import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { gitDiffSearch, gitGrep, matchLines, parseDiff } from '../src/main/git-search';
import { validateSearchRequest } from '../src/main/search-args';
import { SearchRunner } from '../src/main/search-run';
import type { SearchOptions, SearchRequest } from '../src/shared/search-pattern';

const plain: SearchOptions = { regex: false, caseSensitive: false, wholeWord: false };
const req = (root: string, query: string, options: Partial<SearchOptions> = {}): SearchRequest => ({ root, query, options: { ...plain, ...options } });
const signal = () => new AbortController().signal;

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-search-')));
const write = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });

/** Репозиторий с одним коммитом: a.txt (3 строки), sub/b.ts. */
function repo(): string {
  const dir = tmp();
  git(dir, 'init', '-q');
  write(dir, 'a.txt', 'alpha\nbeta needle\ngamma\n');
  write(dir, 'sub/b.ts', 'export const Needle = 1;\nconst other = 2;\n');
  write(dir, '.gitignore', 'ignored.txt\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}
const cleanup = (dir: string) => fs.rmSync(dir, { recursive: true, force: true });
const where = (hits: { rel: string; line: number }[]) => hits.map((h) => `${h.rel}:${h.line}`).sort();

describe('gitGrep', () => {
  it('подстрока без учёта регистра: отслеживаемые и новые файлы, игнорируемые и двоичные мимо', async () => {
    const dir = repo();
    try {
      write(dir, 'new.txt', 'a new NEEDLE here\n');
      write(dir, 'ignored.txt', 'needle\n');
      fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from('needle\0binary'));
      const reply = await gitGrep(req(dir, 'needle'), signal());
      assert.equal(reply.error, undefined);
      assert.deepEqual(where(reply.hits), ['a.txt:2', 'new.txt:1', 'sub/b.ts:1']);
      const hit = reply.hits.find((h) => h.rel === 'a.txt')!;
      assert.equal(hit.text, 'beta needle');
      assert.deepEqual(hit.range, { start: 5, end: 11 });
      assert.equal(reply.truncated, false);
    } finally {
      cleanup(dir);
    }
  });

  it('с учётом регистра и целое слово', async () => {
    const dir = repo();
    try {
      assert.deepEqual(where((await gitGrep(req(dir, 'needle', { caseSensitive: true }), signal())).hits), ['a.txt:2']);
      write(dir, 'w.txt', 'needles\nthe needle.\n');
      assert.deepEqual(where((await gitGrep(req(dir, 'needle', { wholeWord: true }), signal())).hits), ['a.txt:2', 'sub/b.ts:1', 'w.txt:2']);
    } finally {
      cleanup(dir);
    }
  });

  it('регулярное выражение PCRE: \\b, \\d, границы совпадения', async () => {
    const dir = repo();
    try {
      write(dir, 'n.txt', 'item 42 and item 7\n');
      const reply = await gitGrep(req(dir, '\\bitem \\d+', { regex: true }), signal());
      assert.deepEqual(where(reply.hits), ['n.txt:1']);
      assert.deepEqual(reply.hits[0].range, { start: 0, end: 7 });
    } finally {
      cleanup(dir);
    }
  });

  it('негодное выражение - причина, а не исключение', async () => {
    const dir = repo();
    try {
      const reply = await gitGrep(req(dir, '(', { regex: true }), signal());
      assert.deepEqual(reply.hits, []);
      assert.match(reply.error ?? '', /^Выражение не разобрано: /);
    } finally {
      cleanup(dir);
    }
  });

  it('запрос, начинающийся с дефиса, - запрос, а не флаг git', async () => {
    const dir = repo();
    try {
      write(dir, 'flags.txt', 'run with --help now\n');
      assert.deepEqual(where((await gitGrep(req(dir, '--help'), signal())).hits), ['flags.txt:1']);
      assert.deepEqual(where((await gitGrep(req(dir, '-n'), signal())).hits), []);
    } finally {
      cleanup(dir);
    }
  });

  it('вне git: каталог целиком', async () => {
    const dir = tmp();
    try {
      write(dir, 'x/y.txt', 'find me\n');
      const reply = await gitGrep(req(dir, 'find me'), signal());
      assert.equal(reply.error, undefined);
      assert.deepEqual(where(reply.hits), ['x/y.txt:1']);
    } finally {
      cleanup(dir);
    }
  });

  it('больше предела: первые 500 и признак обрезки', async () => {
    const dir = repo();
    try {
      write(dir, 'many.txt', Array.from({ length: 620 }, (_, i) => `line ${i} marker`).join('\n') + '\n');
      const reply = await gitGrep(req(dir, 'marker'), signal());
      assert.equal(reply.hits.length, 500);
      assert.equal(reply.truncated, true);
    } finally {
      cleanup(dir);
    }
  });

  it('длинная строка обрезана, отступ убран, подсветка сдвинута вместе с текстом', async () => {
    const dir = repo();
    try {
      write(dir, 'long.txt', `      ${'x'.repeat(2000)} needle\n    indented needle\n`);
      const reply = await gitGrep(req(dir, 'indented'), signal());
      assert.equal(reply.hits[0].text, 'indented needle');
      assert.deepEqual(reply.hits[0].range, { start: 0, end: 8 });
      const long = await gitGrep(req(dir, 'xxxx'), signal());
      assert.ok(long.hits[0].text.length <= 300);
    } finally {
      cleanup(dir);
    }
  });

  it('отменённый запрос не отдаёт ответ', async () => {
    const dir = repo();
    try {
      const controller = new AbortController();
      const pending = gitGrep(req(dir, 'needle'), controller.signal);
      controller.abort();
      await assert.rejects(pending, (e: Error) => e.name === 'AbortError');
    } finally {
      cleanup(dir);
    }
  });
});

describe('parseDiff', () => {
  it('изменение, добавление и удаление: знак, файл, номера строк рабочего файла', () => {
    const out = [
      'diff --git a.txt a.txt',
      'index 1..2 100644',
      '--- a.txt',
      '+++ a.txt',
      '@@ -2 +2 @@',
      '-beta needle',
      '+beta NEEDLE',
      '@@ -3,0 +4,2 @@',
      '+added one',
      '+added two',
      'diff --git gone.txt gone.txt',
      'deleted file mode 100644',
      '--- gone.txt',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-old one',
      '-old two',
      'diff --git new.txt new.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ new.txt',
      '@@ -0,0 +1 @@',
      '+fresh',
      '',
    ].join('\n');
    assert.deepEqual(parseDiff(out), [
      { rel: 'a.txt', line: 2, sign: '-', text: 'beta needle' },
      { rel: 'a.txt', line: 2, sign: '+', text: 'beta NEEDLE' },
      { rel: 'a.txt', line: 4, sign: '+', text: 'added one' },
      { rel: 'a.txt', line: 5, sign: '+', text: 'added two' },
      { rel: 'gone.txt', line: 1, sign: '-', text: 'old one' },
      { rel: 'gone.txt', line: 1, sign: '-', text: 'old two' },
      { rel: 'new.txt', line: 1, sign: '+', text: 'fresh' },
    ]);
  });

  it('строка удаления, похожая на заголовок файла, не меняет файл; «No newline» пропускается; путь с пробелом и табом', () => {
    const out = [
      'diff --git my file.txt my file.txt',
      '--- my file.txt\t',
      '+++ my file.txt\t',
      '@@ -1,2 +1,2 @@',
      '--- not a header',
      '-second',
      '\\ No newline at end of file',
      '++++ plus',
      '+replacement',
      '',
    ].join('\n');
    assert.deepEqual(parseDiff(out), [
      { rel: 'my file.txt', line: 1, sign: '-', text: '-- not a header' },
      { rel: 'my file.txt', line: 1, sign: '-', text: 'second' },
      { rel: 'my file.txt', line: 1, sign: '+', text: '+++ plus' },
      { rel: 'my file.txt', line: 2, sign: '+', text: 'replacement' },
    ]);
  });

  it('двоичный файл и пустой вывод - пусто', () => {
    assert.deepEqual(parseDiff('diff --git b.bin b.bin\nBinary files a/b.bin and b/b.bin differ\n'), []);
    assert.deepEqual(parseDiff(''), []);
  });
});

describe('gitDiffSearch', () => {
  it('строки + и - изменённых файлов, новые файлы и добавленные в индекс', async () => {
    const dir = repo();
    try {
      write(dir, 'a.txt', 'alpha\nbeta changed\ngamma\ndelta needle\n');
      write(dir, 'untracked.txt', 'plain\nneedle in new file\n');
      write(dir, 'staged.txt', 'staged needle\n');
      git(dir, 'add', 'staged.txt');
      const reply = await gitDiffSearch(req(dir, 'needle'), signal());
      assert.equal(reply.error, undefined);
      const found = reply.hits.map((h) => `${h.sign}${h.rel}:${h.line}:${h.text}`).sort();
      assert.deepEqual(found, ['+a.txt:4:delta needle', '+staged.txt:1:staged needle', '+untracked.txt:2:needle in new file', '-a.txt:2:beta needle']);
    } finally {
      cleanup(dir);
    }
  });

  it('удалённая строка находится, а неизменённая - нет', async () => {
    const dir = repo();
    try {
      write(dir, 'sub/b.ts', 'const other = 2;\n');
      const reply = await gitDiffSearch(req(dir, 'Needle', { caseSensitive: true }), signal());
      assert.deepEqual(reply.hits.map((h) => `${h.sign}${h.rel}:${h.text}`), ['-sub/b.ts:export const Needle = 1;']);
      assert.equal((await gitDiffSearch(req(dir, 'alpha'), signal())).hits.length, 0, 'неизменённая строка контекстом не считается');
    } finally {
      cleanup(dir);
    }
  });

  it('выражение и целое слово', async () => {
    const dir = repo();
    try {
      write(dir, 'a.txt', 'alpha\nbeta needles\ngamma needle\n');
      const re = await gitDiffSearch(req(dir, 'needle$', { regex: true }), signal());
      assert.deepEqual(re.hits.map((h) => `${h.sign}${h.line}`).sort(), ['+3', '-2'], 'конец строки: удалённая «beta needle» и добавленная «gamma needle»');
      const word = await gitDiffSearch(req(dir, 'needle', { wholeWord: true }), signal());
      assert.deepEqual(word.hits.map((h) => `${h.sign}${h.line}`).sort(), ['+3', '-2']);
    } finally {
      cleanup(dir);
    }
  });

  it('негодное и тяжёлое выражение - причина, git не падает', async () => {
    const dir = repo();
    try {
      write(dir, 'a.txt', `${'a'.repeat(40)}b\n`);
      assert.match((await gitDiffSearch(req(dir, '(', { regex: true }), signal())).error ?? '', /^Выражение не разобрано/);
      const started = Date.now();
      const heavy = await gitDiffSearch(req(dir, '(a+)+$', { regex: true }), signal());
      assert.match(heavy.error ?? '', /слишком тяжёл/);
      assert.ok(Date.now() - started < 8000);
    } finally {
      cleanup(dir);
    }
  });

  it('не git-репозиторий и репозиторий без коммитов - причина', async () => {
    const dir = tmp();
    try {
      assert.equal((await gitDiffSearch(req(dir, 'x'), signal())).error, 'Не git-репозиторий');
      git(dir, 'init', '-q');
      write(dir, 'f.txt', 'x\n');
      assert.equal((await gitDiffSearch(req(dir, 'x'), signal())).error, 'Нет коммита HEAD для сравнения');
    } finally {
      cleanup(dir);
    }
  });

  it('внешний diff, textconv и clean-фильтр из конфига репозитория не запускаются', async () => {
    const dir = repo();
    const marker = path.join(dir, '..', `marker-${path.basename(dir)}`);
    try {
      const script = path.join(dir, 'evil.sh');
      fs.writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\ncat "$1" 2>/dev/null\n`, { mode: 0o755 });
      git(dir, 'config', 'diff.external', script);
      git(dir, 'config', 'diff.evil.textconv', script);
      git(dir, 'config', 'filter.evil.clean', `${script} %f`);
      write(dir, '.gitattributes', '*.txt diff=evil filter=evil\n');
      write(dir, 'a.txt', 'alpha\nbeta needle changed\ngamma\n');
      await gitDiffSearch(req(dir, 'needle'), signal());
      assert.equal(fs.existsSync(marker), false, 'команда из конфига репозитория запущена');
    } finally {
      fs.rmSync(marker, { force: true });
      cleanup(dir);
    }
  });
});

describe('matchLines', () => {
  it('подстрока и целое слово по кириллице и латинице', () => {
    const texts = ['Привет мир', 'приветствие', 'say hello', 'Hello!'];
    assert.deepEqual(matchLines(texts, req('', 'привет'), 10).ranges.map((r) => !!r), [true, true, false, false]);
    assert.deepEqual(matchLines(texts, req('', 'привет', { wholeWord: true }), 10).ranges.map((r) => !!r), [true, false, false, false]);
    assert.deepEqual(matchLines(texts, req('', 'hello', { wholeWord: true }), 10).ranges.map((r) => !!r), [false, false, true, true]);
  });

  it('выражение на катастрофическом перборе обрывается по таймауту, а не вешает процесс', () => {
    const started = Date.now();
    const { error } = matchLines([`${'a'.repeat(40)}b`], req('', '(a+)+$', { regex: true }), 10);
    assert.match(error ?? '', /слишком тяжёл/);
    assert.ok(Date.now() - started < 5000);
  });

  it('предел: после limit совпадений сравнение останавливается', () => {
    const texts = Array.from({ length: 50 }, () => 'needle');
    const { ranges } = matchLines(texts, req('', 'needle', { regex: true }), 5);
    assert.equal(ranges.filter(Boolean).length, 6);
  });
});

describe('validateSearchRequest и SearchRunner', () => {
  it('форма, запрос и переключатели проверяются', () => {
    assert.ok(validateSearchRequest(req('/r', 'x')));
    for (const bad of [
      null,
      'x',
      { root: 1, query: 'x', options: plain },
      { root: '/r', query: '', options: plain },
      { root: '/r', query: 'a\nb', options: plain },
      { root: '/r', query: 'a\0b', options: plain },
      { root: '/r', query: 'x'.repeat(501), options: plain },
      { root: '/r', query: 'x'.repeat(201), options: { ...plain, regex: true } },
      { root: '/r', query: 'x', options: { regex: 1, caseSensitive: false, wholeWord: false } },
      { root: '/r', query: 'x' },
    ]) {
      assert.equal(validateSearchRequest(bad), null, JSON.stringify(bad));
    }
  });

  it('новый запрос того же вида отменяет прежний; другой вид не затронут', async () => {
    const runner = new SearchRunner();
    const empty = { hits: [], truncated: false } as { hits: never[]; truncated: boolean; cancelled?: true };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = runner.run('text', async () => (await gate, { ...empty, truncated: true }), empty);
    const other = runner.run('changes', async () => ({ ...empty, truncated: true }), empty);
    const second = runner.run('text', async () => empty, empty);
    release();
    assert.equal((await first).cancelled, true);
    assert.equal((await second).cancelled, undefined);
    assert.equal((await other).cancelled, undefined);
  });
});
