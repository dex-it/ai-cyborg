import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Daemon } from '../src/agentd/daemon';
import type { Msg } from '../src/agentd/protocol';
import { bundleOf, installScript } from '../src/main/remote/install';
import { PREFLIGHT_SCRIPT } from '../src/main/remote/preflight';
import { RemoteSessions } from '../src/main/remote/remote-sessions';
import { RECONNECT_MS, type Timers } from '../src/main/remote/host-link';
import type { SshChannel, SshResult, SshTransport } from '../src/main/remote/ssh';
import type { Project } from '../src/main/projects';
import { SessionManager } from '../src/main/sessions';
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
  constructor(public daemon: Daemon, private readonly home: string) {}

  async run(alias: string, script: string): Promise<SshResult> {
    this.runs.push({ alias, script });
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
    const conn = this.daemon.connect({ send: (m) => closed || queueMicrotask(() => lines.forEach((cb) => cb(JSON.stringify(m)))) });
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
        if (!this.blocked) conn.receive(msg);
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

function side(t: { after: (fn: () => void) => void }, ssh: FakeSsh, extra: { originUrl?: (d: string) => Promise<string | null>; timers?: Timers; instance?: string } = {}): Side {
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
    closeDelayMs: 20,
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
    r.procs[0].emit('экран сессии');
    hook(r, sid, { hook_event_name: 'SessionStart' }, { hook_event_name: 'Notification', notification_type: 'permission_prompt' }, { hook_event_name: 'UserPromptSubmit' }, { hook_event_name: 'PostToolUse', cwd: '/h/w/b' });
    await new Promise((res) => setTimeout(res, 100));
    first.sessions.killAll();
    first.remote.closeLinks();
    assert.deepEqual(r.killed, []);
    const second = side(t, ssh, { instance: 'inst-2' });
    const found = await second.remote.discover(project);
    assert.equal(found.length, 1);
    assert.deepEqual(second.mcp.accepted, [[TOKEN(info.id), found[0].id]]);
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

  it('итог вкладки spawn_agent уходит в очередь вызвавшей, вкладка без keep закрывается по правилам close_agent', async (t) => {
    const { r, ssh } = world(t);
    const a = side(t, ssh);
    const caller = callerOf(a);
    const info = await a.remote.create(project, human, { origin: 'tool', spawnedBy: caller });
    await until(() => r.spawned.length === 1);
    const text = await a.remote.report(info.id, { status: 'ok', summary: 'готово', branch: 'feat/x', pr: 'https://x/pr/1' });
    assert.match(text, /Итог принят/);
    const peers = a.sessions.peers(caller);
    assert.equal(peers?.find((p) => p.id === caller)?.queued, 1);
    await assert.rejects(a.remote.report(info.id, { status: 'ok', summary: 'ещё' }), /уже отправлен/);
    await until(() => a.closedTabs.includes(info.id));
    assert.ok(r.killed.includes('SIGTERM'));
  });

  it('итог вкладки человека и вкладка с keep - уведомление, автозакрытия нет', async (t) => {
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
    const keep = await a.remote.create(project, human, { origin: 'tool', keep: true });
    await until(() => r.spawned.length === 2);
    await a.remote.report(keep.id, { status: 'ok', summary: 'x' });
    await new Promise((res) => setTimeout(res, 100));
    assert.deepEqual(r.killed, []);
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

  it('prepare: сверх предела хоста - ошибка до передачи вкладки', async (t) => {
    const { ssh } = world(t);
    const a = side(t, ssh);
    await a.remote.create(project, human, { origin: 'human' });
    await assert.rejects(a.remote.prepare('dev1', '/loc/a', { max_agents_per_host: 1 }), /предел 1/);
    await a.remote.prepare('dev1', '/loc/a');
  });
});
