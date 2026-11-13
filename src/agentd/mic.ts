import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export const MIC_SOCK = 'mic.sock';
export const MIC_BIN = 'bin';
const LINE_MAX = 512;

/** Первая строка потока и остаток после неё; null - строки ещё нет. */
export function splitLine(buf: Buffer): { line: string; rest: Buffer } | null {
  const nl = buf.indexOf(10);
  if (nl < 0) return null;
  return { line: buf.subarray(0, nl).toString('utf8'), rest: buf.subarray(nl + 1) };
}

/** Первая строка сокета и данные, пришедшие следом за ней. */
export function readLine(socket: net.Socket, timeoutMs = 10_000): Promise<{ line: string; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => done(new Error('нет ответа')), timeoutMs);
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      const got = splitLine(buf);
      if (got) return done(null, got);
      if (buf.length > LINE_MAX) done(new Error('слишком длинная строка'));
    };
    const onEnd = (): void => done(new Error('соединение закрыто'));
    const done = (error: Error | null, got?: { line: string; rest: Buffer }): void => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('error', onEnd);
      if (error) reject(error);
      else resolve(got!);
    };
    socket.on('data', onData);
    socket.on('end', onEnd);
    socket.on('error', onEnd);
  });
}

/** Сокет микрофона сессии: строка probe|record, ответ ok|no <причина>, после ok на record - сырой PCM из туннеля владельца. */
export function micServer(target: () => { forward: string; sid: string } | string): net.Server {
  return net.createServer((socket) => {
    socket.on('error', () => socket.destroy());
    readLine(socket).then(
      ({ line }) => {
        const to = target();
        if (typeof to === 'string') return void socket.end(`no ${to}\n`);
        if (line === 'probe') return void socket.end('ok\n');
        if (line !== 'record') return void socket.end('no неизвестный запрос\n');
        const up = net.connect(to.forward);
        up.on('error', () => {
          if (!socket.destroyed) socket.end('no туннель микрофона Cyborg оборван\n');
        });
        up.on('connect', () => up.write(JSON.stringify({ sid: to.sid }) + '\n'));
        socket.on('close', () => up.destroy());
        up.pipe(socket);
      },
      () => socket.destroy(),
    );
  });
}

/** Настоящий arecord дальше по PATH, мимо каталога подставного. */
export function realArecord(pathVar: string, own: string): string | null {
  for (const dir of pathVar.split(':')) {
    if (!dir || path.resolve(dir) === path.resolve(own)) continue;
    const file = path.join(dir, 'arecord');
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {
      // нет в этом каталоге
    }
  }
  return null;
}

/** Подставной arecord: Claude Code без звуковой карты пишет /voice через `arecord ... -t raw -q -`; без микрофона Cyborg - настоящий arecord хоста. */
export async function arecord(args: string[], env: NodeJS.ProcessEnv, own: string): Promise<number> {
  if (args.includes('--version')) {
    process.stdout.write('arecord: микрофон Cyborg для удалённой сессии\n');
    return 0;
  }
  const target = args[args.length - 1] ?? '-';
  const probe = target === '/dev/null';
  const refuse = (reason: string): Promise<number> => {
    const real = realArecord(env.PATH ?? '', own);
    if (real) return passThrough(real, args);
    process.stderr.write(`arecord: ${reason}\n`);
    return Promise.resolve(1);
  };
  const sock = env.CYBORG_MIC;
  if (!sock) return refuse('сокет микрофона Cyborg не задан');
  const socket = net.connect(sock);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
  } catch {
    return refuse('демон Cyborg не принимает запись');
  }
  socket.write(probe ? 'probe\n' : 'record\n');
  let head: { line: string; rest: Buffer };
  try {
    // Первый захват на macOS ждёт ответа человека на системный запрос доступа к микрофону.
    head = await readLine(socket, 30_000);
  } catch (error) {
    socket.destroy();
    return refuse(`микрофон Cyborg не ответил: ${(error as Error).message}`);
  }
  if (head.line !== 'ok') {
    socket.destroy();
    return refuse(head.line.replace(/^no /, '') || 'микрофон Cyborg недоступен');
  }
  if (probe) {
    socket.destroy();
    return 0;
  }
  const out = target === '-' ? process.stdout : fs.createWriteStream(target);
  return new Promise((resolve) => {
    const finish = (code: number): void => {
      socket.destroy();
      resolve(code);
    };
    process.once('SIGTERM', () => finish(0));
    process.once('SIGINT', () => finish(0));
    out.on('error', () => finish(0));
    if (head.rest.length) out.write(head.rest);
    socket.pipe(out);
    socket.on('end', () => finish(0));
    socket.on('error', () => finish(1));
  });
}

function passThrough(file: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: 'inherit' });
    const stop = (): void => void child.kill('SIGTERM');
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 0));
  });
}

/** bin/arecord сессии: тот же agentd.js тем же node. */
export function arecordScript(node: string, script: string, quote: (s: string) => string): string {
  return `#!/bin/sh\nexec ${quote(node)} ${quote(script)} arecord "$@"\n`;
}
