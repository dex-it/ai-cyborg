import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { INHERITED_SESSION_VARS } from './sessions';

export const TERMINALS = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'kitty', 'alacritty', 'wezterm', 'foot', 'xterm'];

// CYBORG_EVENTS и CYBORG_SETTINGS унаследовал бы Cyborg, запущенный из его же сессии: sessionEnv их перекрывает, а не удаляет.
const UNSET = [...INHERITED_SESSION_VARS, 'CYBORG_EVENTS', 'CYBORG_SETTINGS'];

// Постоянный текст: пользовательские данные доходят до него только аргументами ($1 - каталог, дальше - команда).
export const RUN_SCRIPT = [
  `unset ${UNSET.join(' ')}`,
  'trap : INT',
  'cd -- "$1" || { echo "Каталог недоступен: $1"; read -r _; exit 1; }',
  'shift',
  '"$@"',
  'code=$?',
  'echo',
  'echo "[Код выхода $code] Нажмите Enter, чтобы закрыть окно"',
  'read -r _',
].join('\n');

const MAC_SCRIPT = [
  'on run argv',
  'set cmd to "exec"',
  'repeat with a in argv',
  'set cmd to cmd & " " & quoted form of (a as text)',
  'end repeat',
  'tell application "Terminal"',
  'activate',
  'do script cmd',
  'end tell',
  'end run',
];

export type IsExec = (file: string) => boolean;

const defaultIsExec: IsExec = (file) => {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Первый найденный эмулятор: `$TERMINAL`, затем перечень; имя без `/` ищется по абсолютным каталогам PATH. */
export function findTerminal(env: NodeJS.ProcessEnv, isExec: IsExec = defaultIsExec): string | null {
  const dirs = (env.PATH ?? '').split(':').filter((dir) => path.isAbsolute(dir));
  for (const name of [env.TERMINAL, ...TERMINALS]) {
    if (!name) continue;
    if (name.includes('/')) {
      if (path.isAbsolute(name) && isExec(name)) return name;
      continue;
    }
    for (const dir of dirs) {
      const file = path.join(dir, name);
      if (isExec(file)) return file;
    }
  }
  return null;
}

function realBase(file: string): string {
  try {
    return path.basename(fs.realpathSync(file));
  } catch {
    return path.basename(file);
  }
}

/** Как эмулятор принимает команду: argv поэлементно, формы с одной строкой команды не используются. */
function termArgs(terminal: string, inner: string[]): string[] {
  const base = path.basename(terminal) === 'x-terminal-emulator' ? realBase(terminal) : path.basename(terminal);
  switch (base) {
    case 'gnome-terminal':
      return ['--', ...inner];
    case 'xfce4-terminal':
      return ['-x', ...inner];
    case 'kitty':
    case 'foot':
      return inner;
    case 'wezterm':
      return ['start', '--', ...inner];
    default:
      return ['-e', ...inner];
  }
}

export function noTerminalMessage(env: NodeJS.ProcessEnv): string {
  const own = env.TERMINAL ? ` (TERMINAL=${env.TERMINAL})` : '';
  return `Не найден эмулятор терминала. Искали в PATH: $TERMINAL${own}, ${TERMINALS.join(', ')}. Задайте переменную окружения TERMINAL с именем или путём вашего терминала и перезапустите Cyborg.`;
}

export type TerminalLaunch = { cmd: string; args: string[] } | { error: string };

/** Запуск внешнего терминала с командой в каталоге dir; своего pty нет. */
export function terminalLaunch(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, dir: string, command: string[], isExec?: IsExec): TerminalLaunch {
  if (platform === 'darwin') {
    return { cmd: 'osascript', args: [...MAC_SCRIPT.flatMap((line) => ['-e', line]), '/bin/sh', '-c', RUN_SCRIPT, 'cyborg-run', dir, ...command] };
  }
  if (platform !== 'linux') return { error: 'Запуск в терминале есть на macOS и Linux' };
  const terminal = findTerminal(env, isExec);
  if (terminal === null) return { error: noTerminalMessage(env) };
  const inner = [env.SHELL || '/bin/bash', '-lc', RUN_SCRIPT, 'cyborg-run', dir, ...command];
  return { cmd: terminal, args: termArgs(terminal, inner) };
}

/** osascript живёт, пока Terminal не принял команду; отказ в разрешении на управление Terminal приходит в stderr. */
export function launchAndWait(cmd: string, args: string[]): Promise<{ error?: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 120_000 }, (error, _stdout, stderr) => {
      resolve(error ? { error: String(stderr).trim() || error.message } : {});
    });
  });
}
