import type { MenuItemConstructorOptions } from 'electron';

export const NOTIFICATIONS_MENU_ID = 'notifications';

/**
 * Меню приложения без Reload и масштаба страницы. Перезагрузка интерфейса оставляла работающие сессии в главном процессе
 * без вкладок: они не видны, не закрываются и мешают сменить ветку. Масштаб страницы (Cmd/Ctrl+0, +, -) занят
 * масштабом шрифта приложения. Стандартные роли остаются: правка (копирование и вставка в терминале macOS - Cmd+C/V),
 * окно, инструменты разработчика. Выход - не роль, а `quit`: вызывающий сначала спрашивает подтверждение, пока идут сессии.
 * Окна настроек нет, поэтому выключатель уведомлений о ждущих сессиях живёт в View; состояние галочки выставляет интерфейс по id.
 */
export function appMenuTemplate(
  platform: NodeJS.Platform,
  quit: () => void,
  toggleNotifications: (enabled: boolean) => void,
): MenuItemConstructorOptions[] {
  const notificationsItem: MenuItemConstructorOptions = {
    id: NOTIFICATIONS_MENU_ID,
    label: 'Уведомления о ждущих сессиях',
    type: 'checkbox',
    checked: true,
    click: (item) => toggleNotifications(item.checked),
  };
  const quitItem: MenuItemConstructorOptions = { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: quit };
  const first: MenuItemConstructorOptions =
    platform === 'darwin'
      ? {
          label: 'Cyborg',
          submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, quitItem],
        }
      : { label: 'File', submenu: [{ role: 'close' }, quitItem] };
  return [first, { role: 'editMenu' }, { label: 'View', submenu: [notificationsItem, { type: 'separator' }, { role: 'toggleDevTools' }, { role: 'togglefullscreen' }] }, { role: 'windowMenu' }];
}
