import { MAX_TRACKED, taskPrompt, validateRef, type SourceResult, type TaskRef, type TrackerKind, type TrackerSettings } from './trackers';

export type MrRef = TaskRef;
export type MrFilter = 'all' | 'assigned' | 'review';
export type MrIntent = 'review' | 'rework';
export type MrState = 'open' | 'merged' | 'closed';

export interface Mr extends MrRef {
  key: string;
  title: string;
  author: string;
  sourceBranch: string;
  targetBranch: string;
  draft: boolean;
  state: MrState;
  /** null - не получен. */
  pipeline: string | null;
  approvals: string | null;
  url: string;
  createdAt: string;
  updatedAt: string;
  /** Автор - пользователь хоста: действие «Доработать» вместо «Ревью». */
  own: boolean;
  /** Репозитории проекта, чей remote указывает на трекер MR. */
  repos: string[];
}

export interface MrListResult {
  mrs: Mr[];
  sources: SourceResult[];
  tracked: Mr[];
  enabled: TrackerSettings;
  error?: string;
}

/** Что присылает интерфейс при старте сессии: только проверяемые ссылки, без названий и веток. */
export type SessionStart = { task: TaskRef } | { mr: MrRef; intent: MrIntent };

/** MR списка до запроса деталей: участники нужны фильтру, головной коммит - проверкам GitHub. */
export interface ParsedMr {
  mr: Mr;
  assignees: string[];
  reviewers: string[];
  headSha: string;
}

export const MAX_DETAILED = 200;
export const MR_CONCURRENCY = 6;

const FILTERS: readonly string[] = ['all', 'assigned', 'review'];
const INTENTS: readonly string[] = ['review', 'rework'];
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export const isSha = (value: string): boolean => SHA.test(value);

export const mrKey = (ref: MrRef): string => `${ref.kind}:${ref.host}/${ref.path.toLowerCase()}!${ref.number}`;

export const mrUrl = (ref: MrRef): string =>
  ref.kind === 'github' ? `https://github.com/${ref.path}/pull/${ref.number}` : `https://${ref.host}/${ref.path}/-/merge_requests/${ref.number}`;

/** Первое сообщение сессии. Собирается из проверенной ссылки: название, ветки и автор MR (чужой текст) в него не попадают. */
export function mrPrompt(ref: MrRef, intent: MrIntent): string {
  if (intent === 'review') return `/dex-auto:auto review ${mrUrl(ref)}`;
  return `Разбери замечания к MR ${mrUrl(ref)}: переключись на его ветку и доработай её по замечаниям ревью.`;
}

// ---------- проверка аргументов каналов ----------

export interface MrListArgs {
  projectId: string;
  filter: MrFilter;
  tracked: MrRef[];
}

export function validateMrListArgs(projectId: unknown, filter: unknown, tracked: unknown): MrListArgs | null {
  if (typeof projectId !== 'string' || typeof filter !== 'string' || !FILTERS.includes(filter)) return null;
  if (!Array.isArray(tracked) || tracked.length > MAX_TRACKED) return null;
  const refs: MrRef[] = [];
  for (const item of tracked) {
    const ref = validateRef(item);
    if (!ref) return null;
    refs.push(ref);
  }
  return { projectId, filter: filter as MrFilter, tracked: refs };
}

/** Начальный промпт по аргументу session:create; null - аргумент некорректен. Лишние поля игнорируются. */
export function validateSessionStart(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const { task, mr, intent } = value as Record<string, unknown>;
  if (task !== undefined && mr === undefined) {
    const ref = validateRef(task);
    return ref ? taskPrompt(ref) : null;
  }
  if (mr !== undefined && task === undefined) {
    const ref = validateRef(mr);
    if (!ref || typeof intent !== 'string' || !INTENTS.includes(intent)) return null;
    return mrPrompt(ref, intent as MrIntent);
  }
  return null;
}

// ---------- разбор ----------

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

const names = (value: unknown, field: string): string[] =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        const name = typeof item === 'string' ? item : (item as Record<string, unknown> | null)?.[field];
        return typeof name === 'string' && name ? [name] : [];
      })
    : [];

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

function stateOf(kind: TrackerKind, r: Record<string, unknown>): MrState {
  const state = str(r.state);
  if (kind === 'github') return r.merged === true ? 'merged' : state === 'closed' ? 'closed' : 'open';
  return state === 'merged' ? 'merged' : state === 'closed' || state === 'locked' ? 'closed' : 'open';
}

/** raw - элемент списка (для GitHub уже сведённый jq-фильтром) либо ответ по одному MR. me - пользователь хоста либо undefined. */
export function parseMr(source: { kind: TrackerKind; host: string; path: string; repos: string[] }, raw: unknown, me: string | undefined): ParsedMr | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const number = source.kind === 'github' ? r.number : r.iid;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) return null;
  const ref: MrRef = { kind: source.kind, host: source.host, path: source.path, number };
  let author: string;
  let sourceBranch: string;
  let targetBranch: string;
  let assignees: string[];
  let reviewers: string[];
  let headSha: string;
  if (source.kind === 'github') {
    author = str(r.user);
    // Ветка своего репозитория - как есть; из форка (в том числе удалённого) - «владелец:ветка».
    sourceBranch = typeof r.head_repo === 'string' && same(r.head_repo, source.path) ? str(r.head_ref) : str(r.head_label) || str(r.head_ref);
    targetBranch = str(r.base_ref);
    assignees = names(r.assignees, 'login');
    reviewers = names(r.reviewers, 'login');
    headSha = str(r.head_sha);
  } else {
    author = str((r.author as Record<string, unknown> | null)?.username);
    sourceBranch = str(r.source_branch);
    targetBranch = str(r.target_branch);
    assignees = names(r.assignees, 'username');
    reviewers = names(r.reviewers, 'username');
    headSha = str(r.sha);
  }
  const mr: Mr = {
    ...ref,
    key: mrKey(ref),
    title: str(r.title),
    author,
    sourceBranch,
    targetBranch,
    draft: r.draft === true,
    state: stateOf(source.kind, r),
    pipeline: null,
    approvals: null,
    url: mrUrl(ref),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
    own: !!me && !!author && same(author, me),
    repos: source.repos,
  };
  return { mr, assignees, reviewers, headSha };
}

export const toMr = (source: Parameters<typeof parseMr>[0], raw: unknown, me: string | undefined): Mr | null => parseMr(source, raw, me)?.mr ?? null;

/** Фильтр по полной выборке: без логина «assigned» и «review» не отдают ничего. */
export function filterMrs(items: ParsedMr[], filter: MrFilter, me: string | undefined): ParsedMr[] {
  if (filter === 'all') return items;
  if (!me) return [];
  const has = (list: string[]) => list.some((name) => same(name, me));
  return items.filter((item) => has(filter === 'assigned' ? item.assignees : item.reviewers));
}

// ---------- сводки ----------

export interface CheckRun {
  status?: string;
  conclusion?: string | null;
}

export interface CombinedStatus {
  state?: string;
  total_count?: number;
}

export const NO_PIPELINE = 'нет пайплайна';

export function githubPipeline(runs: CheckRun[], combined: CombinedStatus | null): string {
  const statuses = combined && typeof combined.total_count === 'number' ? combined.total_count : 0;
  if (!runs.length && !statuses) return NO_PIPELINE;
  const state = statuses > 0 ? combined?.state : undefined;
  const concluded = (...values: string[]) => runs.some((run) => run.conclusion != null && values.includes(run.conclusion));
  if (concluded('failure', 'timed_out', 'action_required') || state === 'failure' || state === 'error') return 'упал';
  if (runs.some((run) => run.status === 'in_progress')) return 'идёт';
  if (runs.some((run) => ['queued', 'waiting', 'requested', 'pending'].includes(run.status ?? '')) || state === 'pending') return 'ожидает';
  if (concluded('cancelled')) return 'отменён';
  return 'успешен';
}

const GITLAB_PIPELINE: Record<string, string> = { success: 'успешен', failed: 'упал', running: 'идёт', pending: 'ожидает', canceled: 'отменён' };

/** status - head_pipeline.status либо null, если пайплайна нет. */
export const gitlabPipeline = (status: string | null): string => (status === null ? NO_PIPELINE : (GITLAB_PIPELINE[status] ?? status));

export const approvalsText = (count: number, required?: number): string =>
  required !== undefined && required > 0 ? `апрувов: ${count} из ${required}` : `апрувов: ${count}`;

/** Ревью в хронологическом порядке: у каждого логина решает последнее среди APPROVED, CHANGES_REQUESTED, DISMISSED. */
export function githubApprovals(reviews: { login?: unknown; state?: unknown }[]): number {
  const last = new Map<string, string>();
  for (const { login, state } of reviews) {
    if (typeof login !== 'string' || typeof state !== 'string') continue;
    if (state === 'APPROVED' || state === 'CHANGES_REQUESTED' || state === 'DISMISSED') last.set(login.toLowerCase(), state);
  }
  return [...last.values()].filter((state) => state === 'APPROVED').length;
}

/** Выполняет задачи не более limit одновременно; порядок результатов - порядок задач. */
export async function runLimited<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const i = next++;
      out[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return out;
}
