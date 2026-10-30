/** Общее для окна «Расширения» и главного процесса: что читается из Claude Code и в каком виде уходит в интерфейс. */

/**
 * Область, где записано расширение. user - для пользователя во всех проектах и воркспейсах; project - в репозитории
 * (коммитится); local - в репозитории лично для пользователя; managed - организация; session - только на время сессии;
 * synced - синхронизировано с claude.ai.
 */
export type Scope = 'user' | 'project' | 'local' | 'managed' | 'session' | 'synced';

export type ComponentKind = 'skill' | 'command' | 'agent';

/** Скилл, команда или агент: имя без пространства плагина, описание из frontmatter. */
export interface Component {
  kind: ComponentKind;
  name: string;
  description: string;
}

export interface MarketplacePlugin {
  name: string;
  description: string;
  version?: string;
  category?: string;
  /** Исходники плагина не лежат в клоне магазина (url, git-subdir): состав известен только после установки. */
  remote: boolean;
  /** null - состав не прочитан (удалённый плагин либо путь вне клона). */
  components: Component[] | null;
}

export interface Marketplace {
  name: string;
  /** Откуда подключён: `github anthropics/repo`, `directory /путь`, `git https://хост`. Без учётных данных. */
  source: string;
  updated?: string;
  /** Подключён (есть в списке Claude Code); false - магазин лишь назван в настройках репозитория. */
  known: boolean;
  /** Репозитории, чьи настройки (`extraKnownMarketplaces`) называют этот магазин. */
  declaredBy: string[];
  plugins: MarketplacePlugin[];
  /** Магазин не прочитан (нет клона, повреждён marketplace.json). */
  problem?: string;
  /** В магазине больше плагинов, чем читается. */
  truncated?: boolean;
}

export interface InstalledPlugin {
  /** `имя@магазин`. */
  id: string;
  name: string;
  marketplace: string;
  version: string;
  scope: Scope;
  /** Репозиторий установки (project и local). */
  dir?: string;
  /** Включён, если смотреть вне проекта: по настройкам пользователя. */
  enabledGlobal: boolean;
  /** Включён ли из каталога каждого репозитория (project и local переопределяют user). */
  enabledIn: Record<string, boolean>;
  components: Component[];
  /** Имена MCP-серверов плагина. */
  mcp: string[];
  errors: string[];
}

/** Скилл, команда или агент, лежащий не в плагине: ~/.claude либо .claude репозитория. */
export interface StandaloneComponent extends Component {
  scope: Scope;
  dir?: string;
}

export type McpTransport = 'stdio' | 'http' | 'sse' | 'ws' | 'other';
export type McpApproval = 'approved' | 'pending' | 'disabled';

export interface McpServer {
  name: string;
  /** plugin - сервер плагина, область берётся у плагина; claudeai - коннектор claude.ai (появляется только после проверки связи). */
  scope: Scope | 'plugin' | 'claudeai';
  dir?: string;
  /** Плагин-владелец (id). */
  plugin?: string;
  transport: McpTransport;
  /** stdio - имя программы без аргументов; http, sse - схема и хост без пути, запроса и учётных данных. */
  target: string;
  /** Только у серверов из .mcp.json репозитория: одобрил ли их пользователь. */
  approval?: McpApproval;
}

export interface ClaudeInfo {
  version?: string;
  /** Почему список плагинов не получен: нет claude, не разобран вывод. */
  problem?: string;
}

export interface ExtensionsReply {
  claude: ClaudeInfo;
  marketplaces: Marketplace[];
  plugins: InstalledPlugin[];
  standalone: StandaloneComponent[];
  mcp: McpServer[];
  /** Что не удалось прочитать, по строке на причину. */
  problems: string[];
}

export interface ExtensionsRequest {
  /** Каталоги, чьи расширения читаются: репозитории проекта и рабочий каталог сессии. */
  dirs: string[];
}

export type McpHealth = 'connected' | 'needs-auth' | 'failed' | 'pending' | 'unknown';

export interface ProbeEntry {
  name: string;
  health: McpHealth;
  /** Причина отказа одной строкой. */
  detail?: string;
}

export interface ProbeReply {
  entries: ProbeEntry[];
  error?: string;
}

/** Пределы чтения: большой магазин и скиллы не должны раздуть ответ и задержать окно. */
export const MAX_DIRS = 32;
export const MAX_MARKETPLACE_PLUGINS = 2000;
export const MAX_COMPONENTS_PER_PLUGIN = 200;
export const MAX_NAME_LENGTH = 120;
export const MAX_DESCRIPTION_LENGTH = 400;

// ---------- действия: установка, удаление, подключение магазинов ----------

/** Куда пишет Claude Code: user - для пользователя во всех проектах, project - в `.claude/settings.json` репозитория (коммитится), local - в личные настройки репозитория. */
export type ActionScope = 'user' | 'project' | 'local';
export const ACTION_SCOPES: readonly ActionScope[] = ['user', 'project', 'local'];

export type ExtensionsAction =
  | { kind: 'install' | 'uninstall'; plugin: string; scope: ActionScope; dir?: string }
  | { kind: 'marketplace-add'; source: string; scope: ActionScope; dir?: string }
  | { kind: 'marketplace-remove'; name: string };

export interface ActionReply {
  ok: boolean;
  /** Ответ Claude Code одной-тремя строками либо причина отказа. */
  message: string;
}

/** `имя@магазин`: буквы, цифры, `.`, `_`, `-`; первым знаком не `-`, чтобы значение не стало флагом claude. */
export const PLUGIN_ID = /^[A-Za-z0-9][\w.-]{0,99}@[A-Za-z0-9][\w.-]{0,99}$/;
export const MARKETPLACE_NAME = /^[A-Za-z0-9][\w.-]{0,99}$/;
export const MAX_SOURCE_LENGTH = 500;

/**
 * Адрес магазина для `claude plugin marketplace add`: `владелец/репозиторий` GitHub, https-адрес без учётных данных,
 * `git@хост:путь` либо абсолютный путь на этом компьютере. Иное - причина отказа.
 */
export function marketplaceSourceProblem(source: string): string | null {
  const value = source.trim();
  if (!value) return 'Укажите адрес магазина';
  if (value.length > MAX_SOURCE_LENGTH) return `Адрес длиннее ${MAX_SOURCE_LENGTH} знаков`;
  if (/[\u0000-\u001f\u007f]/.test(value)) return 'В адресе управляющие символы';
  if (value.startsWith('-')) return 'Адрес не может начинаться со знака «-»';
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) return null;
  if (/^git@[\w.-]+:[\w./-]+$/.test(value)) return null;
  if (value.startsWith('/')) return value.split('/').includes('..') ? 'В пути нельзя «..»' : null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return 'Поддержан только https-адрес';
    if (url.username || url.password) return 'В адресе не должно быть логина и пароля';
    return null;
  } catch {
    return 'Нужен владелец/репозиторий, https-адрес, git@хост:путь или абсолютный путь';
  }
}

// ---------- хабы: каталоги магазинов ----------

/** Хаб - список магазинов, в котором ищут и откуда подключают. builtin: встроенный, удалить нельзя, отключить можно. */
export interface Hub {
  id: string;
  name: string;
  /** https-адрес файла хаба; у встроенного null. */
  url: string | null;
  enabled: boolean;
  builtin: boolean;
}

export interface HubEntry {
  name: string;
  description: string;
  /** Что передать `plugin marketplace add`. */
  source: string;
  /** Откуда магазин, для подписи: `github владелец/репозиторий`. */
  label: string;
}

export interface HubContent {
  entries: HubEntry[];
  /** Записей файла, отброшенных как негодные (чужой тип источника, неверный адрес). */
  skipped?: number;
  /** Хаб не получен либо не разобран. */
  error?: string;
}

export type HubOp = { op: 'add'; name: string; url: string } | { op: 'remove' | 'enable' | 'disable'; id: string };

export const MAX_HUB_ENTRIES = 500;
export const MAX_HUB_BYTES = 1024 * 1024;
export const MAX_HUBS = 20;
