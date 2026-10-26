// Jira через jira-cli (ADR-0013): список моих задач, детали, адрес для браузера и проверка входа. Только чтение (FR-11010):
// `jira version`, `jira me`, `jira issue list`, `jira issue view`, `jira open --no-browser`. Конфиг и токен jira-cli Cyborg не читает.
import {
  failureText,
  isEmptyResult,
  isMissingIssue,
  jiraListArgs,
  jiraOpenArgs,
  jiraProgressArgs,
  jiraProjectsArgs,
  jiraViewArgs,
  JIRA_LIMIT,
  KEY_RE,
  parseDetails,
  parseIssues,
  parseKeys,
  parseProjects,
  problemOf,
  problemText,
  suggestKeys,
  timeOf,
  type JiraDetailsResult,
  type JiraListResult,
  type JiraIssue,
  type JiraProblem,
  type JiraProject,
  type JiraProjectsResult,
  type JiraSuggestion,
  type JiraStatus,
  type JiraUrlResult,
} from './jira';
import type { ProjectsState } from './projects';
import type { CliResult, JiraRunner } from './trackers';

/** Как долго список проектов Jira считается свежим. */
const PROJECTS_TTL_MS = 10 * 60_000;

interface Refusal {
  problem: JiraProblem;
  error: string;
}

/** Причина, по которой запуск `jira` не дал ответа; null - процесс отработал (код выхода судит вызывающий). */
function launchFailure(res: CliResult): Refusal | null {
  if (res.missing) return { problem: 'missing', error: problemText('missing', '') };
  if (res.failure === 'timeout') return { problem: 'error', error: 'jira не ответил вовремя' };
  if (res.failure === 'overflow') return { problem: 'error', error: 'ответ jira слишком велик' };
  return null;
}

export class JiraService {
  /**
   * Вход не принят: опрос стоит, пока человек не нажал «Обновить» (recheck). Сервер, который снова и снова видит неверные
   * учётные данные, блокирует учётную запись (Jira Server: капча, затем блок), поэтому таймер повторять запрос не должен.
   */
  private blocked: Refusal | null = null;
  /** Ключи последнего списка по проектам: детали и адрес запрашиваются только по задаче, которую главный процесс сам вернул. */
  private readonly seen = new Map<string, Set<string>>();
  private projectsCache: { at: number; projects: JiraProject[] } | null = null;

  constructor(
    private readonly run: JiraRunner,
    private readonly projects_: () => ProjectsState,
  ) {}

  /** Бинарь и вход: для диалога проекта. Успех снимает блокировку опроса. */
  async status(): Promise<JiraStatus> {
    const version = await this.run('jira', ['version']);
    const lost = launchFailure(version);
    if (lost) return { state: lost.problem, message: lost.error };
    if (version.code !== 0) return { state: 'missing', message: problemText('missing', '') };
    const me = await this.run('jira', ['me']);
    const failed = launchFailure(me);
    if (failed) return { state: failed.problem, message: failed.error };
    if (me.code !== 0) {
      const text = failureText(me);
      const problem = problemOf(text);
      return { state: problem, message: problemText(problem, text) };
    }
    this.blocked = null;
    const login = me.stdout.split('\n')[0]?.trim() ?? '';
    return { state: 'ready', login, version: /Version="([^"]+)"/.exec(version.stdout)?.[1] ?? '' };
  }

  async list(projectId: string, recheck: boolean): Promise<JiraListResult> {
    const settings = this.projects_().projects.find((p) => p.id === projectId)?.jira;
    if (!settings?.enabled) return { issues: [], truncated: false, problem: 'error', error: 'Jira выключена в свойствах проекта' };
    if (recheck) this.blocked = null;
    if (this.blocked) return { issues: [], truncated: false, ...this.blocked };
    // Пустой выбор - один запрос без `-p` (проект из `jira init`); иначе по запросу на проект: `jira -p` берёт один.
    const keys = settings.projects?.length ? settings.projects : [''];
    const parts = await Promise.all(keys.map((key) => this.fetchIssues(key)));
    const done = parts.flatMap((part) => ('issues' in part ? [part] : []));
    const failed = parts.flatMap((part, i) => ('issues' in part ? [] : [{ key: keys[i], ...part }]));
    if (!done.length) {
      const first = failed.find((f) => f.problem === 'auth') ?? failed[0];
      return { issues: [], truncated: false, problem: first.problem, error: keys.length > 1 && first.key ? `${first.key}: ${first.error}` : first.error };
    }
    const byKey = new Map<string, JiraIssue>();
    for (const issue of done.flatMap((part) => part.issues)) if (!byKey.has(issue.key)) byKey.set(issue.key, issue);
    const merged = [...byKey.values()].sort((a, b) => timeOf(b.updated) - timeOf(a.updated));
    const shown = merged.slice(0, JIRA_LIMIT);
    this.seen.set(projectId, new Set(shown.map((issue) => issue.key)));
    return {
      issues: shown,
      truncated: merged.length > JIRA_LIMIT || done.some((part) => part.truncated),
      ...(failed.length ? { notes: failed.map((f) => `${f.key}: ${f.error}`) } : {}),
    };
  }

  /** Задачи одного проекта (пустой ключ - без `-p`): список, ключи «в работе» вторым запросом, категории проставлены. */
  private async fetchIssues(project: string): Promise<{ issues: JiraIssue[]; truncated: boolean } | Refusal> {
    // Категории статуса в списке нет: ключи «в работе» берутся вторым запросом, его отказ только оставляет категории пустыми.
    const [res, progress] = await Promise.all([this.run('jira', jiraListArgs(project)), this.run('jira', jiraProgressArgs(project))]);
    const lost = launchFailure(res);
    if (lost) return lost;
    if (res.code !== 0) {
      const text = failureText(res);
      if (isEmptyResult(text)) return { issues: [], truncated: false };
      const problem = problemOf(text);
      const refusal = { problem, error: problemText(problem, text) };
      if (problem === 'auth') this.blocked = refusal;
      return refusal;
    }
    try {
      const inProgress = progress.code === 0 ? parseKeys(progress.stdout) : new Set<string>();
      const issues = parseIssues(res.stdout).map((issue) => (inProgress.has(issue.key) ? { ...issue, category: 'indeterminate' as const } : issue));
      return { issues, truncated: issues.length >= JIRA_LIMIT };
    } catch {
      return { problem: 'error', error: 'jira issue list: ответ не JSON' };
    }
  }

  /** Проекты Jira, доступные пользователю (`jira project list`); держатся на время работы, «Обновить» сбрасывает. */
  async projects(recheck: boolean): Promise<JiraProjectsResult> {
    if (recheck) {
      this.blocked = null;
      this.projectsCache = null;
    }
    if (this.blocked) return { ...this.blocked };
    if (this.projectsCache && Date.now() - this.projectsCache.at < PROJECTS_TTL_MS) return { projects: this.projectsCache.projects };
    const res = await this.run('jira', jiraProjectsArgs());
    const lost = launchFailure(res);
    if (lost) return lost;
    if (res.code !== 0) {
      const text = failureText(res);
      const problem = problemOf(text);
      const refusal = { problem, error: problemText(problem, text) };
      if (problem === 'auth') this.blocked = refusal;
      return refusal;
    }
    const projects = parseProjects(res.stdout);
    this.projectsCache = { at: Date.now(), projects };
    return { projects };
  }

  /** Проекты Jira, чьи ключи стоят в именах веток; без списка проектов подсказок нет. */
  async suggest(branches: readonly string[]): Promise<JiraSuggestion[]> {
    const res = await this.projects(false);
    if (!('projects' in res)) return [];
    return suggestKeys(branches, new Set(res.projects.map((p) => p.key)));
  }

  /** Ключ задачи проекта, пришедшей в последнем списке; иначе null и причина. */
  private known(projectId: string, key: unknown): { project: string } | string {
    if (typeof key !== 'string' || !KEY_RE.test(key)) return 'Некорректный ключ задачи';
    if (!this.seen.get(projectId)?.has(key)) return 'Задачи нет в списке проекта: обновите список';
    // `-p` - проект самой задачи, если он выбран в настройках (задачи одного списка могут быть из разных проектов); иначе без `-p`.
    const prefix = key.slice(0, key.lastIndexOf('-'));
    const chosen = this.projects_().projects.find((p) => p.id === projectId)?.jira?.projects ?? [];
    return { project: chosen.includes(prefix) ? prefix : '' };
  }

  async details(projectId: string, key: unknown): Promise<JiraDetailsResult> {
    const known = this.known(projectId, key);
    if (typeof known === 'string') return { problem: 'error', error: known };
    const res = await this.run('jira', jiraViewArgs(key as string, known.project));
    const lost = launchFailure(res);
    if (lost) return lost;
    if (res.code !== 0) {
      const text = failureText(res);
      if (isMissingIssue(text)) return { problem: 'error', error: 'Задача не найдена в Jira' };
      const problem = problemOf(text);
      if (problem === 'auth') this.blocked = { problem, error: problemText(problem, text) };
      return { problem, error: problemText(problem, text) };
    }
    try {
      const details = parseDetails(res.stdout);
      return details ? { details } : { problem: 'error', error: 'jira issue view: в ответе нет задачи' };
    } catch {
      return { problem: 'error', error: 'jira issue view: ответ не JSON' };
    }
  }

  /** Адрес задачи в браузере, как его печатает `jira open --no-browser`; принимается только http(s). */
  async url(projectId: string, key: unknown): Promise<JiraUrlResult> {
    const known = this.known(projectId, key);
    if (typeof known === 'string') return { error: known };
    const res = await this.run('jira', jiraOpenArgs(key as string, known.project));
    const lost = launchFailure(res);
    if (lost) return { error: lost.error };
    if (res.code !== 0) return { error: failureText(res) };
    const url = /https?:\/\/\S+/.exec(res.stdout)?.[0];
    return url ? { url } : { error: 'jira не назвал адрес задачи' };
  }
}
