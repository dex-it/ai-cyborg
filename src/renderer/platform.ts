/** Клавиша-модификатор команд приложения: Cmd на macOS, Ctrl на остальных системах. */
export interface ModifierState {
  ctrlKey: boolean;
  metaKey: boolean;
}

export const isMac = (platform: string): boolean => platform === 'darwin';

/** Нажат модификатор команд своей системы и не нажат чужой: Ctrl+C в терминале macOS - прерывание, а не копирование. */
export function hasCommandKey(event: ModifierState, mac: boolean): boolean {
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/** Подпись сочетания для подсказок: `shortcut(true, 'Shift', 'N')` -> `Cmd+Shift+N`. */
export function shortcut(mac: boolean, ...keys: string[]): string {
  return [mac ? 'Cmd' : 'Ctrl', ...keys].join('+');
}

export interface KeyState extends ModifierState {
  shiftKey: boolean;
  altKey: boolean;
  code: string;
}

/** Копирование (`KeyC`) и вставка (`KeyV`) терминала вне macOS: Ctrl+Shift+C/V, голый Ctrl+C - прерывание. */
export function isClipboardKey(event: KeyState, code: 'KeyC' | 'KeyV'): boolean {
  return event.code === code && event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey;
}
