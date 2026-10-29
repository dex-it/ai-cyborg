/** Модель окна поиска: сравнение запроса с именем, подбор и порядок результатов, перемещение по списку. Без DOM. */

import { isHeavyPattern, MAX_PATTERN_LENGTH, patternOf, type MatchRange, type SearchOptions } from '../shared/search-pattern';

export { MAX_PATTERN_LENGTH };
export type { MatchRange, SearchOptions };

export type Matcher = { ok: true; match: (text: string) => MatchRange | null } | { ok: false; error: string };

/** Запрос разобран в сравнение с текстом; негодное выражение - причина строкой, исключения нет. */
export function compileMatcher(query: string, options: SearchOptions): Matcher {
  const pattern = patternOf(query, options);
  if (!pattern) {
    const needle = options.caseSensitive ? query : query.toLocaleLowerCase();
    return {
      ok: true,
      match: (text) => {
        const at = (options.caseSensitive ? text : text.toLocaleLowerCase()).indexOf(needle);
        return at < 0 ? null : { start: at, end: at + needle.length };
      },
    };
  }
  if (options.regex) {
    if (query.length > MAX_PATTERN_LENGTH) return { ok: false, error: `Выражение длиннее ${MAX_PATTERN_LENGTH} знаков` };
    if (isHeavyPattern(query)) return { ok: false, error: 'Выражение слишком сложное: квантор над группой с квантором' };
  }
  let compiled: RegExp;
  try {
    compiled = new RegExp(pattern.source, pattern.flags);
  } catch (error) {
    return { ok: false, error: `Выражение не разобрано: ${(error as Error).message.replace(/^Invalid regular expression: /, '')}` };
  }
  return {
    ok: true,
    match: (text) => {
      const found = compiled.exec(text);
      return found ? { start: found.index, end: found.index + found[0].length } : null;
    },
  };
}

export interface FileEntry {
  /** Индекс корня в списке корней окна. */
  root: number;
  /** Путь относительно корня, с `/`. */
  rel: string;
}

export interface FileHit extends FileEntry {
  name: string;
  range: MatchRange;
}

export interface FileMatches {
  hits: FileHit[];
  /** Всего совпадений; показаны первые limit. */
  total: number;
}

const nameOf = (rel: string): string => rel.slice(rel.lastIndexOf('/') + 1);

/**
 * Файлы, в имени которых есть совпадение (путь не учитывается). Вперёд идут имена, начинающиеся с совпадения, затем
 * короткие пути, затем по алфавиту; в результат попадают первые limit.
 */
export function matchFiles(entries: FileEntry[], matcher: Matcher & { ok: true }, limit: number): FileMatches {
  const found: FileHit[] = [];
  for (const entry of entries) {
    const name = nameOf(entry.rel);
    const range = matcher.match(name);
    if (range) found.push({ ...entry, name, range });
  }
  found.sort(
    (a, b) =>
      Number(b.range.start === 0) - Number(a.range.start === 0) ||
      a.rel.length - b.rel.length ||
      a.rel.localeCompare(b.rel) ||
      a.root - b.root,
  );
  return { hits: found.slice(0, limit), total: found.length };
}

/** Строка подписи под полем: что нашлось и сколько показано. */
export function resultSummary(shown: number, total: number): string {
  if (!total) return 'Нет совпадений';
  return total > shown ? `Найдено ${total}, показаны первые ${shown}` : `Найдено ${total}`;
}

/** Подпись под полем для поиска по строкам: найдено, обрезано пределом либо нет совпадений. */
export function lineSummary(shown: number, truncated: boolean): string {
  if (!shown) return 'Нет совпадений';
  return truncated ? `Показаны первые ${shown}, уточните запрос` : `Найдено ${shown}`;
}

/** Следующий активный результат по клавише стрелки; по кругу. null - клавиша не для списка или список пуст. */
export function moveActive(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  if (key === 'ArrowDown') return (index + 1) % count;
  if (key === 'ArrowUp') return (index - 1 + count) % count;
  return null;
}
