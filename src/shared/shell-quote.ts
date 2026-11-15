const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Как shlex.quote: безопасное слово как есть, иначе в одинарных кавычках, внутренняя кавычка - '\''. */
export function shellQuote(word: string): string {
  return SAFE.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}
