/** Модель окна поиска: сравнение запроса с именем, подбор и порядок результатов, перемещение по списку. Без DOM. */

export interface SearchOptions {
  /** Запрос - регулярное выражение JavaScript, а не подстрока. */
  regex: boolean;
  caseSensitive: boolean;
}

/** Совпавшая часть имени: [start, end) по индексам строки. */
export interface MatchRange {
  start: number;
  end: number;
}

export type Matcher = { ok: true; match: (text: string) => MatchRange | null } | { ok: false; error: string };

/** Длиннее выражение не разбирается: страхует от вставки целого текста в поле. */
export const MAX_PATTERN_LENGTH = 200;

/**
 * У RegExp JavaScript нет таймаута, поэтому выражение с квантором над группой, внутри которой тоже квантор
 * (`(a+)+`, `(.*)*`, `(a|b*)+`), отклоняется: на нём движок уходит в экспоненциальный перебор и вешает окно.
 */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,\d*\})/;

export function compileMatcher(query: string, options: SearchOptions): Matcher {
  if (!options.regex) {
    const needle = options.caseSensitive ? query : query.toLocaleLowerCase();
    return {
      ok: true,
      match: (text) => {
        const at = (options.caseSensitive ? text : text.toLocaleLowerCase()).indexOf(needle);
        return at < 0 ? null : { start: at, end: at + needle.length };
      },
    };
  }
  if (query.length > MAX_PATTERN_LENGTH) return { ok: false, error: `Выражение длиннее ${MAX_PATTERN_LENGTH} знаков` };
  if (NESTED_QUANTIFIER.test(query)) return { ok: false, error: 'Выражение слишком сложное: квантор над группой с квантором' };
  let pattern: RegExp;
  try {
    pattern = new RegExp(query, options.caseSensitive ? '' : 'i');
  } catch (error) {
    return { ok: false, error: `Выражение не разобрано: ${(error as Error).message.replace(/^Invalid regular expression: /, '')}` };
  }
  return {
    ok: true,
    match: (text) => {
      const found = pattern.exec(text);
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

/** Следующий активный результат по клавише стрелки; по кругу. null - клавиша не для списка или список пуст. */
export function moveActive(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  if (key === 'ArrowDown') return (index + 1) % count;
  if (key === 'ArrowUp') return (index - 1 + count) % count;
  return null;
}
