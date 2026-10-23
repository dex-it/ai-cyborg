import { execFile } from 'node:child_process';
import path from 'node:path';

// Конфиг репозитория из cwd не доверенный: ключи, исполняющие команды, отключаются при каждом вызове.
const SAFE_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...SAFE_CONFIG, '-C', cwd, ...args],
      { maxBuffer: 64 * 1024 * 1024, env: env ? { ...process.env, ...env } : process.env },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

const FILTER_KEY = /^filter\..+\.(clean|process|required)$/;
const REPO_SCOPES = new Set(['local', 'worktree']);

// `git status` гоняет clean-фильтр по файлам с изменившимися stat-данными, а драйвер фильтра задаётся ключами конфига
// репозитория; отключить фильтры одним ключом нельзя, поэтому ключи репозитория и вложенных (их status запускает дочерним
// процессом с тем же окружением) перекрываются через GIT_CONFIG_COUNT: в отличие от -c, имя ключа берётся как есть.
// Фильтры из пользовательского и системного конфига доверенные и остаются.
async function repoFilterKeys(dir: string): Promise<Set<string>> {
  const keys = new Set<string>();
  try {
    const cfg = (await git(dir, ['config', '--show-scope', '--null', '--name-only', '--get-regexp', FILTER_KEY.source])).split('\0');
    for (let i = 0; i + 1 < cfg.length; i += 2) if (REPO_SCOPES.has(cfg[i]) && FILTER_KEY.test(cfg[i + 1])) keys.add(cfg[i + 1]);
  } catch {
    // ключей нет (код 1) либо это не репозиторий
  }
  let subs: string[] = [];
  try {
    const index = (await git(dir, ['ls-files', '--stage', '-z'])).split('\0');
    subs = index.filter((e) => e.startsWith('160000 ')).map((e) => e.slice(e.indexOf('\t') + 1));
  } catch {
    // индекса нет
  }
  for (const nested of await Promise.all(subs.map((sub) => repoFilterKeys(path.join(dir, sub))))) {
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
    out = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], await filterOverrides(root));
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
