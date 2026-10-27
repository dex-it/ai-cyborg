/** Правила работы панели задач без DOM: подставляемый вход и состояние, проверяемые в npm test. */

import type { TaskRef } from '../main/trackers';

interface TaskSessionLike {
  project: { id: string };
  task?: { key: string };
  mr?: { key: string };
  jira?: { key: string };
}

const sessionKey = (s: TaskSessionLike): string | undefined => s.task?.key ?? s.mr?.key ?? (s.jira && `jira:${s.jira.key}`);

const compound = (projectId: string, taskKey: string): string => `${projectId}\u0000${taskKey}`;

/** Сессии, начатые из задач и MR, в разрезе проекта: общий remote у двух проектов не смешивает их сессии. */
export class TaskSessionRegistry<S extends TaskSessionLike> {
  private readonly map = new Map<string, S>();

  get(projectId: string, taskKey: string): S | undefined {
    return this.map.get(compound(projectId, taskKey));
  }

  add(session: S): void {
    const key = sessionKey(session);
    if (key) this.map.set(compound(session.project.id, key), session);
  }

  /** Удаляет запись, только если она указывает на эту сессию. */
  remove(session: S): void {
    const sk = sessionKey(session);
    if (!sk) return;
    const key = compound(session.project.id, sk);
    if (this.map.get(key) === session) this.map.delete(key);
  }
}

/** Ключи задач, чья сессия создаётся: повторный клик до ответа createSession игнорируется. */
export class StartGuard {
  private readonly pending = new Set<string>();

  begin(projectId: string, taskKey: string): boolean {
    const key = compound(projectId, taskKey);
    if (this.pending.has(key)) return false;
    this.pending.add(key);
    return true;
  }

  end(projectId: string, taskKey: string): void {
    this.pending.delete(compound(projectId, taskKey));
  }
}

export type StartDecision = { action: 'switch' } | { action: 'create'; repo: string } | { action: 'menu'; repos: string[] } | { action: 'none' };

/** Что делает «Начать»: переключить на открытую сессию проекта, создать в единственном репозитории, спросить репозиторий или ничего. */
export function decideStart(hasOpenSession: boolean, taskRepos: string[], projectRepos: string[]): StartDecision {
  if (hasOpenSession) return { action: 'switch' };
  const repos = taskRepos.filter((r) => projectRepos.includes(r));
  if (repos.length === 1) return { action: 'create', repo: repos[0] };
  if (repos.length > 1) return { action: 'menu', repos };
  return { action: 'none' };
}

/** Что запустило выборку; кэш входа в трекерах сбрасывает только «Обновить» (FR-1006). */
export type RefreshTrigger = 'open' | 'tab' | 'filter' | 'project' | 'reload' | 'timer';

export const recheckFor = (trigger: RefreshTrigger): boolean => trigger === 'reload';

/** Возраст снимка, после которого фон и открытие вида выбирают заново. */
export const SNAPSHOT_TTL_MS = 5 * 60_000;
/** Шаг фоновой проверки устаревания: снимок обновится не позже TTL плюс шаг. */
export const SNAPSHOT_TICK_MS = 30_000;
export const RELOAD_DEBOUNCE_MS = 300;

/**
 * Фоновая выборка не удалась (`fetchFailed`), а годный снимок есть: он остаётся на экране (сеть моргнула - список не пропадает),
 * повтор - не раньше TTL от неудачи. Открытие, вкладка, фильтр и «Обновить» показывают ошибку: человек ждал ответа.
 */
export const keepSnapshotOnError = (trigger: RefreshTrigger, hasSnapshot: boolean, failed: boolean): boolean =>
  trigger === 'timer' && hasSnapshot && failed;

/** Ответы равны по содержимому: номер выборки и служебные поля деталей у каждого ответа свои и в счёт не идут. */
export const sameSnapshot = (a: unknown, b: unknown): boolean => {
  const plain = (value: unknown): string => JSON.stringify(value, (key, item) => (key === 'selection' || key === 'detailsId' || key === 'awaiting' ? undefined : item));
  return plain(a) === plain(b);
};

/** null - снимка нет. */
export const snapshotStale = (at: number | null, now: number, ttl = SNAPSHOT_TTL_MS): boolean => at === null || now - at >= ttl;

/** Вызов канала списка задач: флаг новой проверки входа берётся из триггера. */
export function fetchTasks<R>(
  api: { listTasks(projectId: string, assigned: boolean, tracked: TaskRef[], recheck: boolean): Promise<R> },
  projectId: string,
  assigned: boolean,
  tracked: TaskRef[],
  trigger: RefreshTrigger,
): Promise<R> {
  return api.listTasks(projectId, assigned, tracked, recheckFor(trigger));
}

export interface Listenable {
  addEventListener(type: string, listener: () => void): void;
}

type Refresh = (force: boolean, trigger: RefreshTrigger) => Promise<void>;

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const windowTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Серия вызовов за ms сливается в один - последний. */
export function debounce(fn: () => void, ms: number, timers: Timers = windowTimers): () => void {
  let handle: unknown = null;
  return () => {
    if (handle !== null) timers.clear(handle);
    handle = timers.set(() => {
      handle = null;
      fn();
    }, ms);
  };
}

/**
 * Проводка шапки вида: смена фильтра - новый вопрос, вытесняет фоновую выборку;
 * «Обновить» - внеочередной цикл того же фонового обновления, серия кликов сливается дебаунсом.
 */
export function wireRefresh(controls: { filter: Listenable; reload: Listenable }, refresh: Refresh, timers: Timers = windowTimers): void {
  controls.filter.addEventListener('change', () => void refresh(true, 'filter'));
  controls.reload.addEventListener('click', debounce(() => void refresh(true, 'reload'), RELOAD_DEBOUNCE_MS, timers));
}

export type PanelEvent = 'open' | 'tab' | 'project';

/** Выборка по событию панели: смена проекта - всегда и в обход флага загрузки; открытие и вкладка - только при устаревшем снимке. */
export function refreshOnPanelEvent(refresh: Refresh, event: PanelEvent, loadedAt: number | null = null, now = Date.now()): Promise<void> {
  if (event === 'project') return refresh(true, event);
  return snapshotStale(loadedAt, now) ? refresh(false, event) : Promise.resolve();
}

/** Одиночный полёт обновления и токен ответа: без force второй запрос не начинается, ответ не текущего токена отбрасывается. */
export class RefreshGate {
  private token = 0;
  private busy = false;

  get loading(): boolean {
    return this.busy;
  }

  /** Токен нового запроса либо null, если идёт загрузка и force не задан. */
  begin(force: boolean): number | null {
    if (this.busy && !force) return null;
    this.busy = true;
    return ++this.token;
  }

  /** Сбрасывает запрос в полёте: его ответ будет отброшен. */
  cancel(): void {
    this.token++;
    this.busy = false;
  }

  /** true - выборка токена остаётся текущей: ни новой выборки, ни смены проекта после неё. */
  isCurrent(token: number): boolean {
    return token === this.token;
  }

  /** true - ответ актуален и загрузка закончена; false - ответ устарел. */
  finish(token: number): boolean {
    if (token !== this.token) return false;
    this.busy = false;
    return true;
  }
}
