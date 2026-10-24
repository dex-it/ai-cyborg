import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { gitHeadContent } from '../src/main/git';

describe('gitHeadContent', () => {
  it('текст из HEAD; новый, двоичный и вне репозитория - null', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-head-')));
    try {
      const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
      git('init', '-q');
      fs.mkdirSync(path.join(dir, 'sub dir'));
      fs.writeFileSync(path.join(dir, 'sub dir', 'a.txt'), 'было\n');
      fs.writeFileSync(path.join(dir, 'bin'), Buffer.from([1, 0, 2]));
      git('add', '.');
      git('commit', '-qm', 'init');
      fs.writeFileSync(path.join(dir, 'sub dir', 'a.txt'), 'стало\n');
      fs.writeFileSync(path.join(dir, 'new.txt'), 'x');
      assert.equal(await gitHeadContent(path.join(dir, 'sub dir', 'a.txt')), 'было\n');
      assert.equal(await gitHeadContent(path.join(dir, 'new.txt')), null);
      assert.equal(await gitHeadContent(path.join(dir, 'bin')), null);
      assert.equal(await gitHeadContent(path.join(os.tmpdir(), 'nowhere', 'x.txt')), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
