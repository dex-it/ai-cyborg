import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { gitBranch, gitBranches, gitSwitch } from '../src/main/git';

describe('gitBranches и gitSwitch', () => {
  it('локальные и только удалённые ветки; переключение, в том числе на ветку remote; чужое имя и конфликт - отказ', async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-branch-')));
    try {
      const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'pipe' });
      const origin = path.join(base, 'origin');
      const dir = path.join(base, 'work');
      fs.mkdirSync(origin);
      git(origin, 'init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(origin, 'a.txt'), 'main\n');
      git(origin, 'add', '.');
      git(origin, 'commit', '-qm', 'init');
      git(origin, 'branch', 'remote-only');
      git(base, 'clone', '-q', origin, dir);
      git(dir, 'switch', '-qc', 'feature');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'feature\n');
      git(dir, 'commit', '-qam', 'f');

      const b = await gitBranches(dir);
      assert.equal(b.current, 'feature');
      assert.deepEqual([...b.local].sort(), ['feature', 'main']);
      assert.deepEqual(b.remote, ['remote-only']);

      await gitSwitch(dir, 'remote-only');
      assert.equal(await gitBranch(dir), 'remote-only');
      await assert.rejects(gitSwitch(dir, '--orphan=x'), /Ветки --orphan=x нет/);

      fs.writeFileSync(path.join(dir, 'a.txt'), 'правка\n');
      await assert.rejects(gitSwitch(dir, 'feature'), (e: Error) => !e.message.startsWith('Command failed') && !!e.message);
      assert.equal(await gitBranch(dir), 'remote-only');

      git(dir, 'checkout', '-q', '--', 'a.txt');
      git(dir, 'config', 'filter.evil.smudge', 'touch pwned');
      await assert.rejects(gitSwitch(dir, 'main'), /filter\.evil\.smudge/);
      assert.equal(await gitBranch(dir), 'remote-only');
      assert.ok(!fs.existsSync(path.join(dir, 'pwned')));

      git(dir, 'config', '--unset', 'filter.evil.smudge');
      git(dir, 'config', 'remote.origin.promisor', 'true');
      await assert.rejects(gitSwitch(dir, 'main'), /remote\.origin\.promisor/);
      git(dir, 'config', '--unset', 'remote.origin.promisor');
      git(dir, 'config', 'extensions.partialClone', 'origin');
      await assert.rejects(gitSwitch(dir, 'main'), /extensions\.partialclone/);
      assert.equal(await gitBranch(dir), 'remote-only');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
