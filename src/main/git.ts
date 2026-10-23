import { execFile } from 'node:child_process';

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });
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
    out = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
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
