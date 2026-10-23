import fs from 'node:fs';
import path from 'node:path';
import type * as pty from 'node-pty';
import { createEventsFile, prepareEventsDir } from './events-store.ts';

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
  watcher: fs.FSWatcher;
}

export interface SessionEvent {
  hook_event_name?: string;
  cwd?: string;
  tool_name?: string;
}

// Claude Code не оборачивается: Cyborg только дописывает хуки через --settings, и они кладут JSON события в файл сессии.
const HOOK_COMMAND = '{ cat; echo; } >> "$CYBORG_EVENTS"';
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'];

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
  return { ...env, ...extra };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class SessionManager {
  private readonly sessions = new Map<number, Session>();
  private nextId = 1;
  private readonly settingsFile: string;
  private readonly eventsDir: string;
  private readonly emit: Emit;
  private readonly spawn: Spawn;

  constructor(userData: string, emit: Emit, spawn: Spawn = nodePtySpawn) {
    this.emit = emit;
    this.spawn = spawn;
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
    fs.writeFileSync(this.settingsFile, JSON.stringify({ hooks }, null, 2));
  }

  create(cwd: string, addDirs: string[]): number {
    const id = this.nextId++;
    const eventsFile = path.join(this.eventsDir, `${process.pid}-${id}.jsonl`);
    createEventsFile(eventsFile);
    const shell = process.env.SHELL || '/bin/bash';
    const args = addDirs.length ? ['--add-dir', ...addDirs] : [];
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
      watcher: fs.watch(eventsFile, () => this.readEvents(session)),
    };
    this.sessions.set(id, session);
    proc.onData((data) => this.emit('session:data', { id, data }));
    proc.onExit(({ exitCode }) => {
      session.watcher.close();
      fs.rmSync(eventsFile, { force: true });
      this.sessions.delete(id);
      this.emit('session:exit', { id, exitCode });
    });
    return id;
  }

  write(id: number, data: string): void {
    this.sessions.get(id)?.pty.write(data);
  }

  resize(id: number, cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.sessions.get(id)?.pty.resize(cols, rows);
  }

  kill(id: number): void {
    this.sessions.get(id)?.pty.kill();
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
    }
  }
}
