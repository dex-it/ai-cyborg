import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Импорт с расширением .ts нужен type stripping Node, но tsc без allowImportingTsExtensions его не принимает.
const gitModule = './git.ts';
const { gitRoot, gitBranch, gitStatus } = (await import(gitModule)) as typeof import('./git');

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

test('git-запросы не выполняют core.fsmonitor из конфига репозитория', async (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-git-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo');
  const marker = path.join(base, 'fsmonitor-ran');
  const hook = path.join(base, 'fsmonitor.sh');
  fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });

  fs.mkdirSync(repo);
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.email', 't@example.com');
  sh(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'a\n');
  sh(repo, 'add', 'tracked.txt');
  sh(repo, 'commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'b\n');
  fs.writeFileSync(path.join(repo, 'new.txt'), 'n\n');
  sh(repo, 'config', 'core.fsmonitor', hook);

  const root = await gitRoot(repo);
  const branch = await gitBranch(repo);
  const status = await gitStatus(repo);

  assert.equal(fs.existsSync(marker), false, 'команда core.fsmonitor выполнена');
  assert.equal(root, repo);
  assert.equal(branch, 'main');
  assert.deepEqual(status, { 'tracked.txt': 'M', 'new.txt': '?' });
});
