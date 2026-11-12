import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { MarketplaceSpec, McpServer, MirrorFile } from '../../agentd/protocol';
import { projectDirName } from '../history';

export const MIRROR_MAX_BYTES = 20 * 1024 * 1024;
export const MEMORY_MAX_BYTES = 2 * 1024 * 1024;
const MIRROR_DIRS = ['hooks', 'commands', 'agents', 'skills', 'output-styles', 'bin'];
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__']);

/** Настройка Claude оператора для хоста: файлы и плагины - в ~/.claude хоста, env и MCP - в память демона. */
export interface ClaudeMirror {
  hash: string;
  files: MirrorFile[];
  marketplaces: MarketplaceSpec[];
  plugins: string[];
  env: Record<string, string>;
  mcp: Record<string, McpServer>;
  /** Что на хост не уходит, с причиной: интерфейс печатает во вкладку. */
  skipped: string[];
}

export interface ClaudeConfigPaths {
  home: string;
  configDir: string;
  claudeJson: string;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

async function readJson(file: string): Promise<Json | null> {
  try {
    const v = JSON.parse(await fsp.readFile(file, 'utf8')) as unknown;
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

interface WalkState {
  bytes: number;
  limit: number;
  over: boolean;
  seen: Set<string>;
}

/** Файлы каталога по алфавиту, ссылки разыменованы; на первом файле сверх предела обход кончается, в skipped - одна строка. */
async function walk(dir: string, rel: string, out: MirrorFile[], state: WalkState): Promise<void> {
  if (state.over) return;
  let real: string;
  let names: string[];
  try {
    real = await fsp.realpath(dir);
    if (state.seen.has(real)) return;
    state.seen.add(real);
    names = (await fsp.readdir(dir)).sort();
  } catch {
    return;
  }
  for (const name of names) {
    if (state.over) return;
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    const st = await fsp.stat(full).catch(() => null);
    if (st?.isDirectory()) await walk(full, r, out, state);
    else if (st?.isFile()) await walkFile(full, r, out, state, st.size, st.mode);
  }
}

async function walkFile(file: string, rel: string, out: MirrorFile[], state: WalkState, size: number, mode: number): Promise<void> {
  if (state.bytes + size > state.limit) {
    state.over = true;
    return;
  }
  const data = await fsp.readFile(file).catch(() => null);
  if (!data) return;
  state.bytes += data.length;
  out.push({ rel, mode: mode & 0o111 ? 0o755 : 0o644, b64: data.toString('base64') });
}

/** Абсолютный локальный HOME в командах: на хосте домашний каталог другой. */
function rehome(text: string, home: string, to: string): string {
  return home && home !== '/' ? text.split(`${home}/`).join(`${to}/`) : text;
}

function marketSource(source: unknown): string | null {
  if (!isObj(source)) return null;
  const ref = typeof source.ref === 'string' && source.ref ? `#${source.ref}` : '';
  if (source.source === 'github' && typeof source.repo === 'string') return `${source.repo}${ref}`;
  if ((source.source === 'git' || source.source === 'url') && typeof source.url === 'string') return `${source.url}${ref}`;
  return null;
}

/** settings.json для хоста: пути хуков от $HOME, без env и без плагинов локальных маркетплейсов. */
function hostSettings(settings: Json, home: string, local: Set<string>): Json {
  const out: Json = { ...settings };
  delete out.env;
  if (isObj(out.hooks)) {
    const hooks: Json = {};
    for (const [event, groups] of Object.entries(out.hooks)) {
      hooks[event] = Array.isArray(groups)
        ? groups.map((g) =>
            isObj(g) && Array.isArray(g.hooks)
              ? { ...g, hooks: g.hooks.map((h) => (isObj(h) && typeof h.command === 'string' ? { ...h, command: rehome(h.command, home, '$HOME') } : h)) }
              : g,
          )
        : groups;
    }
    out.hooks = hooks;
  }
  if (isObj(out.statusLine) && typeof out.statusLine.command === 'string') out.statusLine = { ...out.statusLine, command: rehome(out.statusLine.command, home, '$HOME') };
  if (isObj(out.enabledPlugins)) out.enabledPlugins = Object.fromEntries(Object.entries(out.enabledPlugins).filter(([id]) => !local.has(id.split('@')[1] ?? '')));
  if (isObj(out.extraKnownMarketplaces)) out.extraKnownMarketplaces = Object.fromEntries(Object.entries(out.extraKnownMarketplaces).filter(([name]) => !local.has(name)));
  return out;
}

/** Серверы MCP пользователя: локальный HOME в команде stdio - в ~/, демон раскрывает его в свой. */
function userMcp(claudeJson: Json | null, home: string): Record<string, McpServer> {
  const servers = isObj(claudeJson?.mcpServers) ? claudeJson.mcpServers : {};
  const out: Record<string, McpServer> = {};
  for (const [name, server] of Object.entries(servers)) {
    if (!isObj(server) || name === 'cyborg') continue;
    const s: McpServer = { ...server };
    if (typeof s.command === 'string') s.command = rehome(s.command, home, '~');
    if (Array.isArray(s.args)) s.args = s.args.map((a) => (typeof a === 'string' ? rehome(a, home, '~') : a));
    out[name] = s;
  }
  return out;
}

/** Читает ~/.claude асинхронно: зеркало собирается в главном процессе на каждый запуск и не должно держать окно. */
export async function buildMirror(paths: ClaudeConfigPaths): Promise<ClaudeMirror> {
  const { home, configDir } = paths;
  const skipped: string[] = [];
  const known = (await readJson(path.join(configDir, 'plugins', 'known_marketplaces.json'))) ?? {};
  const settings = await readJson(path.join(configDir, 'settings.json'));
  const extra = isObj(settings?.extraKnownMarketplaces) ? settings.extraKnownMarketplaces : {};
  const marketplaces: MarketplaceSpec[] = [];
  const local = new Set<string>();
  for (const [name, entry] of Object.entries({ ...extra, ...known }).sort(([a], [b]) => a.localeCompare(b))) {
    const source = marketSource(isObj(entry) ? entry.source : null);
    if (source && !source.startsWith('-')) marketplaces.push({ name, source });
    else local.add(name);
  }
  const enabled = isObj(settings?.enabledPlugins) ? settings.enabledPlugins : {};
  for (const id of Object.keys(enabled).sort()) {
    const market = id.split('@')[1] ?? '';
    if (enabled[id] === true && local.has(market)) skipped.push(`плагин ${id}: маркетплейс ${market} лежит на этой машине, на хост не переносится`);
  }
  const plugins = Object.keys(enabled)
    .filter((id) => enabled[id] === true && /^[\w.-]+@[\w.-]+$/.test(id) && !local.has(id.split('@')[1]))
    .sort();
  const files: MirrorFile[] = [];
  const state: WalkState = { bytes: 0, limit: MIRROR_MAX_BYTES, over: false, seen: new Set() };
  const md = path.join(configDir, 'CLAUDE.md');
  const mdStat = await fsp.stat(md).catch(() => null);
  if (mdStat?.isFile()) await walkFile(md, 'CLAUDE.md', files, state, mdStat.size, mdStat.mode);
  if (settings) {
    const data = Buffer.from(JSON.stringify(hostSettings(settings, home, local), null, 2));
    state.bytes += data.length;
    files.push({ rel: 'settings.json', mode: 0o644, b64: data.toString('base64') });
  }
  for (const dir of MIRROR_DIRS) await walk(path.join(configDir, dir), dir, files, state);
  if (state.over) skipped.push(`настройка Claude больше ${MIRROR_MAX_BYTES / 1024 / 1024} МиБ: часть файлов на хост не ушла`);
  const env: Record<string, string> = {};
  if (isObj(settings?.env)) for (const [k, v] of Object.entries(settings.env)) if (typeof v === 'string') env[k] = rehome(v, home, '~');
  const hash = createHash('sha256').update(JSON.stringify({ files: files.map((f) => [f.rel, f.mode, f.b64]), marketplaces, plugins })).digest('hex');
  return { hash, files, marketplaces, plugins, env, mcp: userMcp(await readJson(paths.claudeJson), home), skipped };
}

/** Память проекта репозитория для хоста: только на запуск, записи агента обратно не возвращаются. */
export async function readMemory(configDir: string, repo: string): Promise<MirrorFile[]> {
  const files: MirrorFile[] = [];
  await walk(path.join(configDir, 'projects', projectDirName(repo), 'memory'), '', files, { bytes: 0, limit: MEMORY_MAX_BYTES, over: false, seen: new Set() });
  return files;
}

/** Адрес маркетплейса для сбора git-доступа: github-источник owner/repo - в https. */
export function marketplaceUrl(source: string): string {
  const bare = source.replace(/#.*$/, '');
  return /^[\w.-]+\/[\w.-]+$/.test(bare) ? `https://github.com/${bare}.git` : bare;
}
