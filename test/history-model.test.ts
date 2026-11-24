import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { historyMatch, historyOrder } from '../src/renderer/history-model';

describe('вкладка «Сессии»: избранное и отбор', () => {
  it('historyOrder: избранные первыми, внутри групп свежие первыми', () => {
    const list = [{ id: 'a', updated: 1 }, { id: 'b', updated: 2, favorite: true }, { id: 'c', updated: 5 }, { id: 'd', updated: 9, favorite: true }];
    assert.deepEqual(historyOrder(list).map((e) => e.id), ['d', 'b', 'c', 'a']);
  });

  it('historyMatch: слова запроса в любом порядке и регистре по заголовку, репозиторию и хосту', () => {
    const entry = { title: 'Починить Дерево файлов', repo: '/w/Cyborg', host: 'dev-1' };
    assert.equal(historyMatch(entry, ''), true);
    assert.equal(historyMatch(entry, '   '), true);
    assert.equal(historyMatch(entry, 'дерево починить'), true);
    assert.equal(historyMatch(entry, 'cyborg'), true);
    assert.equal(historyMatch(entry, 'DEV-1 файлов'), true);
    assert.equal(historyMatch(entry, 'w'), false, 'каталог над репозиторием не ищется');
    assert.equal(historyMatch(entry, 'дерево mr'), false);
    assert.equal(historyMatch({ title: 'x', repo: '/r' }, 'dev'), false);
  });
});
