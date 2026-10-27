import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareEventsDir, createEventsFile } from './events-store.ts';
import { SessionManager, waitingReason } from './sessions.ts';

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
