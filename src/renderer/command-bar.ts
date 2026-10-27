// Полоса кнопок-команд под терминалом сессии (фича 12): кнопки из встроенного набора и файла воркспейса, отправка текста в сессию.

import {
  DEFAULT_COMMANDS,
  expandCommand,
  hotkeyMatches,
  mergeCommands,
  parseCommands,
  parseHotkey,
  placeholdersOf,
  type CommandButton,
  type Hotkey,
  type Placeholder,
  type PlaceholderValues,
} from '../main/commands';
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
}

interface Bar {
  root: HTMLElement;
  buttons: HTMLElement;
  notice: HTMLElement;
  said: { text: string; warn: boolean } | null;
  timer: number | undefined;
}

const SAID_MS = 8000;

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
    this.bars.set(target, { root, buttons, notice, said: null, timer: undefined });
    this.render(target);
    return root;
  }

  detach(target: CommandTarget): void {
    window.clearTimeout(this.bars.get(target)?.timer);
    this.bars.delete(target);
    this.running.delete(target);
  }

  /** Поле commands файла воркспейса как оно записано (или undefined); перерисовка только при изменении. */
  setConfig(raw: unknown): void {
    const key = JSON.stringify(raw ?? null);
    if (key === this.loaded) return;
    this.loaded = key;
    const user = parseCommands(raw, this.deps.mac);
    const merged = mergeCommands(DEFAULT_COMMANDS, user.commands, this.deps.mac);
    this.commands = merged.commands;
    this.problems = [...user.problems, ...merged.problems];
    this.bound = merged.commands.flatMap((button) => {
      const hotkey = button.hotkey ? parseHotkey(button.hotkey, this.deps.mac) : null;
      return hotkey && !('error' in hotkey) ? [{ button, hotkey }] : [];
    });
    for (const target of this.bars.keys()) this.render(target);
    this.deps.layout();
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
      this.deps.send(target.id, button.submit ? `${out.text}\r` : out.text);
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
    bar.buttons.replaceChildren(
      ...this.commands.map((button) => {
        const node = el('button', `command-button${button.submit ? '' : ' no-submit'}`, button.label) as HTMLButtonElement;
        node.type = 'button';
        node.disabled = exited;
        node.title = [button.text, button.submit ? '' : '(текст вставляется без Enter)', button.hotkey ?? ''].filter(Boolean).join('\n');
        if (button.hotkey) node.append(el('span', 'command-hotkey', button.hotkey));
        node.addEventListener('click', () => void this.run(target, button));
        return node;
      }),
    );
    this.renderNotice(bar);
  }

  private renderNotice(bar: Bar): void {
    const { said } = bar;
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
