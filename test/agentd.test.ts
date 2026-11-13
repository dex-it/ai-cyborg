import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { lockHolderAlive } from '../src/agentd/agentd';
import { uniqueNames } from '../src/agentd/daemon';
import { SLEEP_IDLE_MS, type Msg, type SpawnMsg } from '../src/agentd/protocol';
import { projectDirName } from '../src/main/history';
import { client, mode, rig, tick, until, type Rig } from './daemon-rig';

const spawnMsg = (over: Partial<SpawnMsg> = {}): Msg =>
  ({
    type: 'spawn',
    rid: 1,
    sid: 'aaaaaaaa-1',
    token: 'T'.repeat(43),
    repos: [
      { local: '/loc/a', url: 'git@h:o/a.git', name: 'a' },
      { local: '/loc/b', url: 'git@h:o/b.git', name: 'b' },
    ],
    selected: 0,
    branch: 'feat/x',
    prompt: "задание с 'кавычкой'",
    origin: 'tool',
    keep: false,
    limits: { maxPerHost: 4, taskMs: 4 * 3600_000, idleMs: 30 * 60_000 },
    cols: 120,
    rows: 40,
    ...over,
  }) as Msg;

async function open(r: Rig, over: Partial<SpawnMsg> = {}, instance = 'inst-1') {
  const c = client();
  const conn = r.daemon.connect(c);
  conn.receive({ type: 'hello', rid: 0, proto: 1, instance, fwd: undefined } as Msg);
  const before = r.spawned.length;
  conn.receive(spawnMsg(over));
  await until(() => r.spawned.length > before || c.of('exit').length > 0 || c.of('error').length > 0);
  return { c, conn, sid: (over.sid ?? 'aaaaaaaa-1') as string };
}

describe('daemon: запуск сессии', () => {
  it('клонирует все репозитории, рабочий - на ветке, запускает script с cwd выбранного клона', async (t) => {
    const r = rig(t);
    r.answers['ls-remote'] = { code: 2 };
    const { sid } = await open(r, { selected: 1 });
    const work = path.join(r.home, '.cyborg', 'work', sid);
    const clones = r.execs.filter((e) => e.args[0] === 'clone');
    assert.deepEqual(clones.map((e) => e.args.slice(1)), [['--', 'git@h:o/a.git', path.join(work, 'a')], ['--', 'git@h:o/b.git', path.join(work, 'b')]]);
    assert.ok(r.execs.some((e) => e.args.join(' ') === 'switch -c feat/x' && e.cwd === path.join(work, 'b')), 'нет ветки в origin - switch -c в клоне выбранного');
    assert.equal(r.spawned[0].file, 'script');
    assert.equal(r.spawned[0].cwd, path.join(work, 'b'));
    const launch = fs.readFileSync(path.join(r.home, '.cyborg', 'sessions', sid, 'launch.sh'), 'utf8');
    assert.ok(launch.includes(`'--add-dir' '${path.join(work, 'a')}'`), 'остальные клоны - через --add-dir');
    assert.ok(launch.includes(`'задание с '\\''кавычкой'\\'''`), 'одинарная кавычка экранирована');
  });

  it('launch.sh запускает claude в /bin/sh с аргументами как есть, логин-оболочка (fish, tcsh) не участвует', async (t) => {
    const r = rig(t);
    const { sid } = await open(r, { prompt: 'задание с \'кавычкой\' и $HOME' });
    const dir = path.join(r.home, '.cyborg', 'sessions', sid);
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-bin-'));
    t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done\n', { mode: 0o755 });
    const run = spawnSync('/bin/sh', [path.join(dir, 'launch.sh')], {
      encoding: 'utf8',
      env: { PATH: `${bin}:/usr/bin:/bin`, SHELL: '/nonexistent/fish', CYBORG_DIR: dir, CYBORG_SETTINGS: 's.json', CYBORG_MCP: 'm.json' },
    });
    assert.equal(run.status, 0, run.stderr);
    const argv = run.stdout.trimEnd().split('\n');
    assert.deepEqual(argv.slice(0, 4), ['--settings', 's.json', '--mcp-config', 'm.json']);
    assert.ok(argv.includes('задание с \'кавычкой\' и $HOME'));
  });

  it('ветка есть в origin - switch <ветка>; один репозиторий - без --add-dir', async (t) => {
    const r = rig(t);
    r.answers['ls-remote'] = { code: 0 };
    const { sid } = await open(r, { repos: [{ local: '/loc/a', url: 'u', name: 'a' }] });
    assert.ok(r.execs.some((e) => e.args.join(' ') === 'switch feat/x'));
    assert.equal(fs.readFileSync(path.join(r.home, '.cyborg', 'sessions', sid, 'launch.sh'), 'utf8').includes('--add-dir'), false);
  });

  it('токен лежит в mcp.json 0600 и не попадает ни в аргументы, ни в launch.sh, ни в meta.json, ни в окружение', async (t) => {
    const r = rig(t);
    const { sid } = await open(r);
    const dir = path.join(r.home, '.cyborg', 'sessions', sid);
    const mcp = path.join(dir, 'mcp.json');
    assert.equal(mode(mcp), 0o600);
    assert.equal(mode(path.join(dir, 'events.jsonl')), 0o600);
    assert.equal(mode(path.join(dir, 'meta.json')), 0o600);
    assert.equal(mode(path.join(dir, 'launch.sh')), 0o700);
    const token = 'T'.repeat(43);
    assert.ok(fs.readFileSync(mcp, 'utf8').includes(`Bearer ${token}`));
    assert.equal(fs.readFileSync(path.join(dir, 'launch.sh'), 'utf8').includes(token), false);
    assert.equal(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8').includes(token), false);
    assert.equal(JSON.stringify(r.spawned[0]).includes(token), false);
    assert.equal(r.spawned[0].env.CYBORG_MCP, mcp);
    assert.equal('CLAUDECODE' in r.spawned[0].env, false);
  });

  it('ошибка clone: готовые клоны убраны, сессия получает exit с причиной, вызвавшему - ended failed', async (t) => {
    const r = rig(t);
    r.answers['b.git'] = { code: 128, stderr: 'fatal: repository not found' };
    const { c, sid } = await open(r);
    await until(() => c.of('exit').length > 0);
    assert.match(String(c.of('exit')[0].reason), /repository not found/);
    assert.equal(c.of('ended')[0].status, 'failed');
    assert.equal(r.spawned.length, 0);
    assert.equal(fs.existsSync(path.join(r.home, '.cyborg', 'work', sid, 'a')), false);
  });

  it('прогресс клонирования идёт во вкладку строками вывода', async (t) => {
    const r = rig(t);
    const { c } = await open(r);
    assert.ok(c.of('data').some((m) => String(m.data).includes('клонирую a')));
  });
});

describe('daemon: события и вывод', () => {
  it('строки events.jsonl уходят клиенту по порядку со смещением, неполная строка - позже', async (t) => {
    const r = rig(t);
    const { c, sid } = await open(r);
    const file = path.join(r.home, '.cyborg', 'sessions', sid, 'events.jsonl');
    const a = JSON.stringify({ hook_event_name: 'SessionStart' });
    const b = JSON.stringify({ hook_event_name: 'UserPromptSubmit' });
    fs.appendFileSync(file, a + '\n' + b.slice(0, 5));
    await until(() => c.of('events').length >= 1);
    assert.deepEqual(c.of('events')[0].items, [{ off: 0, line: a }]);
    fs.appendFileSync(file, b.slice(5) + '\n');
    await until(() => c.of('events').length >= 2);
    assert.deepEqual(c.of('events')[1].items, [{ off: a.length + 1, line: b }]);
  });

  it('вывод процесса идёт как есть, символ UTF-8 на границе кусков склеивается', async (t) => {
    const r = rig(t);
    const { c } = await open(r);
    const bytes = Buffer.from('я');
    r.procs[0].emit(bytes.subarray(0, 1));
    r.procs[0].emit(bytes.subarray(1));
    const text = c.of('data').map((m) => m.data).join('');
    assert.ok(text.endsWith('я'));
  });

  it('выход процесса: exit клиенту, mcp.json удалён, чистые клоны убраны', async (t) => {
    const r = rig(t);
    const { c, sid } = await open(r);
    r.procs[0].exit(0);
    await until(() => c.of('exit').some((m) => m.sid === sid && m.code === 0));
    assert.equal(fs.existsSync(path.join(r.home, '.cyborg', 'sessions', sid, 'mcp.json')), false);
    assert.equal(fs.existsSync(path.join(r.home, '.cyborg', 'work', sid)), false);
  });

  it('ввод идёт в процесс; resize ставит размер tty через stty', async (t) => {
    const r = rig(t);
    const { conn, sid } = await open(r);
    conn.receive({ type: 'input', sid, data: 'ls\r' } as Msg);
    await until(() => r.procs[0].written.length === 1);
    assert.deepEqual(r.procs[0].written, ['ls\r']);
    fs.writeFileSync(path.join(r.home, '.cyborg', 'sessions', sid, 'tty'), '/dev/pts/7\n');
    conn.receive({ type: 'resize', sid, cols: 100, rows: 30 } as Msg);
    await until(() => r.execs.some((e) => e.file === 'stty'));
    assert.deepEqual(r.execs.find((e) => e.file === 'stty')?.args, ['-F', '/dev/pts/7', 'rows', '30', 'cols', '100']);
  });
});

describe('daemon: переподключение', () => {
  it('attach отдаёт вывод и события с отметки, отметка старше кольца - reset с режимами терминала и хвост', async (t) => {
    const r = rig(t);
    const { c, conn, sid } = await open(r);
    const file = path.join(r.home, '.cyborg', 'sessions', sid, 'events.jsonl');
    fs.appendFileSync(file, '{"hook_event_name":"Stop"}\n');
    await until(() => c.of('events').length === 1);
    conn.close();
    r.procs[0].emit('after-1\x1b[?2004h\x1b[?1049h');
    const big = 'x'.repeat(600 * 1024);
    r.procs[0].emit(big);
    r.procs[0].emit(big);
    const c2 = client();
    const conn2 = r.daemon.connect(c2);
    conn2.receive({ type: 'hello', rid: 0, instance: 'inst-1' } as Msg);
    conn2.receive({ type: 'attach', rid: 5, sid, outFrom: 0, evFrom: 0 } as Msg);
    await until(() => c2.of('data').length > 0);
    assert.equal(c2.of('reset').length, 1, 'отметка 0 старше начала кольца');
    assert.ok(Number(c2.of('reset')[0].at) > 0);
    assert.equal(c2.of('reset')[0].modes, '\x1b[?1049h\x1b[?2004h', 'режимы из вытесненного вывода');
    assert.equal(c2.of('events')[0].replay, true);
    assert.equal((c2.of('events')[0].items as unknown[]).length, 1);
  });

  it('догон событий при reattach ограничен хвостом, как при подхвате, и не растёт с длиной обрыва', async (t) => {
    const r = rig(t);
    const { conn, sid } = await open(r);
    conn.close();
    const file = path.join(r.home, '.cyborg', 'sessions', sid, 'events.jsonl');
    const line = JSON.stringify({ hook_event_name: 'PostToolUse', tool_response: 'x'.repeat(1000) }) + '\n';
    fs.appendFileSync(file, line.repeat(3000));
    const c2 = client();
    const conn2 = r.daemon.connect(c2);
    conn2.receive({ type: 'hello', rid: 0, instance: 'inst-1' } as Msg);
    conn2.receive({ type: 'attach', rid: 5, sid, outFrom: 0, evFrom: 0 } as Msg);
    await until(() => c2.of('events').length > 0);
    const items = c2.of('events').flatMap((m) => m.items as { off: number; line: string }[]);
    assert.ok(items.length > 0 && items.length < 3000, `строк ${items.length}`);
    assert.ok(items.reduce((n, i) => n + Buffer.byteLength(i.line) + 1, 0) <= 1024 * 1024);
    assert.equal(items[items.length - 1].off + Buffer.byteLength(line), 3000 * Buffer.byteLength(line));
  });

  it('attach к завершившейся сессии отдаёт exit и снимает запись: повторный list её не возвращает, демон простаивает', async (t) => {
    const r = rig(t);
    const { conn, sid } = await open(r);
    conn.close();
    r.procs[0].exit(0);
    await until(() => r.daemon.liveCount() === 0);
    const c2 = client();
    const conn2 = r.daemon.connect(c2);
    conn2.receive({ type: 'hello', rid: 0, instance: 'inst-1' } as Msg);
    conn2.receive({ type: 'list', rid: 1 } as Msg);
    await until(() => c2.of('list').length === 1);
    assert.equal((c2.of('list')[0].sessions as { exited: boolean }[])[0].exited, true);
    conn2.receive({ type: 'attach', rid: 2, sid, outFrom: 0, evFrom: 'tail' } as Msg);
    await until(() => c2.of('exit').length === 1);
    conn2.receive({ type: 'list', rid: 3 } as Msg);
    await until(() => c2.of('list').length === 2);
    assert.deepEqual(c2.of('list')[1].sessions, []);
    conn2.close();
    assert.equal(r.daemon.idle(), true);
  });

  it('сессию, которую держит другое окно, не подхватить; то же окно после обрыва - можно', async (t) => {
    const r = rig(t);
    const { sid } = await open(r);
    const other = client();
    const conn = r.daemon.connect(other);
    conn.receive({ type: 'hello', rid: 0, instance: 'inst-2' } as Msg);
    conn.receive({ type: 'attach', rid: 9, sid, outFrom: 0 } as Msg);
    await until(() => other.of('error').length === 1);
    assert.match(String(other.of('error')[0].message), /другим окном/);
    const same = client();
    const conn2 = r.daemon.connect(same);
    conn2.receive({ type: 'hello', rid: 0, instance: 'inst-1' } as Msg);
    conn2.receive({ type: 'attach', rid: 9, sid, outFrom: 0 } as Msg);
    await until(() => same.of('attach').length === 1);
  });

  it('list показывает живую сессию с токеном и каталогами; несуществующая - ошибка', async (t) => {
    const r = rig(t);
    const { sid } = await open(r);
    const c = client();
    const conn = r.daemon.connect(c);
    conn.receive({ type: 'hello', rid: 0, instance: 'inst-2' } as Msg);
    conn.receive({ type: 'list', rid: 1 } as Msg);
    await until(() => c.of('list').length === 1);
    const item = (c.of('list')[0].sessions as Record<string, unknown>[])[0];
    assert.equal(item.sid, sid);
    assert.deepEqual(item.dirs, ['/loc/a', '/loc/b']);
    assert.equal(item.token, 'T'.repeat(43));
    assert.equal(item.busy, true);
    conn.receive({ type: 'attach', rid: 2, sid: 'nope' } as Msg);
    await until(() => c.of('error').length === 1);
  });
});

describe('daemon: лимиты', () => {
  it('spawn сверх предела хоста отвергается; сессии человека считаются', async (t) => {
    const r = rig(t);
    await open(r, { origin: 'human', limits: { maxPerHost: 1, taskMs: 1, idleMs: 1 } });
    const c = client();
    const conn = r.daemon.connect(c);
    conn.receive({ type: 'hello', rid: 0, instance: 'x' } as Msg);
    conn.receive(spawnMsg({ sid: 'bbbbbbbb-2', limits: { maxPerHost: 1, taskMs: 1, idleMs: 1 } }));
    await until(() => c.of('error').length === 1);
    assert.match(String(c.of('error')[0].message), /предел 1/);
  });

  it('таймаут задачи и простой в working закрывают сессию и дают ended failed с причиной', async (t) => {
    const r = rig(t, { tickMs: 10 });
    const a = await open(r, { sid: 'aaaaaaaa-1', limits: { maxPerHost: 4, taskMs: 5000, idleMs: 3_600_000 } });
    r.clock.now += 6000;
    await until(() => a.c.of('ended').length === 1);
    assert.match(String(a.c.of('ended')[0].reason), /таймаут задачи/);
    assert.equal(a.c.of('ended')[0].status, 'failed');
    assert.ok(r.killed.includes('SIGTERM'));

    const b = await open(r, { sid: 'bbbbbbbb-2', limits: { maxPerHost: 4, taskMs: 3_600_000_000, idleMs: 1000 } }, 'inst-b');
    fs.appendFileSync(path.join(r.home, '.cyborg', 'sessions', 'bbbbbbbb-2', 'events.jsonl'), '{"hook_event_name":"UserPromptSubmit"}\n');
    await until(() => b.c.of('events').length === 1);
    r.clock.now += 2000;
    await until(() => b.c.of('ended').length === 1);
    assert.match(String(b.c.of('ended')[0].reason), /простой .* working/);
  });

  it('лимит без клиента: attach отдаёт ended раньше exit, после ack сессии на хосте нет', async (t) => {
    const r = rig(t, { tickMs: 10 });
    const { conn, sid } = await open(r, { limits: { maxPerHost: 4, taskMs: 5000, idleMs: 3_600_000 } });
    conn.close();
    r.clock.now += 6000;
    await until(() => r.killed.includes('SIGTERM'));
    const c = client();
    const back = r.daemon.connect(c);
    back.receive({ type: 'hello', rid: 0, instance: 'inst-1' } as Msg);
    await until(() => c.of('hello').length === 1);
    back.receive({ type: 'attach', rid: 1, sid, outFrom: 0, evFrom: 0 } as Msg);
    await until(() => c.of('exit').length === 1);
    const order = c.got.map((m) => m.type).filter((type) => type === 'ended' || type === 'exit');
    assert.deepEqual(order, ['ended', 'exit']);
    back.receive({ type: 'ack', rid: 2, sid } as Msg);
    await until(() => !fs.existsSync(path.join(r.home, '.cyborg', 'sessions', sid)));
  });

  it('в waiting простой не копится; сессия человека и сессия после report_done таймерам не подлежат', async (t) => {
    const r = rig(t, { tickMs: 10 });
    const w = await open(r, { sid: 'aaaaaaaa-1', limits: { maxPerHost: 8, taskMs: 3_600_000_000, idleMs: 1000 } }, 'i1');
    fs.appendFileSync(path.join(r.home, '.cyborg', 'sessions', 'aaaaaaaa-1', 'events.jsonl'), '{"hook_event_name":"SessionStart"}\n');
    await until(() => w.c.of('events').length === 1);
    const h = await open(r, { sid: 'bbbbbbbb-2', origin: 'human', limits: { maxPerHost: 8, taskMs: 1, idleMs: 1 } }, 'i2');
    const d = await open(r, { sid: 'cccccccc-3', limits: { maxPerHost: 8, taskMs: 1, idleMs: 1 } }, 'i3');
    d.conn.receive({ type: 'report', rid: 3, sid: 'cccccccc-3' } as Msg);
    await until(() => d.c.of('report').length === 1);
    r.clock.now += 10_000;
    await tick(100);
    assert.equal(w.c.of('ended').length + h.c.of('ended').length + d.c.of('ended').length, 0);
  });
});

describe('daemon: report и close', () => {
  it('повторный report - ошибка', async (t) => {
    const r = rig(t);
    const { c, conn, sid } = await open(r);
    conn.receive({ type: 'report', rid: 2, sid } as Msg);
    conn.receive({ type: 'report', rid: 3, sid } as Msg);
    await until(() => c.of('error').length === 1);
    assert.match(String(c.of('error')[0].message), /уже отправлен/);
  });

  it('close: чистый клон удалён, грязные оставлены с причиной, keep оставляет всё', async (t) => {
    const r = rig(t);
    const { c, conn, sid } = await open(r);
    const work = path.join(r.home, '.cyborg', 'work', sid);
    r.answers[`-C`] = {};
    r.answers['status --porcelain=v1'] = { stdout: '' };
    r.execs.length = 0;
    r.answers['rev-list'] = { stdout: '0\n' };
    conn.receive({ type: 'close', rid: 7, sid, keep: false } as Msg);
    await until(() => c.of('close').length === 1);
    assert.deepEqual((c.of('close')[0].removed as string[]).sort(), [path.join(work, 'a'), path.join(work, 'b')]);
    assert.equal(fs.existsSync(path.join(work, 'a')), false);
    assert.ok(r.killed.includes('SIGTERM'));
  });

  for (const [name, key, answer, reason] of [
    ['незапушенные коммиты', 'rev-list', { stdout: '2\n' }, 'незапушенные коммиты'],
    ['изменения в рабочем дереве', 'status --porcelain', { stdout: ' M f.ts\n' }, 'изменения в рабочем дереве'],
    ['stash', 'stash list', { stdout: 'stash@{0}: WIP\n' }, 'stash'],
    ['git с ошибкой', 'status --porcelain', { code: 128 }, 'клон не проверен: git завершился с ошибкой или не ответил'],
  ] as const) {
    it(`close: клон с причиной «${name}» остаётся, ответ называет путь`, async (t) => {
      const r = rig(t);
      const { c, conn, sid } = await open(r);
      r.answers[key] = answer;
      conn.receive({ type: 'close', rid: 7, sid, keep: false } as Msg);
      await until(() => c.of('close').length === 1);
      const kept = c.of('close')[0].kept as { path: string; reason: string }[];
      assert.equal(kept.length, 2);
      assert.equal(kept[0].reason, reason);
      assert.ok(fs.existsSync(kept[0].path));
    });
  }

  it('close с keep не проверяет клоны и оставляет их', async (t) => {
    const r = rig(t);
    const { c, conn, sid } = await open(r);
    r.execs.length = 0;
    conn.receive({ type: 'close', rid: 7, sid, keep: true } as Msg);
    await until(() => c.of('close').length === 1);
    assert.deepEqual(r.execs.map((e) => e.args.join(' ')), []);
    assert.deepEqual(c.of('close')[0].removed, []);
    assert.equal((c.of('close')[0].kept as unknown[]).length, 2);
  });
});

describe('daemon: уборка клона на настоящем git', () => {
  const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (cwd: string, ...args: string[]): string => {
    const run = spawnSync('git', args, { cwd, env: { ...process.env, ...ID }, encoding: 'utf8' });
    assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`);
    return run.stdout;
  };
  const realExec = (file: string, args: string[], opts?: { cwd?: string; env?: Record<string, string> }) => {
    const run = spawnSync(file, args, { cwd: opts?.cwd, env: { ...process.env, ...ID, ...opts?.env }, encoding: 'utf8' });
    return Promise.resolve({ code: run.status ?? 1, stdout: run.stdout ?? '', stderr: run.stderr ?? '' });
  };

  /** Сессия с одним клоном из локального bare-репозитория: origin настоящий, команды git - настоящие. */
  async function started(t: { after: (fn: () => void) => void }) {
    const r = rig(t, { exec: realExec });
    const origin = path.join(r.home, 'origin.git');
    git(r.home, 'init', '-q', '--bare', '-b', 'main', origin);
    const seed = path.join(r.home, 'seed');
    git(r.home, 'clone', '-q', origin, seed);
    git(seed, 'commit', '-q', '--allow-empty', '-m', 'one');
    git(seed, 'push', '-q', 'origin', 'HEAD:main');
    const { c, conn, sid } = await open(r, { repos: [{ local: '/loc/a', url: origin, name: 'a' }], branch: 'feat/x' });
    assert.equal(c.of('error').length, 0);
    const clone = path.join(r.home, '.cyborg', 'work', sid, 'a');
    return { r, c, conn, sid, clone };
  }

  const closeAndSee = async (c: ReturnType<typeof client>, conn: ReturnType<Rig['daemon']['connect']>, sid: string) => {
    conn.receive({ type: 'close', rid: 9, sid, keep: false } as Msg);
    await until(() => c.of('close').length === 1, 10_000);
    return c.of('close')[0] as unknown as { removed: string[]; kept: { path: string; reason: string }[] };
  };

  it('чистый клон на ветке из origin убирается', async (t) => {
    const { c, conn, sid, clone } = await started(t);
    const done = await closeAndSee(c, conn, sid);
    assert.deepEqual(done.removed, [clone]);
    assert.equal(fs.existsSync(clone), false);
  });

  it('коммит в detached HEAD клона, нигде не запушенный, не пропадает: клон остаётся с причиной', async (t) => {
    const { c, conn, sid, clone } = await started(t);
    git(clone, 'checkout', '-q', '--detach');
    git(clone, 'commit', '-q', '--allow-empty', '-m', 'работа в detached HEAD');
    const done = await closeAndSee(c, conn, sid);
    assert.deepEqual(done.kept, [{ path: clone, reason: 'незапушенные коммиты' }]);
    assert.ok(fs.existsSync(clone));
  });

  it('коммит в detached worktree клона тоже сохраняет клон', async (t) => {
    const { c, conn, sid, clone, r } = await started(t);
    git(clone, 'worktree', 'add', '-q', '--detach', path.join(r.home, 'wt'));
    git(path.join(r.home, 'wt'), 'commit', '-q', '--allow-empty', '-m', 'работа в worktree');
    const done = await closeAndSee(c, conn, sid);
    assert.deepEqual(done.kept, [{ path: clone, reason: 'незапушенные коммиты' }]);
    assert.ok(fs.existsSync(clone));
  });

  it('detached HEAD на коммите, который есть в origin, клон не удерживает', async (t) => {
    const { c, conn, sid, clone } = await started(t);
    git(clone, 'checkout', '-q', '--detach', 'origin/main');
    const done = await closeAndSee(c, conn, sid);
    assert.deepEqual(done.removed, [clone]);
  });
});

const sessDir = (r: Rig, sid: string) => path.join(r.home, '.cyborg', 'sessions', sid);
const readMeta = (r: Rig, sid: string) => JSON.parse(fs.readFileSync(path.join(sessDir(r, sid), 'meta.json'), 'utf8'));
const patchMeta = (r: Rig, sid: string, patch: Record<string, unknown>) =>
  fs.writeFileSync(path.join(sessDir(r, sid), 'meta.json'), JSON.stringify({ ...readMeta(r, sid), ...patch }));
const hook = (r: Rig, sid: string, name: string) => fs.appendFileSync(path.join(sessDir(r, sid), 'events.jsonl'), JSON.stringify({ hook_event_name: name }) + '\n');

/** Журнал разговора claude на хосте: без него пробуждение начинает разговор заново. */
function talked(r: Rig, sid: string) {
  const dir = path.join(r.home, '.claude', 'projects', projectDirName(readMeta(r, sid).cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), JSON.stringify({ type: 'ai-title', aiTitle: 'разговор' }) + '\n');
}

async function putToSleep(r: Rig, c: ReturnType<typeof client>, sid: string) {
  talked(r, sid);
  const seen = c.of('events').length;
  hook(r, sid, 'SessionStart');
  await until(() => c.of('events').length > seen);
  r.clock.now += SLEEP_IDLE_MS + 1;
  await until(() => c.of('slept').length === 1);
}

describe('daemon: круги работы', () => {
  it('report_done - один на круг: сообщение после итога открывает новый круг, итог снова принимается, сессия не закрывается', async (t) => {
    const r = rig(t);
    const { c, conn, sid } = await open(r);
    hook(r, sid, 'UserPromptSubmit');
    await until(() => c.of('events').length === 1);
    assert.equal(c.of('round').length, 0, 'первое сообщение - тот же первый круг');
    conn.receive({ type: 'report', rid: 2, sid } as Msg);
    await until(() => c.of('report').length === 1);
    hook(r, sid, 'UserPromptSubmit');
    await until(() => c.of('round').length === 1);
    assert.equal(c.of('round')[0].round, 2);
    conn.receive({ type: 'report', rid: 3, sid } as Msg);
    await until(() => c.of('report').length === 2);
    assert.equal(c.of('error').length, 0);
    assert.deepEqual(r.killed, [], 'итог сессию не останавливает');
    assert.equal(readMeta(r, sid).round, 2);
    assert.equal(readMeta(r, sid).reported, true);
  });

  it('таймаут задачи считается от начала круга, а не от запуска', async (t) => {
    const r = rig(t, { tickMs: 10 });
    const { c, conn, sid } = await open(r, { limits: { maxPerHost: 4, taskMs: 5000, idleMs: 3_600_000 } });
    conn.receive({ type: 'report', rid: 2, sid } as Msg);
    await until(() => c.of('report').length === 1);
    r.clock.now += 4000;
    hook(r, sid, 'UserPromptSubmit');
    await until(() => c.of('round').length === 1);
    r.clock.now += 4000;
    await tick(100);
    assert.equal(c.of('ended').length, 0, 'от запуска 8 с, от начала круга 4 с');
    r.clock.now += 2000;
    await until(() => c.of('ended').length === 1);
    assert.match(String(c.of('ended')[0].reason), /таймаут задачи/);
  });
});

describe('daemon: сон и пробуждение', () => {
  it('2 ч в waiting без хуков и ввода: группа остановлена, mcp.json удалён, slept, клоны и запись остаются; ввод отодвигает сон', async (t) => {
    const r = rig(t, { tickMs: 10 });
    const { c, conn, sid } = await open(r, { origin: 'human' });
    hook(r, sid, 'SessionStart');
    await until(() => c.of('events').length === 1);
    r.clock.now += SLEEP_IDLE_MS - 1000;
    conn.receive({ type: 'input', sid, data: 'x' } as Msg);
    r.clock.now += 2000;
    await tick(100);
    assert.equal(c.of('slept').length, 0, 'ввод - активность');
    r.clock.now += SLEEP_IDLE_MS;
    await until(() => c.of('slept').length === 1);
    assert.deepEqual(r.kills[0], { pid: r.procs[0].pid, signal: 'SIGTERM' });
    assert.equal(fs.existsSync(path.join(sessDir(r, sid), 'mcp.json')), false);
    for (const clone of readMeta(r, sid).clones) assert.ok(fs.existsSync(clone.path));
    assert.equal(readMeta(r, sid).state, 'asleep');
    assert.equal(c.of('exit').length, 0);
    assert.equal(r.daemon.liveCount(), 0);
    conn.close();
    assert.equal(r.daemon.idle(), true, 'спящие демон не держат');
  });

  it('в working и asking сессия не засыпает', async (t) => {
    const r = rig(t, { tickMs: 10 });
    const w = await open(r, { sid: 'aaaaaaaa-1', origin: 'human' }, 'i1');
    const a = await open(r, { sid: 'bbbbbbbb-2', origin: 'human' }, 'i2');
    hook(r, 'aaaaaaaa-1', 'UserPromptSubmit');
    fs.appendFileSync(path.join(sessDir(r, 'bbbbbbbb-2'), 'events.jsonl'), JSON.stringify({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'x' }) + '\n');
    await until(() => w.c.of('events').length === 1 && a.c.of('events').length === 1);
    r.clock.now += 3 * SLEEP_IDLE_MS;
    await tick(100);
    assert.equal(w.c.of('slept').length + a.c.of('slept').length, 0);
    assert.deepEqual(r.kills, []);
  });

  it('spawn задаёт номер разговора --session-id; wake будит спящую через --resume в том же клоне с новым токеном', async (t) => {
    const r = rig(t, { tickMs: 10 });
    const { c, conn, sid } = await open(r);
    const launch = () => fs.readFileSync(path.join(sessDir(r, sid), 'launch.sh'), 'utf8');
    assert.ok(launch().includes(`'--session-id' '${sid}'`));
    await putToSleep(r, c, sid);
    conn.receive({ type: 'wake', rid: 9, sid, token: 'N'.repeat(43), cols: 100, rows: 30 } as Msg);
    await until(() => r.spawned.length === 2);
    assert.equal(c.got.find((m) => m.rid === 9)?.round, 2);
    assert.ok(launch().includes(`'--resume' '${sid}'`));
    assert.equal(launch().includes('--session-id'), false);
    assert.equal(launch().includes("'задание с"), false, 'задание первым сообщением не повторяется');
    assert.equal(r.spawned[1].cwd, r.spawned[0].cwd);
    assert.ok(fs.readFileSync(path.join(sessDir(r, sid), 'mcp.json'), 'utf8').includes(`Bearer ${'N'.repeat(43)}`));
    assert.equal(readMeta(r, sid).state, 'live');
    r.procs[1].emit('снова');
    assert.equal(c.of('data').at(-1)?.at, 0, 'вывод пробуждённой - с начала');
    conn.receive({ type: 'wake', rid: 10, sid, token: 'N'.repeat(43), cols: 100, rows: 30 } as Msg);
    await until(() => c.got.some((m) => m.rid === 10));
    assert.match(String(c.got.find((m) => m.rid === 10)?.message), /не спит/);
  });

  it('wake сессии, куда ни разу не писали, начинает разговор заново под тем же номером, а не --resume без журнала', async (t) => {
    const r = rig(t, { tickMs: 10 });
    const { c, conn, sid } = await open(r);
    await putToSleep(r, c, sid);
    fs.rmSync(path.join(r.home, '.claude', 'projects'), { recursive: true });
    conn.receive({ type: 'wake', rid: 9, sid, token: 'N'.repeat(43), cols: 100, rows: 30 } as Msg);
    await until(() => r.spawned.length === 2);
    const launch = fs.readFileSync(path.join(sessDir(r, sid), 'launch.sh'), 'utf8');
    assert.ok(launch.includes(`'--session-id' '${sid}'`));
    assert.equal(launch.includes('--resume'), false);
    assert.equal(launch.includes("'задание с"), false, 'задание первым сообщением не повторяется');
  });

  it('wake проверяет предел хоста по умолчанию, а не limits прежнего spawn_agent', async (t) => {
    const r = rig(t, { tickMs: 10 });
    const { c, conn, sid } = await open(r, { origin: 'tool', limits: { maxPerHost: 16, taskMs: 4 * 3600_000, idleMs: 30 * 60_000 } });
    await putToSleep(r, c, sid);
    for (let i = 0; i < 4; i++) await open(r, { sid: `bbbbbbbb-${i}`, origin: 'human' }, `inst-${i + 2}`);
    conn.receive({ type: 'wake', rid: 9, sid, token: 'N'.repeat(43), cols: 100, rows: 30 } as Msg);
    await until(() => c.got.some((m) => m.rid === 9));
    assert.match(String(c.got.find((m) => m.rid === 9)?.message), /предел 4/);
    assert.equal(readMeta(r, sid).state, 'asleep');
  });

  it('wake спящей с узким пределом spawn_agent проходит, пока на хосте меньше умолчания', async (t) => {
    const r = rig(t, { tickMs: 10 });
    const { c, conn, sid } = await open(r, { origin: 'tool', limits: { maxPerHost: 1, taskMs: 4 * 3600_000, idleMs: 30 * 60_000 } });
    await putToSleep(r, c, sid);
    await open(r, { sid: 'bbbbbbbb-1', origin: 'human' }, 'inst-2');
    conn.receive({ type: 'wake', rid: 9, sid, token: 'N'.repeat(43), cols: 100, rows: 30 } as Msg);
    await until(() => r.spawned.length === 3);
    assert.equal(readMeta(r, sid).state, 'live');
  });

  it('wake отказывает, если клон рабочего репозитория удалён или токена сессии нет; сессия остаётся спящей', async (t) => {
    const r = rig(t, { tickMs: 10 });
    const { c, conn, sid } = await open(r);
    await putToSleep(r, c, sid);
    conn.receive({ type: 'wake', rid: 9, sid, cols: 100, rows: 30 } as Msg);
    await until(() => c.got.some((m) => m.rid === 9));
    assert.match(String(c.got.find((m) => m.rid === 9)?.message), /нет токена сессии/);
    fs.rmSync(readMeta(r, sid).cwd, { recursive: true, force: true });
    conn.receive({ type: 'wake', rid: 10, sid, token: 'N'.repeat(43), cols: 100, rows: 30 } as Msg);
    await until(() => c.got.some((m) => m.rid === 10));
    assert.match(String(c.got.find((m) => m.rid === 10)?.message), /клон рабочего репозитория сессии удалён/);
    assert.equal(readMeta(r, sid).state, 'asleep');
    assert.equal(r.spawned.length, 1);
  });

  it('разбуженная сессия spawn_agent - сессия человека: таймаут задачи и простой в working её не закрывают', async (t) => {
    const r = rig(t, { tickMs: 10 });
    const { c, conn, sid } = await open(r, { origin: 'tool', limits: { maxPerHost: 4, taskMs: 3 * SLEEP_IDLE_MS, idleMs: 1000 } });
    await putToSleep(r, c, sid);
    conn.receive({ type: 'wake', rid: 9, sid, token: 'N'.repeat(43), cols: 100, rows: 30 } as Msg);
    await until(() => r.spawned.length === 2);
    assert.equal(readMeta(r, sid).origin, 'human');
    hook(r, sid, 'UserPromptSubmit');
    await until(() => c.of('events').length >= 2);
    r.clock.now += 4 * SLEEP_IDLE_MS;
    await tick(100);
    assert.equal(c.of('ended').length, 0);
    assert.equal(c.of('exit').length, 0);
    assert.equal(readMeta(r, sid).state, 'live');
  });

  it('поздний выход прежнего процесса после wake не трогает разбуженную сессию', async (t) => {
    const r = rig(t, { tickMs: 10 });
    const { c, conn, sid } = await open(r);
    await putToSleep(r, c, sid);
    conn.receive({ type: 'wake', rid: 9, sid, token: 'N'.repeat(43), cols: 100, rows: 30 } as Msg);
    await until(() => r.spawned.length === 2);
    r.procs[0].exit(137);
    await tick(50);
    assert.equal(c.of('exit').length, 0);
    assert.ok(fs.existsSync(path.join(sessDir(r, sid), 'mcp.json')), 'токен разбуженной на месте');
    r.procs[1].emit('жива');
    await until(() => c.of('data').some((m) => String(m.data).includes('жива')));
  });

  it('list отдаёт спящую без токена с заголовком журнала claude; attach к спящей отвечает slept', async (t) => {
    const r = rig(t, { tickMs: 10 });
    const { c, conn, sid } = await open(r);
    await putToSleep(r, c, sid);
    const journal = path.join(r.home, '.claude', 'projects', projectDirName(readMeta(r, sid).cwd));
    fs.mkdirSync(journal, { recursive: true });
    fs.writeFileSync(path.join(journal, `${sid}.jsonl`), JSON.stringify({ type: 'ai-title', aiTitle: 'Чиню вход' }) + '\n');
    conn.receive({ type: 'list', rid: 4 } as Msg);
    await until(() => c.of('list').length === 1);
    const item = (c.of('list')[0].sessions as Record<string, unknown>[])[0];
    assert.equal(item.asleep, true);
    assert.equal(item.title, 'Чиню вход');
    assert.equal(item.branch, 'feat/x');
    assert.equal('token' in item, false);
    conn.receive({ type: 'attach', rid: 5, sid, outFrom: 0, evFrom: 'tail' } as Msg);
    await until(() => c.of('slept').length === 2);
  });

  it('close спящей убирает чистые клоны и снимает запись; hello и shutdown спящих не считают', async (t) => {
    const r = rig(t, { tickMs: 10 });
    const { c, conn, sid } = await open(r);
    await putToSleep(r, c, sid);
    conn.receive({ type: 'hello', rid: 6, instance: 'inst-1' } as Msg);
    await until(() => c.of('hello').length === 2);
    assert.equal(c.of('hello')[1].sessions, 0);
    conn.receive({ type: 'close', rid: 7, sid, keep: false } as Msg);
    await until(() => c.of('close').length === 1);
    assert.equal((c.of('close')[0].removed as string[]).length, 2);
    assert.equal(fs.existsSync(sessDir(r, sid)), false);
    conn.receive({ type: 'list', rid: 8 } as Msg);
    await until(() => c.of('list').length === 1);
    assert.deepEqual(c.of('list')[0].sessions, []);
  });
});

describe('daemon: перезапуск', () => {
  it('живая по записи сессия становится спящей, остатки её группы снимаются, mcp.json удаляется', async (t) => {
    const r = rig(t);
    const { sid } = await open(r);
    const pgid = r.procs[0].pid as number;
    r.daemon.stop();
    const r2 = rig(t, { groupOwned: (pid, marker) => pid === pgid && marker === path.join(sessDir(r, sid), 'launch.sh') }, r.home);
    await r2.daemon.init();
    assert.deepEqual(r2.kills[0], { pid: pgid, signal: 'SIGTERM' });
    assert.equal(readMeta(r2, sid).state, 'asleep');
    assert.equal(fs.existsSync(path.join(sessDir(r2, sid), 'mcp.json')), false);
    const c = client();
    const conn = r2.daemon.connect(c);
    conn.receive({ type: 'list', rid: 1 } as Msg);
    await until(() => c.of('list').length === 1);
    assert.equal((c.of('list')[0].sessions as { asleep?: boolean }[])[0].asleep, true);
  });

  it('чужая группа с тем же pgid не трогается', async (t) => {
    const r = rig(t);
    const { sid } = await open(r);
    r.daemon.stop();
    const r2 = rig(t, { groupOwned: () => false }, r.home);
    await r2.daemon.init();
    assert.deepEqual(r2.kills, []);
    assert.equal(readMeta(r2, sid).state, 'asleep');
  });

  it('прерванная уборка по лимиту доделывается и её итог доставляется; не дошедшая до запуска сессия убирается', async (t) => {
    const r = rig(t);
    const a = await open(r, { sid: 'aaaaaaaa-1' }, 'i1');
    await open(r, { sid: 'bbbbbbbb-2' }, 'i2');
    r.daemon.stop();
    patchMeta(r, 'aaaaaaaa-1', { closing: { keep: false, reason: 'превышен таймаут задачи 4 ч' } });
    patchMeta(r, 'bbbbbbbb-2', { launched: false });
    const r2 = rig(t, {}, r.home);
    await r2.daemon.init();
    const work = path.join(r.home, '.cyborg', 'work');
    assert.equal(fs.existsSync(path.join(work, 'bbbbbbbb-2')), false);
    assert.equal(fs.existsSync(sessDir(r, 'bbbbbbbb-2')), false);
    assert.equal(fs.existsSync(path.join(work, 'aaaaaaaa-1', 'a')), false);
    const c = client();
    const conn = r2.daemon.connect(c);
    conn.receive({ type: 'hello', rid: 0, instance: 'i1' } as Msg);
    conn.receive({ type: 'attach', rid: 1, sid: a.sid, outFrom: 0, evFrom: 0 } as Msg);
    await until(() => c.of('exit').length === 1);
    assert.match(String(c.of('ended')[0].reason), /таймаут задачи/);
    conn.receive({ type: 'ack', rid: 2, sid: a.sid } as Msg);
    await until(() => !fs.existsSync(sessDir(r, a.sid)));
  });

  const reattach = async (r: Rig, sid: string) => {
    const c = client();
    const conn = r.daemon.connect(c);
    conn.receive({ type: 'hello', rid: 0, instance: 'inst-1' } as Msg);
    conn.receive({ type: 'attach', rid: 1, sid, outFrom: 0, evFrom: 0 } as Msg);
    await tick(100);
    return { c, conn };
  };

  it('лимит с оставленными клонами: итог на диске переживает перезапуск демона до ack', async (t) => {
    const r = rig(t, { tickMs: 10 });
    r.answers['status --porcelain'] = { stdout: ' M x' };
    const { conn, sid } = await open(r, { limits: { maxPerHost: 4, taskMs: 5000, idleMs: 3_600_000 } });
    conn.close();
    r.clock.now += 6000;
    await until(() => readMeta(r, sid).state === 'done' && !!readMeta(r, sid).ended);
    r.daemon.stop();
    const r2 = rig(t, {}, r.home);
    await r2.daemon.init();
    const { c, conn: back } = await reattach(r2, sid);
    assert.deepEqual(c.got.map((m) => m.type).filter((x) => x === 'ended' || x === 'exit' || x === 'error'), ['ended', 'exit']);
    assert.match(String(c.of('ended')[0].reason), /таймаут задачи/);
    assert.equal(((c.of('ended')[0].cleanup as { kept: unknown[] }).kept).length, 2);
    back.receive({ type: 'ack', rid: 2, sid } as Msg);
    await until(() => readMeta(r2, sid).ended === undefined);
    assert.equal(fs.existsSync(path.join(r.home, '.cyborg', 'work', sid, 'a')), true, 'грязные клоны остаются');
  });

  it('ошибка клона при старте: итог переживает перезапуск демона до ack', async (t) => {
    const r = rig(t);
    r.answers['clone -- git@h:o/b.git'] = { code: 128, stderr: 'fatal: repository not found' };
    const { sid } = await open(r);
    await until(() => !!readMeta(r, sid).ended);
    r.daemon.stop();
    const r2 = rig(t, {}, r.home);
    await r2.daemon.init();
    const { c } = await reattach(r2, sid);
    assert.deepEqual(c.of('error'), []);
    assert.match(String(c.of('ended')[0].reason), /git clone b: fatal: repository not found/);
    assert.equal(c.of('exit').length, 1);
  });

  describe('лимит у сессии без процесса (идёт клонирование)', () => {
    const slowClone = (t: { after: (fn: () => void) => void }) => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      const r: Rig = rig(t, {
        tickMs: 10,
        exec: async (file, args, opts) => {
          if (args[0] === 'clone') {
            fs.mkdirSync(args[args.length - 1], { recursive: true });
            if (args[args.length - 1].endsWith(`${path.sep}b`)) await gate;
          }
          return { code: 0, stdout: '', stderr: '' };
        },
      });
      return { r, release };
    };
    const limits = { maxPerHost: 4, taskMs: 5000, idleMs: 3_600_000 };

    it('владелец на связи: ended и exit доходят, после ack каталога сессии на хосте нет', async (t) => {
      const { r, release } = slowClone(t);
      const c = client();
      const conn = r.daemon.connect(c);
      conn.receive({ type: 'hello', rid: 0, instance: 'inst-1' } as Msg);
      conn.receive(spawnMsg({ limits }));
      await until(() => fs.existsSync(path.join(r.home, '.cyborg', 'work', 'aaaaaaaa-1', 'a')));
      r.clock.now += 6000;
      await until(() => c.of('ended').length === 1);
      assert.match(String(c.of('ended')[0].reason), /таймаут задачи/);
      await until(() => c.of('exit').length === 1);
      conn.receive({ type: 'ack', rid: 2, sid: 'aaaaaaaa-1' } as Msg);
      await until(() => !fs.existsSync(sessDir(r, 'aaaaaaaa-1')));
      release();
    });

    it('владелец отключён: после переподключения attach отдаёт ended', async (t) => {
      const { r, release } = slowClone(t);
      const c = client();
      const conn = r.daemon.connect(c);
      conn.receive({ type: 'hello', rid: 0, instance: 'inst-1' } as Msg);
      conn.receive(spawnMsg({ limits }));
      await until(() => fs.existsSync(path.join(r.home, '.cyborg', 'work', 'aaaaaaaa-1', 'a')));
      conn.close();
      r.clock.now += 6000;
      await until(() => !!readMeta(r, 'aaaaaaaa-1').ended);
      const back = await reattach(r, 'aaaaaaaa-1');
      assert.deepEqual(back.c.of('error'), []);
      assert.match(String(back.c.of('ended')[0].reason), /таймаут задачи/);
      back.conn.receive({ type: 'ack', rid: 2, sid: 'aaaaaaaa-1' } as Msg);
      await until(() => !fs.existsSync(sessDir(r, 'aaaaaaaa-1')));
      release();
    });
  });

  it('завершённая с оставленными клонами сессия при перезапуске не поднимается', async (t) => {
    const r = rig(t);
    const { c, sid } = await open(r, { keep: true });
    r.procs[0].exit(0);
    await until(() => c.of('exit').length === 1);
    assert.equal(readMeta(r, sid).state, 'done');
    r.daemon.stop();
    const r2 = rig(t, {}, r.home);
    await r2.daemon.init();
    assert.equal(r2.daemon.idle(), true);
  });
});

describe('daemon: прокси MCP без Cyborg', () => {
  const post = (port: number, body: string): Promise<{ status: number; body: string }> =>
    new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => s.write(`POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`));
      let out = '';
      s.on('data', (d) => (out += d));
      s.on('close', () => resolve({ status: Number(/^HTTP\/1.1 (\d+)/.exec(out)?.[1]), body: out.split('\r\n\r\n')[1] ?? '' }));
    });

  it('tools/call - ошибка инструмента с причиной, прочее - 503, итог не засчитан', async (t) => {
    const r = rig(t);
    const { conn, sid } = await open(r);
    conn.close();
    const meta = JSON.parse(fs.readFileSync(path.join(r.home, '.cyborg', 'sessions', sid, 'meta.json'), 'utf8'));
    const call = await post(meta.port, JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'report_done' } }));
    assert.equal(call.status, 200);
    const reply = JSON.parse(call.body);
    assert.equal(reply.result.isError, true);
    assert.match(reply.result.content[0].text, /не на связи/);
    assert.equal((await post(meta.port, JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list' }))).status, 503);
    assert.equal((await post(meta.port, 'не json')).status, 400);
    assert.equal(JSON.parse(fs.readFileSync(path.join(r.home, '.cyborg', 'sessions', sid, 'meta.json'), 'utf8')).reported, false);
  });

  it('при наличии владельца с туннелем соединение идёт байтами в его сокет', async (t) => {
    const r = rig(t);
    const fwd = path.join(r.home, 'fwd.sock');
    const upstream = net.createServer((s) => s.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok'));
    await new Promise<void>((res) => upstream.listen(fwd, res));
    t.after(() => upstream.close());
    const c = client();
    const conn = r.daemon.connect(c);
    conn.receive({ type: 'hello', rid: 0, instance: 'i', fwd } as Msg);
    conn.receive(spawnMsg());
    await until(() => r.spawned.length > 0);
    const meta = JSON.parse(fs.readFileSync(path.join(r.home, '.cyborg', 'sessions', 'aaaaaaaa-1', 'meta.json'), 'utf8'));
    const res = await post(meta.port, '{}');
    assert.equal(res.body, 'ok');
  });
});

describe('daemon: файлы сессии', () => {
  it('путь вне клонов, с «..» и через symlink отвергается', async (t) => {
    const r = rig(t);
    const { c, conn, sid } = await open(r);
    const work = path.join(r.home, '.cyborg', 'work', sid);
    fs.symlinkSync('/etc', path.join(work, 'a', 'link'));
    let rid = 20;
    const ask = async (p: string) => {
      const id = rid++;
      conn.receive({ type: 'fs', rid: id, sid, op: 'list', path: p } as Msg);
      await until(() => c.got.some((m) => m.rid === id));
      return c.got.find((m) => m.rid === id) as Msg;
    };
    assert.match(String((await ask('/etc')).error), /вне каталогов/);
    assert.match(String((await ask(`${work}/a/../../..`)).error), /вне каталогов/);
    assert.match(String((await ask(`${work}/a/link`)).error), /вне каталогов/);
    assert.ok(Array.isArray((await ask(`${work}/a`)).value));
  });
});

describe('замок демона', () => {
  it('живой pid чужого процесса замок не держит, живой agentd - держит', { skip: process.platform !== 'linux' }, async (t) => {
    const other = spawn('sleep', ['30']);
    const daemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '/h/.cyborg/agentd/v/agentd.js', 'serve']);
    const bridge = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '/h/.cyborg/agentd/v/agentd.js', 'connect']);
    t.after(() => (other.kill(), daemon.kill(), bridge.kill()));
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(lockHolderAlive(other.pid!), false);
    assert.equal(lockHolderAlive(bridge.pid!), false, 'мост connect замок не держит');
    assert.equal(lockHolderAlive(daemon.pid!), true);
  });
});

describe('uniqueNames', () => {
  it('повтор имени получает суффикс', () => assert.deepEqual(uniqueNames(['a', 'b', 'a', 'a']), ['a', 'b', 'a-2', 'a-3']));
});

describe('daemon: доступы git и Claude', () => {
  const auth = {
    git: [
      { kind: 'gitlab', host: 'gl.example.com', token: 'glpat-SECRET1' },
      { kind: 'github', host: 'github.com', token: 'gho_SECRET2' },
    ],
    primary: 'gl.example.com',
    claude: 'sk-ant-oat01-SECRET3',
  } as SpawnMsg['auth'];
  const secrets = ['SECRET1', 'SECRET2', 'SECRET3'];

  it('клон и агент получают токены окружением, на диск хоста они не пишутся; после сна пробуждение без доступов их не несёт', async (t) => {
    const r = rig(t, { tickMs: 10 });
    const { c, conn, sid } = await open(r, { auth });
    for (const e of r.execs.filter((x) => x.args[0] === 'clone' || x.args[0] === 'ls-remote')) {
      assert.equal(e.env?.CYBORG_GIT_TOKEN_0, 'glpat-SECRET1', e.args.join(' '));
      assert.equal(e.env?.GIT_CONFIG_KEY_0, 'url.https://gl.example.com/.insteadOf');
    }
    const env = r.spawned[0].env;
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-SECRET3');
    assert.equal(env.GH_TOKEN, 'gho_SECRET2');
    assert.equal(env.GITLAB_TOKEN, 'glpat-SECRET1');
    assert.equal(env.GITLAB_HOST, 'https://gl.example.com');
    const onDisk = (): string => fs.readdirSync(sessDir(r, sid)).map((f) => fs.readFileSync(path.join(sessDir(r, sid), f), 'utf8')).join('\n');
    for (const s of secrets) assert.equal(onDisk().includes(s), false, s);
    await putToSleep(r, c, sid);
    conn.receive({ type: 'wake', rid: 9, sid, token: 'N'.repeat(43), cols: 100, rows: 30 } as Msg);
    await until(() => r.spawned.length === 2);
    for (const s of secrets) assert.equal(JSON.stringify(r.spawned[1].env).includes(s), false, s);
    for (const s of secrets) assert.equal(onDisk().includes(s), false, s);
  });

  it('пробуждение несёт свои доступы, env и серверы MCP пользователя; сон снимает mcp.json с ними', async (t) => {
    const r = rig(t, { tickMs: 10 });
    const web = { type: 'http', url: 'https://mcp.example.com', headers: { Authorization: 'Bearer SECRET4' } };
    const { c, conn, sid } = await open(r, { env: { FOO: 'one' }, mcp: { web } });
    const mcpFile = path.join(sessDir(r, sid), 'mcp.json');
    assert.ok(JSON.parse(fs.readFileSync(mcpFile, 'utf8')).mcpServers.web);
    await putToSleep(r, c, sid);
    assert.equal(fs.existsSync(mcpFile), false);
    conn.receive({ type: 'wake', rid: 9, sid, token: 'N'.repeat(43), cols: 100, rows: 30, auth, env: { FOO: 'two' }, mcp: { web } } as Msg);
    await until(() => r.spawned.length === 2);
    assert.equal(r.spawned[1].env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-SECRET3');
    assert.equal(r.spawned[1].env.GITLAB_TOKEN, 'glpat-SECRET1');
    assert.equal(r.spawned[1].env.FOO, 'two');
    assert.ok(JSON.parse(fs.readFileSync(mcpFile, 'utf8')).mcpServers.web);
  });

  it('доступы, не прошедшие проверку, отброшены без отказа запуска', async (t) => {
    const r = rig(t);
    await open(r, { auth: { git: [{ kind: 'gitlab', host: 'gl.example.com', token: 'a\nb' }], claude: 'x y' } as SpawnMsg['auth'] });
    assert.equal(r.spawned.length, 1);
    assert.equal('CYBORG_GIT_TOKEN_0' in r.spawned[0].env, false);
    assert.notEqual(r.spawned[0].env.CLAUDE_CODE_OAUTH_TOKEN, 'x y');
  });
});

describe('daemon: место на хосте', () => {
  const ask = async (conn: { receive(m: Msg): void }, c: ReturnType<typeof client>, msg: Record<string, unknown>) => {
    const rid = 100 + c.got.length;
    conn.receive({ ...msg, rid } as Msg);
    await until(() => c.got.some((m) => m.rid === rid));
    return c.got.find((m) => m.rid === rid) as Msg;
  };

  async function scene(t: { after: (fn: () => void) => void }, extra: Parameters<typeof rig>[1] = {}) {
    const r = rig(t, extra);
    const live = await open(r, { sid: 'aaaaaaaa-1' }, 'i1');
    const done = await open(r, { sid: 'bbbbbbbb-2' }, 'i2');
    r.answers['status --porcelain'] = { stdout: ' M f.ts\n' };
    done.conn.receive({ type: 'close', rid: 7, sid: 'bbbbbbbb-2', keep: false } as Msg);
    await until(() => done.c.of('close').length === 1);
    fs.mkdirSync(path.join(r.home, '.cyborg', 'work', 'cccccccc-3', 'x'), { recursive: true });
    r.answers['du -sk'] = { stdout: '123\t/x\n' };
    return { r, live };
  }

  it('disk: работающая без проверки клонов, завершённая с оставленными клонами и сирота; размер по du; hello несёт место', async (t) => {
    const { r, live } = await scene(t);
    const hello = live.c.got.find((m) => m.type === 'hello') as Msg;
    assert.ok(Number((hello.disk as { total: number }).total) > 0);
    r.execs.length = 0;
    const res = await ask(live.conn, live.c, { type: 'disk' });
    const by = Object.fromEntries((res.sessions as { sid: string }[]).map((s) => [s.sid, s])) as unknown as Record<string, { state: string; bytes: number; dirty: { reason: string }[]; branch: string }>;
    assert.deepEqual(Object.keys(by).sort(), ['aaaaaaaa-1', 'bbbbbbbb-2', 'cccccccc-3']);
    assert.equal(by['aaaaaaaa-1'].state, 'live');
    assert.deepEqual(by['aaaaaaaa-1'].dirty, []);
    assert.equal(by['bbbbbbbb-2'].state, 'done');
    assert.equal(by['bbbbbbbb-2'].branch, 'feat/x');
    assert.deepEqual(by['bbbbbbbb-2'].dirty.map((d) => d.reason), ['изменения в рабочем дереве', 'изменения в рабочем дереве']);
    assert.equal(by['cccccccc-3'].state, 'orphan');
    assert.equal(by['bbbbbbbb-2'].bytes, 123 * 1024);
    const live1 = path.join(r.home, '.cyborg', 'work', 'aaaaaaaa-1');
    assert.equal(r.execs.some((e) => e.file === 'git' && e.cwd?.startsWith(live1)), false, 'клоны работающей сессии не проверяются');
    assert.ok(Number(res.total) > 0);
  });

  it('disk: замер дольше бюджета не держит ответ - замеренные с размером, незамеренная помечена', async (t) => {
    const { r, live } = await scene(t, { diskBudgetMs: 300 });
    let release = (): void => {};
    r.hold['work/bbbbbbbb-2'] = new Promise((resolve) => (release = resolve));
    t.after(() => release());
    const res = await ask(live.conn, live.c, { type: 'disk' });
    const by = Object.fromEntries((res.sessions as { sid: string }[]).map((s) => [s.sid, s])) as unknown as Record<string, { measured: boolean; bytes: number | null; dirty: unknown[] }>;
    assert.deepEqual(by['bbbbbbbb-2'], { ...by['bbbbbbbb-2'], measured: false, bytes: null, dirty: [] });
    assert.equal(by['aaaaaaaa-1'].measured, true);
    assert.equal(by['cccccccc-3'].bytes, 123 * 1024);
  });

  it('disk: одновременно замеряются не больше четырёх сессий', async (t) => {
    const r = rig(t);
    const live = await open(r, { sid: 'aaaaaaaa-1' });
    for (let i = 0; i < 10; i++) fs.mkdirSync(path.join(r.home, '.cyborg', 'work', `dddddddd-${i}`, 'x'), { recursive: true });
    let release = (): void => {};
    r.hold['du -sk'] = new Promise((resolve) => (release = resolve));
    t.after(() => release());
    live.conn.receive({ type: 'disk', rid: 900 } as Msg);
    await until(() => r.inflight.now === 4);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(r.inflight.peak, 4);
    release();
    await until(() => live.c.got.some((m) => m.rid === 900));
    const res = live.c.got.find((m) => m.rid === 900) as Msg;
    assert.equal((res.sessions as { measured: boolean }[]).filter((s) => s.measured).length, 11);
  });

  it('purge: работающая - отказ, грязные без force остаются, с force и у сироты удаляются вместе с записью', async (t) => {
    const { r, live } = await scene(t);
    const work = path.join(r.home, '.cyborg', 'work');
    const first = (await ask(live.conn, live.c, { type: 'purge', sids: ['aaaaaaaa-1', 'bbbbbbbb-2', 'cccccccc-3'], force: false })).results as { kept: unknown[]; error?: string }[];
    assert.match(String(first[0].error), /работает/);
    assert.equal(first[1].kept.length, 2);
    assert.ok(fs.existsSync(path.join(work, 'bbbbbbbb-2', 'a')));
    assert.equal(first[2].kept.length, 1, 'сирота тоже проверяется');
    const second = (await ask(live.conn, live.c, { type: 'purge', sids: ['bbbbbbbb-2', 'cccccccc-3'], force: true })).results as { removed: string[] }[];
    assert.equal(second[0].removed.length, 2);
    assert.equal(fs.existsSync(path.join(work, 'bbbbbbbb-2')), false);
    assert.equal(fs.existsSync(sessDir(r, 'bbbbbbbb-2')), false);
    assert.equal(fs.existsSync(path.join(work, 'cccccccc-3')), false);
    assert.ok(fs.existsSync(path.join(work, 'aaaaaaaa-1', 'a')));
  });

  it('purge спящей: запись снята, list её больше не отдаёт', async (t) => {
    const r = rig(t, { tickMs: 10 });
    const { c, conn, sid } = await open(r, { origin: 'human' });
    await putToSleep(r, c, sid);
    const res = (await ask(conn, c, { type: 'purge', sids: [sid], force: false })).results as { removed: string[] }[];
    assert.equal(res[0].removed.length, 2);
    assert.equal(fs.existsSync(sessDir(r, sid)), false);
    const list = await ask(conn, c, { type: 'list' });
    assert.deepEqual(list.sessions, []);
  });
});

describe('daemon: поиск в клонах', () => {
  const gitIn = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };

  it('текст и изменения ищутся git в клоне, файлы по имени отдаются списком; корень вне клонов и негодный запрос отвергаются', async (t) => {
    const r = rig(t);
    const { c, conn, sid } = await open(r);
    const clone = path.join(r.home, '.cyborg', 'work', sid, 'a');
    gitIn(clone, 'init', '-q');
    fs.writeFileSync(path.join(clone, 'f.ts'), 'const alpha = 1;\n');
    gitIn(clone, 'add', '.');
    gitIn(clone, 'commit', '-qm', 'x');
    fs.writeFileSync(path.join(clone, 'f.ts'), 'const alpha = 2;\n');
    fs.writeFileSync(path.join(clone, 'new.ts'), 'alpha new\n');
    let rid = 300;
    const ask = async (msg: { type: string } & Record<string, unknown>) => {
      const id = rid++;
      conn.receive({ ...msg, rid: id, sid } as Msg);
      await until(() => c.got.some((m) => m.rid === id), 10_000);
      return c.got.find((m) => m.rid === id) as Msg;
    };
    const options = { regex: false, caseSensitive: false, wholeWord: false };
    const text = (await ask({ type: 'search', mode: 'text', request: { root: clone, query: 'alpha', options } })).value as { hits: { rel: string; line: number }[] };
    assert.deepEqual(text.hits.map((h) => `${h.rel}:${h.line}`).sort(), ['f.ts:1', 'new.ts:1']);
    const changes = (await ask({ type: 'search', mode: 'changes', request: { root: clone, query: 'alpha', options } })).value as { hits: { rel: string; sign: string }[] };
    assert.deepEqual(changes.hits.map((h) => `${h.sign}${h.rel}`).sort(), ['+f.ts', '+new.ts', '-f.ts']);
    assert.deepEqual(((await ask({ type: 'fs', op: 'files', path: clone })).value as string[]).sort(), ['f.ts', 'new.ts']);
    assert.match(String((await ask({ type: 'search', mode: 'text', request: { root: '/etc', query: 'root', options } })).error), /вне каталогов/);
    assert.match(String((await ask({ type: 'search', mode: 'text', request: { root: clone, query: 'a\nb', options } })).error), /Некорректные/);
    assert.match(String((await ask({ type: 'search', mode: 'exec', request: { root: clone, query: 'a', options } })).error), /Некорректные/);
  });
});

describe('daemon: голосовой ввод', () => {
  const self = { node: '/opt/node/bin/node', script: '/home/u/.cyborg/agentd/v1/agentd.js' };
  const askMic = (sock: string, line: string) =>
    new Promise<string>((resolve) => {
      const s = net.connect(sock, () => s.write(line + '\n'));
      let got = '';
      s.on('data', (d) => (got += d));
      s.on('close', () => resolve(got));
    });

  it('сессия получает подставной arecord первым в PATH и сокет микрофона 0600', async (t) => {
    const r = rig(t, { self });
    const { sid } = await open(r);
    const dir = path.join(r.home, '.cyborg', 'sessions', sid);
    const env = r.spawned[0].env;
    assert.equal(env.CYBORG_MIC, path.join(dir, 'mic.sock'));
    assert.equal(env.PATH.split(':')[0], path.join(dir, 'bin'));
    assert.equal(mode(path.join(dir, 'bin', 'arecord')), 0o700);
    assert.equal(fs.readFileSync(path.join(dir, 'bin', 'arecord'), 'utf8'), `#!/bin/sh\nexec '${self.node}' '${self.script}' arecord "$@"\n`);
    assert.equal(mode(env.CYBORG_MIC), 0o600);
  });

  it('без self голосового ввода нет: окружение как прежде', async (t) => {
    const r = rig(t);
    await open(r);
    assert.equal(r.spawned[0].env.CYBORG_MIC, undefined);
  });

  it('ответ сокета: туннель в hello - ok и запись с sid; без туннеля - выключен; без владельца - не на связи', async (t) => {
    const r = rig(t, { self });
    const fwd = path.join(r.home, 'mic-0123456789abcdef.sock');
    const heads: string[] = [];
    const upstream = net.createServer((s) => s.once('data', (d) => (heads.push(String(d)), s.end('ok\nPCM'))));
    await new Promise<void>((res) => upstream.listen(fwd, res));
    t.after(() => upstream.close());
    const conn = r.daemon.connect(client());
    conn.receive({ type: 'hello', rid: 0, instance: 'i', mic: fwd } as Msg);
    conn.receive(spawnMsg());
    await until(() => r.spawned.length > 0);
    const sock = r.spawned[0].env.CYBORG_MIC;
    assert.equal(await askMic(sock, 'probe'), 'ok\n');
    assert.equal(await askMic(sock, 'record'), 'ok\nPCM');
    assert.deepEqual(heads, ['{"sid":"aaaaaaaa-1"}\n']);
    conn.receive({ type: 'hello', rid: 1, instance: 'i' } as Msg);
    assert.match(await askMic(sock, 'record'), /^no голосовой ввод для этого хоста выключен/);
    conn.close();
    assert.equal(await askMic(sock, 'probe'), 'no Cyborg не на связи с хостом\n');
  });

  it('hello с путём mic не по форме туннеля не принимается', async (t) => {
    const r = rig(t, { self });
    const conn = r.daemon.connect(client());
    conn.receive({ type: 'hello', rid: 0, instance: 'i', mic: '/etc/passwd' } as Msg);
    conn.receive(spawnMsg());
    await until(() => r.spawned.length > 0);
    assert.match(await askMic(r.spawned[0].env.CYBORG_MIC, 'probe'), /выключен/);
  });

  it('устаревший туннель mic- прежнего подключения убирается, как fwd-', async (t) => {
    const r = rig(t, { self });
    const run = path.join(r.home, '.cyborg', 'run');
    const stale = path.join(run, 'mic-ffffffffffffffff.sock');
    const live = path.join(run, 'mic-0000000000000000.sock');
    fs.writeFileSync(stale, '');
    fs.writeFileSync(live, '');
    r.daemon.connect(client()).receive({ type: 'hello', rid: 0, instance: 'j', mic: live } as Msg);
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(live), true);
  });
});
