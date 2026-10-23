import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareEventsDir, createEventsFile } from './events-store.ts';
import { SessionManager } from './sessions.ts';

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

function managerIn(t: { after: (fn: () => void) => void }, events: { channel: string; payload: any }[] = []) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-sm-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const manager = new SessionManager(userData, (channel, payload) => events.push({ channel, payload }), (() => fakePty()) as any);
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
