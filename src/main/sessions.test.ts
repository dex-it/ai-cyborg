import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MCP_SESSION_PROMPT, SESSION_PROMPT } from './claude-args.ts';
import { prepareEventsDir, createEventsFile } from './events-store.ts';
import { SessionManager, SUBMIT_DELAY_MS, waitingReason } from './sessions.ts';

const mode = (p: string) => fs.statSync(p).mode & 0o777;

test('существующий каталог событий сужается до 0700', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-ev-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, 'sessions');
  fs.mkdirSync(dir, { mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  prepareEventsDir(dir);
  assert.equal(mode(dir), 0o700);
});

test('новый каталог и файл событий закрыты при umask 000, права держатся после >>', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-ev-'));
  const prev = process.umask(0);
  t.after(() => {
    process.umask(prev);
    fs.rmSync(base, { recursive: true, force: true });
  });
  const dir = path.join(base, 'a', 'sessions');
  prepareEventsDir(dir);
  assert.equal(mode(dir), 0o700);
  const file = path.join(dir, '1-1.jsonl');
  fs.writeFileSync(file, 'old\n', { mode: 0o666 });
  fs.chmodSync(file, 0o666);
  createEventsFile(file);
  assert.equal(mode(file), 0o600);
  assert.equal(fs.readFileSync(file, 'utf8'), '');
  fs.appendFileSync(file, '{}\n');
  assert.equal(mode(file), 0o600);
});

function fakePty() {
  let exit: (e: { exitCode: number }) => void = () => {};
  return {
    onData: () => {},
    onExit: (cb: typeof exit) => {
      exit = cb;
    },
    write: () => {},
    resize: () => {},
    kill: () => exit({ exitCode: 0 }),
  };
}

function managerIn(t: { after: (fn: () => void) => void }, events: { channel: string; payload: any; at?: number }[] = [], stopDelayMs?: number) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-sm-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const manager = new SessionManager(userData, (channel, payload) => events.push({ channel, payload, at: Date.now() }), (() => fakePty()) as any, stopDelayMs);
  t.after(() => manager.killAll());
  return { userData, manager, events, eventsDir: path.join(userData, 'sessions') };
}

test('SessionManager сужает существующий каталог событий до 0700', (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-sm-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const dir = path.join(userData, 'sessions');
  fs.mkdirSync(dir);
  fs.chmodSync(dir, 0o755);
  new SessionManager(userData, () => {}, (() => fakePty()) as any);
  assert.equal(mode(dir), 0o700);
});

test('SessionManager создаёт файл событий с 0600 при umask 000', (t) => {
  const prev = process.umask(0);
  t.after(() => process.umask(prev));
  const { manager, eventsDir } = managerIn(t);
  assert.equal(mode(eventsDir), 0o700);
  const id = manager.create(os.tmpdir(), []);
  const file = path.join(eventsDir, `${process.pid}-${id}.jsonl`);
  assert.equal(mode(file), 0o600);
  fs.appendFileSync(file, '{}\n');
  assert.equal(mode(file), 0o600);
});

test('SessionManager читает события: смена cwd, активность, удаление файла на выходе', async (t) => {
  const events: { channel: string; payload: any }[] = [];
  const { manager, eventsDir } = managerIn(t, events);
  const id = manager.create('/a', []);
  const file = path.join(eventsDir, `${process.pid}-${id}.jsonl`);
  fs.appendFileSync(file, JSON.stringify({ hook_event_name: 'PostToolUse', cwd: '/b', tool_name: 'Edit' }) + '\n');
  for (let i = 0; i < 100 && !events.some((e) => e.channel === 'session:activity'); i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(events.find((e) => e.channel === 'session:cwd')?.payload, { id, cwd: '/b' });
  assert.deepEqual(events.find((e) => e.channel === 'session:activity')?.payload, { id, event: 'PostToolUse', tool: 'Edit' });
  manager.kill(id);
  assert.equal(fs.existsSync(file), false);
  assert.ok(events.some((e) => e.channel === 'session:exit'));
});

test('SessionManager не передаёт сессии CYBORG_CWD лаунчера', (t) => {
  const prev = process.env.CYBORG_CWD;
  process.env.CYBORG_CWD = '/launcher/cwd';
  t.after(() => (prev === undefined ? delete process.env.CYBORG_CWD : (process.env.CYBORG_CWD = prev)));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-sm-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  let env: Record<string, string> = {};
  const manager = new SessionManager(userData, () => {}, ((_file: string, _args: string[], opts: { env: Record<string, string> }) => ((env = opts.env), fakePty())) as any);
  t.after(() => manager.killAll());
  manager.create(os.tmpdir(), []);
  assert.equal('CYBORG_CWD' in env, false);
  assert.ok(env.CYBORG_EVENTS && env.CYBORG_SETTINGS);
});

test('SessionManager считает только работающие сессии', (t) => {
  const { manager } = managerIn(t);
  assert.equal(manager.count(), 0);
  const a = manager.create(os.tmpdir(), []);
  manager.create(os.tmpdir(), []);
  assert.equal(manager.count(), 2);
  manager.kill(a);
  assert.equal(manager.count(), 1);
  manager.killAll();
  assert.equal(manager.count(), 0);
});

test('SessionManager: каталоги работающих сессий - рабочий, дополнительные и текущий cwd; завершённая сессия их не держит', async (t) => {
  const events: { channel: string; payload: any }[] = [];
  const { manager, eventsDir } = managerIn(t, events);
  const tmp = os.tmpdir();
  assert.deepEqual(manager.liveDirs(), []);
  assert.equal(manager.uses(tmp), false);
  const id = manager.create(tmp, ['/extra']);
  assert.deepEqual(manager.liveDirs(), [tmp, '/extra', tmp]);
  assert.equal(manager.uses(tmp), true);
  assert.equal(manager.uses('/extra'), true, 'дополнительный каталог тоже занят сессией');
  assert.equal(manager.uses('/other'), false);
  fs.appendFileSync(path.join(eventsDir, `${process.pid}-${id}.jsonl`), JSON.stringify({ hook_event_name: 'PostToolUse', cwd: '/moved', tool_name: 'EnterWorktree' }) + '\n');
  for (let i = 0; i < 100 && !manager.liveDirs().includes('/moved'); i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(manager.liveDirs(), [tmp, '/extra', '/moved']);
  assert.equal(manager.uses('/moved'), false, 'uses смотрит каталоги запуска, а не текущий cwd');
  manager.kill(id);
  assert.deepEqual(manager.liveDirs(), []);
  assert.equal(manager.uses(tmp), false);
});

test('waitingReason: только ожидание человека, текст по типу события без содержимого ответа', () => {
  assert.equal(waitingReason({ hook_event_name: 'Stop' }), 'Ход завершён, ждёт ответа');
  assert.equal(
    waitingReason({ hook_event_name: 'Stop', last_assistant_message: 'пароль от стенда: hunter2', background_tasks: [], session_crons: [] }),
    'Ход завершён, ждёт ответа',
    'ответ Claude в уведомление не идёт',
  );
  assert.equal(waitingReason({ hook_event_name: 'Stop', background_tasks: [{ id: 't', type: 'subagent', status: 'running' }] }), null, 'пауза до фоновой задачи');
  assert.equal(waitingReason({ hook_event_name: 'Stop', session_crons: [{ id: 'c', schedule: '*/5 * * * *' }] }), null, 'пауза до пробуждения');
  assert.equal(
    waitingReason({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }),
    'Просит разрешение',
    'сообщение запроса в уведомление не идёт',
  );
  const byType: Record<string, string> = {
    elicitation_dialog: 'Задаёт вопрос',
    elicitation_url_dialog: 'Задаёт вопрос',
    agent_needs_input: 'Ждёт ответа',
    quota_auto_resume_stale: 'Остановилась на лимите',
    quota_auto_resume_disabled: 'Остановилась на лимите',
  };
  for (const [type, text] of Object.entries(byType)) assert.equal(waitingReason({ hook_event_name: 'Notification', notification_type: type, message: 'секрет' }), text, type);
  for (const type of ['idle_prompt', 'auth_success', 'elicitation_complete', 'elicitation_response', 'agent_completed', 'quota_auto_resume_fired', 'plugin_notification', 'unknown_future_type', undefined]) {
    assert.equal(waitingReason({ hook_event_name: 'Notification', notification_type: type, message: 'm' }), null, String(type));
  }
  assert.equal(waitingReason({ hook_event_name: 'PostToolUse' }), null);
  assert.equal(waitingReason({ hook_event_name: 'UserPromptSubmit' }), null);
});

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
};

test('SessionManager: после Stop «ждёт» объявляется, только если сессия промолчала задержку', async (t) => {
  const events: { channel: string; payload: any; at?: number }[] = [];
  const delay = 150;
  const { manager, eventsDir } = managerIn(t, events, delay);
  const id = manager.create(os.tmpdir(), []);
  const file = path.join(eventsDir, `${process.pid}-${id}.jsonl`);
  const append = (...lines: object[]) => fs.appendFileSync(file, lines.map((e) => JSON.stringify(e) + '\n').join(''));
  const activity = () => events.filter((e) => e.channel === 'session:activity');
  const waiting = () => events.filter((e) => e.channel === 'session:waiting');

  // Оба события одной записью: прочитаны одним проходом, задержка нагрузки машины на проверку не влияет.
  append({ hook_event_name: 'Stop', last_assistant_message: 'первый' }, { hook_event_name: 'PostToolUse', tool_name: 'Bash' });
  await until(() => activity().length === 2);
  await new Promise((r) => setTimeout(r, delay * 2));
  assert.deepEqual(waiting(), [], 'ход продолжился - Stop не ожидание');

  append({ hook_event_name: 'Stop', last_assistant_message: 'готово' });
  await until(() => activity().length === 3);
  await until(() => waiting().length > 0);
  assert.deepEqual(waiting().map((e) => e.payload), [{ id, reason: 'Ход завершён, ждёт ответа' }]);
  // Моменты событий снимает сам эмиттер, поэтому проверка не зависит от скорости опроса.
  assert.ok(waiting()[0].at! - activity()[2].at! >= delay - 5, 'раньше задержки не объявляется');
  manager.kill(id);
});

test('SessionManager: запрос разрешения объявляется сразу, выход сессии снимает отложенный Stop', async (t) => {
  const events: { channel: string; payload: any }[] = [];
  const { manager, eventsDir } = managerIn(t, events, 150);
  const id = manager.create(os.tmpdir(), []);
  const file = path.join(eventsDir, `${process.pid}-${id}.jsonl`);
  fs.appendFileSync(file, JSON.stringify({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'разрешите Bash' }) + '\n');
  await until(() => events.some((e) => e.channel === 'session:waiting'));
  assert.deepEqual(events.find((e) => e.channel === 'session:waiting')?.payload, { id, reason: 'Просит разрешение' });
  fs.appendFileSync(file, JSON.stringify({ hook_event_name: 'Stop' }) + '\n');
  await until(() => events.filter((e) => e.channel === 'session:activity').length === 2);
  manager.kill(id);
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(events.filter((e) => e.channel === 'session:waiting').length, 1);
});

test('SessionManager: хвост ответа на Stop с кнопками уходит событием session:suggest, без кнопок события нет', async (t) => {
  const events: { channel: string; payload: any }[] = [];
  const { manager, eventsDir } = managerIn(t, events, 60_000);
  const id = manager.create(os.tmpdir(), []);
  const file = path.join(eventsDir, `${process.pid}-${id}.jsonl`);
  const append = (...lines: object[]) => fs.appendFileSync(file, lines.map((e) => JSON.stringify(e) + '\n').join(''));
  const activity = () => events.filter((e) => e.channel === 'session:activity').length;
  append({ hook_event_name: 'Stop', last_assistant_message: 'готово' });
  await until(() => activity() === 1);
  assert.equal(events.filter((e) => e.channel === 'session:suggest').length, 0);
  append(
    { hook_event_name: 'PostToolUse', last_assistant_message: 'Готово.\n<!-- cyborg-buttons: [{"label":"A","text":"a"}] -->' },
    { hook_event_name: 'Stop', last_assistant_message: 'Готово.\n<!-- cyborg-buttons: [{"label":"Тест","text":"напиши тест","submit":true}] -->' },
  );
  await until(() => activity() === 3);
  assert.deepEqual(events.filter((e) => e.channel === 'session:suggest').map((e) => e.payload), [{ id, buttons: [{ label: 'Тест', text: 'напиши тест', submit: true }] }]);
  manager.kill(id);
});

test('SessionManager: предложение снимается, когда модель снова работает без запроса человека; без предложения лишних событий нет', async (t) => {
  const events: { channel: string; payload: any }[] = [];
  const { manager, eventsDir } = managerIn(t, events, 60_000);
  const id = manager.create(os.tmpdir(), []);
  const file = path.join(eventsDir, `${process.pid}-${id}.jsonl`);
  const append = (...lines: object[]) => fs.appendFileSync(file, lines.map((e) => JSON.stringify(e) + '\n').join(''));
  const activity = () => events.filter((e) => e.channel === 'session:activity').length;
  const suggests = () => events.filter((e) => e.channel === 'session:suggest').map((e) => e.payload.buttons.length);
  append({ hook_event_name: 'PostToolUse' }, { hook_event_name: 'Notification', notification_type: 'permission_prompt' });
  await until(() => activity() === 2);
  assert.deepEqual(suggests(), [], 'предложения не было - снимать нечего');
  const stop = { hook_event_name: 'Stop', last_assistant_message: 'Готово.\n<!-- cyborg-buttons: [{"label":"Да","text":"продолжай","submit":true}] -->' };
  append(stop, { hook_event_name: 'Notification', notification_type: 'idle_prompt' });
  await until(() => activity() === 4);
  assert.deepEqual(suggests(), [1], 'idle_prompt повторяет Stop и предложение не снимает');
  append({ hook_event_name: 'PostToolUse' }, { hook_event_name: 'PostToolUse' });
  await until(() => activity() === 6);
  assert.deepEqual(suggests(), [1, 0], 'работа модели сняла предложение один раз');
  append(stop, { hook_event_name: 'UserPromptSubmit' }, { hook_event_name: 'PostToolUse' });
  await until(() => activity() === 9);
  assert.deepEqual(suggests(), [1, 0, 1], 'запрос человека снимает интерфейс, повторного снятия из главного процесса нет');
  append(stop, { hook_event_name: 'Notification', notification_type: 'permission_prompt' });
  await until(() => activity() === 11);
  assert.deepEqual(suggests(), [1, 0, 1, 1, 0], 'запрос разрешения снял предложение');
  manager.kill(id);
});

test('SessionManager: инструменты фонового субагента предложение не снимают, следующий Stop без кнопок снимает', async (t) => {
  const events: { channel: string; payload: any }[] = [];
  const { manager, eventsDir } = managerIn(t, events, 60_000);
  const id = manager.create(os.tmpdir(), []);
  const file = path.join(eventsDir, `${process.pid}-${id}.jsonl`);
  const append = (...lines: object[]) => fs.appendFileSync(file, lines.map((e) => JSON.stringify(e) + '\n').join(''));
  const activity = () => events.filter((e) => e.channel === 'session:activity').length;
  const suggests = () => events.filter((e) => e.channel === 'session:suggest').map((e) => e.payload.buttons.length);
  const stop = {
    hook_event_name: 'Stop',
    background_tasks: [{}],
    last_assistant_message: 'Жду ревьюера.\n<!-- cyborg-buttons: [{"label":"Сливай","text":"сливай","submit":true}] -->',
  };
  const agentTool = { hook_event_name: 'PostToolUse', tool_name: 'Bash', agent_id: 'a8f173bea9820a1e1' };
  append(stop, agentTool, agentTool);
  await until(() => activity() === 3);
  assert.deepEqual(suggests(), [1], 'работа фонового субагента предложение не сняла');
  append({ hook_event_name: 'Stop', last_assistant_message: 'Ревью чистое.' });
  await until(() => activity() === 4);
  assert.deepEqual(suggests(), [1, 0], 'новый ответ без кнопок снял предложение прошлого');
  append({ hook_event_name: 'Stop', last_assistant_message: 'Ещё ответ.' });
  await until(() => activity() === 5);
  assert.deepEqual(suggests(), [1, 0], 'без предложения лишних событий нет');
  manager.kill(id);
});

// Менеджер с pty, записывающим вызовы; throwing - pty, бросающий на каждом вызове (процесс завершился, дескриптор закрыт).
function recordingManager(t: { after: (fn: () => void) => void }, throwing = false) {
  const calls: unknown[][] = [];
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-sm-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const record = (name: string) => (...args: unknown[]) => {
    calls.push([name, ...args]);
    if (throwing) throw new Error(`${name}: pty закрыт`);
  };
  let exit: (e: { exitCode: number }) => void = () => {};
  const spawn = () => ({ onData: () => {}, onExit: (cb: typeof exit) => (exit = cb), write: record('write'), resize: record('resize'), kill: record('kill') });
  const manager = new SessionManager(userData, () => {}, spawn as any);
  const id = manager.create(os.tmpdir(), []);
  t.after(() => exit({ exitCode: 0 })); // закрывает наблюдателя файла событий
  return { manager, id, calls };
}

test('SessionManager: допустимые ввод, размер и kill доходят до pty', (t) => {
  const { manager, id, calls } = recordingManager(t);
  manager.write(id, 'ls\r');
  manager.write(id, 'я'.repeat(200 * 1024));
  manager.resize(id, 100, 30);
  manager.kill(id);
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['write', 'write', 'resize', 'kill'],
  );
  assert.deepEqual(calls[0], ['write', 'ls\r']);
  assert.deepEqual(calls[2], ['resize', 100, 30]);
});

test('SessionManager: мусорные аргументы не бросают и до pty не доходят', (t) => {
  const { manager, id, calls } = recordingManager(t);
  const junk: unknown[] = [12345, null, undefined, {}, ['x'], true, NaN, Infinity, '1', -1, 1.5, 1e9, Symbol('s'), 1n];
  for (const bad of junk) {
    assert.doesNotThrow(() => manager.write(id, typeof bad === 'string' ? 12 : bad)); // строка - допустимые данные
    assert.doesNotThrow(() => manager.write(bad, 'x'));
    assert.doesNotThrow(() => manager.resize(id, bad, 24));
    assert.doesNotThrow(() => manager.resize(id, 80, bad));
    assert.doesNotThrow(() => manager.resize(bad, 80, 24));
    assert.doesNotThrow(() => manager.kill(bad));
  }
  assert.doesNotThrow(() => manager.write(id, 'x'.repeat(5 * 1024 * 1024)));
  assert.doesNotThrow(() => manager.resize(id, 1e9, 1e9));
  assert.doesNotThrow(() => manager.resize(id, 0, 0));
  assert.doesNotThrow(() => manager.write(999, 'нет такой сессии'));
  assert.deepEqual(calls, []);
});

test('SessionManager: pty, бросающий на вызове, не роняет вызывающего', (t) => {
  const { manager, id, calls } = recordingManager(t, true);
  assert.doesNotThrow(() => manager.write(id, 'x'));
  assert.doesNotThrow(() => manager.resize(id, 80, 24));
  assert.doesNotThrow(() => manager.kill(id));
  assert.equal(calls.length, 3);
});

type SpawnCall = { args: string[]; env: Record<string, string> };

function spawningManager(t: { after: (fn: () => void) => void }) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-sm-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const pty = fakePty();
  const box: { call: SpawnCall } = { call: { args: [], env: {} } };
  const spawn = (_file: string, args: string[], opts: { env: Record<string, string> }) => ((box.call = { args, env: opts.env }), pty);
  const manager = new SessionManager(userData, () => {}, spawn as any);
  t.after(() => manager.killAll());
  return { userData, manager, pty, box };
}

test('SessionManager с MCP: конфиг сессии в файле 0600, ключ --mcp-config, на выходе файл удалён и токен отозван', (t) => {
  const prev = process.umask(0);
  t.after(() => process.umask(prev));
  const { userData, manager, pty, box } = spawningManager(t);
  const log: string[] = [];
  manager.mcp = { connect: (id) => (log.push(`connect ${id}`), { token: `t${id}` }), disconnect: (id) => void log.push(`disconnect ${id}`) };
  manager.pluginDir = '/app/plugin';
  const id = manager.create('/repo/a', ['/repo/b']);
  assert.equal(box.call.env.CYBORG_PLUGIN, '/app/plugin');
  assert.match(box.call.args[1], /^exec claude --settings "\$CYBORG_SETTINGS" --plugin-dir "\$CYBORG_PLUGIN" --mcp-config /);
  const file = box.call.env.CYBORG_MCP;
  assert.equal(file, path.join(userData, 'sessions', `${process.pid}-${id}.mcp.json`));
  assert.equal(mode(file), 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { token: `t${id}` });
  assert.match(box.call.args[1], /--mcp-config "\$CYBORG_MCP" "\$@"$/);
  // Вариадический --mcp-config заканчивается на первом ключе args.
  assert.match(box.call.args[3], /^--/);
  assert.equal(box.call.args[4], MCP_SESSION_PROMPT);
  assert.deepEqual(manager.dirsOf(id), ['/repo/a', '/repo/b']);
  pty.kill();
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(log, [`connect ${id}`, `disconnect ${id}`]);
  assert.equal(manager.dirsOf(id), null);
});

test('SessionManager без MCP запускает claude без --mcp-config', (t) => {
  const { manager, box } = spawningManager(t);
  manager.create(os.tmpdir(), []);
  assert.equal(box.call.args[1], 'exec claude --settings "$CYBORG_SETTINGS" "$@"');
  assert.equal(box.call.args[4], SESSION_PROMPT);
  assert.equal('CYBORG_MCP' in box.call.env, false);
  assert.equal('CYBORG_PLUGIN' in box.call.env, false);
});

test('SessionManager с плагином без MCP: скиллы подключены, инструкции о параллельных сессиях нет', (t) => {
  const { manager, box } = spawningManager(t);
  manager.pluginDir = '/app/plugin';
  manager.create(os.tmpdir(), []);
  assert.equal(box.call.args[1], 'exec claude --settings "$CYBORG_SETTINGS" --plugin-dir "$CYBORG_PLUGIN" "$@"');
  assert.equal(box.call.args[4], SESSION_PROMPT);
});

test('SessionManager с MCP без плагина: инструкции о параллельных сессиях нет - скилла, на который она ссылается, у сессии нет', (t) => {
  const { manager, box } = spawningManager(t);
  manager.mcp = { connect: () => ({}), disconnect: () => {} };
  manager.create(os.tmpdir(), []);
  assert.equal(box.call.args[4], SESSION_PROMPT);
});

test('SessionManager: состояние сессии и хвост ответа для list_sessions, соседи - сессии с теми же каталогами', async (t) => {
  const events: { channel: string; payload: any }[] = [];
  const { manager, eventsDir } = managerIn(t, events);
  const id = manager.create('/repo/a', ['/repo/b']);
  const sibling = manager.create('/repo/b', ['/repo/a']);
  manager.create('/other', []);
  const file = path.join(eventsDir, `${process.pid}-${id}.jsonl`);
  const state = () => manager.peers(id)!.find((p) => p.id === id)!;
  const push = async (event: object) => {
    const seen = events.length;
    fs.appendFileSync(file, JSON.stringify(event) + '\n');
    for (let i = 0; i < 100 && events.length === seen; i++) await new Promise((r) => setTimeout(r, 10));
  };
  assert.deepEqual(manager.peers(id)!.map((p) => p.id), [id, sibling]);
  assert.equal(state().state, 'starting');
  await push({ hook_event_name: 'SessionStart' });
  assert.equal(state().state, 'waiting');
  await push({ hook_event_name: 'UserPromptSubmit' });
  await push({ hook_event_name: 'SessionStart', source: 'compact' });
  assert.equal(state().state, 'working');
  await push({ hook_event_name: 'Notification', notification_type: 'permission_prompt' });
  assert.deepEqual([state().state, state().reason], ['asking', 'Просит разрешение']);
  await push({ hook_event_name: 'Notification', notification_type: 'idle_prompt' });
  assert.equal(state().state, 'asking');
  await push({ hook_event_name: 'PostToolUse', tool_name: 'Bash' });
  assert.deepEqual([state().state, state().reason], ['working', undefined]);
  await push({ hook_event_name: 'Stop', last_assistant_message: 'Готово.\n\n<!-- cyborg-buttons: [{"label":"Дальше","text":"дальше"}] -->' });
  assert.deepEqual([state().state, state().lastAnswer], ['waiting', 'Готово.']);
  await push({ hook_event_name: 'PostToolUse', tool_name: 'Read', agent_id: 'bg' });
  assert.equal(state().state, 'waiting');
  manager.kill(sibling);
  assert.deepEqual(manager.peers(id)!.map((p) => p.id), [id]);
  manager.kill(id);
  assert.equal(manager.peers(id), null);
});

function talkingManager(t: { after: (fn: () => void) => void }, outboxDelayMs: number) {
  const writes: string[] = [];
  const events: unknown[] = [];
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-sm-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const pty = { ...fakePty(), write: (data: string) => void writes.push(data) };
  const manager = new SessionManager(userData, (_channel, payload) => void events.push(payload), (() => pty) as any);
  t.after(() => manager.killAll());
  manager.outboxDelayMs = outboxDelayMs;
  const id = manager.create(os.tmpdir(), []);
  const file = path.join(userData, 'sessions', `${process.pid}-${id}.jsonl`);
  const push = async (event: object) => {
    const seen = events.length;
    fs.appendFileSync(file, JSON.stringify(event) + '\n');
    for (let i = 0; i < 100 && events.length === seen; i++) await new Promise((r) => setTimeout(r, 10));
  };
  const queued = () => manager.peers(id)!.find((p) => p.id === id)!.queued;
  return { manager, id, writes, push, queued };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('SessionManager.say: ждущей сессии - вставкой и Enter отдельной записью; запуск, вопрос и завершённая сессия - отказ', async (t) => {
  const { manager, id, writes, push } = talkingManager(t, 0);
  await assert.rejects(manager.say(id, 'x'), /запускается/);
  await push({ hook_event_name: 'SessionStart' });
  assert.equal(await manager.say(id, 'две\nстроки'), 'sent');
  assert.deepEqual(writes, ['\x1b[200~две\nстроки\x1b[201~', '\r']);
  await push({ hook_event_name: 'Notification', notification_type: 'permission_prompt' });
  await assert.rejects(manager.say(id, 'x'), /Просит разрешение/);
  await assert.rejects(manager.say(id + 100, 'x'), /завершилась/);
  assert.equal(writes.length, 2);
});

test('SessionManager.say: работающей сессии - в очередь, по сообщению после конца хода; Stop с фоновыми задачами ход не кончает', async (t) => {
  const quiet = 200;
  const { manager, id, writes, push, queued } = talkingManager(t, quiet);
  await push({ hook_event_name: 'UserPromptSubmit' });
  assert.equal(await manager.say(id, 'первое'), 'queued');
  assert.equal(await manager.say(id, 'второе'), 'queued');
  assert.equal(queued(), 2);
  await push({ hook_event_name: 'Stop', background_tasks: [{ id: 'b1' }] });
  await sleep(quiet + SUBMIT_DELAY_MS + 50);
  assert.deepEqual(writes, []);
  await push({ hook_event_name: 'Stop' });
  await sleep(quiet + SUBMIT_DELAY_MS + 50);
  assert.deepEqual(writes, ['\x1b[200~первое\x1b[201~', '\r']);
  assert.equal(queued(), 1);
  // Отправленное начинает ход раньше, чем истечёт тишина после Enter: второе ждёт его конца.
  await push({ hook_event_name: 'UserPromptSubmit' });
  await sleep(quiet + 50);
  assert.equal(writes.length, 2);
  await push({ hook_event_name: 'Stop' });
  await sleep(quiet + SUBMIT_DELAY_MS + 50);
  assert.deepEqual(writes.slice(2), ['\x1b[200~второе\x1b[201~', '\r']);
  assert.equal(queued(), 0);
});

test('SessionManager.say: после события сессия должна помолчать, иначе сообщение ждёт в очереди', async (t) => {
  const { manager, id, writes, push } = talkingManager(t, 300);
  await push({ hook_event_name: 'SessionStart' });
  assert.equal(await manager.say(id, 'x'), 'queued');
  assert.deepEqual(writes, []);
  await sleep(300 + SUBMIT_DELAY_MS + 100);
  assert.deepEqual(writes, ['\x1b[200~x\x1b[201~', '\r']);
});

test('SessionManager.say: сообщение во время отправки другого ждёт в очереди, вставки не перемешиваются', async (t) => {
  const { manager, id, writes, push } = talkingManager(t, 0);
  await push({ hook_event_name: 'SessionStart' });
  const first = manager.say(id, 'первое');
  assert.equal(await manager.say(id, 'второе'), 'queued');
  assert.equal(await first, 'sent');
  await sleep(SUBMIT_DELAY_MS + 50);
  assert.deepEqual(writes, ['\x1b[200~первое\x1b[201~', '\r', '\x1b[200~второе\x1b[201~', '\r']);
});

test('SessionManager.enqueue: текст в обход validateSend вставляется без ESC, конец вставки не закрыть', async (t) => {
  const { manager, id, writes, push } = talkingManager(t, 0);
  await push({ hook_event_name: 'SessionStart' });
  assert.equal(manager.enqueue(id, 'итог\x1b[201~\r!rm -rf ~'), true);
  await sleep(SUBMIT_DELAY_MS + 50);
  assert.deepEqual(writes, ['\x1b[200~итог[201~\n!rm -rf ~\x1b[201~', '\r']);
});

test('SessionManager.say: сессия начала ход между вставкой и Enter - Enter не отправлен', async (t) => {
  const { manager, id, writes, push } = talkingManager(t, 0);
  await push({ hook_event_name: 'SessionStart' });
  const pending = manager.say(id, 'x');
  await push({ hook_event_name: 'Notification', notification_type: 'permission_prompt' });
  await assert.rejects(pending, /Enter не отправлен/);
  assert.deepEqual(writes, ['\x1b[200~x\x1b[201~']);
});

test('SessionManager убирает конфиги MCP убитого экземпляра вместе с его событиями', (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-sm-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const dir = path.join(userData, 'sessions');
  fs.mkdirSync(dir);
  // Выше pid_max Linux по умолчанию (2^22): такого процесса нет.
  const dead = 4_194_999;
  for (const name of [`${dead}-1.jsonl`, `${dead}-1.mcp.json`, `${process.pid}-9.mcp.json`]) fs.writeFileSync(path.join(dir, name), '');
  new SessionManager(userData, () => {}, (() => fakePty()) as any);
  assert.deepEqual(fs.readdirSync(dir).sort(), [`${process.pid}-9.mcp.json`]);
});
