import { spawn } from 'node:child_process';

/** Аргументы системного ssh: без оболочки и без запросов (BatchMode), алиас после «--», токена и промпта здесь нет. */
export function sshArgs(alias: string, remoteCommand: string, extra: string[] = []): string[] {
  return [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ExitOnForwardFailure=yes',
    ...extra,
    '--', alias, remoteCommand,
  ];
}

/** Причина отказа ssh по stderr: человек получает совет, а не зависший запуск. */
export function classifySshError(stderr: string): string {
  if (/Permission denied/i.test(stderr)) return 'хост требует пароль либо ключ не принят или зашифрован без ssh-agent: настройте вход по ключу через ssh-agent';
  if (/Host key verification failed/i.test(stderr)) return 'ключ хоста не подтверждён: один раз выполните ssh <алиас> в терминале';
  if (/Could not resolve hostname/i.test(stderr)) return 'алиас не найден в ~/.ssh/config и DNS';
  if (/timed out/i.test(stderr)) return 'хост не ответил за 15 с';
  if (/remote port forwarding failed/i.test(stderr)) return 'sshd хоста запретил переадресацию unix-сокета (AllowStreamLocalForwarding)';
  const last = stderr.trim().split('\n').pop() ?? '';
  return last.slice(0, 300) || 'ssh завершился без пояснения';
}

export interface SshResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Долгоживущий канал: строки JSON в обе стороны, конец - выход ssh. */
export interface SshChannel {
  write(line: string): void;
  onLine(cb: (line: string) => void): void;
  onExit(cb: (code: number | null, stderr: string) => void): void;
  close(): void;
}

/** Шов для тестов: настоящий ssh подставляется в main.ts, тесты дают свой, как spawn у SessionManager. */
export interface SshTransport {
  /** Скрипт идёт в stdin `sh -s`; по пределу процесс убивается. */
  run(alias: string, script: string, timeoutMs?: number): Promise<SshResult>;
  /** Канал: удалённая команда и доп. аргументы (-R туннеля). */
  open(alias: string, remoteCommand: string, extra: string[]): SshChannel;
}

export const RUN_LIMIT_MS = 30_000;
/** Сколько канал ждёт выхода ssh после EOF: открытые соединения туннеля держат клиент, тогда его снимает SIGTERM. */
export const CLOSE_GRACE_MS = 5_000;

const sshEnv = (): NodeJS.ProcessEnv => ({ ...process.env, SSH_ASKPASS_REQUIRE: 'never' });

export const systemSsh: SshTransport = {
  run: (alias, script, timeoutMs = RUN_LIMIT_MS) =>
    new Promise((resolve) => {
      const proc = spawn('ssh', sshArgs(alias, 'sh -s'), { stdio: 'pipe', env: sshEnv() });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(
        () => {
          timedOut = true;
          proc.kill('SIGKILL');
        },
        Math.min(timeoutMs, RUN_LIMIT_MS),
      );
      proc.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
      proc.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
      proc.stdin.on('error', () => undefined);
      proc.on('error', (e) => resolve({ code: 255, stdout, stderr: e.message }));
      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: timedOut ? 255 : (code ?? 255), stdout, stderr: timedOut ? 'Connection timed out' : stderr });
      });
      proc.stdin.end(script);
    }),
  open: (alias, remoteCommand, extra) => {
    const proc = spawn('ssh', sshArgs(alias, remoteCommand, extra), { stdio: 'pipe', env: sshEnv() });
    let stderr = '';
    let buf = '';
    const lines: ((line: string) => void)[] = [];
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        for (const cb of lines) cb(line);
      }
    });
    proc.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString('utf8')).slice(-4000)));
    proc.stdin.on('error', () => undefined);
    return {
      write: (line) => void proc.stdin.write(line + '\n'),
      onLine: (cb) => void lines.push(cb),
      onExit: (cb) => {
        proc.on('error', (e) => cb(255, e.message));
        proc.on('close', (code) => cb(code, stderr));
      },
      close: () => {
        // По SIGTERM клиент OpenSSH выходит, не дочитав stdin: ack, записанный перед закрытием, терялся бы.
        proc.stdin.end();
        const timer = setTimeout(() => proc.kill('SIGTERM'), CLOSE_GRACE_MS);
        timer.unref();
        proc.once('close', () => clearTimeout(timer));
      },
    };
  },
};
