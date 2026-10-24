import type { AuthState, SourceResult, Task, TasksResult, TrackerKind, TrackersStatus } from '../main/trackers';

export type SortKey = 'updated' | 'created' | 'number';

export const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'updated', label: 'Обновлена' },
  { key: 'created', label: 'Создана' },
  { key: 'number', label: 'Номер' },
];

const time = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

/** Новые сверху; при равенстве порядок по ключу, чтобы список не прыгал между обновлениями. */
export function sortByKey<T extends { number: number; key: string; createdAt: string; updatedAt: string }>(items: T[], by: SortKey): T[] {
  const value = (t: T): number => (by === 'number' ? t.number : time(by === 'created' ? t.createdAt : t.updatedAt));
  return [...items].sort((a, b) => value(b) - value(a) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export const sortTasks = (tasks: Task[], by: SortKey): Task[] => sortByKey(tasks, by);

type Titled = Pick<Task, 'number' | 'title' | 'state' | 'workflow'>;

export function statusText(task: Pick<Task, 'state' | 'workflow'>): string {
  return [task.state === 'open' ? 'открыта' : 'закрыта', ...task.workflow].join(', ');
}

export const sessionLabel = (sessionId: number, task: Titled): string => `CC${sessionId} · #${task.number} ${task.title} · ${statusText(task)}`;

export const taskTooltip = (task: Titled & Pick<Task, 'url'>): string => `#${task.number} ${task.title}\nСтатус: ${statusText(task)}\n${task.url}`;

export const findTask = (result: TasksResult, key: string): Task | undefined =>
  result.tasks.find((t) => t.key === key) ?? result.tracked.find((t) => t.key === key);

export const sourceLabel = (s: SourceResult): string => {
  const name = s.kind === 'github' ? 'GitHub' : 'GitLab';
  return s.path ? `${name} ${s.host === 'github.com' ? '' : `${s.host}/`}${s.path}` : name;
};

export type EmptyView = 'disabled' | 'no-remotes' | 'none';

/** Чем заполнить панель, когда записей нет: null - показывать список. */
export function emptyOf(enabled: { github: boolean; gitlab: boolean }, count: number, sources: SourceResult[], none: 'none'): EmptyView | null {
  if (!enabled.github && !enabled.gitlab) return 'disabled';
  if (count) return null;
  const real = sources.filter((s) => s.path);
  if (!real.length) return 'no-remotes';
  return real.some((s) => !s.error) ? none : null;
}

/** Чем заполнить панель, когда задач нет: null - показывать список. */
export function emptyView(result: TasksResult): 'disabled' | 'no-remotes' | 'no-tasks' | null {
  const view = emptyOf(result.enabled, result.tasks.length, result.sources, 'none');
  return view === 'none' ? 'no-tasks' : view;
}

function authText(cli: 'gh' | 'glab', auth: AuthState, host?: string): string {
  switch (auth.state) {
    case 'logged-in':
      return `вход выполнен: ${auth.user}`;
    case 'logged-out':
      return `Вход не выполнен. Войдите командой: ${cli === 'gh' ? 'gh auth login' : `glab auth login${host ? ` --hostname ${host}` : ''}`}`;
    case 'missing':
      return `${cli} не установлен`;
    case 'error':
      return `Проверка не удалась: ${auth.message}`;
  }
}

/** У проекта включён хотя бы один источник: только тогда у полосы сессий есть кнопки «Задачи» и «MR/PR». */
export function hasSources(p: { trackers: { github: boolean; gitlab: boolean } } | null): boolean {
  return !!p && (p.trackers.github || p.trackers.gitlab);
}

/** Строки состояния источника для диалога проекта: на gh одна, на glab - по строке на хост. */
export function authLines(kind: TrackerKind, enabled: boolean, status: TrackersStatus): string[] {
  const mode = enabled ? 'включён' : 'выключен';
  if (kind === 'github') return [`${mode} · ${authText('gh', status.github)}`];
  const gitlab = status.gitlab;
  if (gitlab.state === 'hosts') {
    // glab перечисляет и хосты, куда пользователь не входил (gitlab.com по умолчанию) - в диалоге проекта они шум.
    const hosts = gitlab.hosts.filter((h) => h.auth.state !== 'logged-out');
    if (hosts.length) return hosts.map((h) => `${h.host}: ${mode} · ${authText('glab', h.auth, h.host)}`);
    return [`${mode} · ${authText('glab', { state: 'logged-out' })}`];
  }
  return [`${mode} · ${authText('glab', gitlab)}`];
}
