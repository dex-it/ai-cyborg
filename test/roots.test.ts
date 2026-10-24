import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rootLabel, treeRoots } from '../src/renderer/roots';

const paths = (s: Parameters<typeof treeRoots>[0]) => treeRoots(s).map((r) => r.path);

describe('treeRoots', () => {
  it('cwd ушёл в другой репозиторий проекта: свой корень, затем стартовый репозиторий, без дубля', () => {
    assert.deepEqual(paths({ repo: '/A', root: '/B', repos: ['/A', '/B'] }), ['/B', '/A']);
  });

  it('worktree репозитория: свой worktree и прочие без стартового репозитория', () => {
    assert.deepEqual(paths({ repo: '/A', root: '/W', repos: ['/A', '/B'] }), ['/W', '/B']);
  });

  it('корень совпадает со стартовым репозиторием: порядок проекта', () => {
    assert.deepEqual(paths({ repo: '/A', root: '/A', repos: ['/A', '/B'] }), ['/A', '/B']);
  });

  it('при перешедшем cwd стартовый репозиторий назван репозиторием запуска, а корень не worktree', () => {
    const [own, start] = treeRoots({ repo: '/x/A', root: '/x/B', repos: ['/x/A', '/x/B'] });
    assert.match(start.hint, /запущена/);
    assert.doesNotMatch(start.hint, /--add-dir/);
    assert.doesNotMatch(own.hint, /worktree/);
    assert.equal(own.label, 'B');
    assert.equal(rootLabel({ repo: '/x/A', root: '/x/B', repos: ['/x/A', '/x/B'] }), 'B');
  });

  it('worktree сохраняет подпись и подсказку про worktree', () => {
    const [own] = treeRoots({ repo: '/x/A', root: '/x/W', repos: ['/x/A'] });
    assert.equal(own.label, 'A ⎇ W');
    assert.match(own.hint, /worktree репозитория \/x\/A/);
  });
});
