import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

type Ev = { target: FakeNode; key?: string; stopped: boolean; stopPropagation(): void; preventDefault(): void };

class FakeNode {
  className = '';
  textContent = '';
  title = '';
  hidden = false;
  disabled = false;
  checked = false;
  value = '';
  type = '';
  tabIndex = -1;
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  children: FakeNode[] = [];
  parentElement: FakeNode | null = null;
  private listeners: { type: string; fn: (e: Ev) => void }[] = [];
  constructor(readonly tag = '') {}
  classList = {
    add: (c: string) => { this.className = `${this.className} ${c}`.trim(); },
    remove: (c: string) => { this.className = this.className.split(' ').filter((x) => x !== c).join(' '); },
    toggle: (c: string, on?: boolean) => {
      const has = this.className.split(' ').includes(c);
      if (on ?? !has) { if (!has) this.classList.add(c); } else this.classList.remove(c);
    },
  };
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  append(...nodes: FakeNode[]): void { for (const n of nodes) { n.parentElement = this; this.children.push(n); } }
  replaceChildren(...nodes: FakeNode[]): void { this.children = []; this.append(...nodes); }
  addEventListener(type: string, fn: (e: Ev) => void): void { this.listeners.push({ type, fn }); }
  fire(type: string, init: { key?: string } = {}): Ev {
    const ev: Ev = { target: this, key: init.key, stopped: false, stopPropagation() { this.stopped = true; }, preventDefault() {} };
    for (let n: FakeNode | null = this; n && !ev.stopped; n = n.parentElement) {
      if (n.disabled && type === 'click') break;
      for (const l of n.listeners) if (l.type === type) l.fn(ev);
    }
    return ev;
  }
  click(): void { this.fire('click'); }
  all(): FakeNode[] { return [this, ...this.children.flatMap((c) => c.all())]; }
  text(): string { return this.all().map((n) => n.textContent).join('|'); }
}

(globalThis as any).document = {
  createElement: (tag: string) => new FakeNode(tag),
  createTextNode: (text: string) => Object.assign(new FakeNode('#text'), { textContent: text }),
};

const calls = { list: 0, details: [] as { selection: number; number: number }[], open: [] as unknown[] };
const impl = {
  list: async (): Promise<any> => ({}),
  details: async (): Promise<any> => ({ description: 'текст описания' }),
};
(globalThis as any).window = {
  cyborg: {
    listTasks: () => { calls.list++; return impl.list(); },
    taskDetails: (selection: number, ref: { number: number }) => { calls.details.push({ selection, number: ref.number }); return impl.details(); },
    openTask: async (ref: unknown) => { calls.open.push(ref); return {}; },
  },
};

const mk = (number: number, labels: string[], updatedAt = '2024-01-0' + number) => ({
  kind: 'github', host: 'github.com', path: 'o/r', number, key: `github:github.com:o/r#${number}`,
  title: `Задача ${number}`, state: 'open', workflow: [], labels: labels.map((name) => ({ name, color: '#ff0000' })),
  author: 'ann', assignees: [], url: '', createdAt: updatedAt, updatedAt, repos: [],
});
const result = (selection: number, ...tasks: ReturnType<typeof mk>[]) => ({
  tasks, sources: [], tracked: [], enabled: { github: true, gitlab: false }, selection,
});

async function setup(res = result(1, mk(1, ['bug']), mk(2, ['ui']))) {
  impl.list = async () => res;
  impl.details = async () => ({ description: 'текст описания' });
  calls.list = 0; calls.details = []; calls.open = [];
  const { TasksView } = await import('../src/renderer/tasks');
  const host = {
    project: () => ({ id: 'p' }),
    projectHint: () => null,
    trackedRefs: () => [],
    applyStatuses: () => {},
    sessionOf: () => undefined,
    startTask: () => {},
  };
  const view = new TasksView(host as any);
  await view.refresh(false, 'open');
  const root = view.element as unknown as FakeNode;
  const flush = () => new Promise((r) => setImmediate(r));
  const rowOf = (n: number) => root.all().find((x) => x.className === 'task-row' && x.text().includes(`#${n}`))!;
  const detailsOf = (n: number) => rowOf(n).parentElement!.children.find((c) => c.className === 'task-details');
  const rowChip = (n: number, name: string) => rowOf(n).all().find((x) => x.className.includes('task-label') && x.textContent === name)!;
  const barChips = () => root.all().filter((x) => x.className.includes('task-label') && x.parentElement?.className === 'tasks-labels');
  return { view, root, flush, rowOf, detailsOf, rowChip, barChips, setList: (r: any) => { impl.list = async () => r; } };
}

describe('TasksView: проводка', () => {
  it('клик по метке в строке делает её обязательной и не раскрывает строку', async () => {
    const t = await setup();
    t.rowChip(1, 'bug').click();
    await t.flush();
    assert.equal(t.detailsOf(1), undefined, 'строка не раскрылась');
    assert.equal(calls.details.length, 0);
    assert.ok(!t.root.text().includes('#2'), 'задача без метки отфильтрована');
    assert.ok(t.barChips().some((c) => c.textContent === '+ bug'));
  });

  it('клик по строке раскрывает и сворачивает детали; aria-expanded объявляет состояние', async () => {
    const t = await setup();
    assert.equal(t.rowOf(1).attrs['aria-expanded'], 'false');
    t.rowOf(1).click();
    await t.flush();
    assert.ok(t.detailsOf(1)!.text().includes('текст описания'));
    assert.equal(t.rowOf(1).attrs['aria-expanded'], 'true');
    t.rowOf(1).click();
    assert.equal(t.detailsOf(1), undefined);
    assert.equal(t.rowOf(1).attrs['aria-expanded'], 'false');
  });

  it('с клавиатуры: строка в порядке табуляции, Enter и пробел раскрывают, Enter на вложенной кнопке - нет', async () => {
    const t = await setup();
    const row = t.rowOf(1);
    assert.equal(row.tabIndex, 0);
    assert.equal(row.attrs.role, 'button');
    row.fire('keydown', { key: 'Enter' });
    assert.ok(t.detailsOf(1));
    t.rowOf(1).fire('keydown', { key: ' ' });
    assert.equal(t.detailsOf(1), undefined);
    t.rowOf(1).fire('keydown', { key: 'a' });
    assert.equal(t.detailsOf(1), undefined);
    t.rowOf(1).all().find((x) => x.className === 'task-number')!.fire('keydown', { key: 'Enter' });
    assert.equal(t.detailsOf(1), undefined, 'Enter на кнопке номера строку не переключает');
  });

  it('описание запрашивается с номером выборки из ответа tasks:list и кэшируется до «Обновить»', async () => {
    const t = await setup(result(7, mk(1, ['bug'])));
    t.rowOf(1).click();
    await t.flush();
    assert.deepEqual(calls.details, [{ selection: 7, number: 1 }]);
    t.rowOf(1).click();
    t.rowOf(1).click();
    assert.equal(calls.details.length, 1, 'кэш');
    t.setList(result(8, mk(1, ['bug'])));
    await t.view.refresh(false, 'reload');
    await t.flush();
    assert.deepEqual(calls.details, [{ selection: 7, number: 1 }, { selection: 8, number: 1 }]);
  });

  it('ответ без selection: детали показывают отказ, запрос не уходит', async () => {
    const t = await setup({ ...result(1, mk(1, ['bug'])), selection: undefined } as any);
    t.rowOf(1).click();
    await t.flush();
    assert.equal(calls.details.length, 0);
    assert.ok(t.detailsOf(1)!.text().includes('выборка задач неизвестна'));
  });

  it('раскрытие держится при сортировке, фильтре меток и «Обновить»; смена проекта его сбрасывает', async () => {
    const t = await setup();
    t.rowOf(2).click();
    const sort = t.root.all().find((x) => x.tag === 'select')!;
    sort.value = 'number';
    sort.fire('change');
    assert.ok(t.detailsOf(2), 'после сортировки');
    t.rowChip(2, 'ui').click();
    assert.ok(t.detailsOf(2), 'после фильтра');
    t.root.all().find((x) => x.className.includes('tasks-labels-clear'))!.click();
    await t.view.refresh(false, 'reload');
    assert.ok(t.detailsOf(2), 'после «Обновить»');
    t.view.onProjectChanged();
    await t.view.refresh(true, 'project');
    assert.equal(t.detailsOf(2), undefined, 'после смены проекта');
    calls.details = [];
    t.rowOf(2).click();
    await t.flush();
    assert.equal(calls.details.length, 1, 'кэш описаний сброшен');
  });

  it('пустой результат фильтра меток: текст и «✕», «✕» снимает фильтр', async () => {
    const t = await setup();
    t.rowChip(1, 'bug').click();
    t.barChips().find((c) => c.textContent === 'ui')!.click();
    const body = t.root.children.find((c) => c.className === 'tasks-body')!;
    assert.ok(body.text().includes('Нет задач под фильтр меток'), body.text());
    body.all().find((x) => x.textContent === '✕')!.click();
    assert.ok(t.root.text().includes('#1') && t.root.text().includes('#2'));
  });

  it('пока идёт загрузка, полоса меток остаётся с прежними метками и цветом, но выключена', async () => {
    const t = await setup();
    const before = t.barChips().map((c) => `${c.textContent}/${c.style.backgroundColor}`);
    assert.deepEqual(before, ['bug/#ff0000', 'ui/#ff0000']);
    let release!: (r: unknown) => void;
    impl.list = () => new Promise((r) => { release = r; });
    const pending = t.view.refresh(false, 'reload');
    const during = t.barChips();
    assert.deepEqual(during.map((c) => `${c.textContent}/${c.style.backgroundColor}`), before);
    assert.ok(during.every((c) => c.disabled), 'выключена');
    assert.equal(t.root.children.find((c) => c.className === 'tasks-labels')!.hidden, false);
    release(result(2, mk(1, ['bug']), mk(2, ['ui'])));
    await pending;
    assert.ok(t.barChips().every((c) => !c.disabled));
  });

  it('смена проекта очищает полосу меток', async () => {
    const t = await setup();
    t.view.onProjectChanged();
    assert.equal(t.barChips().length, 0);
  });
});
