import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ClaudeMdStore } from '../src/main/claude-md';

describe('ClaudeMdStore: глобальный CLAUDE.md', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-md-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('нет файла и каталога - пустой текст без замечания; сохранение создаёт и каталог, и файл', () => {
    const store = new ClaudeMdStore(path.join(dir, 'claude', 'CLAUDE.md'));
    assert.deepEqual(store.read(), { text: '' });
    assert.deepEqual(store.save('# Правила\n', ''), {});
    assert.equal(fs.readFileSync(store.file, 'utf8'), '# Правила\n');
    assert.deepEqual(fs.readdirSync(path.dirname(store.file)), ['CLAUDE.md']);
  });

  it('текст пишется как есть: многострочный Markdown, пустой текст', () => {
    const store = new ClaudeMdStore(path.join(dir, 'CLAUDE.md'));
    fs.writeFileSync(store.file, 'старое');
    const text = '# Заголовок\n\n- пункт\n```\nкод\n```\n';
    assert.deepEqual(store.save(text, 'старое'), {});
    assert.equal(store.read().text, text);
    assert.deepEqual(store.save('', text), {});
    assert.equal(fs.readFileSync(store.file, 'utf8'), '');
  });

  it('файл изменился после открытия редактора - отказ, файл не затёрт', () => {
    const store = new ClaudeMdStore(path.join(dir, 'CLAUDE.md'));
    fs.writeFileSync(store.file, 'правка сессии');
    const reply = store.save('моя правка', 'как было при открытии');
    assert.match(reply.error ?? '', /изменился на диске/);
    assert.equal(fs.readFileSync(store.file, 'utf8'), 'правка сессии');
  });

  it('символьная ссылка остаётся ссылкой: пишется файл, на который она указывает', () => {
    const real = path.join(dir, 'dotfiles', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(real));
    fs.writeFileSync(real, 'было');
    const link = path.join(dir, 'CLAUDE.md');
    fs.symlinkSync(real, link);
    const store = new ClaudeMdStore(link);
    assert.deepEqual(store.save('стало', 'было'), {});
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.equal(fs.readFileSync(real, 'utf8'), 'стало');
  });

  it('не строка из канала - отказ без записи', () => {
    const store = new ClaudeMdStore(path.join(dir, 'CLAUDE.md'));
    assert.match(store.save(42, '').error ?? '', /Некорректная запись/);
    assert.match(store.save('текст', undefined).error ?? '', /Некорректная запись/);
    assert.equal(fs.existsSync(store.file), false);
  });

  it('файл не читается (каталог на месте файла) - замечание при чтении и отказ при записи', () => {
    const store = new ClaudeMdStore(path.join(dir, 'CLAUDE.md'));
    fs.mkdirSync(store.file);
    assert.match(store.read().problem ?? '', /не прочитан/);
    assert.match(store.save('текст', '').error ?? '', /не прочитан/);
  });
});
