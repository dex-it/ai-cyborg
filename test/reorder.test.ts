import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { moveItem } from '../src/renderer/reorder';

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
