import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AllowedPaths } from './allowed-paths';
import { shellQuote } from '../shared/shell-quote';
import { CONTROL } from './commands';
import { sessionEnv } from './sessions';
import { terminalLaunch, type IsExec } from './run-terminal';

const HEAD = 256;
const INTERPRETERS: Record<string, string> = { '.sh': 'bash', '.py': 'python3', '.js': 'node', '.mjs': 'node', '.cjs': 'node' };

/** Первая строка `#!`: интерпретатор - абсолютный путь, остаток - один аргумент, как в ядре Linux. */
function parseShebang(head: Buffer, size: number): string[] | null {
  const nl = head.indexOf(0x0a);
  if (nl < 0 && size > head.length) return null;
  let line: string;
  try {
    line = new TextDecoder('utf-8', { fatal: true }).decode(nl < 0 ? head : head.subarray(0, nl));
  } catch {
    return null;
  }
  if (CONTROL.test(line)) return null;
  const rest = line.slice(2).trimStart();
  const space = rest.indexOf(' ');
  const interpreter = space < 0 ? rest : rest.slice(0, space);
  if (!interpreter.startsWith('/')) return null;
  const arg = space < 0 ? '' : rest.slice(space).trim();
  return [interpreter, ...(arg ? [arg] : [])];
}

/** Команда запуска файла (физический путь) либо null: бит исполнения, затем shebang, затем расширение из таблицы. */
export async function runnableOf(real: string): Promise<string[] | null> {
  try {
    const stat = await fs.promises.stat(real);
    if (!stat.isFile() || CONTROL.test(real)) return null;
    try {
      await fs.promises.access(real, fs.constants.X_OK);
      return [real];
    } catch {
      // бита нет: смотрим shebang
    }
    const handle = await fs.promises.open(real, 'r');
    let head: Buffer;
    try {
      const buf = Buffer.alloc(Math.min(stat.size, HEAD));
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      head = buf.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
    if (head.length >= 2 && head[0] === 0x23 && head[1] === 0x21) {
      const shebang = parseShebang(head, stat.size);
      return shebang ? [...shebang, real] : null;
    }
    const interpreter = INTERPRETERS[path.extname(real).toLowerCase()];
    return interpreter ? [interpreter, real] : null;
  } catch {
    return null;
  }
}

export function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** Только для показа: к исполнению эта строка отношения не имеет. */
export function displayCommand(command: string[]): string {
  return command.map(shellQuote).join(' ');
}

/** Окно сообщений главного процесса в той части, что нужна запуску: тест подставляет свой. */
export type Tell = (options: {
  type: 'warning' | 'error';
  message: string;
  detail?: string;
  buttons?: string[];
  defaultId?: number;
  cancelId?: number;
}) => Promise<{ response: number }>;

/** Порт confirm: «Отмена» - кнопка по умолчанию и по Esc, «Запустить» - единственный путь к true. */
export function runConfirm(tell: Tell): (warning: RunWarning) => Promise<boolean> {
  return async (warning) => {
    const { response } = await tell({ type: 'warning', buttons: ['Отмена', 'Запустить'], defaultId: 0, cancelId: 0, ...warningText(warning) });
    return response === 1;
  };
}

/** Обработчик канала file:run: ошибка ответа и исключение показываются окном «Файл не запущен». */
export function runChannel(run: (file: unknown) => Promise<RunReply>, tell: Tell): (file: unknown) => Promise<void> {
  return async (file) => {
    try {
      const reply = await run(file);
      if ('error' in reply) await tell({ type: 'error', message: 'Файл не запущен', detail: reply.error });
    } catch (error) {
      await tell({ type: 'error', message: 'Файл не запущен', detail: (error as Error).message });
    }
  };
}

export interface RunWarning {
  file: string;
  dir: string;
  command: string[];
  changed: boolean;
}

export function warningText(p: RunWarning): { message: string; detail: string } {
  return {
    message: 'Запустить файл в терминале?',
    detail: [
      ...(p.changed ? ['Файл изменён с прошлого одобрения.', ''] : []),
      `Файл: ${p.file}`,
      `Каталог: ${p.dir}`,
      `Команда: ${displayCommand(p.command)}`,
      '',
      'Файл выполнится с правами вашего пользователя и может изменить или удалить ваши данные. Запускайте только файл, которому доверяете.',
    ].join('\n'),
  };
}

export type RunReply = { ok: true } | { cancelled: true } | { error: string };

export interface RunDeps {
  allowed: AllowedPaths;
  approvals: { get(real: string): string | undefined; set(real: string, sha256: string): boolean };
  confirm: (p: RunWarning) => Promise<boolean>;
  launch: (cmd: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<{ error?: string }>;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  isExec?: IsExec;
}

const sameCommand = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** Обработчики каналов file:runnable и file:run: путь, команда, хэш и эмулятор определяются тут, интерфейс присылает только путь. */
export function createRunHandlers(deps: RunDeps) {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const busy = new Set<string>();
  const supported = platform === 'darwin' || platform === 'linux';

  async function run(file: unknown): Promise<RunReply> {
    const real = deps.allowed.realInside(file);
    if (!supported) return { error: 'Запуск в терминале есть на macOS и Linux' };
    if (busy.has(real)) return { cancelled: true };
    busy.add(real);
    try {
      const command = await runnableOf(real);
      if (command === null) return { error: `Файл больше не запускается: ${real}` };
      const dir = path.dirname(real);
      const term = terminalLaunch(platform, env, dir, command, deps.isExec);
      if ('error' in term) return term;
      let h1: string;
      try {
        h1 = await hashFile(real);
      } catch (error) {
        return { error: `Файл не прочитан: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}` };
      }
      const prev = deps.approvals.get(real);
      if (prev !== h1) {
        if (!(await deps.confirm({ file: real, dir, command, changed: prev !== undefined }))) return { cancelled: true };
        let same = false;
        try {
          const real2 = deps.allowed.realInside(file);
          const command2 = await runnableOf(real2);
          const h2 = await hashFile(real2);
          same = real2 === real && command2 !== null && sameCommand(command, command2) && h2 === h1;
        } catch {
          same = false;
        }
        if (!same) return { error: 'Файл изменился, пока вы решали: запуск отменён' };
        deps.approvals.set(real, h1);
      }
      const result = await deps.launch(term.cmd, term.args, { cwd: dir, env: sessionEnv({}) });
      return result.error ? { error: result.error } : { ok: true };
    } finally {
      busy.delete(real);
    }
  }

  return {
    /** Только boolean: команду и хэш интерфейс не получает. */
    async runnable(file: unknown): Promise<boolean> {
      const real = deps.allowed.realInside(file);
      return supported && (await runnableOf(real)) !== null;
    },
    run,
  };
}
