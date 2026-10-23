import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
  it('cancel отбрасывает ответ в полёте', () => {
    const g = new RefreshGate();
    const t = g.begin(false)!;
    g.cancel();
    assert.equal(g.finish(t), false);
    assert.equal(g.loading, false);
  });
});
