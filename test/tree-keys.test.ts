import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parentIndex, parentKey, restoreIndex, rowKey, tabStopIndex, treeKeyAction, type KeyRow } from '../src/renderer/tree-keys';

// Плоский список видимых строк: корень r (раскрыт) -> a (раскрыт) -> c (раскрыт, пуст), x.txt; b (свёрнут); f.txt; корень o (свёрнут).
const dir = (level: number, expanded: boolean): KeyRow => ({ level, expandable: true, expanded });
const file = (level: number): KeyRow => ({ level, expandable: false, expanded: false });
const rows: KeyRow[] = [
  dir(1, true), //  0 r
  dir(2, true), //  1 a
  dir(3, true), //  2 a/c, пустой
  file(3), //       3 a/x.txt
  dir(2, false), // 4 b
  file(2), //       5 f.txt
  dir(1, false), // 6 o
];

const act = (key: string, index: number) => treeKeyAction(key, rows, index);

describe('treeKeyAction: ArrowDown/ArrowUp/Home/End', () => {
  it('стрелки идут на соседнюю видимую строку, включая смену корня', () => {
    assert.deepEqual(act('ArrowDown', 0), { kind: 'focus', index: 1 });
    assert.deepEqual(act('ArrowDown', 5), { kind: 'focus', index: 6 });
    assert.deepEqual(act('ArrowUp', 6), { kind: 'focus', index: 5 });
    assert.deepEqual(act('ArrowUp', 3), { kind: 'focus', index: 2 });
  });

  it('без круга: на краях ничего не происходит, но клавиша перехвачена', () => {
    assert.deepEqual(act('ArrowUp', 0), { kind: 'none' });
    assert.deepEqual(act('ArrowDown', 6), { kind: 'none' });
  });

  it('Home и End - первая и последняя строка; на ней самой ничего', () => {
    assert.deepEqual(act('Home', 3), { kind: 'focus', index: 0 });
    assert.deepEqual(act('End', 3), { kind: 'focus', index: 6 });
    assert.deepEqual(act('Home', 0), { kind: 'none' });
    assert.deepEqual(act('End', 6), { kind: 'none' });
  });
});

describe('treeKeyAction: ArrowRight/ArrowLeft', () => {
  it('ArrowRight на свёрнутом каталоге и корне раскрывает (клик)', () => {
    assert.deepEqual(act('ArrowRight', 4), { kind: 'click', index: 4 });
    assert.deepEqual(act('ArrowRight', 6), { kind: 'click', index: 6 });
  });

  it('ArrowRight на раскрытом переходит к первому потомку', () => {
    assert.deepEqual(act('ArrowRight', 0), { kind: 'focus', index: 1 });
    assert.deepEqual(act('ArrowRight', 1), { kind: 'focus', index: 2 });
  });

  it('ArrowRight на раскрытом пустом каталоге и на файле ничего не делает (следующая строка не потомок)', () => {
    assert.deepEqual(act('ArrowRight', 2), { kind: 'none' });
    assert.deepEqual(act('ArrowRight', 3), { kind: 'none' });
    assert.deepEqual(treeKeyAction('ArrowRight', [dir(1, true)], 0), { kind: 'none' });
  });

  it('ArrowLeft на раскрытом сворачивает (клик)', () => {
    assert.deepEqual(act('ArrowLeft', 1), { kind: 'click', index: 1 });
    assert.deepEqual(act('ArrowLeft', 0), { kind: 'click', index: 0 });
  });

  it('ArrowLeft на файле и свёрнутом каталоге переходит к родителю; у свёрнутого корня ничего', () => {
    assert.deepEqual(act('ArrowLeft', 3), { kind: 'focus', index: 1 });
    assert.deepEqual(act('ArrowLeft', 5), { kind: 'focus', index: 0 });
    assert.deepEqual(act('ArrowLeft', 4), { kind: 'focus', index: 0 });
    assert.deepEqual(act('ArrowLeft', 6), { kind: 'none' });
  });

  it('ArrowLeft на раскрытом пустом каталоге сворачивает, а не уходит к родителю', () => {
    assert.deepEqual(act('ArrowLeft', 2), { kind: 'click', index: 2 });
  });
});

describe('treeKeyAction: Enter, пробел и прочие клавиши', () => {
  it('Enter и пробел - то же, что клик, на любой строке', () => {
    for (const index of [0, 3, 4, 6]) {
      assert.deepEqual(act('Enter', index), { kind: 'click', index });
      assert.deepEqual(act(' ', index), { kind: 'click', index });
    }
  });

  it('другие клавиши и неизвестная строка - null (не перехватываются)', () => {
    for (const key of ['a', 'Tab', 'Escape', 'PageDown', 'Shift', 'F2']) assert.equal(act(key, 1), null, key);
    assert.equal(act('ArrowDown', -1), null);
    assert.equal(act('ArrowDown', 99), null);
    assert.equal(treeKeyAction('Enter', [], 0), null);
  });
});

describe('parentIndex', () => {
  it('ближайшая выше строка с меньшей глубиной', () => {
    assert.equal(parentIndex(rows, 3), 1);
    assert.equal(parentIndex(rows, 5), 0);
    assert.equal(parentIndex(rows, 4), 0);
    assert.equal(parentIndex(rows, 1), 0);
  });

  it('у корня родителя нет, и второй корень не принимает строки первого за родителя', () => {
    assert.equal(parentIndex(rows, 0), -1);
    assert.equal(parentIndex(rows, 6), -1);
  });
});

describe('ключи строк и возврат фокуса после перерисовки', () => {
  it('parentKey: каталог -> каталог выше -> корень -> null', () => {
    assert.equal(parentKey(rowKey('/r', 'a/c')), rowKey('/r', 'a'));
    assert.equal(parentKey(rowKey('/r', 'a')), rowKey('/r', ''));
    assert.equal(parentKey(rowKey('/r', '')), null);
  });

  it('одноимённые пути разных корней - разные ключи', () => {
    assert.notEqual(rowKey('/r', 'a'), rowKey('/o', 'a'));
  });

  const keys = [rowKey('/r', ''), rowKey('/r', 'a'), rowKey('/r', 'a/x.txt'), rowKey('/r', 'b'), rowKey('/o', ''), rowKey('/o', 'a')];

  it('строка с тем же ключом находится в новом списке', () => {
    assert.equal(restoreIndex(keys, rowKey('/r', 'a/x.txt')), 2);
    assert.equal(restoreIndex(keys, rowKey('/o', 'a')), 5);
  });

  it('строки больше нет: ближайший родитель, затем корень', () => {
    assert.equal(restoreIndex(keys, rowKey('/r', 'a/c/deep.txt')), 1, 'a/c и файл исчезли - остаётся a');
    assert.equal(restoreIndex(keys, rowKey('/r', 'gone/x/y')), 0, 'выше только корень');
  });

  it('нет ни строки, ни родителей, ни ключа: первая; пусто - -1', () => {
    assert.equal(restoreIndex(keys, rowKey('/zzz', 'a')), 0);
    assert.equal(restoreIndex(keys, null), 0);
    assert.equal(restoreIndex([], rowKey('/r', 'a')), -1);
  });

  it('tabStopIndex: выбранная строка, иначе первая, пусто - -1', () => {
    assert.equal(tabStopIndex([false, false, true, false]), 2);
    assert.equal(tabStopIndex([false, false]), 0);
    assert.equal(tabStopIndex([]), -1);
  });
});
