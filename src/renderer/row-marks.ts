/**
 * Строка списка, с которой человек ушёл в сессию: при возвращении на панель она подсвечена и видна.
 * Строки регистрируются при каждой перерисовке, метка переживает её.
 */
export class RowMarks {
  private readonly rows = new Map<string, HTMLElement>();
  private key: string | null = null;

  /** Перед перерисовкой списка: прежние строки уйдут из DOM. */
  clear(): void {
    this.rows.clear();
  }

  register(key: string, row: HTMLElement): HTMLElement {
    this.rows.set(key, row);
    row.classList.toggle('returned', key === this.key);
    return row;
  }

  /** null снимает метку. */
  set(key: string | null): void {
    this.key = key;
    for (const [rowKey, row] of this.rows) row.classList.toggle('returned', rowKey === key);
  }

  /** Строка есть в показанном списке; под фильтром её может не быть. */
  reveal(key: string): boolean {
    this.set(key);
    const row = this.rows.get(key);
    if (!row) return false;
    if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
    return true;
  }
}
