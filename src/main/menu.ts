import type { MenuItemConstructorOptions } from 'electron';
import path from 'node:path';

export const NOTIFICATIONS_MENU_ID = 'notifications';
export const PROJECT_NEW_MENU_ID = 'project-new';
export const PROJECT_PROPERTIES_MENU_ID = 'project-properties';
export const COMMANDS_MENU_ID = 'commands-edit';
export const PROMPTS_MENU_ID = 'prompts-edit';
export type SearchMode = 'files' | 'text' | 'changes';
/** Пункты меню «Поиск» по режимам; доступны, пока выбран проект. */
export const SEARCH_MENU_IDS: Record<SearchMode, string> = { files: 'search-files', text: 'search-text', changes: 'search-changes' };

export type ExtensionsTab = 'marketplaces' | 'installed' | 'mcp' | 'hubs';
/** Пункты меню «Расширения» по вкладкам окна; доступны, пока выбран проект. */
export const EXTENSIONS_MENU_IDS: Record<ExtensionsTab, string> = {
  marketplaces: 'extensions-marketplaces',
  installed: 'extensions-installed',
  mcp: 'extensions-mcp',
  hubs: 'extensions-hubs',
};

/** Подпись пункта «Недавних»: домашний каталог - «~». */
export function recentLabel(file: string, home: string): string {
  return home && (file === home || file.startsWith(home + path.sep)) ? `~${file.slice(home.length)}` : file;
}

export interface WorkspaceMenu {
  recent: string[];
  home: string;
  hasWorkspace: boolean;
  hasProject: boolean;
  replace(): void;
  open(): void;
  create(): void;
  openRecent(file: string): void;
  newProject(): void;
  editProject(): void;
  editCommands(): void;
  editPrompts(): void;
  search(mode: SearchMode): void;
  extensions(tab: ExtensionsTab): void;
}

/**
 * Меню приложения без Reload и масштаба страницы. Перезагрузка интерфейса оставляла работающие сессии в главном процессе
 * без вкладок: они не видны, не закрываются и мешают сменить ветку. Масштаб страницы (Cmd/Ctrl+0, +, -) занят
 * масштабом шрифта приложения. Стандартные роли остаются: правка (копирование и вставка в терминале macOS - Cmd+C/V),
 * окно, инструменты разработчика. Выход - не роль, а `quit`: вызывающий сначала спрашивает подтверждение, пока идут сессии.
 * Окна настроек нет, поэтому выключатель уведомлений о ждущих сессиях живёт в «Вид»; состояние галочки выставляет интерфейс.
 * Подписи заданы явно: стандартные роли Electron подписывает по-английски независимо от языка системы.
 * «Воркспейс» ведёт воркспейсами и проектами («Открыть…» меняет воркспейс этого окна, завершая его сессии): проект выбирается на панели, а создаётся и правится отсюда; там же правка кнопок команд.
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
  const quitItem: MenuItemConstructorOptions = { label: 'Выход', accelerator: 'CmdOrCtrl+Q', click: quit };
  const first: MenuItemConstructorOptions =
    platform === 'darwin'
      ? {
          label: 'Cyborg',
          submenu: [
            { role: 'about', label: 'О программе Cyborg' },
            { type: 'separator' },
            { role: 'services', label: 'Службы' },
            { type: 'separator' },
            { role: 'hide', label: 'Скрыть Cyborg' },
            { role: 'hideOthers', label: 'Скрыть остальные' },
            { role: 'unhide', label: 'Показать все' },
            { type: 'separator' },
            quitItem,
          ],
        }
      : { label: 'Файл', submenu: [{ role: 'close', label: 'Закрыть окно' }, quitItem] };
  const editMenu: MenuItemConstructorOptions = {
    role: 'editMenu',
    label: 'Правка',
    submenu: [
      { role: 'undo', label: 'Отменить' },
      { role: 'redo', label: 'Повторить' },
      { type: 'separator' },
      { role: 'cut', label: 'Вырезать' },
      { role: 'copy', label: 'Копировать' },
      { role: 'paste', label: 'Вставить' },
      { role: 'selectAll', label: 'Выделить всё' },
    ],
  };
  const windowMenu: MenuItemConstructorOptions = {
    role: 'windowMenu',
    label: 'Окно',
    submenu: [
      { role: 'minimize', label: 'Свернуть' },
      ...(platform === 'darwin' ? [{ role: 'zoom', label: 'Изменить масштаб окна' } as MenuItemConstructorOptions] : []),
      { role: 'close', label: 'Закрыть окно' },
    ],
  };
  const recent: MenuItemConstructorOptions[] = workspace.recent.length
    ? workspace.recent.map((file) => ({ label: recentLabel(file, workspace.home), click: () => workspace.openRecent(file) }))
    : [{ label: 'Нет недавних', enabled: false }];
  const workspaceMenu: MenuItemConstructorOptions = {
    label: 'Воркспейс',
    submenu: [
      { label: 'Открыть…', click: () => workspace.replace() },
      { label: 'Открыть в новом окне…', click: () => workspace.open() },
      { label: 'Создать…', click: () => workspace.create() },
      { label: 'Недавние', submenu: recent },
      { type: 'separator' },
      { id: PROJECT_NEW_MENU_ID, label: 'Новый проект', enabled: workspace.hasWorkspace, click: () => workspace.newProject() },
      { id: PROJECT_PROPERTIES_MENU_ID, label: 'Свойства проекта', enabled: workspace.hasProject, click: () => workspace.editProject() },
      { type: 'separator' },
      { id: COMMANDS_MENU_ID, label: 'Кнопки команд…', enabled: workspace.hasWorkspace, click: () => workspace.editCommands() },
      { id: PROMPTS_MENU_ID, label: 'Промпты кнопок…', click: () => workspace.editPrompts() },
    ],
  };
  const viewMenu: MenuItemConstructorOptions = {
    label: 'Вид',
    submenu: [notificationsItem, { type: 'separator' }, { role: 'toggleDevTools', label: 'Инструменты разработчика' }, { role: 'togglefullscreen', label: 'Во весь экран' }],
  };
  // Ctrl+P в терминале Linux - клавиша readline (предыдущая команда), поэтому там окно поиска вызывается с Shift.
  const searchMenu: MenuItemConstructorOptions = {
    label: 'Поиск',
    submenu: [
      {
        id: SEARCH_MENU_IDS.files,
        label: 'Найти файл…',
        accelerator: platform === 'darwin' ? 'Cmd+P' : 'Ctrl+Shift+P',
        enabled: workspace.hasProject,
        click: () => workspace.search('files'),
      },
      {
        id: SEARCH_MENU_IDS.text,
        label: 'Найти в файлах…',
        accelerator: 'CmdOrCtrl+Shift+F',
        enabled: workspace.hasProject,
        click: () => workspace.search('text'),
      },
      {
        id: SEARCH_MENU_IDS.changes,
        label: 'Найти в изменениях…',
        accelerator: 'CmdOrCtrl+Shift+D',
        enabled: workspace.hasProject,
        click: () => workspace.search('changes'),
      },
    ],
  };
  const extensionsMenu: MenuItemConstructorOptions = {
    label: 'Расширения',
    submenu: [
      { id: EXTENSIONS_MENU_IDS.marketplaces, label: 'Магазины…', accelerator: 'CmdOrCtrl+Shift+X', enabled: workspace.hasProject, click: () => workspace.extensions('marketplaces') },
      { id: EXTENSIONS_MENU_IDS.installed, label: 'Установленные плагины и скиллы…', enabled: workspace.hasProject, click: () => workspace.extensions('installed') },
      { id: EXTENSIONS_MENU_IDS.mcp, label: 'Серверы MCP…', enabled: workspace.hasProject, click: () => workspace.extensions('mcp') },
      { type: 'separator' },
      { id: EXTENSIONS_MENU_IDS.hubs, label: 'Хабы магазинов…', enabled: workspace.hasProject, click: () => workspace.extensions('hubs') },
    ],
  };
  return [first, workspaceMenu, editMenu, searchMenu, extensionsMenu, viewMenu, windowMenu];
}
