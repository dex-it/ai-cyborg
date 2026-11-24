import { el } from './dom';
import { clickedLink, renderMarkdown } from './markdown';
import type { MdLink } from './md-links';
import { readPref, writePref } from './prefs';
import { fitBox, parseBox, SIDE_BOX_KEY, type Box } from './side-geometry';
import { DEFAULT_SIDE_QUESTION, sideFailure, sidePrompt, sideUsageLine, type SideAnswer, type SideTurn } from '../shared/side-question';

export interface SideHost {
  ask(prompt: string): Promise<SideAnswer>;
  open(link: MdLink): void;
  /** Корень для относительных ссылок в ответе. */
  root: string;
  focusTerminal(): void;
}

/** Окно вопроса по выделенному в терминале: ответы форка сессии и уточняющие вопросы по тому же фрагменту. */
export class SideDialog {
  readonly el = el('div', 'side-dialog');
  private readonly fragmentEl = el('pre', 'side-fragment');
  private readonly thread = el('div', 'side-thread');
  private readonly input = document.createElement('textarea');
  private fragment = '';
  private history: SideTurn[] = [];
  private busy = false;
  // Новый фрагмент начинает разговор заново: ответ на прежний вопрос в него уже не попадает.
  private generation = 0;
  private placing = false;

  constructor(
    parent: HTMLElement,
    private readonly host: SideHost,
  ) {
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', 'Вопрос по сессии');
    this.el.hidden = true;
    const header = el('div', 'side-header');
    const close = el('button', 'side-close', '×') as HTMLButtonElement;
    close.type = 'button';
    close.title = 'Закрыть (Esc)';
    close.addEventListener('click', () => this.close());
    header.append(el('span', 'side-title', 'Вопрос по сессии'), close);
    header.addEventListener('pointerdown', (event) => this.drag(event, header));
    // Размер меняет угол окна (CSS resize); событие о конце изменения браузер не шлёт.
    new ResizeObserver(() => {
      if (!this.el.hidden && !this.placing) this.save();
    }).observe(this.el);
    this.input.className = 'side-input';
    this.input.rows = 2;
    this.input.placeholder = 'Уточнить… Enter - спросить, Shift+Enter - новая строка';
    this.input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      const question = this.input.value.trim();
      if (!question || this.busy) return;
      this.input.value = '';
      void this.ask(question);
    });
    this.el.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      this.close();
    });
    this.thread.addEventListener('click', (event) => {
      const link = clickedLink(event, this.host.root + '/.', this.host.root);
      if (!link) return;
      event.preventDefault();
      if (link.kind !== 'none' && link.kind !== 'anchor') this.host.open(link);
    });
    this.el.append(header, this.fragmentEl, this.thread, this.input);
    parent.append(this.el);
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  /** Новый фрагмент: разговор с начала, первый вопрос - пояснить фрагмент. */
  start(fragment: string): void {
    this.generation++;
    this.fragment = fragment;
    this.history = [];
    this.busy = false;
    this.fragmentEl.textContent = fragment.trim();
    this.thread.replaceChildren();
    this.el.hidden = false;
    this.place();
    this.input.focus();
    void this.ask(DEFAULT_SIDE_QUESTION);
  }

  /** Сохранённое место и размер, вписанные в панель этого терминала. */
  private place(): void {
    const area = this.el.parentElement;
    if (!area) return;
    this.placing = true;
    const saved = parseBox(readPref(SIDE_BOX_KEY));
    const r = this.el.getBoundingClientRect();
    const a = area.getBoundingClientRect();
    const box = fitBox(saved ?? { left: r.left - a.left, top: r.top - a.top, width: r.width, height: r.height }, a.width, a.height);
    this.apply(box);
    requestAnimationFrame(() => (this.placing = false));
  }

  private apply(box: Box): void {
    Object.assign(this.el.style, { left: `${box.left}px`, top: `${box.top}px`, right: 'auto', width: `${box.width}px`, height: `${box.height}px` });
  }

  private box(): Box {
    const a = this.el.parentElement?.getBoundingClientRect();
    const r = this.el.getBoundingClientRect();
    return { left: r.left - (a?.left ?? 0), top: r.top - (a?.top ?? 0), width: r.width, height: r.height };
  }

  private save(): void {
    writePref(SIDE_BOX_KEY, JSON.stringify(this.box()));
  }

  private drag(event: PointerEvent, header: HTMLElement): void {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
    const area = this.el.parentElement?.getBoundingClientRect();
    if (!area) return;
    event.preventDefault();
    const start = this.box();
    const from = { x: event.clientX, y: event.clientY };
    header.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent): void =>
      this.apply(fitBox({ ...start, left: start.left + e.clientX - from.x, top: start.top + e.clientY - from.y }, area.width, area.height));
    const up = (): void => {
      header.removeEventListener('pointermove', move);
      header.removeEventListener('pointerup', up);
      header.removeEventListener('pointercancel', up);
      this.save();
    };
    header.addEventListener('pointermove', move);
    header.addEventListener('pointerup', up);
    header.addEventListener('pointercancel', up);
  }

  close(): void {
    this.generation++;
    this.busy = false;
    this.el.hidden = true;
    this.host.focusTerminal();
  }

  private async ask(question: string): Promise<void> {
    const generation = this.generation;
    this.busy = true;
    const turn = el('div', 'side-turn');
    const answerEl = el('div', 'side-answer pending', 'Думаю…');
    turn.append(el('div', 'side-question', question), answerEl);
    this.thread.append(turn);
    turn.scrollIntoView({ block: 'nearest' });
    const started = performance.now();
    const tick = setInterval(() => (answerEl.textContent = `Думаю… ${Math.round((performance.now() - started) / 1000)} с`), 1000);
    let answer: SideAnswer;
    try {
      answer = await this.host.ask(sidePrompt(this.fragment, this.history, question));
    } catch (error) {
      answer = { ok: false, reason: error instanceof Error ? error.message : String(error) };
    } finally {
      clearInterval(tick);
    }
    if (generation !== this.generation) return;
    this.busy = false;
    answerEl.classList.remove('pending');
    if (answer.ok && answer.text) {
      answerEl.replaceChildren(renderMarkdown(answer.text, this.host.root + '/.', this.host.root));
      this.history.push({ question, answer: answer.text });
    } else {
      answerEl.classList.add('failed');
      answerEl.textContent = sideFailure(answer);
    }
    const usage = sideUsageLine(answer);
    if (usage) turn.append(el('div', 'side-usage', usage));
    turn.scrollIntoView({ block: 'nearest' });
    if (this.el.contains(document.activeElement) || document.activeElement === document.body) this.input.focus();
  }
}
