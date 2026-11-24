import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionFavorites } from '../src/main/session-favorites';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

test('SessionFavorites: отметка по проекту переживает новый экземпляр, снятие убирает её, чужой номер отклонён', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-fav-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session-favorites.json');
  const store = new SessionFavorites(file);
  assert.deepEqual([...store.of('p1')], []);
  store.set('p1', A, true);
  store.set('p1', B, true);
  store.set('p1', A, true);
  store.set('p2', B, true);
  assert.deepEqual([...new SessionFavorites(file).of('p1')].sort(), [A, B]);
  assert.deepEqual([...store.of('p2')], [B]);
  store.set('p1', A, false);
  assert.deepEqual([...store.of('p1')], [B]);
  store.set('p2', B, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { p1: [B] });
  assert.throws(() => store.set('p1', 'не-номер', true), /Некорректный номер/);
});

test('SessionFavorites: битый файл читается как пустой и перезаписывается', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-fav-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session-favorites.json');
  fs.writeFileSync(file, '{не json');
  const store = new SessionFavorites(file);
  assert.equal(store.of('p1').size, 0);
  store.set('p1', A, true);
  assert.deepEqual([...store.of('p1')], [A]);
});
