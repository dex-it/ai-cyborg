import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Daemon, type DaemonDeps, type ExecResult, type PtyProc } from '../src/agentd/daemon';
import type { Msg } from '../src/agentd/protocol';

export const mode = (p: string) => fs.statSync(p).mode & 0o777;
export const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
export const until = async (cond: () => boolean, ms = 2000) => {
  for (let i = 0; i < ms / 10 && !cond(); i++) await tick(10);
  assert.ok(cond(), 'условие не наступило');
};

export interface FakeProc extends PtyProc {
  emit(text: string | Buffer): void;
  exit(code: number): void;
  written: string[];
}

let nextPid = 4242;

export function fakeProc(): FakeProc {
  let data: (c: Buffer) => void = () => {};
  const exits: ((code: number) => void)[] = [];
  return {
    written: [],
    write(d: string) {
      this.written.push(d);
    },
    onData: (cb) => (data = cb),
    onExit: (cb) => void exits.push(cb),
    emit: (t) => data(Buffer.from(t)),
    exit: (code) => exits.forEach((cb) => cb(code)),
    pid: nextPid++,
  };
}

export interface Rig {
  daemon: Daemon;
  home: string;
  spawned: { file: string; args: string[]; cwd: string; env: Record<string, string> }[];
  procs: FakeProc[];
  execs: { file: string; args: string[]; cwd?: string; env?: Record<string, string> }[];
  killed: string[];
  /** Сигналы группам по pgid, по порядку. */
  kills: { pid: number; signal: string }[];
  clock: { now: number };
  /** Ответы git по первой совпавшей подстроке команды. */
  answers: Record<string, Partial<ExecResult>>;
  /** Команда с этой подстрокой ждёт обещания: долгий du или git. */
  hold: Record<string, Promise<void>>;
  /** Вызовов exec одновременно: сейчас и наибольшее. */
  inflight: { now: number; peak: number };
}

/** Стенд; home - каталог прежнего стенда: новый демон на том же диске, как после перезапуска. */
export function rig(t: { after: (fn: () => void) => void }, extra: Partial<DaemonDeps> = {}, home = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-ad-'))): Rig {
  const r: Rig = { home, spawned: [], procs: [], execs: [], killed: [], kills: [], clock: { now: 1_000_000 }, answers: {}, hold: {}, inflight: { now: 0, peak: 0 }, daemon: undefined as unknown as Daemon };
  r.daemon = new Daemon({
    home,
    version: 'v1',
    now: () => r.clock.now,
    spawn: (file, args, opts) => {
      const p = fakeProc();
      r.procs.push(p);
      r.spawned.push({ file, args, ...opts });
      return p;
    },
    exec: async (file, args, opts) => {
      r.execs.push({ file, args, cwd: opts?.cwd, env: opts?.env });
      const line = `${file} ${args.join(' ')}`;
      if (args[0] === 'clone') fs.mkdirSync(args[args.length - 1], { recursive: true });
      const held = Object.keys(r.hold).find((k) => line.includes(k));
      if (held) {
        r.inflight.peak = Math.max(r.inflight.peak, ++r.inflight.now);
        await r.hold[held];
        r.inflight.now--;
      }
      const hit = Object.keys(r.answers).find((k) => line.includes(k));
      return { code: 0, stdout: '', stderr: '', ...(hit ? r.answers[hit] : {}) };
    },
    killGroup: (pid, signal) => {
      r.killed.push(signal);
      r.kills.push({ pid, signal });
      if (signal === 'SIGTERM') r.procs.find((p) => p.pid === pid)?.exit(143);
    },
    killGraceMs: 20,
    ...extra,
  });
  t.after(() => {
    r.daemon.stop();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return r;
}

export function client() {
  const got: Msg[] = [];
  return { got, send: (m: Msg) => void got.push(m), of: (type: string) => got.filter((m) => m.type === type) };
}

