import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChildSessions } from './child-sessions.ts';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

test('ChildSessions: номер разговора запоминается между экземплярами, мусор и повтор не пишутся', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-child-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'child-sessions.json');
  assert.deepEqual([...new ChildSessions(file).all()], []);
  const store = new ChildSessions(file);
  store.add(A);
  store.add('не-номер');
  store.add(B);
  store.add(A);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [B, A]);
  assert.deepEqual([...new ChildSessions(file).all()].sort(), [A, B]);
});

test('ChildSessions: битый файл читается как пустой перечень и перезаписывается', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-child-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'child-sessions.json');
  fs.writeFileSync(file, '{не json');
  const store = new ChildSessions(file);
  assert.equal(store.all().size, 0);
  store.add(A);
  assert.deepEqual([...store.all()], [A]);
});
