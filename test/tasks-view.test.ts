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

  it('пока идёт фоновая загрузка, полоса меток остаётся с прежними метками и цветом и работает', async () => {
    const t = await setup();
    const before = t.barChips().map((c) => `${c.textContent}/${c.style.backgroundColor}`);
    assert.deepEqual(before, ['bug/#ff0000', 'ui/#ff0000']);
    let release!: (r: unknown) => void;
    impl.list = () => new Promise((r) => { release = r; });
    const pending = t.view.refresh(false, 'reload');
    const during = t.barChips();
    assert.deepEqual(during.map((c) => `${c.textContent}/${c.style.backgroundColor}`), before);
    assert.ok(during.every((c) => !c.disabled), 'снимок на экране живой');
    assert.equal(t.root.children.find((c) => c.className === 'tasks-labels')!.hidden, false);
    release(result(2, mk(1, ['bug']), mk(2, ['ui'])));
    await pending;
    assert.ok(t.barChips().every((c) => !c.disabled));
  });

  const failedResult = (selection: number) => ({
    tasks: [], sources: [{ kind: 'github', host: 'github.com', path: 'o/r', error: 'нет сети' }], tracked: [], enabled: { github: true, gitlab: false }, selection,
  });

  it('фоновая выборка, на которой упали все источники, снимок не стирает и не повторяется до конца TTL; «Обновить» ошибку показывает', async () => {
    const t = await setup();
    const at = t.view.loadedAt();
    assert.ok(at !== null);
    t.setList(failedResult(2));
    await t.view.refresh(false, 'timer');
    assert.ok(t.root.text().includes('#1') && t.root.text().includes('#2'), 'список остался');
    assert.ok(!t.root.text().includes('нет сети'));
    assert.equal(t.view.loadedAt(), at, 'время снимка не изменилось');
    const before = calls.list;
    await t.view.refresh(false, 'timer');
    assert.equal(calls.list, before, 'повтор раньше TTL не уходит в канал');
    await t.view.refresh(false, 'reload');
    assert.ok(t.root.text().includes('нет сети'), 'по «Обновить» ошибка показана');
  });

  it('ответ-неудача не считается снимком: открытие панели выберет заново, фон его не опрашивает', async () => {
    const t = await setup(failedResult(1) as any);
    assert.equal(t.view.loadedAt(), null);
    assert.ok(t.root.text().includes('нет сети'));
  });

  it('частичный отказ (упал один источник из двух) заменяет снимок', async () => {
    const t = await setup();
    const partial = {
      ...result(2, mk(3, ['bug'])),
      sources: [{ kind: 'github', host: 'github.com', path: 'o/r' }, { kind: 'gitlab', host: 'gitlab.com', path: 'g/p', error: 'нет сети' }],
    };
    t.setList(partial);
    await t.view.refresh(false, 'timer');
    assert.ok(t.root.text().includes('#3') && !t.root.text().includes('#1'));
    assert.notEqual(t.view.loadedAt(), null);
  });

  it('фон не пересоздаёт строки, пока ответ равен снимку; изменившийся ответ их заменяет', async () => {
    const t = await setup();
    const row = t.rowOf(1);
    let release!: (r: unknown) => void;
    impl.list = () => new Promise((r) => { release = r; });
    const pending = t.view.refresh(false, 'timer');
    assert.equal(t.rowOf(1), row, 'в начале выборки строки на месте');
    assert.ok(t.root.text().includes('Обновление…'), 'кнопка показывает выборку');
    release(result(5, mk(1, ['bug']), mk(2, ['ui'])));
    await pending;
    assert.equal(t.rowOf(1), row, 'ответ равен снимку: строки те же');
    assert.ok(t.root.text().includes('Обновить') && !t.root.text().includes('Обновление…'));
    t.setList(result(6, mk(1, ['bug']), mk(2, ['ui']), mk(3, ['ui'])));
    await t.view.refresh(false, 'timer');
    assert.notEqual(t.rowOf(1), row, 'ответ изменился: строки пересозданы');
    assert.ok(t.root.text().includes('#3'));
    t.rowOf(1).click();
    await t.flush();
    assert.deepEqual(calls.details.at(-1), { selection: 6, number: 1 }, 'описание берётся с номером нового ответа');
  });

  it('смена проекта очищает полосу меток', async () => {
    const t = await setup();
    t.view.onProjectChanged();
    assert.equal(t.barChips().length, 0);
  });

  it('действие в строке метит её; метка переживает перерисовку и снимается mark(null)', async () => {
    const t = await setup();
    const rowOf = (n: number) => t.root.all().find((x) => x.className.startsWith('task-row') && x.text().includes(`#${n}`))!;
    t.rowOf(2).all().find((x) => x.dataset.action === 'start')!.click();
    assert.ok(rowOf(2).className.includes('returned'));
    assert.ok(!rowOf(1).className.includes('returned'));
    t.view.repaint();
    assert.ok(rowOf(2).className.includes('returned'), 'после перерисовки строка по-прежнему помечена');
    assert.equal(t.view.reveal('github:github.com:o/r#2'), true);
    assert.equal(t.view.reveal('нет такой'), false);
    t.view.mark(null);
    assert.ok(!rowOf(2).className.includes('returned'));
  });

  it('прокрутка списка читается и восстанавливается', async () => {
    const t = await setup();
    t.view.setScroll(240);
    assert.equal(t.view.getScroll(), 240);
  });
});

describe('TrackerPanel: возврат к списку', () => {
  async function panelSetup() {
    const ids = new Map<string, FakeNode>();
    for (const id of ['tasks-panel', 'sessions', 'tasks-toggle', 'mrs-toggle']) ids.set(id, new FakeNode('div'));
    (globalThis as any).document.getElementById = (id: string) => ids.get(id);
    (globalThis as any).window.setInterval = () => 0;
    const { TrackerPanel } = await import('../src/renderer/panel');
    const host = { project: () => null, projectHint: () => ['нет'], trackedRefs: () => [], applyStatuses: () => {}, sessionOf: () => undefined, startTask: () => {}, startMr: () => {} };
    const closed: number[] = [];
    const panel = new TrackerPanel({ tasks: host as any, mrs: host as any, onClosed: () => closed.push(1) });
    const log: string[] = [];
    const stub = (name: string) => {
      let top = 0;
      return {
        element: new FakeNode('div'),
        refresh: async () => {},
        onProjectChanged: () => log.push(`${name}:project`),
        loadedAt: () => null,
        repaint: () => log.push(`${name}:repaint`),
        getScroll: () => top,
        setScroll: (n: number) => { top = n; log.push(`${name}:scroll=${n}`); },
        mark: (k: string | null) => log.push(`${name}:mark=${k}`),
        reveal: (k: string) => { log.push(`${name}:reveal=${k}`); return true; },
        scroll: (n: number) => { top = n; },
      };
    };
    const views = { tasks: stub('tasks'), mrs: stub('mrs') };
    (panel as any).views = views;
    (panel as any).mount();
    return { panel, views, log, toggle: (id: string) => ids.get(id)!.click(), closed, ids };
  }

  it('прокрутка списка запоминается при закрытии и возвращается при открытии', async () => {
    const t = await panelSetup();
    t.panel.setAvailable(true);
    t.toggle('mrs-toggle');
    assert.ok(t.panel.isOpen);
    t.views.mrs.scroll(480);
    t.panel.close();
    t.log.length = 0;
    t.toggle('mrs-toggle');
    assert.deepEqual(t.log.filter((x) => x.startsWith('mrs:')), ['mrs:repaint', 'mrs:scroll=480']);
  });

  it('прокрутка каждого вида своя; переключение вкладок её не смешивает', async () => {
    const t = await panelSetup();
    t.toggle('tasks-toggle');
    t.views.tasks.scroll(100);
    t.toggle('mrs-toggle');
    t.views.mrs.scroll(300);
    t.toggle('tasks-toggle');
    assert.equal(t.views.tasks.getScroll(), 100);
    t.toggle('mrs-toggle');
    assert.equal(t.views.mrs.getScroll(), 300);
  });

  it('reveal открывает закрытую панель на нужной вкладке и показывает строку', async () => {
    const t = await panelSetup();
    t.panel.reveal('mrs', 'k1');
    assert.ok(t.panel.isOpen);
    assert.ok(t.ids.get('mrs-toggle')!.className.includes('active'));
    assert.ok(t.log.includes('mrs:reveal=k1'));
    t.log.length = 0;
    t.panel.reveal('tasks', 't9');
    assert.ok(t.ids.get('tasks-toggle')!.className.includes('active'), 'открытая панель переключается на вкладку задач');
    assert.ok(t.log.includes('tasks:reveal=t9'));
  });

  it('смена проекта сбрасывает метки и прокрутку', async () => {
    const t = await panelSetup();
    t.toggle('mrs-toggle');
    t.views.mrs.scroll(90);
    t.panel.close();
    t.log.length = 0;
    t.panel.onProjectChanged();
    assert.ok(t.log.includes('mrs:mark=null') && t.log.includes('tasks:mark=null'));
    t.log.length = 0;
    t.toggle('mrs-toggle');
    assert.ok(t.log.includes('mrs:scroll=0'));
  });
});
