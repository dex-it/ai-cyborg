/** Клавиатурное управление деревом файлов: чистая логика по плоскому списку видимых строк, без DOM. */

/** Видимая строка дерева: глубина (aria-level), каталог или корень (можно раскрыть) и раскрыта ли она. */
export interface KeyRow {
  level: number;
  expandable: boolean;
  expanded: boolean;
}

/** focus - перевести фокус на строку; click - нажать строку как мышью (раскрыть, свернуть, открыть файл); none - клавиша дерева, но делать нечего. */
export type TreeKeyAction = { kind: 'focus' | 'click'; index: number } | { kind: 'none' };

const NONE: TreeKeyAction = { kind: 'none' };

/** Что делать по клавише на строке index; null - клавиша не для дерева. */
export function treeKeyAction(key: string, rows: readonly KeyRow[], index: number): TreeKeyAction | null {
  const row = rows[index];
  if (!row) return null;
  const focus = (target: number): TreeKeyAction => (target >= 0 && target < rows.length && target !== index ? { kind: 'focus', index: target } : NONE);
  switch (key) {
    case 'ArrowDown':
      return focus(index + 1);
    case 'ArrowUp':
      return focus(index - 1);
    case 'Home':
      return focus(0);
    case 'End':
      return focus(rows.length - 1);
    case 'ArrowRight':
      if (!row.expandable) return NONE;
      if (!row.expanded) return { kind: 'click', index };
      // Первый потомок идёт сразу за раскрытой строкой и глубже её; у пустого каталога следующая строка не глубже.
      return rows[index + 1] && rows[index + 1].level > row.level ? focus(index + 1) : NONE;
    case 'ArrowLeft':
      if (row.expandable && row.expanded) return { kind: 'click', index };
      return focus(parentIndex(rows, index));
    case 'Enter':
    case ' ':
      return { kind: 'click', index };
    default:
      return null;
  }
}

/** Ближайшая выше строка с меньшей глубиной; -1 у корня. */
export function parentIndex(rows: readonly KeyRow[], index: number): number {
  for (let i = index - 1; i >= 0; i--) if (rows[i].level < rows[index].level) return i;
  return -1;
}

const SEP = '\u0001';

/** Ключ строки, переживающий перерисовку: путь корня и относительный путь внутри него (у самого корня пустой). */
export const rowKey = (rootPath: string, rel: string): string => `${rootPath}${SEP}${rel}`;

/** Ключ родителя: каталог выше, у верхней строки каталога - корень; у корня null. */
export function parentKey(key: string): string | null {
  const at = key.indexOf(SEP);
  const rel = key.slice(at + 1);
  if (!rel) return null;
  return key.slice(0, at + 1) + (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
}

/** Строка, на которую вернуть фокус после перерисовки: та же, иначе ближайший родитель, иначе первая; -1 при пустом дереве. */
export function restoreIndex(keys: readonly string[], wanted: string | null): number {
  if (!keys.length) return -1;
  for (let key = wanted; key !== null; key = parentKey(key)) {
    const found = keys.indexOf(key);
    if (found >= 0) return found;
  }
  return 0;
}

/** Единственная строка дерева в порядке табуляции: выбранная, иначе первая; -1 при пустом дереве. */
export function tabStopIndex(selected: readonly boolean[]): number {
  if (!selected.length) return -1;
  return Math.max(0, selected.indexOf(true));
}
