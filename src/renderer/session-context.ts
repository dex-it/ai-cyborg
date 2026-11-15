/** То же, что SessionContext главного процесса (session-state.ts): приходит событием session:context. */
export interface SessionContext {
  title?: string;
  first?: string;
  last?: string;
}

/** Строки подсказки вкладки: о чём разговор, с чего начат и что спрошено последним. */
export function contextTooltip({ title, first, last }: SessionContext): string {
  return [
    title,
    first && `Задача: ${first}`,
    last && last !== first && `Последний запрос: ${last}`,
  ]
    .filter(Boolean)
    .join('\n');
}
