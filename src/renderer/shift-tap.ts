/** Отдельное нажатие Shift: дольше этого - уже не нажатие, а удержание. */
export const SHIFT_TAP_MS = 800;

export interface KeyLike {
  type: string;
  key: string;
  repeat?: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** Shift нажат и отпущен сам по себе, при выделении в терминале; щелчок мыши между ними (выделение с Shift) не считается. */
export class ShiftTap {
  private armedAt: number | null = null;

  /** Клавиша терминала; true - нажатие Shift состоялось. */
  key(event: KeyLike, at: number, hasSelection: boolean): boolean {
    if (event.key !== 'Shift') {
      if (event.type === 'keydown') this.armedAt = null;
      return false;
    }
    if (event.type === 'keydown') {
      if (!event.repeat) this.armedAt = hasSelection && !event.ctrlKey && !event.altKey && !event.metaKey ? at : null;
      return false;
    }
    if (event.type !== 'keyup' || this.armedAt === null) return false;
    const fired = at - this.armedAt <= SHIFT_TAP_MS && hasSelection;
    this.armedAt = null;
    return fired;
  }

  /** Кнопка мыши: Shift держат для выделения, а не нажимают. */
  pointer(): void {
    this.armedAt = null;
  }
}

/** Выделение держится у программы, а не в xterm, дольше этого после её копирования не считается живым. */
export const APP_SELECTION_MS = 60_000;

/** Выделение, которое программа в терминале (Claude Code) ведёт сама и копирует в буфер: xterm его не видит. */
export class AppSelection {
  private text: string | null = null;
  private at: number | null = null;
  private downAt: { x: number; y: number } | null = null;

  /** Программа записала выделенное в буфер через OSC 52. */
  copied(text: string, at: number): void {
    if (!text.trim()) return;
    this.text = text;
    this.at = at;
  }

  pointerDown(x: number, y: number): void {
    this.text = null;
    this.at = null;
    this.downAt = { x, y };
  }

  /** Протяжка мышью без выделения в xterm - выделяла программа; её копия могла уйти мимо OSC 52, в системный буфер. */
  pointerUp(x: number, y: number, at: number, xtermSelected: boolean): void {
    const from = this.downAt;
    this.downAt = null;
    if (!from || xtermSelected || Math.hypot(x - from.x, y - from.y) < 4) return;
    if (this.at === null || this.text === null) this.at = at;
  }

  /** Клавиша, кроме модификаторов, снимает выделение программы. */
  key(key: string): void {
    if (key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta') return;
    this.text = null;
    this.at = null;
  }

  live(now: number): boolean {
    return this.at !== null && now - this.at >= 0 && now - this.at <= APP_SELECTION_MS;
  }

  /** Текст из OSC 52, если программа его прислала; иначе undefined - читать системный буфер. */
  copiedText(now: number): string | undefined {
    return this.live(now) && this.text !== null ? this.text : undefined;
  }
}
