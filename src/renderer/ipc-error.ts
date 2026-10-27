/** Текст ошибки вызова главного процесса без служебной обёртки Electron («Error invoking remote method 'канал': Error: …»). */
export function ipcErrorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '');
}
