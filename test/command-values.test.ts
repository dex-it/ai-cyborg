import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Mr } from '../src/main/mrs';
import { pickPr } from '../src/renderer/command-values';

let n = 0;
function mr(extra: Partial<Mr> = {}): Mr {
  n++;
  return {
    kind: 'github',
    host: 'github.com',
    path: 'o/a',
    number: n,
    key: `github:github.com/o/a!${n}`,
    title: `Изменение ${n}`,
    author: 'me',
    sourceBranch: 'feat/x',
    targetBranch: 'main',
    draft: false,
    state: 'open',
    pipeline: null,
    approvals: null,
    url: `https://github.com/o/a/pull/${n}`,
    createdAt: '',
    updatedAt: '',
    own: true,
    repos: ['/w/a'],
    ...extra,
  };
}

describe('{pr}: выбор PR/MR по ветке сессии', () => {
  it('единственный открытый PR ветки в репозитории проекта', () => {
    const only = mr();
    assert.deepEqual(pickPr([mr({ sourceBranch: 'other' }), only], 'feat/x', '/w/a'), { url: only.url });
  });

  it('чужой PR на ветке сессии находится, если своего нет', () => {
    const theirs = mr({ own: false, author: 'colleague' });
    assert.deepEqual(pickPr([theirs], 'feat/x', '/w/a'), { url: theirs.url });
  });

  it('свой PR приоритетнее чужого с той же веткой', () => {
    const mine = mr();
    assert.deepEqual(pickPr([mr({ own: false }), mine], 'feat/x', '/w/a'), { url: mine.url });
  });

  it('несколько подходящих на одном уровне - отказ с номерами, выбирает человек', () => {
    const a = mr();
    const b = mr({ kind: 'gitlab' });
    const result = pickPr([a, b], 'feat/x', '/w/a');
    assert.ok('reason' in result);
    assert.match(result.reason, new RegExp(`#${a.number}, !${b.number}`));
    const foreign = pickPr([mr({ own: false }), mr({ own: false })], 'feat/x', '/w/a');
    assert.ok('reason' in foreign && /несколько/.test(foreign.reason));
  });

  it('нет открытого PR: закрытый, влитый, другая ветка, другой репозиторий - не в счёт', () => {
    const result = pickPr([mr({ state: 'merged' }), mr({ state: 'closed' }), mr({ sourceBranch: 'z' }), mr({ repos: ['/w/b'] })], 'feat/x', '/w/a');
    assert.deepEqual(result, { reason: 'у ветки feat/x нет открытого PR/MR' });
    assert.deepEqual(pickPr([], 'feat/x', '/w/a'), { reason: 'у ветки feat/x нет открытого PR/MR' });
  });

  it('PR из форка (ветка источника равна ветке назначения) не принимается за PR ветки сессии', () => {
    const fork = mr({ own: false, sourceBranch: 'main', targetBranch: 'main' });
    assert.deepEqual(pickPr([fork], 'main', '/w/a'), { reason: 'у ветки main нет открытого PR/MR' });
  });
});
