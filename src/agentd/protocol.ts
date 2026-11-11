/** Версия протокола канала Cyborg - демон: меняется при несовместимой правке сообщений (ADR-0020 п.3). */
export const PROTO = 2;

/** Кольцо вывода сессии, которое демон держит для отсутствующего клиента. */
export const RING_BYTES = 1024 * 1024;

/** Хвост событий, который берёт подхваченная при запуске сессия. */
export const EVENTS_TAIL_BYTES = 1024 * 1024;

export const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Простой в waiting без хуков и ввода, после которого сессия засыпает (останавливается с разговором и клонами). */
export const SLEEP_IDLE_MS = 2 * 3_600_000;

export const DEFAULT_LIMITS = { maxPerHost: 4, taskMs: 4 * 3600_000, idleMs: 30 * 60_000 };

export interface LimitsMsg {
  maxPerHost: number;
  taskMs: number;
  idleMs: number;
}

export interface RepoSpec {
  /** Путь локального репозитория: Cyborg по нему узнаёт проект сессии. */
  local: string;
  url: string;
  name: string;
}

/** Доступ к git-хостингу из gh или glab оператора. */
export interface GitCred {
  kind: 'github' | 'gitlab';
  host: string;
  token: string;
}

/** Доступы агента: только в памяти демона и в окружении процессов сессии, в meta.json не пишутся. */
export interface Auth {
  git: GitCred[];
  /** Хост origin рабочего репозитория: его токен glab получает первым. */
  primary?: string;
  /** Токен claude setup-token: вход агента без claude auth login на хосте. */
  claude?: string;
}

/** Файл настройки Claude: путь относительно ~/.claude (у памяти - относительно её каталога). */
export interface MirrorFile {
  rel: string;
  mode: number;
  b64: string;
}

/** Сервер MCP пользователя: только в памяти демона и в mcp.json сессии 0600 - в env у него бывают токены. */
export type McpServer = Record<string, unknown>;

export interface MarketplaceSpec {
  name: string;
  /** Источник в форме claude plugin marketplace add. */
  source: string;
}

/** Зеркало настройки Claude оператора: хэш без секретов, файлы ~/.claude и плагины. */
export interface ConfigMsg {
  hash: string;
  files: MirrorFile[];
  marketplaces: MarketplaceSpec[];
  plugins: string[];
  auth?: Auth;
}

/** Окружение агента вне файлов хоста: env из settings.json и серверы MCP пользователя. */
export interface AgentExtra {
  env?: Record<string, string>;
  mcp?: Record<string, McpServer>;
}

export interface SpawnMsg extends AgentExtra {
  sid: string;
  token: string;
  repos: RepoSpec[];
  /** Индекс рабочего репозитория в repos. */
  selected: number;
  branch: string;
  prompt?: string;
  origin: 'tool' | 'human';
  keep: boolean;
  spawnedBy?: number;
  limits: LimitsMsg;
  cols: number;
  rows: number;
  auth?: Auth;
  /** Память проекта выбранного репозитория: пишется на хост один раз, обратно не возвращается. */
  memory?: MirrorFile[];
}

export interface SessionMeta {
  sid: string;
  /** Локальные репозитории проекта, выбранный первым. */
  dirs: string[];
  origin: 'tool' | 'human';
  keep: boolean;
  spawnedBy?: number;
  branch: string;
  clones: { name: string; path: string }[];
  /** Клон выбранного репозитория: стартовый cwd. */
  cwd: string;
  port: number;
  startedAt: number;
  reported: boolean;
  limits: LimitsMsg;
  ended?: Ended;
  /** live - процесс идёт или ждёт доставки итога; asleep - остановлен, будится wake; done - завершена, на диске лишь оставленные клоны. */
  state: 'live' | 'asleep' | 'done';
  /** Круг работы: начинается запуском, пробуждением и сообщением после итога; report_done - один на круг. */
  round: number;
  roundStartedAt: number;
  /** Последнее событие хука или ввод. */
  lastActive: number;
  /** Группа процессов запуска: после падения демона её остатки снимаются. */
  pgid?: number;
  /** claude запускался: незапущенная (оборванная на клоне) сессия при старте демона убирается. */
  launched: boolean;
  /** Начатая уборка: после падения демона доделывается; reason - закрытие по лимиту, его итог доставляется вызвавшему. */
  closing?: { keep: boolean; reason?: string };
}

export interface Ended {
  status: 'failed';
  reason: string;
  cleanup: CleanupResult;
}

export interface CleanupResult {
  removed: string[];
  kept: { path: string; reason: string }[];
}

export type Msg = { type: string; rid?: number } & Record<string, unknown>;

/** Строка в одинарных кавычках для sh: одинарная кавычка внутри закрывает и открывает кавычки заново. */
export function shQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}
