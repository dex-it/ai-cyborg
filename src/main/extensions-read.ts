/**
 * Чтение того, что Claude Code хранит о магазинах, плагинах, скиллах и MCP (FR-14003..FR-14007). Только чтение и только
 * нужные поля: значения `env` и `headers` MCP-серверов, аргументы их запуска и учётные данные адресов не покидают этот файл.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  MAX_COMPONENTS_PER_PLUGIN,
  MAX_DESCRIPTION_LENGTH,
  MAX_MARKETPLACE_PLUGINS,
  MAX_NAME_LENGTH,
  type Component,
  type ComponentKind,
  type McpApproval,
  type McpServer,
  type McpTransport,
} from '../shared/extensions';
import { isInside } from './allowed-paths';

/** Файл, который читается целиком (настройки, .mcp.json, marketplace.json): больше - не читается. */
const MAX_JSON_BYTES = 8 * 1024 * 1024;
/** ~/.claude.json копит историю всех проектов и бывает большим. */
const MAX_CLAUDE_JSON_BYTES = 64 * 1024 * 1024;
/** Frontmatter читается из начала файла. */
const HEAD_BYTES = 8 * 1024;
const CONCURRENCY = 16;

const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

/** Параллельный обход с пределом: тысячи маленьких файлов не должны исчерпать дескрипторы. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function readHead(file: string): Promise<string | null> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(file, 'r');
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/** JSON-файл целиком; нет файла - null, повреждён либо велик - исключение с причиной. */
export async function readJson(file: string, limit = MAX_JSON_BYTES): Promise<unknown | null> {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
  if (!stat.isFile()) return null;
  if (stat.size > limit) throw new Error(`файл больше ${Math.round(limit / 1024 / 1024)} МиБ`);
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

/**
 * Поля `name` и `description` из frontmatter (YAML между `---`): однострочные значения, значения в кавычках и блочные
 * (`>`, `|`) либо продолженные отступом. Остальное не читается.
 */
export function parseFrontmatter(text: string): { name?: string; description?: string } {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return {};
  const out: Record<string, string> = {};
  let key: string | null = null;
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') break;
    const top = /^([A-Za-z_][\w-]*):(?:\s+(.*)|\s*)$/.exec(line);
    if (top) {
      key = top[1];
      const value = (top[2] ?? '').trim();
      out[key] = /^[>|][+-]?$/.test(value) ? '' : unquote(value);
    } else if (key && /^\s+\S/.test(line)) {
      out[key] = `${out[key]} ${line.trim()}`.trim();
    } else if (line.trim() !== '') {
      key = null;
    }
  }
  return {
    ...(out.name ? { name: clip(out.name, MAX_NAME_LENGTH) } : {}),
    ...(out.description ? { description: clip(out.description, MAX_DESCRIPTION_LENGTH) } : {}),
  };
}

function unquote(value: string): string {
  const quoted = /^(["'])(.*)\1$/.exec(value);
  return quoted ? quoted[2] : value;
}

async function isDir(file: string): Promise<boolean> {
  return fs.stat(file).then((s) => s.isDirectory(), () => false);
}

async function listNames(dir: string): Promise<string[]> {
  return fs.readdir(dir).then((names) => names.sort(), () => []);
}

async function component(kind: ComponentKind, file: string, fallback: string): Promise<Component | null> {
  const head = await readHead(file);
  if (head === null) return null;
  const meta = parseFrontmatter(head);
  return { kind, name: meta.name ?? fallback, description: meta.description ?? '' };
}

/** `skills/<имя>/SKILL.md`. */
async function readSkills(dir: string): Promise<Component[]> {
  const found = await mapLimit(await listNames(dir), CONCURRENCY, async (name) =>
    (await isDir(path.join(dir, name))) ? component('skill', path.join(dir, name, 'SKILL.md'), name) : null,
  );
  return found.filter((c): c is Component => c !== null);
}

/** `commands/<имя>.md`, один уровень подкаталогов даёт `каталог:имя`. */
async function readCommands(dir: string): Promise<Component[]> {
  const out: Component[] = [];
  for (const name of await listNames(dir)) {
    const full = path.join(dir, name);
    if (name.endsWith('.md')) {
      const c = await component('command', full, name.slice(0, -3));
      if (c) out.push(c);
    } else if (await isDir(full)) {
      for (const inner of (await listNames(full)).filter((n) => n.endsWith('.md'))) {
        const c = await component('command', path.join(full, inner), inner.slice(0, -3));
        if (c) out.push({ ...c, name: `${name}:${c.name}` });
      }
    }
  }
  return out;
}

/** `agents/<имя>.md`. */
async function readAgents(dir: string): Promise<Component[]> {
  const found = await mapLimit((await listNames(dir)).filter((n) => n.endsWith('.md')), CONCURRENCY, (name) =>
    component('agent', path.join(dir, name), name.slice(0, -3)),
  );
  return found.filter((c): c is Component => c !== null);
}

/** Скиллы, команды и агенты под каталогом `skills`, `commands`, `agents` корня плагина либо `.claude`. */
export async function readComponents(root: string): Promise<Component[]> {
  const [skills, commands, agents] = await Promise.all([readSkills(path.join(root, 'skills')), readCommands(path.join(root, 'commands')), readAgents(path.join(root, 'agents'))]);
  return [...skills, ...commands, ...agents].slice(0, MAX_COMPONENTS_PER_PLUGIN);
}

/**
 * Скиллы, которые claude.ai синхронизирует в ~/.claude/skills/synced/<id>/<скилл>/SKILL.md: уровень каталога с
 * идентификатором пропускается.
 */
export async function readSyncedSkills(skillsDir: string): Promise<Component[]> {
  const root = path.join(skillsDir, 'synced');
  const out: Component[] = [];
  for (const id of await listNames(root)) {
    if (id.startsWith('.') || !(await isDir(path.join(root, id)))) continue;
    out.push(...(await readSkills(path.join(root, id))));
  }
  return out.slice(0, MAX_COMPONENTS_PER_PLUGIN);
}

// ---------- MCP ----------

/** Транспорт и безопасная подпись сервера: программа без аргументов либо схема и хост без пути, запроса и учётных данных. */
export function describeMcp(config: unknown): { transport: McpTransport; target: string } | null {
  if (!isObject(config)) return null;
  const type = typeof config.type === 'string' ? config.type : null;
  const command = typeof config.command === 'string' ? config.command : null;
  const url = typeof config.url === 'string' ? config.url : null;
  if (command && (type === null || type === 'stdio')) return { transport: 'stdio', target: clip(path.basename(command.trim()), MAX_NAME_LENGTH) };
  const transport: McpTransport = type === 'http' || type === 'sse' || type === 'ws' ? type : url ? 'http' : 'other';
  if (url) return { transport, target: hostOf(url) };
  return { transport: type === 'stdio' ? 'stdio' : 'other', target: '' };
}

function hostOf(value: string): string {
  try {
    const url = new URL(value);
    return clip(`${url.protocol}//${url.host}`, MAX_NAME_LENGTH * 2);
  } catch {
    return '';
  }
}

/** Серверы из объекта `mcpServers`: имя, транспорт, подпись. Остальное содержимое записи отбрасывается. */
export function mcpServersOf(
  value: unknown,
  base: Pick<McpServer, 'scope'> & Partial<Pick<McpServer, 'dir' | 'plugin'>>,
  approval?: (name: string) => McpApproval,
): McpServer[] {
  if (!isObject(value)) return [];
  const out: McpServer[] = [];
  for (const [name, config] of Object.entries(value)) {
    const described = describeMcp(config);
    if (!described) continue;
    out.push({ ...base, name: clip(name, MAX_NAME_LENGTH), ...described, ...(approval ? { approval: approval(name) } : {}) });
  }
  return out;
}

/** Из ~/.claude.json берутся только серверы пользователя и по проектам; история и учётные данные не читаются дальше разбора. */
export interface ClaudeJson {
  mcpServers: unknown;
  projects: Map<string, { mcpServers: unknown; enabled: string[]; disabled: string[] }>;
}

export async function readClaudeJson(file: string): Promise<ClaudeJson> {
  const raw = await readJson(file, MAX_CLAUDE_JSON_BYTES);
  const out: ClaudeJson = { mcpServers: undefined, projects: new Map() };
  if (!isObject(raw)) return out;
  out.mcpServers = raw.mcpServers;
  if (isObject(raw.projects)) {
    for (const [dir, entry] of Object.entries(raw.projects)) {
      if (!isObject(entry)) continue;
      out.projects.set(dir, { mcpServers: entry.mcpServers, enabled: strings(entry.enabledMcpjsonServers), disabled: strings(entry.disabledMcpjsonServers) });
    }
  }
  return out;
}

// ---------- настройки ----------

export interface SettingsFile {
  declaredMarketplaces: { name: string; source: string }[];
  enabledMcp: string[];
  disabledMcp: string[];
  enableAllMcp: boolean;
}

/** Строка о том, откуда подключён магазин; учётные данные адреса отбрасываются. */
export function describeSource(source: unknown): string {
  if (!isObject(source)) return '';
  const kind = typeof source.source === 'string' ? source.source : typeof source.type === 'string' ? source.type : '';
  const target = (typeof source.repo === 'string' && source.repo) || (typeof source.url === 'string' && stripCredentials(source.url)) || (typeof source.path === 'string' && source.path) || '';
  return clip([kind, target].filter(Boolean).join(' '), 300);
}

function stripCredentials(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    return url.toString();
  } catch {
    return /^[\w.-]+@[\w.-]+:/.test(value) ? value.replace(/^[^@]*@/, '') : '';
  }
}

/** Настройки Claude Code: названные магазины и одобрения серверов `.mcp.json`; нет файла - пусто, повреждён - исключение. */
export async function readSettings(file: string): Promise<SettingsFile> {
  const raw = await readJson(file);
  const out: SettingsFile = { declaredMarketplaces: [], enabledMcp: [], disabledMcp: [], enableAllMcp: false };
  if (!isObject(raw)) return out;
  if (isObject(raw.extraKnownMarketplaces)) {
    for (const [name, entry] of Object.entries(raw.extraKnownMarketplaces)) {
      out.declaredMarketplaces.push({ name: clip(name, MAX_NAME_LENGTH), source: isObject(entry) ? describeSource(entry.source) : '' });
    }
  }
  out.enabledMcp = strings(raw.enabledMcpjsonServers);
  out.disabledMcp = strings(raw.disabledMcpjsonServers);
  out.enableAllMcp = raw.enableAllProjectMcpServers === true;
  return out;
}

/** Одобрение сервера из `.mcp.json`: «отключён» сильнее «разрешён»; без записи сервер ждёт одобрения в сессии. */
export function approvalOf(name: string, enabled: string[], disabled: string[], enableAll: boolean): McpApproval {
  if (disabled.includes(name)) return 'disabled';
  return enableAll || enabled.includes(name) ? 'approved' : 'pending';
}

// ---------- магазины ----------

export interface CatalogPlugin {
  name: string;
  description: string;
  version?: string;
  category?: string;
  /** Путь внутри клона магазина; null - исходники не в клоне. */
  folder: string | null;
}

/** Плагины из `.claude-plugin/marketplace.json`; относительный `source` даёт каталог плагина внутри клона, и только внутри. */
export async function readCatalog(installLocation: string): Promise<{ plugins: CatalogPlugin[]; truncated: boolean }> {
  const raw = await readJson(path.join(installLocation, '.claude-plugin', 'marketplace.json'));
  if (!isObject(raw) || !Array.isArray(raw.plugins)) throw new Error('нет списка plugins в marketplace.json');
  const pluginRoot = isObject(raw.metadata) && typeof raw.metadata.pluginRoot === 'string' ? raw.metadata.pluginRoot : '';
  const plugins: CatalogPlugin[] = [];
  for (const entry of raw.plugins.slice(0, MAX_MARKETPLACE_PLUGINS)) {
    if (!isObject(entry) || typeof entry.name !== 'string') continue;
    let folder: string | null = null;
    if (typeof entry.source === 'string') {
      const resolved = path.resolve(installLocation, pluginRoot, entry.source);
      folder = isInside(resolved, installLocation) ? resolved : null;
    }
    plugins.push({
      name: clip(entry.name, MAX_NAME_LENGTH),
      description: typeof entry.description === 'string' ? clip(entry.description, MAX_DESCRIPTION_LENGTH) : '',
      ...(typeof entry.version === 'string' ? { version: clip(entry.version, 40) } : {}),
      ...(typeof entry.category === 'string' ? { category: clip(entry.category, 60) } : {}),
      folder,
    });
  }
  return { plugins, truncated: raw.plugins.length > MAX_MARKETPLACE_PLUGINS };
}
