import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clickSelection, sessionsCount } from '../src/renderer/selection';

const ids = ['a', 'b', 'c', 'd', 'e'];
const sorted = (s: Set<string>): string[] => [...s].sort();

describe('clickSelection', () => {
  it('toggle добавляет невыделенный пункт и снимает выделенный', () => {
    assert.deepEqual(sorted(clickSelection(ids, new Set(['a']), 'a', 'c', 'toggle')), ['a', 'c']);
    assert.deepEqual(sorted(clickSelection(ids, new Set(['a', 'c']), 'a', 'c', 'toggle')), ['a']);
  });

  it('range выделяет пункты между опорным и щёлкнутым в любую сторону', () => {
    assert.deepEqual(sorted(clickSelection(ids, new Set(['b']), 'b', 'd', 'range')), ['b', 'c', 'd']);
    assert.deepEqual(sorted(clickSelection(ids, new Set(['d']), 'd', 'a', 'range')), ['a', 'b', 'c', 'd']);
  });

  it('range без опорного или с исчезнувшим опорным переключает один пункт', () => {
    assert.deepEqual(sorted(clickSelection(ids, new Set(), null, 'c', 'range')), ['c']);
    assert.deepEqual(sorted(clickSelection(ids, new Set(), 'x', 'c', 'range')), ['c']);
  });

  it('пункт не из списка выделение не меняет', () => {
    assert.deepEqual(sorted(clickSelection(ids, new Set(['a']), 'a', 'x', 'toggle')), ['a']);
  });
});

describe('sessionsCount', () => {
  it('склоняет «сессия» по числу', () => {
    assert.deepEqual([1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111].map(sessionsCount), [
      '1 сессию', '2 сессии', '4 сессии', '5 сессий', '11 сессий', '12 сессий', '14 сессий', '21 сессию', '22 сессии', '25 сессий', '101 сессию', '111 сессий',
    ]);
  });
});
