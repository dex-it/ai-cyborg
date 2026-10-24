import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Task, TasksResult, TrackersStatus } from '../src/main/trackers';
import type { Mr, MrListResult } from '../src/main/mrs';
import { applyMrDetails, mrActionLabel, mrEmptyView, mrIntent, mrMeta, mrSessionLabel, mrStatusText, mrTooltip } from '../src/renderer/mr-model';
import {
  availableLabels, cycleLabel, descriptionText, DescriptionStore, detailsLines, filterByLabels, labelEmpty, labelInk, parseLabelFilter,
  requireLabel, serializeLabelFilter, type LabelFilter,
} from '../src/renderer/task-model';
import { authLines, hasSources, sortByKey, emptyView, findTask, sessionLabel, sortTasks, sourceLabel, statusText, taskTooltip } from '../src/renderer/task-model';

const task = (n: number, over: Partial<Task> = {}): Task => ({
  kind: 'github', host: 'github.com', path: 'o/r', number: n, key: `github:github.com/o/r#${n}`, title: `T${n}`, state: 'open',
  workflow: [], labels: [], author: 'u', assignees: [], url: `https://github.com/o/r/issues/${n}`, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', repos: ['/a'], ...over,
});

describe('sortTasks', () => {
  const a = task(1, { createdAt: '2026-03-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });
  const b = task(2, { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-03-01T00:00:00Z' });
  const c = task(3, { createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z' });
  it('по дате обновления новые сверху', () => assert.deepEqual(sortTasks([a, b, c], 'updated').map((t) => t.number), [2, 3, 1]));
  it('по дате создания', () => assert.deepEqual(sortTasks([a, b, c], 'created').map((t) => t.number), [1, 3, 2]));
  it('по номеру по убыванию', () => assert.deepEqual(sortTasks([a, b, c], 'number').map((t) => t.number), [3, 2, 1]));
  it('при равенстве - по ключу, вход не меняется', () => {
    const x = task(5, { key: 'b' });
    const y = task(5, { key: 'a' });
    const input = [x, y];
    assert.deepEqual(sortTasks(input, 'number').map((t) => t.key), ['a', 'b']);
    assert.deepEqual(input, [x, y]);
  });
});

describe('заголовок сессии', () => {
  it('номер, название и статус', () => {
    assert.equal(sessionLabel(2, task(7, { title: 'Починить' })), 'CC2 · #7 Починить · открыта');
  });
  it('закрытая и GitLab с workflow-метками', () => {
    assert.equal(statusText(task(1, { state: 'closed' })), 'закрыта');
    assert.equal(statusText(task(1, { workflow: ['workflow::in review'] })), 'открыта, workflow::in review');
  });
  it('подсказка содержит полное название, статус и ссылку', () => {
    const long = 'x'.repeat(300);
    const tip = taskTooltip(task(7, { title: long }));
    assert.ok(tip.includes(long));
    assert.ok(tip.includes('Статус: открыта'));
    assert.ok(tip.includes('https://github.com/o/r/issues/7'));
  });
});

describe('emptyView и поиск', () => {
  const base: TasksResult = { tasks: [], sources: [], tracked: [], enabled: { github: true, gitlab: false } };
  it('нет включённых источников', () => assert.equal(emptyView({ ...base, enabled: { github: false, gitlab: false } }), 'disabled'));
  it('нет remote трекера', () => assert.equal(emptyView(base), 'no-remotes'));
  it('источник без задач', () => assert.equal(emptyView({ ...base, sources: [{ kind: 'github', host: 'github.com', path: 'o/r' }] }), 'no-tasks'));
  it('все источники упали - только ошибки', () =>
    assert.equal(emptyView({ ...base, sources: [{ kind: 'github', host: 'github.com', path: 'o/r', error: 'x' }] }), null));
  it('есть задачи - список', () => assert.equal(emptyView({ ...base, tasks: [task(1)] }), null));
  it('findTask ищет в списке и в tracked', () => {
    const r = { ...base, tasks: [task(1)], tracked: [task(2)] };
    assert.equal(findTask(r, task(2).key)?.number, 2);
    assert.equal(findTask(r, 'none'), undefined);
  });
  it('sourceLabel', () => {
    assert.equal(sourceLabel({ kind: 'github', host: 'github.com', path: 'o/r' }), 'GitHub o/r');
    assert.equal(sourceLabel({ kind: 'gitlab', host: 'git.corp', path: 'g/p' }), 'GitLab git.corp/g/p');
    assert.equal(sourceLabel({ kind: 'gitlab', host: '', path: '' }), 'GitLab');
  });
});

describe('authLines', () => {
  const status = (over: Partial<TrackersStatus>): TrackersStatus => ({ github: { state: 'logged-out' }, gitlab: { state: 'logged-out' }, ...over });
  it('вошедший показан с именем и признаком «включён»', () => {
    assert.deepEqual(authLines('github', true, status({ github: { state: 'logged-in', user: 'me' } })), ['включён · вход выполнен: me']);
    assert.match(authLines('github', false, status({}))[0], /^выключен/);
  });
  it('не вошедший - с подсказкой команды входа', () => {
    assert.match(authLines('github', true, status({}))[0], /gh auth login/);
    assert.match(authLines('gitlab', true, status({}))[0], /glab auth login$/);
  });
  it('хост glab без входа скрыт, пока есть хост с входом', () => {
    const hosts = authLines('gitlab', true, status({ gitlab: { state: 'hosts', hosts: [{ host: 'gitlab.com', auth: { state: 'logged-out' } }, { host: 'h2', auth: { state: 'logged-in', user: 'u' } }] } }));
    assert.deepEqual(hosts, ['h2: включён · вход выполнен: u']);
    const none = authLines('gitlab', true, status({ gitlab: { state: 'hosts', hosts: [{ host: 'gitlab.com', auth: { state: 'logged-out' } }] } }));
    assert.equal(none.length, 1);
    assert.match(none[0], /glab auth login$/);
  });
  it('нет CLI и сбой проверки - отдельные состояния без подсказки входа', () => {
    const missing = authLines('github', true, status({ github: { state: 'missing' } }))[0];
    assert.match(missing, /gh не установлен/);
    assert.ok(!/auth login/.test(missing));
    const err = authLines('github', true, status({ github: { state: 'error', message: 'нет сети' } }))[0];
    assert.match(err, /Проверка не удалась: нет сети/);
    assert.ok(!/auth login/.test(err));
  });
});

const mr = (n: number, over: Partial<Mr> = {}): Mr => ({
  kind: 'gitlab', host: 'git.corp', path: 'g/p', number: n, key: `gitlab:git.corp/g/p!${n}`, title: `M${n}`, author: 'bob', sourceBranch: 'feat',
  targetBranch: 'main', draft: false, state: 'open', pipeline: 'успешен', approvals: 'апрувов: 1', url: `https://git.corp/g/p/-/merge_requests/${n}`,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', own: false, repos: ['/a'], ...over,
});

describe('MR: сортировка', () => {
  it('sortByKey: большее сверху, при равенстве по ключу', () => {
    const a = mr(1, { updatedAt: '2026-03-01T00:00:00Z' });
    const b = mr(2, { updatedAt: '2026-03-01T00:00:00Z' });
    const c = mr(3, { updatedAt: 'мусор' });
    assert.deepEqual(sortByKey([c, b, a], 'updated').map((m) => m.number), [1, 2, 3]);
    assert.deepEqual(sortByKey([a, b, c], 'number').map((m) => m.number), [3, 2, 1]);
  });
});

describe('MR: заголовки и действия', () => {
  it('статус: открыт, черновик, влит, закрыт', () => {
    assert.deepEqual([mr(1), mr(1, { draft: true }), mr(1, { state: 'merged' }), mr(1, { state: 'closed', draft: true })].map(mrStatusText), ['открыт', 'черновик', 'влит', 'закрыт']);
  });
  it('заголовок сессии и подсказка; пайплайн не получен - «—»; номер с префиксом вида', () => {
    assert.equal(mrSessionLabel(3, mr(7, { title: 'Фикс' })), 'CC3 · !7 Фикс · открыт · успешен');
    assert.equal(mrSessionLabel(3, mr(7, { kind: 'github', pipeline: null, state: 'merged' })), 'CC3 · #7 M7 · влит · —');
    assert.equal(mrTooltip(mr(7)), '!7 M7\nСтатус: открыт\nПайплайн: успешен\nhttps://git.corp/g/p/-/merge_requests/7');
  });
  it('действие по автору: чужой - ревью, свой - доработка', () => {
    assert.deepEqual([mrIntent(mr(1)), mrActionLabel(mr(1))], ['review', 'Ревью']);
    assert.deepEqual([mrIntent(mr(1, { own: true })), mrActionLabel(mr(1, { own: true }))], ['rework', 'Доработать']);
  });
  it('строка: автор, ветки, черновик, пайплайн, апрувы; не полученное - «—»; название буквально текстом', () => {
    assert.equal(mrMeta(mr(1, { draft: true })), 'bob · feat → main · черновик · пайплайн: успешен · апрувов: 1');
    assert.equal(mrMeta(mr(1, { pipeline: null, approvals: null })), 'bob · feat → main · пайплайн: — · апрувов: —');
    assert.equal(mrMeta(mr(1, { pipeline: null, approvals: null }), true), 'bob · feat → main · пайплайн: … · апрувов: …');
    assert.equal(mrSessionLabel(1, mr(1, { title: '<img src=x onerror=1>' })).includes('<img src=x onerror=1>'), true);
  });
});

describe('applyMrDetails', () => {
  const list = (): MrListResult => ({ mrs: [mr(1, { pipeline: null, approvals: null }), mr(2, { pipeline: null, approvals: null }), mr(3, { pipeline: null, approvals: null })], sources: [], tracked: [], enabled: { github: false, gitlab: true }, detailsId: 4, awaiting: ['a'] });
  it('значения встают по ключам, порядок прежний, MR без записи - «—», хвост tracked из деталей', () => {
    const extra = mr(9);
    const r = applyMrDetails(list(), { details: [{ key: mr(3).key, pipeline: 'упал', approvals: 'апрувов: 2' }, { key: mr(1).key, pipeline: null, approvals: 'апрувов: 0' }], tracked: [extra] });
    assert.deepEqual(r.mrs.map((m) => [m.number, m.pipeline, m.approvals]), [[1, null, 'апрувов: 0'], [2, null, null], [3, 'упал', 'апрувов: 2']]);
    assert.deepEqual([r.tracked, r.awaiting, r.detailsId], [[extra], [], null]);
  });
  it('детали не получены - у всех «—»', () => {
    const r = applyMrDetails(list(), null);
    assert.ok(r.mrs.every((m) => m.pipeline === null && m.approvals === null));
    assert.deepEqual(r.tracked, []);
  });
});

describe('MR: пустые состояния', () => {
  const result = (over: Partial<MrListResult>): MrListResult => ({ mrs: [], sources: [], tracked: [], enabled: { github: true, gitlab: false }, detailsId: null, awaiting: [], ...over });
  const src = (error?: string) => ({ kind: 'github' as const, host: 'github.com', path: 'o/r', error });
  it('четыре исхода', () => {
    assert.equal(mrEmptyView(result({ enabled: { github: false, gitlab: false } })), 'disabled');
    assert.equal(mrEmptyView(result({})), 'no-remotes');
    assert.equal(mrEmptyView(result({ sources: [src()] })), 'no-mrs');
    assert.equal(mrEmptyView(result({ sources: [src('boom')] })), null);
    assert.equal(mrEmptyView(result({ mrs: [mr(1)], sources: [src()] })), null);
  });
  it('glab-ошибка без path не заменяет «нет remote»', () => {
    assert.equal(mrEmptyView(result({ sources: [{ kind: 'gitlab', host: '', path: '', error: 'x' }] })), 'no-remotes');
  });
});

describe('hasSources', () => {
  const p = (github: boolean, gitlab: boolean) => ({ trackers: { github, gitlab } });
  it('кнопки панелей только при включённом источнике выбранного проекта', () => {
    assert.equal(hasSources(null), false);
    assert.equal(hasSources(p(false, false)), false);
    assert.equal(hasSources(p(true, false)), true);
    assert.equal(hasSources(p(false, true)), true);
  });
});

describe('фильтр меток', () => {
  const lab = (...names: string[]) => names.map((name) => ({ name, color: null }));
  const t = task(1, { labels: lab('a', 'b') });
  const f = (...pairs: [string, '+' | '-'][]): LabelFilter => new Map(pairs);
  it('И по обязательным и НЕ по исключённым', () => {
    for (const ok of [f(['a', '+']), f(['a', '+'], ['b', '+']), f(['a', '+'], ['c', '-']), f()]) assert.equal(filterByLabels([t], ok).length, 1);
    for (const bad of [f(['a', '+'], ['b', '-']), f(['c', '+'])]) assert.equal(filterByLabels([t], bad).length, 0);
  });
  it('только исключённые оставляют и задачи без меток', () => {
    assert.equal(filterByLabels([task(2)], f(['a', '-'])).length, 1);
  });
  it('requireLabel ставит + для новой и исключённой, вход не меняется', () => {
    const input = f(['a', '-']);
    assert.equal(requireLabel(input, 'a').get('a'), '+');
    assert.equal(requireLabel(input, 'z').get('z'), '+');
    assert.equal(input.get('a'), '-');
  });
  it('cycleLabel: + -> − -> снята', () => {
    const one = cycleLabel(f(), 'a');
    assert.equal(one.get('a'), '+');
    const two = cycleLabel(one, 'a');
    assert.equal(two.get('a'), '-');
    assert.equal(cycleLabel(two, 'a').has('a'), false);
  });
  it('сохранение: круг и повреждённые значения', () => {
    const x = f(['a', '+'], ['b c', '-']);
    assert.deepEqual([...parseLabelFilter(serializeLabelFilter(x))], [...x]);
    for (const bad of ['{', '[1]', '[["a","x"]]', '[["","+"]]', '{"a":"+"}', '[["a","+"],1]']) assert.equal(parseLabelFilter(bad).size, 0);
    assert.equal(parseLabelFilter(null).size, 0);
  });
  it('availableLabels: одноимённые метки в одну запись, сохранённая без задач остаётся, регистр различается', () => {
    const tasks = [
      task(1, { labels: [{ name: 'bug', color: null }, { name: 'Bug', color: '#111111' }] }),
      task(2, { labels: [{ name: 'bug', color: '#ff0000' }] }),
    ];
    const m = availableLabels(tasks, f(['gone', '+']));
    assert.deepEqual([...m.keys()].sort(), ['Bug', 'bug', 'gone']);
    assert.equal(m.get('bug'), '#ff0000');
    assert.equal(m.get('gone'), null);
  });
  it('labelEmpty: только при непустой выборке и пустом результате', () => {
    assert.equal(labelEmpty([t], f(['c', '+'])), true);
    assert.equal(labelEmpty([], f(['c', '+'])), false);
    assert.equal(labelEmpty([t], f(['a', '+'])), false);
    assert.equal(labelEmpty([t], f()), false);
  });
});

describe('labelInk', () => {
  it('чёрный на светлом, белый на тёмном, null на неверном', () => {
    assert.equal(labelInk('#ffffff'), '#000000');
    assert.equal(labelInk('#000000'), '#ffffff');
    assert.equal(labelInk('#1d1d80'), '#ffffff');
    assert.equal(labelInk('#fbca04'), '#000000');
    assert.equal(labelInk(null), null);
    assert.equal(labelInk('red'), null);
  });
});

describe('детали задачи', () => {
  it('detailsLines: автор, исполнители, даты', () => {
    const lines = detailsLines(task(1, { author: 'u', assignees: ['a', 'b'], createdAt: 'мусор' }));
    assert.equal(lines[0], 'Автор: u');
    assert.equal(lines[1], 'Исполнители: a, b');
    assert.equal(lines[2], 'Создана: —');
    assert.ok(lines[3].startsWith('Обновлена: '));
  });
  it('нет исполнителей - «не назначены»', () => assert.equal(detailsLines(task(1))[1], 'Исполнители: не назначены'));
  it('пустое описание', () => {
    for (const v of ['', '  \n', null, undefined]) assert.equal(descriptionText(v), 'Описания нет');
    assert.equal(descriptionText('<b>x</b>'), '<b>x</b>');
  });
});

describe('DescriptionStore', () => {
  it('готовое переживает повторное раскрытие, сброс стирает, поздний ответ прежнего поколения отбрасывается', () => {
    const s = new DescriptionStore();
    const g = s.begin('k')!;
    assert.equal(s.begin('k'), null);
    assert.deepEqual(s.get('k'), { state: 'loading' });
    assert.ok(s.finish('k', g, { description: 'd' }));
    assert.equal(s.begin('k'), null);
    s.reset();
    assert.equal(s.get('k'), undefined);
    const old = s.begin('k')!;
    s.reset();
    assert.equal(s.finish('k', old, { description: 'late' }), false);
    assert.equal(s.get('k'), undefined);
  });
  it('отказ не кэшируется: после повторного раскрытия новый запрос', () => {
    const s = new DescriptionStore();
    const g = s.begin('k')!;
    s.finish('k', g, { error: 'boom' });
    assert.deepEqual(s.get('k'), { state: 'error', message: 'boom' });
    assert.equal(s.begin('k'), null);
    s.forgetError('k');
    assert.notEqual(s.begin('k'), null);
  });
});
