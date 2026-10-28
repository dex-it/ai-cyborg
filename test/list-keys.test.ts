import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { asMenuItem, bindList, listTarget, rove } from '../src/renderer/list-keys';

class FakeItem {
  tabIndex = 0;
  attrs: Record<string, string> = {};
  clicks = 0;
  focused = 0;
  constructor(readonly tagName = 'DIV', readonly isItem = true) {}
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  click() {
    this.clicks++;
  }
  focus() {
    this.focused++;
  }
  closest() {
    return this.isItem ? this : null;
  }
}

class FakeList {
  items: FakeItem[] = [];
  handler: ((e: any) => void) | null = null;
  addEventListener(type: string, fn: (e: any) => void) {
    if (type === 'keydown') this.handler = fn;
  }
  querySelectorAll() {
    return this.items;
  }
  press(target: unknown, key: string, init: Record<string, boolean> = {}) {
    const ev = { target, key, prevented: false, preventDefault() { this.prevented = true; }, ...init };
    this.handler!(ev);
    return ev;
  }
}

function list(n: number) {
  const l = new FakeList();
  l.items = Array.from({ length: n }, () => asMenuItem(new FakeItem() as unknown as HTMLElement) as unknown as FakeItem);
  bindList(l as unknown as HTMLElement, '.menu-item');
  return l;
}

describe('listTarget', () => {
  it('стрелки по кругу, из поля ввода (-1) вниз - на первый, вверх - на последний, Home и End - на края', () => {
    assert.equal(listTarget('ArrowDown', 2, 3), 0);
    assert.equal(listTarget('ArrowUp', 0, 3), 2);
    assert.equal(listTarget('ArrowDown', -1, 3), 0);
    assert.equal(listTarget('ArrowUp', -1, 3), 2);
    assert.equal(listTarget('Home', 2, 3), 0);
    assert.equal(listTarget('End', 0, 3), 2);
    assert.equal(listTarget('ArrowLeft', 0, 3), null);
    assert.equal(listTarget('ArrowDown', 0, 0), null);
  });
});

describe('asMenuItem и rove', () => {
  it('пункт получает роль и выходит из порядка табуляции; rove оставляет в нём один', () => {
    const item = new FakeItem();
    asMenuItem(item as unknown as HTMLElement, 'option');
    assert.equal(item.attrs.role, 'option');
    assert.equal(item.tabIndex, -1);
    const l = new FakeList();
    l.items = [new FakeItem(), new FakeItem(), new FakeItem()];
    rove(l as unknown as HTMLElement, '.x');
    assert.deepEqual(l.items.map((i) => i.tabIndex), [0, -1, -1]);
    rove(l as unknown as HTMLElement, '.x', l.items[2] as unknown as HTMLElement);
    assert.deepEqual(l.items.map((i) => i.tabIndex), [-1, -1, 0]);
  });
});

describe('bindList', () => {
  it('стрелка вниз с пункта переводит фокус дальше и делает его единственным в порядке табуляции', () => {
    const l = list(3);
    const ev = l.press(l.items[0], 'ArrowDown');
    assert.ok(ev.prevented);
    assert.equal(l.items[1].focused, 1);
    assert.deepEqual(l.items.map((i) => i.tabIndex), [-1, 0, -1]);
    l.press(l.items[0], 'ArrowUp');
    assert.equal(l.items[2].focused, 1, 'вверх с первого - на последний');
  });

  it('из поля поиска ArrowDown уходит на первый пункт, остальные клавиши поле получает как обычно', () => {
    const l = list(2);
    const input = new FakeItem('INPUT', false);
    assert.ok(l.press(input, 'ArrowDown').prevented);
    assert.equal(l.items[0].focused, 1);
    assert.ok(!l.press(input, 'a').prevented);
    assert.ok(!l.press(input, 'ArrowUp').prevented, 'вверх из поля пункты не берут: курсор остаётся в поле');
    assert.ok(!l.press(input, 'Enter').prevented);
  });

  it('Enter и пробел нажимают пункт', () => {
    const l = list(2);
    assert.ok(l.press(l.items[1], 'Enter').prevented);
    l.press(l.items[1], ' ');
    assert.equal(l.items[1].clicks, 2);
    assert.equal(l.items[0].clicks, 0);
  });

  it('вложенный элемент пункта (кнопка удаления) и сочетания с модификаторами не перехватываются', () => {
    const l = list(2);
    const inner = Object.assign(new FakeItem('BUTTON', false), { closest: () => l.items[0] });
    assert.ok(!l.press(inner, 'ArrowDown').prevented);
    assert.ok(!l.press(inner, 'Enter').prevented);
    assert.equal(l.items[0].clicks, 0);
    assert.ok(!l.press(l.items[0], 'ArrowDown', { ctrlKey: true }).prevented);
  });
});
