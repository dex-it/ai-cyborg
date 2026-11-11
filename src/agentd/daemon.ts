import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { claudeArgs, REMOTE_SYSTEM_PROMPT } from '../main/claude-args.ts';
import { listDir, readTextFile, walkFiles } from '../main/files.ts';
import { gitBranch, gitFiles, gitHeadContent, gitRoot, gitStatus } from '../main/git.ts';
import { gitDiffSearch, gitGrep } from '../main/git-search.ts';
import { validateSearchRequest } from '../main/search-args.ts';
import { SearchRunner } from '../main/search-run.ts';
import type { SearchReply } from '../shared/search-pattern.ts';
import { projectDirName, readJournalFacts } from '../main/history.ts';
import { agentAuthEnv, gitAuthEnv, readAuth } from './git-auth.ts';
import { applyFiles, claudeHome, configHash, hostMcp, installPlugins, pluginsPending, readEnv, readPluginState, trustClone, writeMemory, writePluginState, type ClaudeHome } from './claude-setup.ts';
import { hookSettings, track, type SessionEvent, type Tracked } from '../main/session-state.ts';
import {
  DEFAULT_LIMITS,
  EVENTS_TAIL_BYTES,
  PROTO,
  RING_BYTES,
  shQuote,
  SLEEP_IDLE_MS,
  type Auth,
  type CleanupResult,
  type ConfigMsg,
  type McpServer,
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
  exec(file: string, args: string[], opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }): Promise<ExecResult>;
  /** CLAUDE_CONFIG_DIR демона: по нему claude на хосте ищет настройку. */
  claudeConfigDir?: string;
  /** Сигнал группе процессов с этим pgid. */
  killGroup(pgid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
  /** Группа pgid жива и её лидер запущен с marker в командной строке: pid после перезагрузки мог достаться чужому. */
  groupOwned?(pgid: number, marker: string): boolean;
  now(): number;
  /** Период проверки лимитов. */
  tickMs?: number;
  killGraceMs?: number;
  sleepMs?: number;
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
  /** Только в памяти и в окружении процессов сессии. */
  auth: Auth;
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
  /** Процесс вышел; exited ставится позже, после уборки. */
  gone?: boolean;
  closing?: Promise<CleanupResult>;
  sleeping?: Promise<void>;
  size?: { cols: number; rows: number };
  prepared: boolean;
  /** Только в памяти и в mcp.json 0600: в env серверов MCP пользователя бывают токены. */
  extra: { env: Record<string, string>; mcp: Record<string, McpServer> };
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
  private readonly searches = new SearchRunner();
  private readonly root: string;
  private tick?: NodeJS.Timeout;
  private readonly claude: ClaudeHome;
  /** Установка плагинов зеркала: запуск claude её ждёт, чтобы агент стартовал с настройкой оператора. */
  private setup: Promise<void> = Promise.resolve();
  private setupRuns = 0;
  private stopped = false;

  constructor(private readonly deps: DaemonDeps) {
    this.root = path.join(deps.home, '.cyborg');
    this.claude = claudeHome(deps.home, deps.claudeConfigDir);
    for (const sub of ['sessions', 'work', 'run']) fs.mkdirSync(path.join(this.root, sub), { recursive: true, mode: 0o700 });
    this.tick = setInterval(() => void this.enforceLimits(), deps.tickMs ?? 30_000);
    this.tick.unref();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.tick);
    for (const s of this.sessions.values()) this.teardownIo(s);
  }

  /** Демон выходит, когда нет ни клиентов, ни сессий, кроме спящих: те лежат на диске и поднимутся следующим демоном. */
  idle(): boolean {
    return this.conns.size === 0 && [...this.sessions.values()].every((s) => s.meta.state === 'asleep');
  }

  liveCount(): number {
    return [...this.sessions.values()].filter((s) => !s.exited && s.meta.state !== 'asleep').length;
  }

  /** Сессии с диска после перезапуска демона: живые по записи засыпают, прерванная уборка доделывается, незапущенные убираются. */
  async init(): Promise<void> {
    const base = path.join(this.root, 'sessions');
    for (const sid of fs.readdirSync(base)) {
      let meta: SessionMeta;
      try {
        meta = JSON.parse(fs.readFileSync(path.join(base, sid, 'meta.json'), 'utf8')) as SessionMeta;
      } catch {
        continue;
      }
      if (meta.sid !== sid || this.sessions.has(sid) || (meta.state === 'done' && !meta.ended)) continue;
      meta.round ??= 1;
      meta.roundStartedAt ??= meta.startedAt;
      meta.lastActive ??= meta.startedAt;
      meta.launched ??= meta.port > 0;
      const sess = this.makeSess(meta, '');
      this.sessions.set(sid, sess);
      if (meta.ended) {
        sess.gone = true;
        sess.exited = { code: 1, reason: meta.ended.reason, kept: meta.ended.cleanup.kept };
        continue;
      }
      if (meta.state !== 'asleep' && meta.pgid) this.killStale(meta.pgid, path.join(sess.dir, 'launch.sh'));
      meta.pgid = undefined;
      fs.rmSync(path.join(sess.dir, 'mcp.json'), { force: true });
      if (meta.closing) {
        await this.finishClose(sess, meta.closing);
        continue;
      }
      if (!meta.launched) {
        await this.cleanClones(sess, true);
        this.sessions.delete(sid);
        fs.rmSync(sess.dir, { recursive: true, force: true });
        continue;
      }
      meta.state = 'asleep';
      sess.sleeping = Promise.resolve();
      this.saveMeta(sess);
    }
  }

  private killStale(pgid: number, marker: string): void {
    if (!this.deps.groupOwned?.(pgid, marker)) return;
    this.deps.killGroup(pgid, 'SIGTERM');
    const t = setTimeout(() => {
      if (this.deps.groupOwned?.(pgid, marker)) this.deps.killGroup(pgid, 'SIGKILL');
    }, this.deps.killGraceMs ?? 10_000);
    t.unref();
  }

  private async finishClose(sess: Sess, closing: { keep: boolean; reason?: string }): Promise<void> {
    const cleanup = await this.close(sess, closing.keep, closing.reason);
    if (!closing.reason) return;
    this.settleEnded(sess, { status: 'failed', reason: closing.reason, cleanup });
  }

  /**
   * Итог, выставленный демоном, ждёт ack на диске. Сессия без процесса (до запуска, после перезапуска демона) выхода не даст:
   * close снял её запись, поэтому она возвращается в карту, чтобы attach и ack нашли её, а exit уходит владельцу здесь.
   */
  private settleEnded(sess: Sess, ended: Ended): void {
    sess.meta.ended = ended;
    const idle = !sess.proc;
    if (idle) {
      sess.gone = true;
      sess.exited = { code: 1, reason: ended.reason, kept: ended.cleanup.kept };
      this.sessions.set(sess.sid, sess);
    }
    this.saveMeta(sess);
    if (sess.owner?.open) sess.owner.send({ type: 'ended', sid: sess.sid, ...ended });
    if (idle) this.deliverExit(sess);
  }

  private makeSess(meta: SessionMeta, token: string, owner?: Conn, size?: { cols: number; rows: number }, auth: Auth = { git: [] }): Sess {
    return {
      sid: meta.sid,
      token,
      auth,
      dir: path.join(this.root, 'sessions', meta.sid),
      meta,
      ring: [],
      ringStart: 0,
      ringEnd: 0,
      decoder: new StringDecoder('utf8'),
      emitted: 0,
      evOff: 0,
      tracked: { state: 'starting' },
      lastHookAt: this.deps.now(),
      owner,
      sockets: new Set(),
      size,
      prepared: false,
      extra: { env: {}, mcp: {} },
    };
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
        // sessions - то, что держит демон от замены; спящие переживают замену на диске.
        return reply({ proto: PROTO, version: this.deps.version, sessions: this.awake().length, live: this.liveCount(), config: configHash(this.root), disk: this.space() });
      case 'disk':
        return reply(await this.disk());
      case 'purge':
        return reply({ results: await this.purge(msg.sids, msg.force === true) });
      case 'config':
        return this.configure(msg as unknown as ConfigMsg & Msg, reply);
      case 'list':
        return reply({ sessions: [...this.sessions.values()].map((s) => this.listItem(s, conn)) });
      case 'shutdown':
        if (this.awake().length) return fail('на хосте есть сессии');
        reply({});
        setImmediate(() => this.deps.onShutdown?.());
        return;
      case 'spawn':
        return this.spawn(conn, msg as unknown as SpawnMsg & Msg, reply, fail);
      case 'attach':
        if (!sess) return fail('сессия на хосте не найдена');
        return this.attach(conn, sess, msg, reply, fail);
      case 'wake':
        if (!sess) return fail('сессия на хосте не найдена');
        return this.wake(conn, sess, msg, reply, fail);
      case 'input':
        if (sess?.proc && !sess.gone && sess.meta.state === 'live') {
          sess.proc.write(String(msg.data ?? ''));
          sess.meta.lastActive = this.deps.now();
        }
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
        if (sess.meta.state !== 'live' || sess.exited) return fail('сессия не работает');
        if (sess.meta.reported) return fail('итог этого круга работы уже отправлен: новый круг начнётся со следующего сообщения сессии');
        sess.meta.reported = true;
        this.saveMeta(sess);
        return reply({});
      case 'ack':
        if (sess?.meta.ended) {
          sess.meta.ended = undefined;
          sess.meta.state = 'done';
          this.saveMeta(sess);
          this.reap(sess);
        }
        return;
      case 'fs':
        if (!sess) return fail('сессия на хосте не найдена');
        return reply(await this.fsOp(sess, String(msg.op), String(msg.path ?? '')));
      case 'search':
        if (!sess) return fail('сессия на хосте не найдена');
        return reply(await this.search(sess, msg.mode, msg.request));
      default:
        return fail(`неизвестное сообщение ${msg.type}`);
    }
  }

  private awake(): Sess[] {
    return [...this.sessions.values()].filter((s) => s.meta.state !== 'asleep');
  }

  private listItem(s: Sess, conn: Conn): Record<string, unknown> {
    const base = { sid: s.sid, dirs: s.meta.dirs, origin: s.meta.origin, keep: s.meta.keep, spawnedBy: s.meta.spawnedBy, cwd: s.meta.cwd, clones: s.meta.clones.map((c) => c.path), branch: s.meta.branch, lastActive: s.meta.lastActive };
    if (s.meta.state === 'asleep') return { ...base, asleep: true, title: this.title(s.meta) };
    return {
      ...base,
      token: s.token,
      reported: s.meta.reported,
      round: s.meta.round,
      exited: s.exited !== undefined,
      busy: !!s.owner && s.owner.open && s.owner.instance !== conn.instance,
    };
  }

  /** Заголовок разговора из журнала claude на хосте: им спящая сессия названа в «Истории». */
  private title(meta: SessionMeta): string {
    return readJournalFacts(this.journalOf(meta))?.title || meta.branch;
  }

  private journalOf(meta: SessionMeta): string {
    return path.join(this.claude.configDir, 'projects', projectDirName(meta.cwd), `${meta.sid}.jsonl`);
  }

  private space(): { free: number; total: number } | null {
    try {
      const st = fs.statfsSync(this.root);
      return { free: st.bavail * st.bsize, total: st.blocks * st.bsize };
    } catch {
      return null;
    }
  }

  private readMetaFile(sid: string): SessionMeta | null {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(this.root, 'sessions', sid, 'meta.json'), 'utf8')) as SessionMeta;
      return meta.sid === sid && Array.isArray(meta.clones) ? meta : null;
    } catch {
      return null;
    }
  }

  /** Клоны каталога work/<sid>: у записи без меты (оборванный запуск) - все его подкаталоги. */
  private clonesOf(sid: string, meta: SessionMeta | null): { name: string; path: string }[] {
    if (meta) return meta.clones.filter((c) => fs.existsSync(c.path));
    const work = path.join(this.root, 'work', sid);
    try {
      return fs.readdirSync(work, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => ({ name: d.name, path: path.join(work, d.name) }));
    } catch {
      return [];
    }
  }

  private async du(dir: string): Promise<number | null> {
    const r = await this.deps.exec('du', ['-sk', dir], { timeoutMs: DU_TIMEOUT_MS });
    const kb = Number(r.stdout.trim().split(/\s/)[0]);
    return r.code === 0 && Number.isFinite(kb) ? kb * 1024 : null;
  }

  /** Место на хосте: каталоги work/ с диска, в том числе завершённые с оставленными клонами - демон их в памяти не держит. */
  private async disk(): Promise<Record<string, unknown>> {
    const work = path.join(this.root, 'work');
    const sessions: Record<string, unknown>[] = [];
    let names: string[] = [];
    try {
      names = fs.readdirSync(work).sort();
    } catch {
      // work/ ещё нет: на хосте не было ни одной сессии
    }
    for (const sid of names) {
      if (!SID.test(sid)) continue;
      const sess = this.sessions.get(sid);
      const meta = sess?.meta ?? this.readMetaFile(sid);
      const state = sess ? (sess.meta.state === 'asleep' ? 'asleep' : 'live') : meta ? 'done' : 'orphan';
      const dirty: { path: string; reason: string }[] = [];
      if (state !== 'live') {
        for (const c of this.clonesOf(sid, meta)) {
          const reason = await this.dirtyReason(c.path);
          if (reason) dirty.push({ path: c.path, reason });
        }
      }
      let lastActive = meta?.lastActive ?? 0;
      if (!lastActive) {
        // Каталог мог уйти между readdir и stat (уборка закрытой сессии): строка не нужна, ответ не должен падать.
        const st = fs.statSync(path.join(work, sid), { throwIfNoEntry: false });
        if (!st) continue;
        lastActive = st.mtimeMs;
      }
      sessions.push({ sid, state, title: meta ? this.title(meta) : '', branch: meta?.branch ?? '', dirs: meta?.dirs ?? [], lastActive, bytes: await this.du(path.join(work, sid)), dirty });
    }
    return { ...(this.space() ?? { free: 0, total: 0 }), sessions };
  }

  /** Удаление отмеченного: работающие не трогаются, грязные клоны - только с force. */
  private async purge(sids: unknown, force: boolean): Promise<Record<string, unknown>[]> {
    const results: Record<string, unknown>[] = [];
    for (const sid of new Set(Array.isArray(sids) ? sids.slice(0, 500) : [])) {
      if (typeof sid !== 'string' || !SID.test(sid)) continue;
      const sess = this.sessions.get(sid);
      if (sess && sess.meta.state !== 'asleep') {
        results.push({ sid, removed: [], kept: [], error: 'сессия работает: её закрывают вкладкой' });
        continue;
      }
      if (sess) {
        results.push({ sid, ...(await this.close(sess, false, undefined, force)) });
        continue;
      }
      const meta = this.readMetaFile(sid);
      const clones = this.clonesOf(sid, meta);
      const stub = this.makeSess(meta ?? ({ sid, clones } as SessionMeta), '');
      stub.meta = { ...stub.meta, clones };
      results.push({ sid, ...(await this.cleanClones(stub, force)) });
    }
    return results;
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
    const now = this.deps.now();
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
      startedAt: now,
      reported: false,
      limits,
      state: 'live',
      round: 1,
      roundStartedAt: now,
      lastActive: now,
      launched: false,
    };
    const sess = this.makeSess(meta, msg.token, conn, { cols: msg.cols, rows: msg.rows }, readAuth(msg.auth));
    sess.extra = this.readExtra(msg);
    this.sessions.set(sess.sid, sess);
    this.saveMeta(sess);
    reply({ sid: sess.sid, cwd: meta.cwd, clones: clones.map((c) => c.path) });
    void this.prepareAndStart(sess, msg, clones, selected).catch((e) => this.failStart(sess, String((e as Error)?.message ?? e)));
  }

  /** Зеркало настройки Claude: файлы пишутся до ответа, плагины ставятся в фоне, запуск агента их ждёт. */
  private configure(msg: ConfigMsg & Msg, reply: (m: Record<string, unknown>) => void): void {
    applyFiles(this.root, this.claude, msg);
    const marketplaces = Array.isArray(msg.marketplaces) ? msg.marketplaces : [];
    const plugins = Array.isArray(msg.plugins) ? msg.plugins : [];
    try {
      writePluginState(this.root, { marketplaces, plugins, done: false, notes: [] });
    } catch {
      /* без записи установка идёт по этому config, но не повторится после перезапуска */
    }
    reply({});
    this.installPlugins(readAuth(msg.auth));
  }

  /** Установка по сохранённому составу; итог - на диск: отказ не теряется с демоном и повторяется при следующем запуске. */
  private installPlugins(auth: Auth): void {
    const state = readPluginState(this.root);
    if (!state) return;
    const env = { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes', ...agentAuthEnv(auth) };
    this.setupRuns++;
    this.setup = this.setup
      .then(async () => {
        const notes = await installPlugins(this.deps.exec, state, env).catch((e: Error) => [`плагины Claude не поставлены: ${e.message}`]);
        try {
          writePluginState(this.root, { ...state, done: true, notes });
        } catch {
          /* итог остаётся «не доведено»: следующий запуск повторит */
        }
      })
      .finally(() => void this.setupRuns--);
  }

  private readExtra(msg: Record<string, unknown>): Sess['extra'] {
    const mcp = typeof msg.mcp === 'object' && msg.mcp !== null && !Array.isArray(msg.mcp) ? (msg.mcp as Record<string, McpServer>) : {};
    return { env: readEnv(msg.env, this.deps.home), mcp };
  }

  private progress(sess: Sess, text: string): void {
    this.pushOutput(sess, Buffer.from(`\x1b[2mCyborg: ${text}\x1b[0m\r\n`));
  }

  private async prepareAndStart(sess: Sess, msg: SpawnMsg, clones: { name: string; path: string }[], selected: number): Promise<void> {
    const env = { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes', ...gitAuthEnv(sess.auth) };
    for (let i = 0; i < msg.repos.length; i++) {
      if (sess.closing) return;
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
    try {
      writeMemory(this.claude, cwd, msg.memory);
    } catch (error) {
      this.progress(sess, `память проекта не перенесена: ${(error as Error).message}`);
    }
    await this.launch(sess, { prompt: msg.prompt, resume: false });
  }

  private async wake(conn: Conn, sess: Sess, msg: Msg, reply: (m: Record<string, unknown>) => void, fail: (m: string) => void): Promise<void> {
    await sess.sleeping;
    if (sess.meta.state !== 'asleep' || sess.closing) return fail('сессия не спит');
    const max = DEFAULT_LIMITS.maxPerHost;
    if (this.liveCount() >= max) return fail(`на хосте уже ${this.liveCount()} удалённых сессий (предел ${max})`);
    if (!fs.existsSync(sess.meta.cwd)) return fail('клон рабочего репозитория сессии удалён');
    if (typeof msg.token !== 'string' || !msg.token) return fail('нет токена сессии');
    const now = this.deps.now();
    Object.assign(sess, this.makeSess(sess.meta, msg.token, conn, { cols: Number(msg.cols) || 80, rows: Number(msg.rows) || 24 }, readAuth(msg.auth)));
    sess.extra = this.readExtra(msg);
    sess.sleeping = undefined;
    sess.proc = undefined;
    sess.gone = undefined;
    // Разбуженную ведёт человек (FR-17014): таймеры задачи и простоя к ней больше не применяются, вызвавшая из прошлого сна не ждёт итога.
    Object.assign(sess.meta, { state: 'live', origin: 'human', spawnedBy: undefined, reported: false, round: sess.meta.round + 1, roundStartedAt: now, lastActive: now });
    this.saveMeta(sess);
    reply({ sid: sess.sid, cwd: sess.meta.cwd, clones: sess.meta.clones.map((c) => c.path), round: sess.meta.round });
    void this.launch(sess, { resume: true }).catch((e) => {
      this.progress(sess, String((e as Error)?.message ?? e));
      void this.sleep(sess);
    });
  }

  /** Сон: процесс остановлен, mcp.json с токеном удалён, клоны и журнал разговора остаются для wake. */
  private sleep(sess: Sess): Promise<void> {
    sess.sleeping ??= (async () => {
      sess.meta.state = 'asleep';
      this.saveMeta(sess);
      await this.stopProc(sess);
      this.teardownIo(sess);
      fs.rmSync(path.join(sess.dir, 'mcp.json'), { force: true });
      sess.proc = undefined;
      sess.token = '';
      sess.auth = { git: [] };
      sess.extra = { env: {}, mcp: {} };
      sess.meta.pgid = undefined;
      this.saveMeta(sess);
      if (sess.owner?.open) sess.owner.send({ type: 'slept', sid: sess.sid });
      sess.owner = undefined;
    })();
    return sess.sleeping;
  }

  private async launch(sess: Sess, opts: { prompt?: string; resume: boolean }): Promise<void> {
    const dir = sess.dir;
    const file = (name: string): string => path.join(dir, name);
    const write = (name: string, content: string, mode: number): void => {
      fs.writeFileSync(file(name), content, { mode });
      fs.chmodSync(file(name), mode);
    };
    if (this.setupRuns === 0 && pluginsPending(readPluginState(this.root))) this.installPlugins(sess.auth);
    if (this.setupRuns > 0) {
      this.progress(sess, 'ставятся плагины Claude…');
      await Promise.race([this.setup, new Promise((resolve) => setTimeout(resolve, SETUP_WAIT_MS).unref())]);
    }
    for (const note of readPluginState(this.root)?.notes ?? []) this.progress(sess, note);
    const port = await this.listenProxy(sess);
    if (this.stopped || sess.closing || !this.sessions.has(sess.sid)) {
      this.teardownIo(sess);
      return;
    }
    sess.meta.port = port;
    this.saveMeta(sess);
    write('settings.json', JSON.stringify(hookSettings()), 0o600);
    write('events.jsonl', '', 0o600);
    sess.evOff = 0;
    const user = hostMcp(sess.extra.mcp, this.deps.home, process.env.PATH ?? '');
    for (const note of user.skipped) this.progress(sess, note);
    const cyborg = { type: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${sess.token}` } };
    write('mcp.json', JSON.stringify({ mcpServers: { ...user.servers, cyborg } }), 0o600);
    try {
      trustClone(this.claude, sess.meta.clones.map((c) => c.path));
    } catch (error) {
      this.progress(sess, `каталоги клонов не отмечены доверенными: ${(error as Error).message}`);
    }
    const addDirs = sess.meta.clones.map((c) => c.path).filter((p) => p !== sess.meta.cwd);
    // Номер разговора задаётся при запуске: по нему wake продолжает тот же разговор.
    // В сессию, куда ни разу не писали, claude журнала не завёл: --resume упал бы «No conversation found», разговор начинается заново под тем же номером.
    const args = opts.resume && fs.existsSync(this.journalOf(sess.meta))
      ? claudeArgs(addDirs, undefined, sess.sid, REMOTE_SYSTEM_PROMPT)
      : ['--session-id', sess.sid, ...claudeArgs(addDirs, opts.prompt, undefined, REMOTE_SYSTEM_PROMPT)];
    write(
      'launch.sh',
      `#!/bin/sh\ntty > "$CYBORG_DIR/tty"\nexec claude --settings "$CYBORG_SETTINGS" --mcp-config "$CYBORG_MCP" ${args.map(shQuote).join(' ')}\n`,
      0o700,
    );
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    for (const name of PARENT_SESSION_VARS) delete env[name];
    Object.assign(env, sess.extra.env, {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      CYBORG_DIR: dir,
      CYBORG_EVENTS: file('events.jsonl'),
      CYBORG_SETTINGS: file('settings.json'),
      CYBORG_MCP: file('mcp.json'),
      ...agentAuthEnv(sess.auth),
    });
    this.watchEvents(sess);
    const proc = this.deps.spawn('script', ['-qfec', `exec /bin/sh ${shQuote(file('launch.sh'))}`, '/dev/null'], { cwd: sess.meta.cwd, env });
    sess.proc = proc;
    sess.meta.pgid = proc.pid;
    sess.meta.launched = true;
    this.saveMeta(sess);
    proc.onData((chunk) => {
      this.pushOutput(sess, chunk);
      if (sess.size && !sess.prepared) {
        sess.prepared = true;
        void this.resize(sess, sess.size.cols, sess.size.rows);
      }
    });
    // Прежний процесс, переживший SIGKILL-таймер сна, может выйти уже после wake: его выход не должен снести новую сессию.
    proc.onExit((code) => sess.proc === proc && void this.onExit(sess, code));
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
    const { meta } = sess;
    for (const { line } of items) {
      let event: SessionEvent;
      try {
        event = JSON.parse(line) as SessionEvent;
      } catch {
        continue;
      }
      track(sess.tracked, event);
      const now = this.deps.now();
      sess.lastHookAt = now;
      meta.lastActive = now;
      if (event.hook_event_name === 'UserPromptSubmit' && meta.reported) {
        Object.assign(meta, { reported: false, round: meta.round + 1, roundStartedAt: now });
        if (sess.owner?.open) sess.owner.send({ type: 'round', sid: sess.sid, round: meta.round });
      }
    }
    this.saveMeta(sess, false);
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
    if (sess.meta.state === 'asleep') {
      reply({ sid: sess.sid, cwd: sess.meta.cwd });
      conn.send({ type: 'slept', sid: sess.sid });
      return;
    }
    sess.owner = conn;
    reply({ sid: sess.sid, cwd: sess.meta.cwd, reported: sess.meta.reported, round: sess.meta.round, ...sess.size });
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
    if (sess.exited) {
      conn.send({ type: 'exit', sid: sess.sid, code: sess.exited.code, reason: sess.exited.reason, kept: sess.exited.kept });
      this.reap(sess);
    }
  }

  private sendBacklog(conn: Conn, sess: Sess, evFrom: unknown): void {
    let from = Math.max(this.tailStart(sess), evFrom === 'tail' ? 0 : Math.max(0, Number(evFrom) || 0));
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
    if (sess.exited || sess.gone) return;
    sess.gone = true;
    const rest = sess.decoder.end();
    if (rest) this.pushOutput(sess, Buffer.from(rest));
    this.teardownIo(sess);
    fs.rmSync(path.join(sess.dir, 'mcp.json'), { force: true });
    this.readEvents(sess);
    if (sess.meta.state === 'asleep') return;
    const cleanup = sess.closing ? await sess.closing : sess.meta.keep ? undefined : await this.cleanClones(sess);
    sess.exited = { code, kept: cleanup?.kept };
    this.markDone(sess);
    this.deliverExit(sess);
  }

  /** Завершённая сессия на диске - лишь запись при оставленных клонах: следующий демон её не поднимает. */
  private markDone(sess: Sess): void {
    sess.meta.state = 'done';
    sess.meta.pgid = undefined;
    if (sess.meta.clones.some((c) => fs.existsSync(c.path))) this.saveMeta(sess);
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
    sess.meta.state = 'done';
    if (sess.meta.origin === 'tool') {
      sess.meta.ended = { status: 'failed', reason, cleanup };
      this.saveMeta(sess);
      if (sess.owner?.open) sess.owner.send({ type: 'ended', sid: sess.sid, ...sess.meta.ended });
    }
    this.deliverExit(sess);
  }

  /**
   * Завершение: процесс останавливается, клоны без keep убираются. Повторный вызов ждёт тот же результат.
   * Начатая уборка записана в мету: упавший посреди неё демон доделает её при старте.
   */
  close(sess: Sess, keep: boolean, reason?: string, force = false): Promise<CleanupResult> {
    sess.closing ??= Promise.resolve().then(async () => {
      await sess.sleeping;
      sess.meta.closing = reason ? { keep, reason } : { keep };
      this.saveMeta(sess);
      await this.stopProc(sess);
      this.teardownIo(sess);
      fs.rmSync(path.join(sess.dir, 'mcp.json'), { force: true });
      const result = keep ? { removed: [], kept: sess.meta.clones.filter((c) => fs.existsSync(c.path)).map((c) => ({ path: c.path, reason: 'оставлен по keep' })) } : await this.cleanClones(sess, force);
      sess.meta.closing = undefined;
      // Без процесса (спящая, не дошедшая до запуска) выхода не будет: запись снимается здесь.
      if (!sess.proc) {
        this.markDone(sess);
        this.sessions.delete(sess.sid);
      }
      return result;
    });
    return sess.closing;
  }

  private async stopProc(sess: Sess): Promise<void> {
    const proc = sess.proc;
    if (!proc || sess.exited || sess.gone) return;
    const pid = proc.pid;
    if (!pid) return;
    const gone = new Promise<void>((resolve) => proc.onExit(() => resolve()));
    this.deps.killGroup(pid, 'SIGTERM');
    const timer = new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.deps.killGroup(pid, 'SIGKILL');
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
    const sleepMs = this.deps.sleepMs ?? SLEEP_IDLE_MS;
    for (const sess of [...this.sessions.values()]) {
      const { meta } = sess;
      if (meta.state !== 'live' || sess.exited || sess.gone || sess.closing || sess.sleeping) continue;
      if (sess.proc && sess.tracked.state === 'waiting' && now - meta.lastActive > sleepMs) {
        await this.sleep(sess);
        continue;
      }
      if (meta.origin !== 'tool' || meta.reported) continue;
      const { taskMs, idleMs } = meta.limits;
      let reason: string | null = null;
      if (now - meta.roundStartedAt > taskMs) reason = `превышен таймаут задачи ${fmtDuration(taskMs)}`;
      else if (sess.tracked.state === 'working' && now - sess.lastHookAt > idleMs) reason = `простой ${fmtDuration(idleMs)} без событий в working`;
      if (!reason) continue;
      const cleanup = await this.close(sess, false, reason);
      this.settleEnded(sess, { status: 'failed', reason, cleanup });
    }
  }

  /** create=false - не заводить каталог заново, если уборка его уже сняла. */
  private saveMeta(sess: Sess, create = true): void {
    const file = path.join(sess.dir, 'meta.json');
    if (!create && !fs.existsSync(sess.dir)) return;
    fs.mkdirSync(sess.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(sess.meta), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  }

  /** Настоящий путь внутри каталога сессии: ссылка наружу и «..» отвергаются. */
  private clonePath(sess: Sess, target: string): { real: string } | { error: string } {
    const outside = { error: 'Путь вне каталогов удалённой сессии' };
    if (!path.isAbsolute(target) || target.split('/').includes('..')) return outside;
    let work: string;
    let real: string;
    try {
      work = fs.realpathSync(path.join(this.root, 'work', sess.sid));
      real = fs.realpathSync(target);
    } catch (e) {
      return { error: (e as Error).message };
    }
    return real === work || real.startsWith(work + path.sep) ? { real } : outside;
  }

  /** Поиск по содержимому и изменениям клона теми же командами, что у локальной сессии; новый запрос того же корня отменяет прежний. */
  private async search(sess: Sess, mode: unknown, value: unknown): Promise<Record<string, unknown>> {
    const request = validateSearchRequest(value);
    if ((mode !== 'text' && mode !== 'changes') || !request) return { error: 'Некорректные аргументы поиска' };
    const at = this.clonePath(sess, request.root);
    if ('error' in at) return at;
    const work = { ...request, root: at.real };
    const empty: SearchReply = { hits: [], truncated: false };
    const run = (signal: AbortSignal) => (mode === 'text' ? gitGrep(work, signal) : gitDiffSearch(work, signal));
    return { value: await this.searches.run(`${sess.sid}:${mode}:${at.real}`, run, empty).catch((e: Error): SearchReply => ({ ...empty, error: e.message })) };
  }

  private async fsOp(sess: Sess, op: string, target: string): Promise<Record<string, unknown>> {
    const at = this.clonePath(sess, target);
    if ('error' in at) return at;
    const { real } = at;
    switch (op) {
      case 'files':
        return { value: (await gitFiles(real)) ?? (await walkFiles(real)) };
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

const SID = /^[0-9a-f-]{8,64}$/;
const DU_TIMEOUT_MS = 20_000;

/** Дольше запуск агента установку плагинов не ждёт: агент стартует без недоставленных. */
const SETUP_WAIT_MS = 10 * 60_000;

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
