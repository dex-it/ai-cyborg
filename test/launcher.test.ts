import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

// `npm test` запускается из корня репозитория.
const script = path.join(process.cwd(), 'cyborg');

/** Каталог с подставными git, node и npm: скрипт доходит до проверки версии, не трогая настоящие. */
function stubBin(t: { after: (fn: () => void) => void }, nodeVersion: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-launcher-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name: string, body: string) => fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  write('git', 'exit 0');
  write('npm', 'echo "вызван подставной npm" >&2; exit 99');
  write('node', `case "$1" in -v) echo v${nodeVersion};; -p) echo ${nodeVersion.split('.')[0]};; esac`);
  return dir;
}

describe('скрипт запуска cyborg', () => {
  it('исполняемый и разбирается как POSIX sh', () => {
    assert.ok(fs.statSync(script).mode & 0o100, 'нет бита исполнения');
    const check = spawnSync('sh', ['-n', script], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
  });

  it('Node старше 24 - сообщение с найденной версией и код 1 до установки и сборки', (t) => {
    const bin = stubBin(t, '22.1.0');
    const run = spawnSync('sh', [script], { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin` } });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /нужен Node\.js 24 или новее, найден v22\.1\.0/);
    assert.doesNotMatch(run.stderr, /вызван подставной npm/);
  });

  it('Node 24 проходит проверку версии и доходит до npm (установка или сборка)', (t) => {
    const bin = stubBin(t, '24.20.0');
    const run = spawnSync('sh', [script], { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin` } });
    assert.equal(run.status, 99);
    assert.match(run.stderr, /вызван подставной npm/);
    assert.doesNotMatch(run.stderr, /нужен Node\.js 24/);
  });

  it('передаёт Electron каталог вызова: относительный --workspace считается не от репозитория', (t) => {
    const bin = stubBin(t, '24.20.0');
    fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-repo-'));
    const caller = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-caller-'));
    t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
    t.after(() => fs.rmSync(caller, { recursive: true, force: true }));
    fs.copyFileSync(script, path.join(repo, 'cyborg'));
    fs.chmodSync(path.join(repo, 'cyborg'), 0o755);
    fs.writeFileSync(path.join(repo, 'package-lock.json'), '{}');
    fs.mkdirSync(path.join(repo, 'node_modules', '.bin'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'node_modules', '.package-lock.json'), '{}');
    fs.writeFileSync(path.join(repo, 'node_modules', '.bin', 'electron'), '#!/bin/sh\necho "cwd=$(pwd -P) caller=$CYBORG_CWD"\n', { mode: 0o755 });
    const run = spawnSync('sh', [path.join(repo, 'cyborg'), '--workspace', 'rel.json'], { cwd: caller, encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin` } });
    assert.equal(run.status, 0, run.stderr);
    assert.ok(run.stdout.includes(`caller=${fs.realpathSync(caller)}`) || run.stdout.includes(`caller=${caller}`), run.stdout);
    assert.ok(run.stdout.includes(`cwd=${fs.realpathSync(repo)}`), run.stdout);
  });
});
