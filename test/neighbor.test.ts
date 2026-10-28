import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { neighborAfterClose } from '../src/renderer/neighbor';

describe('neighborAfterClose', () => {
  it('закрытая вкладка из середины: выбирается сосед справа', () => {
    assert.equal(neighborAfterClose(['a', 'b', 'c', 'd'], 'b'), 'c');
  });

  it('закрыта первая: следующая, а не «первая в списке» из-за совпадения', () => {
    assert.equal(neighborAfterClose(['a', 'b', 'c'], 'a'), 'b');
  });

  it('закрыта последняя: сосед слева, а не первая вкладка', () => {
    assert.equal(neighborAfterClose(['a', 'b', 'c', 'd'], 'd'), 'c');
  });

  it('закрыта единственная: выбирать нечего', () => {
    assert.equal(neighborAfterClose(['a'], 'a'), undefined);
    assert.equal(neighborAfterClose([], 'a'), undefined);
  });

  it('закрытого нет в списке: первый элемент (запасной путь)', () => {
    assert.equal(neighborAfterClose(['a', 'b'], 'z'), 'a');
  });
});
