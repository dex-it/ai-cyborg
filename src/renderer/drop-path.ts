/** Тип dataTransfer, которым строка дерева отдаёт свой абсолютный путь. */
export const TREE_PATH_MIME = 'application/x-cyborg-path';

const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Как shlex.quote: безопасный путь как есть, иначе в одинарных кавычках, внутренняя кавычка - '\''. */
export function shellQuote(path: string): string {
  return SAFE.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`;
}

const CONTROL = /[\x00-\x1f\x7f]/;

/**
 * Пути через пробел с завершающим пробелом; нет путей - ''. Пустые пути и пути с управляющими символами
 * отбрасываются: CR/LF/ESC в имени файла при вставке без bracketed paste отправили бы ввод в процесс.
 */
export function pastePaths(paths: readonly string[]): string {
  const quoted = paths.filter((p) => p && !CONTROL.test(p)).map(shellQuote);
  return quoted.length ? `${quoted.join(' ')} ` : '';
}

/** Пути брошенного: строка дерева несёт свой путь, иначе берутся файлы ОС через pathOf. */
export function droppedPaths(
  data: Pick<DataTransfer, 'types' | 'getData' | 'files'>,
  pathOf: (file: File) => string,
): string[] {
  if (Array.from(data.types).includes(TREE_PATH_MIME)) return [data.getData(TREE_PATH_MIME)];
  return Array.from(data.files).map(pathOf);
}

export function acceptsDrop(types: readonly string[]): boolean {
  return types.includes('Files') || types.includes(TREE_PATH_MIME);
}
