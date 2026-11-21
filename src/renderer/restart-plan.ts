/** Ответ главного процесса на перезапуск вкладки: удалённая просыпается на хосте, локальная продолжает разговор под той же открывшей. */
export interface RestartReply<R> {
  resume?: string;
  parent?: number;
  remote?: R;
}

export type RestartPlan<R, S> = { kind: 'remote'; info: R } | { kind: 'local'; resume: string; opener: S | undefined } | { kind: 'none' };

/** Открывшая дочерней вкладки находится среди вкладок окна: нет её (закрыта) - вкладка встаёт без родителя. */
export function restartPlan<R, S>(reply: RestartReply<R>, find: (id: number) => S | undefined): RestartPlan<R, S> {
  if (reply.remote) return { kind: 'remote', info: reply.remote };
  if (reply.resume) return { kind: 'local', resume: reply.resume, opener: reply.parent === undefined ? undefined : find(reply.parent) };
  return { kind: 'none' };
}
