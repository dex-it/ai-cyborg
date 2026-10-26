import type { MenuItemConstructorOptions } from 'electron';
import path from 'node:path';

export const NOTIFICATIONS_MENU_ID = 'notifications';
export const PROJECT_NEW_MENU_ID = 'project-new';
export const PROJECT_PROPERTIES_MENU_ID = 'project-properties';

/** Подпись пункта «Недавних»: домашний каталог - «~». */
export function recentLabel(file: string, home: string): string {
  return home && (file === home || file.startsWith(home + path.sep)) ? `~${file.slice(home.length)}` : file;
}

export interface WorkspaceMenu {
  recent: string[];
  home: string;
  hasWorkspace: boolean;
  hasProject: boolean;
  open(): void;
  create(): void;
  openRecent(file: string): void;
  newProject(): void;
  editProject(): void;
}

/**
 * Меню приложения без Reload и масштаба страницы. Перезагрузка интерфейса оставляла работающие сессии в главном процессе
 * без вкладок: они не видны, не закрываются и мешают сменить ветку. Масштаб страницы (Cmd/Ctrl+0, +, -) занят
 * масштабом шрифта приложения. Стандартные роли остаются: правка (копирование и вставка в терминале macOS - Cmd+C/V),
 * окно, инструменты разработчика. Выход - не роль, а `quit`: вызывающий сначала спрашивает подтверждение, пока идут сессии.
 * Окна настроек нет, поэтому выключатель уведомлений о ждущих сессиях живёт в View; состояние галочки выставляет интерфейс.
 * «Воркспейс» ведёт воркспейсами и проектами: проект выбирается на панели, а создаётся и правится отсюда.
 */
export function appMenuTemplate(
  platform: NodeJS.Platform,
  quit: () => void,
  toggleNotifications: (enabled: boolean) => void,
  workspace: WorkspaceMenu,
  notificationsEnabled = true,
): MenuItemConstructorOptions[] {
  const notificationsItem: MenuItemConstructorOptions = {
    id: NOTIFICATIONS_MENU_ID,
    label: 'Уведомления о ждущих сессиях',
    type: 'checkbox',
    checked: notificationsEnabled,
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
  const recent: MenuItemConstructorOptions[] = workspace.recent.length
    ? workspace.recent.map((file) => ({ label: recentLabel(file, workspace.home), click: () => workspace.openRecent(file) }))
    : [{ label: 'Нет недавних', enabled: false }];
  const workspaceMenu: MenuItemConstructorOptions = {
    label: 'Воркспейс',
    submenu: [
      { label: 'Открыть в новом окне…', click: () => workspace.open() },
      { label: 'Создать…', click: () => workspace.create() },
      { label: 'Недавние', submenu: recent },
      { type: 'separator' },
      { id: PROJECT_NEW_MENU_ID, label: 'Новый проект', enabled: workspace.hasWorkspace, click: () => workspace.newProject() },
      { id: PROJECT_PROPERTIES_MENU_ID, label: 'Свойства проекта', enabled: workspace.hasProject, click: () => workspace.editProject() },
    ],
  };
  return [first, workspaceMenu, { role: 'editMenu' }, { label: 'View', submenu: [notificationsItem, { type: 'separator' }, { role: 'toggleDevTools' }, { role: 'togglefullscreen' }] }, { role: 'windowMenu' }];
}
