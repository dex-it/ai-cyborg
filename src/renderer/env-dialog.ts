import { MAX_CANDIDATES, defsOf, stateLabel, type Candidate, type EnvVarView, type EnvView } from '../shared/env-vars';
import { byId, el } from './dom';

export interface EnvApi {
  envView(): Promise<EnvView>;
  envSave(defs: unknown): Promise<EnvView>;
  envSelect(name: string, candidate: string): Promise<{ ok: true } | { ok: false; reason: string; stderr: string }>;
  envUnset(name: string): Promise<void>;
  envUntouch(name: string): Promise<void>;
  envRemove(name: string): Promise<void>;
  envCancel(name: string): Promise<void>;
  envReveal(name: string): Promise<string | null>;
}

const button = (label: string, onClick: () => void, className = ''): HTMLButtonElement => {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  if (className) b.className = className;
  b.addEventListener('click', onClick);
  return b;
};

/** Окно «Окружение»: переменные, кандидаты (значение либо выражение) и три состояния; все изменения идут через главный процесс. */
export class EnvDialog {
  private readonly dialog = byId<HTMLDialogElement>('env-dialog');
  private readonly body = byId('env-body');
  private readonly error = byId('env-error');
  private view: EnvView = { vars: [], problems: [], starting: false };

  constructor(
    private readonly api: EnvApi,
    private readonly onView: (view: EnvView) => void,
  ) {
    byId('env-close').addEventListener('click', () => this.dialog.close());
    byId('env-add').addEventListener('click', () => void this.addVar(byId<HTMLInputElement>('env-new-name')));
    byId('env-unset-new').addEventListener('click', () => void this.unsetNew(byId<HTMLInputElement>('env-new-name')));
  }

  async open(): Promise<void> {
    if (this.dialog.open) return;
    this.showError('');
    this.update(await this.api.envView());
    this.dialog.showModal();
  }

  /** Главный процесс прислал состояние: окно перерисовывается, пока открыто. */
  update(view: EnvView): void {
    this.view = view;
    this.onView(view);
    if (this.dialog.open) this.render();
  }

  private showError(text: string): void {
    this.error.textContent = text;
    this.error.hidden = !text;
  }

  private async run(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
      this.showError('');
    } catch (error) {
      this.showError(String((error as Error).message ?? error).replace(/^Error invoking remote method '[^']*': (Error: )?/, ''));
    }
    this.update(await this.api.envView());
  }

  private save(mutate: (defs: ReturnType<typeof defsOf>) => void): Promise<void> {
    const defs = defsOf(this.view);
    mutate(defs);
    return this.run(() => this.api.envSave(defs));
  }

  private async addVar(input: HTMLInputElement): Promise<void> {
    const name = input.value.trim();
    if (!name) return;
    await this.save((defs) => defs.push({ name, candidates: [] }));
    if (!this.error.textContent) input.value = '';
  }

  private async unsetNew(input: HTMLInputElement): Promise<void> {
    const name = input.value.trim();
    if (!name) return;
    await this.run(() => this.api.envUnset(name));
    if (!this.error.textContent) input.value = '';
  }

  private render(): void {
    const problems = this.view.problems.map((p) => el('div', 'dialog-note', p));
    const cards = this.view.vars.map((v) => this.card(v));
    this.body.replaceChildren(...problems, ...(cards.length ? cards : [el('p', 'hint', 'Переменных нет. Добавьте имя ниже или снимите унаследованную.')]));
  }

  private card(v: EnvVarView): HTMLElement {
    const card = el('section', 'env-var');
    card.dataset.name = v.name;
    const head = el('div', 'env-head');
    head.append(el('strong', '', v.name), el('span', 'env-state', stateLabel(v)));
    card.append(head);
    for (const note of v.notes) card.append(el('div', 'hint', note));
    if (v.status.kind === 'failed' && v.status.stderr) card.append(el('pre', 'env-stderr', v.status.stderr));
    for (const c of v.candidates) card.append(this.candidate(v, c));
    card.append(this.adder(v));
    const actions = el('div', 'env-actions');
    actions.append(
      button('Снять', () => void this.run(() => this.api.envUnset(v.name)), v.choice.kind === 'unset' ? 'active' : ''),
      button('Не трогать', () => void this.run(() => this.api.envUntouch(v.name)), v.choice.kind === 'untouched' ? 'active' : ''),
      button('Удалить переменную', () => void this.run(() => this.api.envRemove(v.name))),
    );
    if (v.status.kind === 'evaluating') actions.append(button('Отменить вычисление', () => void this.run(() => this.api.envCancel(v.name))));
    if (v.choice.kind === 'selected' && !v.unapplied) actions.append(button('Показать значение', () => void this.reveal(v.name, card)));
    card.append(actions);
    return card;
  }

  private candidate(v: EnvVarView, c: Candidate): HTMLElement {
    const row = el('div', 'env-candidate');
    const picked = v.choice.kind === 'selected' && v.choice.candidate === c.id;
    if (picked) row.classList.add('selected');
    const input = document.createElement('input');
    input.type = 'text';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.value = c.kind === 'literal' ? c.value : c.command;
    input.setAttribute('aria-label', c.kind === 'literal' ? `Значение ${v.name}` : `Команда ${v.name}`);
    input.addEventListener('change', () => {
      void this.save((defs) => {
        const def = defs.find((d) => d.name === v.name);
        const i = def?.candidates.findIndex((x) => x.id === c.id) ?? -1;
        if (def && i >= 0) def.candidates[i] = c.kind === 'literal' ? { ...c, value: input.value } : { ...c, command: input.value };
      });
    });
    row.append(
      el('span', 'env-kind', c.kind === 'literal' ? 'значение' : 'выражение'),
      input,
      button(picked ? 'Выбрано' : 'Выбрать', () => void this.select(v.name, c.id), picked ? 'active' : ''),
      button('×', () => void this.save((defs) => {
        const def = defs.find((d) => d.name === v.name);
        if (def) def.candidates = def.candidates.filter((x) => x.id !== c.id);
      })),
    );
    row.lastElementChild?.setAttribute('aria-label', 'Убрать кандидата');
    return row;
  }

  private adder(v: EnvVarView): HTMLElement {
    const row = el('div', 'env-add');
    const kind = document.createElement('select');
    kind.setAttribute('aria-label', 'Вид кандидата');
    kind.append(new Option('значение', 'literal'), new Option('выражение', 'expr'));
    const text = document.createElement('input');
    text.type = 'text';
    text.spellcheck = false;
    text.placeholder = 'значение или команда sh';
    const add = button('Добавить', () => {
      if (!text.value.trim() && kind.value === 'expr') return;
      if (v.candidates.length >= MAX_CANDIDATES) return;
      void this.save((defs) => {
        const def = defs.find((d) => d.name === v.name);
        const id = crypto.randomUUID().slice(0, 8);
        if (def) def.candidates.push(kind.value === 'literal' ? { id, kind: 'literal', value: text.value } : { id, kind: 'expr', command: text.value });
      });
    });
    row.append(kind, text, add);
    return row;
  }

  private async select(name: string, id: string): Promise<void> {
    await this.run(async () => {
      const result = await this.api.envSelect(name, id);
      if (!result.ok && result.reason !== 'cancelled') this.showError(`${name}: не вычислено${result.stderr ? ` (${result.stderr})` : ''}`);
    });
  }

  private async reveal(name: string, card: HTMLElement): Promise<void> {
    const value = await this.api.envReveal(name).catch(() => null);
    card.querySelector('.env-value')?.remove();
    card.append(el('pre', 'env-value', value ?? 'не задана'));
  }
}
