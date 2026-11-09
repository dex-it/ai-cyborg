import { branchNameProblem } from '../branch-name';
import type { Project } from '../projects';
import { cleanMessage } from '../clean-text';
import { promptProblem } from '../session-tools';

export interface RemoteCreateArgs {
  host: string;
  repo: string;
  branch: string;
  prompt?: string;
}

/** Аргументы remote:create из интерфейса: главный процесс им не доверяет (ADR-0002 п.5); ошибка - строка с причиной. */
export function validateRemoteCreate(value: unknown, project: Project | undefined): RemoteCreateArgs | string {
  if (!project || typeof value !== 'object' || value === null) return 'Некорректные аргументы remote:create';
  const { host, repo, branch, prompt } = value as Record<string, unknown>;
  if (typeof host !== 'string' || !(project.hosts ?? []).includes(host)) return 'хост не из списка проекта';
  if (typeof repo !== 'string' || !project.repos.includes(repo)) return 'репозиторий не из проекта';
  const problem = branchNameProblem(branch);
  if (problem) return problem;
  const out: RemoteCreateArgs = { host, repo, branch: branch as string };
  if (prompt === undefined || prompt === null) return out;
  if (typeof prompt !== 'string') return 'задание - строка';
  const promptBad = promptProblem(prompt, 'задание');
  if (promptBad) return promptBad;
  const clean = cleanMessage(prompt);
  return clean ? { ...out, prompt: clean } : out;
}

export const REMOTE_FS_OPS = ['list', 'read', 'root', 'branch', 'status', 'head'] as const;
export type RemoteFsOp = (typeof REMOTE_FS_OPS)[number];

/** Аргументы remote:fs из интерфейса: номер вкладки и операция из читающего списка; иначе null. Правка файлов и смена ветки в список не входят. */
export function validateRemoteFs(id: unknown, op: unknown): { id: number; op: RemoteFsOp } | null {
  if (typeof id !== 'number' || !REMOTE_FS_OPS.includes(op as RemoteFsOp)) return null;
  return { id, op: op as RemoteFsOp };
}
