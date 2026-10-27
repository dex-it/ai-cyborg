// Промпты кнопок запуска сессий (фича 12): первое сообщение сессии из «Ревью», «Доработать», «CI», «Взять в работу» и сессии по задаче Jira.
// Чистый файл без Node: проверку при записи и сборку текста делает главный процесс, действующий набор для редактора - интерфейс.

import { CONTROL, TEXT_MAX } from './commands';

export type PromptId = 'mr.review' | 'mr.rework' | 'mr.ci' | 'task.start' | 'jira.start';

export interface PromptTemplate {
  text: string;
  description?: string;
}

/** Подстановки каждого промпта. Значения берутся только из проверенных ссылок и ключей: название, ветки и автор (чужой текст) в промпт не попадают. */
export const PROMPT_PLACEHOLDERS: Readonly<Record<PromptId, readonly string[]>> = {
  'mr.review': ['mr_url'],
  'mr.rework': ['mr_url'],
  'mr.ci': ['mr_url'],
  'task.start': ['task_url', 'status_command'],
  'jira.start': ['jira_key'],
};

export const PROMPT_IDS = Object.keys(PROMPT_PLACEHOLDERS) as PromptId[];

/** Встроенные промпты: то, что приложение отправляло до появления файла настроек. */
export const DEFAULT_PROMPTS: Readonly<Record<PromptId, Required<PromptTemplate>>> = {
  'mr.review': {
    text: '/dex-auto:auto review {mr_url}',
    description: 'Кнопка «Ревью» у MR (список MR и карточка «Статус»): запрос ревью слеш-командой плагина dex-auto. Подстановка: {mr_url} - ссылка на MR.',
  },
  'mr.rework': {
    text: 'Разбери замечания к MR {mr_url}: переключись на его ветку и доработай её по замечаниям ревью.',
    description: 'Кнопка «Доработать» у MR: разобрать замечания ревью. Подстановка: {mr_url} - ссылка на MR.',
  },
  'mr.ci': {
    text: 'Пайплайн MR {mr_url} упал: найди причину в логах упавших заданий, переключись на ветку MR и исправь её.',
    description: 'Кнопка «CI» у MR (в том числе в «Статусе»): разобрать упавший пайплайн. Подстановка: {mr_url} - ссылка на MR.',
  },
  'task.start': {
    text: 'Ознакомься с задачей {task_url}. Когда приступишь к работе, смени её статус в трекере ({status_command}), чтобы было видно, что задача в работе.',
    description: 'Сессия по задаче GitHub или GitLab. Подстановки: {task_url} - ссылка на задачу, {status_command} - «gh issue edit» либо «glab issue update».',
  },
  'jira.start': {
    text: 'Задача Jira {jira_key}: прочитай её (jira issue view {jira_key} --comments 5), разберись в постановке и предложи план работ. Код не правь, пока я не подтвержу план.',
    description: 'Сессия по задаче Jira. Подстановка: {jira_key} - ключ задачи.',
  },
};

/** Описания встроенных промптов называют подстановки, поэтому длиннее описаний кнопок полосы. */
export const PROMPT_DESCRIPTION_MAX = 400;
const ANY_PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const KNOWN_FIELDS = new Set(['text', 'description']);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isPromptId = (id: string): id is PromptId => (PROMPT_IDS as string[]).includes(id);

export interface ParsedPrompts {
  /** Годные записи файла (без встроенных). */
  prompts: Partial<Record<PromptId, PromptTemplate>>;
  problems: string[];
}

/**
 * Поле `prompts` файла воркспейса. Негодная запись пропускается, причина - в problems; запись с id, которого нет, и лишнее поле называются.
 * Подстановка, которой у промпта нет (`{mr_ulr}`), - ошибка: в запрос к модели ушёл бы литерал.
 */
export function parsePrompts(raw: unknown): ParsedPrompts {
  if (raw === undefined) return { prompts: {}, problems: [] };
  if (!isRecord(raw)) return { prompts: {}, problems: ['prompts должен быть объектом: { "mr.review": { "text": ... } }'] };
  const prompts: Partial<Record<PromptId, PromptTemplate>> = {};
  const problems: string[] = [];
  for (const [id, item] of Object.entries(raw)) {
    const at = `Промпт «${id}»`;
    if (!isPromptId(id)) {
      problems.push(`${at}: нет такого промпта (есть: ${PROMPT_IDS.join(', ')})`);
      continue;
    }
    if (!isRecord(item)) {
      problems.push(`${at}: не объект`);
      continue;
    }
    const { text, description } = item;
    if (typeof text !== 'string' || !text.trim() || text.length > TEXT_MAX || CONTROL.test(text)) {
      problems.push(`${at}: text - непустая строка до ${TEXT_MAX} знаков в одну строку без управляющих символов`);
      continue;
    }
    // Первое сообщение идёт позиционным аргументом claude: ведущий «-» он принял бы за параметр.
    if (text.trim().startsWith('-')) {
      problems.push(`${at}: text не может начинаться с «-»: claude принял бы его за параметр`);
      continue;
    }
    const allowed = PROMPT_PLACEHOLDERS[id];
    const unknown = [...new Set([...text.matchAll(ANY_PLACEHOLDER)].map((m) => m[1]))].filter((name) => !allowed.includes(name));
    if (unknown.length) {
      problems.push(`${at}: неизвестная подстановка ${unknown.map((n) => `{${n}}`).join(', ')} (есть: ${allowed.map((n) => `{${n}}`).join(', ')})`);
      continue;
    }
    const template: PromptTemplate = { text: text.trim() };
    if (typeof description === 'string' && description.trim() && description.length <= PROMPT_DESCRIPTION_MAX && !CONTROL.test(description)) template.description = description.trim();
    else if (description !== undefined) problems.push(`${at}: description - непустая строка до ${PROMPT_DESCRIPTION_MAX} знаков в одну строку`);
    const extra = Object.keys(item).filter((key) => !KNOWN_FIELDS.has(key));
    if (extra.length) problems.push(`${at}: неизвестное поле ${extra.join(', ')}`);
    prompts[id] = template;
  }
  return { prompts, problems };
}

/**
 * Действующий набор в том виде, как он записывается в файл: встроенные промпты (с описаниями) и записи файла как они есть.
 * Записи берутся без разбора: негодную можно увидеть и поправить, а не потерять при сохранении.
 */
export function effectivePrompts(raw: unknown): Record<string, unknown> {
  const own = isRecord(raw) ? raw : {};
  const merged: Record<string, unknown> = {};
  for (const id of PROMPT_IDS) merged[id] = own[id] ?? DEFAULT_PROMPTS[id];
  for (const [id, item] of Object.entries(own)) if (!(id in merged)) merged[id] = item;
  return merged;
}

export const promptsToText = (raw: unknown): string => JSON.stringify(effectivePrompts(raw), null, 2);

/** Проверка текста редактора: не JSON, не объект либо любая проблема - отказ с причиной, файл не пишется. */
export function checkPromptsText(text: string): { ok: true; prompts: Record<string, unknown> } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `Не JSON: ${(error as Error).message}` };
  }
  if (!isRecord(raw)) return { ok: false, error: 'Нужен объект: { "mr.review": { "text": ... } }' };
  const { problems } = parsePrompts(raw);
  return problems.length ? { ok: false, error: problems.join('\n') } : { ok: true, prompts: raw };
}

/** Предел текста файла промптов, принимаемого главным процессом от интерфейса. */
export const MAX_PROMPTS_TEXT = 100_000;

/** Запись из редактора: текст проверяется заново (интерфейсу не доверяют), ошибка проверки или записи - в ответе, а не исключением. */
export function savePromptsText(text: unknown, store: { savePrompts(prompts: Record<string, unknown>): void }): { error?: string } {
  if (typeof text !== 'string' || text.length > MAX_PROMPTS_TEXT) return { error: 'Некорректный текст промптов' };
  const checked = checkPromptsText(text);
  if (!checked.ok) return { error: checked.error };
  try {
    store.savePrompts(checked.prompts);
  } catch (error) {
    return { error: (error as Error).message };
  }
  return {};
}

/**
 * Шаблон промпта для старта сессии: запись файла либо встроенный текст. Негодная запись названа ошибкой, а не заменена встроенной молча:
 * сессия по такой кнопке не стартует, пока файл не исправят.
 */
export function promptTemplate(id: PromptId, raw: unknown): string {
  const parsed = parsePrompts(raw);
  if (raw !== undefined && !isRecord(raw)) throw new Error(`${parsed.problems[0]}. Исправьте файл воркспейса или меню «Воркспейс → Промпты кнопок…».`);
  const own = parsed.prompts[id];
  if (own) return own.text;
  const problem = parsed.problems.find((p) => p.startsWith(`Промпт «${id}»`));
  if (problem) throw new Error(`${problem}. Исправьте файл воркспейса или меню «Воркспейс → Промпты кнопок…».`);
  return DEFAULT_PROMPTS[id].text;
}

/** Один проход: подставленное значение заново не разбирается. */
export const fillPrompt = (template: string, values: Readonly<Record<string, string>>): string =>
  template.replace(ANY_PLACEHOLDER, (all, name: string) => values[name] ?? all);
