const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Давность для списка сессий: «только что», «5 мин», «3 ч», «2 дн», старше недели - дата. */
export function ago(time: number, now: number): string {
  const delta = Math.max(0, now - time);
  if (delta < MINUTE) return 'только что';
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)} мин`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)} ч`;
  if (delta < 7 * DAY) return `${Math.floor(delta / DAY)} дн`;
  return new Date(time).toLocaleDateString('ru-RU');
}
