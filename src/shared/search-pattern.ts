/** Общее для окна поиска и главного процесса: параметры запроса, разбор в выражение, формат ответа каналов поиска. */

export interface SearchOptions {
  /** Запрос - регулярное выражение, а не подстрока. */
  regex: boolean;
  caseSensitive: boolean;
  /** Совпадение не должно примыкать к буквам, цифрам и `_`. */
  wholeWord: boolean;
}

/** Совпавшая часть текста: [start, end) по индексам строки. */
export interface MatchRange {
  start: number;
  end: number;
}

/** Длиннее выражение не разбирается: страхует от вставки целого текста в поле. */
export const MAX_PATTERN_LENGTH = 200;
/** Предел подстроки (аргумент git); выражение ограничено строже. */
export const MAX_QUERY_LENGTH = 500;
/** Показываемое число результатов поиска по содержимому и изменениям. */
export const MAX_HITS = 500;
/** Строка результата обрезается до этой длины: минифицированные файлы не должны раздувать ответ. */
export const MAX_LINE_LENGTH = 300;

export interface SearchRequest {
  /** Корень (репозиторий), по которому идёт поиск. */
  root: string;
  query: string;
  options: SearchOptions;
}

/** Совпавшая строка: файл относительно корня, номер строки в рабочем файле, текст и граница совпадения в нём. */
export interface LineHit {
  rel: string;
  line: number;
  text: string;
  range: MatchRange | null;
  /** Только у поиска по изменениям: строка добавлена либо удалена (у удалённой номер - место удаления в рабочем файле). */
  sign?: '+' | '-';
}

export interface SearchReply {
  hits: LineHit[];
  /** Запрос вытеснен более новым того же вида: ответ не нужен. */
  cancelled?: true;
  /** Совпадений больше показанных. */
  truncated: boolean;
  /** Причина, по которой поиска нет (негодное выражение, git без PCRE, таймаут). */
  error?: string;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Знаки слова для «целого слова»: `\w`, латиница с диакритикой и кириллица (`\w` кириллицу не знает). */
const WORD = '\\w\\u00C0-\\u024F\\u0400-\\u04FF';

/** RegExp JavaScript нужен выражению и «целому слову»; обычная подстрока без «целого слова» ищется `indexOf`. */
export function patternOf(query: string, options: SearchOptions): { source: string; flags: string } | null {
  if (!options.regex && !options.wholeWord) return null;
  const body = options.regex ? query : escapeRegExp(query);
  const source = options.wholeWord ? `(?<![${WORD}])(?:${body})(?![${WORD}])` : body;
  return { source, flags: options.caseSensitive ? '' : 'i' };
}

/**
 * У RegExp JavaScript в окне нет таймаута, поэтому выражение с квантором над группой, внутри которой тоже квантор
 * (`(a+)+`, `(.*)*`, `(a|b*)+`), отклоняется: на нём движок уходит в экспоненциальный перебор и вешает окно.
 */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,\d*\})/;

export const isHeavyPattern = (query: string): boolean => NESTED_QUANTIFIER.test(query);

/** Запрос допустим для аргумента git и RegExp: непустой, в пределе, без перевода строки (git читает его как несколько шаблонов) и NUL. */
export function queryProblem(query: string, options: SearchOptions): string | null {
  if (!query.trim()) return 'Запрос пуст';
  if (/[\0\r\n]/.test(query)) return 'В запросе недопустим перевод строки';
  const limit = options.regex ? MAX_PATTERN_LENGTH : MAX_QUERY_LENGTH;
  if (query.length > limit) return `${options.regex ? 'Выражение' : 'Запрос'} длиннее ${limit} знаков`;
  return null;
}

/** Строка результата без хвоста и отступа; граница совпадения пересчитана на урезанный текст. */
export function lineHit(rel: string, line: number, raw: string, range: MatchRange | null, sign?: '+' | '-'): LineHit {
  const lead = raw.length - raw.trimStart().length;
  const shift = Math.min(lead, range ? range.start : lead);
  const text = raw.slice(shift, shift + MAX_LINE_LENGTH).trimEnd();
  const shifted = range && range.start - shift < text.length ? { start: range.start - shift, end: Math.min(range.end - shift, text.length) } : null;
  return { rel, line, text, range: shifted, ...(sign ? { sign } : {}) };
}
