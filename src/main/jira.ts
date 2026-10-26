// Jira через jira-cli (ADR-0013): разбор его вывода, аргументы запросов, классификация отказов и начальный промпт.
// Чистые функции без запуска процессов и без Node: файл проверяется в npm test. Cyborg не читает конфиг и токен jira-cli,
// не пишет в Jira (FR-11010).
//
// `issue list --raw` у jira-cli - не ответ REST, а свой плоский вид (`fields.issueType`, у исполнителя только displayName),
// `issue view --raw` - тело REST как есть (комментарии с `author`, `self`). Разбор следует обоим видам; формы сверены
// модом dex-jira-tracker на jira-cli 1.7.0 и Jira Server 9.2 (на живой Jira Server 9.2 Cyborg прогнан 26.10.2026; Cloud и Data Center вживую не проверялись - D-11 фичи 11).

import { PROJECT_KEY } from './jira-keys';
import type { CliResult } from './trackers';

export const KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/;

/** Сколько задач берётся за один запрос списка и сколько последних комментариев - с деталями. */
export const JIRA_LIMIT = 50;
export const DETAIL_COMMENTS = 3;
const DESCRIPTION_MAX = 20_000;

/** Открытые задачи, назначенные на того, кто вошёл в jira-cli. Проекта и ORDER BY в запросе нет: `-p` и сортировку ставит вызов. */
export const MINE_JQL = 'assignee = currentUser() AND statusCategory != Done';

/** Из открытых моих - те, чья категория статуса «В работе»: в выводе списка категории нет, её даёт этот запрос ключей. */
export const PROGRESS_JQL = 'assignee = currentUser() AND statusCategory = "In Progress"';

export type JiraCategory = 'new' | 'indeterminate' | 'done' | '';

export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  /** Категория статуса (`new`, `indeterminate`, `done`): есть только в теле `issue view`, в списке - ''. */
  category: JiraCategory;
  type: string;
  priority: string;
  assignee: string | null;
  reporter: string | null;
  created: string;
  updated: string;
  labels: string[];
  /** Текст описания; в списке и деталях разный объём, поэтому поле необязательное для читателя. */
  description: string;
}

export interface JiraComment {
  author: string;
  created: string;
  text: string;
}

export interface JiraDetails {
  issue: JiraIssue;
  /** Последние комментарии (DETAIL_COMMENTS), старые первыми. */
  comments: JiraComment[];
  /** Всего комментариев у задачи. */
  total: number;
}

/** Почему Jira недоступна: нет бинаря, нет настройки, вход не принят, прочее. */
export type JiraProblem = 'missing' | 'setup' | 'auth' | 'error';

export type JiraStatus = { state: 'ready'; login: string; version: string } | { state: JiraProblem; message: string };

export interface JiraListResult {
  issues: JiraIssue[];
  /** В выборке ровно предельное число задач: возможно, есть ещё. */
  truncated: boolean;
  problem?: JiraProblem;
  error?: string;
  /** Проекты, по которым запрос не удался, когда по другим он удался: «KEY: причина». */
  notes?: string[];
}

export interface JiraProject {
  key: string;
  name: string;
}

export type JiraProjectsResult = { projects: JiraProject[] } | { problem: JiraProblem; error: string };

/** Ключ проекта Jira, найденный в ветках репозиториев, и сколько веток его называют. */
export interface JiraSuggestion {
  key: string;
  count: number;
}

export type JiraDetailsResult = { details: JiraDetails } | { problem: JiraProblem; error: string };

export type JiraUrlResult = { url: string } | { error: string };

// ---------- чужой текст ----------

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
// Всё ниже пробела, кроме табуляции и перевода строки, DEL и блок C1: чужой текст с управляющими кодами не должен их нести.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

export const clean = (value: string): string => value.replace(ANSI, '').replace(/\r\n?/g, '\n').replace(CONTROL, '');

const rec = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function adfText(node: unknown): string {
  const item = rec(node);
  const type = str(item.type);
  if (type === 'text') return str(item.text);
  if (type === 'hardBreak') return '\n';
  if (type === 'mention') return str(rec(item.attrs).text);
  if (type === 'emoji') return str(rec(item.attrs).shortName);
  const inner = list(item.content).map(adfText).join('');
  return ['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote'].includes(type) ? `${inner}\n` : inner;
}

/** Тело описания или комментария: Jira Cloud присылает документ ADF, Server и Data Center - строку с вики-разметкой, её оставляем как есть. */
export function bodyText(value: unknown): string {
  const text = typeof value === 'string' ? clean(value) : clean(adfText(value)).trim();
  return text.length > DESCRIPTION_MAX ? `${text.slice(0, DESCRIPTION_MAX)}…` : text;
}

const nameOf = (value: unknown): string | null => {
  const item = rec(value);
  const name = str(item.displayName) || str(item.name);
  return name === '' ? null : clean(name);
};

const CATEGORIES: readonly string[] = ['new', 'indeterminate', 'done'];

// ---------- разбор ----------

/** Запись `issue list --raw` либо тело `issue view --raw`: у обеих есть `key` и `fields`. */
export function issueOfRaw(raw: unknown): JiraIssue | null {
  const item = rec(raw);
  const key = str(item.key);
  if (!KEY_RE.test(key)) return null;
  const fields = rec(item.fields);
  const category = str(rec(rec(fields.status).statusCategory).key);
  return {
    key,
    summary: clean(str(fields.summary)),
    status: nameOf(fields.status) ?? '',
    category: (CATEGORIES.includes(category) ? category : '') as JiraCategory,
    type: nameOf(fields.issueType) ?? nameOf(fields.issuetype) ?? '',
    priority: nameOf(fields.priority) ?? '',
    assignee: nameOf(fields.assignee),
    reporter: nameOf(fields.reporter),
    created: str(fields.created),
    updated: str(fields.updated),
    labels: list(fields.labels)
      .map((label) => (typeof label === 'string' ? label : (nameOf(label) ?? '')))
      .filter((label) => label !== '')
      .map(clean),
    description: bodyText(fields.description),
  };
}

/** `issue list --raw`: массив JSON; по пустой выборке - пусто или `null`. Не JSON - исключение. */
export function parseIssues(stdout: string): JiraIssue[] {
  const body = stdout.trim();
  if (body === '' || body === 'null') return [];
  return list(JSON.parse(body)).flatMap((entry) => {
    const issue = issueOfRaw(entry);
    return issue ? [issue] : [];
  });
}

/** `issue view --raw`; null - в теле нет задачи. Не JSON - исключение. */
export function parseDetails(stdout: string): JiraDetails | null {
  const raw: unknown = JSON.parse(stdout);
  const issue = issueOfRaw(raw);
  if (!issue) return null;
  const block = rec(rec(rec(raw).fields).comment);
  const comments = list(block.comments).flatMap((entry): JiraComment[] => {
    const comment = rec(entry);
    if (str(comment.id) === '') return [];
    return [{ author: nameOf(comment.author) ?? '?', created: str(comment.created), text: bodyText(comment.body) }];
  });
  return { issue, comments, total: typeof block.total === 'number' ? block.total : comments.length };
}

/**
 * `jira project list`: таблица через табуляцию (KEY, NAME, TYPE, LEAD; пустые колонки добиты табами), флагов --plain и --raw у команды нет.
 * Нужны ключ и название; строка заголовка и строки без ключа по форме пропускаются.
 */
export function parseProjects(stdout: string): JiraProject[] {
  const out: JiraProject[] = [];
  for (const line of clean(stdout).split('\n')) {
    const cells = line.split('\t').map((cell) => cell.trim()).filter((cell) => cell !== '');
    const key = cells[0] ?? '';
    if (!PROJECT_KEY.test(key) || (key === 'KEY' && cells[1] === 'NAME')) continue;
    out.push({ key: key.toUpperCase(), name: cells[1] ?? '' });
  }
  return out;
}

const BRANCH_KEY = /(?<![A-Za-z0-9_])([A-Za-z][A-Za-z0-9_]*)-\d+(?![0-9])/g;

/** Проекты Jira, чьи ключи стоят в именах веток (`feature/dex-12-fix`): только те, что есть в known (иначе `utf-8` стал бы «проектом UTF»); частые первыми. */
export function suggestKeys(branches: readonly string[], known: ReadonlySet<string>): JiraSuggestion[] {
  const count = new Map<string, number>();
  for (const branch of branches) {
    const seen = new Set<string>();
    for (const match of branch.matchAll(BRANCH_KEY)) seen.add(match[1].toUpperCase());
    for (const key of seen) if (known.has(key)) count.set(key, (count.get(key) ?? 0) + 1);
  }
  return [...count].map(([key, n]) => ({ key, count: n })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

// ---------- аргументы ----------

const projectArgs = (project: string): string[] => (project === '' ? [] : ['-p', project]);

/** Открытые задачи на меня, свежие первыми. `-q` jira-cli сам помещает в контекст проекта (`-p` либо из `jira init`). */
export const jiraListArgs = (project: string, limit = JIRA_LIMIT): string[] => [
  'issue', 'list', '-q', MINE_JQL, '--raw', '--order-by', 'updated', '--paginate', `0:${limit}`, ...projectArgs(project),
];

/** Только ключи задач в работе: колонка KEY без заголовков. */
export const jiraProgressArgs = (project: string, limit = JIRA_LIMIT): string[] => [
  'issue', 'list', '-q', PROGRESS_JQL, '--plain', '--no-headers', '--columns', 'key', '--order-by', 'updated', '--paginate', `0:${limit}`, ...projectArgs(project),
];

/** Ключи из plain-вывода: по строке на задачу, ключ - первое слово; не по форме пропускается. */
export function parseKeys(stdout: string): Set<string> {
  const keys = new Set<string>();
  for (const line of clean(stdout).split('\n')) {
    const key = line.trim().split(/\s+/)[0] ?? '';
    if (KEY_RE.test(key)) keys.add(key);
  }
  return keys;
}

export const jiraViewArgs = (key: string, project: string): string[] => [
  'issue', 'view', key, '--raw', '--comments', String(DETAIL_COMMENTS), ...projectArgs(project),
];

export const jiraProjectsArgs = (): string[] => ['project', 'list'];

export const jiraOpenArgs = (key: string, project: string): string[] => ['open', key, '--no-browser', ...projectArgs(project)];

// ---------- отказы ----------

// jira-cli без токена пишет "The tool needs a Jira API token to function", иначе - слова сервера (Unauthorized, 401/403).
const AUTH = /api token|unauthori[sz]ed|\b40[13]\b|forbidden|authenticat|bad credentials/i;
const SETUP = /no such file|config file|not initiali[sz]ed|jira init/i;
const EMPTY = /no result found/i;
const MISSING = /does not exist|not found|\b404\b/i;

/** Текст отказа: stderr (иначе stdout) без управляющих кодов, строки без заголовка «Error:», первые две. */
export function failureText(result: Pick<CliResult, 'stderr' | 'stdout' | 'code'>): string {
  const text = clean(result.stderr.trim() === '' ? result.stdout : result.stderr);
  const lines = text
    .split('\n')
    .map((line) => line.replace(/^\s*[-✗x]\s+/, '').trim())
    .filter((line) => line !== '' && !/^error:?$/i.test(line));
  return lines.slice(0, 2).join(' ') || `jira завершился с кодом ${result.code ?? '?'}`;
}

export const isEmptyResult = (text: string): boolean => EMPTY.test(text);
export const isMissingIssue = (text: string): boolean => MISSING.test(text);

export function problemOf(text: string): JiraProblem {
  if (AUTH.test(text)) return 'auth';
  return SETUP.test(text) ? 'setup' : 'error';
}

/** Что сказать человеку: факт и команда, которая его исправляет. */
export function problemText(problem: JiraProblem, reason: string): string {
  if (problem === 'missing') return 'jira-cli не установлен: brew tap ankitpokhrel/jira-cli && brew install jira-cli';
  if (problem === 'setup') return `jira-cli не настроен (${reason}). Выполните в терминале: jira init`;
  if (problem === 'auth') return `jira-cli не вошёл в Jira (${reason}). Токен: JIRA_API_TOKEN (Cloud - email и API-токен, Server - JIRA_AUTH_TYPE=bearer и PAT), затем jira init`;
  return `jira-cli отказал: ${reason}`;
}

// ---------- сессия ----------

/** Начальный промпт сессии по задаче: только ключ, без названия и описания (чужой текст в промпт не попадает). */
export const jiraPrompt = (key: string): string =>
  `Задача Jira ${key}: прочитай её (jira issue view ${key} --comments 5), разберись в постановке и предложи план работ. Код не правь, пока я не подтвержу план.`;

/** Аргумент session:create: `{ jira: { key } }`; null - ключ не по форме. */
export function validateJiraStart(value: unknown): string | null {
  const key = rec(value).key;
  return typeof key === 'string' && KEY_RE.test(key) ? key : null;
}
