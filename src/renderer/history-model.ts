import type { HistoryEntry } from '../main/history';
import { basename } from './dom';

/** Избранные первыми, внутри групп свежие первыми: снятая звезда возвращает сессию на её место по времени. */
export function historyOrder<T extends Pick<HistoryEntry, 'favorite' | 'updated'>>(entries: readonly T[]): T[] {
  const byTime = [...entries].sort((a, b) => b.updated - a.updated);
  return [...byTime.filter((e) => e.favorite), ...byTime.filter((e) => !e.favorite)];
}

/** Отбор вкладки «Сессии»: каждое слово запроса без учёта регистра есть в заголовке, имени репозитория или хосте. */
export function historyMatch(entry: Pick<HistoryEntry, 'title' | 'repo' | 'host'>, query: string): boolean {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [entry.title, basename(entry.repo), entry.host ?? ''].join('\n').toLocaleLowerCase();
  return words.every((w) => hay.includes(w));
}
