import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { openablePath, webUrl } from '../src/main/open-path';
import { fileUrlPath, findLinks, findPaths, findUrls, linksOnRow, type LinkBuffer } from '../src/renderer/term-links';

const paths = (text: string) => findPaths(text).map((m) => m.target);
const urls = (text: string) => findUrls(text).map((m) => m.target);

describe('пути в выводе сессии', () => {
  it('абсолютный и от ~ находятся, смещение указывает на начало', () => {
    assert.deepEqual(findPaths('см. /tmp/a/shot.png тут'), [{ start: 4, length: 15, target: '/tmp/a/shot.png', kind: 'path' }]);
    assert.deepEqual(paths('~/.config/cyborg/prompts.json'), ['~/.config/cyborg/prompts.json']);
  });

  it('скобки, кавычки и пунктуация предложения в путь не входят', () => {
    assert.deepEqual(paths('Редактор (/tmp/x/shot.png) - готов'), ['/tmp/x/shot.png']);
    assert.deepEqual(paths('Файл `/etc/hosts`, затем «/var/log/syslog».'), ['/etc/hosts', '/var/log/syslog']);
    assert.deepEqual(paths('![Редактор](/tmp/x/shot.png)'), ['/tmp/x/shot.png']);
  });

  it('дробь, относительный путь, одиночный «/» и «~/» - не пути', () => {
    assert.deepEqual(paths('1/2 и a/b, src/main.ts, деление /, домой ~/'), []);
  });
});

describe('ссылки в выводе сессии', () => {
  it('URL находится, хвостовая пунктуация и непарная скобка отрезаются', () => {
    assert.deepEqual(urls('PR: https://github.com/dex-it/ai-cyborg/pull/37.'), ['https://github.com/dex-it/ai-cyborg/pull/37']);
    assert.deepEqual(urls('(см. https://example.com/a?b=1)'), ['https://example.com/a?b=1']);
    assert.deepEqual(urls('[док](https://ru.wikipedia.org/wiki/Foo_(bar))'), ['https://ru.wikipedia.org/wiki/Foo_(bar)']);
    assert.deepEqual(urls('http://localhost:5173/, ftp://x, https://'), ['http://localhost:5173/']);
  });

  it('путь внутри URL не считается отдельной ссылкой', () => {
    assert.deepEqual(
      findLinks('см. https://github.com/a/b и /tmp/x').map((m) => [m.kind, m.target]),
      [['url', 'https://github.com/a/b'], ['path', '/tmp/x']],
    );
  });

  it('OSC 8 file:// - путь, остальное - не путь', () => {
    assert.equal(fileUrlPath('file:///tmp/a%20b.png'), '/tmp/a b.png');
    assert.equal(fileUrlPath('file://localhost/etc/hosts'), '/etc/hosts');
    assert.equal(fileUrlPath('file://evil.host/share/x'), null);
    assert.equal(fileUrlPath('https://example.com'), null);
  });

  it('браузеру отдаются только http(s)', () => {
    assert.equal(webUrl('https://example.com/a b'), 'https://example.com/a%20b');
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'vscode://x', 'не url', 5]) assert.equal(webUrl(bad), null, String(bad));
  });
});

/** Буфер xterm из строк экрана; строка с префиксом `+` перенесена xterm (isWrapped). */
function screen(cols: number, rows: string[]): LinkBuffer {
  const lines = rows.map((row) => {
    const wrapped = row.startsWith('+');
    const text = (wrapped ? row.slice(1) : row).padEnd(cols);
    return {
      isWrapped: wrapped,
      length: cols,
      getCell: (x: number) => ({ getChars: () => (text[x] === ' ' ? '' : text[x]), getWidth: () => 1 }),
    };
  });
  return { length: lines.length, getLine: (y: number) => lines[y] } as unknown as LinkBuffer;
}

const onRow = (buffer: LinkBuffer, cols: number, y: number) =>
  linksOnRow(buffer, cols, y).map(({ match, start, end }) => `${match.target} ${start.x},${start.y}-${end.x},${end.y}`);

describe('пути, которые Claude Code перенёс сам', () => {
  const BODY = '/tmp/claude-1000/-home-mmx-Work-Cyborg/78590e60-eeb4-48da-88be-381e10c4f16b/scratchpad/body.md';

  it('путь, оборванный у края и продолженный с отступа, - одна ссылка на обеих строках', () => {
    const buffer = screen(70, [
      '  ⎿  /tmp/claude-1000/-home-mmx-Work-Cyborg/78590e60-eeb4-48da-88be-38',
      '     1e10c4f16b/scratchpad/body.md такая строка',
    ]);
    assert.deepEqual(onRow(buffer, 70, 0), [`${BODY} 6,1-70,1`]);
    assert.deepEqual(onRow(buffer, 70, 1), [`${BODY} 6,2-34,2`]);
  });

  it('путь через три строки и отступ подсказки', () => {
    const buffer = screen(30, ['  формата: /tmp/claude-1000/-h', '  ome-mmx-Work-Cyborg/78590e60', '  -eeb4.md дальше']);
    const whole = '/tmp/claude-1000/-home-mmx-Work-Cyborg/78590e60-eeb4.md';
    assert.deepEqual(onRow(buffer, 30, 2), [`${whole} 3,3-10,3`]);
    assert.deepEqual(onRow(buffer, 30, 1), [`${whole} 3,2-30,2`]);
  });

  it('путь, кончившийся до края, со следующей строкой не склеивается', () => {
    const buffer = screen(40, ['  см. /tmp/a.md', '  дальше текст']);
    assert.deepEqual(onRow(buffer, 40, 0), ['/tmp/a.md 7,1-15,1']);
    assert.deepEqual(onRow(buffer, 40, 1), []);
  });

  it('проза, дописанная до края, путь со следующей строки не съедает', () => {
    const buffer = screen(20, ['────────────────────', '  /tmp/a.md']);
    assert.deepEqual(onRow(buffer, 20, 1), ['/tmp/a.md 3,2-11,2']);
  });

  it('перенос самого xterm по-прежнему склеивается', () => {
    const buffer = screen(10, ['см /tmp/ab', '+c/d.md']);
    assert.deepEqual(onRow(buffer, 10, 1), ['/tmp/abc/d.md 1,2-6,2']);
  });
});

describe('openablePath', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-open-')));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('существующий файл и каталог открываются, ~ раскрывается от домашнего', () => {
    fs.writeFileSync(path.join(dir, 'shot.png'), '');
    assert.deepEqual(openablePath(path.join(dir, 'shot.png'), '/nope'), { path: path.join(dir, 'shot.png') });
    assert.deepEqual(openablePath(dir, '/nope'), { path: dir });
    assert.deepEqual(openablePath('~/shot.png', dir), { path: path.join(dir, 'shot.png') });
  });

  it('нет файла, относительный путь и не строка - отказ с причиной', () => {
    assert.match((openablePath(path.join(dir, 'нет.png'), dir) as { error: string }).error, /Нет такого файла/);
    assert.match((openablePath('a/b.png', dir) as { error: string }).error, /не абсолютный/);
    for (const bad of [5, '', '/a\nb']) assert.deepEqual(openablePath(bad, dir), { error: 'Некорректный путь' });
  });

  it('исполняемый файл и запускающие расширения не открываются', () => {
    const script = path.join(dir, 'run');
    fs.writeFileSync(script, '#!/bin/sh\n', { mode: 0o755 });
    assert.match((openablePath(script, dir) as { error: string }).error, /Исполняемый/);
    const desktop = path.join(dir, 'x.desktop');
    fs.writeFileSync(desktop, '', { mode: 0o644 });
    assert.match((openablePath(desktop, dir) as { error: string }).error, /Исполняемый/);
    const disguised = path.join(dir, 'shot.png');
    fs.symlinkSync(desktop, disguised);
    assert.match((openablePath(disguised, dir) as { error: string }).error, /Исполняемый/, 'ссылка с безобидным именем на .desktop');
  });
});
