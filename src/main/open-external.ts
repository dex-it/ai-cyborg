import { spawn } from 'node:child_process';
import { childEnv } from './child-env';

interface ChildLike {
  once(event: 'spawn', cb: () => void): unknown;
  once(event: 'error', cb: (error: NodeJS.ErrnoException) => void): unknown;
  unref(): void;
}

export type OpenSpawn = (command: string, args: string[], options: { detached: boolean; stdio: 'ignore'; env: NodeJS.ProcessEnv }) => ChildLike;

export interface OpenDeps {
  platform?: NodeJS.Platform;
  spawn?: OpenSpawn;
  /** Открытие средствами Electron: платформа без xdg-open и open, либо программа не найдена; '' - открыто. */
  fallback: (target: string) => Promise<string>;
}

const OPENER: Partial<Record<NodeJS.Platform, string>> = { linux: 'xdg-open', darwin: 'open' };

/** Адрес или путь открывает системная программа с управляемым окружением (Electron отдал бы ей окружение процесса); '' - открыто, иначе причина отказа. */
export async function openTarget(target: string, deps: OpenDeps): Promise<string> {
  const opener = OPENER[deps.platform ?? process.platform];
  if (!opener) return deps.fallback(target);
  const env = await childEnv();
  const run = deps.spawn ?? (spawn as unknown as OpenSpawn);
  const outcome = await new Promise<string | null>((resolve) => {
    let child: ChildLike;
    try {
      child = run(opener, [target], { detached: true, stdio: 'ignore', env });
    } catch (error) {
      resolve((error as Error).message);
      return;
    }
    child.once('spawn', () => {
      child.unref();
      resolve('');
    });
    child.once('error', (error) => resolve(error.code === 'ENOENT' ? null : error.message));
  });
  return outcome === null ? deps.fallback(target) : outcome;
}
