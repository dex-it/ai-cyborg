import fs from 'node:fs';
import path from 'node:path';
import type * as pty from 'node-pty';
import { createEventsFile, prepareEventsDir } from './events-store.ts';
import { claudeArgs } from './claude-args.ts';
import { parseSuggestions } from './suggestions.ts';
import { writeJsonAtomic } from './jsonfile.ts';
import { isAlive } from './pid.ts';
import { validateInputArgs, validateResizeArgs, validateSessionId } from './session-args.ts';

type Emit = (channel: string, payload: unknown) => void;
type Spawn = typeof pty.spawn;

// node-pty собран под ABI Electron и в чистом node не грузится: модуль подключается при первом запуске сессии, а тест подставляет свой spawn.
const nodePtySpawn: Spawn = (...args) => require('node-pty').spawn(...args);

interface Session {
  id: number;
  pty: pty.IPty;
  eventsFile: string;
  offset: number;
  cwd: string;
  /** Репозитории запуска: ветками в них управляет сессия. */
  dirs: string[];
  watcher: fs.FSWatcher;
  /** Отложенное «ждёт» после Stop: любое следующее событие сессии его отменяет. */
  stopTimer?: NodeJS.Timeout;
  /** Интерфейсу отправлены предложенные моделью кнопки, которые ещё не сняты. */
  suggested?: boolean;
}

export interface SessionEvent {
  hook_event_name?: string;
  cwd?: string;
  tool_name?: string;
  message?: string;
  notification_type?: string;
  last_assistant_message?: string;
  background_tasks?: unknown[];
  session_crons?: unknown[];
}

// Claude Code не оборачивается: Cyborg только дописывает хуки через --settings, и они кладут JSON события в файл сессии.
const HOOK_COMMAND = '{ cat; echo; } >> "$CYBORG_EVENTS"';
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'Notification'];

// Белый список: новый тип Notification в следующей версии CC не уведомляет; idle_prompt повторяет Stop через минуту.
// Текст уведомления зависит только от типа события: ответ Claude и сообщение запроса на экран блокировки не попадают (D-07).
const WAITING_NOTIFICATIONS: ReadonlyMap<string, string> = new Map([
  ['permission_prompt', 'Просит разрешение'],
  ['elicitation_dialog', 'Задаёт вопрос'],
  ['elicitation_url_dialog', 'Задаёт вопрос'],
  ['agent_needs_input', 'Ждёт ответа'],
  ['quota_auto_resume_stale', 'Остановилась на лимите'],
  ['quota_auto_resume_disabled', 'Остановилась на лимите'],
]);

/** Сессия ждёт человека: ход закончен либо CC стоит на вопросе, разрешении или лимите (типы - code.claude.com/docs/en/hooks). */
export function waitingReason(event: SessionEvent): string | null {
  if (event.hook_event_name === 'Stop') {
    // Непустые background_tasks или session_crons - пауза до фоновой работы: сессия проснётся сама.
    if (event.background_tasks?.length || event.session_crons?.length) return null;
    return 'Ход завершён, ждёт ответа';
  }
  if (event.hook_event_name !== 'Notification') return null;
  return WAITING_NOTIFICATIONS.get(event.notification_type ?? '') ?? null;
}

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

  // Чужой Stop-хук может продолжить ход: «ждёт» после Stop объявляется, только если сессия молчит stopDelayMs.
  constructor(userData: string, emit: Emit, spawn: Spawn = nodePtySpawn, stopDelayMs = 30_000) {
    this.emit = emit;
    this.spawn = spawn;
    this.stopDelayMs = stopDelayMs;
    this.eventsDir = path.join(userData, 'sessions');
    prepareEventsDir(this.eventsDir);
    this.removeOrphanedEvents();
    this.settingsFile = path.join(userData, 'claude-hooks.json');
    const hooks = Object.fromEntries(
      HOOK_EVENTS.map((event) => [
        event,
        [{ ...(event === 'PostToolUse' ? { matcher: '*' } : {}), hooks: [{ type: 'command', command: HOOK_COMMAND }] }],
      ]),
    );
    // Атомарно: соседний инстанс пишет тот же файл, а запускающийся claude не должен прочитать обрезанный.
    writeJsonAtomic(this.settingsFile, { hooks });
  }

  create(cwd: string, addDirs: string[], prompt?: string, resume?: string): number {
    const id = this.nextId++;
    const eventsFile = path.join(this.eventsDir, `${process.pid}-${id}.jsonl`);
    createEventsFile(eventsFile);
    const shell = process.env.SHELL || '/bin/bash';
    const args = claudeArgs(addDirs, prompt, resume);
    // Логин-шелл даёт PATH пользователя: из меню приложений Electron стартует без ~/.local/bin.
    const proc = this.spawn(shell, ['-lc', 'exec claude --settings "$CYBORG_SETTINGS" "$@"', 'cyborg', ...args], {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd,
      env: sessionEnv({
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        CYBORG_EVENTS: eventsFile,
        CYBORG_SETTINGS: this.settingsFile,
      }),
    });
    const session: Session = {
      id,
      pty: proc,
      eventsFile,
      offset: 0,
      cwd,
      dirs: [cwd, ...addDirs],
      watcher: fs.watch(eventsFile, () => this.readEvents(session)),
    };
    this.sessions.set(id, session);
    // kqueue (macOS) взводит наблюдателя на следующем витке цикла: запись между spawn и взводом событие не даёт и иначе осталась бы непрочитанной.
    setImmediate(() => this.readEvents(session));
    proc.onData((data) => this.emit('session:data', { id, data }));
    proc.onExit(({ exitCode }) => {
      clearTimeout(session.stopTimer);
      session.watcher.close();
      fs.rmSync(eventsFile, { force: true });
      this.sessions.delete(id);
      this.emit('session:exit', { id, exitCode });
    });
    return id;
  }

  /** Работающие сессии: завершившаяся убирается из набора в onExit. */
  count(): number {
    return this.sessions.size;
  }

  /** Каталоги и текущие cwd работающих сессий: интерфейсу они доступны, даже если лежат не в репозиториях проекта. */
  liveDirs(): string[] {
    return [...this.sessions.values()].flatMap((s) => [...s.dirs, s.cwd]);
  }

  uses(dir: string): boolean {
    return [...this.sessions.values()].some((s) => s.dirs.includes(dir));
  }

  // Аргументы приходят из интерфейса и не проверены (session-args.ts): мусор молча отбрасывается. Вызов pty в try: процесс мог
  // завершиться между проверкой и вызовом, и ioctl на закрытом дескрипторе бросает, а исключение в обработчике канала - ошибка главного процесса.
  write(id: unknown, data: unknown): void {
    const args = validateInputArgs(id, data);
    if (args) this.guarded(args.id, (p) => p.write(args.data));
  }

  resize(id: unknown, cols: unknown, rows: unknown): void {
    const args = validateResizeArgs(id, cols, rows);
    if (args) this.guarded(args.id, (p) => p.resize(args.cols, args.rows));
  }

  kill(id: unknown): void {
    const valid = validateSessionId(id);
    if (valid !== null) this.guarded(valid, (p) => p.kill());
  }

  private guarded(id: number, action: (proc: pty.IPty) => void): void {
    const proc = this.sessions.get(id)?.pty;
    if (!proc) return;
    try {
      action(proc);
    } catch {
      // Процесс уже завершён: onExit уберёт сессию.
    }
  }

  killAll(): void {
    for (const session of this.sessions.values()) session.pty.kill();
  }

  // Убитый экземпляр не доходит до onExit, и его файлы событий остаются.
  private removeOrphanedEvents(): void {
    for (const name of fs.readdirSync(this.eventsDir)) {
      const pid = Number(/^(\d+)-\d+\.jsonl$/.exec(name)?.[1]);
      if (pid && pid !== process.pid && !isAlive(pid)) fs.rmSync(path.join(this.eventsDir, name), { force: true });
    }
  }

  private readEvents(session: Session): void {
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
    for (const line of buffer.subarray(0, end).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let event: SessionEvent;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.cwd && event.cwd !== session.cwd) {
        session.cwd = event.cwd;
        this.emit('session:cwd', { id: session.id, cwd: event.cwd });
      }
      this.emit('session:activity', { id: session.id, event: event.hook_event_name, tool: event.tool_name });
      if (event.hook_event_name === 'Stop') {
        const buttons = parseSuggestions(event.last_assistant_message);
        if (buttons.length) {
          this.emit('session:suggest', { id: session.id, buttons });
          session.suggested = true;
        }
      } else if (event.hook_event_name === 'UserPromptSubmit') {
        session.suggested = false; // кнопки снимает интерфейс по этому же событию
      } else if (session.suggested && (event.hook_event_name === 'PostToolUse' || (event.hook_event_name === 'Notification' && waitingReason(event)))) {
        // Модель снова работает без запроса человека (фоновая задача, расписание) либо стоит на вопросе: предложение относилось к прошлому ходу,
        // а кнопка с submit отправила бы Enter уже в чужой диалог.
        this.emit('session:suggest', { id: session.id, buttons: [] });
        session.suggested = false;
      }
      clearTimeout(session.stopTimer);
      const reason = waitingReason(event);
      if (!reason) continue;
      if (event.hook_event_name === 'Stop') {
        session.stopTimer = setTimeout(() => this.emit('session:waiting', { id: session.id, reason }), this.stopDelayMs);
      } else this.emit('session:waiting', { id: session.id, reason });
    }
  }
}
