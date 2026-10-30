// Общее для Jira в главном процессе и интерфейсе: форма ключа, предел проектов, время jira-cli. Чистый файл без Node: renderer берёт значения из main только из таких.

/** Ключ проекта Jira в том виде, в каком он попадает в аргумент `-p`: ничего, кроме букв, цифр и «_». */
export const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Сколько проектов Jira можно выбрать: на каждый идут свои вызовы `jira`. */
export const MAX_JIRA_PROJECTS = 10;

/** Ключ, введённый в поиск проектов: не по форме, уже выбран, выбор полон (ввод остаётся в поле) или добавляется. */
export function typedKey(typed: string, selected: readonly string[]): 'invalid' | 'chosen' | 'full' | 'add' {
  if (!PROJECT_KEY.test(typed)) return 'invalid';
  if (selected.includes(typed.toUpperCase())) return 'chosen';
  return selected.length >= MAX_JIRA_PROJECTS ? 'full' : 'add';
}

/** Время из jira-cli (`+0300` без двоеточия) в миллисекунды; не разобралось - 0. */
export function timeOf(value: string): number {
  const ms = Date.parse(value.replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
  return Number.isNaN(ms) ? 0 : ms;
}
