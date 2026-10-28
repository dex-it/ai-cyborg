import { basename } from './dom';
import type { TreeRoot } from './tree';

/** Что нужно знать о сессии, чтобы построить корни её дерева. */
export interface RootsInput {
  /** Репозиторий, где сессия стартовала (каталог запуска). */
  repo: string;
  /** Текущий корень: тот же репозиторий, его worktree либо другой репозиторий проекта, куда ушёл cwd. */
  root: string;
  /** Репозитории проекта. */
  repos: string[];
}

const inside = (dir: string, repo: string): boolean => dir === repo || dir.startsWith(`${repo}/`) || dir.startsWith(`${repo}\\`);

// Сессия уходит и в worktree репозитория из --add-dir (<репозиторий>/.claude/worktrees/<имя>); worktree вне проекта - стартового.
function ownerRepo(s: RootsInput): string {
  const owners = s.repos.filter((r) => inside(s.root, r));
  return owners.length ? owners.reduce((a, b) => (b.length > a.length ? b : a)) : s.repo;
}

export function rootLabel(s: RootsInput): string {
  const owner = ownerRepo(s);
  return s.root === owner ? basename(s.root) : `${basename(owner)} ⎇ ${basename(s.root)}`;
}

/** Свой корень первым, затем прочие репозитории проекта; путь корня не повторяется. */
export function treeRoots(s: RootsInput): TreeRoot[] {
  const owner = ownerRepo(s);
  const own: TreeRoot = {
    path: s.root,
    label: rootLabel(s),
    hint: s.root === s.repo ? 'репозиторий сессии' : s.root === owner ? 'другой репозиторий проекта, куда перешёл рабочий каталог сессии' : `worktree репозитория ${owner}`,
  };
  const others = s.repos
    .filter((r) => r !== owner)
    .map((r) => ({
      path: r,
      label: basename(r),
      hint: r === s.repo ? 'репозиторий, где сессия была запущена' : 'другой репозиторий проекта, доступен сессии через --add-dir',
    }));
  return [own, ...others];
}
