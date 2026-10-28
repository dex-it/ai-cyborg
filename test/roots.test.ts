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

  it('worktree другого репозитория проекта: подписан его репозиторием, стартовый остаётся в дереве', () => {
    const s = { repo: '/x/front', root: '/x/back/.claude/worktrees/v2', repos: ['/x/front', '/x/back'] };
    const [own, start, ...rest] = treeRoots(s);
    assert.equal(own.label, 'back ⎇ v2');
    assert.match(own.hint, /worktree репозитория \/x\/back/);
    assert.equal(start.path, '/x/front');
    assert.match(start.hint, /запущена/);
    assert.deepEqual(rest, []);
    assert.equal(rootLabel(s), 'back ⎇ v2');
  });

  it('worktree стартового внутри него: подпись прежняя, прочие репозитории на месте', () => {
    assert.deepEqual(paths({ repo: '/x/front', root: '/x/front/.claude/worktrees/v2', repos: ['/x/front', '/x/back'] }), ['/x/front/.claude/worktrees/v2', '/x/back']);
    assert.equal(rootLabel({ repo: '/x/front', root: '/x/front/.claude/worktrees/v2', repos: ['/x/front', '/x/back'] }), 'front ⎇ v2');
  });

  it('worktree сохраняет подпись и подсказку про worktree', () => {
    const [own] = treeRoots({ repo: '/x/A', root: '/x/W', repos: ['/x/A'] });
    assert.equal(own.label, 'A ⎇ W');
    assert.match(own.hint, /worktree репозитория \/x\/A/);
  });
});
