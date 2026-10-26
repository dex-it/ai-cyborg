import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './jsonfile';
import { isAlive } from './pid';
import { canonicalRepo, type Project, type ProjectsState } from './projects';
import { validateProjectsState } from './trackers';

// Файл воркспейса - набор проектов {projects, lastProjectId} по любому пути (ADR-0014); прежний userData/projects.json - тоже воркспейс.

export const RECENT_LIMIT = 10;
export const RECENT_FILE = 'recent-workspaces.json';
export const LEGACY_FILE = 'projects.json';
const FRESH_LOCK_MS = 2000;

// ---------- аргументы ----------

export type WorkspaceArg = { kind: 'none' } | { kind: 'file'; file: string } | { kind: 'error'; reason: string };

/** `--workspace <файл>` и `--workspace=<файл>`; относительный путь - от рабочего каталога, значение-флаг не путь. */
export function parseWorkspaceArg(argv: string[], cwd: string): WorkspaceArg {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let value: string | undefined;
    if (arg === '--workspace') value = argv[i + 1];
    else if (arg.startsWith('--workspace=')) value = arg.slice('--workspace='.length);
    else continue;
    if (!value || value.startsWith('--')) return { kind: 'error', reason: '--workspace без пути к файлу' };
    return { kind: 'file', file: path.resolve(cwd, value) };
  }
  return { kind: 'none' };
}

/** Каталог вместо файла воркспейса: причина или null. */
export function directoryProblem(file: string): string | null {
  try {
    return fs.statSync(file).isDirectory() ? `${file} - каталог, а не файл воркспейса` : null;
  } catch {
    return null;
  }
}

// ---------- имена и пути ----------

/** Путь без символьных ссылок; файла нет - ссылки разрешаются у каталога, имя остаётся. */
export function canonicalWorkspace(file: string): string {
  const abs = path.resolve(file);
  try {
    return fs.realpathSync(abs);
  } catch {
    return path.join(canonicalRepo(path.dirname(abs)), path.basename(abs));
  }
}

/** Каталог sessionData воркспейса: ключ по каноническому пути разводит одноимённые файлы разных папок. */
export function sessionDirOf(userData: string, file: string): string {
  const hash = createHash('sha256').update(canonicalWorkspace(file)).digest('hex').slice(0, 16);
  return path.join(userData, 'workspaces', hash);
}

export const legacyFileOf = (userData: string): string => path.join(userData, LEGACY_FILE);

export function isLegacyWorkspace(userData: string, file: string): boolean {
  return canonicalWorkspace(file) === canonicalWorkspace(legacyFileOf(userData));
}

/** Имя воркспейса в заголовке окна: имя файла без `.cyborg.json`, иначе без последнего расширения. */
export function workspaceDisplayName(file: string): string {
  const base = path.basename(file);
  if (base.endsWith('.cyborg.json') && base.length > '.cyborg.json'.length) return base.slice(0, -'.cyborg.json'.length);
  return path.parse(base).name || base;
}

// ---------- замок ----------

export const lockPathOf = (file: string): string => `${file}.lock`;

export type LockState = { busy: false } | { busy: true; pid: number | null };

function readLock(lock: string): { pid: number | null; fresh: boolean } | null {
  let text: string;
  let mtimeMs: number;
  try {
    text = fs.readFileSync(lock, 'utf8').trim();
    mtimeMs = fs.statSync(lock).mtimeMs;
  } catch {
    return null;
  }
  const pid = /^\d+$/.test(text) ? Number(text) : null;
  return { pid, fresh: Date.now() - mtimeMs < FRESH_LOCK_MS };
}

// Свежий файл без pid занят: его создали, но ещё не успели записать pid.
function lockState(lock: string, alive: (pid: number) => boolean): LockState {
  const held = readLock(lock);
  if (!held) return { busy: false };
  if (held.pid !== null) return alive(held.pid) ? { busy: true, pid: held.pid } : { busy: false };
  return held.fresh ? { busy: true, pid: null } : { busy: false };
}

/** Занят ли файл живым инстансом - без захвата. */
export function isWorkspaceBusy(file: string, alive: (pid: number) => boolean = isAlive): LockState {
  return lockState(lockPathOf(file), alive);
}

export type LockResult = { status: 'locked' } | { status: 'busy'; pid: number | null } | { status: 'unlocked' };

// Каталог без записи замка не даёт: воркспейс открывается без него, его save всё равно откажет.
const NO_LOCK_CODES = new Set(['EACCES', 'EROFS', 'ENOENT', 'EPERM', 'ENOTDIR']);

/** Захват замка `<файл>.lock` с pid: 'wx' пропускает ровно один инстанс, замок мёртвого процесса перехватывается. */
export function tryLock(file: string, pid = process.pid, alive: (pid: number) => boolean = isAlive): LockResult {
  const lock = lockPathOf(file);
  const create = (): LockResult | 'exists' => {
    try {
      fs.writeFileSync(lock, String(pid), { flag: 'wx' });
      return { status: 'locked' };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (code === 'EEXIST') return 'exists';
      if (NO_LOCK_CODES.has(code)) return { status: 'unlocked' };
      throw error;
    }
  };
  const first = create();
  if (first !== 'exists') return first;
  const state = lockState(lock, alive);
  if (state.busy) return { status: 'busy', pid: state.pid };
  try {
    fs.unlinkSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { status: 'unlocked' };
  }
  const second = create();
  if (second !== 'exists') return second;
  return { status: 'busy', pid: readLock(lock)?.pid ?? null };
}

/** Удаляет замок, только если в нём свой pid. */
export function releaseLock(file: string, pid = process.pid): void {
  const lock = lockPathOf(file);
  if (readLock(lock)?.pid !== pid) return;
  try {
    fs.unlinkSync(lock);
  } catch {
    // Замок уже убран.
  }
}

// ---------- недавние ----------

export function readRecent(userData: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(userData, RECENT_FILE), 'utf8'));
  } catch {
    return [];
  }
  const list = (parsed as { recent?: unknown } | null)?.recent;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  for (const item of list) if (typeof item === 'string' && path.isAbsolute(item)) seen.add(item);
  return [...seen].slice(0, RECENT_LIMIT);
}

// Список - удобство: ошибка записи открытие не блокирует.
function writeRecent(userData: string, recent: string[]): void {
  try {
    writeJsonAtomic(path.join(userData, RECENT_FILE), { recent });
  } catch {
    // Недоступный userData виден и без этого списка.
  }
}

export function touchRecent(userData: string, file: string): string[] {
  const recent = [file, ...readRecent(userData).filter((p) => p !== file)].slice(0, RECENT_LIMIT);
  writeRecent(userData, recent);
  return recent;
}

export function forgetRecent(userData: string, file: string): string[] {
  const recent = readRecent(userData).filter((p) => p !== file);
  writeRecent(userData, recent);
  return recent;
}

/** Подпись пункта «Недавних»: домашний каталог - «~». */
export function recentLabel(file: string, home: string): string {
  return home && (file === home || file.startsWith(home + path.sep)) ? `~${file.slice(home.length)}` : file;
}

// ---------- выбор воркспейса при старте ----------

export type Startup = { kind: 'workspace'; file: string; legacy: boolean } | { kind: 'first-run' };

export interface StartupDeps {
  recent: string[];
  legacyFile: string;
  isFile(file: string): boolean;
  /** Берёт замок: выбор и захват - одна операция. */
  tryLock(file: string): 'ok' | 'busy';
  isLegacy(file: string): boolean;
}

/** «Недавние» по порядку, пропавший и занятый пропускаются (из списка не удаляются); пустые «Недавние» - прежний projects.json; исчерпано - первый запуск. */
export function resolveStartup(deps: StartupDeps): Startup {
  const candidates = deps.recent.length ? deps.recent : [deps.legacyFile];
  for (const file of candidates) {
    if (!deps.isFile(file)) continue;
    if (deps.tryLock(file) === 'busy') continue;
    return { kind: 'workspace', file, legacy: deps.isLegacy(file) };
  }
  return { kind: 'first-run' };
}

export const isRegularFile = (file: string): boolean => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

// ---------- создание ----------

export interface CreateRequest {
  name: string;
  file: string;
  project: Project;
}

/** Запрос workspace:create: проект проходит ту же проверку, что при сохранении; нужны имя и репозиторий. */
export function validateCreateRequest(raw: unknown): CreateRequest | { error: string } {
  if (typeof raw !== 'object' || raw === null) return { error: 'Некорректный запрос' };
  const { name, file, project } = raw as Partial<CreateRequest>;
  if (typeof name !== 'string' || !name.trim()) return { error: 'Нужно имя воркспейса' };
  if (typeof file !== 'string' || !file.trim()) return { error: 'Нужен файл воркспейса' };
  if (!path.isAbsolute(file)) return { error: 'Нужен полный путь' };
  const valid = validateProjectsState({ projects: [project], lastProjectId: null })?.projects[0];
  if (!valid || typeof valid.id !== 'string' || typeof valid.name !== 'string' || !valid.name.trim()) return { error: 'Нужно название проекта' };
  if (!Array.isArray(valid.repos) || !valid.repos.length || valid.repos.some((r) => typeof r !== 'string' || !path.isAbsolute(r))) {
    return { error: 'Нужен хотя бы один репозиторий с полным путём' };
  }
  return { name: name.trim(), file: path.normalize(file), project: valid };
}

export type CreateResult = { file: string } | { exists: true } | { error: string };

/** Пишет файл с первым проектом; существующий не перезаписывается ('wx' закрывает и гонку между проверкой и записью). */
export function createWorkspaceFile(request: CreateRequest): CreateResult {
  const { file, project } = request;
  try {
    if (!fs.statSync(path.dirname(file)).isDirectory()) return { error: 'Папка не существует' };
  } catch {
    return { error: 'Папка не существует' };
  }
  if (fs.existsSync(file)) return { exists: true };
  const state: ProjectsState = { projects: [project], lastProjectId: project.id };
  try {
    fs.writeFileSync(file, JSON.stringify(state, null, 2), { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { exists: true };
    return { error: `Не удалось записать файл: ${(error as Error).message}` };
  }
  return { file };
}

// ---------- запуск отдельного инстанса ----------

export interface LaunchContext {
  packaged: boolean;
  appPath: string;
  userData: string;
  argv: string[];
  file: string;
}

// Путь приложения нужен только неупакованному запуску (execPath - бинарь Electron); форма `--workspace=` защищает путь с ведущим «-».
export function launchArgs(ctx: LaunchContext): string[] {
  return [
    ...(ctx.packaged ? [] : [ctx.appPath]),
    `--user-data-dir=${ctx.userData}`,
    ...(ctx.argv.includes('--no-sandbox') ? ['--no-sandbox'] : []),
    `--workspace=${ctx.file}`,
  ];
}

interface ChildLike {
  once(event: 'spawn', cb: () => void): unknown;
  once(event: 'error', cb: (error: Error) => void): unknown;
  unref(): void;
}
export type SpawnFn = (command: string, args: string[], options: { detached: boolean; stdio: 'ignore' }) => ChildLike;

/** Независимый процесс, живущий после выхода породившего; сбой запуска - в результате, не исключением. */
export function launchInstance(spawnFn: SpawnFn, execPath: string, args: string[]): Promise<{ error?: string }> {
  return new Promise((resolve) => {
    let child: ChildLike;
    try {
      child = spawnFn(execPath, args, { detached: true, stdio: 'ignore' });
    } catch (error) {
      resolve({ error: (error as Error).message });
      return;
    }
    child.once('spawn', () => {
      child.unref();
      resolve({});
    });
    child.once('error', (error) => resolve({ error: error.message }));
  });
}

// ---------- открытие из меню ----------

export type OpenResult = { ok: true } | { busy: { pid: number | null; lock: string } } | { missing: true } | { error: string };

export interface OpenDeps {
  userData: string;
  hasWorkspace(): boolean;
  /** Инстанс без воркспейса открывает файл в своём окне. */
  openHere(file: string): OpenResult;
  launch(file: string): Promise<{ error?: string }>;
  isFile?(file: string): boolean;
  isAlive?(pid: number): boolean;
}

/** Занятый живым инстансом (в том числе этим) файл не открывается; с воркспейсом - новый процесс, без - это окно. */
export async function openWorkspaceFile(input: string, deps: OpenDeps): Promise<OpenResult> {
  const file = canonicalWorkspace(input);
  if (!(deps.isFile ?? isRegularFile)(file)) return { missing: true };
  const state = isWorkspaceBusy(file, deps.isAlive);
  if (state.busy) return { busy: { pid: state.pid, lock: lockPathOf(file) } };
  if (!deps.hasWorkspace()) return deps.openHere(file);
  const launched = await deps.launch(file);
  if (launched.error !== undefined) return { error: launched.error };
  return { ok: true };
}

/** Клик по «Недавним»: пропавший файл называется ошибкой и убирается из списка. */
export async function openRecentWorkspace(file: string, deps: OpenDeps): Promise<OpenResult> {
  const result = await openWorkspaceFile(file, deps);
  if ('missing' in result) forgetRecent(deps.userData, file);
  return result;
}

export type CreateOutcome = { exists: true } | { error: string } | { opened: OpenResult };

/** Создание из окна: файл пишется сразу, ложится в «Недавние» и открывается. */
export async function createAndOpen(raw: unknown, deps: OpenDeps): Promise<CreateOutcome> {
  const request = validateCreateRequest(raw);
  if ('error' in request) return request;
  const created = createWorkspaceFile(request);
  if ('error' in created || 'exists' in created) return created;
  touchRecent(deps.userData, canonicalWorkspace(created.file));
  return { opened: await openWorkspaceFile(created.file, deps) };
}
