import { withoutSuggestions } from './suggestions.ts';

/** starting - SessionStart ещё не пришёл (CC грузится или стоит на доверии к каталогу); asking - ждёт человека на вопросе, разрешении или лимите. */
export type SessionState = 'starting' | 'working' | 'waiting' | 'asking' | 'exited';

export interface SessionEvent {
  hook_event_name?: string;
  /** Номер разговора Claude Code: имя журнала и аргумент --resume. */
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  message?: string;
  notification_type?: string;
  last_assistant_message?: string;
  /** Текст запроса у UserPromptSubmit. */
  prompt?: string;
  /** Журнал разговора; у удалённой сессии - путь на хосте. */
  transcript_path?: string;
  /** Есть у событий инструментов субагента, в том числе фонового, который работает после Stop главного хода. */
  agent_id?: string;
  /** Связывает PreToolUse вызова с его PostToolUse или PostToolUseFailure. */
  tool_use_id?: string;
  background_tasks?: unknown[];
  session_crons?: unknown[];
}

// Код 2 у PreToolUse запрещает вызов: недоступный файл событий не должен останавливать сессию.
export const HOOK_COMMAND = '{ cat; echo; } >> "$CYBORG_EVENTS" || true';
// Упавший инструмент шлёт PostToolUseFailure, а не PostToolUse: без него ход из одних отказов выглядел бы простоем.
export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStop', 'Stop', 'Notification'];

/** Вызов инструмента закончен, успешно или нет. */
export const isToolEnd = (name: string | undefined): boolean => name === 'PostToolUse' || name === 'PostToolUseFailure';

/** Вызов инструмента начат или закончен: сессия (или её субагент) работает. */
export const isToolEvent = (name: string | undefined): boolean => name === 'PreToolUse' || isToolEnd(name);

/** Содержимое --settings: те же хуки у локальной сессии и у демона на хосте. */
export function hookSettings(): { hooks: Record<string, unknown[]> } {
  return {
    hooks: Object.fromEntries(
      HOOK_EVENTS.map((event) => [
        event,
        [{ ...(isToolEvent(event) ? { matcher: '*' } : {}), hooks: [{ type: 'command', command: HOOK_COMMAND }] }],
      ]),
    ),
  };
}

// Белый список: новый тип Notification не уведомляет, а текст зависит только от типа - ответ и запрос на экран блокировки не попадают (D-07).
const WAITING_NOTIFICATIONS: ReadonlyMap<string, string> = new Map([
  ['permission_prompt', 'Просит разрешение'],
  ['elicitation_dialog', 'Задаёт вопрос'],
  ['elicitation_url_dialog', 'Задаёт вопрос'],
  ['agent_needs_input', 'Ждёт ответа'],
  ['quota_auto_resume_stale', 'Остановилась на лимите'],
  ['quota_auto_resume_disabled', 'Остановилась на лимите'],
]);

/** Сессия ждёт человека: ход закончен либо CC стоит на вопросе, разрешении или лимите (типы - code.claude.com/docs/en/hooks). */
export function waitingReason(event: SessionEvent): string | null {
  if (event.hook_event_name === 'Stop') {
    if (event.background_tasks?.length || event.session_crons?.length) return null;
    return 'Ход завершён, ждёт ответа';
  }
  if (event.hook_event_name !== 'Notification') return null;
  return WAITING_NOTIFICATIONS.get(event.notification_type ?? '') ?? null;
}

export interface Tracked {
  state: SessionState;
  reason?: string;
  lastAnswer?: string;
  /** working после Stop с фоновыми задачами или пробуждениями: ход кончен, ввод Claude Code принимает. */
  background?: boolean;
}

/** Состояние для list_sessions; фоновый субагент (agent_id) хода главной модели не меняет. */
export function track(session: Tracked, event: SessionEvent): void {
  const name = event.hook_event_name;
  if (name === 'SessionStart') {
    if (session.state === 'starting') session.state = 'waiting';
  } else if (name === 'UserPromptSubmit' || (isToolEvent(name) && !event.agent_id)) {
    session.state = 'working';
    session.background = false;
  } else if (name === 'Stop') {
    session.background = !!(event.background_tasks?.length || event.session_crons?.length);
    session.state = session.background ? 'working' : 'waiting';
    if (typeof event.last_assistant_message === 'string') session.lastAnswer = withoutSuggestions(event.last_assistant_message);
  } else if (name === 'Notification') {
    const reason = waitingReason(event);
    if (!reason) return;
    session.state = 'asking';
    session.reason = reason;
    session.background = false;
    return;
  } else return;
  session.reason = undefined;
}

/** О чём сессия: подсказка её вкладки. */
export interface SessionContext {
  /** Название разговора от Claude Code (ai-title или /rename). */
  title?: string;
  /** Первый запрос - обычно постановка задачи. */
  first?: string;
  last?: string;
}

const PROMPT_MAX = 300;

export function clipPrompt(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > PROMPT_MAX ? `${line.slice(0, PROMPT_MAX - 1)}…` : line;
}

/** Запрос человека из UserPromptSubmit; служебная разметка (`<...>`) запросом не считается, как и в истории. */
export function notePrompt(context: SessionContext, prompt: unknown): void {
  if (typeof prompt !== 'string') return;
  const text = clipPrompt(prompt);
  if (!text || text.startsWith('<')) return;
  context.first ??= text;
  context.last = text;
}
