import { branchNameProblem } from '../branch-name';
import type { Project } from '../projects';
import { cleanMessage } from '../clean-text';
import { promptProblem } from '../session-tools';
import { MAX_HITS, type LineHit, type MatchRange, type SearchReply } from '../../shared/search-pattern';

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

/** Запуск человеком из интерфейса: задание он пишет в терминал сам, поле prompt не принимается (D-32). */
export function validateHumanRemoteCreate(value: unknown, project: Project | undefined): RemoteCreateArgs | string {
  if (typeof value !== 'object' || value === null) return validateRemoteCreate(value, project);
  const { host, repo, branch } = value as Record<string, unknown>;
  return validateRemoteCreate({ host, repo, branch }, project);
}

/**
 * Адрес origin для клона на хосте: учётные данные в http(s)-адресе (`https://пользователь:токен@хост/…`) отбрасываются.
 * Иначе токен из локального `.git/config` лёг бы в `.git/config` клона на диске хоста и в аргументы `git clone`, которые видны в списке процессов (NFR-17001);
 * доступ к хостингу дают токены gh и glab (FR-17016). Пользователь `git` в `ssh://git@хост/…` не секрет и остаётся.
 */
export function hostCloneUrl(url: string): { url: string; stripped: boolean } {
  const m = /^(https?:\/\/)([^/?#]*)(.*)$/is.exec(url);
  const at = m ? m[2].lastIndexOf('@') : -1;
  return m && at >= 0 ? { url: m[1] + m[2].slice(at + 1) + m[3], stripped: true } : { url, stripped: false };
}

export const REMOTE_FS_OPS = ['list', 'read', 'root', 'branch', 'status', 'head', 'files'] as const;
export type RemoteFsOp = (typeof REMOTE_FS_OPS)[number];

/** Аргументы remote:fs из интерфейса: номер вкладки и операция из читающего списка; иначе null. Правка файлов и смена ветки в список не входят. */
export function validateRemoteFs(id: unknown, op: unknown): { id: number; op: RemoteFsOp } | null {
  if (typeof id !== 'number' || !REMOTE_FS_OPS.includes(op as RemoteFsOp)) return null;
  return { id, op: op as RemoteFsOp };
}

/** Ответ поиска с хоста: форма проверяется, пути только относительные, число попаданий и длина строк ограничены. */
export function readSearchReply(value: unknown): SearchReply {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const hits = (Array.isArray(v.hits) ? v.hits.slice(0, MAX_HITS) : []).flatMap((item): LineHit[] => {
    const h = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    const { rel, text, line, sign } = h;
    if (typeof rel !== 'string' || !rel || rel.startsWith('/') || rel.split('/').includes('..') || typeof text !== 'string') return [];
    if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) return [];
    const r = h.range as MatchRange | null;
    const range = r && Number.isInteger(r.start) && Number.isInteger(r.end) && r.start >= 0 && r.end >= r.start ? { start: r.start, end: r.end } : null;
    return [{ rel: rel.slice(0, 4096), line, text: text.slice(0, 1000), range, ...(sign === '+' || sign === '-' ? { sign } : {}) }];
  });
  return {
    hits,
    truncated: v.truncated === true,
    ...(v.cancelled === true ? { cancelled: true as const } : {}),
    ...(typeof v.error === 'string' ? { error: v.error.slice(0, 500) } : {}),
  };
}
