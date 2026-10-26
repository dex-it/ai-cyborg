import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { readTrackers, type Project, type ProjectsState, type TrackerSettings } from './projects';

export type { TrackerSettings } from './projects';

export type TrackerKind = 'github' | 'gitlab';

export interface TaskRef {
  kind: TrackerKind;
  host: string;
  path: string;
  number: number;
}

export interface TaskLabel {
  name: string;
  /** '#rrggbb' либо null, если трекер цвета не дал или он неверный. */
  color: string | null;
}

export interface Task extends TaskRef {
  key: string;
  title: string;
  state: 'open' | 'closed';
  workflow: string[];
  labels: TaskLabel[];
  author: string;
  assignees: string[];
  url: string;
  createdAt: string;
  updatedAt: string;
  /** Репозитории проекта, чей remote указывает на трекер задачи. */
  repos: string[];
}

export interface SourceResult {
  kind: TrackerKind;
  host: string;
  path: string;
  error?: string;
  note?: string;
}

export interface TasksResult {
  tasks: Task[];
  sources: SourceResult[];
  tracked: Task[];
  enabled: TrackerSettings;
  error?: string;
  /** Номер выборки для tasks:details; выдаёт главный процесс. */
  selection?: number;
}

export type AuthState =
  | { state: 'logged-in'; user: string }
  | { state: 'logged-out' }
  | { state: 'missing' }
  | { state: 'error'; message: string };

export interface HostAuth {
  host: string;
  auth: AuthState;
}

export interface TrackersStatus {
  github: AuthState;
  gitlab: AuthState | { state: 'hosts'; hosts: HostAuth[] };
}

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  missing: boolean;
  failure?: 'timeout' | 'overflow';
}

export type CliRunner = (cmd: 'gh' | 'glab', args: string[]) => Promise<CliResult>;

export interface TrackerDeps {
  run: CliRunner;
  remotes: (repo: string) => Promise<string[]>;
  projects: () => ProjectsState;
}

/** Предел одного вызова gh/glab (NFR-1003): время ожидания и размер ответа. */
export const CLI_LIMITS = { timeoutMs: 120_000, maxBuffer: 64 * 1024 * 1024 };
export const MAX_TRACKED = 200;
const SEGMENT = /^[A-Za-z0-9._-]+$/;
const HOST = /^[a-z0-9][a-z0-9.-]*$/;
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com', 'ssh.github.com']);

// Только чтение: ни -X, ни полей запроса (они переключают gh и glab на POST).
const GH_FIELDS =
  '{number,title,state,html_url,created_at,updated_at,user:.user.login,assignees:[.assignees[]?.login],labels:[.labels[]? | if type=="object" then {name,color} else {name:.,color:null} end]}';
const GH_JQ = `.[] | select(.pull_request == null) | ${GH_FIELDS}`;
const GH_JQ_ONE = GH_FIELDS;

// ---------- чистые функции ----------

const validSegments = (segments: string[]): boolean => segments.every((s) => SEGMENT.test(s) && s !== '.' && s !== '..');

export function parseRemote(url: string): { host: string; path: string } | null {
  const text = url.trim();
  let host: string;
  let rawPath: string;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(text);
  if (scheme) {
    if (!['http', 'https', 'ssh', 'git'].includes(scheme[1].toLowerCase())) return null;
    host = scheme[2];
    rawPath = scheme[3];
  } else {
    if (text.includes('://')) return null;
    const scp = /^(?:[^@/\s]+@)?([^/:\s]+):(.+)$/.exec(text);
    if (!scp) return null;
    host = scp[1];
    rawPath = scp[2];
  }
  host = host.toLowerCase();
  if (!HOST.test(host)) return null;
  const segments = rawPath
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .split('/');
  if (!validSegments(segments)) return null;
  return { host, path: segments.join('/') };
}

/** Какой трекер стоит за remote; gitlabHosts - хосты, на которые залогинен glab. */
export function classifyRemote(url: string, gitlabHosts: ReadonlySet<string>): { kind: TrackerKind; host: string; path: string } | null {
  const parsed = parseRemote(url);
  if (!parsed) return null;
  const segments = parsed.path.split('/');
  if (GITHUB_HOSTS.has(parsed.host)) return segments.length === 2 ? { kind: 'github', host: 'github.com', path: parsed.path } : null;
  if (gitlabHosts.has(parsed.host)) return segments.length >= 2 ? { kind: 'gitlab', host: parsed.host, path: parsed.path } : null;
  return null;
}

export const taskKey = (ref: TaskRef): string => `${ref.kind}:${ref.host}/${ref.path.toLowerCase()}#${ref.number}`;

export const sourceKey = (ref: Pick<TaskRef, 'kind' | 'host' | 'path'>): string => `${ref.kind}:${ref.host}/${ref.path.toLowerCase()}`;

export const taskUrl = (ref: TaskRef): string =>
  ref.kind === 'github' ? `https://github.com/${ref.path}/issues/${ref.number}` : `https://${ref.host}/${ref.path}/-/issues/${ref.number}`;

/** Цвет метки трекера в '#rrggbb' нижним регистром; не цвет - null. */
export function normalizeColor(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw.trim());
  if (!m) return null;
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return `#${hex.toLowerCase()}`;
}

/** Начальный промпт сессии. Собирается из проверенного TaskRef: название задачи (чужой текст) в него не попадает. */
export function taskPrompt(ref: TaskRef): string {
  const command = ref.kind === 'github' ? 'gh issue edit' : 'glab issue update';
  return `Ознакомься с задачей ${taskUrl(ref)}. Когда приступишь к работе, смени её статус в трекере (${command}), чтобы было видно, что задача в работе.`;
}

/** Значения JSON, записанные подряд: строка на объект у gh --jq, `][` между страницами у glab --paginate. */
export function splitJsonValues(text: string): unknown[] {
  const values: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{' || c === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}' || c === ']') {
      depth--;
      if (depth < 0) throw new Error('лишняя закрывающая скобка');
      if (depth === 0) values.push(JSON.parse(text.slice(start, i + 1)));
    }
  }
  if (depth !== 0 || inString) throw new Error('обрезанный JSON');
  return values;
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

export function firstLine(text: string): string {
  const line = text.replace(ANSI, '').split('\n').map((l) => l.trim()).find((l) => l) ?? '';
  return line.slice(0, 300);
}

/** Текст `glab auth status` (он пишет в stderr и выходит с кодом 0): блок на хост, заголовок - хост в колонке 0. */
export function parseGlabStatus(text: string): HostAuth[] {
  const blocks: { host: string; lines: string[] }[] = [];
  for (const line of text.replace(ANSI, '').split('\n')) {
    if (/^\S+$/.test(line)) blocks.push({ host: line, lines: [] });
    else if (blocks.length && line.trim()) blocks[blocks.length - 1].lines.push(line.trim());
  }
  return blocks.map(({ host, lines }) => {
    for (const line of lines) {
      const login = /Logged in to \S+ as (\S+)/.exec(line);
      if (login) return { host, auth: { state: 'logged-in', user: login[1] } };
    }
    if (lines.some((l) => /\b401\b|No token provided|not authenticated/i.test(l))) return { host, auth: { state: 'logged-out' } };
    const failed = lines.find((l) => /^x /.test(l) && /api call failed/.test(l));
    if (failed) return { host, auth: { state: 'error', message: failed.slice(2, 302) } };
    return { host, auth: { state: 'error', message: 'не удалось разобрать вывод glab auth status' } };
  });
}

export function validateRef(value: unknown): TaskRef | null {
  if (typeof value !== 'object' || value === null) return null;
  const { kind, host, path, number } = value as Record<string, unknown>;
  if (kind !== 'github' && kind !== 'gitlab') return null;
  if (typeof host !== 'string' || host.length > 253 || !HOST.test(host)) return null;
  if (typeof path !== 'string') return null;
  const segments = path.split('/');
  if (!validSegments(segments)) return null;
  if (kind === 'github' && (host !== 'github.com' || segments.length !== 2)) return null;
  if (kind === 'gitlab' && segments.length < 2) return null;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1 || number > 2 ** 31) return null;
  return { kind, host, path, number };
}

/** Аргументы tasks:open: адрес строится из проверенной ссылки, остальные поля игнорируются. */
export const validateOpenArgs = (value: unknown): TaskRef | null => validateRef(value);

export function validateSettings(value: unknown): TrackerSettings | null {
  if (typeof value !== 'object' || value === null) return null;
  const { github, gitlab } = value as Record<string, unknown>;
  return typeof github === 'boolean' && typeof gitlab === 'boolean' ? { github, gitlab } : null;
}

export interface ListArgs {
  projectId: string;
  assignedToMe: boolean;
  tracked: TaskRef[];
  /** «Обновить»: перед выборкой вход проверяется заново. */
  recheck: boolean;
}

export function validateListArgs(projectId: unknown, assignedToMe: unknown, tracked: unknown, recheck: unknown): ListArgs | null {
  if (typeof projectId !== 'string' || typeof assignedToMe !== 'boolean' || typeof recheck !== 'boolean') return null;
  if (!Array.isArray(tracked) || tracked.length > MAX_TRACKED) return null;
  const refs: TaskRef[] = [];
  for (const item of tracked) {
    const ref = validateRef(item);
    if (!ref) return null;
    refs.push(ref);
  }
  return { projectId, assignedToMe, tracked: refs, recheck };
}

/** Сессия с задачей стартует только в репозиториях проектов. */
export function sessionDirsAllowed(state: ProjectsState, cwd: unknown, addDirs: unknown): boolean {
  if (typeof cwd !== 'string' || !Array.isArray(addDirs) || addDirs.some((d) => typeof d !== 'string')) return false;
  const repos = new Set(state.projects.flatMap((p) => p.repos));
  return repos.has(cwd) && addDirs.every((d) => repos.has(d));
}

// ---------- настройки ----------

/** Состояние проектов из канала projects:save: поле источников каждого проекта - два boolean; лишние ключи отбрасываются. */
export function validateProjectsState(value: unknown): ProjectsState | null {
  if (typeof value !== 'object' || value === null) return null;
  const state = value as ProjectsState;
  if (!Array.isArray(state.projects)) return null;
  const projects: Project[] = [];
  for (const p of state.projects) {
    if (typeof p !== 'object' || p === null) return null;
    const trackers = validateSettings((p as Partial<Project>).trackers);
    if (!trackers) return null;
    projects.push({ ...p, trackers });
  }
  return { ...state, projects };
}

/** Источники хотя бы одного проекта различаются; отсутствующий проект - оба выключены. */
export function sourcesChanged(a: ProjectsState, b: ProjectsState): boolean {
  const flags = (s: ProjectsState) => new Map(s.projects.map((p) => [p.id, p.trackers]));
  const [from, to] = [flags(a), flags(b)];
  const off = { github: false, gitlab: false };
  for (const id of new Set([...from.keys(), ...to.keys()])) {
    const x = from.get(id) ?? off;
    const y = to.get(id) ?? off;
    if (x.github !== y.github || x.gitlab !== y.gitlab) return true;
  }
  return false;
}

/** Сохранение проектов: включённые источники другие - вход проверяется заново; прочие сохранения кэш входа не трогают. */
export function saveProjectsState(
  raw: unknown,
  store: { load(): ProjectsState; save(s: ProjectsState): void },
  trackers: { resetAuth(): void },
): void {
  const valid = validateProjectsState(raw);
  if (!valid) throw new Error('Некорректные источники задач проекта');
  const prev = store.load();
  store.save(valid);
  if (sourcesChanged(prev, valid)) trackers.resetAuth();
}

/** Прежний общий trackers.json: только чтение, значения подставляются проектам без поля источников. */
export class TrackerSettingsStore {
  constructor(private readonly file: string) {}

  load(): TrackerSettings {
    try {
      return readTrackers(JSON.parse(fs.readFileSync(this.file, 'utf8'))) ?? { github: false, gitlab: false };
    } catch {
      return { github: false, gitlab: false };
    }
  }
}

// ---------- запуск gh и glab ----------

/** gh и glab берут токен из своей конфигурации; Cyborg его не читает и не передаёт. cwd вне репозиториев: glab не выводит хост из текущего. */
export function createCliRunner(cwd: string, limits = CLI_LIMITS): CliRunner {
  const env = { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' };
  return (cmd, args) =>
    new Promise((resolve) => {
      execFile(cmd, args, { cwd, env, timeout: limits.timeoutMs, maxBuffer: limits.maxBuffer }, (error, stdout, stderr) => {
        if (!error) return resolve({ code: 0, stdout, stderr, missing: false });
        const e = error as NodeJS.ErrnoException & { killed?: boolean };
        resolve({
          code: typeof e.code === 'number' ? e.code : null,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          missing: e.code === 'ENOENT',
          failure: e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'overflow' : e.killed ? 'timeout' : undefined,
        });
      });
    });
}

// ---------- сервис ----------

export interface Source {
  kind: TrackerKind;
  host: string;
  path: string;
  repos: string[];
}

export type Fetched = { values: unknown[] } | { error?: string; note?: string };

const cliName = (kind: TrackerKind): 'gh' | 'glab' => (kind === 'github' ? 'gh' : 'glab');

/** goneNote: пометка для HTTP 410; null - 410 такой же отказ, как прочие. */
export function interpret(kind: TrackerKind, res: CliResult, goneNote: string | null = 'задачи в репозитории отключены'): Fetched {
  const cli = cliName(kind);
  if (res.missing) return { error: `${cli} не установлен` };
  if (res.failure === 'timeout') return { error: 'трекер не ответил за 120 с' };
  if (res.failure === 'overflow') return { error: 'ответ больше 64 МБ' };
  if (kind === 'github' && res.code === 4) return { error: 'gh не залогинен' };
  // glab api выходит с кодом 0 и при HTTP-ошибке: отказ виден по stderr.
  const http = /HTTP (\d{3})/.exec(res.stderr);
  const httpStatus = http ? Number(http[1]) : 0;
  if (httpStatus === 410 && goneNote !== null) return { note: goneNote };
  if (res.code !== 0 || httpStatus >= 400) return { error: firstLine(res.stderr) || `${cli} завершился с кодом ${res.code}` };
  let parsed: unknown[];
  try {
    parsed = splitJsonValues(res.stdout);
  } catch {
    return { error: 'ответ трекера не разобран' };
  }
  const first = parsed[0];
  if (kind === 'gitlab' && typeof first === 'object' && first !== null && !Array.isArray(first)) {
    const { message, iid } = first as { message?: unknown; iid?: unknown };
    if (message !== undefined && iid === undefined) return { error: firstLine(String(message)) };
  }
  return { values: parsed.flat() };
}

/** Метка - строка либо объект с name и color; повтор имени и прочее отбрасываются. */
function parseLabels(raw: unknown): TaskLabel[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: TaskLabel[] = [];
  for (const item of raw) {
    let label: TaskLabel | null = null;
    if (typeof item === 'string') label = { name: item, color: null };
    else if (typeof item === 'object' && item !== null && typeof (item as { name?: unknown }).name === 'string') {
      label = { name: (item as { name: string }).name, color: normalizeColor((item as { color?: unknown }).color) };
    }
    if (!label || !label.name || seen.has(label.name)) continue;
    seen.add(label.name);
    out.push(label);
  }
  return out;
}

function toTask(source: Source, raw: unknown): Task | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const number = source.kind === 'github' ? r.number : r.iid;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) return null;
  const ref: TaskRef = { kind: source.kind, host: source.host, path: source.path, number };
  const labels = parseLabels(r.labels);
  const login = (v: unknown): string => {
    if (typeof v === 'string') return v;
    const name = typeof v === 'object' && v !== null ? (v as { username?: unknown }).username : undefined;
    return typeof name === 'string' ? name : '';
  };
  return {
    ...ref,
    key: taskKey(ref),
    title: typeof r.title === 'string' ? r.title : '',
    state: typeof r.state === 'string' && r.state.startsWith('open') ? 'open' : 'closed',
    workflow: source.kind === 'gitlab' ? labels.map((l) => l.name).filter((l) => l.startsWith('workflow::')) : [],
    labels,
    author: login(r.user ?? r.author),
    assignees: Array.isArray(r.assignees) ? r.assignees.map(login).filter((a) => a) : [],
    url: taskUrl(ref),
    createdAt: typeof r.created_at === 'string' ? r.created_at : '',
    updatedAt: typeof r.updated_at === 'string' ? r.updated_at : '',
    repos: source.repos,
  };
}

export const enc = encodeURIComponent;

function hostDownReason(host: string, auth: AuthState): string {
  if (auth.state === 'logged-out') return `вход в ${host} не выполнен: glab auth login --hostname ${host}`;
  if (auth.state === 'error') return `проверка входа в ${host} не удалась: ${auth.message}`;
  return `вход в ${host} не подтверждён`;
}

export interface ResolvedSources {
  project: Project | undefined;
  enabled: TrackerSettings;
  sources: Map<string, Source>;
  blocked: Map<string, SourceResult>;
  /** Отказы, не привязанные к репозиторию (glab не установлен или не залогинен). */
  preErrors: SourceResult[];
  gitlabUsers: Map<string, string>;
  /** Логин gh; проверка входа общая с кэшем сервиса. */
  loginOf: () => Promise<string | { error: string }>;
  /**
   * Выборка шла по прежнему результату проверки входа: после новой проверки отдаёт источники, перестроенные
   * по ней, если хосты с входом, пользователи или состояние gh изменились, иначе null.
   */
  revise: () => Promise<ResolvedSources | null>;
}

/** Кэш проверки входа: промис в полёте общий, сброс отсекает его результат от кэша, прежний результат переживает сброс. */
class AuthCache<T> {
  private p?: Promise<T>;
  private done = false;
  private last?: T;

  constructor(private readonly check: () => Promise<T>) {}

  reset(): void {
    this.p = undefined;
    this.done = false;
  }

  /** `prior` - результат прежней проверки, пока текущая не завершилась; без него выборка ждёт `current`. */
  get(): { current: Promise<T>; prior?: T } {
    if (!this.p) {
      const p: Promise<T> = this.check().then((v) => {
        if (this.p === p) {
          this.last = v;
          this.done = true;
        }
        return v;
      });
      this.p = p;
    }
    return { current: this.p, prior: this.done ? undefined : this.last };
  }
}

/** Что в результате проверки входа меняет выборку: хосты с входом и их пользователи, состояние остальных; текст ошибки не в счёт. */
const authKey = (a: AuthState | { hosts: HostAuth[] }): string =>
  'hosts' in a
    ? JSON.stringify(a.hosts.map((h) => [h.host, h.auth.state, h.auth.state === 'logged-in' ? h.auth.user : '']))
    : JSON.stringify([a.state, a.state === 'logged-in' ? a.user : '']);

const sameAuth = (a: AuthState | { hosts: HostAuth[] }, b: AuthState | { hosts: HostAuth[] } | undefined): boolean => b !== undefined && authKey(a) === authKey(b);

export class TrackersService {
  private readonly gitlabCache = new AuthCache(() => this.gitlabAuth());
  private readonly githubCache = new AuthCache(() => this.githubAuth());

  constructor(private readonly deps: TrackerDeps) {}

  /** Следующая выборка проверит вход заново; проверка, начатая до сброса, в кэш не попадает. */
  resetAuth(): void {
    this.gitlabCache.reset();
    this.githubCache.reset();
  }

  /** Проверка входа при старте приложения: один раз, результат ложится в кэш выборок (без опроса по таймеру). */
  warmAuth(): Promise<void> {
    const all = this.deps.projects().projects;
    const enabled = { github: all.some((p) => p.trackers.github), gitlab: all.some((p) => p.trackers.gitlab) };
    const pending: Promise<unknown>[] = [];
    if (enabled.gitlab) pending.push(this.gitlabCache.get().current);
    if (enabled.github) pending.push(this.githubCache.get().current);
    return Promise.all(pending).then(() => undefined);
  }

  async status(): Promise<TrackersStatus> {
    const [github, gitlab] = await Promise.all([this.githubAuth(), this.gitlabAuth()]);
    return { github, gitlab: 'state' in gitlab ? gitlab : { state: 'hosts', hosts: gitlab.hosts } };
  }

  private async githubAuth(): Promise<AuthState> {
    const res = await this.deps.run('gh', ['api', '--hostname', 'github.com', 'user', '--jq', '.login']);
    if (res.missing) return { state: 'missing' };
    if (res.failure === 'timeout') return { state: 'error', message: 'трекер не ответил за 120 с' };
    if (res.code === 0) return { state: 'logged-in', user: res.stdout.trim() };
    if (res.code === 4) return { state: 'logged-out' };
    return { state: 'error', message: firstLine(res.stderr) || `gh завершился с кодом ${res.code}` };
  }

  private async gitlabAuth(): Promise<AuthState | { hosts: HostAuth[] }> {
    const res = await this.deps.run('glab', ['auth', 'status']);
    if (res.missing) return { state: 'missing' };
    if (res.failure === 'timeout') return { state: 'error', message: 'glab не ответил за 120 с' };
    const hosts = parseGlabStatus(`${res.stdout}\n${res.stderr}`);
    return hosts.length ? { hosts } : { state: 'logged-out' };
  }

  /** Источники проекта: remote его репозиториев, признанные трекерами; общий разбор для задач и MR. */
  async resolveSources(projectId: string, recheck = false): Promise<ResolvedSources> {
    if (recheck) this.resetAuth();
    const project = this.deps.projects().projects.find((p) => p.id === projectId);
    const enabled = project?.trackers ?? { github: false, gitlab: false };
    const resolved: ResolvedSources = {
      project,
      enabled,
      sources: new Map(),
      blocked: new Map(),
      preErrors: [],
      gitlabUsers: new Map(),
      loginOf: () => Promise.resolve({ error: 'gh не залогинен' }),
      revise: () => Promise.resolve(null),
    };
    if (!project || (!enabled.github && !enabled.gitlab)) return resolved;

    const { gitlabUsers, sources, blocked } = resolved;
    // Хосты glab, на которых вход не подтверждён: remote такого хоста - источник с причиной, а не отсутствие remote.
    const gitlabDown = new Map<string, string>();
    const gl = enabled.gitlab ? this.gitlabCache.get() : null;
    // Вход и remote читаются параллельно: они не зависят друг от друга. После сброса кэша идём по прежнему результату входа.
    const [status, remotes] = await Promise.all([
      gl ? Promise.resolve(gl.prior ?? gl.current) : Promise.resolve(null),
      Promise.all(project.repos.map(async (repo) => ({ repo, urls: await this.deps.remotes(repo) }))),
    ]);
    if (status) {
      if ('hosts' in status) {
        for (const { host, auth } of status.hosts) {
          if (auth.state === 'logged-in') gitlabUsers.set(host, auth.user);
          else gitlabDown.set(host, hostDownReason(host, auth));
        }
      } else {
        resolved.preErrors.push({ kind: 'gitlab', host: '', path: '', error: status.state === 'missing' ? 'glab не установлен' : 'вход glab не выполнен' });
      }
    }

    const knownHosts = new Set([...gitlabUsers.keys(), ...gitlabDown.keys()]);
    for (const { repo, urls } of remotes) {
      for (const url of urls) {
        const found = classifyRemote(url, knownHosts);
        if (!found || !enabled[found.kind]) continue;
        const key = sourceKey(found);
        if (found.kind === 'gitlab' && !gitlabUsers.has(found.host)) {
          blocked.set(key, { kind: found.kind, host: found.host, path: found.path, error: gitlabDown.get(found.host) });
          continue;
        }
        const source = sources.get(key) ?? { ...found, repos: [] };
        if (!source.repos.includes(repo)) source.repos.push(repo);
        sources.set(key, source);
      }
    }

    let gh: { current: Promise<AuthState>; prior?: AuthState } | undefined;
    resolved.loginOf = () => {
      gh ??= this.githubCache.get();
      return Promise.resolve(gh.prior ?? gh.current).then((a) =>
        a.state === 'logged-in' ? a.user : { error: a.state === 'logged-out' ? 'gh не залогинен' : a.state === 'missing' ? 'gh не установлен' : a.state === 'error' ? a.message : '' },
      );
    };
    resolved.revise = async () => {
      const [glNext, ghNext] = await Promise.all([gl?.prior !== undefined ? gl.current : undefined, gh?.prior !== undefined ? gh.current : undefined]);
      const changed = (gl?.prior !== undefined && !sameAuth(gl.prior, glNext)) || (gh?.prior !== undefined && !sameAuth(gh.prior, ghNext));
      return changed ? this.resolveSources(projectId) : null;
    };
    return resolved;
  }

  /** Выборка по источникам; шла по прежнему результату входа и новая проверка его изменила - выполняется заново по ней. */
  async fetchRevised<T>(projectId: string, recheck: boolean, run: (r: ResolvedSources) => Promise<T>, discard?: (out: T) => void): Promise<T> {
    const first = await this.resolveSources(projectId, recheck);
    const out = await run(first);
    const next = await first.revise();
    if (!next) return out;
    discard?.(out);
    return run(next);
  }

  async list(projectId: string, assignedToMe: boolean, tracked: TaskRef[], recheck = false): Promise<TasksResult> {
    return this.fetchRevised(projectId, recheck, (r) => this.listFrom(r, assignedToMe, tracked));
  }

  private async listFrom(resolved: ResolvedSources, assignedToMe: boolean, tracked: TaskRef[]): Promise<TasksResult> {
    const { project, enabled, sources, blocked, preErrors, gitlabUsers, loginOf } = resolved;
    const result: TasksResult = { tasks: [], sources: [...preErrors], tracked: [], enabled };
    if (!project) return { ...result, error: 'Проект не найден' };
    if (!enabled.github && !enabled.gitlab) return result;

    const fetched = await Promise.all(
      [...sources.values()].map(async (source) => {
        try {
          let assignee: string | undefined;
          if (assignedToMe) {
            if (source.kind === 'github') {
              const login = await loginOf();
              if (typeof login !== 'string') return { source, out: { error: login.error } as Fetched };
              assignee = login;
            } else assignee = gitlabUsers.get(source.host);
          }
          return { source, out: await this.fetchList(source, assignee) };
        } catch (error) {
          return { source, out: { error: firstLine((error as Error).message) } as Fetched };
        }
      }),
    );

    const failed = new Set<string>();
    for (const { source, out } of fetched) {
      const info: SourceResult = { kind: source.kind, host: source.host, path: source.path };
      if ('values' in out) {
        for (const raw of out.values) {
          const task = toTask(source, raw);
          if (task) result.tasks.push(task);
        }
      } else {
        if (out.error) {
          info.error = out.error;
          failed.add(sourceKey(source));
        }
        if (out.note) info.note = out.note;
      }
      result.sources.push(info);
    }

    result.sources.push(...blocked.values());

    const have = new Set(result.tasks.map((t) => t.key));
    const wanted = new Map<string, TaskRef>();
    for (const ref of tracked.slice(0, MAX_TRACKED)) {
      const key = taskKey(ref);
      const sk = sourceKey(ref);
      if (have.has(key) || wanted.has(key) || !sources.has(sk) || failed.has(sk)) continue;
      wanted.set(key, ref);
    }
    const singles = await Promise.all(
      [...wanted.values()].map(async (ref) => {
        try {
          const source = sources.get(sourceKey(ref))!;
          const out = await this.fetchOne(source, ref.number);
          return 'values' in out ? toTask(source, out.values[0]) : null;
        } catch {
          return null;
        }
      }),
    );
    result.tracked = singles.filter((t): t is Task => t !== null);
    return result;
  }

  private async fetchList(source: Source, assignee: string | undefined): Promise<Fetched> {
    if (source.kind === 'github') {
      const query = `state=open&per_page=100${assignee ? `&assignee=${enc(assignee)}` : ''}`;
      const res = await this.deps.run('gh', ['api', '--hostname', 'github.com', '--paginate', '--jq', GH_JQ, `repos/${source.path}/issues?${query}`]);
      return interpret('github', res);
    }
    const query = `state=opened&per_page=100&with_labels_details=true${assignee ? `&assignee_username=${enc(assignee)}` : ''}`;
    const res = await this.deps.run('glab', ['api', '--hostname', source.host, '--paginate', `projects/${enc(source.path)}/issues?${query}`]);
    return interpret('gitlab', res);
  }

  private async fetchOne(source: Source, number: number): Promise<Fetched> {
    if (source.kind === 'github') {
      const res = await this.deps.run('gh', ['api', '--hostname', 'github.com', '--jq', GH_JQ_ONE, `repos/${source.path}/issues/${number}`]);
      return interpret('github', res);
    }
    const res = await this.deps.run('glab', ['api', '--hostname', source.host, `projects/${enc(source.path)}/issues/${number}`]);
    return interpret('gitlab', res);
  }
}
