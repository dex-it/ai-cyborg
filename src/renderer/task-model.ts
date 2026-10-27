import type { TaskDetailsResult } from '../main/task-details';
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

/**
 * Выборка не удалась целиком: ошибка верхнего уровня (отказ канала, проект не найден) либо каждый источник с адресом ответил ошибкой
 * (нет сети, выход из gh, лимит). Частичный отказ не провал: ответ заменяет снимок, ошибка упавшего источника видна в списке.
 */
export function fetchFailed(result: { error?: string; sources: SourceResult[] }): boolean {
  if (result.error) return true;
  const real = result.sources.filter((s) => s.path);
  return real.length > 0 && real.every((s) => !!s.error);
}

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

// ---------- метки ----------

export type LabelMode = '+' | '-';
/** Имя метки (точное, общее для источников) -> обязательная либо исключённая. */
export type LabelFilter = ReadonlyMap<string, LabelMode>;

export function matchLabels(task: Pick<Task, 'labels'>, filter: LabelFilter): boolean {
  if (!filter.size) return true;
  const names = new Set(task.labels.map((l) => l.name));
  for (const [name, mode] of filter) if (names.has(name) !== (mode === '+')) return false;
  return true;
}

export const filterByLabels = <T extends Pick<Task, 'labels'>>(tasks: T[], filter: LabelFilter): T[] =>
  filter.size ? tasks.filter((t) => matchLabels(t, filter)) : tasks;

/** Фильтр дал пустой список из непустой выборки. */
export const labelEmpty = (tasks: Pick<Task, 'labels'>[], filter: LabelFilter): boolean =>
  filter.size > 0 && tasks.length > 0 && filterByLabels(tasks, filter).length === 0;

export const requireLabel = (filter: LabelFilter, name: string): LabelFilter => new Map(filter).set(name, '+');

/** Нет -> обязательная -> исключённая -> снята. */
export function cycleLabel(filter: LabelFilter, name: string): LabelFilter {
  const next = new Map(filter);
  const mode = filter.get(name);
  if (mode === undefined) next.set(name, '+');
  else if (mode === '+') next.set(name, '-');
  else next.delete(name);
  return next;
}

export const serializeLabelFilter = (filter: LabelFilter): string => JSON.stringify([...filter]);

/** Повреждённое значение целиком даёт пустой фильтр. */
export function parseLabelFilter(raw: string | null): LabelFilter {
  if (raw === null) return new Map();
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return new Map();
    const out = new Map<string, LabelMode>();
    for (const pair of data) {
      if (!Array.isArray(pair) || pair.length !== 2) return new Map();
      const [name, mode] = pair as [unknown, unknown];
      if (typeof name !== 'string' || !name || (mode !== '+' && mode !== '-')) return new Map();
      out.set(name, mode);
    }
    return out;
  } catch {
    return new Map();
  }
}

/** Метки выборки и сохранённого фильтра: имя -> цвет первой метки с цветом; по алфавиту. */
export function availableLabels(tasks: Pick<Task, 'labels'>[], filter: LabelFilter): Map<string, string | null> {
  const colors = new Map<string, string | null>();
  for (const task of tasks) {
    for (const { name, color } of task.labels) {
      if (!colors.has(name) || (colors.get(name) === null && color)) colors.set(name, color);
    }
  }
  for (const name of filter.keys()) if (!colors.has(name)) colors.set(name, null);
  return new Map([...colors].sort(([a], [b]) => a.localeCompare(b)));
}

const channel = (v: number): number => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** Цвет текста на фоне '#rrggbb' с большим контрастом по WCAG; неверный фон - null. */
export function labelInk(color: string | null): '#000000' | '#ffffff' | null {
  const m = color ? /^#([0-9a-f]{6})$/.exec(color) : null;
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const l = 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
  return 1.05 / (l + 0.05) > (l + 0.05) / 0.05 ? '#ffffff' : '#000000';
}

// ---------- детали ----------

const dateText = (iso: string): string => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '—' : new Date(t).toLocaleString('ru');
};

export const detailsLines = (task: Pick<Task, 'author' | 'assignees' | 'createdAt' | 'updatedAt'>): string[] => [
  `Автор: ${task.author || '—'}`,
  `Исполнители: ${task.assignees.length ? task.assignees.join(', ') : 'не назначены'}`,
  `Создана: ${dateText(task.createdAt)}`,
  `Обновлена: ${dateText(task.updatedAt)}`,
];

export const descriptionText = (text: string | null | undefined): string => (text && text.trim() ? text : 'Описания нет');

export type DescriptionState = { state: 'loading' } | { state: 'done'; text: string } | { state: 'error'; message: string };

/** Описания раскрытых задач: готовое держится до сброса, отказ в кэш не попадает, поздний ответ прежнего поколения отбрасывается. */
export class DescriptionStore {
  private readonly entries = new Map<string, DescriptionState>();
  private generation = 0;

  get(key: string): DescriptionState | undefined {
    return this.entries.get(key);
  }

  /** Поколение для запроса либо null, если запрос не нужен (идёт, готов или отказ ещё показан). */
  begin(key: string): number | null {
    const cur = this.entries.get(key);
    if (cur) return null;
    this.entries.set(key, { state: 'loading' });
    return this.generation;
  }

  finish(key: string, generation: number, result: TaskDetailsResult): boolean {
    if (generation !== this.generation) return false;
    this.entries.set(key, 'error' in result ? { state: 'error', message: result.error } : { state: 'done', text: result.description });
    return true;
  }

  /** Отказ показывается до следующего раскрытия. */
  forgetError(key: string): void {
    if (this.entries.get(key)?.state === 'error') this.entries.delete(key);
  }

  reset(): void {
    this.entries.clear();
    this.generation++;
  }
}
