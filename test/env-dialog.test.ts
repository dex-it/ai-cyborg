import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EnvVarView, EnvView } from '../src/shared/env-vars';

class FakeNode {
  className = '';
  textContent = '';
  hidden = false;
  disabled = false;
  open = false;
  value = '';
  type = '';
  spellcheck = false;
  autocomplete = '';
  placeholder = '';
  checked = false;
  name = '';
  title = '';
  id = '';
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  children: FakeNode[] = [];
  parentElement: FakeNode | null = null;
  private listeners: { type: string; fn: () => void }[] = [];
  constructor(readonly tag = '') {}
  classList = { add: (c: string) => { this.className = `${this.className} ${c}`.trim(); } };
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  removeAttribute(k: string): void { delete this.attrs[k]; }
  getBoundingClientRect() { return { left: 10, top: 500, bottom: 520, width: 300 }; }
  append(...nodes: FakeNode[]): void { for (const n of nodes) { n.parentElement = this; this.children.push(n); } }
  replaceChildren(...nodes: FakeNode[]): void { this.children = []; this.append(...nodes); }
  addEventListener(type: string, fn: () => void): void { this.listeners.push({ type, fn }); }
  fire(type: string): void {
    if (this.disabled && type === 'click') return;
    for (const l of this.listeners) if (l.type === type) l.fn();
  }
  showModal(): void { this.open = true; }
  close(): void { this.open = false; }
  remove(): void {}
  querySelector(): null { return null; }
  get lastElementChild(): FakeNode | null { return this.children[this.children.length - 1] ?? null; }
  all(): FakeNode[] { return [this, ...this.children.flatMap((c) => c.all())]; }
}

const ids = new Map<string, FakeNode>();
for (const id of ['env-dialog', 'env-body', 'env-error', 'env-close', 'env-add', 'env-unset-new', 'env-new-name', 'env-names']) ids.set(id, new FakeNode('div'));
Object.assign(globalThis, {
  window: { innerHeight: 900 },
  document: { createElement: (tag: string) => new FakeNode(tag), createElementNS: (_ns: string, tag: string) => new FakeNode(tag), getElementById: (id: string) => ids.get(id) },
  Option: class extends FakeNode {
    constructor(text: string, value: string) {
      super('option');
      this.textContent = text;
      this.value = value;
    }
  },
});

const expr = (id: string, command: string) => ({ id, kind: 'expr' as const, command });
const variable = (over: Partial<EnvVarView>): EnvVarView => ({
  name: 'TOKEN',
  candidates: [expr('aaaaaaaa', 'pass show a'), expr('bbbbbbbb', 'pass show b')],
  choice: { kind: 'selected', candidate: 'aaaaaaaa' },
  status: { kind: 'evaluating' } as EnvVarView['status'],
  unapplied: false,
  notes: [],
  ...over,
});

async function open(v: EnvVarView) {
  const { EnvDialog } = await import('../src/renderer/env-dialog');
  const view: EnvView = { vars: [v], problems: [], starting: true };
  const selected: [string, string][] = [];
  const api = {
    envView: async () => view,
    envSave: async () => view,
    envSelect: async (name: string, id: string) => { selected.push([name, id]); return { ok: true as const }; },
    envUnset: async () => {},
    envUntouch: async () => {},
    envRemove: async () => {},
    envCancel: async () => {},
    envReveal: async () => null,
    envNames: async () => ['HOME', 'TOKEN', 'ZZ_KEY'],
  };
  ids.get('env-dialog')!.open = false;
  await new EnvDialog(api).open();
  const nodes = ids.get('env-body')!.all();
  return {
    selected,
    radios: nodes.filter((n) => n.type === 'radio'),
    again: () => nodes.filter((n) => n.attrs['aria-label'] === 'Вычислить заново'),
    reveal: () => nodes.filter((n) => n.attrs['aria-label'] === 'Показать значение'),
  };
}

describe('окно «Окружение»: выбор кандидата во время вычисления', () => {
  for (const [title, v] of [
    ['стартовое вычисление выбранного выражения', variable({})],
    ['вычисление, начатое выбором человека (кандидат ещё не выбран)', variable({ choice: { kind: 'untouched' } })],
  ] as const) {
    it(`${title}: отметки кандидатов доступны, выбор другого уходит в главный процесс`, async () => {
      const { radios, selected } = await open(v);
      assert.equal(radios.length, 2);
      assert.ok(radios.every((r) => !r.disabled));
      radios[1].fire('change');
      assert.deepEqual(selected, [['TOKEN', 'bbbbbbbb']]);
    });
  }
  it('вычисление, начатое выбором кандидата B: отмечен B, ↻ стоит у B и вычисляет его, а не прежний выбор', async () => {
    const { radios, again, selected } = await open(variable({ status: { kind: 'evaluating', candidate: 'bbbbbbbb' } }));
    assert.deepEqual(radios.map((r) => r.checked), [false, true]);
    assert.equal(again().length, 1);
    again()[0].fire('click');
    assert.deepEqual(selected, [['TOKEN', 'bbbbbbbb']], 'нажатие повторяет вычисление показанного B, не подменяет его прежним A');
  });

  it('вычисление выбором при непроставленном выборе: отмечен вычисляемый, не первый', async () => {
    const { radios } = await open(variable({ choice: { kind: 'untouched' }, status: { kind: 'evaluating', candidate: 'bbbbbbbb' } }));
    assert.deepEqual(radios.map((r) => r.checked), [false, true]);
  });
});

describe('окно «Окружение»: показ значения', () => {
  it('у выбранного вычисленного выражения - ↻ и показ значения; у выбранного литерала их нет', async () => {
    const expr = await open(variable({ status: { kind: 'idle' } }));
    assert.equal(expr.again().length, 1);
    assert.equal(expr.reveal().length, 1);
    const literal = await open(variable({ candidates: [{ id: 'cccccccc', kind: 'literal', value: 'v' }], choice: { kind: 'selected', candidate: 'cccccccc' }, status: { kind: 'idle' } }));
    assert.equal(literal.again().length, 0);
    assert.equal(literal.reveal().length, 0, 'литерал и так виден в поле');
  });
  it('пока выражение вычисляется или значения нет, показа нет', async () => {
    assert.equal((await open(variable({}))).reveal().length, 0);
    assert.equal((await open(variable({ status: { kind: 'idle' }, unapplied: true }))).reveal().length, 0);
  });
});

describe('окно «Окружение»: подсказка имени', () => {
  it('поле нового имени подсказывает унаследованные имена, кроме заведённых; клик подставляет имя', async () => {
    await open(variable({}));
    const input = ids.get('env-new-name')!;
    const list = ids.get('env-names')!;
    input.fire('focus');
    assert.equal(list.hidden, true, 'список открылся без ввода');
    input.value = '';
    input.fire('input');
    assert.deepEqual(list.children.map((o) => o.textContent), ['HOME', 'ZZ_KEY']);
    assert.equal(list.hidden, false);
    input.value = 'key';
    input.fire('input');
    assert.deepEqual(list.children.map((o) => o.textContent), ['ZZ_KEY']);
    list.children[0].fire('click');
    assert.equal(input.value, 'ZZ_KEY');
    assert.equal(list.hidden, true);
  });
});
