import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { projectDirName } from '../src/main/history';
import { sessionTree } from '../src/main/session-tree';

const SID = '11111111-1111-1111-1111-111111111111';

function repoAt(dir: string): string {
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'a.md'), 'x\n');
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']);
  return dir;
}

test('дерево сессии: worktree из журнала и из живого cwd; подкаталог, чужой репозиторий, убранный worktree и сессия без каталога дают репозиторий строки', async (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-session-tree-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const repo = repoAt(path.join(base, 'repo'));
  const other = repoAt(path.join(base, 'other'));
  const wt = path.join(repo, '.claude', 'worktrees', 'x');
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', wt]);
  const journals = path.join(base, 'projects');
  const journal = path.join(journals, projectDirName(wt));
  fs.mkdirSync(journal, { recursive: true });
  fs.writeFileSync(path.join(journal, `${SID}.jsonl`), JSON.stringify({ type: 'user', cwd: wt }));

  assert.equal(await sessionTree(repo, { cwd: repo, resume: SID }, journals), wt, 'журнал называет worktree, хотя живой cwd - репозиторий');
  assert.equal(await sessionTree(repo, { cwd: wt, resume: null }, journals), wt, 'разговор не начат: живой cwd');
  assert.equal(await sessionTree(repo, { cwd: path.join(wt, 'docs'), resume: null }, journals), wt, 'подкаталог worktree');
  assert.equal(await sessionTree(repo, { cwd: path.join(repo, 'docs'), resume: null }, journals), repo, 'подкаталог репозитория');
  assert.equal(await sessionTree(repo, { cwd: other, resume: null }, journals), repo, 'чужой репозиторий');
  assert.equal(await sessionTree(repo, { cwd: base, resume: null }, journals), repo, 'каталог вне git');
  assert.equal(await sessionTree(repo, null, journals), repo, 'сессии нет');
  assert.equal(await sessionTree(repo, { cwd: repo, resume: '22222222-2222-2222-2222-222222222222' }, journals), repo, 'журнала нет');
  execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', wt]);
  assert.equal(await sessionTree(repo, { cwd: repo, resume: SID }, journals), repo, 'worktree убран');
  assert.equal(await sessionTree(repo, { cwd: wt, resume: null }, journals), repo, 'живой cwd убран');
});
