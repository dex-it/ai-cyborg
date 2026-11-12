import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Daemon } from '../src/agentd/daemon';
import { SLEEP_IDLE_MS, type Msg } from '../src/agentd/protocol';
import { bundleOf, installScript } from '../src/main/remote/install';
import { PREFLIGHT_SCRIPT } from '../src/main/remote/preflight';
import { RemoteSessions, type RemoteDeps } from '../src/main/remote/remote-sessions';
import { RECONNECT_MS, type Timers } from '../src/main/remote/host-link';
import type { SshChannel, SshResult, SshTransport } from '../src/main/remote/ssh';
import type { Project } from '../src/main/projects';
import { SessionManager } from '../src/main/sessions';
import { projectDirName } from '../src/main/history';
import { rig, until, type Rig } from './daemon-rig';

const BUNDLE = bundleOf('// agentd stub\n');
const TOKEN = (n: number): string => String(n).padStart(43, 'T');

interface Chan extends SshChannel {
  cut(): void;
}

class FakeSsh implements SshTransport {
  runs: { alias: string; script: string }[] = [];
  opens: { alias: string; cmd: string; extra: string[] }[] = [];
  seen: Msg[] = [];
  installed: string[] = [];
  failure: SshResult | null = null;
  preflight = (home: string): string =>
    `home=${home}\nuname=Linux\nnode=v20.1.0\ngit=/usr/bin/git\nclaude=/usr/bin/claude\nscript=/usr/bin/script\nauth={"loggedIn":true}\nagentd=${this.installed.join(' ')}\n`;
  channels: Chan[] = [];
  blocked = false;
  /** Хосты, ssh к которым не отвечает: preflight висит, как при недоступном сервере до ConnectTimeout. */
  hang = new Set<string>();
  /** Не null - запросы типов hold копятся здесь и доходят до демона, когда тест вызовет отложенное: долгая уборка или занятый канал. */
  held: (() => void)[] | null = null;
  hold = new Set(['close']);
  constructor(public daemon: Daemon, private readonly home: string) {}

  async run(alias: string, script: string): Promise<SshResult> {
    this.runs.push({ alias, script });
    if (this.hang.has(alias)) return new Promise(() => undefined);
    if (this.failure) return this.failure;
    if (script === PREFLIGHT_SCRIPT) return { code: 0, stdout: this.preflight(this.home), stderr: '' };
    this.installed.push(BUNDLE.version);
    return { code: 0, stdout: 'installed', stderr: '' };
  }

  open(alias: string, cmd: string, extra: string[]): SshChannel {
    this.opens.push({ alias, cmd, extra });
    const lines: ((l: string) => void)[] = [];
    const exits: ((code: number | null, stderr: string) => void)[] = [];
    let closed = false;
    const conn = this.daemon.connect({ send: (m) => closed || setImmediate(() => lines.forEach((cb) => cb(JSON.stringify(m)))) });
    const end = (code: number, stderr: string): void => {
      if (closed) return;
      closed = true;
      conn.close();
      exits.forEach((cb) => cb(code, stderr));
    };
    const channel: Chan = {
      write: (line) => {
        const msg = JSON.parse(line) as Msg;
        this.seen.push(msg);
        if (this.held && this.hold.has(msg.type)) this.held.push(() => conn.receive(msg));
        else if (!this.blocked) conn.receive(msg);
      },
      onLine: (cb) => void lines.push(cb),
      onExit: (cb) => void exits.push(cb),
      close: () => end(0, ''),
      cut: () => end(255, 'Connection timed out'),
    };
    this.channels.push(channel);
    return channel;
  }
}

function fakeTimers() {
  const queue: { fn: () => void; ms: number; alive: boolean }[] = [];
  const timers: Timers = {
    set: (fn, ms) => {
      const t = { fn, ms, alive: true };
      queue.push(t);
      return t;
    },
    clear: (h) => void ((h as { alive: boolean } | null) && ((h as { alive: boolean }).alive = false)),
  };
  return { timers, queue, fire: (ms: number) => queue.filter((t) => t.alive && t.ms === ms).forEach((t) => ((t.alive = false), t.fn())) };
}

const project: Project = { id: 'p', name: 'P', description: '', repos: ['/loc/a', '/loc/b'], trackers: {} as Project['trackers'], hosts: ['dev1'] };

function fakePty() {
  return { onData: () => {}, onExit: () => {}, write: () => {}, resize: () => {}, kill: () => {} };
}

interface Side {
  sessions: SessionManager;
  remote: RemoteSessions;
  events: { channel: string; payload: any }[];
  alerts: string[];
  closedTabs: number[];
  mcp: { issued: number[]; accepted: [string, number][]; disconnected: number[] };
}

function side(t: { after: (fn: () => void) => void }, ssh: FakeSsh, extra: { originUrl?: (d: string) => Promise<string | null>; timers?: Timers; instance?: string; deps?: Partial<RemoteDeps> } = {}): Side {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-rl-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const events: Side['events'] = [];
  const sessions = new SessionManager(userData, (channel, payload) => events.push({ channel, payload }), (() => fakePty()) as any, 30);
  t.after(() => sessions.killAll());
  const mcp: Side['mcp'] = { issued: [], accepted: [], disconnected: [] };
  const alerts: string[] = [];
  const closedTabs: number[] = [];
  const remote = new RemoteSessions({
    ssh,
    bundle: BUNDLE,
    sessions,
    mcp: {
      issue: (id) => (mcp.issued.push(id), TOKEN(id)),
      accept: (token, id) => void mcp.accepted.push([token, id]),
      disconnect: (id) => void mcp.disconnected.push(id),
      boundPort: 5555,
    },
    originUrl: extra.originUrl ?? (async (d) => `git@h:o/${path.basename(d)}.git`),
    emit: (channel, payload) => void events.push({ channel, payload }),
    closeTab: (id) => void closedTabs.push(id),
    alert: (title, text) => void alerts.push(`${title}: ${text}`),
    instance: extra.instance ?? 'inst-1',
    timers: extra.timers,
    ...extra.deps,
  });
  t.after(() => remote.closeLinks());
  return { sessions, remote, events, alerts, closedTabs, mcp };
}

function world(t: { after: (fn: () => void) => void }) {
  const r: Rig = rig(t, { version: BUNDLE.version });
  const ssh = new FakeSsh(r.daemon, r.home);
  return { r, ssh };
}

const human = { host: 'dev1', repo: '/loc/a', branch: 'feat/x', prompt: 'сделай' };
const hook = (r: Rig, sid: string, ...events: object[]): void => fs.appendFileSync(path.join(r.home, '.cyborg', 'sessions', sid, 'events.jsonl'), events.map((e) => JSON.stringify(e) + '\n').join(''));
const sidOf = (ssh: FakeSsh): string => String(ssh.seen.find((m) => m.type === 'spawn')?.sid);

describe('RemoteSessions: открытие человеком', () => {
  it('демон получает хост-независимый spawn с репозиториями, веткой и заданием; вкладка несёт набор каталогов и клоны', async (t) => {
    const { r, ssh } = world(t);
    const a = side(t, ssh);
    const info = await a.remote.create(project, human, { origin: 'human' });
    const spawn = ssh.seen.find((m) => m.type === 'spawn') as any;
    assert.equal(spawn.branch, 'feat/x');
    assert.equal(spawn.prompt, 'сделай');
    assert.equal(spawn.selected, 0);
    assert.deepEqual(spawn.repos.map((x: any) => x.local), ['/loc/a', '/loc/b']);
    assert.equal(spawn.token, TOKEN(info.id));
    assert.deepEqual(info.dirs, ['/loc/a', '/loc/b']);
    assert.equal(info.host, 'dev1');
    assert.equal(info.roots.length, 2);
    assert.equal(a.sessions.peers(info.id)?.[0].host, 'dev1');
    await until(() => r.spawned.length === 1);
  });

  it('ввод и изменение размера идут в процесс на хосте, вывод - как session:data с номером', async (t) => {
    const { r, ssh } = world(t);
    const a = side(t, ssh);
    const info = await a.remote.create(project, human, { origin: 'human' });
    await until(() => r.spawned.length === 1);
    a.sessions.write(info.id, 'ls\r');
    await until(() => r.procs[0].written.length === 1);
    assert.deepEqual(r.procs[0].written, ['ls\r']);
    a.sessions.resize(info.id, 100, 30);
    await until(() => ssh.seen.some((m) => m.type === 'resize'));
    r.procs[0].emit('вывод');
    await until(() => a.events.some((e) => e.channel === 'session:data' && String(e.payload.data).includes('вывод')));
    assert.equal(a.events.find((e) => e.channel === 'session:data' && String(e.payload.data).includes('вывод'))?.payload.id, info.id);
  });

  it('хук permission_prompt удалённой сессии даёт session:waiting; состояние ведётся по тем же хукам', async (t) => {
    const { r, ssh } = world(t);
    const a = side(t, ssh);
    const info = await a.remote.create(project, human, { origin: 'human' });
    await until(() => r.spawned.length === 1);
    hook(r, sidOf(ssh), { hook_event_name: 'SessionStart', cwd: '/h/w/a' }, { hook_event_name: 'PostToolUse' });
    await until(() => a.sessions.peers(info.id)?.[0].state === 'working');
    hook(r, sidOf(ssh), { hook_event_name: 'Notification', notification_type: 'permission_prompt' });
    await until(() => a.events.some((e) => e.channel === 'session:waiting'));
    assert.equal(a.events.find((e) => e.channel === 'session:waiting')?.payload.id, info.id);
    assert.equal(a.sessions.peers(info.id)?.[0].cwd, '/h/w/a');
  });

  it('учётные данные в адресе origin (https://пользователь:токен@хост/…) на хост не уходят: ни в spawn, ни в клон; вкладка называет это заметкой', async (t) => {
    const { r, ssh } = world(t);
    const urls: Record<string, string> = {
      '/loc/a': 'https://oauth2:glpat-SECRET123@gitlab.example.com/o/a.git',
      '/loc/b': 'https://ghp_TOKENONLY@github.com/o/b.git',
    };
    const a = side(t, ssh, { originUrl: async (d) => urls[d] });
    const info = await a.remote.create(project, human, { origin: 'human' });
    const spawn = ssh.seen.find((m) => m.type === 'spawn') as any;
    assert.deepEqual(spawn.repos.map((x: any) => x.url), ['https://gitlab.example.com/o/a.git', 'https://github.com/o/b.git']);
    const wire = JSON.stringify(ssh.seen);
    assert.ok(!wire.includes('SECRET123') && !wire.includes('TOKENONLY'), 'секрет из адреса ушёл по каналу');
    await until(() => r.execs.filter((e) => e.args[0] === 'clone').length === 2);
    assert.ok(r.execs.every((e) => !e.args.join(' ').includes('SECRET123') && !e.args.join(' ').includes('TOKENONLY')), 'секрет из адреса попал в аргументы git на хосте');
    assert.ok(info.notes?.some((n) => /\/loc\/a/.test(n) && /учётные данные/.test(n)), `нет заметки: ${JSON.stringify(info.notes)}`);
    assert.ok(info.notes?.some((n) => /\/loc\/b/.test(n) && /учётные данные/.test(n)));
  });

  it('адрес origin без учётных данных уходит как есть: scp-форма, ssh:// с пользователем git, https без пользователя', async (t) => {
    const { r, ssh } = world(t);
    const urls: Record<string, string> = { '/loc/a': 'ssh://git@h.example.com:2222/o/a.git', '/loc/b': 'https://h.example.com/o/b.git' };
    const a = side(t, ssh, { originUrl: async (d) => urls[d] });
    const info = await a.remote.create(project, human, { origin: 'human' });
    const spawn = ssh.seen.find((m) => m.type === 'spawn') as any;
    assert.deepEqual(spawn.repos.map((x: any) => x.url), ['ssh://git@h.example.com:2222/o/a.git', 'https://h.example.com/o/b.git']);
    assert.ok(!info.notes?.some((n) => /учётные данные/.test(n)));
    await until(() => r.spawned.length === 1);
  });

  it('репозиторий без origin: отказ с путём, демону ничего не уходит', async (t) => {
    const { ssh } = world(t);
    const a = side(t, ssh, { originUrl: async (d) => (d === '/loc/b' ? null : 'u') });
    await assert.rejects(a.remote.create(project, human, { origin: 'human' }), /\/loc\/b нет origin/);
    assert.equal(ssh.runs.length + ssh.opens.length, 0);
  });

  it('демон отказал (предел) - создание отвергнуто, номер не остаётся в менеджере', async (t) => {
    const { ssh } = world(t);
    const a = side(t, ssh);
    await a.remote.create(project, human, { origin: 'human', limits: { max_agents_per_host: 1 } });
    await assert.rejects(a.remote.create(project, human, { origin: 'human', limits: { max_agents_per_host: 1 } }), /предел 1/);
    assert.equal(a.sessions.peers(1)?.length, 1);
  });

  it('killAll не трогает удалённые сессии, count их не считает', async (t) => {
    const { r, ssh } = world(t);
    const a = side(t, ssh);
    await a.remote.create(project, human, { origin: 'human' });
    await until(() => r.spawned.length === 1);
    assert.equal(a.sessions.count(), 0);
    a.sessions.killAll();
    assert.deepEqual(r.killed, []);
  });
});

describe('HostLink: проверка хоста и установка демона', () => {
  it('проверка называет нехватку, запуск не стартует молча', async (t) => {
    const { ssh } = world(t);
    ssh.preflight = () => 'home=/h\nnode=\ngit=/g\nclaude=\nscript=/s\nauth=\n';
    const a = side(t, ssh);
    await assert.rejects(a.remote.create(project, human, { origin: 'human' }), /на хосте нет: node ≥ 18, claude/);
    assert.equal(ssh.opens.length, 0);
  });

  it('отказ ssh называется причиной: пароль, host key', async (t) => {
    const { ssh } = world(t);
    ssh.failure = { code: 255, stdout: '', stderr: 'dev1: Permission denied (publickey,password).' };
    const a = side(t, ssh);
    await assert.rejects(a.remote.create(project, human, { origin: 'human' }), /ssh-agent/);
  });

  it('демон ставится, когда версии нет на хосте, и не ставится повторно', async (t) => {
    const { ssh } = world(t);
    const a = side(t, ssh);
    await a.remote.create(project, human, { origin: 'human' });
    assert.equal(ssh.runs.filter((x) => x.script === installScript(BUNDLE) || x.script.startsWith('set -e')).length, 1);
    assert.match(ssh.opens[0].cmd, new RegExp(`^sh \\.cyborg/agentd/${BUNDLE.version}/connect\\.sh$`));
    assert.match(ssh.opens[0].extra[1], /^\/.*\/\.cyborg\/run\/fwd-[0-9a-f]{16}\.sock:127\.0\.0\.1:5555$/);
    assert.equal(ssh.opens[0].extra.join(' ').includes(TOKEN(1)), false);
  });

  it('старая версия демона без сессий - shutdown и новый демон', async (t) => {
    const old = rig(t, { version: 'old-version' });
    const fresh = rig(t, { version: BUNDLE.version });
    const ssh = new FakeSsh(old.daemon, old.home);
    ssh.installed = [BUNDLE.version];
    const origOpen = ssh.open.bind(ssh);
    ssh.open = (alias, cmd, extra) => {
      const channel = origOpen(alias, cmd, extra);
      const write = channel.write;
      channel.write = (line) => {
        write(line);
        if (JSON.parse(line).type === 'shutdown') ssh.daemon = fresh.daemon;
      };
      return channel;
    };
    const a = side(t, ssh);
    await a.remote.prepare('dev1', '/loc/a');
    assert.ok(ssh.seen.some((m) => m.type === 'shutdown'));
    assert.equal(ssh.opens.length, 2);
  });

  it('shutdown старого демона доходит до него раньше, чем закрывается канал', async (t) => {
    const old = rig(t, { version: 'old-version' });
    const fresh = rig(t, { version: BUNDLE.version });
    const ssh = new FakeSsh(old.daemon, old.home);
    ssh.installed = [BUNDLE.version];
    const order: string[] = [];
    const origOpen = ssh.open.bind(ssh);
    ssh.open = (alias, cmd, extra) => {
      const channel = origOpen(alias, cmd, extra);
      const { write, close } = channel;
      channel.write = (line) =>
        void setTimeout(() => {
          if (JSON.parse(line).type === 'shutdown') order.push('shutdown');
          write(line);
          if (JSON.parse(line).type === 'shutdown') ssh.daemon = fresh.daemon;
        }, 5);
      channel.close = () => (order.push('close'), close());
      return channel;
    };
    const a = side(t, ssh);
    await a.remote.prepare('dev1', '/loc/a');
    assert.deepEqual(order.slice(0, 2), ['shutdown', 'close']);
  });

  it('старая версия с сессиями и совместимым proto - работа со старым демоном без shutdown', async (t) => {
    const old = rig(t, { version: 'old-version' });
    const ssh = new FakeSsh(old.daemon, old.home);
    ssh.installed = [BUNDLE.version];
    const direct = old.daemon.connect({ send: () => {} });
    direct.receive({ type: 'hello', rid: 0, instance: 'other' } as Msg);
    direct.receive({ type: 'spawn', rid: 1, sid: 'dddddddd-4', token: 'x', repos: [{ local: '/loc/a', url: 'u', name: 'a' }], selected: 0, branch: 'b', origin: 'human', keep: false, limits: { maxPerHost: 4, taskMs: 1e9, idleMs: 1e9 }, cols: 80, rows: 24 } as Msg);
    await until(() => old.daemon.liveCount() === 1);
    const a = side(t, ssh);
    await a.remote.prepare('dev1', '/loc/a');
    assert.equal(ssh.seen.some((m) => m.type === 'shutdown'), false);
  });

  it('несовместимый демон с сессиями - отказ с числом сессий', async (t) => {
    const { r, ssh } = world(t);
    ssh.installed = [BUNDLE.version];
    const a = side(t, ssh);
    const orig = ssh.open.bind(ssh);
    ssh.open = (alias, cmd, extra) => {
      const channel = orig(alias, cmd, extra);
      let cb: (l: string) => void = () => {};
      channel.onLine = (c) => (cb = c);
      channel.write = (line) => queueMicrotask(() => cb(JSON.stringify({ type: 'hello', rid: JSON.parse(line).rid, proto: 99, version: 'zzz', sessions: 2 })));
      return channel;
    };
    void r;
    await assert.rejects(a.remote.prepare('dev1', '/loc/a'), /несовместимой версии с 2 сессиями/);
  });

  it('сокет туннеля длиннее sun_path отвергается с причиной', async (t) => {
    const { ssh } = world(t);
    ssh.preflight = () => `home=/${'h'.repeat(120)}\nnode=v20\ngit=/g\nclaude=/c\nscript=/s\nauth={"loggedIn":true}\nagentd=${BUNDLE.version}\n`;
    const a = side(t, ssh);
    await assert.rejects(a.remote.create(project, human, { origin: 'human' }), /слишком длинный для сокета/);
  });
});

describe('HostLink: обрыв связи и подхват', () => {
  it('обрыв: вкладки offline, повторы с растущей паузой до 60 с, после подключения вывод и события с отметок без дублей', async (t) => {
    const { r, ssh } = world(t);
    const clock = fakeTimers();
    const a = side(t, ssh, { timers: clock.timers });
    const info = await a.remote.create(project, human, { origin: 'human' });
    await until(() => r.spawned.length === 1);
    r.procs[0].emit('до-обрыва ');
    await until(() => a.events.some((e) => String(e.payload.data ?? '').includes('до-обрыва')));
    ssh.channels[0].cut();
    assert.equal(a.sessions.peers(info.id)?.[0].link, 'offline');
    assert.ok(a.events.some((e) => e.channel === 'remote:link' && e.payload.online === false));
    r.procs[0].emit('за-время-обрыва ');
    hook(r, sidOf(ssh), { hook_event_name: 'SessionStart' });
    ssh.failure = { code: 255, stdout: '', stderr: 'Connection timed out' };
    clock.fire(RECONNECT_MS[0]);
    await until(() => clock.queue.some((x) => x.alive && x.ms === RECONNECT_MS[1]));
    clock.queue.forEach((x) => x.alive && x.ms === RECONNECT_MS[1] && ((x.alive = false), x.fn()));
    await until(() => clock.queue.some((x) => x.alive && x.ms === RECONNECT_MS[2]));
    ssh.failure = null;
    clock.queue.forEach((x) => x.alive && x.ms === RECONNECT_MS[2] && ((x.alive = false), x.fn()));
    await until(() => a.sessions.peers(info.id)?.[0].link === undefined);
    await until(() => a.events.some((e) => String(e.payload.data ?? '').includes('за-время-обрыва')));
    const text = a.events.filter((e) => e.channel === 'session:data').map((e) => e.payload.data).join('');
    assert.equal(text.split('до-обрыва').length, 2, 'до обрыва показано один раз');
    assert.equal(text.split('за-время-обрыва').length, 2);
    await until(() => a.sessions.peers(info.id)?.[0].state === 'waiting');
  });

  it('неудачное подключение по запросу окна во время обрыва не снимает повтор: хост вернулся - вкладка снова на связи', async (t) => {
    const { r, ssh } = world(t);
    const clock = fakeTimers();
    const a = side(t, ssh, { timers: clock.timers });
    const info = await a.remote.create(project, human, { origin: 'human' });
    await until(() => r.spawned.length === 1);
    ssh.channels[0].cut();
    ssh.failure = { code: 255, stdout: '', stderr: 'Connection refused' };
    await assert.rejects(a.remote.disk(project, 'dev1'), /Connection refused|нет связи/);
    const retry = clock.queue.filter((x) => x.alive && RECONNECT_MS.includes(x.ms));
    assert.equal(retry.length, 1, 'после неудачи окна повтор переподключения запланирован');
    ssh.failure = null;
    retry.forEach((x) => ((x.alive = false), x.fn()));
    await until(() => a.sessions.peers(info.id)?.[0].link === undefined);
  });

  it('ввод без связи в удалённую сессию бросает «без связи с хостом», сообщение остаётся в очереди', async (t) => {
    const { r, ssh } = world(t);
    const a = side(t, ssh, { timers: fakeTimers().timers });
    a.sessions.outboxDelayMs = 0;
    const info = await a.remote.create(project, human, { origin: 'human' });
    await until(() => r.spawned.length === 1);
    hook(r, sidOf(ssh), { hook_event_name: 'SessionStart' });
    await until(() => a.sessions.peers(info.id)?.[0].state === 'waiting');
    ssh.channels[0].cut();
    await new Promise((res) => setTimeout(res, 80));
    await assert.rejects(a.sessions.say(info.id, 'привет'), /без связи с хостом/);
  });

  it('выход Cyborg не останавливает сессию; новый запуск подхватывает её, токен принят, устаревший asking не уведомляет', async (t) => {
    const { r, ssh } = world(t);
    const first = side(t, ssh);
    const info = await first.remote.create(project, human, { origin: 'human' });
    await until(() => r.spawned.length === 1);
    const sid = sidOf(ssh);
    assert.deepEqual(info.size, { cols: 120, rows: 40 });
    r.procs[0].emit('экран сессии');
    first.sessions.resize(info.id, 100, 30);
    hook(r, sid, { hook_event_name: 'SessionStart' }, { hook_event_name: 'Notification', notification_type: 'permission_prompt' }, { hook_event_name: 'UserPromptSubmit' }, { hook_event_name: 'PostToolUse', cwd: '/h/w/b' });
    await new Promise((res) => setTimeout(res, 100));
    first.sessions.killAll();
    first.remote.closeLinks();
    assert.deepEqual(r.killed, []);
    const second = side(t, ssh, { instance: 'inst-2' });
    const found = await second.remote.discover(project);
    assert.equal(found.length, 1);
    assert.deepEqual(second.mcp.accepted, [[TOKEN(info.id), found[0].id]]);
    assert.deepEqual(found[0].size, { cols: 100, rows: 30 }, 'вкладка подхваченной сессии берёт размер pty до догона вывода');
    await until(() => second.events.some((e) => String(e.payload.data ?? '').includes('экран сессии')));
    await until(() => second.sessions.peers(found[0].id)?.[0].state === 'working');
    assert.equal(second.sessions.peers(found[0].id)?.[0].cwd, '/h/w/b');
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(second.events.some((e) => e.channel === 'session:waiting'), false, 'устаревший asking не отзывается уведомлением');
  });

  it('текущий asking в конце догона уведомляет; сессия с другим набором каталогов не подхватывается', async (t) => {
    const { r, ssh } = world(t);
    const first = side(t, ssh);
    await first.remote.create(project, human, { origin: 'human' });
    await until(() => r.spawned.length === 1);
    hook(r, sidOf(ssh), { hook_event_name: 'SessionStart' }, { hook_event_name: 'Notification', notification_type: 'permission_prompt' });
    await new Promise((res) => setTimeout(res, 100));
    first.remote.closeLinks();
    const other = side(t, ssh, { instance: 'inst-3' });
    assert.deepEqual(await other.remote.discover({ ...project, repos: ['/loc/a', '/loc/z'] }), []);
    const second = side(t, ssh, { instance: 'inst-2' });
    const found = await second.remote.discover(project);
    assert.equal(found.length, 1);
    await until(() => second.events.some((e) => e.channel === 'session:waiting'));
  });

  it('смена воркспейса снимает удалённые записи и токены; повторный discover подхватывает сессию', async (t) => {
    const { r, ssh } = world(t);
    const a = side(t, ssh);
    const info = await a.remote.create(project, human, { origin: 'human' });
    await until(() => r.spawned.length === 1);
    a.remote.closeLinks();
    assert.equal(a.remote.isRemote(info.id), false);
    assert.equal(a.sessions.peers(info.id), null);
    assert.ok(a.mcp.disconnected.includes(info.id));
    const found = await a.remote.discover(project);
    assert.equal(found.length, 1);
    assert.equal(a.remote.isRemote(found[0].id), true);
  });

  it('discover без своих сессий на хосте закрывает канал: демону ничто не мешает выйти по простою', async (t) => {
    const { ssh } = world(t);
    const a = side(t, ssh);
    assert.deepEqual(await a.remote.discover(project), []);
    assert.equal((a.remote as unknown as { links: Map<string, { state: string }> }).links.get('dev1')?.state, 'offline');
  });

  it('сессию, которую держит другое окно, не подхватывает', async (t) => {
    const { r, ssh } = world(t);
    const first = side(t, ssh);
    await first.remote.create(project, human, { origin: 'human' });
    await until(() => r.spawned.length === 1);
    const second = side(t, ssh, { instance: 'inst-2' });
    assert.deepEqual(await second.remote.discover(project), []);
  });
});

describe('report_done, close_agent и лимиты', () => {
  const callerOf = (a: Side): number => a.sessions.adopt({ term: { write() {}, resize() {}, kill() {} }, dirs: ['/loc/a', '/loc/b'], cwd: '/loc/a', remote: { host: 'local', origin: 'human', keep: false, online: true } });
  const outboxOf = (a: Side, id: number): string[] => (a.sessions as unknown as { sessions: Map<number, { outbox: string[] }> }).sessions.get(id)?.outbox ?? [];

  const states = (a: Side): unknown[] => a.events.filter((e) => e.channel === 'remote:state').map((e) => e.payload);

  it('итог вкладки spawn_agent уходит в очередь вызвавшей, вкладка остаётся; второй итог - только после нового круга', async (t) => {
    const r = rig(t, { tickMs: 10, version: BUNDLE.version });
    const ssh = new FakeSsh(r.daemon, r.home);
    const a = side(t, ssh);
    const caller = callerOf(a);
    const info = await a.remote.create(project, human, { origin: 'tool', spawnedBy: caller });
    await until(() => r.spawned.length === 1);
    const text = await a.remote.report(info.id, { status: 'ok', summary: 'готово', branch: 'feat/x', pr: 'https://x/pr/1' });
    assert.match(text, /Итог принят\. Сессия остаётся открытой/);
    assert.equal(outboxOf(a, caller).length, 1);
    assert.deepEqual(states(a), [{ id: info.id, reported: true }]);
    await assert.rejects(a.remote.report(info.id, { status: 'ok', summary: 'ещё' }), /уже отправлен/);
    await new Promise((res) => setTimeout(res, 100));
    assert.deepEqual(a.closedTabs, []);
    assert.deepEqual(r.killed, []);
    assert.ok(a.remote.isRemote(info.id));
    hook(r, sidOf(ssh), { hook_event_name: 'UserPromptSubmit' });
    await until(() => states(a).length === 2);
    assert.deepEqual(states(a)[1], { id: info.id, reported: false });
    assert.match(await a.remote.report(info.id, { status: 'ok', summary: 'второй круг' }), /Итог принят/);
    assert.equal(outboxOf(a, caller).length, 2);
    assert.match(outboxOf(a, caller)[1], /второй круг/);
  });

  it('итог вкладки человека - уведомление, сессия не останавливается', async (t) => {
    const { r, ssh } = world(t);
    const a = side(t, ssh);
    const info = await a.remote.create(project, human, { origin: 'human' });
    await until(() => r.spawned.length === 1);
    await a.remote.report(info.id, { status: 'blocked', summary: 'нужен человек' });
    const note = a.events.find((e) => e.channel === 'remote:report');
    assert.equal(note?.payload.title, `CC${info.id} · dev1`);
    assert.match(note?.payload.body, /^blocked: нужен человек/);
    await new Promise((res) => setTimeout(res, 100));
    assert.deepEqual(r.killed, []);
    assert.deepEqual(a.closedTabs, []);
  });

  it('подхват: «итог сдан» приходит с list, а после обрыва - с ответа attach', async (t) => {
    const r = rig(t, { tickMs: 10, version: BUNDLE.version });
    const ssh = new FakeSsh(r.daemon, r.home);
    const first = side(t, ssh);
    const info = await first.remote.create(project, human, { origin: 'tool' });
    await until(() => r.spawned.length === 1);
    await first.remote.report(info.id, { status: 'ok', summary: 'x' });
    first.remote.closeLinks();
    const clock = fakeTimers();
    const second = side(t, ssh, { timers: clock.timers });
    const [found] = await second.remote.discover(project);
    assert.equal(found.reported, true);
    hook(r, sidOf(ssh), { hook_event_name: 'UserPromptSubmit' });
    await until(() => (r.daemon as unknown as { sessions: Map<string, { meta: { reported: boolean } }> }).sessions.get(sidOf(ssh))?.meta.reported === false);
    ssh.channels[ssh.channels.length - 1].cut();
    clock.fire(RECONNECT_MS[0]);
    await until(() => states(second).some((p) => (p as { reported: boolean }).reported === false));
  });

  it('report_done без связи - ошибка, повтор не засчитан', async (t) => {
    const { r, ssh } = world(t);
    const a = side(t, ssh, { timers: fakeTimers().timers });
    const info = await a.remote.create(project, human, { origin: 'human' });
    await until(() => r.spawned.length === 1);
    ssh.channels[0].cut();
    await assert.rejects(a.remote.report(info.id, { status: 'ok', summary: 'x' }), /нет связи/);
  });

  it('close_agent: чистые клоны удалены, грязный остаётся с путём на хосте и окном', async (t) => {
    const { r, ssh } = world(t);
    const a = side(t, ssh);
    const info = await a.remote.create(project, human, { origin: 'human' });
    await until(() => r.spawned.length === 1);
    r.answers['status --porcelain'] = { stdout: ' M f\n' };
    const text = await a.remote.close(info.id, false);
    assert.match(text, /Уборка отказана - оставлены dev1:\S+\/work\/\S+\/a \(изменения в рабочем дереве\)/);
    assert.equal(a.alerts.length, 1);
    assert.deepEqual(a.closedTabs, [info.id]);
  });

  it('лимит демона закрывает вкладку spawn_agent и отдаёт вызвавшей итог failed с причиной', async (t) => {
    const w = world(t);
    const r2 = rig(t, { tickMs: 10, version: BUNDLE.version });
    const ssh = new FakeSsh(r2.daemon, r2.home);
    const a = side(t, ssh);
    const caller = callerOf(a);
    const info = await a.remote.create(project, human, { origin: 'tool', spawnedBy: caller, limits: { task_timeout_min: 1 } });
    await until(() => r2.spawned.length === 1);
    r2.clock.now += 120_000;
    await until(() => a.sessions.peers(caller)?.find((p) => p.id === caller)?.queued === 1);
    assert.ok(a.closedTabs.includes(info.id));
    void w;
  });

  it('лимит сработал во время обрыва: после переподключения итог failed у вызвавшей, ack ушёл, на хосте сессии нет', async (t) => {
    const r2 = rig(t, { tickMs: 10, version: BUNDLE.version });
    const ssh = new FakeSsh(r2.daemon, r2.home);
    const clock = fakeTimers();
    const a = side(t, ssh, { timers: clock.timers });
    const caller = callerOf(a);
    const info = await a.remote.create(project, human, { origin: 'tool', spawnedBy: caller, limits: { task_timeout_min: 1 } });
    await until(() => r2.spawned.length === 1);
    ssh.channels[0].cut();
    r2.clock.now += 120_000;
    await until(() => r2.killed.includes('SIGTERM'));
    await new Promise((res) => setTimeout(res, 50));
    clock.fire(RECONNECT_MS[0]);
    await until(() => outboxOf(a, caller).length === 1);
    assert.match(outboxOf(a, caller)[0], /failed[\s\S]*таймаут задачи/);
    await until(() => ssh.seen.some((m) => m.type === 'ack'));
    await until(() => !fs.existsSync(path.join(r2.home, '.cyborg', 'sessions', sidOf(ssh))));
    assert.ok(a.closedTabs.includes(info.id));
  });


  it('текст хоста в итоге лимита очищен от управляющих символов и обрезан; отказ уборки - в итоге с путём', async (t) => {
    const { r, ssh } = world(t);
    const a = side(t, ssh);
    const caller = callerOf(a);
    await a.remote.create(project, human, { origin: 'tool', spawnedBy: caller });
    await until(() => r.spawned.length === 1);
    const route = (a.remote as unknown as { route(m: Msg): void }).route.bind(a.remote);
    route({ type: 'ended', sid: sidOf(ssh), reason: `\x1b[201~\r!rm -rf ~${'я'.repeat(3000)}`, cleanup: { removed: [], kept: [{ path: '/h/w/a\x1b[201~', reason: 'незапушенные\x07 коммиты' }] } });
    const [text] = outboxOf(a, caller);
    assert.doesNotMatch(text, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    assert.match(text, /\[201~\n!rm -rf ~я+\n/);
    assert.ok(text.length < 2300);
    assert.match(text, /dev1:\/h\/w\/a\[201~ \(незапушенные коммиты\)/);
  });

  it('демон прежней версии шлёт exit раньше ended: итог всё равно у вызвавшей и ack ушёл; после 60 с ended не принимается', async (t) => {
    const { r, ssh } = world(t);
    const clock = fakeTimers();
    const a = side(t, ssh, { timers: clock.timers });
    const caller = callerOf(a);
    await a.remote.create(project, human, { origin: 'tool', spawnedBy: caller });
    await until(() => r.spawned.length === 1);
    const route = (a.remote as unknown as { route(m: Msg): void }).route.bind(a.remote);
    const sid = sidOf(ssh);
    route({ type: 'exit', sid, code: 1 });
    route({ type: 'ended', sid, reason: 'таймаут задачи' });
    assert.match(outboxOf(a, caller)[0], /failed[\s\S]*таймаут задачи/);
    await until(() => ssh.seen.some((m) => m.type === 'ack' && m.sid === sid));
    await a.remote.create(project, human, { origin: 'tool', spawnedBy: caller });
    await until(() => r.spawned.length === 2);
    const sid2 = String(ssh.seen.filter((m) => m.type === 'spawn')[1].sid);
    route({ type: 'exit', sid: sid2, code: 1 });
    clock.fire(60_000);
    route({ type: 'ended', sid: sid2, reason: 'поздно' });
    assert.equal(outboxOf(a, caller).length, 1);
  });

  it('prepare: сверх предела хоста - ошибка до передачи вкладки', async (t) => {
    const { ssh } = world(t);
    const a = side(t, ssh);
    await a.remote.create(project, human, { origin: 'human' });
    await assert.rejects(a.remote.prepare('dev1', '/loc/a', { max_agents_per_host: 1 }), /предел 1/);
    await a.remote.prepare('dev1', '/loc/a');
  });
});

describe('подхват: сессия, завершившаяся на хосте без клиента', () => {
  const hostSessions = (r: Rig): number => (r.daemon as unknown as { sessions: Map<string, unknown> }).sessions.size;

  it('Cyborg закрыт, claude вышел: следующий запуск вкладку не открывает, запись на хосте снята, демон простаивает', async (t) => {
    const { r, ssh } = world(t);
    const first = side(t, ssh);
    await first.remote.create(project, human, { origin: 'human' });
    await until(() => r.spawned.length === 1);
    first.remote.closeLinks();
    r.procs[0].exit(0);
    await until(() => r.daemon.liveCount() === 0);
    assert.equal(hostSessions(r), 1);
    const second = side(t, ssh, { instance: 'inst-2' });
    assert.deepEqual(await second.remote.discover(project), []);
    await until(() => hostSessions(r) === 0);
    await until(() => r.daemon.idle());
    const third = side(t, ssh, { instance: 'inst-3' });
    assert.deepEqual(await third.remote.discover(project), []);
  });

  it('Cyborg работает, связь оборвалась, claude вышел: после переподключения вкладка завершена, запись на хосте снята', async (t) => {
    const { r, ssh } = world(t);
    const clock = fakeTimers();
    const a = side(t, ssh, { timers: clock.timers });
    const info = await a.remote.create(project, human, { origin: 'human' });
    await until(() => r.spawned.length === 1);
    ssh.channels[0].cut();
    r.procs[0].exit(0);
    await until(() => r.daemon.liveCount() === 0);
    clock.fire(RECONNECT_MS[0]);
    await until(() => a.events.some((e) => e.channel === 'session:exit' && e.payload.id === info.id));
    await until(() => hostSessions(r) === 0);
  });
});

describe('подхват: итог сессии, завершившейся без клиента, доходит до человека', () => {
  const hostSessions = (r: Rig): number => (r.daemon as unknown as { sessions: Map<string, unknown> }).sessions.size;
  // Итог записан, когда уборка дошла до конца: подхват раньше застал бы сессию ещё живой.
  const ghostEnded = (r: Rig): boolean => [...(r.daemon as unknown as { sessions: Map<string, { meta: { ended?: unknown } }> }).sessions.values()].some((s) => s.meta.ended);

  it('лимит сработал при закрытом Cyborg: на следующем запуске уведомление failed с причиной и путём оставленного клона, вкладки нет, запись снята после доставки', async (t) => {
    const r2 = rig(t, { tickMs: 10, version: BUNDLE.version });
    const ssh = new FakeSsh(r2.daemon, r2.home);
    const first = side(t, ssh);
    await first.remote.create(project, human, { origin: 'tool', limits: { task_timeout_min: 1 } });
    await until(() => r2.spawned.length === 1);
    first.remote.closeLinks();
    r2.answers['status --porcelain'] = { stdout: ' M f\n' };
    r2.clock.now += 120_000;
    await until(() => r2.killed.includes('SIGTERM'));
    await until(() => ghostEnded(r2));
    const second = side(t, ssh, { instance: 'inst-2' });
    assert.deepEqual(await second.remote.discover(project), []);
    await until(() => second.events.some((e) => e.channel === 'remote:report' && /^failed: [\s\S]*таймаут задачи/.test(e.payload.body)));
    await until(() => second.alerts.some((m) => /Уборка отказана/.test(m)));
    assert.equal(second.closedTabs.length, 0);
    await until(() => hostSessions(r2) === 0);
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(second.alerts.length, 1, 'ended и exit призрака несут один результат уборки: окно одно');
    assert.equal(second.events.filter((e) => e.channel === 'remote:report').length, 1);
  });

  it('на хосте живая вкладка человека и призрак с лимитом: после доставки итога призрака канал остаётся, ввод и вывод вкладки доходят', async (t) => {
    const r2 = rig(t, { tickMs: 10, version: BUNDLE.version });
    const ssh = new FakeSsh(r2.daemon, r2.home);
    const first = side(t, ssh);
    await first.remote.create(project, human, { origin: 'human' });
    await first.remote.create(project, human, { origin: 'tool', limits: { task_timeout_min: 1 } });
    await until(() => r2.spawned.length === 2);
    first.remote.closeLinks();
    r2.clock.now += 120_000;
    await until(() => r2.killed.includes('SIGTERM'));
    await until(() => ghostEnded(r2));
    const second = side(t, ssh, { instance: 'inst-2' });
    const found = await second.remote.discover(project);
    assert.equal(found.length, 1);
    await until(() => second.events.some((e) => e.channel === 'remote:report' && /^failed: /.test(e.payload.body)));
    await until(() => hostSessions(r2) === 1);
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(second.events.some((e) => e.channel === 'remote:link' && e.payload.online === false), false, 'канал живой вкладки не закрыт');
    second.sessions.write(found[0].id, 'ls\r');
    await until(() => r2.procs[0].written.includes('ls\r'));
    r2.procs[0].emit('после итога');
    await until(() => second.events.some((e) => e.channel === 'session:data' && String(e.payload.data).includes('после итога')));
  });
});

describe('RemoteSessions: файловый канал, запасной путь итога, сбой close', () => {
  const callerOf = (a: Side): number => a.sessions.adopt({ term: { write() {}, resize() {}, kill() {} }, dirs: ['/loc/a', '/loc/b'], cwd: '/loc/a', remote: { host: 'local', origin: 'human', keep: false, online: true } });
  const entryOf = (a: Side, id: number): { closing?: boolean } | undefined => (a.remote as unknown as { byId: Map<number, { closing?: boolean }> }).byId.get(id);

  it('fsOp: путь вне клонов, относительный, с «..», чужая и локальная вкладка, нет связи - отказ; путь в клоне доходит до демона', async (t) => {
    const { r, ssh } = world(t);
    const a = side(t, ssh, { timers: fakeTimers().timers });
    const info = await a.remote.create(project, human, { origin: 'human' });
    await until(() => r.spawned.length === 1);
    const root = info.roots[0];
    for (const bad of ['/etc', 'work/a', `${root}/../x`, `${root}x`, 5, undefined]) {
      await assert.rejects(a.remote.fsOp(info.id, 'list', bad), /Путь вне каталогов удалённой сессии/, String(bad));
    }
    await assert.rejects(a.remote.fsOp(callerOf(a), 'list', root), /не удалённая/);
    assert.equal(ssh.seen.filter((m) => m.type === 'fs').length, 0, 'отвергнутые пути демону не уходят');
    await a.remote.fsOp(info.id, 'list', root);
    assert.equal(ssh.seen.filter((m) => m.type === 'fs').length, 1);
    ssh.channels[0].cut();
    await assert.rejects(a.remote.fsOp(info.id, 'list', root), /нет связи/);
  });

  it('итог вкладки spawn_agent, когда вызвавшей сессии уже нет, - уведомление рабочего стола', async (t) => {
    const { r, ssh } = world(t);
    const a = side(t, ssh);
    const info = await a.remote.create(project, human, { origin: 'tool', spawnedBy: 9999, keep: true });
    await until(() => r.spawned.length === 1);
    await a.remote.report(info.id, { status: 'ok', summary: 'готово' });
    const note = a.events.find((e) => e.channel === 'remote:report');
    assert.equal(note?.payload.id, info.id);
    assert.match(note?.payload.body, /^ok: готово/);
  });

  it('close без ответа хоста: ошибка вызвавшему, closing сброшен, повторный close возможен', async (t) => {
    const { r, ssh } = world(t);
    const clock = fakeTimers();
    const a = side(t, ssh, { timers: clock.timers });
    const info = await a.remote.create(project, human, { origin: 'human' });
    await until(() => r.spawned.length === 1);
    ssh.blocked = true;
    const closing = a.remote.close(info.id, false);
    await until(() => clock.queue.some((x) => x.alive && x.ms === 30_000));
    assert.equal(entryOf(a, info.id)?.closing, true);
    clock.fire(30_000);
    await assert.rejects(closing, /не ответил/);
    assert.equal(entryOf(a, info.id)?.closing, false);
    assert.deepEqual(a.closedTabs, []);
    ssh.blocked = false;
    assert.match(await a.remote.close(info.id, false), /завершена/);
  });

  it('уборка дольше 30 с: вызвавшая close_agent получает отказ по времени, а поздний итог уборки с путём - в очередь, вкладка закрыта', async (t) => {
    const { r, ssh } = world(t);
    const clock = fakeTimers();
    const a = side(t, ssh, { timers: clock.timers });
    const caller = callerOf(a);
    const info = await a.remote.create(project, human, { origin: 'tool', spawnedBy: caller });
    await until(() => r.spawned.length === 1);
    r.answers['status --porcelain'] = { stdout: ' M f\n' };
    ssh.held = [];
    const closing = a.remote.close(info.id, false);
    await until(() => clock.queue.some((x) => x.alive && x.ms === 30_000));
    clock.fire(30_000);
    await assert.rejects(closing, /не ответил за 30 с: если уборка оставит клоны, отказ с путём придёт отдельно/);
    assert.deepEqual(a.closedTabs, []);
    ssh.held.forEach((release) => release());
    const outbox = (): string[] => (a.sessions as unknown as { sessions: Map<number, { outbox: string[] }> }).sessions.get(caller)?.outbox ?? [];
    await until(() => outbox().some((m) => /Уборка отказана - оставлены dev1:\S+\/work\/\S+\/a \(изменения в рабочем дереве\)/.test(m)));
    assert.deepEqual(a.closedTabs, [info.id]);
    assert.equal(a.alerts.filter((m) => /Уборка отказана/.test(m)).length, 1);
  });

  it('поздний итог уборки у вкладки человека: отказ с путём - уведомлением, очередь никому не уходит', async (t) => {
    const { r, ssh } = world(t);
    const clock = fakeTimers();
    const a = side(t, ssh, { timers: clock.timers });
    const other = callerOf(a);
    const info = await a.remote.create(project, human, { origin: 'human' });
    await until(() => r.spawned.length === 1);
    r.answers['status --porcelain'] = { stdout: ' M f\n' };
    ssh.held = [];
    const closing = a.remote.close(info.id, false);
    await until(() => clock.queue.some((x) => x.alive && x.ms === 30_000));
    clock.fire(30_000);
    await assert.rejects(closing, /не ответил/);
    ssh.held.forEach((release) => release());
    await until(() => a.closedTabs.includes(info.id));
    assert.equal(a.alerts.filter((m) => /Уборка отказана - оставлены dev1:\S+\/work\/\S+\/a/.test(m)).length, 1);
    assert.deepEqual((a.sessions as unknown as { sessions: Map<number, { outbox: string[] }> }).sessions.get(other)?.outbox ?? [], []);
  });

  it('поздний отказ уборки уходит и сессии, вызвавшей close_agent над вкладкой человека', async (t) => {
    const { r, ssh } = world(t);
    const clock = fakeTimers();
    const a = side(t, ssh, { timers: clock.timers });
    const caller = callerOf(a);
    const info = await a.remote.create(project, human, { origin: 'human' });
    await until(() => r.spawned.length === 1);
    r.answers['status --porcelain'] = { stdout: ' M f\n' };
    ssh.held = [];
    const closing = a.remote.close(info.id, false, caller);
    await until(() => clock.queue.some((x) => x.alive && x.ms === 30_000));
    clock.fire(30_000);
    await assert.rejects(closing, /не ответил/);
    ssh.held.forEach((release) => release());
    const outbox = (): string[] => (a.sessions as unknown as { sessions: Map<number, { outbox: string[] }> }).sessions.get(caller)?.outbox ?? [];
    await until(() => outbox().some((m) => /Уборка отказана - оставлены dev1:\S+\/work\/\S+\/a/.test(m)));
    assert.equal(outbox().length, 1);
  });

  it('поздний успешный итог уборки: вкладка закрыта, ни уведомления, ни сообщения вызвавшей', async (t) => {
    const { r, ssh } = world(t);
    const clock = fakeTimers();
    const a = side(t, ssh, { timers: clock.timers });
    const caller = callerOf(a);
    const info = await a.remote.create(project, human, { origin: 'tool', spawnedBy: caller });
    await until(() => r.spawned.length === 1);
    ssh.held = [];
    const closing = a.remote.close(info.id, false);
    await until(() => clock.queue.some((x) => x.alive && x.ms === 30_000));
    clock.fire(30_000);
    await assert.rejects(closing, /не ответил/);
    ssh.held.forEach((release) => release());
    await until(() => a.closedTabs.includes(info.id));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(a.alerts.filter((m) => /Уборка отказана/.test(m)).length, 0);
    assert.deepEqual((a.sessions as unknown as { sessions: Map<number, { outbox: string[] }> }).sessions.get(caller)?.outbox ?? [], []);
  });
});

describe('сон, «История» и пробуждение', () => {
  const callerOf = (a: Side): number => a.sessions.adopt({ term: { write() {}, resize() {}, kill() {} }, dirs: ['/loc/a', '/loc/b'], cwd: '/loc/a', remote: { host: 'local', origin: 'human', keep: false, online: true } });
  const outboxOf = (a: Side, id: number): string[] => (a.sessions as unknown as { sessions: Map<number, { outbox: string[] }> }).sessions.get(id)?.outbox ?? [];
  const evPosOf = (a: Side, id: number): number => (a.remote as unknown as { byId: Map<number, { evPos: number }> }).byId.get(id)?.evPos ?? 0;

  /** Сессия засыпает: хук приводит её в waiting, часы демона уходят за порог простоя. */
  async function asleep(t: { after: (fn: () => void) => void }, origin: 'tool' | 'human', deps: Partial<RemoteDeps> = {}) {
    const r = rig(t, { tickMs: 10, version: BUNDLE.version });
    const ssh = new FakeSsh(r.daemon, r.home);
    const a = side(t, ssh, { deps });
    const caller = callerOf(a);
    const info = await a.remote.create(project, human, origin === 'tool' ? { origin, spawnedBy: caller } : { origin });
    await until(() => r.spawned.length === 1);
    const sid = sidOf(ssh);
    const cwd = JSON.parse(fs.readFileSync(path.join(r.home, '.cyborg', 'sessions', sid, 'meta.json'), 'utf8')).cwd;
    const journal = path.join(r.home, '.claude', 'projects', projectDirName(cwd));
    fs.mkdirSync(journal, { recursive: true });
    fs.writeFileSync(path.join(journal, `${sid}.jsonl`), JSON.stringify({ type: 'ai-title', aiTitle: 'разговор' }) + '\n');
    hook(r, sid, { hook_event_name: 'SessionStart' });
    await until(() => evPosOf(a, info.id) > 0);
    r.clock.now += SLEEP_IDLE_MS + 1;
    await until(() => a.closedTabs.includes(info.id));
    return { r, ssh, a, caller, info, sid };
  }

  it('сон: вкладка закрыта, токен снят, вызвавшая узнаёт, что продолжить можно из «Истории»; спящая не в счёт предела хоста', async (t) => {
    const { r, a, caller, info } = await asleep(t, 'tool');
    assert.ok(r.killed.includes('SIGTERM'));
    assert.equal(a.remote.isRemote(info.id), false);
    assert.ok(a.mcp.disconnected.includes(info.id));
    assert.match(outboxOf(a, caller)[0], /CC\d+ \(dev1\) уснула[\s\S]*«Истории»/);
    assert.ok(a.events.some((e) => e.channel === 'session:exit' && e.payload.id === info.id));
    await a.remote.prepare('dev1', '/loc/a', { max_agents_per_host: 1 });
  });

  it('сон вкладки человека - уведомление рабочего стола', async (t) => {
    const { a, info } = await asleep(t, 'human');
    const note = a.events.find((e) => e.channel === 'remote:report' && e.payload.id === info.id);
    assert.match(note?.payload.body, /уснула[\s\S]*«Истории»/);
  });

  it('«История» отдаёт спящую с хостом; wake поднимает вкладку с --resume в тех же клонах, вывод доходит, строка уходит из «Истории»', async (t) => {
    const { r, ssh, a, sid } = await asleep(t, 'tool');
    const list = (await a.remote.history(project)).entries;
    assert.equal(list.length, 1);
    assert.equal(list[0].id, sid);
    assert.equal(list[0].host, 'dev1');
    assert.equal(list[0].repo, '/loc/a');
    const woke = await a.remote.wake(project, 'dev1', sid);
    await until(() => r.spawned.length === 2);
    const launch = fs.readFileSync(path.join(r.home, '.cyborg', 'sessions', sid, 'launch.sh'), 'utf8');
    assert.ok(launch.includes(`'--resume' '${sid}'`));
    assert.equal(r.spawned[1].cwd, r.spawned[0].cwd);
    assert.equal(woke.roots.length, 2);
    assert.equal(woke.reported, false);
    assert.ok(a.remote.isRemote(woke.id));
    const wakeMsg = ssh.seen.find((m) => m.type === 'wake');
    assert.equal(wakeMsg?.token, TOKEN(woke.id));
    r.procs[1].emit('снова здесь');
    await until(() => a.events.some((e) => e.channel === 'session:data' && e.payload.id === woke.id && String(e.payload.data).includes('снова здесь')));
    assert.deepEqual((await a.remote.history(project)).entries, []);
  });

  it('второе пробуждение той же сессии, пока идёт первое, отклоняется и не отнимает у вкладки вывод', async (t) => {
    const { r, a, sid } = await asleep(t, 'human');
    const [one, two] = await Promise.allSettled([a.remote.wake(project, 'dev1', sid), a.remote.wake(project, 'dev1', sid)]);
    assert.equal(one.status, 'fulfilled');
    assert.equal(two.status, 'rejected');
    assert.match(String((two as PromiseRejectedResult).reason), /уже просыпается/);
    const woke = (one as PromiseFulfilledResult<{ id: number }>).value;
    await until(() => r.spawned.length === 2);
    r.procs[1].emit('после двойного щелчка');
    await until(() => a.events.some((e) => e.channel === 'session:data' && e.payload.id === woke.id && String(e.payload.data).includes('после двойного щелчка')));
    await assert.rejects(a.remote.wake(project, 'dev1', sid), /открыта/);
  });

  it('разбуженную сессию spawn_agent ведёт человек: на хосте она без вызвавшей и под таймерами задачи не стоит', async (t) => {
    const { r, a, sid } = await asleep(t, 'tool');
    await a.remote.wake(project, 'dev1', sid);
    await until(() => r.spawned.length === 2);
    const meta = JSON.parse(fs.readFileSync(path.join(r.home, '.cyborg', 'sessions', sid, 'meta.json'), 'utf8'));
    assert.equal(meta.origin, 'human');
    assert.equal(meta.spawnedBy, undefined);
  });

  it('«История» не ждёт молчащий хост: спящие отвечающего хоста отдаются, молчащий назван', async (t) => {
    const { ssh, sid } = await asleep(t, 'human');
    const b = side(t, ssh, { deps: { historyTimeoutMs: 100 } });
    ssh.hang.add('slow');
    const started = Date.now();
    const got = await b.remote.history({ ...project, hosts: ['dev1', 'slow'] });
    assert.ok(Date.now() - started < 2000);
    assert.deepEqual(got.entries.map((e) => [e.host, e.id]), [['dev1', sid]]);
    assert.deepEqual(got.unreachable.map((u) => u.host), ['slow']);
    assert.match(got.unreachable[0].reason, /не ответил/);
  });

  it('«История»: живой канал, не ответивший на list, вкладки хоста «нет связи» не помечает', async (t) => {
    const { r, ssh } = world(t);
    const clock = fakeTimers();
    const a = side(t, ssh, { timers: clock.timers });
    await a.remote.create(project, human, { origin: 'human' });
    await until(() => r.spawned.length === 1);
    ssh.hold = new Set(['list']);
    ssh.held = [];
    const got = a.remote.history(project);
    await until(() => clock.queue.some((x) => x.alive && x.ms === 15_000));
    clock.fire(15_000);
    assert.deepEqual((await got).unreachable.map((u) => u.host), ['dev1']);
    assert.equal(a.events.some((e) => e.channel === 'remote:link' && e.payload.online === false), false);
    ssh.held.forEach((release) => release());
  });

  it('«История»: хост, к которому не подключиться, назван и показан в интерфейсе оффлайн с причиной', async (t) => {
    const { ssh } = await asleep(t, 'human');
    const b = side(t, ssh);
    ssh.failure = { code: 255, stdout: '', stderr: 'Permission denied (publickey)' };
    const got = await b.remote.history({ ...project, hosts: ['dev1'] });
    assert.deepEqual(got.entries, []);
    assert.equal(got.unreachable[0].host, 'dev1');
    const ev = b.events.find((e) => e.channel === 'remote:link' && e.payload.host === 'dev1' && e.payload.online === false);
    assert.ok(ev, 'вкладкам хоста показана потеря связи');
    assert.match(String(ev.payload.reason), /\S/);
  });

  it('wake собирает доступы заново: токен, сменившийся во время сна, доходит до агента', async (t) => {
    let token = 'glpat-ONE';
    const { r, ssh, a, sid } = await asleep(t, 'human', { gitAuth: async () => [{ kind: 'gitlab', host: 'h', token }] });
    token = 'glpat-TWO';
    const woke = await a.remote.wake(project, 'dev1', sid);
    await until(() => r.spawned.length === 2);
    assert.equal((ssh.seen.find((m) => m.type === 'wake') as any).auth.git[0].token, 'glpat-TWO');
    assert.equal(r.spawned[1].env.GITLAB_TOKEN, 'glpat-TWO');
    assert.deepEqual(woke.notes, ['на хосте нет glab: агент не откроет MR']);
  });

  it('удаление спящей: клоны убраны, грязный клон - текст отказа; запись снята, wake больше не находит; чужой хост - отказ', async (t) => {
    const { r, a, sid } = await asleep(t, 'human');
    r.answers['status --porcelain'] = { stdout: ' M f\n' };
    assert.match(await a.remote.removeAsleep(project, 'dev1', sid), /Уборка отказана - оставлены dev1:\S+\/work\/\S+\/a \(изменения в рабочем дереве\)/);
    assert.deepEqual((await a.remote.history(project)).entries, []);
    await assert.rejects(a.remote.wake(project, 'dev1', sid), /не найдена/);
    await assert.rejects(a.remote.wake(project, 'other', sid), /Некорректное/);
    await assert.rejects(a.remote.removeAsleep(project, 'dev1', '../x'), /Некорректное/);
  });
});

describe('доступы git и Claude', () => {
  const CLAUDE = 'sk-ant-oat01-' + 'c'.repeat(30);

  it('spawn несёт токены хостингов origin, хост рабочего репозитория и токен Claude; агент получает их окружением', async (t) => {
    const { r, ssh } = world(t);
    const asked: string[][] = [];
    const a = side(t, ssh, { deps: { gitAuth: async (urls) => (asked.push(urls), [{ kind: 'gitlab', host: 'h', token: 'glpat-ONE' }]), claudeToken: () => CLAUDE } });
    ssh.preflight = ((base) => (home: string) => base(home) + 'glab=/usr/bin/glab\n')(ssh.preflight);
    const info = await a.remote.create(project, human, { origin: 'human' });
    assert.deepEqual(asked, [['git@h:o/a.git', 'git@h:o/b.git']]);
    assert.deepEqual((ssh.seen.find((m) => m.type === 'spawn') as any).auth, { git: [{ kind: 'gitlab', host: 'h', token: 'glpat-ONE' }], primary: 'h', claude: CLAUDE });
    assert.deepEqual(info.notes, []);
    await until(() => r.spawned.length === 1);
    assert.equal(r.spawned[0].env.GITLAB_TOKEN, 'glpat-ONE');
    assert.equal(r.spawned[0].env.CLAUDE_CODE_OAUTH_TOKEN, CLAUDE);
  });

  it('хост без токена и сбой сбора не мешают запуску: заметка называет хост, клон идёт ключами хоста', async (t) => {
    const { r, ssh } = world(t);
    const a = side(t, ssh, { deps: { gitAuth: async () => Promise.reject(new Error('gh упал')) } });
    const info = await a.remote.create(project, human, { origin: 'human' });
    assert.deepEqual((ssh.seen.find((m) => m.type === 'spawn') as any).auth, { git: [], primary: 'h' });
    assert.deepEqual(info.notes, ['для h нет токена gh или glab на этой машине: клон и push идут ключами хоста']);
    await until(() => r.spawned.length === 1);
  });

  it('claude на хосте без входа: без токена - отказ с подсказкой, с токеном - запуск', async (t) => {
    const { ssh } = world(t);
    ssh.preflight = ((base) => (home: string) => base(home).replace('{"loggedIn":true}', '{"loggedIn":false}'))(ssh.preflight);
    await assert.rejects(side(t, ssh).remote.create(project, human, { origin: 'human' }), /не залогинен[\s\S]*Вход Claude на хостах/);
    const info = await side(t, ssh, { deps: { claudeToken: () => CLAUDE } }).remote.create(project, human, { origin: 'human' });
    assert.equal(info.host, 'dev1');
  });
});

describe('зеркало настройки Claude', () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64');
  const mirror = (hash: string) => ({
    hash,
    files: [{ rel: 'CLAUDE.md', mode: 0o644, b64: b64('# правила') }],
    marketplaces: [{ name: 'm', source: 'org/m' }],
    plugins: [],
    env: { FOO: 'bar' },
    mcp: { web: { type: 'http', url: 'https://mcp.example.com' } },
    skipped: ['плагин b@loc: маркетплейс loc лежит на этой машине, на хост не переносится'],
  });

  it('уходит на хост при смене хэша и один раз; маркетплейсы получают свой git-доступ; spawn несёт env, MCP и память', async (t) => {
    const { r, ssh } = world(t);
    let current = mirror('a'.repeat(64));
    const asked: string[][] = [];
    const a = side(t, ssh, {
      deps: {
        mirror: async () => current,
        memory: async (repo) => [{ rel: 'MEMORY.md', mode: 0o644, b64: b64(repo) }],
        gitAuth: async (urls) => (asked.push(urls), []),
      },
    });
    const info = await a.remote.create(project, human, { origin: 'human' });
    assert.deepEqual(ssh.seen.filter((m) => m.type === 'config').map((m) => m.hash), ['a'.repeat(64)]);
    assert.deepEqual(asked[0], ['https://github.com/org/m.git'], 'доступ маркетплейсам собирается отдельно от доступа сессии');
    assert.deepEqual((ssh.seen.find((m) => m.type === 'config') as any).auth, { git: [] });
    const spawn = ssh.seen.find((m) => m.type === 'spawn') as any;
    assert.deepEqual([spawn.env, Object.keys(spawn.mcp), spawn.memory[0].rel], [{ FOO: 'bar' }, ['web'], 'MEMORY.md']);
    assert.ok(info.notes?.includes(current.skipped[0]));
    assert.equal(fs.readFileSync(path.join(r.home, '.claude', 'CLAUDE.md'), 'utf8'), '# правила');
    await a.remote.create(project, { ...human, branch: 'feat/y' }, { origin: 'human' });
    assert.equal(ssh.seen.filter((m) => m.type === 'config').length, 1, 'тот же хэш не шлётся повторно');
    current = mirror('b'.repeat(64));
    await a.remote.create(project, { ...human, branch: 'feat/z' }, { origin: 'human' });
    assert.equal(ssh.seen.filter((m) => m.type === 'config').length, 2);
  });

  it('отказ хоста принять зеркало не мешает запуску: заметка называет причину', async (t) => {
    const { ssh } = world(t);
    const a = side(t, ssh, { deps: { mirror: async () => ({ ...mirror('нехэш'), skipped: [] }) } });
    const info = await a.remote.create(project, human, { origin: 'human' });
    assert.deepEqual(info.notes, ['для h нет токена gh или glab на этой машине: клон и push идут ключами хоста', 'настройка Claude на хост не передана: некорректная настройка Claude']);
    assert.ok(ssh.seen.some((m) => m.type === 'spawn'));
  });
});

describe('место на хосте', () => {
  it('мало места по hello: одно предупреждение на хост, переподключение его не повторяет', async (t) => {
    const { r, ssh } = world(t);
    const connect = r.daemon.connect.bind(r.daemon);
    r.daemon.connect = (c) => connect({ send: (m) => c.send(m.type === 'hello' ? { ...m, disk: { free: 1024 ** 3, total: 100 * 1024 ** 3 } } : m) });
    const clock = fakeTimers();
    const a = side(t, ssh, { timers: clock.timers });
    await a.remote.create(project, human, { origin: 'human' });
    const low = () => a.events.filter((e) => e.channel === 'remote:disk-low');
    assert.deepEqual(low().map((e) => e.payload), [{ host: 'dev1', free: 1024 ** 3, total: 100 * 1024 ** 3 }]);
    ssh.channels[0].cut();
    clock.fire(RECONNECT_MS[0]);
    await until(() => a.events.filter((e) => e.channel === 'remote:link' && e.payload.online).length === 2);
    assert.equal(low().length, 1);
  });

  it('места достаточно - предупреждения нет; disk и purge доходят до демона, чужой хост отвергается', async (t) => {
    const { r, ssh } = world(t);
    const a = side(t, ssh);
    await a.remote.create(project, human, { origin: 'human' });
    assert.equal(a.events.some((e) => e.channel === 'remote:disk-low'), false);
    r.answers['du -sk'] = { stdout: '2048\t/x\n' };
    const disk = await a.remote.disk(project, 'dev1');
    assert.equal(disk.host, 'dev1');
    assert.deepEqual(disk.sessions.map((s) => [s.state, s.bytes]), [['live', 2048 * 1024]]);
    const results = await a.remote.purge(project, 'dev1', [disk.sessions[0].sid], true);
    assert.match(String(results[0].error), /работает/);
    await assert.rejects(a.remote.disk(project, 'чужой'), /не из проекта/);
    await assert.rejects(a.remote.purge(project, 'dev1', ['../x'], true), /Некорректное/);
  });
});

describe('поиск у удалённой вкладки', () => {
  it('идёт на хост по корню вкладки; корень вне её клонов отвергается до хоста', async (t) => {
    const { ssh } = world(t);
    const a = side(t, ssh);
    const info = await a.remote.create(project, human, { origin: 'human' });
    const root = info.roots[0];
    fs.writeFileSync(path.join(root, 'f.ts'), 'needle\n');
    const options = { regex: false, caseSensitive: true, wholeWord: false };
    const reply = await a.remote.search(info.id, 'text', { root, query: 'needle', options });
    assert.deepEqual(reply.hits.map((h) => [h.rel, h.line, h.range]), [['f.ts', 1, { start: 0, end: 6 }]]);
    const sent = ssh.seen.length;
    await assert.rejects(a.remote.search(info.id, 'text', { root: '/loc/a', query: 'x', options }), /вне каталогов/);
    await assert.rejects(a.remote.search(info.id, 'changes', { root: `${root}-x`, query: 'x', options }), /вне каталогов/);
    assert.equal(ssh.seen.length, sent);
  });
});
