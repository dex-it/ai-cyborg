// Хранилище окна бывает недоступно: тогда настройка действует до закрытия окна.
export function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // см. выше
  }
}

/** Сохранённое значение, если оно из допустимых, иначе fallback: прежняя версия могла записать снятый вариант. */
export function readChoice<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const raw = readPref(key);
  return allowed.includes(raw as T) ? (raw as T) : fallback;
}
