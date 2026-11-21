import { spawn, type ChildProcess } from 'node:child_process';
import { LOGIN_PATH } from './remote/preflight';

export type EvalFailure = 'exit' | 'empty' | 'nul' | 'overflow' | 'timeout' | 'cancelled' | 'spawn';
export type EvalResult = { ok: true; value: string } | { ok: false; reason: EvalFailure; stderr: string };

export const EVAL_TIMEOUT_MS = 60_000;
export const EVAL_MAX_BYTES = 64 * 1024;
const STDERR_TAIL = 4096;
const KILL_GRACE_MS = 2000;
const LOGIN_PATH_TIMEOUT_MS = 10_000;

export interface EvalOptions {
  env: Record<string, string>;
  home: string;
  path: string;
  signal: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  killGraceMs?: number;
  spawn?: typeof spawn;
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // Группы уже нет (ESRCH) либо чужая: снимать нечего.
  }
}

/** Выражение: /bin/sh -c в своей группе процессов, stdin пуст, cwd - домашний каталог, PATH - логин-оболочки; значение - stdout без одного завершающего перевода строки. */
export function evaluate(command: string, o: EvalOptions): Promise<EvalResult> {
  const timeoutMs = o.timeoutMs ?? EVAL_TIMEOUT_MS;
  const maxBytes = o.maxBytes ?? EVAL_MAX_BYTES;
  const grace = o.killGraceMs ?? KILL_GRACE_MS;
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = (o.spawn ?? spawn)('/bin/sh', ['-c', command], { cwd: o.home, env: { ...o.env, PATH: o.path }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (error) {
      resolve({ ok: false, reason: 'spawn', stderr: (error as Error).message });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = '';
    let verdict: EvalFailure | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = (reason: EvalFailure): void => {
      if (verdict) return;
      verdict = reason;
      killGroup(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => killGroup(child.pid, 'SIGKILL'), grace);
    };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const onAbort = (): void => stop('cancelled');
    if (o.signal.aborted) onAbort();
    else o.signal.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) stop('overflow');
      else chunks.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL);
    });
    // Фоновые остатки группы держат pipe и откладывали бы close: после выхода оболочки группа снимается целиком.
    child.on('exit', () => killGroup(child.pid, 'SIGKILL'));
    let settled = false;
    const finish = (result: EvalResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      o.signal.removeEventListener('abort', onAbort);
      killGroup(child.pid, 'SIGKILL');
      resolve(result);
    };
    child.on('error', (error) => finish({ ok: false, reason: 'spawn', stderr: error.message }));
    child.on('close', (code) => {
      if (verdict) return finish({ ok: false, reason: verdict, stderr });
      if (code !== 0) return finish({ ok: false, reason: 'exit', stderr });
      const out = Buffer.concat(chunks);
      if (out.includes(0)) return finish({ ok: false, reason: 'nul', stderr });
      let text = out.toString('utf8');
      text = text.endsWith('\r\n') ? text.slice(0, -2) : text.endsWith('\n') ? text.slice(0, -1) : text;
      if (!text) return finish({ ok: false, reason: 'empty', stderr });
      finish({ ok: true, value: text });
    });
  });
}

/** PATH логин-оболочки пользователя (nvm, ~/.local/bin): тем же скриптом, что проверка хоста; неудача - унаследованный PATH. */
export async function loginPath(env: Record<string, string>, shell: string, run: typeof spawn = spawn): Promise<string> {
  const fallback = env.PATH ?? '';
  const result = await evaluate(`${LOGIN_PATH}printf %s "$PATH"`, {
    env: { ...env, SHELL: shell },
    home: env.HOME || '/',
    path: fallback,
    signal: new AbortController().signal,
    timeoutMs: LOGIN_PATH_TIMEOUT_MS,
    spawn: run,
  });
  return result.ok ? result.value : fallback;
}
