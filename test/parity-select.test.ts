import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';

const repo = process.cwd();

describe('scripts/parity.mjs: выбор записей по номеру', () => {
  // Записи kind=expected не играются, поэтому Electron не запускается: по выводу видно, какие записи выбраны.
  const run = (...selected: string[]) => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'cyborg-parity-select-')));
    try {
      mkdirSync(join(base, 'app', 'dist'), { recursive: true });
      writeFileSync(join(base, 'app', 'dist', 'main.js'), '');
      mkdirSync(join(base, 'records'));
      for (const [id, name] of [['S01', 'S01-first'], ['S02', 'S02-second'], ['S10', 'S10-tenth']]) {
        writeFileSync(join(base, 'records', `${name}.json`), JSON.stringify({ id, title: name, kind: 'expected' }));
      }
      const out = spawnSync(process.execPath, ['scripts/parity.mjs', '--dir', relative(repo, join(base, 'records')), ...selected], { cwd: repo, encoding: 'utf8', timeout: 30_000, env: { ...process.env, CYBORG_APP_DIR: join(base, 'app') } });
      return { status: out.status, text: out.stdout + out.stderr };
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  };

  it('S1 выбирает запись S01, а не S10', () => {
    const { text } = run('S1');
    assert.match(text, /S01-first/);
    assert.doesNotMatch(text, /S10-tenth/);
    assert.doesNotMatch(text, /S02-second/);
  });

  it('S10 выбирает только S10', () => {
    const { text } = run('S10');
    assert.match(text, /S10-tenth/);
    assert.doesNotMatch(text, /S01-first/);
  });

  it('номер без записи - ошибка с кодом 1, а не зелёный прогон из нуля записей', () => {
    const { status, text } = run('S99');
    assert.equal(status, 1, text);
    assert.match(text, /S99/);
    assert.doesNotMatch(text, /все 0 прошли/);
  });

  it('без номеров играются все записи', () => {
    const { status, text } = run();
    assert.equal(status, 0, text);
    for (const name of ['S01-first', 'S02-second', 'S10-tenth']) assert.match(text, new RegExp(name));
  });
});
