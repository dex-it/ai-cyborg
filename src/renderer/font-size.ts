import { readPref, writePref } from './prefs';

export const DEFAULT_FONT_SIZE = 13;
const MIN = 8;
const MAX = 32;
const KEY = 'cyborg.fontSize';

/** Шаг колеса: вверх (deltaY < 0) крупнее, вниз мельче, в пределах [MIN, MAX]. */
export function stepFontSize(size: number, deltaY: number): number {
  if (!deltaY) return size;
  return Math.min(MAX, Math.max(MIN, size + (deltaY < 0 ? 1 : -1)));
}

export function parseFontSize(raw: string | null): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= MIN && n <= MAX ? n : DEFAULT_FONT_SIZE;
}

export function loadFontSize(): number {
  return parseFontSize(readPref(KEY));
}

export function saveFontSize(size: number): void {
  writePref(KEY, String(size));
}
