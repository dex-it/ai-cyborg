/** Копирование - ответ программы на действие человека: позже вывод сам подменил бы буфер, например командой для вставки. */
export const OSC52_USER_WINDOW_MS = 3000;
const MAX_PAYLOAD = 4 * 1024 * 1024;

/** Текст записи в буфер обмена из тела OSC 52 (`Pc;base64`); запрос чтения `?`, негодный и слишком большой base64 - undefined. */
export function osc52Text(data: string): string | undefined {
  const sep = data.indexOf(';');
  if (sep < 0) return undefined;
  const payload = data.slice(sep + 1);
  if (payload === '?' || payload.length > MAX_PAYLOAD || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return undefined;
  try {
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Запись принимается от терминала в фокусе и вскоре после клавиши или кнопки мыши. */
export function osc52Allowed(focused: boolean, now: number, lastUserAt: number): boolean {
  return focused && now - lastUserAt >= 0 && now - lastUserAt <= OSC52_USER_WINDOW_MS;
}
