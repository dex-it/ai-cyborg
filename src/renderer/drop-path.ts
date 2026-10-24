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

/** Строка дерева становится источником перетаскивания: dragstart отдаёт путь в своём типе и разрешает только копирование. */
export function makeDraggable(row: HTMLElement, path: string): void {
  row.draggable = true;
  row.addEventListener('dragstart', (event) => {
    if (!event.dataTransfer) return;
    event.dataTransfer.setData(TREE_PATH_MIME, path);
    event.dataTransfer.effectAllowed = 'copy';
  });
}

export interface DropTarget {
  exited: boolean;
  term: { paste(text: string): void };
}

/** Решение броска: завершённой сессии и пустому тексту - ни вставки, ни показа терминала; иначе один paste и showTerminal. */
export function dropIntoSession(
  session: DropTarget,
  data: Pick<DataTransfer, 'types' | 'getData' | 'files'>,
  pathOf: (file: File) => string,
  showTerminal: () => void,
): void {
  if (session.exited) return;
  const text = pastePaths(droppedPaths(data, pathOf));
  if (!text) return;
  session.term.paste(text);
  showTerminal();
}
