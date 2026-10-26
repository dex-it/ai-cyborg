import type { MenuItemConstructorOptions } from 'electron';

/**
 * Меню приложения без Reload и масштаба страницы. Перезагрузка интерфейса оставляла работающие сессии в главном процессе
 * без вкладок: они не видны, не закрываются и мешают сменить ветку. Масштаб страницы (Cmd/Ctrl+0, +, -) занят
 * масштабом шрифта приложения. Стандартные роли остаются: правка (копирование и вставка в терминале macOS - Cmd+C/V),
 * окно, инструменты разработчика. Выход - не роль, а `quit`: вызывающий сначала спрашивает подтверждение, пока идут сессии.
 */
export function appMenuTemplate(platform: NodeJS.Platform, quit: () => void): MenuItemConstructorOptions[] {
  const quitItem: MenuItemConstructorOptions = { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: quit };
  const first: MenuItemConstructorOptions =
    platform === 'darwin'
      ? {
          label: 'Cyborg',
          submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, quitItem],
        }
      : { label: 'File', submenu: [{ role: 'close' }, quitItem] };
  return [first, { role: 'editMenu' }, { label: 'View', submenu: [{ role: 'toggleDevTools' }, { role: 'togglefullscreen' }] }, { role: 'windowMenu' }];
}
