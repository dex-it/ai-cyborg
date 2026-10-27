// Кнопки, которые предлагает модель (фича 12): инструкция сессии и разбор хвоста ответа.
// Чистый файл без Node: разбор вызывает главный процесс (событие Stop), инструкцию - сборка аргументов claude.

import { LABEL_MAX, parseCommands, type CommandButton } from './commands.ts';

export const SUGGEST_MAX = 2;
/** Хвост длиннее разбирать не стоит: две кнопки по пределам commands.ts умещаются с запасом. */
const SUGGEST_BLOCK_MAX = 20_000;
const MARKER = '<!-- cyborg-buttons:';
const END = '-->';
const SHELL_PREFIX = '!';
const SLASH_PREFIX = '/';

/** Инструкция сессии: когда и в каком виде предлагать кнопки (дописывается к системному промту, как инструкция об изоляции). */
export const SUGGEST_PROMPT =
  `Если после ответа человеку понятны 1-${SUGGEST_MAX} следующих шага, допиши в самом конце ответа, отдельной строкой, комментарий ` +
  `${MARKER} [{"label":"подпись до ${LABEL_MAX} знаков","text":"реплика человека к тебе, одной строкой"}] ${END} . ` +
  '"submit":true добавляй, только если реплику можно отправить без правки; иначе поле не пиши, и человек допишет реплику сам. ' +
  'Реплика не начинается с «!». ' +
  'Не очевидно, что делать дальше, - не пиши ничего. В тексте ответа комментарий не упоминай.';

/**
 * Кнопки из хвоста ответа: комментарий должен стоять в самом конце сообщения (процитированный из файла в середине ответа не в счёт).
 * Ответ модели недоверенный: поля проверяются как у кнопок файла, лишние поля отбрасываются. `submit` принимается (нажимает по-прежнему человек),
 * сочетание клавиш и отключение - нет. Claude Code выполняет ввод с «!» как команду оболочки без запроса разрешения (режим shell), а с «/» как свою
 * команду: такая реплика от модели отбрасывается («!») либо только вставляется без Enter («/»).
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
  // Только известные поля: сочетание клавиш и disabled от модели не принимаются.
  const plain = raw.map((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return item;
    const { label, text, submit, description } = item as Record<string, unknown>;
    return { label, text, ...(submit === undefined ? {} : { submit }), ...(description === undefined ? {} : { description }) };
  });
  const seen = new Set<string>();
  const buttons: CommandButton[] = [];
  for (const button of parseCommands(plain, false).commands) {
    const key = button.label.toLowerCase();
    if (seen.has(key)) continue;
    if (button.text.startsWith(SHELL_PREFIX)) continue;
    seen.add(key);
    buttons.push({ label: button.label, text: button.text, submit: button.submit && !button.text.startsWith(SLASH_PREFIX), ...(button.description ? { description: button.description } : {}) });
    if (buttons.length === SUGGEST_MAX) break;
  }
  return buttons;
}
