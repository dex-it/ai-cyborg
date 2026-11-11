import fs from 'node:fs';
import path from 'node:path';
import { projectDirName } from '../main/history.ts';
import type { ConfigMsg, MarketplaceSpec, McpServer, MirrorFile } from './protocol.ts';

/** Пути Claude на хосте: CLAUDE_CONFIG_DIR меняет и каталог, и место .claude.json. */
export interface ClaudeHome {
  home: string;
  configDir: string;
  claudeJson: string;
}

export function claudeHome(home: string, custom?: string): ClaudeHome {
  return { home, configDir: custom || path.join(home, '.claude'), claudeJson: custom ? path.join(custom, '.claude.json') : path.join(home, '.claude.json') };
}

export interface SetupExec {
  (file: string, args: string[], opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }>;
}

interface Manifest {
  hash: string;
  files: string[];
}

const FILE_REL = /^(CLAUDE\.md|settings\.json|(hooks|commands|agents|skills|output-styles|bin)\/.+)$/;
const NAME = /^[\w.-]{1,128}$/;
const PLUGIN = /^[\w.-]{1,128}@[\w.-]{1,128}$/;
const ORIG = '.cyborg-orig';

/** Относительный путь без выхода из каталога: ни пустых частей, ни «.» и «..». */
export function safeRel(rel: unknown): rel is string {
  return typeof rel === 'string' && rel.length < 1024 && !rel.includes('\0') && rel.split('/').every((p) => p !== '' && p !== '.' && p !== '..');
}

function writeAtomic(file: string, data: Buffer | string, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.cyborg-tmp-${process.pid}`;
  fs.writeFileSync(tmp, data, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

const manifestFile = (root: string): string => path.join(root, 'config.json');

function readManifest(root: string): Manifest | null {
  try {
    const v = JSON.parse(fs.readFileSync(manifestFile(root), 'utf8')) as Manifest;
    return typeof v.hash === 'string' && Array.isArray(v.files) ? v : null;
  } catch {
    return null;
  }
}

/** Хэш зеркала, лежащего на хосте: Cyborg по нему решает, слать ли настройку заново. */
export function configHash(root: string): string | null {
  return readManifest(root)?.hash ?? null;
}

/** Установка плагинов зеркала: что ставить и чем кончилась прошлая попытка; хранится на диске, чтобы отказ переживал демона. */
export interface PluginState {
  marketplaces: MarketplaceSpec[];
  plugins: string[];
  done: boolean;
  notes: string[];
}

const pluginsFile = (root: string): string => path.join(root, 'plugins.json');

export function readPluginState(root: string): PluginState | null {
  try {
    const v = JSON.parse(fs.readFileSync(pluginsFile(root), 'utf8')) as PluginState;
    return Array.isArray(v.marketplaces) && Array.isArray(v.plugins) && Array.isArray(v.notes) ? v : null;
  } catch {
    return null;
  }
}

export function writePluginState(root: string, state: PluginState): void {
  writeAtomic(pluginsFile(root), JSON.stringify(state), 0o600);
}

/** Установка не доведена до чистого итога: новому запуску её повторять. */
export const pluginsPending = (state: PluginState | null): boolean => !!state && (!state.done || state.notes.length > 0);

const exists = (file: string): boolean => {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
};

/** Файлы зеркала в ~/.claude: чужой прежний файл один раз сохраняется рядом, снятые из зеркала удаляются. */
export function applyFiles(root: string, ch: ClaudeHome, msg: ConfigMsg): void {
  if (typeof msg.hash !== 'string' || !/^[0-9a-f]{64}$/.test(msg.hash) || !Array.isArray(msg.files)) throw new Error('некорректная настройка Claude');
  const prev = new Set(readManifest(root)?.files ?? []);
  const next: string[] = [];
  for (const f of msg.files) {
    if (!safeRel(f?.rel) || !FILE_REL.test(f.rel) || typeof f.b64 !== 'string') continue;
    const target = path.join(ch.configDir, f.rel);
    if (!prev.has(f.rel) && exists(target) && !exists(target + ORIG)) fs.renameSync(target, target + ORIG);
    writeAtomic(target, Buffer.from(f.b64, 'base64'), f.mode === 0o755 ? 0o755 : 0o644);
    next.push(f.rel);
  }
  const kept = new Set(next);
  for (const rel of prev) {
    if (kept.has(rel) || !safeRel(rel)) continue;
    const target = path.join(ch.configDir, rel);
    fs.rmSync(target, { force: true });
    if (exists(target + ORIG)) fs.renameSync(target + ORIG, target);
  }
  writeAtomic(manifestFile(root), JSON.stringify({ hash: msg.hash, files: next }), 0o600);
}

const lastLine = (text: string): string => text.trim().split('\n').pop()?.slice(0, 300) || 'без пояснения';

function names(stdout: string, key: 'name' | 'id'): Set<string> {
  try {
    const list = JSON.parse(stdout) as unknown;
    return new Set(Array.isArray(list) ? list.map((x) => (x as Record<string, unknown>)?.[key]).filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

/** Недостающие маркетплейсы и плагины через claude plugin на хосте; возвращает заметки об отказах. */
export async function installPlugins(exec: SetupExec, msg: Pick<ConfigMsg, 'marketplaces' | 'plugins'>, env: Record<string, string>): Promise<string[]> {
  const notes: string[] = [];
  const markets = (Array.isArray(msg.marketplaces) ? msg.marketplaces : []).filter(
    (m: MarketplaceSpec) => NAME.test(m?.name ?? '') && typeof m.source === 'string' && m.source.length < 2048 && !m.source.startsWith('-'),
  );
  const plugins = (Array.isArray(msg.plugins) ? msg.plugins : []).filter((p) => typeof p === 'string' && PLUGIN.test(p));
  if (!markets.length && !plugins.length) return notes;
  const known = await exec('claude', ['plugin', 'marketplace', 'list', '--json'], { env, timeoutMs: 60_000 });
  if (known.code !== 0) return [`плагины Claude не поставлены: claude plugin marketplace list - ${lastLine(known.stderr)}`];
  const have = names(known.stdout, 'name');
  for (const m of markets) {
    if (have.has(m.name)) continue;
    const r = await exec('claude', ['plugin', 'marketplace', 'add', m.source], { env, timeoutMs: 300_000 });
    if (r.code !== 0) notes.push(`маркетплейс ${m.name} не добавлен: ${lastLine(r.stderr || r.stdout)}`);
  }
  const listed = await exec('claude', ['plugin', 'list', '--json'], { env, timeoutMs: 60_000 });
  if (listed.code !== 0) return [...notes, `плагины Claude не поставлены: claude plugin list - ${lastLine(listed.stderr)}`];
  const installed = names(listed.stdout, 'id');
  for (const id of plugins) {
    if (installed.has(id)) continue;
    const r = await exec('claude', ['plugin', 'install', id], { env, timeoutMs: 300_000 });
    if (r.code !== 0) notes.push(`плагин ${id} не поставлен: ${lastLine(r.stderr || r.stdout)}`);
  }
  return notes;
}

/** Клоны сессии - доверенные каталоги: иначе claude встаёт на вопросе о доверии, а агенту spawn_agent ответить некому. */
export function trustClone(ch: ClaudeHome, dirs: string[]): void {
  // ~/.claude.json пишет и claude соседних сессий: запись, вклинившаяся между чтением и заменой файла, не теряется - чтение повторяется.
  for (let attempt = 0; attempt < 3; attempt++) {
    const seen = readClaudeJson(ch.claudeJson);
    if (!seen) return;
    const { data, mode, mtimeMs } = seen;
    const projects = typeof data.projects === 'object' && data.projects !== null ? { ...(data.projects as Record<string, unknown>) } : {};
    const trusted = (dir: string): boolean => (projects[dir] as { hasTrustDialogAccepted?: unknown } | undefined)?.hasTrustDialogAccepted === true;
    if (data.hasCompletedOnboarding !== undefined && dirs.every(trusted)) return;
    data.hasCompletedOnboarding ??= true;
    for (const dir of dirs) {
      const prev = projects[dir];
      projects[dir] = { ...(typeof prev === 'object' && prev !== null ? prev : {}), hasTrustDialogAccepted: true };
    }
    data.projects = projects;
    if (mtimeOf(ch.claudeJson) !== mtimeMs) continue;
    writeAtomic(ch.claudeJson, JSON.stringify(data, null, 2), mode);
    return;
  }
}

/** null - файл есть, но не разобрался: его не переписываем, в нём вход и история пользователя. */
function readClaudeJson(file: string): { data: Record<string, unknown>; mode: number; mtimeMs: number | null } | null {
  try {
    const st = fs.statSync(file);
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
    return { data: v as Record<string, unknown>, mode: st.mode & 0o777, mtimeMs: st.mtimeMs };
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? { data: {}, mode: 0o600, mtimeMs: null } : null;
  }
}

function mtimeOf(file: string): number | null {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/** Память проекта под каталог клона: так claude на хосте видит её как память этого проекта. */
export function writeMemory(ch: ClaudeHome, cwd: string, files: unknown): void {
  if (!Array.isArray(files)) return;
  const dir = path.join(ch.configDir, 'projects', projectDirName(cwd), 'memory');
  for (const f of files as MirrorFile[]) {
    if (!safeRel(f?.rel) || typeof f.b64 !== 'string') continue;
    writeAtomic(path.join(dir, f.rel), Buffer.from(f.b64, 'base64'), 0o600);
  }
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const ENV_DENY = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'PWD']);

/** env из settings.json оператора: переменные среды хоста и Cyborg он не переопределяет. */
export function readEnv(value: unknown, home: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof value !== 'object' || value === null) return out;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!ENV_NAME.test(k) || ENV_DENY.has(k) || k.startsWith('CYBORG_') || typeof v !== 'string' || v.includes('\0') || v.length > 32_768) continue;
    out[k] = v.startsWith('~/') ? path.join(home, v.slice(2)) : v;
  }
  return out;
}

function onPath(command: string, pathEnv: string): boolean {
  const runnable = (file: string): boolean => {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  };
  if (command.includes('/')) return path.isAbsolute(command) && runnable(command);
  return pathEnv.split(':').some((dir) => dir && runnable(path.join(dir, command)));
}

/** Серверы MCP пользователя, которые запустятся на хосте: ~/ раскрыт в HOME хоста, stdio без команды на хосте пропущен. */
export function hostMcp(value: unknown, home: string, pathEnv: string): { servers: Record<string, McpServer>; skipped: string[] } {
  const servers: Record<string, McpServer> = {};
  const skipped: string[] = [];
  if (typeof value !== 'object' || value === null) return { servers, skipped };
  const expand = (s: unknown): unknown => (typeof s === 'string' && s.startsWith('~/') ? path.join(home, s.slice(2)) : s);
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[\w.-]{1,64}$/.test(name) || name === 'cyborg' || typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const s: McpServer = { ...(raw as McpServer) };
    const stdio = s.type === undefined || s.type === 'stdio';
    if (stdio) {
      if (typeof s.command !== 'string' || !s.command) continue;
      s.command = expand(s.command);
      if (Array.isArray(s.args)) s.args = s.args.map(expand);
      if (!onPath(s.command as string, pathEnv)) {
        skipped.push(`сервер MCP ${name} пропущен: на хосте нет ${s.command as string}`);
        continue;
      }
    }
    servers[name] = s;
  }
  return { servers, skipped };
}
