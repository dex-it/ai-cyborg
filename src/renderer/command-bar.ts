// Полоса кнопок-команд под терминалом сессии (фича 12): встроенные кнопки, общий набор и набор воркспейса, отправка текста в сессию.

import {
  expandCommand,
  hotkeyMatches,
  parseHotkey,
  resolveBar,
  placeholdersOf,
  type CommandButton,
  type CommandsConfig,
  type Hotkey,
  type Placeholder,
  type PlaceholderValues,
} from '../main/commands';
import type { ButtonsNotice } from '../main/buttons-service';
import type { FileLayer } from '../main/commands';
import { el } from './dom';

/** Сессия, которой служит полоса: что нужно знать о ней и куда отправлять. */
export interface CommandTarget {
  readonly id: number;
  isExited(): boolean;
  /** Значения подстановок; значения нет - исключение с причиной, её увидит человек. */
  values(needs: Placeholder[]): Promise<PlaceholderValues>;
  focus(): void;
}

export interface CommandBarsDeps {
  mac: boolean;
  send(id: number, data: string): void;
  /** Высота полосы изменилась: терминалу пора пересчитать размер. */
  layout(): void;
  /** Окно «Кнопки»: на кнопке, на новой кнопке из предложенной или просто открыть. */
  openButtons(request?: { layer?: FileLayer; place?: 'bar'; label?: string; draft?: { label: string; text: string; submit: boolean; description?: string } }): void;
  /** Открыт ли воркспейс: без него выключать кнопки в воркспейсе негде. */
  workspaceOpen(): boolean;
  /** Выключить кнопку в слое без окна. */
  disableButton(layer: FileLayer, label: string): Promise<{ error?: string }>;
  /** Меню у кнопки: общее меню приложения (клавиатура, Escape). */
  menu(anchor: HTMLElement, label: string, items: [string, () => void][]): void;
  undoButtons(id: number): Promise<{ error?: string }>;
}

interface Bar {
  root: HTMLElement;
  buttons: HTMLElement;
  notice: HTMLElement;
  said: { text: string; warn: boolean } | null;
  announce: ButtonsNotice | null;
  timer: number | undefined;
  /** Кнопки, предложенные моделью: живут до следующего запроса человека (FR-12008). */
  suggested: CommandButton[];
}

const SAID_MS = 8000;
const freshKey = (place: string, label: string): string => `${place}:${label.trim().toLowerCase()}`;
/** Пауза между текстом и Enter: достаточно, чтобы они дошли до сессии разными записями (Claude Code 2.1.311, проверено через pty). */
const SUBMIT_DELAY_MS = 150;

/** Поле ввода, куда сочетание клавиш не вмешивается; помощник xterm - это сам терминал. */
const typingIn = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && !target.classList.contains('xterm-helper-textarea') && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

export class CommandBars {
  private commands: CommandButton[] = [];
  private bound: { button: CommandButton; hotkey: Hotkey }[] = [];
  private problems: string[] = [];
  private loaded = '';
  private readonly bars = new Map<CommandTarget, Bar>();
  private readonly running = new Set<CommandTarget>();
  /** Кнопки, добавленные сессией: помечены «новая», пока человек их не нажал. */
  private readonly fresh = new Set<string>();
  /** Слой, где кнопка родилась, по подписи в нижнем регистре: выключить в воркспейсе можно встроенную и общую. */
  private origins = new Map<string, string>();

  constructor(private readonly deps: CommandBarsDeps) {}

  /** Замечания к текущему файлу: негодные кнопки, занятые сочетания. */
  get configProblems(): readonly string[] {
    return this.problems;
  }

  /** Новая полоса сессии: кнопки ставятся сразу, поле commands приходит позже через setConfig. */
  attach(target: CommandTarget): HTMLElement {
    const root = el('div', 'command-bar');
    root.setAttribute('role', 'toolbar');
    root.setAttribute('aria-label', 'Команды сессии');
    const buttons = el('div', 'command-buttons');
    const notice = el('div', 'command-notice');
    notice.setAttribute('role', 'status');
    root.append(buttons, notice);
    this.bars.set(target, { root, buttons, notice, said: null, announce: null, timer: undefined, suggested: [] });
    this.render(target);
    return root;
  }

  detach(target: CommandTarget): void {
    window.clearTimeout(this.bars.get(target)?.timer);
    this.bars.delete(target);
    this.running.delete(target);
  }

  /** Общий набор и поле commands воркспейса как записаны; перерисовка только при изменении. */
  setConfig(config: CommandsConfig): void {
    const key = JSON.stringify([config.global ?? null, config.globalProblem ?? null, config.workspace ?? null]);
    if (key === this.loaded) return;
    this.loaded = key;
    const resolved = resolveBar(config, this.deps.mac);
    this.commands = resolved.buttons;
    this.origins = new Map(resolved.rows.map((r) => [r.label.toLowerCase(), r.origin]));
    this.problems = [...(config.globalProblem ? [config.globalProblem] : []), ...resolved.problems];
    this.bound = resolved.buttons.flatMap((button) => {
      const hotkey = button.hotkey ? parseHotkey(button.hotkey, this.deps.mac) : null;
      return hotkey && !('error' in hotkey) ? [{ button, hotkey }] : [];
    });
    for (const target of this.bars.keys()) this.render(target);
    this.deps.layout();
  }

  /** Кнопки, предложенные моделью, вместо прежних; пустой набор убирает их. `submit` берётся как проверил главный процесс (parseSuggestions); сочетаний у них нет. */
  suggest(target: CommandTarget, buttons: readonly CommandButton[]): void {
    const bar = this.bars.get(target);
    if (!bar || (!bar.suggested.length && !buttons.length)) return;
    bar.suggested = buttons.map((button) => ({ label: button.label, text: button.text, submit: button.submit, ...(button.description ? { description: button.description } : {}) }));
    this.render(target);
    this.deps.layout();
  }

  /** Сессия сама добавила, изменила или выключила кнопку: у полосы этой сессии - уведомление с «Отменить» и «Изменить…». */
  announce(caller: number, notice: ButtonsNotice): void {
    for (const [target, bar] of this.bars) {
      if (target.id !== caller) continue;
      bar.announce = notice;
    }
    if (notice.verb === 'added' || notice.verb === 'changed') this.fresh.add(freshKey(notice.place, notice.label));
    for (const target of this.bars.keys()) this.render(target);
  }

  /** Кнопку с таким ключом (место:подпись) добавила или изменила сессия, и человек её ещё не видел. */
  isFresh(key: string): boolean {
    return this.fresh.has(key);
  }

  /** Человек увидел кнопку: пометка «новая» снимается на полосе и в окне. */
  seen(key: string): void {
    if (!this.fresh.delete(key)) return;
    for (const target of this.bars.keys()) this.render(target);
  }

  /** Состояние сессии изменилось (завершилась): кнопки гаснут. */
  refresh(target: CommandTarget): void {
    this.render(target);
  }

  /** Сочетание кнопки на видимой сессии; true - клавиша обработана и дальше (в терминал) не идёт. */
  handleKey(event: KeyboardEvent, visible: CommandTarget | null): boolean {
    if (!visible || event.repeat || typingIn(event.target) || document.querySelector('dialog[open]')) return false;
    const hit = this.bound.find((b) => hotkeyMatches(b.hotkey, event));
    if (!hit) return false;
    event.preventDefault();
    event.stopPropagation();
    void this.run(visible, hit.button);
    return true;
  }

  async run(target: CommandTarget, button: CommandButton): Promise<void> {
    if (this.running.has(target)) return;
    if (target.isExited()) {
      this.say(target, `${button.label}: сессия завершена, команда не отправлена`, true);
      return;
    }
    this.running.add(target);
    try {
      const needs = placeholdersOf(button.text);
      let values: PlaceholderValues = {};
      if (needs.length) {
        this.say(target, `${button.label}: ищу ${needs.map((n) => `{${n}}`).join(', ')}…`, false);
        values = await target.values(needs);
      }
      if (target.isExited()) {
        this.say(target, `${button.label}: сессия завершилась, команда не отправлена`, true);
        return;
      }
      const out = expandCommand(button.text, values);
      if (!out.ok) {
        this.say(target, `${button.label}: ${out.reason}`, true);
        return;
      }
      this.deps.send(target.id, out.text);
      if (button.submit) {
        // Enter отдельной записью: пакет «текст и Enter» TUI вправе принять за вставку, где Enter - перевод строки, а не отправка.
        await new Promise((resolve) => window.setTimeout(resolve, SUBMIT_DELAY_MS));
        if (target.isExited()) {
          this.say(target, `${button.label}: сессия завершилась, Enter не отправлен`, true);
          return;
        }
        this.deps.send(target.id, '\r');
      }
      this.say(target, null);
      target.focus();
    } catch (error) {
      this.say(target, `${button.label}: ${(error as Error).message}`, true);
    } finally {
      this.running.delete(target);
    }
  }

  // ---------- вид ----------

  private render(target: CommandTarget): void {
    const bar = this.bars.get(target);
    if (!bar) return;
    const exited = target.isExited();
    const make = (button: CommandButton, suggested: boolean): HTMLElement => {
      const node = el('button', `command-button${button.submit ? '' : ' no-submit'}${suggested ? ' suggested' : ''}`, suggested ? `✦ ${button.label}` : button.label) as HTMLButtonElement;
      node.type = 'button';
      node.disabled = exited;
      node.title = [
        suggested ? 'Предложено моделью' : '',
        button.hotkey ?? '',
        button.description ?? '',
        button.text,
        button.submit ? (suggested ? '(нажатие отправит текст с Enter)' : '') : '(текст вставляется без Enter)',
      ]
        .filter(Boolean)
        .join('\n');
      const key = freshKey('bar', button.label);
      if (!suggested && this.fresh.has(key)) node.classList.add('fresh');
      node.addEventListener('mouseenter', () => this.seen(key));
      node.addEventListener('click', () => void this.run(target, button));
      node.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        const draft = { label: button.label, text: button.text, submit: button.submit, ...(button.description ? { description: button.description } : {}) };
        const items: [string, () => void][] = suggested
          ? [['Сохранить как кнопку…', () => this.deps.openButtons({ layer: this.deps.workspaceOpen() ? 'workspace' : 'global', place: 'bar', draft })]]
          : [[`Изменить «${button.label}»…`, () => this.deps.openButtons({ label: button.label })]];
        if (!suggested && this.origins.get(button.label.toLowerCase()) !== 'workspace' && this.deps.workspaceOpen()) {
          items.push(['Выключить в этом воркспейсе', () => void this.deps.disableButton('workspace', button.label).then((r) => r.error && this.say(target, `${button.label}: ${r.error}`, true))]);
        }
        this.deps.menu(node, node.textContent ?? '', items);
      });
      return node;
    };
    const gear = el('button', 'command-gear', '⚙') as HTMLButtonElement;
    gear.type = 'button';
    gear.title = 'Кнопки…';
    gear.setAttribute('aria-label', 'Кнопки');
    gear.addEventListener('click', () => this.deps.openButtons());
    // Черта на стыке кнопок общих слоёв и воркспейса.
    const own = (button: CommandButton): boolean => this.origins.get(button.label.toLowerCase()) === 'workspace';
    const placed = this.commands.flatMap((button, index) => {
      const node = make(button, false);
      return index > 0 && own(button) !== own(this.commands[index - 1]) ? [el('span', 'command-separator'), node] : [node];
    });
    bar.buttons.replaceChildren(...placed, ...bar.suggested.map((button) => make(button, true)), gear);
    this.renderNotice(bar);
  }

  private renderNotice(bar: Bar): void {
    const { said, announce } = bar;
    if (announce && !said) {
      const verbs = { added: 'добавила кнопку', changed: 'изменила кнопку', disabled: 'выключила кнопку', enabled: 'включила кнопку' };
      const text = `Сессия ${verbs[announce.verb]} «${announce.label}»${announce.hotkey ? ` (${announce.hotkey})` : ''}${announce.took?.length ? `; сочетание взято у ${announce.took.map((t) => `«${t}»`).join(', ')}` : ''}`;
      const undo = el('button', '', 'Отменить') as HTMLButtonElement;
      undo.type = 'button';
      undo.addEventListener('click', () => {
        bar.announce = null;
        void this.deps.undoButtons(announce.undo).then((r) => {
          bar.said = r.error ? { text: r.error, warn: true } : null;
          this.renderNotice(bar);
        });
        this.renderNotice(bar);
      });
      const edit = el('button', '', 'Изменить…') as HTMLButtonElement;
      edit.type = 'button';
      edit.addEventListener('click', () => this.deps.openButtons({ layer: announce.layer === 'all' ? 'global' : 'workspace', label: announce.label }));
      const close = el('button', 'command-announce-close', '✕') as HTMLButtonElement;
      close.type = 'button';
      close.title = 'Закрыть';
      close.setAttribute('aria-label', 'Закрыть уведомление');
      close.addEventListener('click', () => {
        bar.announce = null;
        this.renderNotice(bar);
      });
      const box = el('span', 'command-announce', text);
      box.append(undo, edit, close);
      bar.notice.classList.remove('warn');
      bar.notice.title = '';
      bar.notice.replaceChildren(box);
      return;
    }
    bar.notice.classList.toggle('warn', !!said?.warn || (!said && this.problems.length > 0));
    bar.notice.title = said ? '' : this.problems.join('\n');
    bar.notice.textContent = said ? said.text : this.problems.length ? `Кнопки: замечаний ${this.problems.length}` : '';
  }

  /** Сообщение у полосы; null - убрать. Само гаснет: пока идёт работа, застрявшая фраза вводила бы в заблуждение. */
  private say(target: CommandTarget, text: string | null, warn = false): void {
    const bar = this.bars.get(target);
    if (!bar) return;
    window.clearTimeout(bar.timer);
    bar.said = text === null ? null : { text, warn };
    this.renderNotice(bar);
    if (text !== null && warn) {
      bar.timer = window.setTimeout(() => {
        bar.said = null;
        this.renderNotice(bar);
      }, SAID_MS);
    }
  }
}
