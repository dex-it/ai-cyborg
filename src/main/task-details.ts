import { enc, firstLine, interpret, taskKey, taskUrl, validateListArgs, validateOpenArgs, validateRef, type CliRunner, type TaskRef, type TasksResult } from './trackers';

export type TaskDetailsResult = { description: string } | { error: string };

const SELECTIONS_KEPT = 8;

export function validateTaskDetailsArgs(selection: unknown, ref: unknown): { selection: number; ref: TaskRef } | null {
  if (typeof selection !== 'number' || !Number.isSafeInteger(selection) || selection < 1) return null;
  const valid = validateRef(ref);
  return valid ? { selection, ref: valid } : null;
}

/**
 * Описание задачи запрашивается только по задаче, которую главный процесс сам вернул в списке: так токен glab
 * не уходит на хост вне источников проекта.
 */
export class TaskDetailsService {
  private seq = 0;
  private readonly selections = new Map<number, Map<string, TaskRef>>();

  constructor(private readonly run: CliRunner) {}

  remember(result: TasksResult): TasksResult {
    const id = ++this.seq;
    this.selections.set(
      id,
      new Map(result.tasks.map((t) => [t.key, { kind: t.kind, host: t.host, path: t.path, number: t.number }])),
    );
    while (this.selections.size > SELECTIONS_KEPT) this.selections.delete(this.selections.keys().next().value!);
    return { ...result, selection: id };
  }

  async details(selection: number, ref: TaskRef): Promise<TaskDetailsResult> {
    const stored = this.selections.get(selection)?.get(taskKey(ref));
    if (!stored) return { error: 'задача не из текущей выборки: нажмите «Обновить»' };
    try {
      const res =
        stored.kind === 'github'
          ? await this.run('gh', ['api', '--hostname', 'github.com', '--jq', '{body}', `repos/${stored.path}/issues/${stored.number}`])
          : await this.run('glab', ['api', '--hostname', stored.host, `projects/${enc(stored.path)}/issues/${stored.number}`]);
      const out = interpret(stored.kind, res, null);
      if (!('values' in out)) return { error: out.error ?? 'трекер не ответил' };
      const value = out.values[0] as Record<string, unknown> | undefined;
      const text = stored.kind === 'github' ? value?.body : value?.description;
      return { description: typeof text === 'string' ? text : '' };
    } catch (error) {
      return { error: firstLine((error as Error).message) };
    }
  }
}

/** Обработчики каналов задач без electron: проверка аргументов и выдача номера выборки живут здесь, main.ts только регистрирует их. */
export function createTaskHandlers(
  trackers: { list(projectId: string, assignedToMe: boolean, tracked: TaskRef[], recheck: boolean): Promise<TasksResult> },
  details: TaskDetailsService,
  openExternal: (url: string) => Promise<void>,
) {
  return {
    list(projectId: unknown, assignedToMe: unknown, tracked: unknown, recheck: unknown): Promise<TasksResult> {
      const args = validateListArgs(projectId, assignedToMe, tracked, recheck);
      if (!args) throw new Error('Некорректные аргументы tasks:list');
      return trackers.list(args.projectId, args.assignedToMe, args.tracked, args.recheck).then((r) => details.remember(r));
    },
    details(selection: unknown, ref: unknown): Promise<TaskDetailsResult> {
      const args = validateTaskDetailsArgs(selection, ref);
      if (!args) throw new Error('Некорректные аргументы tasks:details');
      return details.details(args.selection, args.ref);
    },
    async open(arg: unknown): Promise<{ error?: string }> {
      const ref = validateOpenArgs(arg);
      if (!ref) throw new Error('Некорректные аргументы tasks:open');
      try {
        await openExternal(taskUrl(ref));
        return {};
      } catch (error) {
        return { error: firstLine((error as Error).message) || 'браузер не открылся' };
      }
    },
  };
}
