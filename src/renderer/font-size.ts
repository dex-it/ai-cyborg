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

/** Один шаг размера - сколько пикселей прокрутки: ровно одно деление колеса мыши (deltaY 100), тачпад накапливает мелкие события. */
export const WHEEL_STEP_PX = 100;
/** Пауза, после которой накопленная прокрутка забывается: новый жест не доедает остаток прежнего. */
export const WHEEL_IDLE_MS = 250;

/**
 * Колесо с клавишей команд: тачпад шлёт десятки событий deltaY по 1-5 пикселей на один жест, и шаг на каждое событие
 * гнал размер от 13 до предела за долю секунды. Накопитель отдаёт шаг, когда прокрутка набрала WHEEL_STEP_PX в одну сторону.
 */
export class WheelStepper {
  private acc = 0;
  private last = Number.NEGATIVE_INFINITY;

  /** Знак шага как у deltaY (отрицательный - крупнее, положительный - мельче) либо 0, если шага ещё нет. */
  push(deltaY: number, now: number): number {
    if (!deltaY) return 0;
    if (now - this.last > WHEEL_IDLE_MS || Math.sign(deltaY) !== Math.sign(this.acc)) this.acc = 0;
    this.last = now;
    this.acc += deltaY;
    if (Math.abs(this.acc) < WHEEL_STEP_PX) return 0;
    const step = Math.sign(this.acc);
    this.acc = 0;
    return step;
  }
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
