import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Task, TasksResult, TrackersStatus } from '../src/main/trackers';
import { authLines, emptyView, findTask, sessionLabel, sortTasks, sourceLabel, statusText, taskTooltip } from '../src/renderer/task-model';

const task = (n: number, over: Partial<Task> = {}): Task => ({
  kind: 'github', host: 'github.com', path: 'o/r', number: n, key: `github:github.com/o/r#${n}`, title: `T${n}`, state: 'open',
  workflow: [], url: `https://github.com/o/r/issues/${n}`, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', repos: ['/a'], ...over,
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
