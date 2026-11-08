/** Щелчок по пункту: `toggle` переключает его, `range` выделяет пункты от опорного до этого, без опорного - один пункт. */
export function clickSelection(ids: readonly string[], selected: ReadonlySet<string>, anchor: string | null, id: string, mode: 'toggle' | 'range'): Set<string> {
  const next = new Set(selected);
  const from = anchor === null ? -1 : ids.indexOf(anchor);
  const to = ids.indexOf(id);
  if (to < 0) return next;
  if (mode === 'range' && from >= 0) {
    const [start, end] = from < to ? [from, to] : [to, from];
    return new Set(ids.slice(start, end + 1));
  }
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** «1 сессию», «3 сессии», «5 сессий». */
export function sessionsCount(n: number): string {
  const tens = n % 100;
  const ones = n % 10;
  const word = tens >= 11 && tens <= 14 ? 'сессий' : ones === 1 ? 'сессию' : ones >= 2 && ones <= 4 ? 'сессии' : 'сессий';
  return `${n} ${word}`;
}
