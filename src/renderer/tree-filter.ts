export interface FilterNode {
  name: string;
  rel: string;
  isDir: boolean;
  children: FilterNode[];
}

export interface FilterResult {
  nodes: FilterNode[];
  matched: number;
}

const nameOf = (rel: string): string => rel.slice(rel.lastIndexOf('/') + 1);

/** Позиция совпадения в имени без учёта регистра; -1 - нет совпадения. */
export const matchAt = (name: string, query: string): number => name.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());

/** Файлы, в имени которых есть query, деревом своих каталогов; в дерево попадают первые limit совпадений. */
export function filterPaths(paths: string[], query: string, limit: number): FilterResult {
  const top: FilterNode[] = [];
  const dirs = new Map<string, FilterNode>();
  let matched = 0;
  for (const rel of [...paths].sort()) {
    if (matchAt(nameOf(rel), query) < 0) continue;
    if (++matched > limit) continue;
    let siblings = top;
    const parts = rel.split('/');
    for (let i = 0; i < parts.length - 1; i++) {
      const dirRel = parts.slice(0, i + 1).join('/');
      let dir = dirs.get(dirRel);
      if (!dir) {
        dir = { name: parts[i], rel: dirRel, isDir: true, children: [] };
        dirs.set(dirRel, dir);
        siblings.push(dir);
      }
      siblings = dir.children;
    }
    siblings.push({ name: parts[parts.length - 1], rel, isDir: false, children: [] });
  }
  sortNodes(top);
  return { nodes: top, matched };
}

function sortNodes(nodes: FilterNode[]): void {
  nodes.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
  for (const node of nodes) sortNodes(node.children);
}
