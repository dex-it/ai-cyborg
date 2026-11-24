/** Вопрос по выделению в терминале: тот же форк, что у /btw, через мод cyborg-ask в сессии. */

/** Расход форка, как его называет API. */
export interface SideUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Ответ мода либо причина, по которой ответа нет. */
export interface SideAnswer {
  ok: boolean;
  text?: string;
  /** no-mod, timeout, session-ended, а также причины $.model.fork: nothing-to-fork, api-error, empty-reply, aborted. */
  reason?: string;
  status?: number;
  usage?: SideUsage;
  ms?: number;
}

export interface SideTurn {
  question: string;
  answer: string;
}

export const DEFAULT_SIDE_QUESTION = 'Поясни этот фрагмент в контексте текущей сессии.';

/** Пределы текста, вложенного в один вопрос: хвост форка не кэшируется и оплачивается целиком каждым вопросом. */
export const MAX_FRAGMENT_CHARS = 8000;
export const MAX_HISTORY_TURNS = 6;
export const MAX_HISTORY_ANSWER_CHARS = 3000;

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}\n…(обрезано)` : text);

// Обёртка как у /btw: форк видит разговор целиком и должен понимать, что основной агент не прерван.
const WRAPPER = `<system-reminder>This is a side question from the user, asked about a fragment they selected in the session's terminal. You must answer it directly in a single response.

- You are a separate, lightweight agent spawned to answer this one question
- The main agent is NOT interrupted - it continues working independently in the background
- You share the conversation context but are a completely separate instance
- You have NO tools available - you cannot read files, run commands, search, or take any actions
- Do NOT promise to check, try or do anything; if you do not know, say so
- Answer straight away, concisely, in the language of the question
</system-reminder>`;

/** Текст одного вопроса форку: обёртка, фрагмент, прошлые вопросы этого окна и новый вопрос. */
export function sidePrompt(fragment: string, history: readonly SideTurn[], question: string): string {
  const parts = [WRAPPER, `Выделенный фрагмент терминала:\n<fragment>\n${cut(fragment.trim(), MAX_FRAGMENT_CHARS)}\n</fragment>`];
  const recent = history.slice(-MAX_HISTORY_TURNS);
  if (recent.length) {
    const lines = recent.map((t) => `Вопрос: ${t.question}\nОтвет: ${cut(t.answer, MAX_HISTORY_ANSWER_CHARS)}`);
    parts.push(`Прошлые вопросы об этом фрагменте:\n${lines.join('\n\n')}`);
  }
  parts.push(`Вопрос: ${question.trim() || DEFAULT_SIDE_QUESTION}`);
  return parts.join('\n\n');
}

/** Причина без ответа - фраза для окна. */
export function sideFailure(answer: SideAnswer): string {
  switch (answer.reason) {
    case 'no-mod':
      return 'Сессия не подключила мод вопросов cyborg-ask. Он включается в «Расширениях»; сессия, открытая раньше, получит его после перезапуска.';
    case 'nothing-to-fork':
      return 'Сессия ещё не отправила ни одного запроса модели: спрашивать пока не о чем.';
    case 'api-error':
      return `API ответил ошибкой${answer.status ? ` ${answer.status}` : ''}.`;
    case 'empty-reply':
      return 'Модель вернула пустой ответ.';
    case 'aborted':
      return 'Вопрос прерван вместе с ходом сессии.';
    case 'timeout':
      return 'Мод не ответил вовремя.';
    case 'session-ended':
      return 'Сессия завершилась.';
    default:
      return `Ответа нет${answer.reason ? `: ${answer.reason}` : ''}.`;
  }
}

/** Строка расхода: сколько прочитано из кэша, записано в него и оплачено без кэша. */
export function sideUsageLine(answer: SideAnswer): string {
  const u = answer.usage;
  if (!u) return '';
  const n = (v?: number): string => (v ?? 0).toLocaleString('ru-RU');
  const parts = [`из кэша ${n(u.cache_read_input_tokens)}`, `в кэш ${n(u.cache_creation_input_tokens)}`, `без кэша ${n(u.input_tokens)}`, `ответ ${n(u.output_tokens)}`];
  if (answer.ms !== undefined) parts.push(`${(answer.ms / 1000).toFixed(1).replace('.', ',')} с`);
  return parts.join(' · ');
}
