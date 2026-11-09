/** Версия протокола канала Cyborg - демон: меняется при несовместимой правке сообщений (ADR-0020 п.3). */
export const PROTO = 1;

/** Кольцо вывода сессии, которое демон держит для отсутствующего клиента. */
export const RING_BYTES = 1024 * 1024;

/** Хвост событий, который берёт подхваченная при запуске сессия. */
export const EVENTS_TAIL_BYTES = 1024 * 1024;

export const MAX_FILE_BYTES = 5 * 1024 * 1024;

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

export interface SpawnMsg {
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
