import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Daemon, type PtyProc } from './daemon.ts';
import type { Msg } from './protocol.ts';

const IDLE_EXIT_MS = 10 * 60_000;
const home = os.homedir();
const run = path.join(home, '.cyborg', 'run');
const sock = path.join(run, 'agentd.sock');
const lock = path.join(run, 'agentd.lock');

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Замок демона: один на пользователя; замок мёртвого pid снимается. */
function takeLock(): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
      return true;
    } catch {
      const pid = Number(fs.readFileSync(lock, 'utf8'));
      if (pid && alive(pid)) return false;
      fs.rmSync(lock, { force: true });
    }
  }
  return false;
}

function quit(): void {
  fs.rmSync(sock, { force: true });
  fs.rmSync(lock, { force: true });
  process.exit(0);
}

function serve(): void {
  fs.mkdirSync(run, { recursive: true, mode: 0o700 });
  if (!takeLock()) return;
  fs.rmSync(sock, { force: true });
  const daemon = new Daemon({
    home,
    version: path.basename(path.dirname(process.argv[1])),
    now: () => Date.now(),
    spawn: (file, args, opts): PtyProc => {
      const child = spawn(file, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
      child.stdin.on('error', () => undefined);
      return {
        pid: child.pid,
        write: (data) => void child.stdin.write(data),
        onData: (cb) => void child.stdout.on('data', cb),
        onExit: (cb) => void child.on('close', (code) => cb(code ?? 1)),
      };
    },
    exec: (file, args, opts) =>
      new Promise((resolve) => {
        execFile(file, args, { cwd: opts?.cwd, env: { ...process.env, ...opts?.env }, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
          const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : 1) : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr || (error ? error.message : '')) });
        });
      }),
    onShutdown: () => quit(),
    killGroup: (proc, signal) => {
      try {
        if (proc.pid) process.kill(-proc.pid, signal);
      } catch {
        // группа уже завершена
      }
    },
  });
  const server = net.createServer((socket) => {
    const conn = daemon.connect({ send: (msg) => void socket.write(JSON.stringify(msg) + '\n') });
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          conn.receive(JSON.parse(line) as Msg);
        } catch {
          // строка не JSON: пропускается
        }
      }
    });
    socket.on('close', () => conn.close());
    socket.on('error', () => socket.destroy());
  });
  server.listen(sock, () => fs.chmodSync(sock, 0o600));
  let idleSince = Date.now();
  setInterval(() => {
    if (!daemon.idle()) idleSince = Date.now();
    else if (Date.now() - idleSince > IDLE_EXIT_MS) quit();
  }, 30_000);
  process.on('SIGTERM', quit);
}

function dial(): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    const socket = net.connect(sock);
    socket.once('connect', () => resolve(socket));
    socket.once('error', () => resolve(null));
  });
}

async function connect(): Promise<void> {
  let socket = await dial();
  if (!socket) {
    fs.mkdirSync(run, { recursive: true, mode: 0o700 });
    spawn(process.execPath, [process.argv[1], 'serve'], { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 50 && !socket; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      socket = await dial();
    }
  }
  if (!socket) {
    process.stderr.write('агент Cyborg на хосте не запустился\n');
    process.exit(1);
  }
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  socket.on('close', () => process.exit(0));
  process.stdin.on('end', () => socket.end());
}

if (process.argv[2] === 'serve') serve();
else if (process.argv[2] === 'connect') void connect();
