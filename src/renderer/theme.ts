import type { ITheme } from '@xterm/xterm';

const media = matchMedia('(prefers-color-scheme: dark)');

export const isDark = (): boolean => media.matches;

export function onThemeChange(listener: () => void): void {
  media.addEventListener('change', listener);
}

export const monacoTheme = (): string => (isDark() ? 'vs-dark' : 'vs');

// Палитра терминала VS Code: Claude Code рассчитан на неё в обеих темах.
const DARK: ITheme = {
  background: '#1e1e1e',
  foreground: '#cccccc',
  cursor: '#cccccc',
  selectionBackground: '#264f78',
};

const LIGHT: ITheme = {
  background: '#ffffff',
  foreground: '#333333',
  cursor: '#333333',
  selectionBackground: '#add6ff',
  black: '#000000',
  red: '#cd3131',
  green: '#00bc00',
  yellow: '#949800',
  blue: '#0451a5',
  magenta: '#bc05bc',
  cyan: '#0598bc',
  white: '#555555',
  brightBlack: '#666666',
  brightRed: '#cd3131',
  brightGreen: '#14ce14',
  brightYellow: '#b5ba00',
  brightBlue: '#0451a5',
  brightMagenta: '#bc05bc',
  brightCyan: '#0598bc',
  brightWhite: '#a5a5a5',
};

export const terminalTheme = (): ITheme => (isDark() ? DARK : LIGHT);

const SESSION_COLORS = ['#d97757', '#3b82f6', '#10b981', '#a855f7', '#f59e0b', '#ec4899', '#14b8a6', '#6366f1'];

export const sessionColor = (index: number): string => SESSION_COLORS[index % SESSION_COLORS.length];
