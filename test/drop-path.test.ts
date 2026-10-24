import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { acceptsDrop, droppedPaths, pastePaths, shellQuote, TREE_PATH_MIME } from '../src/renderer/drop-path';

const files = (...names: string[]) => names.map((name) => ({ name }) as File) as unknown as FileList;

describe('shellQuote', () => {
  it('путь из безопасного класса остаётся как есть', () => {
    assert.equal(shellQuote('/home/mmx/Work/Cyborg/src/a_b-c.ts'), '/home/mmx/Work/Cyborg/src/a_b-c.ts');
    assert.equal(shellQuote('/a@b%c+d=e:f,g'), '/a@b%c+d=e:f,g');
  });
  it('пробел - в одинарные кавычки', () => {
    assert.equal(shellQuote('/home/mmx/My Repo/a b.ts'), "'/home/mmx/My Repo/a b.ts'");
  });
  it("одинарная кавычка внутри записывается как '\\''", () => {
    assert.equal(shellQuote("/tmp/it's"), "'/tmp/it'\\''s'");
  });
  it('не-ASCII и спецсимволы shell - в кавычки', () => {
    assert.equal(shellQuote('/home/mmx/Документы/a.md'), "'/home/mmx/Документы/a.md'");
    for (const ch of ['$', '`', '\\', '*', '?', '!', '~', '"', '&', ';']) assert.equal(shellQuote(`/a${ch}b`), `'/a${ch}b'`);
  });
});

describe('pastePaths', () => {
  it('один путь - с завершающим пробелом', () => {
    assert.equal(pastePaths(['/home/mmx/Work/Cyborg/src/renderer/tree.ts']), '/home/mmx/Work/Cyborg/src/renderer/tree.ts ');
  });
  it('несколько путей через пробел, кавычки по правилу', () => {
    assert.equal(pastePaths(['/a', '/b c']), "/a '/b c' ");
  });
  it('путь с управляющим символом (перевод строки, ESC) отбрасывается', () => {
    assert.equal(pastePaths(['/a\nb', '/c\x1b[0m', '/ok']), '/ok ');
    assert.equal(pastePaths(['/a\rb']), '');
  });
  it('пустые пути отбрасываются; нет путей - пустая строка', () => {
    assert.equal(pastePaths(['', '/a']), '/a ');
    assert.equal(pastePaths(['']), '');
    assert.equal(pastePaths([]), '');
  });
});

describe('droppedPaths', () => {
  it('строка дерева: путь из своего типа, files не читаются', () => {
    const data = {
      types: [TREE_PATH_MIME],
      getData: (t: string) => (t === TREE_PATH_MIME ? '/x/y' : ''),
      get files(): FileList {
        throw new Error('files не должны читаться');
      },
    };
    assert.deepEqual(droppedPaths(data, () => 'нет'), ['/x/y']);
  });
  it('файлы ОС: пути в порядке files через pathOf', () => {
    const data = { types: ['Files'], getData: () => '', files: files('a', 'b c') };
    assert.deepEqual(droppedPaths(data, (f) => `/d/${f.name}`), ['/d/a', '/d/b c']);
  });
  it('файл без пути на диске не даёт текста', () => {
    const data = { types: ['Files'], getData: () => '', files: files('a') };
    assert.equal(pastePaths(droppedPaths(data, () => '')), '');
  });
});

describe('acceptsDrop', () => {
  it('Files и тип строки дерева принимаются, текст - нет', () => {
    assert.equal(acceptsDrop(['Files']), true);
    assert.equal(acceptsDrop([TREE_PATH_MIME]), true);
    assert.equal(acceptsDrop(['text/plain']), false);
  });
});
