import type { MenuItemConstructorOptions } from 'electron';

/**
 * Меню приложения без Reload и масштаба страницы. Перезагрузка интерфейса оставляла работающие сессии в главном процессе
 * без вкладок: они не видны, не закрываются и мешают сменить ветку. Масштаб страницы (Cmd/Ctrl+0, +, -) занят
 * масштабом шрифта приложения. Стандартные роли остаются: правка (копирование и вставка в терминале macOS - Cmd+C/V),
 * окно, выход.
 */
export function appMenuTemplate(platform: NodeJS.Platform): MenuItemConstructorOptions[] {
  return [
    platform === 'darwin' ? { role: 'appMenu' } : { role: 'fileMenu' },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'toggleDevTools' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ];
}
