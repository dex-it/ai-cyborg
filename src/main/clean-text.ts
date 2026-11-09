/** Управляющие символы (кроме перевода строки и табуляции) вычищаются: ESC закрыл бы вставку и дальше текст пошёл бы в TUI клавишами. */
export function cleanMessage(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').trim();
}
