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

const isDir = (p: string) => fs.promises.stat(p).then((s) => s.isDirectory(), () => false);
const exists = (p: string) => fs.promises.stat(p).then(() => true, () => false);

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
  const index = (await git(dir, ['ls-files', '--stage', '-z'])).split('\0');
  const subs = index.filter((e) => e.startsWith('160000 ')).map((e) => path.resolve(dir, e.slice(e.indexOf('\t') + 1)));
  const populated: string[] = [];
  for (const sub of subs) {
    const rel = path.relative(dir, sub);
    // Незаполненный подмодуль git status не открывает, а `git -C` из него нашёл бы родителя и зациклил рекурсию.
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    if ((await isDir(sub)) && (await exists(path.join(sub, '.git')))) populated.push(sub);
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
