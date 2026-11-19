// Промпты кнопок запуска сессий (фича 12): первое сообщение сессии из «Ревью», «Доработать», «CI», «Взять в работу» и сессии по задаче Jira.
// Чистый файл без Node: проверку при записи и сборку текста делает главный процесс, подсказки и вид окна «Кнопки» - интерфейс.

import { CONTROL, LABEL_MAX, MAX_COMMANDS, TEXT_MAX, sameLabel, type ButtonIssue } from './commands';

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
/** Ключ файла промптов со своими кнопками запуска сессий. */
export const BUTTONS_KEY = 'buttons';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isPromptId = (id: string): id is PromptId => (PROMPT_IDS as string[]).includes(id);

/** Правило первого сообщения сессии, общее для встроенных и своих кнопок запуска: claude берёт его позиционным аргументом, ведущий «-» он принял бы за параметр. */
export function promptTextProblem(text: unknown, allowed: readonly string[]): string | null {
  if (typeof text !== 'string' || !text.trim() || text.length > TEXT_MAX || CONTROL.test(text)) return `text - непустая строка до ${TEXT_MAX} знаков в одну строку без управляющих символов`;
  if (text.trim().startsWith('-')) return 'text не может начинаться с «-»: claude принял бы его за параметр';
  const unknown = [...new Set([...text.matchAll(ANY_PLACEHOLDER)].map((m) => m[1]))].filter((name) => !allowed.includes(name));
  if (unknown.length) return `неизвестная подстановка ${unknown.map((n) => `{${n}}`).join(', ')} (есть: ${allowed.map((n) => `{${n}}`).join(', ')})`;
  return null;
}

const descriptionProblem = (description: unknown): string | null =>
  typeof description === 'string' && description.trim() && description.length <= PROMPT_DESCRIPTION_MAX && !CONTROL.test(description) ? null : `description - непустая строка до ${PROMPT_DESCRIPTION_MAX} знаков в одну строку`;

export interface ParsedPrompts {
  /** Годные записи файла (без встроенных). */
  prompts: Partial<Record<PromptId, PromptTemplate>>;
  problems: string[];
}

/** Поле файла промптов `prompts.json` в userData. Негодная запись пропускается, причина - в problems; запись с id, которого нет, и лишнее поле называются. Подстановка, которой у промпта нет (`{mr_ulr}`), - ошибка: в запрос к модели ушёл бы литерал. */
export function parsePrompts(raw: unknown): ParsedPrompts {
  if (raw === undefined) return { prompts: {}, problems: [] };
  if (!isRecord(raw)) return { prompts: {}, problems: ['prompts должен быть объектом: { "mr.review": { "text": ... } }'] };
  const prompts: Partial<Record<PromptId, PromptTemplate>> = {};
  const problems: string[] = [];
  for (const [id, item] of Object.entries(raw)) {
    if (id === BUTTONS_KEY) continue;
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
    const textProblem = promptTextProblem(text, PROMPT_PLACEHOLDERS[id]);
    if (textProblem) {
      problems.push(`${at}: ${textProblem}`);
      continue;
    }
    const template: PromptTemplate = { text: (text as string).trim() };
    const descProblem = description === undefined ? null : descriptionProblem(description);
    if (descProblem) problems.push(`${at}: ${descProblem}`);
    else if (typeof description === 'string') template.description = description.trim();
    const extra = Object.keys(item).filter((key) => !KNOWN_FIELDS.has(key));
    if (extra.length) problems.push(`${at}: неизвестное поле ${extra.join(', ')}`);
    prompts[id] = template;
  }
  return { prompts, problems };
}

/** Шаблон промпта для старта сессии: запись файла либо встроенный текст. Негодная запись названа ошибкой, а не заменена встроенной молча: сессия по такой кнопке не стартует, пока файл не исправят. */
export function promptTemplate(id: PromptId, raw: unknown): string {
  const parsed = parsePrompts(raw);
  if (raw !== undefined && !isRecord(raw)) throw new Error(`${parsed.problems[0]}. Исправьте файл промптов или меню «Воркспейс → Кнопки…».`);
  const own = parsed.prompts[id];
  if (own) return own.text;
  const problem = parsed.problems.find((p) => p.startsWith(`Промпт «${id}»`));
  if (problem) throw new Error(`${problem}. Исправьте файл промптов или меню «Воркспейс → Кнопки…».`);
  return DEFAULT_PROMPTS[id].text;
}

/** Один проход: подставленное значение заново не разбирается. */
export const fillPrompt = (template: string, values: Readonly<Record<string, string>>): string =>
  template.replace(ANY_PLACEHOLDER, (all, name: string) => values[name] ?? all);
export type LaunchPlace = 'mr' | 'task' | 'jira';
export const LAUNCH_PLACES: readonly LaunchPlace[] = ['mr', 'task', 'jira'];

/** Подстановки своих кнопок запуска: только значения своего места. */
export const PLACE_PLACEHOLDERS: Readonly<Record<LaunchPlace, readonly string[]>> = { mr: ['mr_url'], task: ['task_url', 'status_command'], jira: ['jira_key'] };

/** Встроенные кнопки запуска по местам: подпись в окне и подпись на карточке. */
export const BUILTIN_LAUNCH: Readonly<Record<LaunchPlace, readonly { id: PromptId; label: string; card: string }[]>> = {
  mr: [
    { id: 'mr.review', label: 'Ревью', card: 'Ревью' },
    { id: 'mr.rework', label: 'Доработать', card: 'Доработать' },
    { id: 'mr.ci', label: 'CI', card: 'Разобрать пайплайн' },
  ],
  task: [{ id: 'task.start', label: 'Взять в работу', card: 'Начать' }],
  jira: [{ id: 'jira.start', label: 'Сессия по задаче Jira', card: 'Начать' }],
};

/** Своя кнопка запуска: хранится в prompts.json и действует во всех воркспейсах. */
export interface LaunchButton {
  place: LaunchPlace;
  label: string;
  text: string;
  description?: string;
  disabled?: boolean;
}

export interface BadLaunchButton {
  index: number;
  place?: LaunchPlace;
  label?: string;
  message: string;
  /** Запись выключена человеком: на карточке её нет, даже негодной. */
  disabled?: true;
  /** Подпись повторена на том же месте: на карточке стоит первая кнопка, эта не показывается. */
  duplicate?: true;
}

export interface ParsedLaunchButtons {
  buttons: LaunchButton[];
  bad: BadLaunchButton[];
  issues: ButtonIssue[];
}

const LAUNCH_FIELDS = new Set(['place', 'label', 'text', 'description', 'disabled']);

/** Ключ buttons файла промптов. Негодная кнопка пропускается и называется, прочие кнопки это не затрагивает. */
export function parseLaunchButtons(raw: unknown): ParsedLaunchButtons {
  const out: ParsedLaunchButtons = { buttons: [], bad: [], issues: [] };
  const list = isRecord(raw) ? raw[BUTTONS_KEY] : undefined;
  if (list === undefined) return out;
  if (!Array.isArray(list)) {
    out.issues.push({ place: 'mr', layer: 'global', message: 'buttons - массив кнопок' });
    return out;
  }
  if (list.length > MAX_COMMANDS) out.issues.push({ place: 'mr', layer: 'global', message: `Своих кнопок запуска больше ${MAX_COMMANDS}: лишние пропущены` });
  list.slice(0, MAX_COMMANDS).forEach((item, index) => {
    const reject = (message: string, place?: LaunchPlace, label?: string, field?: ButtonIssue['field'], duplicate?: true): void => {
      const at = `Кнопка запуска ${index + 1}${label ? ` («${label}»)` : ''}`;
      const off = isRecord(item) && item.disabled === true;
      out.bad.push({ index, ...(place ? { place } : {}), ...(label ? { label } : {}), message: `${at}: ${message}`, ...(off ? { disabled: true as const } : {}), ...(duplicate ? { duplicate } : {}) });
      out.issues.push({ place: place ?? 'mr', layer: 'global', index, ...(label ? { label } : {}), ...(field ? { field } : {}), message: `${at}: ${message}` });
    };
    if (!isRecord(item)) return reject('не объект');
    const { place, label, text, description, disabled } = item;
    const named = typeof label === 'string' && label.trim() ? label.trim() : undefined;
    if (typeof place !== 'string' || !(LAUNCH_PLACES as readonly string[]).includes(place)) return reject(`place - ${LAUNCH_PLACES.join(', ')}`, undefined, named, 'place');
    const at = place as LaunchPlace;
    if (named === undefined || named.length > LABEL_MAX || CONTROL.test(label as string)) return reject(`label - непустая строка до ${LABEL_MAX} знаков без управляющих символов`, at, named, 'label');
    if (BUILTIN_LAUNCH[at].some((b) => sameLabel(b.label, named))) return reject('подпись встроенной кнопки этого места', at, named, 'label');
    if (out.buttons.some((b) => b.place === at && sameLabel(b.label, named))) return reject('подпись повторена, действует первая кнопка', at, named, 'label', true);
    const textProblem = promptTextProblem(text, PLACE_PLACEHOLDERS[at]);
    if (textProblem) return reject(textProblem, at, named, 'text');
    const descProblem = description === undefined ? null : descriptionProblem(description);
    if (descProblem) return reject(descProblem, at, named, 'description');
    if (disabled !== undefined && typeof disabled !== 'boolean') return reject('disabled - true или false', at, named, 'disabled');
    const extra = Object.keys(item).filter((key) => !LAUNCH_FIELDS.has(key));
    if (extra.length) return reject(`неизвестное поле ${extra.join(', ')}`, at, named);
    out.buttons.push({ place: at, label: named, text: (text as string).trim(), ...(typeof description === 'string' ? { description: description.trim() } : {}), ...(disabled === true ? { disabled: true } : {}) });
  });
  // Подпись уже занята на месте: негодную с ней на карточке нет, иначе подсказка по подписи покажет чужую запись.
  out.bad.forEach((b, i) => {
    if (b.duplicate || b.place === undefined || b.label === undefined) return;
    const same = (x: { place?: LaunchPlace; label?: string }): boolean => x.place === b.place && x.label !== undefined && sameLabel(x.label, b.label as string);
    if (out.buttons.some(same) || out.bad.slice(0, i).some((x) => !x.duplicate && !x.disabled && same(x))) b.duplicate = true;
  });
  return out;
}

/** Шаблон своей кнопки запуска для старта сессии: негодная и выключенная названы ошибкой, исчезнувшая - тоже. */
export function launchTemplate(place: LaunchPlace, label: string, raw: unknown): string {
  if (raw !== undefined && !isRecord(raw)) throw new Error(`prompts должен быть объектом. Исправьте файл промптов или меню «Воркспейс → Кнопки…».`);
  const parsed = parseLaunchButtons(raw);
  const found = parsed.buttons.find((b) => b.place === place && sameLabel(b.label, label));
  if (found) {
    if (found.disabled) throw new Error(`Кнопка «${found.label}» выключена. Включите её в меню «Воркспейс → Кнопки…».`);
    return found.text;
  }
  const bad = parsed.bad.find((b) => b.place === place && b.label !== undefined && sameLabel(b.label, label));
  if (bad) throw new Error(`${bad.message}. Исправьте её в меню «Воркспейс → Кнопки…».`);
  throw new Error(`Кнопки «${label}» больше нет`);
}

/** Подсказка кнопки запуска: описание и промпт-шаблон; у негодной - причина. Прочитано из prompts.json как есть. */
export function launchTitle(place: LaunchPlace, key: PromptId | string, raw: unknown): string {
  const builtin = BUILTIN_LAUNCH[place].find((b) => b.id === key);
  if (builtin) {
    const parsed = parsePrompts(raw);
    const problem = parsed.problems.find((x) => x.startsWith(`Промпт «${builtin.id}»`));
    if (problem) return problem;
    const own = parsed.prompts[builtin.id];
    const description = own?.description ?? (own ? undefined : DEFAULT_PROMPTS[builtin.id].description);
    return [description, own?.text ?? DEFAULT_PROMPTS[builtin.id].text].filter(Boolean).join('\n\n');
  }
  const parsed = parseLaunchButtons(raw);
  const found = parsed.buttons.find((b) => b.place === place && sameLabel(b.label, key));
  if (found) return [found.description, found.text].filter(Boolean).join('\n\n');
  return parsed.bad.find((b) => b.place === place && b.label !== undefined && !b.disabled && !b.duplicate && sameLabel(b.label, key))?.message ?? '';
}
/** Предел текста файла промптов, принимаемого главным процессом от интерфейса. */
export const MAX_PROMPTS_TEXT = 100_000;

/** Запись файла без лишнего: промпт, совпавший со встроенным, и пустой список своих кнопок в файл не пишутся. */
export function compactPrompts(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [id, item] of Object.entries(raw)) {
    if (id === BUTTONS_KEY) {
      if (Array.isArray(item) && item.length === 0) continue;
    } else if (isPromptId(id) && isRecord(item) && item.text === DEFAULT_PROMPTS[id].text && item.description === DEFAULT_PROMPTS[id].description && Object.keys(item).length === 2) continue;
    out[id] = item;
  }
  return out;
}
