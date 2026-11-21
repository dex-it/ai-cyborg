import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { restartPlan } from '../src/renderer/restart-plan';
import { resumeSession, type ResumeDeps } from '../src/main/session-resume';
import type { Project } from '../src/main/projects';

const project = { id: 'p', name: 'P', description: '', repos: ['/a', '/b'], trackers: {} } as unknown as Project;
const SID = '11111111-2222-4333-8444-555555555555';

const rig = (owners: Record<number, string> = { 7: 'p', 8: 'other' }) => {
  const calls: unknown[][] = [];
  const order: string[] = [];
  const deps: ResumeDeps = {
    envReady: async () => void order.push('ready'),
    projects: () => ({ projects: [project], lastProjectId: null }),
    historyExists: () => true,
    isSessionId: (id): id is string => id === SID,
    projectOf: (n) => owners[n] ?? null,
    create: (...args) => (order.push('create'), calls.push(args), 41),
  };
  return { deps, calls, order };
};

describe('session:resume: продолжение разговора, в том числе перезапуск дочерней вкладки', () => {
  it('живая открывшая того же проекта доходит до create последним аргументом, окружение ждётся до запуска', async () => {
    const { deps, calls, order } = rig();
    assert.equal(await resumeSession(deps, 'p', '/a', ['/b'], SID, 7), 41);
    assert.deepEqual(calls, [['p', '/a', ['/b'], undefined, SID, 7]]);
    assert.deepEqual(order, ['ready', 'create']);
  });

  it('чужая, закрытая и не число открывшая отбрасываются: вкладка встаёт без родителя', async () => {
    for (const parent of [8, 99, '7', undefined, null]) {
      const { deps, calls } = rig();
      await resumeSession(deps, 'p', '/a', [], SID, parent);
      assert.equal(calls[0][5], undefined, String(parent));
    }
  });

  it('чужой каталог, неверный номер разговора и пустой журнал - отказ без запуска', async () => {
    const a = rig();
    await assert.rejects(resumeSession(a.deps, 'p', '/zzz', [], SID), /Некорректное продолжение/);
    await assert.rejects(resumeSession(a.deps, 'p', '/a', [], 'bad'), /Некорректное продолжение/);
    const b = rig();
    await assert.rejects(resumeSession({ ...b.deps, historyExists: () => false }, 'p', '/a', [], SID), /Журнал сессии не найден/);
    assert.deepEqual([...a.calls, ...b.calls], []);
  });
});

describe('перезапуск вкладки в окне: план по ответу главного процесса', () => {
  const tabs = new Map([[7, { id: 7 }]]);
  const find = (id: number) => tabs.get(id);

  it('локальная дочерняя: продолжение разговора под той же открывшей', () => {
    assert.deepEqual(restartPlan({ resume: SID, parent: 7 }, find), { kind: 'local', resume: SID, opener: { id: 7 } });
  });

  it('открывшая закрыта в окне или не названа: без родителя; без разговора - ничего', () => {
    assert.deepEqual(restartPlan({ resume: SID, parent: 5 }, find), { kind: 'local', resume: SID, opener: undefined });
    assert.deepEqual(restartPlan({ resume: SID }, find), { kind: 'local', resume: SID, opener: undefined });
    assert.deepEqual(restartPlan({}, find), { kind: 'none' });
  });

  it('удалённая: описание вкладки уходит как есть', () => {
    assert.deepEqual(restartPlan({ remote: { dirs: ['/h'] } }, find), { kind: 'remote', info: { dirs: ['/h'] } });
  });
});
