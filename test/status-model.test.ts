import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { JiraIssue } from '../src/main/jira';
import type { Mr, MrListResult } from '../src/main/mrs';
import { attentionOf, groupIssues, jiraTime, levelOf, mentionsKey, mrsOfIssue, pipelineTone, usable } from '../src/renderer/status-model';

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
    sourceBranch: `feature/${n}`,
    targetBranch: 'main',
    draft: false,
    state: 'open',
    pipeline: 'успешен',
    approvals: 'апрувов: 0',
    url: '',
    createdAt: '',
    updatedAt: '',
    own: true,
    comments: false,
    repos: ['/w/a'],
    ...extra,
  };
}

function issue(key: string, category: JiraIssue['category'] = ''): JiraIssue {
  return { key, summary: key, status: 'X', category, type: '', priority: '', assignee: null, reporter: null, created: '', updated: '', labels: [], description: '' };
}

describe('Статус: пайплайн', () => {
  it('слова главного процесса -> тон', () => {
    assert.equal(pipelineTone('упал'), 'bad');
    assert.equal(pipelineTone('идёт'), 'wait');
    assert.equal(pipelineTone('ожидает'), 'wait');
    assert.equal(pipelineTone('успешен'), 'good');
    for (const other of ['нет пайплайна', 'отменён', null, 'manual']) assert.equal(pipelineTone(other), 'none', String(other));
  });
});

describe('Статус: что просит внимания', () => {
  it('свой MR: упавший пайплайн и замечания - причины одного MR; спокойный MR не попадает', () => {
    const both = mr({ pipeline: 'упал', comments: true });
    const quiet = mr();
    const items = attentionOf([quiet, both], []);
    assert.equal(items.length, 1);
    assert.deepEqual(items[0].kinds, ['pipeline-failed', 'has-comments']);
  });

  it('чужой открытый не-черновик, где я ревьюер - ждёт ревью; черновик, закрытый и свой не считаются', () => {
    const wait = mr({ own: false });
    const items = attentionOf([], [wait, mr({ own: false, draft: true }), mr({ own: false, state: 'merged' }), mr({ own: true })]);
    assert.deepEqual(items.map((i) => i.mr), [wait]);
    assert.deepEqual(items[0].kinds, ['review-requested']);
  });

  it('закрытый и влитый свой MR с упавшим пайплайном внимания не просят', () => {
    assert.deepEqual(attentionOf([mr({ state: 'closed', pipeline: 'упал' }), mr({ state: 'merged', comments: true })], []), []);
  });

  it('порядок: упавший пайплайн, замечания, ревью; MR из двух списков - один раз', () => {
    const review = mr({ own: false });
    const comments = mr({ comments: true });
    const failed = mr({ pipeline: 'упал' });
    const items = attentionOf([comments, failed], [review, { ...failed, own: false }]);
    assert.deepEqual(items.map((i) => i.mr), [failed, comments, review]);
  });
});

describe('Статус: уровень индикатора', () => {
  it('нет данных ни из одного списка - unknown', () => {
    assert.equal(levelOf(null, null), 'unknown');
  });

  it('упавший пайплайн своего MR - bad, сильнее прочего', () => {
    assert.equal(levelOf([mr({ pipeline: 'упал' }), mr({ comments: true })], [mr({ own: false })]), 'bad');
  });

  it('замечания либо просьба ревью - attention', () => {
    assert.equal(levelOf([mr({ comments: true })], []), 'attention');
    assert.equal(levelOf([], [mr({ own: false })]), 'attention');
  });

  it('пайплайн идёт - wait; всё хорошо - ok, в том числе без единого MR', () => {
    assert.equal(levelOf([mr({ pipeline: 'идёт' })], []), 'wait');
    assert.equal(levelOf([mr()], []), 'ok');
    assert.equal(levelOf([], []), 'ok');
    assert.equal(levelOf([], null), 'ok', 'один список получен, другого нет - судим по полученному');
  });

  it('wait не затирает attention', () => {
    assert.equal(levelOf([mr({ pipeline: 'идёт' }), mr({ comments: true })], []), 'attention');
  });
});

describe('Статус: связь задач Jira и MR', () => {
  it('ключ - отдельное слово: DEX-1 не в DEX-12 и не в XDEX-1, регистр не важен', () => {
    assert.ok(mentionsKey('DEX-1: починить', 'DEX-1'));
    assert.ok(mentionsKey('feature/dex-1-fix', 'DEX-1'));
    assert.ok(mentionsKey('Fix (DEX-1)', 'DEX-1'));
    assert.ok(!mentionsKey('DEX-12 делаем', 'DEX-1'));
    assert.ok(!mentionsKey('XDEX-1', 'DEX-1'));
    assert.ok(!mentionsKey('A_DEX-1', 'DEX-1'));
    assert.ok(!mentionsKey('нет ключа', 'DEX-1'));
  });

  it('MR задачи: по названию или по ветке; в ключе нет спецсимволов регэкспа', () => {
    const byTitle = mr({ title: 'DEX-7 выгрузка' });
    const byBranch = mr({ sourceBranch: 'feature/dex-7-csv' });
    const other = mr({ title: 'DEX-70 другое', sourceBranch: 'main-2' });
    assert.deepEqual(mrsOfIssue({ key: 'DEX-7' }, [byTitle, other, byBranch]), [byTitle, byBranch]);
    assert.deepEqual(mrsOfIssue({ key: 'A.B-1' }, [mr({ title: 'AXB-1' })]), [], 'точка ключа не «любой символ»');
  });

  it('группы: «В работе» первой, пустые не возвращаются, порядок сохранён', () => {
    const groups = groupIssues([issue('A-1'), issue('A-2', 'indeterminate'), issue('A-3'), issue('A-4', 'indeterminate')]);
    assert.deepEqual(groups.map((g) => [g.id, g.issues.map((i) => i.key)]), [['progress', ['A-2', 'A-4']], ['rest', ['A-1', 'A-3']]]);
    assert.deepEqual(groupIssues([issue('A-1')]).map((g) => g.id), ['rest']);
    assert.deepEqual(groupIssues([]), []);
  });

  it('время jira-cli с поясом без двоеточия', () => {
    assert.equal(jiraTime('2026-10-25T12:30:00.000+0300'), Date.parse('2026-10-25T12:30:00.000+03:00'));
    assert.equal(jiraTime('вчера'), 0);
    assert.equal(jiraTime(''), 0);
  });
});

describe('Статус: когда по MR можно судить', () => {
  const list = (over: Partial<MrListResult>): MrListResult => ({
    mrs: [],
    sources: [{ kind: 'github', host: 'github.com', path: 'o/a' }],
    tracked: [],
    enabled: { github: true, gitlab: false },
    detailsId: null,
    awaiting: [],
    ...over,
  });

  it('источник ответил - MR есть (в том числе пустой список)', () => {
    const mrs = [mr()];
    assert.equal(usable(list({ mrs })), mrs);
    assert.deepEqual(usable(list({})), []);
  });

  it('нет результата, общая ошибка, источники выключены - данных нет', () => {
    assert.equal(usable(null), null);
    assert.equal(usable(list({ error: 'Проект не найден' })), null);
    assert.equal(usable(list({ enabled: { github: false, gitlab: false } })), null);
  });

  it('нет входа (источник без пути), нет remote (источников нет), все репозитории с ошибкой - данных нет, а не «всё спокойно»', () => {
    assert.equal(usable(list({ sources: [{ kind: 'github', host: '', path: '', error: 'вход gh не выполнен' }] })), null);
    assert.equal(usable(list({ sources: [] })), null);
    assert.equal(usable(list({ sources: [{ kind: 'github', host: 'github.com', path: 'o/a', error: 'таймаут' }] })), null);
  });

  it('один репозиторий упал, другой ответил - судим по ответившему', () => {
    const sources = [{ kind: 'github' as const, host: 'github.com', path: 'o/a', error: 'таймаут' }, { kind: 'github' as const, host: 'github.com', path: 'o/b' }];
    assert.deepEqual(usable(list({ sources })), []);
  });
});
