import { gitCommonDir, gitRoot } from './git';
import { resumeCwd } from './history';

export interface LiveSession {
  cwd: string;
  resume: string | null;
}

// Дерево сессии настройки (D-55): worktree из журнала, живой cwd - запасной; чужой репозиторий и убранный worktree дают репозиторий строки.
export async function sessionTree(repo: string, live: LiveSession | null, journalRoot?: string): Promise<string> {
  const cwd = (live?.resume ? resumeCwd(repo, live.resume, journalRoot) : undefined) ?? live?.cwd ?? repo;
  const root = await gitRoot(cwd);
  if (!root || root === repo) return repo;
  const [own, common] = await Promise.all([gitCommonDir(repo), gitCommonDir(root)]);
  return own && own === common ? root : repo;
}
