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
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  children: FakeNode[] = [];
  parentElement: FakeNode | null = null;
  private listeners: { type: string; fn: () => void }[] = [];
  constructor(readonly tag = '') {}
  classList = { add: (c: string) => { this.className = `${this.className} ${c}`.trim(); } };
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
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
for (const id of ['env-dialog', 'env-body', 'env-error', 'env-close', 'env-add', 'env-unset-new', 'env-new-name']) ids.set(id, new FakeNode('div'));
Object.assign(globalThis, {
  document: { createElement: (tag: string) => new FakeNode(tag), getElementById: (id: string) => ids.get(id) },
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
  };
  ids.get('env-dialog')!.open = false;
  await new EnvDialog(api, () => {}).open();
  const nodes = ids.get('env-body')!.all();
  return {
    selected,
    list: nodes.find((n) => n.attrs['aria-label'] === 'Кандидат TOKEN')!,
    apply: nodes.find((n) => n.tag === 'button' && /Выбрать|Вычислить заново/.test(n.textContent))!,
  };
}

describe('окно «Окружение»: выбор кандидата во время вычисления', () => {
  for (const [title, v] of [
    ['стартовое вычисление выбранного выражения', variable({})],
    ['вычисление, начатое выбором человека (кандидат ещё не выбран)', variable({ choice: { kind: 'untouched' } })],
  ] as const) {
    it(`${title}: список и кнопка доступны, выбор другого кандидата уходит в главный процесс`, async () => {
      const { list, apply, selected } = await open(v);
      assert.equal(list.disabled, false);
      assert.equal(apply.disabled, false);
      list.value = 'bbbbbbbb';
      list.fire('change');
      assert.deepEqual(selected, [['TOKEN', 'bbbbbbbb']]);
      apply.fire('click');
      assert.equal(selected.length, 2, 'кнопка тоже выбирает, пока вычисление идёт');
    });
  }
  it('вычисление, начатое выбором кандидата B: список стоит на B, кнопка относится к B, а не к прежнему выбору', async () => {
    const { list, apply, selected } = await open(variable({ status: { kind: 'evaluating', candidate: 'bbbbbbbb' } }));
    assert.equal(list.value, 'bbbbbbbb');
    assert.equal(apply.textContent, 'Вычислить заново');
    apply.fire('click');
    assert.deepEqual(selected, [['TOKEN', 'bbbbbbbb']], 'нажатие повторяет вычисление показанного B, не подменяет его прежним A');
  });

  it('вычисление выбором при непроставленном выборе: список на вычисляемом, не на первом, кнопка не «Выбрать»', async () => {
    const { list, apply } = await open(variable({ choice: { kind: 'untouched' }, status: { kind: 'evaluating', candidate: 'bbbbbbbb' } }));
    assert.equal(list.value, 'bbbbbbbb');
    assert.equal(apply.textContent, 'Вычислить заново');
  });
});
