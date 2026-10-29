import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { walkFiles } from '../src/main/files';
import { gitFiles } from '../src/main/git';

describe('список файлов для поиска', () => {
  const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-files-')));

  it('gitFiles: отслеживаемые и новые без игнорируемых; вне git - null', async () => {
    const dir = tmp();
    try {
      const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
      git('init', '-q');
      fs.mkdirSync(path.join(dir, 'sub'));
      fs.writeFileSync(path.join(dir, 'sub', 'a.txt'), '');
      fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored.txt\n');
      git('add', '.');
      git('commit', '-qm', 'init');
      fs.writeFileSync(path.join(dir, 'new.txt'), '');
      fs.writeFileSync(path.join(dir, 'ignored.txt'), '');
      assert.deepEqual((await gitFiles(dir))?.sort(), ['.gitignore', 'new.txt', 'sub/a.txt']);
      assert.equal(await gitFiles(os.tmpdir()), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('walkFiles: файлы всех уровней без .git', async () => {
    const dir = tmp();
    try {
      fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
      fs.mkdirSync(path.join(dir, '.git'));
      fs.writeFileSync(path.join(dir, '.git', 'HEAD'), '');
      fs.writeFileSync(path.join(dir, 'a', 'b', 'c.txt'), '');
      fs.writeFileSync(path.join(dir, 'top.txt'), '');
      assert.deepEqual((await walkFiles(dir)).sort(), ['a/b/c.txt', 'top.txt']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
