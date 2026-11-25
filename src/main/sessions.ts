import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type * as pty from 'node-pty';
import { createEventsFile, prepareEventsDir } from './events-store.ts';
import { claudeArgs, MCP_CHILD_PROMPT, MCP_SESSION_PROMPT, modelArgs, SESSION_PROMPT, type ModelChoice } from './claude-args.ts';
import { childEnvNow, envStampNow, loginShell, staleNames, type EnvStamp } from './child-env.ts';
import { cleanMessage } from './clean-text.ts';
import { parseSuggestions } from './suggestions.ts';
import { childExitText, REPORT_ACCEPTED, REPORTED_ERROR, reportNote, reportText } from './report-text.ts';
import { clipPrompt, hookSettings, isToolEnd, isToolEvent, notePrompt, track, waitingReason, type SessionContext, type SessionEvent, type SessionState } from './session-state.ts';
import { readJournalFacts } from './history.ts';

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
  project: string;
  term: TermPort;
  dirs: string[];
  cwd: string;
  remote: RemoteMeta;
  /** Окружение сессии при запуске: по нему видно, что управляемые переменные с тех пор менялись. */
  envStamp?: EnvStamp;
}

interface Session {
  id: number;
  /** id проекта воркспейса: соседей задаёт он, а не каталоги запуска - правка репозиториев проекта сессий не разделяет. */
  project: string;
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
  background?: boolean;
  context: SessionContext;
  /** Задача, объявленная самой сессией через set_task. */
  declared?: { ref?: string; summary: string };
  /** Сообщения других сессий, ждущие, когда сессия примет ввод: Enter, пока идёт вызов инструмента, мог бы попасть в его запрос разрешения. */
  outbox: string[];
  outboxTimer?: NodeJS.Timeout;
  lastEventAt: number;
  delivering?: boolean;
  /** Сообщение вставлено, а Enter ждёт конца вызова инструмента, начатого между вставкой и Enter. */
  submitPending?: boolean;
  /** Вызовы инструментов от PreToolUse до Post*: tool_use_id -> agent_id ('' - главная модель). */
  inFlight: Map<string, string>;
  /** Открыта другой сессией (open_session, spawn_agent); у локальной разговоры уходят в onChild. */
  parent?: number;
  childSid?: string;
  /** Итог этого круга работы сдан report_done; круг открывает следующий UserPromptSubmit. */
  reported?: boolean;
  exitCode?: number;
  /** Вкладку закрыли: после выхода процесса запись не нужна. */
  released?: boolean;
  /** Сессия, закрывшая вкладку close_session; у закрытой человеком нет. */
  closedBy?: number;
  /** Гасится вместе со всеми (killAll). */
  ending?: boolean;
  /** Номер разговора Claude Code из событий: по нему сессия продолжается с --resume. */
  claudeSid?: string;
  envStamp?: EnvStamp;
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
  /** Сессия, открывшая эту инструментом. */
  parent?: number;
  /** Только у завершённой (state exited). */
  exitCode?: number;
  /** Номер задачи и что делает - со слов самой сессии (set_task). */
  ref?: string;
  summary?: string;
  /** Название разговора, первый и последний запрос - чем сессия занята. */
  title?: string;
  task?: string;
  lastPrompt?: string;
}

/** sent-working - отправлено в работающую сессию: Claude Code передаст его модели после текущего вызова инструмента. */
export type SayResult = 'sent' | 'sent-working' | 'queued';

/** Пауза между текстом и Enter, как у кнопок команд (command-bar.ts): пакет «текст и Enter» TUI вправе принять за вставку. */
export const SUBMIT_DELAY_MS = 150;

const TERMINATE_WAIT_MS = 5000;

export const SETTINGS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const EXITED_TERM: TermPort = { write: () => {}, resize: () => {}, kill: () => {} };

export const sameDirs = (a: string[], b: string[]): boolean => a.length === b.length && [...a].sort().join('\0') === [...b].sort().join('\0');

// Унаследованные маркеры делают сессию дочерней, и CC не пишет её транскрипт.
export const PARENT_SESSION_VARS = [
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

/**
 * Переменные, которые Cyborg, запущенный из сессии, унаследовал бы от неё: CYBORG_CWD перебил бы cwd относительного
 * --workspace, MCP-конфиг родителя с его токеном и его плагин не должны уходить тому, у кого их нет.
 */
export const INHERITED_SESSION_VARS = [...PARENT_SESSION_VARS, 'CYBORG_CWD', 'CYBORG_MCP', 'CYBORG_PLUGIN'];

/** Окружение сессии и других процессов Cyborg: унаследованное, управляемое, поверх - свои значения; метки родительской сессии снимаются у всех. */
export function sessionEnv(extra: Record<string, string>): Record<string, string> {
  return childEnvNow({ unset: INHERITED_SESSION_VARS, set: extra });
}

// Внешний вызов не спрашивает человека, а вызовы внутри него дают свои PreToolUse: держать очередь на всё время REPL или субагента незачем.
const CONTAINER_TOOLS = new Set(['REPL', 'Poll', 'Agent', 'Task']);

// Диалог появляется только внутри вызова, после его PreToolUse; у удалённой события идут по ssh с задержкой - ей пишем только после хода.
const acceptsInput = (session: Session): boolean =>
  session.state === 'waiting' ||
  (session.state === 'working' && (session.remote ? session.background === true : session.inFlight.size === 0));

// Отказ и Esc не дают Post*: зависший вызов снимает Stop; UserPromptSubmit шлют и фоновые задачи.
function noteCall(inFlight: Map<string, string>, event: SessionEvent): void {
  const name = event.hook_event_name;
  const agent = event.agent_id ?? '';
  const key = event.tool_use_id ?? `?${agent}`;
  if (name === 'PreToolUse') {
    if (!CONTAINER_TOOLS.has(event.tool_name ?? '')) inFlight.set(key, agent);
  } else if (isToolEnd(name)) inFlight.delete(key);
  else if (name === 'SubagentStop' || name === 'Stop') {
    // Stop без фоновых задач: не работает ни один субагент.
    const all = name === 'Stop' && !event.background_tasks?.length;
    const owner = name === 'SubagentStop' ? agent : '';
    for (const [id, of] of inFlight) if (all || of === owner) inFlight.delete(id);
  }
}

export class SessionManager {
  private readonly sessions = new Map<number, Session>();
  private nextId = 1;
  private readonly settingsFile: string;
  private readonly settings = hookSettings();
  private readonly eventsDir: string;
  private readonly emit: Emit;
  private readonly spawn: Spawn;
  private readonly stopDelayMs: number;
  /** Ставится, когда MCP-сервер слушает; сессии до этого стартуют без него. */
  mcp: McpLink | null = null;
  /** Включённые встроенные плагины: каталоги идут ключами --plugin-dir только на время сессии; core - включено ядро. */
  plugins: () => { dirs: string[]; core: boolean } = () => ({ dirs: [], core: false });
  /** dist/agentd.js: им хук MessageDisplay прячет комментарий кнопок; нет файла - комментарий виден. */
  agentd: string | null = null;
  outboxDelayMs = 2000;
  /** Номер разговора дочерней сессии: приходит с первым событием хука и после /clear. */
  onChild: ((sid: string) => void) | null = null;

  // Чужой Stop-хук может продолжить ход: «ждёт» после Stop объявляется, только если сессия молчит stopDelayMs.
  constructor(userData: string, emit: Emit, spawn: Spawn = nodePtySpawn, stopDelayMs = 30_000) {
    this.emit = emit;
    this.spawn = spawn;
    this.stopDelayMs = stopDelayMs;
    this.eventsDir = path.join(userData, 'sessions');
    prepareEventsDir(this.eventsDir);
    this.removeOrphanedEvents();
    // Экземпляр другой версии с тем же userData не подменит сессиям набор хуков.
    this.settingsFile = path.join(userData, `claude-hooks-${createHash('sha256').update(JSON.stringify(this.settings)).digest('hex').slice(0, 12)}.json`);
    this.writeSettings();
    this.removeStaleSettings(userData);
  }

  // Атомарно: соседний инстанс пишет тот же файл, а запускающийся claude не должен прочитать обрезанный.
  private writeSettings(): void {
    writeJsonAtomic(this.settingsFile, this.settings);
  }

  // Свой файл живой экземпляр освежает перед каждой сессией: давно не тронутый - ничей.
  private removeStaleSettings(userData: string): void {
    const stale = Date.now() - SETTINGS_TTL_MS;
    for (const name of fs.readdirSync(userData)) {
      const file = path.join(userData, name);
      if (file === this.settingsFile || !/^claude-hooks-[0-9a-f]{12}\.json$/.test(name)) continue;
      try {
        if (fs.statSync(file).mtimeMs < stale) fs.rmSync(file, { force: true });
      } catch {
        // Файл убрал соседний экземпляр.
      }
    }
  }

  create(project: string, cwd: string, addDirs: string[], prompt?: string, resume?: string, parent?: number, choice?: ModelChoice): number {
    this.checkParent(project, parent);
    this.writeSettings();
    const id = this.nextId++;
    const eventsFile = path.join(this.eventsDir, `${process.pid}-${id}.jsonl`);
    createEventsFile(eventsFile);
    const env = sessionEnv({
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      CYBORG_EVENTS: eventsFile,
      CYBORG_SETTINGS: this.settingsFile,
      ...(this.agentd ? { CYBORG_NODE: process.execPath, CYBORG_AGENTD: this.agentd } : {}),
    });
    const shell = loginShell('/bin/bash');
    const mcp = this.mcp;
    const plugins = this.plugins();
    const args = [...plugins.dirs.flatMap((dir) => ['--plugin-dir', dir]), ...modelArgs(choice), ...claudeArgs(addDirs, prompt, resume, mcp && plugins.core ? (parent === undefined ? MCP_SESSION_PROMPT : MCP_CHILD_PROMPT) : SESSION_PROMPT)];
    // Токен в файле 0600, а не в аргументе: командную строку процесса видят все пользователи машины.
    const mcpFile = mcp ? path.join(this.eventsDir, `${process.pid}-${id}.mcp.json`) : undefined;
    if (mcp && mcpFile) createEventsFile(mcpFile, JSON.stringify(mcp.connect(id)));
    // --mcp-config вариадический: за ним в args всегда идёт ключ (--plugin-dir, --model, --effort, --resume или --append-system-prompt).
    const command = `exec claude --settings "$CYBORG_SETTINGS"${mcpFile ? ' --mcp-config "$CYBORG_MCP"' : ''} "$@"`;
    // Логин-шелл даёт PATH пользователя: из меню приложений Electron стартует без ~/.local/bin.
    const proc = this.spawn(shell, ['-lc', command, 'cyborg', ...args], {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd,
      env: mcpFile ? { ...env, CYBORG_MCP: mcpFile } : env,
    });
    const session: Session = {
      id,
      project,
      term: { write: (data) => proc.write(data), resize: (cols, rows) => proc.resize(cols, rows), kill: () => proc.kill() },
      eventsFile,
      envStamp: envStampNow(false),
      offset: 0,
      cwd,
      dirs: [cwd, ...addDirs],
      state: 'starting',
      outbox: [],
      inFlight: new Map(),
      context: {},
      lastEventAt: Date.now(),
      ...(parent !== undefined ? { parent } : {}),
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
      this.exited(session, exitCode);
      this.emit('session:exit', { id, exitCode });
    });
    return id;
  }

  // Вкладка вышедшей сессии остаётся: открывшая должна её видеть и закрыть, а не счесть пропавшей.
  private exited(session: Session, exitCode: number): void {
    if (session.released) this.sessions.delete(session.id);
    else {
      Object.assign(session, { state: 'exited', exitCode, term: EXITED_TERM, outbox: [], submitPending: false, delivering: false, reason: undefined });
      session.inFlight.clear();
    }
    if (session.parent === undefined || session.closedBy === session.parent || session.ending) return;
    this.enqueue(session.parent, childExitText(session.id, { code: exitCode, released: !!session.released, closedBy: session.closedBy }));
  }

  /** Вкладку закрыли: завершённая сессия убирается сразу, работающая - когда выйдет её процесс. */
  release(id: unknown): void {
    const valid = validateSessionId(id);
    const session = valid === null ? undefined : this.sessions.get(valid);
    if (!session || session.remote) return;
    if (session.state === 'exited') this.sessions.delete(session.id);
    else session.released = true;
  }

  /** Вкладку закрывает сессия инструментом: открывшей, закрывшей свою дочернюю, сообщение о выходе не нужно. */
  noteClosing(id: number, caller: number): void {
    const session = this.sessions.get(id);
    if (session) session.closedBy = caller;
  }

  /** Сессии, чьё окружение при запуске отличается от нынешнего управляемого: имена переменных по каждой. */
  staleSessions(): { id: number; names: string[]; noRestart?: true }[] {
    return [...this.sessions.values()]
      .filter((s) => s.envStamp && s.state !== 'exited')
      // Вкладку удалённой сессии, открытой другой сессией, ведёт вызвавшая: перезапуск её потерял бы.
      .map((s) => ({ id: s.id, names: staleNames(s.envStamp as EnvStamp), ...(s.remote?.origin === 'tool' ? { noRestart: true as const } : {}) }))
      .filter((s) => s.names.length);
  }

  /** Что нужно для продолжения локальной сессии с её разговором; null - продолжать нечего (удалённая, разговор не начат, вышла). */
  restartInfo(id: unknown): { project: string; cwd: string; addDirs: string[]; resume: string } | null {
    const valid = validateSessionId(id);
    const session = valid === null ? undefined : this.sessions.get(valid);
    if (!session || session.remote || session.state === 'exited' || !session.claudeSid) return null;
    return { project: session.project, cwd: session.cwd, addDirs: session.dirs.slice(1), resume: session.claudeSid };
  }

  /** Перезапуск локальной сессии: живая открывшая не получает сообщения о выходе и возвращается, чтобы report_done новой вкладки дошёл до неё. */
  async restart(id: unknown): Promise<{ resume: string; parent?: number }> {
    const info = this.restartInfo(id);
    if (!info) throw new Error('Сессию нельзя перезапустить: разговор в ней ещё не начат');
    const valid = id as number;
    const parent = this.sessions.get(valid)?.parent;
    const live = parent !== undefined && this.sessions.has(parent) && this.sessions.get(parent)?.state !== 'exited' ? parent : undefined;
    if (live !== undefined) this.noteClosing(valid, live);
    await this.terminate(valid);
    return { resume: info.resume, ...(live !== undefined ? { parent: live } : {}) };
  }

  /** Работающие сессии: у завершившейся вкладка может оставаться, но процесса нет. */
  count(): number {
    return this.local().length;
  }

  private local(): Session[] {
    return [...this.sessions.values()].filter((s) => !s.remote && s.state !== 'exited');
  }

  /** Каталоги и текущие cwd работающих сессий: интерфейсу они доступны, даже если лежат не в репозиториях проекта. */
  liveDirs(): string[] {
    return this.local().flatMap((s) => [...s.dirs, s.cwd]);
  }

  /** Каталоги запуска сессии - её рабочий и подключённые через --add-dir; null - сессии нет. */
  dirsOf(id: number): string[] | null {
    const session = this.sessions.get(id);
    return session && session.state !== 'exited' ? session.dirs : null;
  }

  // Проект приходит из недоверенного интерфейса (ADR-0002 п.5): дочерняя не уходит в чужой проект, где её не увидит открывшая.
  private checkParent(project: string, parent: number | undefined): void {
    const own = parent === undefined ? undefined : this.sessions.get(parent)?.project;
    if (own !== undefined && own !== project) throw new Error('Проект вкладки не совпадает с проектом открывшей сессии');
  }

  /** id проекта сессии; null - сессии нет. */
  projectOf(id: number): string | null {
    return this.sessions.get(id)?.project ?? null;
  }

  /** Вкладки проекта вызывающей, она сама и завершённые тоже. null - сессии нет либо она завершена. */
  peers(id: number): SessionInfo[] | null {
    const own = this.sessions.get(id);
    if (!own || own.state === 'exited') return null;
    return [...this.sessions.values()]
      .filter((s) => s.project === own.project)
      .map(({ id, dirs, cwd, state, reason, lastAnswer, outbox, submitPending, remote, parent, exitCode, context, declared }) => ({
        id,
        dirs,
        cwd,
        state,
        reason,
        lastAnswer,
        queued: outbox.length + (submitPending ? 1 : 0),
        ...(remote ? { host: remote.host, ...(remote.online ? {} : { link: 'offline' as const }) } : {}),
        ...(parent !== undefined ? { parent } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(declared?.ref ? { ref: declared.ref } : {}),
        ...(declared ? { summary: declared.summary } : {}),
        ...(context.title ? { title: context.title } : {}),
        ...(context.first ? { task: context.first } : {}),
        ...(context.last ? { lastPrompt: context.last } : {}),
      }));
  }

  /** Сообщение от другой сессии: принимающей ввод - сразу, иначе в очередь; на вопросе и при запуске - отказ. */
  async say(id: number, text: string): Promise<SayResult> {
    const session = this.sessions.get(id);
    if (!session || session.state === 'exited') throw new Error(`сессия ${id} завершилась`);
    if (!session.remote) this.readEvents(session);
    const open = acceptsInput(session);
    if (!open && session.state !== 'working') {
      throw new Error(`сессия ${id} ${session.state === 'asking' ? `ждёт человека (${session.reason})` : 'ещё запускается'}`);
    }
    const quiet = !session.remote || Date.now() - session.lastEventAt >= this.outboxDelayMs;
    if (!open || !quiet || session.outbox.length || session.delivering) {
      session.outbox.push(text);
      this.scheduleOutbox(session);
      return 'queued';
    }
    const working = session.state === 'working' && !session.background;
    const result = await this.deliver(session, text);
    return result === 'sent' && working ? 'sent-working' : result;
  }

  // Локальная дочитывает события перед проверкой: вызов мог начаться после последнего чтения.
  private put(session: Session, data: string): boolean {
    if (this.sessions.get(session.id) !== session || session.state === 'exited') throw new Error(`сессия ${session.id} завершилась`);
    if (session.remote && !session.remote.online) throw new Error(`сессия ${session.id} без связи с хостом`);
    if (!session.remote) this.readEvents(session);
    if (!acceptsInput(session)) return false;
    try {
      session.term.write(data);
    } catch {
      throw new Error(`сессия ${session.id} завершилась`);
    }
    return true;
  }

  private async deliver(session: Session, text: string): Promise<'sent' | 'queued'> {
    session.delivering = true;
    try {
      // Вставкой: перевод строки в тексте TUI мог бы принять за Enter и отправить сообщение по кускам.
      // Чистка у записи: в очередь попадает и текст хоста, минуя validateSend.
      if (!this.put(session, `\x1b[200~${cleanMessage(text)}\x1b[201~`)) {
        session.outbox.unshift(text);
        return 'queued';
      }
      await new Promise((resolve) => setTimeout(resolve, SUBMIT_DELAY_MS));
      if (this.put(session, '\r')) return 'sent';
      if (session.remote) throw new Error(`сессия ${session.id} начала ход: текст вставлен в её ввод, Enter не отправлен`);
      session.submitPending = true;
      return 'queued';
    } finally {
      if (!session.submitPending) session.delivering = false;
      // Хук UserPromptSubmit приходит позже Enter: тишина отсчитывается заново.
      session.lastEventAt = Date.now();
      this.scheduleOutbox(session);
    }
  }

  private submit(session: Session): void {
    try {
      if (!this.put(session, '\r')) return;
    } catch {
      // Сессия завершилась: отправлять некуда.
    }
    session.submitPending = false;
    session.delivering = false;
    session.lastEventAt = Date.now();
    this.scheduleOutbox(session);
  }

  /** Очередь отдаёт по сообщению, когда сессия примет ввод; удалённая - после outboxDelayMs тишины: чужой Stop-хук мог продолжить ход. */
  private scheduleOutbox(session: Session): void {
    clearTimeout(session.outboxTimer);
    if (!acceptsInput(session) || (session.remote && !session.remote.online)) return;
    if (session.submitPending) {
      session.outboxTimer = setTimeout(() => this.submit(session), 0);
      return;
    }
    if (!session.outbox.length || session.delivering) return;
    session.outboxTimer = setTimeout(
      () => {
        const text = session.outbox.shift();
        if (text !== undefined) this.deliver(session, text).catch(() => {});
      },
      session.remote ? Math.max(0, session.lastEventAt + this.outboxDelayMs - Date.now()) : 0,
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

  /** Завершить сессию и дождаться выхода процесса (предел 5 с): перезапуск начинает новую после старой. */
  async terminate(id: unknown): Promise<void> {
    const valid = validateSessionId(id);
    if (valid === null) return;
    this.kill(valid);
    for (let waited = 0; waited < TERMINATE_WAIT_MS && this.sessions.get(valid)?.state !== 'exited' && this.sessions.has(valid); waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
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

  // Вкладки уходят вместе с сессиями (смена воркспейса, выход): гаснущей открывшей сообщать незачем.
  killAll(): void {
    for (const session of [...this.sessions.values()]) {
      if (session.remote) continue;
      if (session.state === 'exited') this.sessions.delete(session.id);
      else {
        Object.assign(session, { released: true, ending: true });
        session.term.kill();
      }
    }
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
    this.checkParent(options.project, options.remote.spawnedBy);
    const id = this.nextId++;
    this.sessions.set(id, {
      id,
      project: options.project,
      term: options.term,
      remote: options.remote,
      envStamp: options.envStamp,
      ...(options.remote.spawnedBy !== undefined ? { parent: options.remote.spawnedBy } : {}),
      offset: 0,
      cwd: options.cwd,
      dirs: options.dirs,
      state: 'starting',
      outbox: [],
      inFlight: new Map(),
      context: {},
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

  /** Номер сессии, открывшей эту; null - открыл человек либо сессии нет. */
  parentOf(id: number): number | null {
    return this.sessions.get(id)?.parent ?? null;
  }

  /**
   * Итог локальной дочерней (report_done): один за круг работы, в очередь открывшей сессии;
   * её уже нет - уведомлением рабочего стола. Удалённую ведёт RemoteSessions.
   */
  reportLocal(id: number, report: { status: string; summary: string; branch?: string; pr?: string }): string {
    const session = this.sessions.get(id);
    if (!session || session.remote || session.parent === undefined) throw new Error('report_done есть только у сессии, открытой другой сессией');
    if (session.reported) throw new Error(REPORTED_ERROR);
    session.reported = true;
    if (!this.enqueue(session.parent, reportText(id, undefined, report))) {
      this.emit('remote:report', { id, title: `CC${id}`, body: reportNote(report) });
    }
    return REPORT_ACCEPTED;
  }

  /** set_task: сессия сама называет свою задачу; новый вызов заменяет прежний. */
  setTask(id: number, task: { ref?: string; summary: string }): void {
    const session = this.sessions.get(id);
    if (!session || session.state === 'exited') throw new Error('сессия завершена');
    session.declared = task;
  }

  remoteOf(id: number): RemoteMeta | null {
    return this.sessions.get(id)?.remote ?? null;
  }

  /** Сообщение в очередь сессии без отказа: уйдёт, когда она будет ждать. false - сессии нет. */
  enqueue(id: number, text: string): boolean {
    const session = this.sessions.get(id);
    if (!session || session.state === 'exited') return false;
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
    if (!session || session.state === 'exited') return;
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

  /** Название и первый запрос берутся из журнала: у продолженной сессии постановка задачи была в прошлом запуске. */
  private noteContext(session: Session, event: SessionEvent): void {
    const context = session.context;
    const before = JSON.stringify(context);
    const name = event.hook_event_name;
    if (name === 'UserPromptSubmit') notePrompt(context, event.prompt);
    // Журнал удалённой сессии лежит на хосте.
    if (!session.remote && event.transcript_path && (name === 'SessionStart' || name === 'Stop')) {
      const facts = readJournalFacts(event.transcript_path);
      if (facts?.named) context.title = facts.named;
      if (facts?.firstPrompt) context.first = clipPrompt(facts.firstPrompt);
    }
    if (JSON.stringify(context) !== before) this.emit('session:context', { id: session.id, ...context });
  }

  private apply(session: Session, event: SessionEvent, notify: boolean): void {
    if (event.cwd && event.cwd !== session.cwd) {
      session.cwd = event.cwd;
      this.emit('session:cwd', { id: session.id, cwd: event.cwd });
    }
    if (notify) this.emit('session:activity', { id: session.id, event: event.hook_event_name, tool: event.tool_name });
    session.lastEventAt = Date.now();
    if (event.session_id) session.claudeSid = event.session_id;
    if (session.parent !== undefined && !session.remote && event.session_id && event.session_id !== session.childSid) {
      session.childSid = event.session_id;
      this.onChild?.(event.session_id);
    }
    noteCall(session.inFlight, event);
    track(session, event);
    this.noteContext(session, event);
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
      session.reported = false;
    } else if (
      session.suggested &&
      ((isToolEvent(event.hook_event_name) && !event.agent_id) || (event.hook_event_name === 'Notification' && waitingReason(event)))
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
