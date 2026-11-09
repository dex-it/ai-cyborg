import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { lockHolderAlive } from '../src/agentd/agentd';
import { uniqueNames } from '../src/agentd/daemon';
import type { Msg, SpawnMsg } from '../src/agentd/protocol';
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
  it('attach отдаёт вывод и события с отметки, отметка старше кольца - reset и хвост', async (t) => {
    const r = rig(t);
    const { c, conn, sid } = await open(r);
    const file = path.join(r.home, '.cyborg', 'sessions', sid, 'events.jsonl');
    fs.appendFileSync(file, '{"hook_event_name":"Stop"}\n');
    await until(() => c.of('events').length === 1);
    conn.close();
    r.procs[0].emit('after-1');
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
