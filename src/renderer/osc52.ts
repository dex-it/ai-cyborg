/** Текст записи в буфер обмена из тела OSC 52 (`Pc;base64`); запрос чтения `?` и негодный base64 - undefined. */
export function osc52Text(data: string): string | undefined {
  const sep = data.indexOf(';');
  if (sep < 0) return undefined;
  const payload = data.slice(sep + 1);
  if (payload === '?' || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return undefined;
  try {
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}
