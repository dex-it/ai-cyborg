import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Конфиг репозитория из cwd не доверенный: ключи, исполняющие команды, отключаются при каждом вызове.
const SAFE_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];

function gitRaw(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...SAFE_CONFIG, '-C', cwd, ...args],
      { maxBuffer: 64 * 1024 * 1024, encoding: 'buffer', env: env ? { ...process.env, ...env } : process.env },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return (await gitRaw(cwd, args, env)).toString('utf8');
}

const FILTER_KEY = /^filter\..+\.(clean|process|required)$/;
const REPO_SCOPES = new Set(['local', 'worktree']);
// Глубже git status спустился бы без перекрытия, поэтому превышение предела - ошибка, а не обрезка.
const MAX_DEPTH = 8;

const isDir = (p: fs.PathLike) => fs.promises.stat(p).then((s) => s.isDirectory(), () => false);
const exists = (p: fs.PathLike) => fs.promises.stat(p).then(() => true, () => false);

// `git status` гоняет clean-фильтр по файлам с изменившимися stat-данными, а драйвер фильтра задаётся ключами конфига
// репозитория; отключить фильтры одним ключом нельзя, поэтому ключи репозитория и вложенных (их status запускает дочерним
// процессом с тем же окружением) перекрываются через GIT_CONFIG_COUNT: в отличие от -c, имя ключа берётся как есть.
// Фильтры из пользовательского и системного конфига доверенные и остаются.
// Сбор ключей не должен молча давать неполный набор: любая ошибка, кроме «нет совпадений», уходит наверх.
async function repoFilterKeys(dir: string, depth = 0): Promise<Set<string>> {
  const keys = new Set<string>();
  let raw: Buffer;
  try {
    raw = await gitRaw(dir, ['config', '--show-scope', '--null', '--name-only', '--get-regexp', FILTER_KEY.source], {
      LC_ALL: 'C',
    });
  } catch (e) {
    if ((e as { code?: unknown }).code !== 1) throw e;
    raw = Buffer.alloc(0);
  }
  // LC_ALL=C выше: в UTF-8 локали `.` в ERE git не матчит невалидный UTF-8, и такой ключ не попал бы в вывод.
  // latin1 сохраняет байты один в один; ключ отбирает git, повторная проверка именем в JS расходилась бы с его ERE.
  const cfg = raw.toString('latin1').split('\0');
  for (let i = 0; i + 1 < cfg.length; i += 2) {
    if (!REPO_SCOPES.has(cfg[i])) continue;
    const bytes = Buffer.from(cfg[i + 1], 'latin1');
    if (!Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) throw new Error('ключ фильтра не в UTF-8, перекрыть нельзя');
    keys.add(bytes.toString('utf8'));
  }
  // Путь gitlink может быть не UTF-8: строкой он не представим, поэтому читается байтами и в fs идёт как Buffer.
  const index = (await gitRaw(dir, ['ls-files', '--stage', '-z'])).toString('latin1').split('\0');
  const populated: string[] = [];
  for (const entry of index) {
    if (!entry.startsWith('160000 ')) continue;
    const bytes = Buffer.from(entry.slice(entry.indexOf('\t') + 1), 'latin1');
    const text = bytes.toString('utf8');
    const utf8 = Buffer.from(text, 'utf8').equals(bytes);
    if (utf8) {
      // git не отдаёт компонент `..` и абсолютный путь, но имя `..x` законно: отсекается только выход из dir.
      const rel = path.relative(dir, path.resolve(dir, text));
      if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) continue;
    }
    const sub = Buffer.concat([Buffer.from(dir), Buffer.from(path.sep), bytes]);
    // Незаполненный подмодуль git status не открывает, а `git -C` из него нашёл бы родителя и зациклил рекурсию.
    if (!(await isDir(sub)) || !(await exists(Buffer.concat([sub, Buffer.from(path.sep + '.git')])))) continue;
    if (!utf8) throw new Error('путь вложенного репозитория не в UTF-8, перекрыть его фильтры нельзя');
    populated.push(path.join(dir, text));
  }
  if (populated.length > 0 && depth >= MAX_DEPTH) throw new Error('вложенность репозиториев глубже предела');
  for (const nested of await Promise.all(populated.map((sub) => repoFilterKeys(sub, depth + 1)))) {
    for (const key of nested) keys.add(key);
  }
  return keys;
}

async function filterOverrides(root: string): Promise<NodeJS.ProcessEnv> {
  const base = Number(process.env.GIT_CONFIG_COUNT) || 0;
  const keys = [...(await repoFilterKeys(root))];
  const env: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: String(base + keys.length) };
  keys.forEach((key, i) => {
    env[`GIT_CONFIG_KEY_${base + i}`] = key;
    env[`GIT_CONFIG_VALUE_${base + i}`] = key.endsWith('.required') ? 'false' : '';
  });
  return env;
}

export async function gitRoot(dir: string): Promise<string | null> {
  try {
    return (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    return null;
  }
}

export async function gitBranch(root: string): Promise<string | null> {
  try {
    return (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  } catch {
    return null;
  }
}

/** Путь относительно корня репозитория -> код состояния: M, A, D, R, U либо ? для неотслеживаемого. */
export async function gitStatus(root: string): Promise<Record<string, string>> {
  let out: string;
  try {
    const overrides = await filterOverrides(root);
    out = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], overrides);
  } catch {
    return {};
  }
  const status: Record<string, string> = {};
  const entries = out.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    const index = entry[0];
    const worktree = entry[1];
    const file = entry.slice(3).replace(/\/$/, '');
    // При переименовании и копировании следом идёт исходный путь.
    if (index === 'R' || index === 'C') i++;
    if (index === '?') status[file] = '?';
    else if (index === 'U' || worktree === 'U') status[file] = 'U';
    else status[file] = worktree !== ' ' ? worktree : index;
  }
  return status;
}

const MAX_ORIGINAL_BYTES = 5 * 1024 * 1024;

/** Текст файла в HEAD его репозитория; нет репозитория, файла в HEAD, двоичный или больше предела - null. */
export async function gitHeadContent(file: string): Promise<string | null> {
  const root = await gitRoot(path.dirname(file));
  if (!root) return null;
  const rel = path.relative(root, file).split(path.sep).join('/');
  if (!rel || rel.startsWith('..')) return null;
  try {
    const spec = `HEAD:./${rel}`;
    if (Number(await git(root, ['cat-file', '-s', spec])) > MAX_ORIGINAL_BYTES) return null;
    // cat-file blob отдаёт байты как есть: ни textconv, ни smudge-фильтр репозитория не запускаются.
    const blob = await gitRaw(root, ['cat-file', 'blob', spec]);
    return blob.subarray(0, 8000).includes(0) ? null : blob.toString('utf8');
  } catch {
    return null;
  }
}

/** URL всех fetch-remote репозитория (у частичного клона после `(fetch)` стоит `[blob:none]`); не git или нет remote - пусто. Только читающая команда. */
export async function gitRemotes(root: string): Promise<string[]> {
  try {
    const out = await git(root, ['remote', '-v']);
    return out
      .split('\n')
      .map((line) => /^\S+\s+(\S+)\s+\(fetch\)(?:\s+\[[^\]]*\])?$/.exec(line.trim())?.[1])
      .filter((url): url is string => !!url);
  } catch {
    return [];
  }
}

export interface Branches {
  current: string | null;
  local: string[];
  /** Ветки remote без локальной копии, без имени remote: `git switch` заведёт локальную с отслеживанием. */
  remote: string[];
}

/** Свежие первыми; не git - пустые списки. */
export async function gitBranches(root: string): Promise<Branches> {
  try {
    const [current, out] = await Promise.all([gitBranch(root), git(root, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)', 'refs/heads', 'refs/remotes'])]);
    const local: string[] = [];
    const remote = new Set<string>();
    for (const ref of out.split('\n')) {
      if (ref.startsWith('refs/heads/')) local.push(ref.slice('refs/heads/'.length));
      else {
        const name = /^refs\/remotes\/[^/]+\/(.+)$/.exec(ref)?.[1];
        if (name && name !== 'HEAD') remote.add(name);
      }
    }
    for (const name of local) remote.delete(name);
    return { current: current === 'HEAD' ? null : current, local, remote: [...remote] };
  } catch {
    return { current: null, local: [], remote: [] };
  }
}

// Выписывание файлов запускает smudge-фильтры: их драйверы из недоверенного конфига репозитория не исполняются вовсе.
async function hasRepoFilters(root: string): Promise<boolean> {
  let raw: string;
  try {
    raw = (await gitRaw(root, ['config', '--show-scope', '--null', '--name-only', '--get-regexp', '^filter\\.'], { LC_ALL: 'C' })).toString('latin1');
  } catch (e) {
    if ((e as { code?: unknown }).code !== 1) throw e;
    return false;
  }
  const cfg = raw.split('\0');
  for (let i = 0; i + 1 < cfg.length; i += 2) if (REPO_SCOPES.has(cfg[i])) return true;
  return false;
}

/** Только ветка из gitBranches: имя не уходит в git опцией. Незакоммиченные правки git переносит сам или отказывает. */
export async function gitSwitch(root: string, branch: string): Promise<void> {
  const { local, remote } = await gitBranches(root);
  if (branch.startsWith('-') || (!local.includes(branch) && !remote.includes(branch))) throw new Error(`Ветки ${branch} нет`);
  if (await hasRepoFilters(root)) throw new Error('в конфиге репозитория заданы фильтры filter.*, их git запустил бы при смене ветки: переключите её в терминале');
  try {
    // Подмодули со своим непроверенным конфигом switch не трогает, даже если репозиторий задал submodule.recurse.
    await git(root, ['-c', 'submodule.recurse=false', 'switch', branch]);
  } catch (error) {
    // Первая строка message - сама команда, причина отказа git идёт следом.
    const reason = (error as Error).message.split('\n').slice(1).find((line) => line.trim());
    throw new Error(reason?.replace(/^(error|fatal): /, '') || 'git switch не выполнен');
  }
}
