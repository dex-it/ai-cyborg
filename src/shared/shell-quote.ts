const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Строка в одинарных кавычках для sh: одинарная кавычка внутри закрывает и открывает кавычки заново. */
export function shQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/** Как shlex.quote: безопасное слово как есть, иначе shQuote. */
export function shellQuote(word: string): string {
  return SAFE.test(word) ? word : shQuote(word);
}
