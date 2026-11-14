/** Как часто окно без фокуса отдаёт накопленный вывод в терминал: спиннер Claude пишет ~80 раз в секунду, и каждое окно перерисовывало бы его на 60 кадрах. */
export const UNFOCUSED_FLUSH_MS = 250;

// Запрос терминалу (DA, DSR, цвет OSC 10-12, режим DECRQM, XTGETTCAP, клавиатура kitty): программа ждёт ответа с коротким таймаутом, и без ответа решила бы, что терминал возможности не знает.
const TERMINAL_QUERY = /\x1b\[[?>=]?[\d;]*[cn]|\x1b\[\?u|\x1b\[[?\d;]*\$p|\x1b\[[\d;]*t|\x1b\]1[0-2];\?|\x1bP[+$]q/;

export interface OutputGateDeps<K> {
  focused: () => boolean;
  write: (key: K, data: string) => void;
  setTimer: (fn: () => void, ms: number) => void;
}

/** Вывод сессий: в окне с фокусом и с запросом терминалу уходит в терминал сразу, без фокуса копится и уходит пачкой раз в UNFOCUSED_FLUSH_MS. */
export class OutputGate<K> {
  private readonly pending = new Map<K, string[]>();
  private scheduled = false;

  constructor(private readonly deps: OutputGateDeps<K>) {}

  push(key: K, data: string): void {
    if (this.deps.focused() || TERMINAL_QUERY.test(data)) {
      this.flush(key);
      this.deps.write(key, data);
      return;
    }
    const chunks = this.pending.get(key);
    if (chunks) chunks.push(data);
    else this.pending.set(key, [data]);
    if (this.scheduled) return;
    this.scheduled = true;
    this.deps.setTimer(() => {
      this.scheduled = false;
      this.flushAll();
    }, UNFOCUSED_FLUSH_MS);
  }

  /** Отдать накопленное одной сессии: перед любой своей записью в её терминал, иначе порядок вывода нарушится. */
  flush(key: K): void {
    const chunks = this.pending.get(key);
    if (!chunks) return;
    this.pending.delete(key);
    this.deps.write(key, chunks.join(''));
  }

  flushAll(): void {
    for (const key of [...this.pending.keys()]) this.flush(key);
  }

  drop(key: K): void {
    this.pending.delete(key);
  }
}
