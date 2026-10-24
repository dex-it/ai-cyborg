import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTaskHandlers, TaskDetailsService, validateTaskDetailsArgs } from '../src/main/task-details';
import { taskKey, taskUrl, type CliResult, type Task, type TaskRef, type TasksResult } from '../src/main/trackers';

const ok = (stdout: string, stderr = ''): CliResult => ({ code: 0, stdout, stderr, missing: false });
const gh: TaskRef = { kind: 'github', host: 'github.com', path: 'o/r', number: 5 };
const gl: TaskRef = { kind: 'gitlab', host: 'git.corp', path: 'g/sub/p', number: 7 };
const asTask = (ref: TaskRef): Task => ({ ...ref, key: taskKey(ref), title: '', state: 'open', workflow: [], labels: [], author: '', assignees: [], url: '', createdAt: '', updatedAt: '', repos: [] });
const result = (...refs: TaskRef[]): TasksResult => ({ tasks: refs.map(asTask), sources: [], tracked: [], enabled: { github: true, gitlab: true } });

function make(respond: (cmd: string, args: string[]) => CliResult) {
  const calls: { cmd: string; args: string[] }[] = [];
  const svc = new TaskDetailsService(async (cmd, args) => {
    calls.push({ cmd, args });
    return respond(cmd, args);
  });
  return { svc, calls };
}

describe('validateTaskDetailsArgs', () => {
  it('принимает целый номер выборки и проверенную ссылку', () => {
    assert.deepEqual(validateTaskDetailsArgs(1, gh), { selection: 1, ref: gh });
  });
  it('отклоняет неверные типы', () => {
    for (const sel of ['1', 0, 1.5, -1, NaN, null]) assert.equal(validateTaskDetailsArgs(sel, gh), null);
    assert.equal(validateTaskDetailsArgs(1, { ...gh, host: 'evil.com' }), null);
    assert.equal(validateTaskDetailsArgs(1, null), null);
  });
});

describe('TaskDetailsService', () => {
  it('remember выдаёт растущий номер и держит не больше 8 выборок', async () => {
    const { svc } = make(() => ok('{"body":"x"}'));
    const first = svc.remember(result(gh)).selection!;
    assert.equal(svc.remember(result(gh)).selection, first + 1);
    for (let i = 0; i < 8; i++) svc.remember(result());
    assert.deepEqual(await svc.details(first, gh), { error: 'задача не из текущей выборки: нажмите «Обновить»' });
  });
  it('GitHub: gh api с --jq {body} и путём issues/N, только чтение', async () => {
    const { svc, calls } = make(() => ok('{"body":"текст"}\n'));
    const { selection } = svc.remember(result(gh, gl));
    assert.deepEqual(await svc.details(selection!, gh), { description: 'текст' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'gh');
    assert.deepEqual(calls[0].args, ['api', '--hostname', 'github.com', '--jq', '{body}', 'repos/o/r/issues/5']);
    assert.ok(!calls[0].args.some((a) => /^(-X|--method|-f|-F|--input|--field|--raw-field)$/.test(a)));
  });
  it('GitHub: body null - пустое описание', async () => {
    const { svc } = make(() => ok('{"body":null}'));
    const { selection } = svc.remember(result(gh));
    assert.deepEqual(await svc.details(selection!, gh), { description: '' });
  });
  it('GitLab: glab api на хосте выборки, единственный вызов - issues/N', async () => {
    const { svc, calls } = make(() => ok('{"iid":7,"description":"d"}'));
    const { selection } = svc.remember(result(gl));
    assert.deepEqual(await svc.details(selection!, gl), { description: 'd' });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { cmd: 'glab', args: ['api', '--hostname', 'git.corp', 'projects/g%2Fsub%2Fp/issues/7'] });
  });
  it('ссылка не из выборки: CLI не запускается', async () => {
    const { svc, calls } = make(() => ok('{}'));
    const { selection } = svc.remember(result(gh));
    const res = await svc.details(selection!, { ...gl, host: 'evil.example' });
    assert.ok('error' in res);
    assert.equal(calls.length, 0);
    assert.ok('error' in (await svc.details(selection! + 1, gh)));
    assert.equal(calls.length, 0);
  });
  it('отказ CLI - текст как у interpret', async () => {
    const { svc } = make(() => ({ code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)\n', missing: false }));
    const { selection } = svc.remember(result(gh));
    assert.deepEqual(await svc.details(selection!, gh), { error: 'gh: Not Found (HTTP 404)' });
  });
  it('GitLab: {message} без iid - отказ; HTTP 410 - ошибка, не пометка', async () => {
    const a = make(() => ok('{"message":"404 Not found"}'));
    const s1 = a.svc.remember(result(gl)).selection!;
    assert.deepEqual(await a.svc.details(s1, gl), { error: '404 Not found' });
    const b = make(() => ({ code: 0, stdout: '', stderr: 'HTTP 410', missing: false }));
    const s2 = b.svc.remember(result(gl)).selection!;
    assert.deepEqual(await b.svc.details(s2, gl), { error: 'HTTP 410' });
  });
});

describe('createTaskHandlers', () => {
  const deps = () => {
    const opened: string[] = [];
    const listed: unknown[][] = [];
    const svc = new TaskDetailsService(async () => ok('{"body":"b"}'));
    const handlers = createTaskHandlers(
      { list: async (...a) => { listed.push(a); return result(gh); } },
      svc,
      async (url) => { opened.push(url); },
    );
    return { handlers, opened, listed };
  };
  it('tasks:list отдаёт результат с номером выборки, по которому details находит задачу', async () => {
    const { handlers } = deps();
    const res = await handlers.list('p', true, [], false);
    assert.equal(typeof res.selection, 'number');
    assert.deepEqual(await handlers.details(res.selection, gh), { description: 'b' });
    assert.ok('error' in (await handlers.details(res.selection, gl)));
  });
  it('tasks:list и tasks:details отклоняют неверные аргументы до запроса', async () => {
    const { handlers, listed } = deps();
    assert.throws(() => handlers.list(1, true, [], false), /tasks:list/);
    assert.equal(listed.length, 0);
    assert.throws(() => handlers.details('1', gh), /tasks:details/);
  });
  it('tasks:open строит адрес из проверенной ссылки и отклоняет чужой хост', async () => {
    const { handlers, opened } = deps();
    assert.deepEqual(await handlers.open(gh), {});
    assert.equal(opened[0], taskUrl(gh));
    await assert.rejects(async () => handlers.open({ ...gh, host: 'evil.com' }), /tasks:open/);
    assert.equal(opened.length, 1);
  });
  it('tasks:open: отказ браузера возвращается текстом', async () => {
    const h = createTaskHandlers({ list: async () => result() }, new TaskDetailsService(async () => ok('')), async () => { throw new Error('нет браузера\nстек'); });
    assert.deepEqual(await h.open(gh), { error: 'нет браузера' });
  });
});
