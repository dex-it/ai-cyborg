import fs from 'node:fs';
import path from 'node:path';
import type * as pty from 'node-pty';
import { createEventsFile, prepareEventsDir } from './events-store.ts';
import { claudeArgs, MCP_SESSION_PROMPT, SESSION_PROMPT } from './claude-args.ts';
import { cleanMessage } from './clean-text.ts';
import { parseSuggestions } from './suggestions.ts';
import { hookSettings, track, waitingReason, type SessionEvent, type SessionState } from './session-state.ts';

export { waitingReason, type SessionEvent, type SessionState };
import { writeJsonAtomic } from './jsonfile.ts';
import { isAlive } from './pid.ts';
import { validateInputArgs, validateResizeArgs, validateSessionId } from './session-args.ts';

type Emit = (channel: string, payload: unknown) => void;
type Spawn = typeof pty.spawn;

/** MCP Cyborg для сессии: конфиг --mcp-config со своим токеном и его отзыв на выходе. */
export interface McpLink {
  connect(id: number): unknown;
  disconnect(id: number): void;
}

// node-pty собран под ABI Electron и в чистом node не грузится: модуль подключается при первом запуске сессии, а тест подставляет свой spawn.
const nodePtySpawn: Spawn = (...args) => require('node-pty').spawn(...args);

/** Порт ввода-вывода сессии: локальный pty либо канал к демону на хосте. */
export interface TermPort {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

/** Удалённая вкладка: хост, кто её открыл и что с итогом. */
export interface RemoteMeta {
  host: string;
  origin: 'tool' | 'human';
  keep: boolean;
  spawnedBy?: number;
  online: boolean;
}

export interface AdoptOptions {
  term: TermPort;
  dirs: string[];
  cwd: string;
  remote: RemoteMeta;
}

interface Session {
  id: number;
  term: TermPort;
  remote?: RemoteMeta;
  eventsFile?: string;
  offset: number;
  cwd: string;
  /** Репозитории запуска: ветками в них управляет сессия. */
  dirs: string[];
  watcher?: fs.FSWatcher;
  /** Отложенное «ждёт» после Stop: любое следующее событие сессии его отменяет. */
  stopTimer?: NodeJS.Timeout;
  /** Интерфейсу отправлены предложенные моделью кнопки, которые ещё не сняты. */
  suggested?: boolean;
  state: SessionState;
  reason?: string;
  lastAnswer?: string;
  /** Сообщения других сессий, ждущие конца хода: в работающую сессию не пишем, Enter мог бы попасть в её запрос разрешения. */
  outbox: string[];
  outboxTimer?: NodeJS.Timeout;
  lastEventAt: number;
  delivering?: boolean;
}

export interface SessionInfo {
  id: number;
  dirs: string[];
  cwd: string;
  state: SessionState;
  reason?: string;
  lastAnswer?: string;
  /** Сообщений в очереди сессии. */
  queued: number;
  /** Только у удалённой вкладки. */
  host?: string;
  link?: 'offline';
}

export type SayResult = 'sent' | 'queued';

/** Пауза между текстом и Enter, как у кнопок команд (command-bar.ts): пакет «текст и Enter» TUI вправе принять за вставку. */
export const SUBMIT_DELAY_MS = 150;

export const sameDirs = (a: string[], b: string[]): boolean => a.length === b.length && [...a].sort().join('\0') === [...b].sort().join('\0');

// Унаследованные маркеры делают сессию дочерней, и CC не пишет её транскрипт.
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

function sessionEnv(extra: Record<string, string>): Record<string, string> {
  const env = { ...(process.env as Record<string, string>) };
  for (const name of PARENT_SESSION_VARS) delete env[name];
  // Каталог вызова лаунчера: в сессии он перебил бы cwd относительного --workspace у запущенного из неё Cyborg.
  delete env.CYBORG_CWD;
  return { ...env, ...extra };
}

export class SessionManager {
  private readonly sessions = new Map<number, Session>();
  private nextId = 1;
  private readonly settingsFile: string;
  private readonly eventsDir: string;
  private readonly emit: Emit;
  private readonly spawn: Spawn;
  private readonly stopDelayMs: number;
  /** Ставится, когда MCP-сервер слушает; сессии до этого стартуют без него. */
  mcp: McpLink | null = null;
  /** Каталог плагина Cyborg со скиллами сессии; подключается ключом --plugin-dir только на время сессии. */
  pluginDir: string | null = null;
  outboxDelayMs = 2000;

  // Чужой Stop-хук может продолжить ход: «ждёт» после Stop объявляется, только если сессия молчит stopDelayMs.
  constructor(userData: string, emit: Emit, spawn: Spawn = nodePtySpawn, stopDelayMs = 30_000) {
    this.emit = emit;
    this.spawn = spawn;
    this.stopDelayMs = stopDelayMs;
    this.eventsDir = path.join(userData, 'sessions');
    prepareEventsDir(this.eventsDir);
    this.removeOrphanedEvents();
    this.settingsFile = path.join(userData, 'claude-hooks.json');
    // Атомарно: соседний инстанс пишет тот же файл, а запускающийся claude не должен прочитать обрезанный.
    writeJsonAtomic(this.settingsFile, hookSettings());
  }

  create(cwd: string, addDirs: string[], prompt?: string, resume?: string): number {
    const id = this.nextId++;
    const eventsFile = path.join(this.eventsDir, `${process.pid}-${id}.jsonl`);
    createEventsFile(eventsFile);
    const shell = process.env.SHELL || '/bin/bash';
    const mcp = this.mcp;
    const pluginDir = this.pluginDir;
    const args = claudeArgs(addDirs, prompt, resume, mcp && pluginDir ? MCP_SESSION_PROMPT : SESSION_PROMPT);
    // Токен в файле 0600, а не в аргументе: командную строку процесса видят все пользователи машины.
    const mcpFile = mcp ? path.join(this.eventsDir, `${process.pid}-${id}.mcp.json`) : undefined;
    if (mcp && mcpFile) createEventsFile(mcpFile, JSON.stringify(mcp.connect(id)));
    // --mcp-config вариадический: за ним в args всегда идёт ключ (claudeArgs начинается с --resume или --append-system-prompt).
    const command = `exec claude --settings "$CYBORG_SETTINGS"${pluginDir ? ' --plugin-dir "$CYBORG_PLUGIN"' : ''}${mcpFile ? ' --mcp-config "$CYBORG_MCP"' : ''} "$@"`;
    // Логин-шелл даёт PATH пользователя: из меню приложений Electron стартует без ~/.local/bin.
    const proc = this.spawn(shell, ['-lc', command, 'cyborg', ...args], {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd,
      env: sessionEnv({
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        CYBORG_EVENTS: eventsFile,
        CYBORG_SETTINGS: this.settingsFile,
        ...(pluginDir ? { CYBORG_PLUGIN: pluginDir } : {}),
        ...(mcpFile ? { CYBORG_MCP: mcpFile } : {}),
      }),
    });
    const session: Session = {
      id,
      term: { write: (data) => proc.write(data), resize: (cols, rows) => proc.resize(cols, rows), kill: () => proc.kill() },
      eventsFile,
      offset: 0,
      cwd,
      dirs: [cwd, ...addDirs],
      state: 'starting',
      outbox: [],
      lastEventAt: Date.now(),
      watcher: fs.watch(eventsFile, () => this.readEvents(session)),
    };
    this.sessions.set(id, session);
    // kqueue (macOS) взводит наблюдателя на следующем витке цикла: запись между spawn и взводом событие не даёт и иначе осталась бы непрочитанной.
    setImmediate(() => this.readEvents(session));
    proc.onData((data) => this.emit('session:data', { id, data }));
    proc.onExit(({ exitCode }) => {
      clearTimeout(session.stopTimer);
      clearTimeout(session.outboxTimer);
      session.watcher?.close();
      fs.rmSync(eventsFile, { force: true });
      if (mcpFile) {
        fs.rmSync(mcpFile, { force: true });
        mcp?.disconnect(id);
      }
      this.sessions.delete(id);
      this.emit('session:exit', { id, exitCode });
    });
    return id;
  }

  /** Работающие сессии: завершившаяся убирается из набора в onExit. */
  count(): number {
    return this.local().length;
  }

  private local(): Session[] {
    return [...this.sessions.values()].filter((s) => !s.remote);
  }

  /** Каталоги и текущие cwd работающих сессий: интерфейсу они доступны, даже если лежат не в репозиториях проекта. */
  liveDirs(): string[] {
    return this.local().flatMap((s) => [...s.dirs, s.cwd]);
  }

  /** Каталоги запуска сессии - её рабочий и подключённые через --add-dir; null - сессии нет. */
  dirsOf(id: number): string[] | null {
    return this.sessions.get(id)?.dirs ?? null;
  }

  /** Работающие сессии проекта вызывающей, она сама тоже: проект сессии - набор её каталогов запуска. null - сессии нет. */
  peers(id: number): SessionInfo[] | null {
    const own = this.sessions.get(id);
    if (!own) return null;
    return [...this.sessions.values()]
      .filter((s) => sameDirs(s.dirs, own.dirs))
      .map(({ id, dirs, cwd, state, reason, lastAnswer, outbox, remote }) => ({
        id,
        dirs,
        cwd,
        state,
        reason,
        lastAnswer,
        queued: outbox.length,
        ...(remote ? { host: remote.host, ...(remote.online ? {} : { link: 'offline' as const }) } : {}),
      }));
  }

  /** Сообщение от другой сессии: ждущей - сразу, работающей - в очередь до конца её хода; на вопросе и при запуске - отказ. */
  async say(id: number, text: string): Promise<SayResult> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`сессия ${id} завершилась`);
    const quiet = Date.now() - session.lastEventAt >= this.outboxDelayMs;
    if (session.state === 'working' || (session.state === 'waiting' && (!quiet || session.outbox.length || session.delivering))) {
      session.outbox.push(text);
      this.scheduleOutbox(session);
      return 'queued';
    }
    if (session.state !== 'waiting') throw new Error(`сессия ${id} ${session.state === 'asking' ? `ждёт человека (${session.reason})` : 'ещё запускается'}`);
    await this.deliver(session, text);
    return 'sent';
  }

  private async deliver(session: Session, text: string): Promise<void> {
    // Перед каждой записью: открытый запрос разрешения принял бы Enter за «Да».
    const write = (data: string): void => {
      if (this.sessions.get(session.id) !== session) throw new Error(`сессия ${session.id} завершилась`);
      if (session.remote && !session.remote.online) throw new Error(`сессия ${session.id} без связи с хостом`);
      if (session.state !== 'waiting') throw new Error(`сессия ${session.id} начала ход: текст вставлен в её ввод, Enter не отправлен`);
      try {
        session.term.write(data);
      } catch {
        throw new Error(`сессия ${session.id} завершилась`);
      }
    };
    session.delivering = true;
    try {
      // Вставкой: перевод строки в тексте TUI мог бы принять за Enter и отправить сообщение по кускам.
      // Чистка у записи: в очередь попадает и текст хоста, минуя validateSend.
      write(`\x1b[200~${cleanMessage(text)}\x1b[201~`);
      await new Promise((resolve) => setTimeout(resolve, SUBMIT_DELAY_MS));
      write('\r');
    } finally {
      session.delivering = false;
      // Хук UserPromptSubmit приходит позже Enter: тишина отсчитывается заново.
      session.lastEventAt = Date.now();
      this.scheduleOutbox(session);
    }
  }

  /** Очередь отдаёт по сообщению, когда сессия ждёт и молчит outboxDelayMs: чужой Stop-хук мог продолжить ход. */
  private scheduleOutbox(session: Session): void {
    clearTimeout(session.outboxTimer);
    if (session.state !== 'waiting' || !session.outbox.length || session.delivering || (session.remote && !session.remote.online)) return;
    session.outboxTimer = setTimeout(
      () => {
        const text = session.outbox.shift();
        if (text !== undefined) this.deliver(session, text).catch(() => {});
      },
      Math.max(0, session.lastEventAt + this.outboxDelayMs - Date.now()),
    );
  }

  uses(dir: string): boolean {
    return this.local().some((s) => s.dirs.includes(dir));
  }

  // Аргументы приходят из интерфейса и не проверены (session-args.ts): мусор молча отбрасывается. Вызов pty в try: процесс мог
  // завершиться между проверкой и вызовом, и ioctl на закрытом дескрипторе бросает, а исключение в обработчике канала - ошибка главного процесса.
  write(id: unknown, data: unknown): void {
    const args = validateInputArgs(id, data);
    if (args) this.guarded(args.id, (t) => t.write(args.data));
  }

  resize(id: unknown, cols: unknown, rows: unknown): void {
    const args = validateResizeArgs(id, cols, rows);
    if (args) this.guarded(args.id, (t) => t.resize(args.cols, args.rows));
  }

  kill(id: unknown): void {
    const valid = validateSessionId(id);
    if (valid !== null) this.guarded(valid, (t) => t.kill());
  }

  private guarded(id: number, action: (term: TermPort) => void): void {
    const proc = this.sessions.get(id)?.term;
    if (!proc) return;
    try {
      action(proc);
    } catch {
      // Процесс уже завершён: onExit уберёт сессию.
    }
  }

  killAll(): void {
    for (const session of this.local()) session.term.kill();
  }

  // Убитый экземпляр не доходит до onExit, и его файлы событий остаются.
  private removeOrphanedEvents(): void {
    for (const name of fs.readdirSync(this.eventsDir)) {
      const pid = Number(/^(\d+)-\d+\.(?:jsonl|mcp\.json)$/.exec(name)?.[1]);
      if (pid && pid !== process.pid && !isAlive(pid)) fs.rmSync(path.join(this.eventsDir, name), { force: true });
    }
  }

  private readEvents(session: Session): void {
    if (!session.eventsFile) return;
    let size: number;
    try {
      size = fs.statSync(session.eventsFile).size;
    } catch {
      return;
    }
    if (size <= session.offset) return;
    const buffer = Buffer.alloc(size - session.offset);
    const fd = fs.openSync(session.eventsFile, 'r');
    try {
      fs.readSync(fd, buffer, 0, buffer.length, session.offset);
    } finally {
      fs.closeSync(fd);
    }
    // Хук может дописывать строку прямо сейчас: читаем только до последнего полного перевода строки.
    const end = buffer.lastIndexOf(0x0a);
    if (end < 0) return;
    session.offset += end + 1;
    this.ingest(session.id, buffer.subarray(0, end).toString('utf8').split('\n'), { replay: false });
  }

  /** Удалённая вкладка: порт - канал к демону; номер выдаёт Cyborg, события и вывод приходят по каналу. */
  adopt(options: AdoptOptions): number {
    const id = this.nextId++;
    this.sessions.set(id, {
      id,
      term: options.term,
      remote: options.remote,
      offset: 0,
      cwd: options.cwd,
      dirs: options.dirs,
      state: 'starting',
      outbox: [],
      lastEventAt: Date.now(),
    });
    return id;
  }

  /** Вывод удалённой сессии: как у локальной, интерфейс разбирает его сам. */
  feed(id: number, data: string): void {
    if (this.sessions.get(id)?.remote) this.emit('session:data', { id, data });
  }

  /** Конец удалённой сессии: вкладка получает session:exit, причина - необязательная строка. */
  finish(id: number, exitCode: number, reason?: string): void {
    const session = this.sessions.get(id);
    if (!session?.remote) return;
    clearTimeout(session.stopTimer);
    clearTimeout(session.outboxTimer);
    this.sessions.delete(id);
    this.emit('session:exit', { id, exitCode, ...(reason ? { reason } : {}) });
  }

  /** Убрать удалённую сессию без session:exit: вкладки интерфейс ещё не создал. */
  discard(id: number): void {
    const session = this.sessions.get(id);
    if (!session?.remote) return;
    clearTimeout(session.stopTimer);
    clearTimeout(session.outboxTimer);
    this.sessions.delete(id);
  }

  setCwd(id: number, cwd: string): void {
    const session = this.sessions.get(id);
    if (session) session.cwd = cwd;
  }

  setLink(id: number, online: boolean): void {
    const session = this.sessions.get(id);
    if (!session?.remote) return;
    session.remote.online = online;
    if (online) this.scheduleOutbox(session);
  }

  remoteOf(id: number): RemoteMeta | null {
    return this.sessions.get(id)?.remote ?? null;
  }

  /** Сообщение в очередь сессии без отказа: уйдёт, когда она будет ждать. false - сессии нет. */
  enqueue(id: number, text: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.outbox.push(text);
    this.scheduleOutbox(session);
    return true;
  }

  /**
   * Строки событий хука: из файла (live) либо с канала хоста. replay - догон после отсутствия:
   * состояние, cwd, ответ и кнопки считаются по всем событиям, уведомление и задержка Stop - только по последнему.
   */
  ingest(id: number, lines: string[], { replay }: { replay: boolean }): void {
    const session = this.sessions.get(id);
    if (!session) return;
    const events: SessionEvent[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        continue;
      }
    }
    events.forEach((event, i) => this.apply(session, event, !replay || i === events.length - 1));
  }

  private apply(session: Session, event: SessionEvent, notify: boolean): void {
    if (event.cwd && event.cwd !== session.cwd) {
      session.cwd = event.cwd;
      this.emit('session:cwd', { id: session.id, cwd: event.cwd });
    }
    if (notify) this.emit('session:activity', { id: session.id, event: event.hook_event_name, tool: event.tool_name });
    session.lastEventAt = Date.now();
    track(session, event);
    this.scheduleOutbox(session);
    if (event.hook_event_name === 'Stop') {
      // Кнопки относятся к последнему ответу: Stop без них снимает прежние (модель проснулась после фоновой задачи и ответила текстом).
      const buttons = parseSuggestions(event.last_assistant_message);
      if (buttons.length || session.suggested) {
        this.emit('session:suggest', { id: session.id, buttons });
        session.suggested = buttons.length > 0;
      }
    } else if (event.hook_event_name === 'UserPromptSubmit') {
      session.suggested = false;
    } else if (
      session.suggested &&
      ((event.hook_event_name === 'PostToolUse' && !event.agent_id) || (event.hook_event_name === 'Notification' && waitingReason(event)))
    ) {
      // Модель снова работает без запроса человека либо стоит на вопросе: кнопка с submit отправила бы Enter в чужой диалог.
      this.emit('session:suggest', { id: session.id, buttons: [] });
      session.suggested = false;
    }
    clearTimeout(session.stopTimer);
    const reason = waitingReason(event);
    if (!reason || !notify) return;
    if (event.hook_event_name === 'Stop') {
      session.stopTimer = setTimeout(() => this.emit('session:waiting', { id: session.id, reason }), this.stopDelayMs);
    } else this.emit('session:waiting', { id: session.id, reason });
  }
}
