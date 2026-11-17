import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MCP_SESSION_PROMPT, SESSION_PROMPT } from './claude-args.ts';
import { prepareEventsDir, createEventsFile } from './events-store.ts';
import { SessionManager, SUBMIT_DELAY_MS, waitingReason } from './sessions.ts';
import { HOOK_COMMAND, hookSettings } from './session-state.ts';

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

test('SessionManager: номер разговора уходит в onChild только у дочерней сессии, повтор - один раз, новый после /clear - снова', (t) => {
  const { manager } = managerIn(t);
  const seen: string[] = [];
  manager.onChild = (sid) => seen.push(sid);
  const own = manager.create('p', '/a', []);
  const child = manager.create('p', '/a', [], 'задание', undefined, own);
  const event = (sid: string) => JSON.stringify({ hook_event_name: 'SessionStart', session_id: sid });
  manager.ingest(own, [event('own-sid')], { replay: false });
  manager.ingest(child, [event('sid-1'), event('sid-1')], { replay: false });
  manager.ingest(child, [event('sid-2')], { replay: false });
  assert.deepEqual(seen, ['sid-1', 'sid-2']);
});

test('SessionManager: контекст вкладки - первый и последний запрос из хуков, название и постановка из журнала', (t) => {
  const { manager, userData, events } = managerIn(t);
  const id = manager.create('p', '/a', []);
  const prompt = (text: string) => JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: text });
  manager.ingest(id, [prompt('почини\n  дерево'), prompt('<task-notification>x</task-notification>'), prompt('и тесты')], { replay: false });
  const contexts = () => events.filter((e) => e.channel === 'session:context').map((e) => e.payload);
  assert.deepEqual(contexts().at(-1), { id, first: 'почини дерево', last: 'и тесты' });
  const journal = path.join(userData, 'j.jsonl');
  fs.writeFileSync(
    journal,
    [JSON.stringify({ type: 'user', message: { content: 'исходная задача' } }), JSON.stringify({ type: 'ai-title', aiTitle: 'Дерево файлов' })].join('\n'),
  );
  const stop = JSON.stringify({ hook_event_name: 'Stop', transcript_path: journal });
  manager.ingest(id, [stop, stop], { replay: false });
  assert.deepEqual(contexts().at(-1), { id, title: 'Дерево файлов', first: 'исходная задача', last: 'и тесты' });
  assert.equal(contexts().length, 3, 'без перемен событие не шлётся');
});

test('SessionManager: у удалённой вкладки spawn_agent есть parent, но разговоры в onChild не идут - их ведёт удалённая часть', (t) => {
  const { manager } = managerIn(t);
  const seen: string[] = [];
  manager.onChild = (sid) => seen.push(sid);
  const own = manager.create('p', '/a', []);
  const agent = manager.adopt({ project: 'p', term: { write() {}, resize() {}, kill() {} }, dirs: ['/a'], cwd: '/a', remote: { host: 'dev1', origin: 'tool', keep: false, spawnedBy: own, online: true } });
  manager.ingest(agent, [JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'remote-sid' })], { replay: false });
  assert.equal(manager.parentOf(agent), own);
  assert.deepEqual(seen, []);
});

test('SessionManager: открывшая сессия - parent в перечне соседей и parentOf; у открытой человеком его нет', (t) => {
  const { manager } = managerIn(t);
  const own = manager.create('p', '/a', []);
  const child = manager.create('p', '/a', [], 'задание', undefined, own);
  const peers = manager.peers(own) ?? [];
  assert.equal(peers.find((p) => p.id === child)?.parent, own);
  assert.equal('parent' in (peers.find((p) => p.id === own) ?? {}), false);
  assert.equal(manager.parentOf(child), own);
  assert.equal(manager.parentOf(own), null);
});

test('SessionManager: проект сессии - ключ проекта; дочерняя - только в проекте открывшей, в том числе удалённая', (t) => {
  const { manager } = managerIn(t);
  const own = manager.create('p', '/a', ['/b']);
  assert.equal(manager.projectOf(own), 'p');
  assert.equal(manager.projectOf(own + 100), null);
  const child = manager.create('p', '/a', ['/b', '/c'], 'задание', undefined, own);
  assert.deepEqual(manager.peers(own)?.map((p) => p.id), [own, child], 'каталоги проекта поменялись, проект тот же');
  assert.throws(() => manager.create('q', '/a', [], 'задание', undefined, own), /Проект вкладки не совпадает/);
  const remote = { host: 'dev1', origin: 'tool' as const, keep: false, spawnedBy: own, online: true };
  assert.throws(() => manager.adopt({ project: 'q', term: { write() {}, resize() {}, kill() {} }, dirs: ['/a'], cwd: '/a', remote }), /Проект вкладки не совпадает/);
  assert.equal(manager.count(), 2);
});

test('SessionManager.reportLocal: итог - в очередь открывшей, один за круг; новый круг - после UserPromptSubmit; без открывшей - уведомление', (t) => {
  const events: { channel: string; payload: any }[] = [];
  const { manager } = managerIn(t, events);
  const own = manager.create('p', '/a', []);
  const child = manager.create('p', '/a', [], 'задание', undefined, own);
  assert.throws(() => manager.reportLocal(own, { status: 'ok', summary: 'x' }), /открытой другой сессией/);
  assert.match(manager.reportLocal(child, { status: 'ok', summary: 'сделано', branch: 'feat-x' }), /Итог принят/);
  const queued = manager.peers(own)?.find((p) => p.id === own)?.queued;
  assert.equal(queued, 1);
  assert.throws(() => manager.reportLocal(child, { status: 'ok', summary: 'ещё' }), /уже отправлен/);
  manager.ingest(child, [JSON.stringify({ hook_event_name: 'UserPromptSubmit' })], { replay: false });
  manager.kill(own);
  assert.match(manager.reportLocal(child, { status: 'blocked', summary: 'нужен человек' }), /Итог принят/);
  assert.deepEqual(events.find((e) => e.channel === 'remote:report')?.payload, { id: child, title: `CC${child}`, body: 'blocked: нужен человек' });
});

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
  const id = manager.create('p', os.tmpdir(), []);
  const file = path.join(eventsDir, `${process.pid}-${id}.jsonl`);
  assert.equal(mode(file), 0o600);
  fs.appendFileSync(file, '{}\n');
  assert.equal(mode(file), 0o600);
});

test('SessionManager читает события: смена cwd, активность, удаление файла на выходе', async (t) => {
  const events: { channel: string; payload: any }[] = [];
  const { manager, eventsDir } = managerIn(t, events);
  const id = manager.create('p', '/a', []);
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
  manager.create('p', os.tmpdir(), []);
  assert.equal('CYBORG_CWD' in env, false);
  assert.ok(env.CYBORG_EVENTS && env.CYBORG_SETTINGS);
});

test('SessionManager: файл хуков назван по содержимому - экземпляр другой версии с тем же userData его не затирает', (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-sm-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const legacy = path.join(userData, 'claude-hooks.json');
  fs.writeFileSync(legacy, '{"hooks":{}}');
  let env: Record<string, string> = {};
  const manager = new SessionManager(userData, () => {}, ((_file: string, _args: string[], opts: { env: Record<string, string> }) => ((env = opts.env), fakePty())) as any);
  t.after(() => manager.killAll());
  manager.create('p', os.tmpdir(), []);
  assert.match(path.basename(env.CYBORG_SETTINGS), /^claude-hooks-[0-9a-f]{12}\.json$/);
  assert.deepEqual(JSON.parse(fs.readFileSync(env.CYBORG_SETTINGS, 'utf8')), hookSettings());
  assert.equal(fs.readFileSync(legacy, 'utf8'), '{"hooks":{}}');
});

test('SessionManager считает только работающие сессии', (t) => {
  const { manager } = managerIn(t);
  assert.equal(manager.count(), 0);
  const a = manager.create('p', os.tmpdir(), []);
  manager.create('p', os.tmpdir(), []);
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
  const id = manager.create('p', tmp, ['/extra']);
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
  const id = manager.create('p', os.tmpdir(), []);
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
  const id = manager.create('p', os.tmpdir(), []);
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
  const id = manager.create('p', os.tmpdir(), []);
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
  const id = manager.create('p', os.tmpdir(), []);
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
  const id = manager.create('p', os.tmpdir(), []);
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

test('упавший инструмент - работа: после запроса разрешения сессия снова working, хук подписан на все инструменты', (t) => {
  const { manager } = managerIn(t);
  const id = manager.create('p', '/a', []);
  const ev = (e: object) => JSON.stringify(e);
  manager.ingest(id, [ev({ hook_event_name: 'Notification', notification_type: 'permission_prompt' })], { replay: false });
  assert.equal(manager.peers(id)?.[0].state, 'asking');
  manager.ingest(id, [ev({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash' })], { replay: false });
  assert.equal(manager.peers(id)?.[0].state, 'working');
  assert.deepEqual(hookSettings().hooks.PostToolUseFailure, hookSettings().hooks.PostToolUse);
  assert.deepEqual(hookSettings().hooks.PreToolUse, hookSettings().hooks.PostToolUse);
  assert.ok(hookSettings().hooks.SubagentStop);
});

test('хук не запрещает вызов инструмента, когда файл событий недоступен: код 2 у PreToolUse - запрет', () => {
  for (const shell of ['/bin/sh', '/bin/bash']) {
    const run = spawnSync(shell, ['-c', HOOK_COMMAND], { input: '{}', env: { CYBORG_EVENTS: '/nonexistent/cyborg/events.jsonl' } });
    assert.equal(run.status, 0, shell);
  }
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
  const id = manager.create('p', os.tmpdir(), []);
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
  const id = manager.create('p', '/repo/a', ['/repo/b']);
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
  manager.create('p', os.tmpdir(), []);
  assert.equal(box.call.args[1], 'exec claude --settings "$CYBORG_SETTINGS" "$@"');
  assert.equal(box.call.args[4], SESSION_PROMPT);
  assert.equal('CYBORG_MCP' in box.call.env, false);
  assert.equal('CYBORG_PLUGIN' in box.call.env, false);
});

test('SessionManager без MCP и плагина не наследует их у родительской сессии Cyborg', (t) => {
  const saved = { mcp: process.env.CYBORG_MCP, plugin: process.env.CYBORG_PLUGIN };
  process.env.CYBORG_MCP = '/parent/mcp.json';
  process.env.CYBORG_PLUGIN = '/parent/plugin';
  t.after(() => {
    for (const [name, value] of [['CYBORG_MCP', saved.mcp], ['CYBORG_PLUGIN', saved.plugin]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const { manager, box } = spawningManager(t);
  manager.create('p', os.tmpdir(), []);
  assert.equal('CYBORG_MCP' in box.call.env, false);
  assert.equal('CYBORG_PLUGIN' in box.call.env, false);
});

test('SessionManager с плагином без MCP: скиллы подключены, инструкции о параллельных сессиях нет', (t) => {
  const { manager, box } = spawningManager(t);
  manager.pluginDir = '/app/plugin';
  manager.create('p', os.tmpdir(), []);
  assert.equal(box.call.args[1], 'exec claude --settings "$CYBORG_SETTINGS" --plugin-dir "$CYBORG_PLUGIN" "$@"');
  assert.equal(box.call.args[4], SESSION_PROMPT);
});

test('SessionManager с MCP без плагина: инструкции о параллельных сессиях нет - скилла, на который она ссылается, у сессии нет', (t) => {
  const { manager, box } = spawningManager(t);
  manager.mcp = { connect: () => ({}), disconnect: () => {} };
  manager.create('p', os.tmpdir(), []);
  assert.equal(box.call.args[4], SESSION_PROMPT);
});

test('SessionManager: состояние сессии и хвост ответа для list_sessions, соседи - сессии того же проекта при любых каталогах', async (t) => {
  const events: { channel: string; payload: any }[] = [];
  const { manager, eventsDir } = managerIn(t, events);
  const id = manager.create('p', '/repo/a', ['/repo/b']);
  const sibling = manager.create('p', '/repo/b', ['/repo/a', '/repo/c']);
  manager.create('q', '/repo/a', ['/repo/b']);
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
  manager.release(sibling);
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
  const id = manager.create('p', os.tmpdir(), []);
  const file = path.join(userData, 'sessions', `${process.pid}-${id}.jsonl`);
  const push = async (event: object) => {
    const seen = events.length;
    fs.appendFileSync(file, JSON.stringify(event) + '\n');
    for (let i = 0; i < 100 && events.length === seen; i++) await new Promise((r) => setTimeout(r, 10));
  };
  const queued = () => manager.peers(id)!.find((p) => p.id === id)!.queued;
  return { manager, id, writes, push, queued, file };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function remoteTalking(t: { after: (fn: () => void) => void }, outboxDelayMs: number) {
  const writes: string[] = [];
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-sm-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const manager = new SessionManager(userData, () => {}, (() => fakePty()) as any);
  manager.outboxDelayMs = outboxDelayMs;
  const term = { write: (data: string) => void writes.push(data), resize: () => {}, kill: () => {} };
  const id = manager.adopt({ project: 'p', term, dirs: ['/h/a'], cwd: '/h/a', remote: { host: 'dev1', origin: 'human', keep: false, online: true } });
  const push = (event: object) => manager.ingest(id, [JSON.stringify(event)], { replay: false });
  return { manager, id, writes, push };
}

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

test('SessionManager.say: работающей сессии без вызова инструмента - сразу, без тишины; вызов держит очередь до своего Post*', async (t) => {
  const { manager, id, writes, push, queued } = talkingManager(t, 60_000);
  await push({ hook_event_name: 'UserPromptSubmit' });
  assert.equal(await manager.say(id, 'первое'), 'sent-working');
  assert.deepEqual(writes, ['\x1b[200~первое\x1b[201~', '\r']);
  await push({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't1' });
  await push({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 't2' });
  assert.equal(await manager.say(id, 'второе'), 'queued');
  assert.equal(queued(), 1);
  await push({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 't1' });
  await sleep(SUBMIT_DELAY_MS + 50);
  assert.equal(writes.length, 2, 'второй вызов ещё идёт');
  await push({ hook_event_name: 'PostToolUseFailure', tool_name: 'Read', tool_use_id: 't2' });
  await sleep(SUBMIT_DELAY_MS + 50);
  assert.deepEqual(writes.slice(2), ['\x1b[200~второе\x1b[201~', '\r']);
  assert.equal(queued(), 0);
});

test('SessionManager.say: вызов субагента держит очередь до его SubagentStop, внешние REPL, Poll и Agent - нет', async (t) => {
  const { manager, id, writes, push } = talkingManager(t, 0);
  await push({ hook_event_name: 'UserPromptSubmit' });
  for (const [n, tool] of ['REPL', 'Poll', 'Agent'].entries()) await push({ hook_event_name: 'PreToolUse', tool_name: tool, tool_use_id: `c${n}` });
  assert.equal(await manager.say(id, 'первое'), 'sent-working');
  await push({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'repl_1' });
  assert.equal(await manager.say(id, 'второе'), 'queued', 'вызов внутри REPL');
  await push({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'repl_1' });
  await sleep(SUBMIT_DELAY_MS + 50);
  assert.equal(writes.length, 4);
  await push({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 's1', agent_id: 'sub' });
  assert.equal(await manager.say(id, 'третье'), 'queued', 'запрос разрешения субагента - в том же TUI');
  await push({ hook_event_name: 'SubagentStop', agent_id: 'other' });
  await sleep(SUBMIT_DELAY_MS + 50);
  assert.equal(writes.length, 4);
  await push({ hook_event_name: 'SubagentStop', agent_id: 'sub' });
  await sleep(SUBMIT_DELAY_MS + 50);
  assert.deepEqual(writes.slice(4), ['\x1b[200~третье\x1b[201~', '\r']);
});

test('SessionManager.say: вызов без Post* (отказ в разрешении, Esc) снимают Stop и UserPromptSubmit, вызов фонового субагента - только Stop без фоновых задач', async (t) => {
  const { manager, id, writes, push } = talkingManager(t, 0);
  const state = () => manager.peers(id)!.find((p) => p.id === id)!.state;
  await push({ hook_event_name: 'UserPromptSubmit' });
  await push({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'denied' });
  assert.equal(await manager.say(id, 'первое'), 'queued');
  await push({ hook_event_name: 'Stop', background_tasks: [{ id: 'b1' }] });
  await sleep(SUBMIT_DELAY_MS + 50);
  assert.deepEqual(writes, ['\x1b[200~первое\x1b[201~', '\r'], 'пауза до фоновой задачи принимает ввод');
  await push({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'bg1', agent_id: 'bg' });
  assert.equal(state(), 'working');
  assert.equal(await manager.say(id, 'второе'), 'queued');
  await push({ hook_event_name: 'UserPromptSubmit' });
  await sleep(SUBMIT_DELAY_MS + 50);
  assert.equal(writes.length, 2, 'фоновый субагент работает дальше');
  await push({ hook_event_name: 'Stop' });
  await sleep(SUBMIT_DELAY_MS + 50);
  assert.deepEqual(writes.slice(2), ['\x1b[200~второе\x1b[201~', '\r']);
});

test('SessionManager.say: удалённой - только после конца хода и тишины outboxDelayMs, вызовы инструментов не в счёт', async (t) => {
  const quiet = 200;
  const { manager, id, writes, push } = remoteTalking(t, quiet);
  push({ hook_event_name: 'SessionStart' });
  push({ hook_event_name: 'UserPromptSubmit' });
  assert.equal(await manager.say(id, 'первое'), 'queued');
  push({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't1' });
  push({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 't1' });
  await sleep(quiet + SUBMIT_DELAY_MS + 50);
  assert.deepEqual(writes, [], 'ход не кончен');
  push({ hook_event_name: 'Stop', background_tasks: [{ id: 'b1' }] });
  for (let i = 0; i < 4; i++) {
    await sleep(quiet / 2);
    push({ hook_event_name: 'PostToolUse', tool_name: 'Bash', agent_id: 'a1' });
  }
  assert.deepEqual(writes, [], 'фоновый субагент шлёт события: его запрос разрешения мог бы опередить свой Notification');
  await sleep(quiet + SUBMIT_DELAY_MS + 50);
  assert.deepEqual(writes, ['\x1b[200~первое\x1b[201~', '\r']);
  await sleep(quiet + 50);
  assert.equal(await manager.say(id, 'второе'), 'sent', 'пауза до фоновой задачи');
  push({ hook_event_name: 'PostToolUse', tool_name: 'Read' });
  assert.equal(await manager.say(id, 'третье'), 'queued', 'модель проснулась после фоновой задачи - снова ход');
  push({ hook_event_name: 'Stop', session_crons: [{ id: 'c' }] });
  await sleep(quiet + SUBMIT_DELAY_MS + 50);
  assert.deepEqual(writes.slice(4), ['\x1b[200~третье\x1b[201~', '\r'], 'пауза до пробуждения тоже принимает ввод');
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

test('SessionManager.say: вызов начат между вставкой и Enter - Enter ждёт его конца, следующее сообщение - за ним', async (t) => {
  const { manager, id, writes, push, queued, file } = talkingManager(t, 0);
  await push({ hook_event_name: 'UserPromptSubmit' });
  const pending = manager.say(id, 'x');
  assert.deepEqual(writes, ['\x1b[200~x\x1b[201~']);
  // Без ожидания fs.watch: Enter должен увидеть вызов и тогда, когда наблюдатель ещё не сработал.
  fs.appendFileSync(file, JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't1' }) + '\n');
  assert.equal(await pending, 'queued');
  assert.deepEqual(writes, ['\x1b[200~x\x1b[201~']);
  assert.equal(queued(), 1);
  assert.equal(await manager.say(id, 'y'), 'queued');
  await push({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 't1' });
  await sleep(SUBMIT_DELAY_MS + 50);
  assert.deepEqual(writes, ['\x1b[200~x\x1b[201~', '\r', '\x1b[200~y\x1b[201~', '\r']);
});

test('SessionManager.say: удалённая сессия начала ход между вставкой и Enter - Enter не отправлен', async (t) => {
  const { manager, id, writes, push } = remoteTalking(t, 0);
  push({ hook_event_name: 'SessionStart' });
  const pending = manager.say(id, 'x');
  push({ hook_event_name: 'Notification', notification_type: 'permission_prompt' });
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

test('SessionManager: вышедшая сессия остаётся среди соседей как exited с кодом до закрытия вкладки; вкладка, закрытая до выхода, убирается с выходом', async (t) => {
  const { manager } = managerIn(t);
  const own = manager.create('p', '/a', []);
  const gone = manager.create('p', '/a', []);
  manager.kill(gone);
  assert.deepEqual(
    manager.peers(own)!.map((p) => [p.id, p.state, p.exitCode]),
    [
      [own, 'starting', undefined],
      [gone, 'exited', 0],
    ],
  );
  assert.equal(manager.count(), 1);
  assert.equal(manager.dirsOf(gone), null, 'у завершённой инструментов нет');
  assert.equal(manager.peers(gone), null);
  await assert.rejects(manager.say(gone, 'x'), /завершилась/);
  assert.equal(manager.enqueue(gone, 'x'), false);
  manager.release(gone);
  assert.deepEqual(manager.peers(own)!.map((p) => p.id), [own]);
  const closing = manager.create('p', '/a', []);
  manager.release(closing);
  assert.deepEqual(manager.peers(own)!.map((p) => p.id), [own, closing], 'процесс ещё жив - сессия видна');
  manager.kill(closing);
  assert.deepEqual(manager.peers(own)!.map((p) => p.id), [own]);
  manager.release('мусор');
});

test('SessionManager: открывшей - сообщение о выходе дочерней (сама, закрыла себя, закрыл человек, закрыла другая сессия), без сообщения - своё закрытие и killAll', async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-sm-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const writes: string[] = [];
  const manager = new SessionManager(userData, () => {}, (() => ({ ...fakePty(), write: (data: string) => void writes.push(data) })) as any);
  t.after(() => manager.killAll());
  const parent = manager.create('p', '/a', []);
  const other = manager.create('p', '/a', []);
  const child = () => manager.create('p', '/a', [], 'задание', undefined, parent);
  const self = child();
  manager.kill(self);
  const byHuman = child();
  manager.release(byHuman);
  manager.kill(byHuman);
  const byOther = child();
  manager.noteClosing(byOther, other);
  manager.release(byOther);
  manager.kill(byOther);
  const byItself = child();
  manager.noteClosing(byItself, byItself);
  manager.release(byItself);
  manager.kill(byItself);
  const byParent = child();
  manager.noteClosing(byParent, parent);
  manager.release(byParent);
  manager.kill(byParent);
  assert.equal(manager.peers(parent)!.find((p) => p.id === parent)!.queued, 4);
  manager.ingest(parent, [JSON.stringify({ hook_event_name: 'SessionStart' })], { replay: false });
  for (let i = 0; i < 200 && writes.length < 8; i++) await sleep(10);
  assert.deepEqual(
    writes.filter((w) => w !== '\r'),
    [
      `Сессия CC${self} завершилась (код 0): её вкладка открыта, закрыть - close_session.`,
      `Вкладку сессии CC${byHuman} закрыл человек.`,
      `Вкладку сессии CC${byOther} закрыла сессия CC${other}.`,
      `Сессия CC${byItself} закрыла свою вкладку.`,
    ].map((text) => `\x1b[200~${text}\x1b[201~`),
  );
  const last = child();
  manager.killAll();
  assert.equal(writes.length, 8, 'killAll гасит и открывшую: сообщать некому');
  for (const id of [parent, other, self, last]) assert.equal(manager.projectOf(id), null, 'killAll не оставляет записей вкладок');
});
