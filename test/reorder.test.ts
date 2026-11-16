import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { childSlot, moveItem } from '../src/renderer/reorder';

describe('moveItem', () => {
  it('вниз и вверх: элемент встаёт на место цели, остальные сдвигаются', () => {
    assert.deepEqual(moveItem(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a']);
    assert.deepEqual(moveItem(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b']);
    assert.deepEqual(moveItem(['a', 'b'], 0, 1), ['b', 'a']);
  });

  it('на себя и за границы - тот же порядок, исходный список не меняется', () => {
    const list = ['a', 'b'];
    assert.deepEqual(moveItem(list, 1, 1), ['a', 'b']);
    assert.deepEqual(moveItem(list, -1, 0), ['a', 'b']);
    assert.deepEqual(moveItem(list, 0, 2), ['a', 'b']);
    assert.deepEqual(list, ['a', 'b']);
  });
});

describe('childSlot', () => {
  const tree: Record<string, string | undefined> = { p: undefined, c1: 'p', g1: 'c1', c2: 'p', x: undefined };
  const under = (ancestor: string) => (item: string): boolean => {
    for (let up = tree[item]; up; up = tree[up]) if (up === ancestor) return true;
    return false;
  };

  it('первый ребёнок встаёт сразу справа от родителя, а не в конец', () => {
    assert.equal(childSlot(['p', 'x', 'y'], 'p', under('p')), 1);
  });

  it('следующий ребёнок - за уже открытыми детьми и их потомками, но перед чужой вкладкой', () => {
    assert.equal(childSlot(['p', 'c1', 'g1', 'c2', 'x'], 'p', under('p')), 4);
  });

  it('родителя в списке нет - в конец', () => {
    assert.equal(childSlot(['x', 'y'], 'p', under('p')), 2);
  });
});
