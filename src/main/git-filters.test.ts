import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitStatus } from './git.ts';

function sh(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'protocol.file.allow=always', '-C', cwd, ...args], { stdio: 'pipe' });
}

function makeRepo(dir: string): void {
  fs.mkdirSync(dir);
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 't@example.com');
  sh(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, '.gitattributes'), '* filter=x\n');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'a\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'init');
}

// Фильтр запускается только у файла с изменившимся mtime при прежних размере и содержимом.
function touchOld(file: string): void {
  const old = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(file, old, old);
}

function setup(t: { after: (fn: () => void) => void }) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-flt-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const marker = path.join(base, 'filter-ran');
  const script = path.join(base, 'filter.sh');
  fs.writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o755 });
  return { base, marker, script };
}

for (const key of ['clean', 'process']) {
  test(`gitStatus не запускает filter.x.${key} из конфига репозитория`, async (t) => {
    const { base, marker, script } = setup(t);
    const repo = path.join(base, 'repo');
    makeRepo(repo);
    sh(repo, 'config', `filter.x.${key}`, script);
    sh(repo, 'config', 'filter.x.required', 'true');
    touchOld(path.join(repo, 'f.txt'));
    fs.writeFileSync(path.join(repo, 'new.txt'), 'n\n');

    const status = await gitStatus(repo);

    assert.equal(fs.existsSync(marker), false, 'драйвер фильтра выполнен');
    assert.equal(status['new.txt'], '?');
  });
}

test('gitStatus не запускает фильтр из конфига вложенного репозитория', async (t) => {
  const { base, marker, script } = setup(t);
  const inner = path.join(base, 'inner');
  makeRepo(inner);
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.email', 't@example.com');
  sh(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-q', '-m', 'init');
  sh(repo, 'submodule', 'add', '-q', inner, 'sub');
  sh(repo, 'commit', '-q', '-m', 'sub');
  sh(path.join(repo, 'sub'), 'config', 'filter.x.clean', script);
  touchOld(path.join(repo, 'sub', 'f.txt'));

  await gitStatus(repo);

  assert.equal(fs.existsSync(marker), false, 'драйвер фильтра вложенного репозитория выполнен');
});

test('gitStatus вне репозитория возвращает пустой статус', async (t) => {
  const { base } = setup(t);
  assert.deepEqual(await gitStatus(base), {});
});

test('gitStatus перекрывает фильтр с U+2028 в имени подсекции', async (t) => {
  const { base, marker, script } = setup(t);
  const repo = path.join(base, 'repo');
  const name = 'x\u2028y';
  makeRepo(repo);
  fs.writeFileSync(path.join(repo, '.gitattributes'), `f.txt filter=${name}\n`);
  sh(repo, 'commit', '-q', '-am', 'attrs');
  sh(repo, 'config', `filter.${name}.clean`, script);
  touchOld(path.join(repo, 'f.txt'));

  const status = await gitStatus(repo);

  assert.equal(fs.existsSync(marker), false, 'драйвер фильтра выполнен');
  assert.deepEqual(status, {});
});

// Подменяет git в PATH обёрткой: пишет аргументы каждого вызова в журнал, вызов с одним из fail-аргументов завершает кодом 2.
function wrapGit(t: { after: (fn: () => void) => void }, base: string, fail: string[]): () => string[] {
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const bin = path.join(base, 'bin');
  const log = path.join(base, 'git.log');
  fs.mkdirSync(bin);
  const cases = fail.map((arg) => `  *" ${arg} "*) exit 2;;\n`).join('');
  fs.writeFileSync(
    path.join(bin, 'git'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\ncase " $* " in\n${cases}esac\nexec '${realGit}' "$@"\n`,
    { mode: 0o755 },
  );
  const prevPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${prevPath}`;
  t.after(() => {
    process.env.PATH = prevPath;
  });
  return () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
}

for (const failing of ['--get-regexp', 'ls-files']) {
  test(`gitStatus при ошибке ${failing} возвращает пустой статус и не запускает git status`, async (t) => {
    const { base, marker, script } = setup(t);
    const repo = path.join(base, 'repo');
    makeRepo(repo);
    sh(repo, 'config', 'filter.x.clean', script);
    touchOld(path.join(repo, 'f.txt'));
    fs.writeFileSync(path.join(repo, 'new.txt'), 'n\n');
    const calls = wrapGit(t, base, [failing]);

    const status = await gitStatus(repo);

    assert.deepEqual(status, {});
    assert.equal(fs.existsSync(marker), false, 'драйвер фильтра выполнен');
    assert.deepEqual(calls().filter((c) => / status /.test(` ${c} `)), [], 'git status запущен без перекрытия');
  });
}

// Пустой каталог незаполненного подмодуля - обычный итог clone без --recurse-submodules.
test('gitStatus не вызывает git для незаполненного подмодуля', { timeout: 10_000 }, async (t) => {
  const { base } = setup(t);
  const repo = path.join(base, 'repo');
  makeRepo(repo);
  const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  sh(repo, 'update-index', '--add', '--cacheinfo', `160000,${head},sub`);
  sh(repo, 'commit', '-q', '-m', 'gitlink');
  const sub = path.join(repo, 'sub');
  fs.mkdirSync(sub);
  const calls = wrapGit(t, base, []);

  await gitStatus(repo);

  assert.deepEqual(calls().filter((c) => c.includes(sub)), [], 'вызов git для незаполненного подмодуля');
});

test('gitStatus при имени подсекции не в UTF-8 возвращает пустой статус и не запускает фильтр', async (t) => {
  const { base, marker, script } = setup(t);
  const repo = path.join(base, 'repo');
  makeRepo(repo);
  fs.writeFileSync(path.join(repo, '.gitattributes'), Buffer.concat([Buffer.from('f.txt filter=p'), Buffer.from([0xff]), Buffer.from('q\n')]));
  sh(repo, 'commit', '-q', '-am', 'attrs');
  fs.appendFileSync(
    path.join(repo, '.git', 'config'),
    Buffer.concat([Buffer.from('[filter "p'), Buffer.from([0xff]), Buffer.from(`q"]\n\tclean = ${script}\n`)]),
  );
  touchOld(path.join(repo, 'f.txt'));
  fs.writeFileSync(path.join(repo, 'new.txt'), 'n\n');

  assert.deepEqual(await gitStatus(repo), {});
  assert.equal(fs.existsSync(marker), false, 'драйвер фильтра выполнен');
});

// Цепочка заполненных репозиториев: каждый хранит gitlink на вложенный, как заполненный подмодуль.
function makeChain(root: string, levels: number): string {
  let dir = root;
  makeRepo(dir);
  for (let i = 0; i < levels; i++) {
    const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    sh(dir, 'update-index', '--add', '--cacheinfo', `160000,${head},sub`);
    sh(dir, 'commit', '-q', '-m', 'gitlink');
    dir = path.join(dir, 'sub');
    makeRepo(dir);
  }
  return dir;
}

test('gitStatus перекрывает фильтр репозитория на глубине 3', async (t) => {
  const { base, marker, script } = setup(t);
  const deepest = makeChain(path.join(base, 'repo'), 3);
  sh(deepest, 'config', 'filter.x.clean', script);
  touchOld(path.join(deepest, 'f.txt'));

  await gitStatus(path.join(base, 'repo'));

  assert.equal(fs.existsSync(marker), false, 'драйвер фильтра выполнен');
});

test('gitStatus при вложенности глубже предела возвращает пустой статус', { timeout: 30_000 }, async (t) => {
  const { base } = setup(t);
  makeChain(path.join(base, 'repo'), 12);
  fs.writeFileSync(path.join(base, 'repo', 'new.txt'), 'n\n');

  assert.deepEqual(await gitStatus(path.join(base, 'repo')), {});
});

// Gitlink заводится через index-info: путь с байтом 0xff в аргумент командной строки строкой не передать.
function addGitlink(repo: string, inner: string, relPath: Buffer): void {
  const sha = execFileSync('git', ['-C', inner, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', repo, 'update-index', '--add', '-z', '--index-info'], {
    input: Buffer.concat([Buffer.from(`160000 ${sha}\t`), relPath, Buffer.from('\0')]),
  });
}

function repoWithPopulatedSub(base: string, relPath: Buffer, script: string): string {
  const inner = path.join(base, 'inner');
  makeRepo(inner);
  sh(inner, 'config', 'filter.x.clean', script);
  touchOld(path.join(inner, 'f.txt'));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  sh(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  addGitlink(repo, inner, relPath);
  fs.renameSync(Buffer.from(inner), Buffer.concat([Buffer.from(repo + '/'), relPath]));
  return repo;
}

test('gitStatus перекрывает фильтр заполненного подмодуля с именем на две точки', async (t) => {
  const { base, marker, script } = setup(t);
  const repo = repoWithPopulatedSub(base, Buffer.from('..x'), script);

  await gitStatus(repo);

  assert.equal(fs.existsSync(marker), false, 'драйвер фильтра подмодуля ..x выполнен');
});

test('gitStatus с подмодулем по пути не в UTF-8 не запускает его фильтр', async (t) => {
  const { base, marker, script } = setup(t);
  const repo = repoWithPopulatedSub(base, Buffer.from([0x70, 0xff, 0x71]), script);

  const status = await gitStatus(repo);

  assert.equal(fs.existsSync(marker), false, 'драйвер фильтра подмодуля выполнен');
  assert.deepEqual(status, {});
});

test('gitStatus не перекрывает фильтр из глобального конфига', async (t) => {
  const { base, marker, script } = setup(t);
  const global = path.join(base, 'gitconfig');
  fs.writeFileSync(global, `[filter "x"]\n\tclean = ${script}\n`);
  const prev = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = global;
  t.after(() => {
    if (prev === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = prev;
  });
  const repo = path.join(base, 'repo');
  makeRepo(repo);
  // makeRepo сам гоняет глобальный фильтр через git add.
  fs.rmSync(marker, { force: true });
  touchOld(path.join(repo, 'f.txt'));

  await gitStatus(repo);

  assert.equal(fs.existsSync(marker), true, 'доверенный глобальный фильтр перекрыт');
});

test('gitStatus перекрывает фильтр из worktree-конфига', async (t) => {
  const { base, marker, script } = setup(t);
  const repo = path.join(base, 'repo');
  makeRepo(repo);
  sh(repo, 'config', 'extensions.worktreeConfig', 'true');
  sh(repo, 'config', '--worktree', 'filter.x.clean', script);
  touchOld(path.join(repo, 'f.txt'));

  await gitStatus(repo);

  assert.equal(fs.existsSync(marker), false, 'драйвер фильтра из worktree-конфига выполнен');
});
