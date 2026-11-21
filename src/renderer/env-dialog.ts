import { MAX_CANDIDATES, candidateLabel, defsOf, matchNames, revealStamp, stateLabel, type Candidate, type EnvVarView, type EnvView } from '../shared/env-vars';
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
  envNames(): Promise<string[]>;
}

const button = (label: string, onClick: () => void, className = ''): HTMLButtonElement => {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  if (className) b.className = className;
  b.addEventListener('click', onClick);
  return b;
};

const toggle = (label: string, on: boolean, onClick: () => void): HTMLButtonElement => {
  const b = button(label, onClick, on ? 'active' : '');
  b.setAttribute('aria-pressed', String(on));
  return b;
};

const TRASH = { path: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M7 7v4M9 7v4' };
const EYE = { path: 'M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8zM6 8a2 2 0 1 0 4 0a2 2 0 1 0-4 0' };

/** Кнопка-значок: подпись в aria-label и подсказке; значок - символ либо контур svg. */
const icon = (glyph: string | { path: string }, label: string, onClick: () => void): HTMLButtonElement => {
  const b = button(typeof glyph === 'string' ? glyph : '', onClick, 'env-icon');
  if (typeof glyph !== 'string') {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', glyph.path);
    svg.append(path);
    b.append(svg);
  }
  b.setAttribute('aria-label', label);
  b.title = label;
  return b;
};

/** Окно «Окружение»: переменные, кандидаты (значение либо выражение) и три состояния; все изменения идут через главный процесс. */
export class EnvDialog {
  private readonly dialog = byId<HTMLDialogElement>('env-dialog');
  private readonly body = byId('env-body');
  private readonly error = byId('env-error');
  private readonly nameInput = byId<HTMLInputElement>('env-new-name');
  private readonly names = byId('env-names');
  /** Имена унаследованного окружения - подсказка поля нового имени; перечитываются при открытии окна. */
  private inheritedNames: string[] = [];
  private shownNames: string[] = [];
  private activeName = -1;
  private view: EnvView = { vars: [], problems: [], starting: false };
  /** Раскрытые «Показать» значения: до закрытия окна; запись верна, пока состояние переменной то же. */
  private readonly revealed = new Map<string, { value: string; stamp: string }>();
  /** Карточки с раскрытой строкой «+ значение»: переживают перерисовку, сворачиваются добавлением или Escape. */
  private readonly adding = new Set<string>();

  constructor(private readonly api: EnvApi) {
    byId('env-close').addEventListener('click', () => this.dialog.close());
    this.dialog.addEventListener('close', () => {
      if (this.dialog.open) return;
      this.revealed.clear();
      this.adding.clear();
      this.body.replaceChildren();
    });
    byId('env-add').addEventListener('click', () => void this.addVar(this.nameInput));
    byId('env-unset-new').addEventListener('click', () => void this.unsetNew(this.nameInput));
    this.nameInput.addEventListener('input', () => this.suggest());
    this.nameInput.addEventListener('blur', () => this.hideSuggest());
    this.nameInput.addEventListener('keydown', (e) => this.suggestKey(e));
    // Нажатие в списке не уводит фокус из поля: иначе blur спрячет список до клика.
    this.names.addEventListener('mousedown', (e) => e.preventDefault());
  }

  /** Список подсказок под полем имени: своя прокрутка и клавиши, а не datalist - его всплывающее окно в Electron на Linux не прокручивается. */
  private suggest(): void {
    const defined = new Set(this.view.vars.map((v) => v.name));
    this.shownNames = matchNames(this.inheritedNames.filter((name) => !defined.has(name)), this.nameInput.value);
    this.activeName = -1;
    this.names.replaceChildren(
      ...this.shownNames.map((name, i) => {
        const item = el('div', 'env-suggest-item', name);
        item.id = `env-name-${i}`;
        item.setAttribute('role', 'option');
        item.addEventListener('click', () => this.pickName(name));
        return item;
      }),
    );
    const show = this.shownNames.length > 0 && !(this.shownNames.length === 1 && this.shownNames[0] === this.nameInput.value);
    if (!show) return this.hideSuggest();
    const box = this.nameInput.getBoundingClientRect();
    const below = window.innerHeight - box.bottom;
    this.names.style.left = `${box.left}px`;
    this.names.style.width = `${box.width}px`;
    // Окно растёт туда, где больше места: поле стоит внизу окна «Окружение».
    if (below >= 160 || below >= box.top) {
      this.names.style.top = `${box.bottom + 2}px`;
      this.names.style.bottom = '';
      this.names.style.maxHeight = `${Math.min(280, below - 12)}px`;
    } else {
      this.names.style.top = '';
      this.names.style.bottom = `${window.innerHeight - box.top + 2}px`;
      this.names.style.maxHeight = `${Math.min(280, box.top - 12)}px`;
    }
    this.names.hidden = false;
    this.nameInput.setAttribute('aria-expanded', 'true');
  }

  private hideSuggest(): void {
    this.names.hidden = true;
    this.activeName = -1;
    this.nameInput.setAttribute('aria-expanded', 'false');
    this.nameInput.removeAttribute('aria-activedescendant');
  }

  private pickName(name: string): void {
    this.nameInput.value = name;
    this.hideSuggest();
  }

  private suggestKey(e: KeyboardEvent): void {
    if (this.names.hidden) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.suggest();
      }
      return;
    }
    const count = this.shownNames.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      this.activeName = e.key === 'ArrowDown' ? (this.activeName + 1) % count : (this.activeName - 1 + count) % count;
      const items = [...this.names.children] as HTMLElement[];
      items.forEach((item, i) => item.classList.toggle('active', i === this.activeName));
      items[this.activeName]?.scrollIntoView({ block: 'nearest' });
      this.nameInput.setAttribute('aria-activedescendant', `env-name-${this.activeName}`);
    } else if (e.key === 'Enter' && this.activeName >= 0) {
      e.preventDefault();
      this.pickName(this.shownNames[this.activeName]);
    } else if (e.key === 'Escape') {
      // Escape закрывает список, а не окно «Окружение».
      e.preventDefault();
      e.stopPropagation();
      this.hideSuggest();
    }
  }

  async open(): Promise<void> {
    if (this.dialog.open) return;
    this.revealed.clear();
    this.showError('');
    [this.view, this.inheritedNames] = await Promise.all([this.api.envView(), this.api.envNames().catch(() => [])]);
    this.hideSuggest();
    this.render();
    this.dialog.showModal();
  }

  /** Главный процесс прислал состояние: окно перерисовывается, пока открыто. */
  update(view: EnvView): void {
    this.view = view;
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
    head.append(el('strong', '', v.name), el('span', 'env-state', stateLabel(v)), el('span', 'spacer'));
    if (v.status.kind === 'evaluating') head.append(button('Отменить вычисление', () => void this.run(() => this.api.envCancel(v.name)), 'env-small'));
    const seg = el('div', 'env-seg');
    seg.append(
      toggle('Не трогать', v.choice.kind === 'untouched', () => void this.run(() => this.api.envUntouch(v.name))),
      toggle('Снять', v.choice.kind === 'unset', () => void this.run(() => this.api.envUnset(v.name))),
    );
    head.append(seg, icon(TRASH, 'Удалить переменную', () => void this.run(() => this.api.envRemove(v.name))));
    card.append(head);
    for (const note of v.notes) card.append(el('div', 'hint', note));
    if (v.status.kind === 'failed' && v.status.stderr) card.append(el('pre', 'env-stderr', v.status.stderr));
    const chosen = v.choice.kind === 'selected' ? v.choice.candidate : undefined;
    const known = (id: string | undefined): string | undefined => v.candidates.find((c) => c.id === id)?.id;
    // Пока идёт вычисление, отмечен вычисляемый кандидат: ↻ относится к нему, а не к прежнему выбору.
    const current = (v.status.kind === 'evaluating' ? known(v.status.candidate) : undefined) ?? known(chosen);
    const shown = this.revealed.get(v.name);
    for (const c of v.candidates) {
      card.append(this.candidate(v, c, c.id === current));
      if (c.id === chosen && shown && shown.stamp === revealStamp(v)) card.append(el('pre', 'env-value', shown.value));
    }
    if (v.candidates.length < MAX_CANDIDATES) card.append(this.adding.has(v.name) ? this.adder(v) : button('+ значение', () => this.openAdder(v.name), 'env-plus'));
    return card;
  }

  /** Кандидат строкой: отметка выбирает его (выражение вычисляется), текст правится на месте; у отмеченного выражения - ↻ и показ значения. */
  private candidate(v: EnvVarView, c: Candidate, current: boolean): HTMLElement {
    const row = el('div', 'env-candidate');
    if (current) row.classList.add('selected');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = `env-${v.name}`;
    radio.checked = current;
    radio.setAttribute('aria-label', `Выбрать ${candidateLabel(c)}`);
    radio.addEventListener('change', () => void this.select(v.name, c.id));
    const input = document.createElement('input');
    input.type = 'text';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.className = 'env-text';
    input.value = c.kind === 'literal' ? c.value : c.command;
    input.setAttribute('aria-label', c.kind === 'literal' ? `Значение ${v.name}` : `Команда ${v.name}`);
    input.addEventListener('change', () => {
      void this.save((defs) => {
        const def = defs.find((d) => d.name === v.name);
        const i = def?.candidates.findIndex((x) => x.id === c.id) ?? -1;
        if (def && i >= 0) def.candidates[i] = c.kind === 'literal' ? { ...c, value: input.value } : { ...c, command: input.value };
      });
    });
    row.append(radio);
    if (c.kind === 'expr') row.append(el('span', 'env-tag', 'sh'));
    row.append(input);
    if (current && c.kind === 'expr') {
      row.append(icon('↻', 'Вычислить заново', () => void this.select(v.name, c.id)));
      if (v.choice.kind === 'selected' && v.choice.candidate === c.id && !v.unapplied && v.status.kind !== 'evaluating') row.append(icon(EYE, 'Показать значение', () => void this.reveal(v.name)));
    }
    row.append(
      icon('×', 'Убрать кандидата', () => void this.save((defs) => {
        const def = defs.find((d) => d.name === v.name);
        if (def) def.candidates = def.candidates.filter((x) => x.id !== c.id);
      })),
    );
    return row;
  }

  private openAdder(name: string): void {
    this.adding.add(name);
    this.render();
    this.body.querySelector<HTMLInputElement>(`.env-var[data-name="${name}"] .env-add input`)?.focus();
  }

  private adder(v: EnvVarView): HTMLElement {
    const row = el('div', 'env-add');
    const kind = document.createElement('select');
    kind.setAttribute('aria-label', 'Вид кандидата');
    kind.append(new Option('текст', 'literal'), new Option('команда', 'expr'));
    const text = document.createElement('input');
    text.type = 'text';
    text.spellcheck = false;
    text.placeholder = 'новое значение';
    text.setAttribute('aria-label', `Новое значение ${v.name}`);
    const add = (): void => {
      if (!text.value.trim() && kind.value === 'expr') return;
      this.adding.delete(v.name);
      void this.save((defs) => {
        const def = defs.find((d) => d.name === v.name);
        const id = crypto.randomUUID().slice(0, 8);
        if (def) def.candidates.push(kind.value === 'literal' ? { id, kind: 'literal', value: text.value } : { id, kind: 'expr', command: text.value });
      });
    };
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        add();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.adding.delete(v.name);
        this.render();
      }
    });
    const plus = button('+', add, 'env-small');
    plus.setAttribute('aria-label', 'Добавить значение');
    row.append(kind, text, plus);
    return row;
  }

  private async select(name: string, id: string): Promise<void> {
    this.revealed.delete(name);
    await this.run(async () => {
      const result = await this.api.envSelect(name, id);
      if (!result.ok && result.reason !== 'cancelled') this.showError(`${name}: не вычислено${result.stderr ? ` (${result.stderr})` : ''}`);
    });
  }

  private async reveal(name: string): Promise<void> {
    const value = await this.api.envReveal(name).catch(() => null);
    const v = this.view.vars.find((x) => x.name === name);
    if (v) this.revealed.set(name, { value: value ?? 'не задана', stamp: revealStamp(v) });
    this.render();
  }
}
