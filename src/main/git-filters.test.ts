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
