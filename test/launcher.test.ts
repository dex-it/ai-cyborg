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
});
