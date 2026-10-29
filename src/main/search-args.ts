import { queryProblem, type SearchOptions, type SearchRequest } from '../shared/search-pattern';

/**
 * Проверка аргумента каналов поиска. Граница процессов типов не знает: запрос идёт аргументом git, поэтому форма и размер
 * проверяются здесь, а не в интерфейсе. Иное - null.
 */
export function validateSearchRequest(value: unknown): SearchRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const { root, query, options } = value as Record<string, unknown>;
  if (typeof root !== 'string' || typeof query !== 'string' || typeof options !== 'object' || options === null) return null;
  const { regex, caseSensitive, wholeWord } = options as Record<string, unknown>;
  if (typeof regex !== 'boolean' || typeof caseSensitive !== 'boolean' || typeof wholeWord !== 'boolean') return null;
  const valid: SearchOptions = { regex, caseSensitive, wholeWord };
  return queryProblem(query, valid) === null ? { root, query, options: valid } : null;
}
