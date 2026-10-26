// Jira через jira-cli (ADR-0013): список моих задач, детали, адрес для браузера и проверка входа. Только чтение (FR-11010):
// `jira version`, `jira me`, `jira issue list`, `jira issue view`, `jira open --no-browser`. Конфиг и токен jira-cli Cyborg не читает.
import {
  failureText,
  isEmptyResult,
  isMissingIssue,
  jiraListArgs,
  jiraOpenArgs,
  jiraProgressArgs,
  jiraViewArgs,
  JIRA_LIMIT,
  KEY_RE,
  parseDetails,
  parseIssues,
  parseKeys,
  problemOf,
  problemText,
  type JiraDetailsResult,
  type JiraListResult,
  type JiraProblem,
  type JiraStatus,
  type JiraUrlResult,
} from './jira';
import type { ProjectsState } from './projects';
import type { CliResult, JiraRunner } from './trackers';

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

  constructor(
    private readonly run: JiraRunner,
    private readonly projects: () => ProjectsState,
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
    const settings = this.projects().projects.find((p) => p.id === projectId)?.jira;
    if (!settings?.enabled) return { issues: [], truncated: false, problem: 'error', error: 'Jira выключена в свойствах проекта' };
    if (recheck) this.blocked = null;
    if (this.blocked) return { issues: [], truncated: false, ...this.blocked };
    // Категории статуса в списке нет: ключи «в работе» берутся вторым запросом, его отказ только оставляет категории пустыми.
    const [res, progress] = await Promise.all([this.run('jira', jiraListArgs(settings.project)), this.run('jira', jiraProgressArgs(settings.project))]);
    const lost = launchFailure(res);
    if (lost) return { issues: [], truncated: false, ...lost };
    if (res.code !== 0) {
      const text = failureText(res);
      if (isEmptyResult(text)) return this.listed(projectId, []);
      const problem = problemOf(text);
      const refusal = { problem, error: problemText(problem, text) };
      if (problem === 'auth') this.blocked = refusal;
      return { issues: [], truncated: false, ...refusal };
    }
    try {
      const inProgress = progress.code === 0 ? parseKeys(progress.stdout) : new Set<string>();
      return this.listed(
        projectId,
        parseIssues(res.stdout).map((issue) => (inProgress.has(issue.key) ? { ...issue, category: 'indeterminate' as const } : issue)),
      );
    } catch {
      return { issues: [], truncated: false, problem: 'error', error: 'jira issue list: ответ не JSON' };
    }
  }

  private listed(projectId: string, issues: ReturnType<typeof parseIssues>): JiraListResult {
    this.seen.set(projectId, new Set(issues.map((issue) => issue.key)));
    return { issues, truncated: issues.length >= JIRA_LIMIT };
  }

  /** Ключ задачи проекта, пришедшей в последнем списке; иначе null и причина. */
  private known(projectId: string, key: unknown): { project: string } | string {
    if (typeof key !== 'string' || !KEY_RE.test(key)) return 'Некорректный ключ задачи';
    if (!this.seen.get(projectId)?.has(key)) return 'Задачи нет в списке проекта: обновите список';
    return { project: this.projects().projects.find((p) => p.id === projectId)?.jira?.project ?? '' };
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
