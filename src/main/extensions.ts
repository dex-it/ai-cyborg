/**
 * Сводка магазинов, плагинов, скиллов и MCP для окна «Расширения» (фича 14). Список плагинов и магазинов даёт сам Claude Code
 * (`claude plugin list --json`, `claude plugin marketplace list --json`), состав - файлы плагинов, MCP - файлы настроек.
 * Ничего не пишется, серверы MCP не запускаются: связь проверяет только probeMcp по просьбе человека (ADR-0018).
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  MAX_NAME_LENGTH,
  type ClaudeInfo,
  type Component,
  type ExtensionsReply,
  type InstalledPlugin,
  type Marketplace,
  type McpHealth,
  type McpServer,
  type ProbeEntry,
  type ProbeReply,
  type Scope,
  type StandaloneComponent,
} from '../shared/extensions';
import {
  approvalOf,
  describeSource,
  mapLimit,
  mcpServersOf,
  readCatalog,
  readClaudeJson,
  readComponents,
  readJson,
  readSettings,
  readSyncedSkills,
  type ClaudeJson,
  type SettingsFile,
} from './extensions-read';

export interface ClaudeResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** claude не найден в PATH пользователя. */
  missing: boolean;
  timedOut: boolean;
}

/** Запуск `claude <args>` в каталоге cwd. */
export type ClaudeRunner = (args: string[], cwd: string, timeoutMs: number) => Promise<ClaudeResult>;

export interface ExtensionsEnv {
  run: ClaudeRunner;
  home: string;
  /** Конфигурация Claude Code пользователя; по умолчанию ~/.claude, переопределяется CLAUDE_CONFIG_DIR. */
  configDir: string;
  /** Файл ~/.claude.json (серверы MCP пользователя и проектов). */
  claudeJson: string;
  /** Каталог вне репозиториев: из него `claude` видит только настройки пользователя. */
  neutralDir: string;
  /** Каталог организации с managed-mcp.json; null - платформа без него. */
  managedDir: string | null;
}

const LIST_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 90_000;
const PLUGIN_LIST_PARALLEL = 4;

/** Пути Claude Code на этой машине: CLAUDE_CONFIG_DIR меняет и каталог, и место ~/.claude.json. */
export function claudePaths(home: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Pick<ExtensionsEnv, 'configDir' | 'claudeJson' | 'managedDir'> {
  const custom = env.CLAUDE_CONFIG_DIR;
  return {
    configDir: custom || path.join(home, '.claude'),
    claudeJson: custom ? path.join(custom, '.claude.json') : path.join(home, '.claude.json'),
    managedDir: platform === 'darwin' ? '/Library/Application Support/ClaudeCode' : platform === 'linux' ? '/etc/claude-code' : null,
  };
}

/** Запуск claude через login-шелл, как у сессий: из меню приложений Electron стартует без ~/.local/bin в PATH. */
export function createClaudeRunner(): ClaudeRunner {
  return (args, cwd, timeoutMs) =>
    new Promise((resolve) => {
      const shell = process.env.SHELL || '/bin/bash';
      execFile(
        shell,
        ['-lc', 'exec claude "$@"', 'cyborg', ...args],
        { cwd, env: { ...process.env, NO_COLOR: '1' }, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (!error) return resolve({ code: 0, stdout, stderr, missing: false, timedOut: false });
          const e = error as NodeJS.ErrnoException & { killed?: boolean };
          resolve({
            code: typeof e.code === 'number' ? e.code : null,
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            missing: e.code === 'ENOENT' || (e.code as unknown) === 127,
            timedOut: e.killed === true,
          });
        },
      );
    });
}

interface ApprovalRules {
  enabled: string[];
  disabled: string[];
  all: boolean;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Вывод `--json`: login-шелл мог напечатать лишнее до данных, поэтому разбор идёт и с первой строки, начинающейся с `[` либо `{`. */
export function parseJsonOutput(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const at = text.search(/^[[{]/m);
    if (at < 0) throw new Error('вывод не JSON');
    return JSON.parse(text.slice(at));
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const canonical = (dir: string): string => {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
};

const idParts = (id: string): { name: string; marketplace: string } => {
  const at = id.lastIndexOf('@');
  return at > 0 ? { name: id.slice(0, at), marketplace: id.slice(at + 1) } : { name: id, marketplace: '' };
};

const SCOPES: readonly string[] = ['user', 'project', 'local', 'managed', 'session', 'synced'];

interface RawPlugin {
  id: string;
  version: string;
  scope: Scope;
  enabled: boolean;
  installPath: string | null;
  projectPath: string | null;
  mcpServers: unknown;
  errors: string[];
}

function rawPlugins(value: unknown): RawPlugin[] {
  if (!Array.isArray(value)) throw new Error('ответ не список');
  const out: RawPlugin[] = [];
  for (const item of value) {
    if (!isObject(item) || typeof item.id !== 'string' || typeof item.scope !== 'string' || !SCOPES.includes(item.scope)) continue;
    out.push({
      id: item.id,
      version: typeof item.version === 'string' ? item.version : '',
      scope: item.scope as Scope,
      enabled: item.enabled === true,
      installPath: typeof item.installPath === 'string' ? item.installPath : null,
      projectPath: typeof item.projectPath === 'string' ? item.projectPath : null,
      mcpServers: item.mcpServers,
      errors: Array.isArray(item.errors) ? item.errors.map((e) => (isObject(e) && typeof e.message === 'string' ? e.message : String(e))).slice(0, 5) : [],
    });
  }
  return out;
}

async function runJson(env: ExtensionsEnv, args: string[], cwd: string): Promise<unknown> {
  const result = await env.run(args, cwd, LIST_TIMEOUT_MS);
  if (result.missing) throw new Error('claude не найден в PATH');
  if (result.timedOut) throw new Error('claude не ответил за 30 с');
  if (result.code !== 0) throw new Error(result.stderr.trim().split('\n')[0] || `claude завершился с кодом ${result.code}`);
  return parseJsonOutput(result.stdout);
}

/** Плагины: общий список (настройки пользователя) и список из каталога каждого репозитория, где видно, что включено именно там. */
async function loadPlugins(env: ExtensionsEnv, dirs: string[], claude: ClaudeInfo): Promise<{ plugins: InstalledPlugin[]; mcp: McpServer[] }> {
  const canon = new Map(dirs.map((dir) => [canonical(dir), dir]));
  const lists = await mapLimit([env.neutralDir, ...dirs], PLUGIN_LIST_PARALLEL, async (cwd) => {
    try {
      return rawPlugins(await runJson(env, ['plugin', 'list', '--json'], cwd));
    } catch (error) {
      return error as Error;
    }
  });
  const failed = lists.find((l): l is Error => l instanceof Error);
  if (failed) claude.problem = `Список плагинов не получен: ${reason(failed)}`;
  const byKey = new Map<string, InstalledPlugin>();
  const mcp = new Map<string, McpServer>();
  for (const [index, list] of lists.entries()) {
    if (list instanceof Error) continue;
    const cwd = index === 0 ? null : dirs[index - 1];
    for (const entry of list) {
      const project = entry.scope === 'project' || entry.scope === 'local';
      const dir = project && entry.projectPath ? canon.get(canonical(entry.projectPath)) : undefined;
      if (project && !dir) continue;
      const key = `${entry.id}|${entry.scope}|${dir ?? ''}`;
      let plugin = byKey.get(key);
      if (!plugin) {
        const parts = idParts(entry.id);
        plugin = {
          id: entry.id,
          ...parts,
          version: entry.version,
          scope: entry.scope,
          ...(dir ? { dir } : {}),
          enabledGlobal: false,
          enabledIn: {},
          components: [],
          mcp: [],
          errors: entry.errors,
        };
        byKey.set(key, plugin);
        if (entry.installPath) plugin.components = await readComponents(entry.installPath).catch(() => [] as Component[]);
      }
      // Серверы плагина Claude Code называет только в списке, снятом там, где плагин включён.
      for (const server of mcpServersOf(entry.mcpServers, { scope: 'plugin', plugin: entry.id })) {
        if (!plugin.mcp.includes(server.name)) plugin.mcp.push(server.name);
        mcp.set(`${entry.id}|${server.name}`, server);
      }
      if (cwd === null) plugin.enabledGlobal = entry.enabled;
      else plugin.enabledIn[cwd] = entry.enabled;
    }
  }
  return { plugins: [...byKey.values()], mcp: [...mcp.values()] };
}

async function safe<T>(label: string, problems: string[], fallback: T, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    problems.push(`${label}: ${reason(error)}`);
    return fallback;
  }
}

async function standaloneIn(root: string, scope: Scope, dir?: string): Promise<StandaloneComponent[]> {
  return (await readComponents(root)).map((c) => ({ ...c, scope, ...(dir ? { dir } : {}) }));
}

/** Магазины: подключённые (по списку Claude Code) и названные в настройках репозиториев, но не подключённые. */
async function loadMarketplaces(env: ExtensionsEnv, declared: Map<string, { source: string; by: string[] }>, problems: string[]): Promise<Marketplace[]> {
  const listed = await safe('Список магазинов', problems, [] as unknown[], async () => {
    const value = await runJson(env, ['plugin', 'marketplace', 'list', '--json'], env.neutralDir);
    if (!Array.isArray(value)) throw new Error('ответ не список');
    return value;
  });
  const known = await safe('known_marketplaces.json', problems, null as unknown, () => readJson(path.join(env.configDir, 'plugins', 'known_marketplaces.json')));
  const updated = (name: string): string | undefined => {
    const entry = isObject(known) ? known[name] : undefined;
    return isObject(entry) && typeof entry.lastUpdated === 'string' ? entry.lastUpdated : undefined;
  };
  const result: Marketplace[] = [];
  const seen = new Set<string>();
  for (const item of listed) {
    if (!isObject(item) || typeof item.name !== 'string') continue;
    seen.add(item.name);
    const market: Marketplace = {
      name: item.name,
      source: describeSource(item),
      ...(updated(item.name) ? { updated: updated(item.name) } : {}),
      known: true,
      declaredBy: declared.get(item.name)?.by ?? [],
      plugins: [],
    };
    result.push(market);
    if (typeof item.installLocation !== 'string') {
      market.problem = 'Каталог магазина хранится на claude.ai, состав не читается';
      continue;
    }
    try {
      const catalog = await readCatalog(item.installLocation);
      market.truncated = catalog.truncated;
      market.plugins = await mapLimit(catalog.plugins, 16, async (plugin) => ({
        name: plugin.name,
        description: plugin.description,
        ...(plugin.version ? { version: plugin.version } : {}),
        ...(plugin.category ? { category: plugin.category } : {}),
        remote: plugin.folder === null,
        components: plugin.folder === null ? null : await readComponents(plugin.folder),
      }));
    } catch (error) {
      market.problem = `Состав не прочитан: ${reason(error)}`;
    }
  }
  for (const [name, info] of declared) {
    if (!seen.has(name)) result.push({ name, source: info.source, known: false, declaredBy: info.by, plugins: [] });
  }
  return result;
}

/** Всё, что видно окну «Расширения» по каталогам dirs (репозитории проекта и рабочий каталог сессии). */
export async function loadExtensions(dirs: string[], env: ExtensionsEnv): Promise<ExtensionsReply> {
  const problems: string[] = [];
  const claude: ClaudeInfo = {};
  const version = await env.run(['--version'], env.neutralDir, 10_000);
  if (version.missing) claude.problem = 'claude не найден в PATH: список плагинов и магазинов недоступен';
  else claude.version = /^\d+\.\d+\.\d+\S*/.exec(version.stdout.trim())?.[0];

  const settingsFiles = new Map<string, SettingsFile>();
  const readSettingsOf = async (file: string): Promise<SettingsFile | null> => {
    const parsed = await safe(path.basename(path.dirname(file)) + '/' + path.basename(file), problems, null as SettingsFile | null, () => readSettings(file));
    if (parsed) settingsFiles.set(file, parsed);
    return parsed;
  };
  const userSettings = path.join(env.configDir, 'settings.json');
  const managedSettings = env.managedDir ? path.join(env.managedDir, 'managed-settings.json') : null;
  const files = [userSettings, ...(managedSettings ? [managedSettings] : []), ...dirs.flatMap((dir) => [path.join(dir, '.claude', 'settings.json'), path.join(dir, '.claude', 'settings.local.json')])];
  await Promise.all(files.map(readSettingsOf));

  const declared = new Map<string, { source: string; by: string[] }>();
  for (const dir of dirs) {
    for (const name of ['settings.json', 'settings.local.json']) {
      for (const market of settingsFiles.get(path.join(dir, '.claude', name))?.declaredMarketplaces ?? []) {
        const entry = declared.get(market.name) ?? { source: market.source, by: [] };
        if (!entry.by.includes(dir)) entry.by.push(dir);
        declared.set(market.name, entry);
      }
    }
  }

  const claudeJson = await safe('.claude.json', problems, { mcpServers: undefined, projects: new Map() } as ClaudeJson, () => readClaudeJson(env.claudeJson));

  const [pluginsResult, marketplaces, standalone] = await Promise.all([
    version.missing ? Promise.resolve({ plugins: [] as InstalledPlugin[], mcp: [] as McpServer[] }) : loadPlugins(env, dirs, claude),
    version.missing ? Promise.resolve([] as Marketplace[]) : loadMarketplaces(env, declared, problems),
    (async () => {
      const found: StandaloneComponent[] = [];
      found.push(...(await standaloneIn(env.configDir, 'user')));
      found.push(...(await readSyncedSkills(path.join(env.configDir, 'skills'))).map((c) => ({ ...c, scope: 'synced' as const })));
      for (const dir of dirs) found.push(...(await standaloneIn(path.join(dir, '.claude'), 'project', dir)));
      return found;
    })().catch((error) => {
      problems.push(`Скиллы: ${reason(error)}`);
      return [] as StandaloneComponent[];
    }),
  ]);

  // Серверы MCP: пользователь, репозитории (личные и .mcp.json), организация; серверы плагинов пришли со списком плагинов.
  const mcp: McpServer[] = [...mcpServersOf(claudeJson.mcpServers, { scope: 'user' })];
  const rulesOf = (settings?: SettingsFile): ApprovalRules => ({ enabled: settings?.enabledMcp ?? [], disabled: settings?.disabledMcp ?? [], all: settings?.enableAllMcp ?? false });
  /** Одобрения серверов `.mcp.json`: запись Claude Code о проекте и все файлы настроек, которые их хранят. */
  const approvals = (dir: string, project?: { enabled: string[]; disabled: string[] }): ApprovalRules => {
    const files = [userSettings, managedSettings, path.join(dir, '.claude', 'settings.json'), path.join(dir, '.claude', 'settings.local.json')];
    const rules = [{ enabled: project?.enabled ?? [], disabled: project?.disabled ?? [], all: false }, ...files.map((f) => rulesOf(f ? settingsFiles.get(f) : undefined))];
    return { enabled: rules.flatMap((r) => r.enabled), disabled: rules.flatMap((r) => r.disabled), all: rules.some((r) => r.all) };
  };
  for (const dir of dirs) {
    const project = claudeJson.projects.get(dir) ?? claudeJson.projects.get(canonical(dir));
    mcp.push(...mcpServersOf(project?.mcpServers, { scope: 'local', dir }));
    const projectFile = await safe(`${path.basename(dir)}/.mcp.json`, problems, null as unknown, () => readJson(path.join(dir, '.mcp.json')));
    if (isObject(projectFile)) {
      const rule = approvals(dir, project);
      mcp.push(...mcpServersOf(projectFile.mcpServers, { scope: 'project', dir }, (name) => approvalOf(name, rule.enabled, rule.disabled, rule.all)));
    }
  }
  if (env.managedDir) {
    const managed = await safe('managed-mcp.json', problems, null as unknown, () => readJson(path.join(env.managedDir!, 'managed-mcp.json')));
    if (isObject(managed)) mcp.push(...mcpServersOf(managed.mcpServers, { scope: 'managed' }));
  }
  mcp.push(...pluginsResult.mcp);

  return { claude, marketplaces, plugins: pluginsResult.plugins, standalone, mcp, problems: problems.slice(0, 20) };
}

// ---------- проверка связи ----------

const ANSI = /\u001b\[[0-9;]*m/g;

function healthOf(status: string): { health: McpHealth; detail?: string } {
  if (status.startsWith('✔')) return { health: 'connected' };
  if (status.startsWith('!')) return { health: 'needs-auth' };
  if (status.startsWith('⏸')) return { health: 'pending' };
  if (status.startsWith('✘')) {
    const detail = status.replace(/^✘\s*Failed to connect\s*[—-]?\s*/, '').trim();
    return { health: 'failed', ...(detail ? { detail: detail.slice(0, 200) } : {}) };
  }
  return { health: 'unknown' };
}

/** Текстовый вывод `claude mcp list`: `имя: цель - состояние`. У команды нет --json. */
export function parseMcpList(text: string): ProbeEntry[] {
  const out: ProbeEntry[] = [];
  for (const line of text.replace(ANSI, '').split(/\r?\n/)) {
    const match = /^(.+?): .* - ((?:✔|!|✘|⏸).*)$/.exec(line.trim());
    if (match) out.push({ name: match[1].slice(0, MAX_NAME_LENGTH), ...healthOf(match[2]) });
  }
  return out;
}

/** `claude mcp list` в каталоге: запускает программы серверов и ходит по сети, поэтому вызывается только по просьбе человека. */
export async function probeMcp(dir: string, run: ClaudeRunner): Promise<ProbeReply> {
  const result = await run(['mcp', 'list'], dir, PROBE_TIMEOUT_MS);
  if (result.missing) return { entries: [], error: 'claude не найден в PATH' };
  if (result.timedOut) return { entries: [], error: 'Проверка не закончилась за 90 с' };
  const entries = parseMcpList(result.stdout);
  if (!entries.length && result.code !== 0) return { entries, error: result.stderr.trim().split('\n')[0] || `claude завершился с кодом ${result.code}` };
  return { entries };
}
