/** Правила работы панели задач без DOM: подставляемый вход и состояние, проверяемые в npm test. */

interface TaskSessionLike {
  project: { id: string };
  task?: { key: string };
}

const compound = (projectId: string, taskKey: string): string => `${projectId}\u0000${taskKey}`;

/** Сессии, начатые из задач, в разрезе проекта: общий remote у двух проектов не смешивает их сессии. */
export class TaskSessionRegistry<S extends TaskSessionLike> {
  private readonly map = new Map<string, S>();

  get(projectId: string, taskKey: string): S | undefined {
    return this.map.get(compound(projectId, taskKey));
  }

  add(session: S): void {
    if (session.task) this.map.set(compound(session.project.id, session.task.key), session);
  }

  /** Удаляет запись, только если она указывает на эту сессию. */
  remove(session: S): void {
    if (!session.task) return;
    const key = compound(session.project.id, session.task.key);
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

  /** true - ответ актуален и загрузка закончена; false - ответ устарел. */
  finish(token: number): boolean {
    if (token !== this.token) return false;
    this.busy = false;
    return true;
  }
}
