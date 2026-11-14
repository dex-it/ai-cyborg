import { withoutSuggestions } from './suggestions.ts';

/** starting - SessionStart ещё не пришёл (CC грузится или стоит на доверии к каталогу); asking - ждёт человека на вопросе, разрешении или лимите. */
export type SessionState = 'starting' | 'working' | 'waiting' | 'asking';

export interface SessionEvent {
  hook_event_name?: string;
  /** Номер разговора Claude Code: имя журнала и аргумент --resume. */
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  message?: string;
  notification_type?: string;
  last_assistant_message?: string;
  /** Есть у событий инструментов субагента, в том числе фонового, который работает после Stop главного хода. */
  agent_id?: string;
  background_tasks?: unknown[];
  session_crons?: unknown[];
}

export const HOOK_COMMAND = '{ cat; echo; } >> "$CYBORG_EVENTS"';
export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'Notification'];

/** Содержимое --settings: те же хуки у локальной сессии и у демона на хосте. */
export function hookSettings(): { hooks: Record<string, unknown[]> } {
  return {
    hooks: Object.fromEntries(
      HOOK_EVENTS.map((event) => [
        event,
        [{ ...(event === 'PostToolUse' ? { matcher: '*' } : {}), hooks: [{ type: 'command', command: HOOK_COMMAND }] }],
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
}

/** Состояние для list_sessions; фоновый субагент (agent_id) хода главной модели не меняет. */
export function track(session: Tracked, event: SessionEvent): void {
  const name = event.hook_event_name;
  if (name === 'SessionStart') {
    if (session.state === 'starting') session.state = 'waiting';
  } else if (name === 'UserPromptSubmit' || (name === 'PostToolUse' && !event.agent_id)) session.state = 'working';
  else if (name === 'Stop') {
    session.state = event.background_tasks?.length || event.session_crons?.length ? 'working' : 'waiting';
    if (typeof event.last_assistant_message === 'string') session.lastAnswer = withoutSuggestions(event.last_assistant_message);
  } else if (name === 'Notification') {
    const reason = waitingReason(event);
    if (!reason) return;
    session.state = 'asking';
    session.reason = reason;
    return;
  } else return;
  session.reason = undefined;
}
