import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MrListResult } from '../src/main/mrs';
import { refreshMrs, type MrRefreshApi } from '../src/renderer/mr-refresh';
import { mrMeta } from '../src/renderer/mr-model';
import { decideStart, RefreshGate, StartGuard, TaskSessionRegistry } from '../src/renderer/task-flow';

type S = { project: { id: string }; task?: { key: string }; mr?: { key: string } };
const sess = (project: string, key: string): S => ({ project: { id: project }, task: { key } });

describe('TaskSessionRegistry: сессии MR', () => {
  it('задача #5 и MR !5 одного репозитория - разные сессии; сессия с mr регистрируется и снимается', () => {
    const reg = new TaskSessionRegistry<S>();
    const task = sess('A', 'github:github.com/o/r#5');
    const mr: S = { project: { id: 'A' }, mr: { key: 'github:github.com/o/r!5' } };
    reg.add(task);
    reg.add(mr);
    assert.equal(reg.get('A', 'github:github.com/o/r#5'), task);
    assert.equal(reg.get('A', 'github:github.com/o/r!5'), mr);
    reg.remove(mr);
    assert.equal(reg.get('A', 'github:github.com/o/r!5'), undefined);
    assert.equal(reg.get('A', 'github:github.com/o/r#5'), task);
  });
  it('повторный клик до появления сессии MR: StartGuard не пускает второй старт; решение по repos MR', () => {
    const guard = new StartGuard();
    assert.equal(guard.begin('A', 'k!1'), true);
    assert.equal(guard.begin('A', 'k!1'), false);
    assert.deepEqual(decideStart(false, ['/a', '/b'], ['/a', '/b']), { action: 'menu', repos: ['/a', '/b'] });
    assert.deepEqual(decideStart(false, ['/gone'], ['/a']), { action: 'none' });
  });
});

describe('TaskSessionRegistry', () => {
  it('общий remote у двух проектов: сессии не смешиваются, закрытие одной не трогает другую', () => {
    const reg = new TaskSessionRegistry<S>();
    const a = sess('A', 'k');
    const b = sess('B', 'k');
    reg.add(a);
    assert.equal(reg.get('B', 'k'), undefined);
    reg.add(b);
    assert.equal(reg.get('A', 'k'), a);
    reg.remove(b);
    assert.equal(reg.get('A', 'k'), a);
    assert.equal(reg.get('B', 'k'), undefined);
  });
  it('remove не стирает запись, указывающую на другую сессию', () => {
    const reg = new TaskSessionRegistry<S>();
    const first = sess('A', 'k');
    const second = sess('A', 'k');
    reg.add(first);
    reg.add(second);
    reg.remove(first);
    assert.equal(reg.get('A', 'k'), second);
  });
  it('сессия без задачи игнорируется', () => {
    const reg = new TaskSessionRegistry<S>();
    reg.add({ project: { id: 'A' } });
    reg.remove({ project: { id: 'A' } });
  });
});

describe('StartGuard', () => {
  it('второй клик до окончания игнорируется, после end - снова можно, другой проект независим', () => {
    const g = new StartGuard();
    assert.equal(g.begin('A', 'k'), true);
    assert.equal(g.begin('A', 'k'), false);
    assert.equal(g.begin('B', 'k'), true);
    g.end('A', 'k');
    assert.equal(g.begin('A', 'k'), true);
  });
});

describe('decideStart', () => {
  it('открытая сессия проекта - переключить, даже если репозитории есть', () => {
    assert.deepEqual(decideStart(true, ['/a'], ['/a']), { action: 'switch' });
  });
  it('один репозиторий - создать, несколько - меню, ни одного из проекта - ничего', () => {
    assert.deepEqual(decideStart(false, ['/a', '/x'], ['/a']), { action: 'create', repo: '/a' });
    assert.deepEqual(decideStart(false, ['/a', '/b'], ['/a', '/b', '/c']), { action: 'menu', repos: ['/a', '/b'] });
    assert.deepEqual(decideStart(false, ['/x'], ['/a']), { action: 'none' });
  });
});

describe('RefreshGate', () => {
  it('без force второй запрос во время загрузки не начинается', () => {
    const g = new RefreshGate();
    const t = g.begin(false);
    assert.notEqual(t, null);
    assert.equal(g.loading, true);
    assert.equal(g.begin(false), null);
  });
  it('force начинает новый запрос, ответ старого отбрасывается и не снимает загрузку', () => {
    const g = new RefreshGate();
    const old = g.begin(false)!;
    const fresh = g.begin(true)!;
    assert.equal(g.finish(old), false);
    assert.equal(g.loading, true);
    assert.equal(g.finish(fresh), true);
    assert.equal(g.loading, false);
  });
  it('isCurrent: токен текущей выборки, пока нет новой и не было cancel', () => {
    const g = new RefreshGate();
    const first = g.begin(false)!;
    assert.equal(g.isCurrent(first), true);
    g.finish(first);
    assert.equal(g.isCurrent(first), true);
    const second = g.begin(false)!;
    assert.equal(g.isCurrent(first), false);
    g.cancel();
    assert.equal(g.isCurrent(second), false);
  });
  it('cancel отбрасывает ответ в полёте', () => {
    const g = new RefreshGate();
    const t = g.begin(false)!;
    g.cancel();
    assert.equal(g.finish(t), false);
    assert.equal(g.loading, false);
  });
});

describe('refreshMrs: двухфазная выборка MR', () => {
  const mr = (n: number) => ({ key: `k${n}`, kind: 'gitlab', number: n, author: 'bob', sourceBranch: 'f', targetBranch: 'm', draft: false, pipeline: null, approvals: null });
  const list = { mrs: [mr(1)], sources: [], tracked: [], enabled: { github: false, gitlab: true }, detailsId: 7, awaiting: ['k1'] } as unknown as MrListResult;
  const args = { projectId: 'p', filter: 'all' as const, tracked: [], recheck: false };
  const harness = (details: Promise<unknown>) => {
    const events: string[] = [];
    const api: MrRefreshApi = { listMrs: async () => list, mrDetails: () => details as never };
    const sink = {
      listed: (r: MrListResult, pending: Set<string>) => events.push(`listed:${[...pending]}:${mrMeta(r.mrs[0], pending.has('k1'))}`),
      detailed: (r: MrListResult) => events.push(`detailed:${mrMeta(r.mrs[0])}`),
    };
    return { events, api, sink };
  };

  it('до деталей строка с «…», после - значения', async () => {
    const gate = new RefreshGate();
    const h = harness(Promise.resolve({ details: [{ key: 'k1', pipeline: 'успешен', approvals: 'апрувов: 1' }], tracked: [] }));
    await refreshMrs(h.api, gate, gate.begin(false)!, args, h.sink);
    assert.deepEqual(h.events, ['listed:k1:bob · f → m · пайплайн: … · апрувов: …', 'detailed:bob · f → m · пайплайн: успешен · апрувов: 1']);
  });

  it('новая выборка во время деталей: детали прежней не применяются', async () => {
    const gate = new RefreshGate();
    let release!: (v: unknown) => void;
    const h = harness(new Promise((r) => (release = r)));
    const first = refreshMrs(h.api, gate, gate.begin(false)!, args, h.sink);
    await new Promise((r) => setImmediate(r));
    assert.equal(gate.loading, false);
    gate.begin(false);
    release({ details: [], tracked: [] });
    await first;
    assert.equal(h.events.length, 1);
    assert.ok(h.events[0].startsWith('listed:'));
  });

  it('смена проекта до списка: ни списка, ни деталей; отказ деталей - «—» у ожидавших', async () => {
    const gate = new RefreshGate();
    const h = harness(Promise.resolve(null));
    const token = gate.begin(false)!;
    gate.cancel();
    await refreshMrs(h.api, gate, token, args, h.sink);
    assert.deepEqual(h.events, []);
    const g2 = new RefreshGate();
    const rejected = harness(Promise.reject(new Error('x')));
    await refreshMrs(rejected.api, g2, g2.begin(false)!, args, rejected.sink);
    assert.ok(rejected.events[1].includes('пайплайн: — · апрувов: —'));
  });
});
