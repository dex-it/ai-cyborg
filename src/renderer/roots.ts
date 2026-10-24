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

const movedToOtherRepo = (s: RootsInput): boolean => s.root !== s.repo && s.repos.includes(s.root);

export function rootLabel(s: RootsInput): string {
  return s.root === s.repo || movedToOtherRepo(s) ? basename(s.root) : `${basename(s.repo)} ⎇ ${basename(s.root)}`;
}

/** Свой корень первым, затем прочие репозитории проекта; путь корня не повторяется. */
export function treeRoots(s: RootsInput): TreeRoot[] {
  const moved = movedToOtherRepo(s);
  const own: TreeRoot = {
    path: s.root,
    label: rootLabel(s),
    hint: s.root === s.repo ? 'репозиторий сессии' : moved ? 'другой репозиторий проекта, куда перешёл рабочий каталог сессии' : `worktree репозитория ${s.repo}`,
  };
  const others = s.repos
    .filter((r) => r !== s.root && (r !== s.repo || moved))
    .map((r) => ({
      path: r,
      label: basename(r),
      hint: r === s.repo ? 'репозиторий, где сессия была запущена' : 'другой репозиторий проекта, доступен сессии через --add-dir',
    }));
  return [own, ...others];
}
