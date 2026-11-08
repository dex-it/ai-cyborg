import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** `мажор.минор.ДДММ-хеш`: патч заменяет дата коммита сборки; без коммита - версия из package.json. */
export function formatVersion(version, commit) {
  if (!commit) return version;
  const [major = '0', minor = '0'] = version.split('.');
  const day = String(commit.date.getDate()).padStart(2, '0');
  const month = String(commit.date.getMonth() + 1).padStart(2, '0');
  return `${major}.${minor}.${day}${month}-${commit.hash}`;
}

export function appVersion(root = process.cwd()) {
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  let commit = null;
  try {
    const [hash, seconds] = execFileSync('git', ['log', '-1', '--format=%h %ct'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
      .split(' ');
    if (hash && seconds) commit = { date: new Date(Number(seconds) * 1000), hash };
  } catch {
    // Сборка из архива без .git: версия остаётся из package.json.
  }
  return formatVersion(version, commit);
}
