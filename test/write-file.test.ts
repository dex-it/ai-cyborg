import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { writeTextFile } from '../src/main/files';

let dir: string;
beforeEach(() => void (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-write-'))));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('writeTextFile', () => {
  it('диск совпадает с base - файл перезаписан', async () => {
    const file = path.join(dir, 'a.md');
    fs.writeFileSync(file, '# было\n');
    assert.deepEqual(await writeTextFile(file, '# стало\n', '# было\n', false), { saved: true });
    assert.equal(fs.readFileSync(file, 'utf8'), '# стало\n');
  });

  it('файл изменён на диске после начала правки - конфликт без записи; force перезаписывает', async () => {
    const file = path.join(dir, 'a.md');
    fs.writeFileSync(file, 'сессия дописала\n');
    assert.deepEqual(await writeTextFile(file, 'правка\n', 'было\n', false), { conflict: true });
    assert.equal(fs.readFileSync(file, 'utf8'), 'сессия дописала\n');
    assert.deepEqual(await writeTextFile(file, 'правка\n', 'было\n', true), { saved: true });
    assert.equal(fs.readFileSync(file, 'utf8'), 'правка\n');
  });

  it('файла нет - ошибка, файл не создан; правка больше предела - отказ', async () => {
    const missing = path.join(dir, 'new.md');
    assert.ok('error' in (await writeTextFile(missing, 'x', 'x', true)));
    assert.equal(fs.existsSync(missing), false);
    const file = path.join(dir, 'a.md');
    fs.writeFileSync(file, 'x');
    const reply = await writeTextFile(file, 'я'.repeat(3 * 1024 * 1024), 'x', true);
    assert.match('error' in reply ? reply.error : '', /больше 5 МБ/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'x');
  });
});
