// Кнопки, которые предлагает модель (фича 12): инструкция сессии и разбор хвоста ответа.
// Чистый файл без Node: разбор вызывает главный процесс (событие Stop), инструкцию - сборка аргументов claude.

import { parseCommands, type CommandButton } from './commands.ts';

export const SUGGEST_MAX = 4;
/** Хвост длиннее разбирать не стоит: четыре кнопки по пределам commands.ts умещаются с запасом. */
const SUGGEST_BLOCK_MAX = 20_000;
const MARKER = '<!-- cyborg-buttons:';
const END = '-->';

/** Инструкция сессии: когда и в каком виде предлагать кнопки (дописывается к системному промту, как инструкция об изоляции). */
export const SUGGEST_PROMPT =
  `Если после ответа человеку понятны 1-${SUGGEST_MAX} следующих шага, допиши в самом конце ответа, отдельной строкой, комментарий ` +
  `${MARKER} [{"label":"подпись до 40 знаков","text":"реплика человека к тебе, одной строкой"}] ${END} . ` +
  'Не очевидно, что делать дальше, - не пиши ничего. В тексте ответа комментарий не упоминай.';

/**
 * Кнопки из хвоста ответа: комментарий должен стоять в самом конце сообщения (процитированный из файла в середине ответа не в счёт).
 * Ответ модели недоверенный: поля проверяются как у кнопок файла, лишние поля отбрасываются, Enter не отправляется никогда.
 */
export function parseSuggestions(message: unknown): CommandButton[] {
  if (typeof message !== 'string') return [];
  const trimmed = message.trimEnd();
  if (!trimmed.endsWith(END)) return [];
  const start = trimmed.lastIndexOf(MARKER);
  if (start < 0) return [];
  const body = trimmed.slice(start + MARKER.length, trimmed.length - END.length).trim();
  if (!body || body.length > SUGGEST_BLOCK_MAX) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  // Только известные поля: сочетание клавиш, submit и disabled от модели не принимаются.
  const plain = raw.map((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return item;
    const { label, text, description } = item as Record<string, unknown>;
    return { label, text, ...(description === undefined ? {} : { description }) };
  });
  const seen = new Set<string>();
  const buttons: CommandButton[] = [];
  for (const button of parseCommands(plain, false).commands) {
    const key = button.label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    buttons.push({ label: button.label, text: button.text, submit: false, ...(button.description ? { description: button.description } : {}) });
    if (buttons.length === SUGGEST_MAX) break;
  }
  return buttons;
}
