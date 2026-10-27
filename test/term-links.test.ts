import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { openablePath, webUrl } from '../src/main/open-path';
import { fileUrlPath, findLinks, findPaths, findUrls } from '../src/renderer/term-links';

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
