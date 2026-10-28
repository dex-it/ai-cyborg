import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bindTablist, markTab, selectTab, tabTarget } from '../src/renderer/tabs';

class FakeTab {
  className = '';
  hidden = false;
  tabIndex = 0;
  attrs: Record<string, string> = {};
  clicks = 0;
  focused = 0;
  constructor(readonly tagName = 'DIV') {}
  classList = {
    toggle: (c: string, on: boolean) => {
      const has = this.className.split(' ').includes(c);
      if (on && !has) this.className = `${this.className} ${c}`.trim();
      if (!on && has) this.className = this.className.split(' ').filter((x) => x !== c).join(' ');
    },
  };
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
    return this.attrs.role === 'tab' ? this : null;
  }
}

class FakeList {
  attrs: Record<string, string> = {};
  tabs: FakeTab[] = [];
  handler: ((e: any) => void) | null = null;
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  addEventListener(type: string, fn: (e: any) => void) {
    if (type === 'keydown') this.handler = fn;
  }
  contains(t: unknown) {
    return this.tabs.includes(t as FakeTab);
  }
  querySelectorAll() {
    return this.tabs.filter((t) => t.attrs.role === 'tab');
  }
  press(target: FakeTab, key: string, init: Record<string, boolean> = {}) {
    const ev = { target, key, prevented: false, preventDefault() { this.prevented = true; }, ...init };
    this.handler!(ev);
    return ev;
  }
}

const tab = (tag = 'DIV') => markTab(new FakeTab(tag) as unknown as HTMLElement) as unknown as FakeTab;
function list(n: number, tag = 'DIV') {
  const l = new FakeList();
  l.tabs = Array.from({ length: n }, () => tab(tag));
  bindTablist(l as unknown as HTMLElement, 'Сессии');
  return l;
}

describe('tabTarget', () => {
  it('стрелки идут по кругу, Home и End - на края, прочие клавиши - не для вкладок', () => {
    assert.equal(tabTarget('ArrowRight', 2, 3), 0);
    assert.equal(tabTarget('ArrowLeft', 0, 3), 2);
    assert.equal(tabTarget('ArrowDown', 0, 3), 1);
    assert.equal(tabTarget('ArrowUp', 1, 3), 0);
    assert.equal(tabTarget('Home', 2, 3), 0);
    assert.equal(tabTarget('End', 0, 3), 2);
    assert.equal(tabTarget('a', 0, 3), null);
    assert.equal(tabTarget('ArrowRight', 0, 0), null);
  });
});

describe('selectTab и markTab', () => {
  it('невыбранная вкладка вне порядка табуляции, выбранная - единственная в нём; aria-selected объявляет выбор', () => {
    const t = tab();
    assert.equal(t.attrs.role, 'tab');
    assert.equal(t.attrs['aria-selected'], 'false');
    assert.equal(t.tabIndex, -1);
    selectTab(t as unknown as HTMLElement, true);
    assert.equal(t.tabIndex, 0);
    assert.equal(t.attrs['aria-selected'], 'true');
    assert.ok(t.className.includes('active'));
    selectTab(t as unknown as HTMLElement, false);
    assert.equal(t.tabIndex, -1);
    assert.ok(!t.className.includes('active'));
  });
});

describe('bindTablist', () => {
  it('список объявлен tablist с подписью', () => {
    const l = list(1);
    assert.equal(l.attrs.role, 'tablist');
    assert.equal(l.attrs['aria-label'], 'Сессии');
  });

  it('стрелки переводят фокус на соседнюю вкладку и не нажимают её', () => {
    const l = list(3);
    const ev = l.press(l.tabs[0], 'ArrowRight');
    assert.equal(l.tabs[1].focused, 1);
    assert.equal(l.tabs[1].clicks, 0);
    assert.ok(ev.prevented);
    l.press(l.tabs[0], 'ArrowLeft');
    assert.equal(l.tabs[2].focused, 1, 'с первой влево - на последнюю');
  });

  it('скрытые вкладки (сессии другого проекта) пропускаются', () => {
    const l = list(3);
    l.tabs[1].hidden = true;
    l.press(l.tabs[0], 'ArrowRight');
    assert.equal(l.tabs[1].focused, 0);
    assert.equal(l.tabs[2].focused, 1);
  });

  it('Enter и пробел нажимают вкладку-не-кнопку; у кнопки это делает браузер, у вложенной кнопки закрытия - тоже', () => {
    const l = list(2);
    assert.ok(l.press(l.tabs[0], 'Enter').prevented);
    l.press(l.tabs[0], ' ');
    assert.equal(l.tabs[0].clicks, 2);
    const buttons = list(1, 'BUTTON');
    buttons.press(buttons.tabs[0], 'Enter');
    assert.equal(buttons.tabs[0].clicks, 0, 'Enter на button даёт click сам, повтор был бы двойным нажатием');
    const inner = { ...new FakeTab('BUTTON'), closest: () => l.tabs[0] };
    l.press(inner as unknown as FakeTab, 'Enter');
    assert.equal(l.tabs[0].clicks, 2, 'Enter на кнопке внутри вкладки вкладку не нажимает');
  });

  it('клавиши с Ctrl, Alt и Cmd не перехватываются', () => {
    const l = list(2);
    const ev = l.press(l.tabs[0], 'ArrowRight', { ctrlKey: true });
    assert.ok(!ev.prevented);
    assert.equal(l.tabs[1].focused, 0);
  });
});
