import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { claudeArgs, REMOTE_SYSTEM_PROMPT } from '../main/claude-args.ts';
import { listDir, readTextFile } from '../main/files.ts';
import { gitBranch, gitHeadContent, gitRoot, gitStatus } from '../main/git.ts';
import { hookSettings, track, type SessionEvent, type Tracked } from '../main/session-state.ts';
import {
  DEFAULT_LIMITS,
  EVENTS_TAIL_BYTES,
  PROTO,
  RING_BYTES,
  shQuote,
  type CleanupResult,
  type Ended,
  type Msg,
  type SessionMeta,
  type SpawnMsg,
} from './protocol.ts';

export interface PtyProc {
  pid?: number;
  write(data: string): void;
  onData(cb: (chunk: Buffer) => void): void;
  onExit(cb: (code: number) => void): void;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface DaemonDeps {
  home: string;
  version: string;
  spawn(file: string, args: string[], opts: { cwd: string; env: Record<string, string> }): PtyProc;
  exec(file: string, args: string[], opts?: { cwd?: string; env?: Record<string, string> }): Promise<ExecResult>;
  killGroup(proc: PtyProc, signal: 'SIGTERM' | 'SIGKILL'): void;
  now(): number;
  /** Период проверки лимитов. */
  tickMs?: number;
  killGraceMs?: number;
  /** Демон выходит по команде shutdown, когда сессий нет. */
  onShutdown?: () => void;
}

export interface Client {
  send(msg: Msg): void;
}

export interface Connection {
  receive(msg: Msg): void;
  close(): void;
}

interface Sess {
  sid: string;
  /** Только в памяти и в mcp.json 0600: meta.json читают отладка и уборка. */
  token: string;
  dir: string;
  meta: SessionMeta;
  proc?: PtyProc;
  ring: Buffer[];
  ringStart: number;
  ringEnd: number;
  decoder: StringDecoder;
  emitted: number;
  evOff: number;
  watcher?: fs.FSWatcher;
  poll?: NodeJS.Timeout;
  tracked: Tracked;
  lastHookAt: number;
  owner?: Conn;
  server?: net.Server;
  sockets: Set<net.Socket>;
  exited?: { code: number; reason?: string; kept?: CleanupResult['kept'] };
  closing?: Promise<CleanupResult>;
  size?: { cols: number; rows: number };
  prepared: boolean;
}

interface Conn extends Client {
  instance: string;
  fwd?: string;
  open: boolean;
}

const MAX_PROXY_BODY = 1024 * 1024;
const OFFLINE_TEXT = 'Cyborg не на связи (закрыт либо оборван туннель): вызов не выполнен, повтори его позже';

export class Daemon {
  private readonly sessions = new Map<string, Sess>();
  private readonly conns = new Set<Conn>();
  private readonly root: string;
  private tick?: NodeJS.Timeout;
  private stopped = false;

  constructor(private readonly deps: DaemonDeps) {
    this.root = path.join(deps.home, '.cyborg');
    for (const sub of ['sessions', 'work', 'run']) fs.mkdirSync(path.join(this.root, sub), { recursive: true, mode: 0o700 });
    this.tick = setInterval(() => void this.enforceLimits(), deps.tickMs ?? 30_000);
    this.tick.unref();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.tick);
    for (const s of this.sessions.values()) this.teardownIo(s);
  }

  /** Демон выходит, когда нет ни сессий, ни клиентов. */
  idle(): boolean {
    return this.sessions.size === 0 && this.conns.size === 0;
  }

  liveCount(): number {
    return [...this.sessions.values()].filter((s) => !s.exited).length;
  }

  connect(client: Client): Connection {
    const conn: Conn = { send: (m) => client.send(m), instance: '', open: true };
    this.conns.add(conn);
    return {
      receive: (msg) => void this.handle(conn, msg).catch((e) => conn.send({ type: 'error', rid: msg.rid, message: String((e as Error)?.message ?? e).slice(0, 500) })),
      close: () => {
        conn.open = false;
        this.conns.delete(conn);
        for (const s of this.sessions.values()) if (s.owner === conn) s.owner = undefined;
      },
    };
  }

  private async handle(conn: Conn, msg: Msg): Promise<void> {
    const reply = (extra: Record<string, unknown>): void => conn.send({ type: msg.type, rid: msg.rid, ...extra });
    const fail = (message: string): void => conn.send({ type: 'error', rid: msg.rid, message });
    const sess = typeof msg.sid === 'string' ? this.sessions.get(msg.sid) : undefined;
    switch (msg.type) {
      case 'hello':
        conn.instance = typeof msg.instance === 'string' ? msg.instance : '';
        conn.fwd = typeof msg.fwd === 'string' ? msg.fwd : undefined;
        if (conn.fwd) this.dropStaleForwards(conn.fwd);
        return reply({ proto: PROTO, version: this.deps.version, sessions: this.sessions.size, live: this.liveCount() });
      case 'list':
        return reply({
          sessions: [...this.sessions.values()].map((s) => ({
            sid: s.sid,
            token: s.token,
            dirs: s.meta.dirs,
            origin: s.meta.origin,
            keep: s.meta.keep,
            spawnedBy: s.meta.spawnedBy,
            cwd: s.meta.cwd,
            clones: s.meta.clones.map((c) => c.path),
            reported: s.meta.reported,
            exited: s.exited !== undefined,
            busy: !!s.owner && s.owner.open && s.owner.instance !== conn.instance,
          })),
        });
      case 'shutdown':
        if (this.sessions.size) return fail('на хосте есть сессии');
        reply({});
        setImmediate(() => this.deps.onShutdown?.());
        return;
      case 'spawn':
        return this.spawn(conn, msg as unknown as SpawnMsg & Msg, reply, fail);
      case 'attach':
        if (!sess) return fail('сессия на хосте не найдена');
        return this.attach(conn, sess, msg, reply, fail);
      case 'input':
        if (sess?.proc && !sess.exited) sess.proc.write(String(msg.data ?? ''));
        return;
      case 'resize':
        if (sess) await this.resize(sess, Number(msg.cols), Number(msg.rows));
        return;
      case 'close': {
        if (!sess) return fail('сессия на хосте не найдена');
        const result = await this.close(sess, msg.keep === true);
        return reply({ ...result });
      }
      case 'report':
        if (!sess) return fail('сессия на хосте не найдена');
        if (sess.meta.reported) return fail('итог этой сессии уже отправлен');
        sess.meta.reported = true;
        this.saveMeta(sess);
        return reply({});
      case 'ack':
        if (sess?.meta.ended) {
          sess.meta.ended = undefined;
          this.saveMeta(sess);
          this.reap(sess);
        }
        return;
      case 'fs':
        if (!sess) return fail('сессия на хосте не найдена');
        return reply(await this.fsOp(sess, String(msg.op), String(msg.path ?? '')));
      default:
        return fail(`неизвестное сообщение ${msg.type}`);
    }
  }

  private dropStaleForwards(current: string): void {
    const dir = path.join(this.root, 'run');
    const live = new Set([...this.conns].map((c) => c.fwd).filter(Boolean));
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (/^fwd-[0-9a-f]{16}\.sock$/.test(name) && file !== current && !live.has(file)) fs.rmSync(file, { force: true });
    }
  }

  private async spawn(conn: Conn, msg: SpawnMsg & Msg, reply: (m: Record<string, unknown>) => void, fail: (m: string) => void): Promise<void> {
    const limits = { ...DEFAULT_LIMITS, ...msg.limits };
    if (this.liveCount() >= limits.maxPerHost) return fail(`на хосте уже ${this.liveCount()} удалённых сессий (предел ${limits.maxPerHost})`);
    if (!/^[0-9a-f-]{8,64}$/.test(msg.sid) || this.sessions.has(msg.sid)) return fail('некорректный номер сессии');
    const dir = path.join(this.root, 'sessions', msg.sid);
    const work = path.join(this.root, 'work', msg.sid);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(work, { recursive: true, mode: 0o700 });
    const names = uniqueNames(msg.repos.map((r) => r.name));
    const clones = names.map((name) => ({ name, path: path.join(work, name) }));
    const selected = msg.selected;
    const meta: SessionMeta = {
      sid: msg.sid,
      dirs: [msg.repos[selected].local, ...msg.repos.filter((_, i) => i !== selected).map((r) => r.local)],
      origin: msg.origin,
      keep: msg.keep,
      spawnedBy: msg.spawnedBy,
      branch: msg.branch,
      clones,
      cwd: clones[selected].path,
      port: 0,
      startedAt: this.deps.now(),
      reported: false,
      limits,
    };
    const sess: Sess = {
      sid: msg.sid,
      token: msg.token,
      dir,
      meta,
      ring: [],
      ringStart: 0,
      ringEnd: 0,
      decoder: new StringDecoder('utf8'),
      emitted: 0,
      evOff: 0,
      tracked: { state: 'starting' },
      lastHookAt: this.deps.now(),
      owner: conn,
      sockets: new Set(),
      size: { cols: msg.cols, rows: msg.rows },
      prepared: false,
    };
    this.sessions.set(sess.sid, sess);
    this.saveMeta(sess);
    reply({ sid: sess.sid, cwd: meta.cwd, clones: clones.map((c) => c.path) });
    void this.prepareAndStart(sess, msg, clones, selected).catch((e) => this.failStart(sess, String((e as Error)?.message ?? e)));
  }

  private progress(sess: Sess, text: string): void {
    this.pushOutput(sess, Buffer.from(`\x1b[2mCyborg: ${text}\x1b[0m\r\n`));
  }

  private async prepareAndStart(sess: Sess, msg: SpawnMsg, clones: { name: string; path: string }[], selected: number): Promise<void> {
    const env = { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };
    for (let i = 0; i < msg.repos.length; i++) {
      this.progress(sess, `клонирую ${clones[i].name}…`);
      const r = await this.deps.exec('git', ['clone', '--', msg.repos[i].url, clones[i].path], { cwd: path.dirname(clones[i].path), env });
      if (r.code !== 0) throw new Error(`git clone ${clones[i].name}: ${lastLine(r.stderr)}`);
    }
    const cwd = clones[selected].path;
    const heads = await this.deps.exec('git', ['ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${msg.branch}`], { cwd, env });
    if (heads.code !== 0 && heads.code !== 2) throw new Error(`git ls-remote: ${lastLine(heads.stderr)}`);
    const sw = await this.deps.exec('git', heads.code === 0 ? ['switch', msg.branch] : ['switch', '-c', msg.branch], { cwd });
    if (sw.code !== 0) throw new Error(`git switch ${msg.branch}: ${lastLine(sw.stderr)}`);
    if (!this.sessions.has(sess.sid) || sess.closing) return;
    await this.launch(sess, msg, clones, selected);
  }

  private async launch(sess: Sess, msg: SpawnMsg, clones: { name: string; path: string }[], selected: number): Promise<void> {
    const dir = sess.dir;
    const file = (name: string): string => path.join(dir, name);
    const write = (name: string, content: string, mode: number): void => {
      fs.writeFileSync(file(name), content, { mode });
      fs.chmodSync(file(name), mode);
    };
    const port = await this.listenProxy(sess);
    if (this.stopped || sess.closing || !this.sessions.has(sess.sid)) {
      this.teardownIo(sess);
      return;
    }
    sess.meta.port = port;
    this.saveMeta(sess);
    write('settings.json', JSON.stringify(hookSettings()), 0o600);
    write('events.jsonl', '', 0o600);
    write('mcp.json', JSON.stringify({ mcpServers: { cyborg: { type: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${msg.token}` } } } }), 0o600);
    const addDirs = clones.filter((_, i) => i !== selected).map((c) => c.path);
    const args = claudeArgs(addDirs, msg.prompt, undefined, REMOTE_SYSTEM_PROMPT);
    write(
      'launch.sh',
      `#!/bin/sh\ntty > "$CYBORG_DIR/tty"\nexec claude --settings "$CYBORG_SETTINGS" --mcp-config "$CYBORG_MCP" ${args.map(shQuote).join(' ')}\n`,
      0o700,
    );
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    for (const name of PARENT_SESSION_VARS) delete env[name];
    Object.assign(env, {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      CYBORG_DIR: dir,
      CYBORG_EVENTS: file('events.jsonl'),
      CYBORG_SETTINGS: file('settings.json'),
      CYBORG_MCP: file('mcp.json'),
    });
    this.watchEvents(sess);
    const proc = this.deps.spawn('script', ['-qfec', `exec /bin/sh ${shQuote(file('launch.sh'))}`, '/dev/null'], { cwd: clones[selected].path, env });
    sess.proc = proc;
    proc.onData((chunk) => {
      this.pushOutput(sess, chunk);
      if (sess.size && !sess.prepared) {
        sess.prepared = true;
        void this.resize(sess, sess.size.cols, sess.size.rows);
      }
    });
    proc.onExit((code) => void this.onExit(sess, code));
  }

  private listenProxy(sess: Sess): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.proxy(sess, socket));
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        sess.server = server;
        resolve((server.address() as net.AddressInfo).port);
      });
    });
  }

  private proxy(sess: Sess, socket: net.Socket): void {
    sess.sockets.add(socket);
    socket.on('close', () => sess.sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    const fwd = sess.owner?.open ? sess.owner.fwd : undefined;
    if (fwd) {
      const up = net.connect(fwd);
      up.on('error', () => socket.destroy());
      socket.on('close', () => up.destroy());
      socket.pipe(up);
      up.pipe(socket);
      return;
    }
    answerOffline(socket);
  }

  private watchEvents(sess: Sess): void {
    const file = path.join(sess.dir, 'events.jsonl');
    const read = (): void => this.readEvents(sess);
    try {
      sess.watcher = fs.watch(file, read);
    } catch {
      sess.watcher = undefined;
    }
    setImmediate(read);
    sess.poll = setInterval(read, 2000);
    sess.poll.unref();
  }

  private readEvents(sess: Sess): void {
    const items = this.readLines(sess, sess.evOff, true);
    if (!items.length) return;
    for (const { line } of items) {
      try {
        const event = JSON.parse(line) as SessionEvent;
        track(sess.tracked, event);
        sess.lastHookAt = this.deps.now();
      } catch {
        continue;
      }
    }
    if (sess.owner?.open) sess.owner.send({ type: 'events', sid: sess.sid, items, replay: false });
  }

  /** Полные строки events.jsonl с байтового смещения; advance - сдвинуть общий курсор чтения. */
  private readLines(sess: Sess, from: number, advance: boolean): { off: number; line: string }[] {
    const file = path.join(sess.dir, 'events.jsonl');
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return [];
    }
    if (size <= from) return [];
    const buf = Buffer.alloc(size - from);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buf, 0, buf.length, from);
    } finally {
      fs.closeSync(fd);
    }
    const end = buf.lastIndexOf(0x0a);
    if (end < 0) return [];
    if (advance) sess.evOff = from + end + 1;
    const items: { off: number; line: string }[] = [];
    let start = 0;
    while (start <= end) {
      const nl = buf.indexOf(0x0a, start);
      const text = buf.subarray(start, nl).toString('utf8');
      if (text.trim()) items.push({ off: from + start, line: text });
      start = nl + 1;
    }
    return items;
  }

  private pushOutput(sess: Sess, chunk: Buffer): void {
    sess.ring.push(chunk);
    sess.ringEnd += chunk.length;
    while (sess.ringEnd - sess.ringStart > RING_BYTES && sess.ring.length > 1) {
      const dropped = sess.ring.shift() as Buffer;
      sess.ringStart += dropped.length;
    }
    const text = sess.decoder.write(chunk);
    if (!text) return;
    const at = sess.emitted;
    sess.emitted += Buffer.byteLength(text);
    if (sess.owner?.open) sess.owner.send({ type: 'data', sid: sess.sid, at, data: text });
  }

  private attach(conn: Conn, sess: Sess, msg: Msg, reply: (m: Record<string, unknown>) => void, fail: (m: string) => void): void {
    if (sess.owner?.open && sess.owner !== conn && sess.owner.instance !== conn.instance) return fail('сессия открыта другим окном Cyborg');
    if (sess.owner && sess.owner !== conn) sess.owner.open = sess.owner.instance === conn.instance ? false : sess.owner.open;
    sess.owner = conn;
    reply({ sid: sess.sid, cwd: sess.meta.cwd });
    const outFrom = Math.max(0, Number(msg.outFrom) || 0);
    const bytes = Buffer.concat(sess.ring);
    let from = outFrom;
    if (from < sess.ringStart) {
      conn.send({ type: 'reset', sid: sess.sid, at: sess.ringStart });
      from = sess.ringStart;
    }
    const upto = Math.min(sess.emitted, sess.ringEnd);
    let begin = from - sess.ringStart;
    while (begin < upto - sess.ringStart && (bytes[begin] & 0xc0) === 0x80) begin++;
    if (begin < upto - sess.ringStart) conn.send({ type: 'data', sid: sess.sid, at: sess.ringStart + begin, data: bytes.subarray(begin, upto - sess.ringStart).toString('utf8') });
    this.sendBacklog(conn, sess, msg.evFrom);
    // Порядок живого потока: после exit клиент забывает сессию, и ended следом не нашёл бы её.
    if (sess.meta.ended) conn.send({ type: 'ended', sid: sess.sid, ...sess.meta.ended });
    if (sess.exited) conn.send({ type: 'exit', sid: sess.sid, code: sess.exited.code, reason: sess.exited.reason, kept: sess.exited.kept });
  }

  private sendBacklog(conn: Conn, sess: Sess, evFrom: unknown): void {
    let from = evFrom === 'tail' ? this.tailStart(sess) : Math.max(0, Number(evFrom) || 0);
    const file = path.join(sess.dir, 'events.jsonl');
    if (from > 0) {
      try {
        const fd = fs.openSync(file, 'r');
        try {
          const prev = Buffer.alloc(1);
          fs.readSync(fd, prev, 0, 1, from - 1);
          if (prev[0] !== 0x0a) {
            const probe = Buffer.alloc(65536);
            const n = fs.readSync(fd, probe, 0, probe.length, from);
            const nl = probe.subarray(0, n).indexOf(0x0a);
            from = nl < 0 ? from + n : from + nl + 1;
          }
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        return;
      }
    }
    const items = this.readLines(sess, from, false);
    if (items.length) conn.send({ type: 'events', sid: sess.sid, items, replay: true });
  }

  private tailStart(sess: Sess): number {
    try {
      return Math.max(0, fs.statSync(path.join(sess.dir, 'events.jsonl')).size - EVENTS_TAIL_BYTES);
    } catch {
      return 0;
    }
  }

  private async resize(sess: Sess, cols: number, rows: number): Promise<void> {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 1000 || rows > 1000) return;
    sess.size = { cols, rows };
    let tty = '';
    try {
      tty = fs.readFileSync(path.join(sess.dir, 'tty'), 'utf8').trim();
    } catch {
      return;
    }
    if (!/^\/dev\/[A-Za-z0-9/_-]+$/.test(tty)) return;
    await this.deps.exec('stty', ['-F', tty, 'rows', String(rows), 'cols', String(cols)]).catch(() => undefined);
  }

  private async onExit(sess: Sess, code: number): Promise<void> {
    if (sess.exited) return;
    const rest = sess.decoder.end();
    if (rest) this.pushOutput(sess, Buffer.from(rest));
    this.teardownIo(sess);
    fs.rmSync(path.join(sess.dir, 'mcp.json'), { force: true });
    this.readEvents(sess);
    const cleanup = sess.closing ? await sess.closing : sess.meta.keep ? undefined : await this.cleanClones(sess);
    sess.exited = { code, kept: cleanup?.kept };
    this.deliverExit(sess);
  }

  private deliverExit(sess: Sess): void {
    const exited = sess.exited;
    if (exited && sess.owner?.open) {
      sess.owner.send({ type: 'exit', sid: sess.sid, code: exited.code, reason: exited.reason, kept: exited.kept });
      this.reap(sess);
    }
  }

  private reap(sess: Sess): void {
    if (!sess.exited || sess.meta.ended || !sess.owner?.open) return;
    this.sessions.delete(sess.sid);
    this.pruneDir(sess);
  }

  private pruneDir(sess: Sess): void {
    if (sess.meta.clones.some((c) => fs.existsSync(c.path))) return;
    fs.rmSync(sess.dir, { recursive: true, force: true });
    fs.rmSync(path.join(this.root, 'work', sess.sid), { recursive: true, force: true });
  }

  private teardownIo(sess: Sess): void {
    sess.watcher?.close();
    clearInterval(sess.poll);
    sess.server?.close();
    for (const s of sess.sockets) s.destroy();
    sess.server = undefined;
  }

  private async failStart(sess: Sess, reason: string): Promise<void> {
    if (sess.exited) return;
    this.progress(sess, reason);
    const cleanup = await this.cleanClones(sess, true);
    this.teardownIo(sess);
    sess.exited = { code: 1, reason, kept: cleanup.kept };
    if (sess.meta.origin === 'tool') {
      sess.meta.ended = { status: 'failed', reason, cleanup };
      this.saveMeta(sess);
      if (sess.owner?.open) sess.owner.send({ type: 'ended', sid: sess.sid, ...sess.meta.ended });
    }
    this.deliverExit(sess);
  }

  /** Завершение: процесс останавливается, клоны без keep убираются. Повторный вызов ждёт тот же результат. */
  close(sess: Sess, keep: boolean): Promise<CleanupResult> {
    sess.closing ??= Promise.resolve().then(async () => {
      await this.stopProc(sess);
      this.teardownIo(sess);
      fs.rmSync(path.join(sess.dir, 'mcp.json'), { force: true });
      if (keep) return { removed: [], kept: sess.meta.clones.filter((c) => fs.existsSync(c.path)).map((c) => ({ path: c.path, reason: 'оставлен по keep' })) };
      return this.cleanClones(sess);
    });
    return sess.closing;
  }

  private async stopProc(sess: Sess): Promise<void> {
    const proc = sess.proc;
    if (!proc || sess.exited) return;
    const gone = new Promise<void>((resolve) => proc.onExit(() => resolve()));
    this.deps.killGroup(proc, 'SIGTERM');
    const timer = new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.deps.killGroup(proc, 'SIGKILL');
        resolve();
      }, this.deps.killGraceMs ?? 10_000);
      t.unref();
    });
    await Promise.race([gone, timer]);
  }

  private async cleanClones(sess: Sess, force = false): Promise<CleanupResult> {
    const result: CleanupResult = { removed: [], kept: [] };
    for (const clone of sess.meta.clones) {
      if (!fs.existsSync(clone.path)) continue;
      const reason = force ? null : await this.dirtyReason(clone.path);
      if (reason) result.kept.push({ path: clone.path, reason });
      else {
        await fs.promises.rm(clone.path, { recursive: true, force: true });
        result.removed.push(clone.path);
      }
    }
    this.pruneDir(sess);
    return result;
  }

  private async dirtyReason(clone: string): Promise<string | null> {
    const run = (args: string[], cwd = clone): Promise<ExecResult> => this.deps.exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd });
    const trees = await run(['worktree', 'list', '--porcelain']);
    const paths = trees.code === 0 ? trees.stdout.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9)) : [clone];
    for (const tree of paths.length ? paths : [clone]) {
      const status = await run(['status', '--porcelain=v1', '--untracked-files=all'], tree);
      if (status.code !== 0 || status.stdout.trim()) return 'изменения в рабочем дереве';
    }
    const ahead = await run(['rev-list', '--count', '--branches', '--not', '--remotes']);
    if (ahead.code !== 0 || Number(ahead.stdout.trim()) !== 0) return 'незапушенные коммиты';
    const stash = await run(['stash', 'list']);
    if (stash.code !== 0 || stash.stdout.trim()) return 'stash';
    return null;
  }

  private async enforceLimits(): Promise<void> {
    const now = this.deps.now();
    for (const sess of this.sessions.values()) {
      const { meta } = sess;
      if (meta.origin !== 'tool' || meta.reported || sess.exited || sess.closing) continue;
      const { taskMs, idleMs } = meta.limits;
      let reason: string | null = null;
      if (now - meta.startedAt > taskMs) reason = `превышен таймаут задачи ${fmtDuration(taskMs)}`;
      else if (sess.tracked.state === 'working' && now - sess.lastHookAt > idleMs) reason = `простой ${fmtDuration(idleMs)} без событий в working`;
      if (!reason) continue;
      const cleanup = await this.close(sess, false);
      const ended: Ended = { status: 'failed', reason, cleanup };
      meta.ended = ended;
      this.saveMeta(sess);
      if (sess.owner?.open) sess.owner.send({ type: 'ended', sid: sess.sid, ...ended });
    }
  }

  private saveMeta(sess: Sess): void {
    const file = path.join(sess.dir, 'meta.json');
    fs.mkdirSync(sess.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(sess.meta), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  }

  private async fsOp(sess: Sess, op: string, target: string): Promise<Record<string, unknown>> {
    const work = fs.realpathSync(path.join(this.root, 'work', sess.sid));
    if (!path.isAbsolute(target) || target.split('/').includes('..')) return { error: 'Путь вне каталогов удалённой сессии' };
    let real: string;
    try {
      real = fs.realpathSync(target);
    } catch (e) {
      return { error: (e as Error).message };
    }
    if (real !== work && !real.startsWith(work + path.sep)) return { error: 'Путь вне каталогов удалённой сессии' };
    switch (op) {
      case 'list':
        return { value: await listDir(real).catch((e: Error) => ({ error: e.message })) };
      case 'read':
        return { value: await readTextFile(real) };
      case 'root':
        return { value: await gitRoot(real) };
      case 'branch':
        return { value: await gitBranch(real) };
      case 'status':
        return { value: await gitStatus(real) };
      case 'head':
        return { value: await gitHeadContent(real) };
      default:
        return { error: `неизвестная операция ${op}` };
    }
  }
}

const PARENT_SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_EFFORT',
  'CLAUDE_PID',
];

export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return n === 1 ? name : `${name}-${n}`;
  });
}

const lastLine = (text: string): string => text.trim().split('\n').pop()?.slice(0, 300) || 'без пояснения';

function fmtDuration(ms: number): string {
  const min = Math.round(ms / 60_000);
  return min % 60 === 0 && min >= 60 ? `${min / 60} ч` : `${min} мин`;
}

/** Ответ прокси без Cyborg: tools/call - ошибка инструмента, прочее - 503; состояния сессии он не меняет. */
function answerOffline(socket: net.Socket): void {
  let buf = Buffer.alloc(0);
  let answered = false;
  const send = (status: number, body?: unknown): void => {
    if (answered) return;
    answered = true;
    const text = body === undefined ? '' : JSON.stringify(body);
    socket.end(`HTTP/1.1 ${status} ${status === 200 ? 'OK' : 'Error'}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`);
  };
  socket.on('data', (chunk: Buffer) => {
    if (answered) return;
    buf = Buffer.concat([buf, chunk]);
    const headEnd = buf.indexOf('\r\n\r\n');
    if (headEnd < 0) return buf.length > 64 * 1024 ? send(431) : undefined;
    const length = Number(/^content-length:\s*(\d+)/im.exec(buf.subarray(0, headEnd).toString('latin1'))?.[1] ?? 0);
    if (length > MAX_PROXY_BODY) return send(413);
    if (buf.length < headEnd + 4 + length) return;
    let message: { id?: unknown; method?: unknown };
    try {
      message = JSON.parse(buf.subarray(headEnd + 4, headEnd + 4 + length).toString('utf8'));
    } catch {
      return send(400);
    }
    if (message.method === 'tools/call') return send(200, { jsonrpc: '2.0', id: message.id ?? null, result: { content: [{ type: 'text', text: OFFLINE_TEXT }], isError: true } });
    send(503);
  });
}
