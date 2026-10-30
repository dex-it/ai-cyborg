import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MenuItemConstructorOptions } from 'electron';
import fs from 'node:fs';
import { appMenuTemplate, recentLabel, COMMANDS_MENU_ID, NOTIFICATIONS_MENU_ID, PROJECT_NEW_MENU_ID, PROJECT_PROPERTIES_MENU_ID, PROMPTS_MENU_ID, SEARCH_MENU_IDS, EXTENSIONS_MENU_IDS, type ExtensionsTab, type SearchMode, type WorkspaceMenu } from '../src/main/menu';

const roles = (items: MenuItemConstructorOptions[]): string[] =>
  items.flatMap((item) => [...(item.role ? [String(item.role)] : []), ...(Array.isArray(item.submenu) ? roles(item.submenu) : [])]);

const notifications = () => {};

const workspaceMenu = (over: Partial<WorkspaceMenu> = {}): WorkspaceMenu => ({
  recent: [],
  home: '/home/u',
  hasWorkspace: true,
  hasProject: true,
  replace() {},
  open() {},
  create() {},
  openRecent() {},
  newProject() {},
  editProject() {},
  editCommands() {},
  editPrompts() {},
  search() {},
  extensions() {},
  ...over,
});

const submenu = (item: MenuItemConstructorOptions | undefined): MenuItemConstructorOptions[] => (item?.submenu ?? []) as MenuItemConstructorOptions[];
const workspaceItems = (platform: NodeJS.Platform, over: Partial<WorkspaceMenu> = {}) =>
  submenu(appMenuTemplate(platform, () => {}, notifications, workspaceMenu(over)).find((item) => item.label === 'Воркспейс'));

describe('appMenuTemplate', () => {
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    it(`${platform}: нет перезагрузки интерфейса и масштаба страницы`, () => {
      const present = roles(appMenuTemplate(platform, () => {}, notifications, workspaceMenu())).map((r) => r.toLowerCase());
      for (const forbidden of ['reload', 'forcereload', 'zoomin', 'zoomout', 'resetzoom']) assert.ok(!present.includes(forbidden), `в меню есть ${forbidden}`);
    });

    it(`${platform}: правка и окно на месте`, () => {
      const present = roles(appMenuTemplate(platform, () => {}, notifications, workspaceMenu()));
      assert.ok(present.includes('editMenu'));
      assert.ok(present.includes('windowMenu'));
      for (const role of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll', 'minimize', 'close']) assert.ok(present.includes(role), `нет роли ${role}`);
    });

    it(`${platform}: подписи меню по-русски, ни один пункт не остаётся с английской подписью роли`, () => {
      const unlabeled = (items: MenuItemConstructorOptions[]): string[] =>
        items.flatMap((item) => [
          ...(item.type !== 'separator' && !item.label ? [String(item.role)] : []),
          ...(item.label && /[A-Za-z]/.test(item.label.replace('Cyborg', '').replace('MCP', '')) ? [item.label] : []),
          ...(Array.isArray(item.submenu) ? unlabeled(item.submenu) : []),
        ]);
      assert.deepEqual(unlabeled(appMenuTemplate(platform, () => {}, notifications, workspaceMenu())), []);
    });
  }

  it('выход - пункт с Cmd/Ctrl+Q, который вызывает переданную функцию, а не роль quit', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      let calls = 0;
      const items = (appMenuTemplate(platform, () => calls++, notifications, workspaceMenu())[0].submenu ?? []) as MenuItemConstructorOptions[];
      const quit = items.find((item) => item.accelerator === 'CmdOrCtrl+Q');
      assert.ok(quit, `${platform}: нет пункта выхода`);
      assert.equal(quit.role, undefined);
      (quit.click as () => void)();
      assert.equal(calls, 1);
    }
  });

  it('выключатель уведомлений - галочка в «Вид» с известным id, клик передаёт новое состояние', () => {
    const set: boolean[] = [];
    const view = appMenuTemplate('linux', () => {}, (value) => set.push(value), workspaceMenu()).find((item) => item.label === 'Вид');
    const toggle = ((view?.submenu ?? []) as MenuItemConstructorOptions[]).find((item) => item.id === NOTIFICATIONS_MENU_ID);
    assert.ok(toggle, 'нет выключателя уведомлений');
    assert.equal(toggle.type, 'checkbox');
    (toggle.click as (item: { checked: boolean }) => void)({ checked: false });
    assert.deepEqual(set, [false]);
  });

  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    it(`${platform}: «Воркспейс» с восемью пунктами в заданном порядке`, () => {
      const labels = workspaceItems(platform).filter((item) => item.type !== 'separator').map((item) => item.label);
      assert.deepEqual(labels, ['Открыть…', 'Открыть в новом окне…', 'Создать…', 'Недавние', 'Новый проект', 'Свойства проекта', 'Кнопки команд…', 'Промпты кнопок…']);
    });
  }

  it('без выбранного проекта «Свойства проекта» недоступны, без воркспейса недоступен «Новый проект»', () => {
    const byId = (items: MenuItemConstructorOptions[], id: string) => items.find((item) => item.id === id);
    assert.equal(byId(workspaceItems('linux', { hasProject: false }), PROJECT_PROPERTIES_MENU_ID)?.enabled, false);
    assert.equal(byId(workspaceItems('linux', { hasProject: true }), PROJECT_PROPERTIES_MENU_ID)?.enabled, true);
    assert.equal(byId(workspaceItems('linux', { hasWorkspace: false }), PROJECT_NEW_MENU_ID)?.enabled, false);
    assert.equal(byId(workspaceItems('linux'), PROJECT_NEW_MENU_ID)?.enabled, true);
  });

  it('«Кнопки команд…» недоступны без воркспейса и вызывают правку', () => {
    const byId = (items: MenuItemConstructorOptions[], id: string) => items.find((item) => item.id === id);
    assert.equal(byId(workspaceItems('linux', { hasWorkspace: false }), COMMANDS_MENU_ID)?.enabled, false);
    const calls: string[] = [];
    const item = byId(workspaceItems('darwin', { editCommands: () => calls.push('commands') }), COMMANDS_MENU_ID);
    assert.equal(item?.label, 'Кнопки команд…');
    assert.equal(item?.enabled, true);
    (item?.click as () => void)();
    assert.deepEqual(calls, ['commands']);
  });

  it('«Промпты кнопок…» общие для воркспейсов: доступны и без воркспейса, вызывают правку', () => {
    const byId = (items: MenuItemConstructorOptions[], id: string) => items.find((item) => item.id === id);
    assert.notEqual(byId(workspaceItems('linux', { hasWorkspace: false }), PROMPTS_MENU_ID)?.enabled, false);
    const calls: string[] = [];
    const item = byId(workspaceItems('darwin', { editPrompts: () => calls.push('prompts') }), PROMPTS_MENU_ID);
    assert.equal(item?.label, 'Промпты кнопок…');
    assert.notEqual(item?.enabled, false);
    (item?.click as () => void)();
    assert.deepEqual(calls, ['prompts']);
  });

  describe('меню «Поиск»', () => {
    const searchItems = (platform: NodeJS.Platform, over: Partial<WorkspaceMenu> = {}) =>
      submenu(appMenuTemplate(platform, () => {}, notifications, workspaceMenu(over)).find((item) => item.label === 'Поиск'));
    const searchItem = (mode: SearchMode, platform: NodeJS.Platform = 'darwin', over: Partial<WorkspaceMenu> = {}) =>
      searchItems(platform, over).find((item) => item.id === SEARCH_MENU_IDS[mode]);

    it('три пункта: файл, содержимое, изменения - с подписями и сочетаниями', () => {
      assert.deepEqual(searchItems('darwin').map((i) => i.label), ['Найти файл…', 'Найти в файлах…', 'Найти в изменениях…']);
      assert.equal(searchItem('files', 'darwin')?.accelerator, 'Cmd+P');
      assert.equal(searchItem('files', 'linux')?.accelerator, 'Ctrl+Shift+P', 'Ctrl+P в терминале Linux - readline');
      for (const platform of ['darwin', 'linux'] as const) {
        assert.equal(searchItem('text', platform)?.accelerator, 'CmdOrCtrl+Shift+F');
        assert.equal(searchItem('changes', platform)?.accelerator, 'CmdOrCtrl+Shift+D');
      }
    });

    it('сочетания не повторяются и не занимают «Новую сессию» и выход', () => {
      const keys = searchItems('linux').map((i) => i.accelerator);
      assert.equal(new Set(keys).size, keys.length);
      for (const taken of ['CmdOrCtrl+Shift+N', 'CmdOrCtrl+Q', 'CmdOrCtrl+0']) assert.ok(!keys.includes(taken as never));
    });

    it('доступны только при проекте и вызывают переданную функцию со своим режимом', () => {
      for (const mode of ['files', 'text', 'changes'] as const) {
        assert.equal(searchItem(mode, 'linux', { hasProject: false })?.enabled, false, mode);
        const calls: string[] = [];
        const item = searchItem(mode, 'darwin', { search: (m) => calls.push(m) });
        assert.equal(item?.enabled, true);
        (item?.click as () => void)();
        assert.deepEqual(calls, [mode]);
      }
    });
  });

  describe('меню «Расширения»', () => {
    const items = (platform: NodeJS.Platform, over: Partial<WorkspaceMenu> = {}) =>
      submenu(appMenuTemplate(platform, () => {}, notifications, workspaceMenu(over)).find((item) => item.label === 'Расширения'));

    it('пункты по вкладкам окна, сочетание у магазинов и никакого повтора', () => {
      const found = items('linux');
      assert.deepEqual(found.filter((i) => i.id).map((i) => i.id), Object.values(EXTENSIONS_MENU_IDS));
      assert.equal(found.find((i) => i.id === EXTENSIONS_MENU_IDS.marketplaces)?.accelerator, 'CmdOrCtrl+Shift+X');
      const keys = found.map((i) => i.accelerator).filter(Boolean);
      assert.equal(new Set(keys).size, keys.length);
      const search = submenu(appMenuTemplate('linux', () => {}, notifications, workspaceMenu()).find((i) => i.label === 'Поиск')).map((i) => i.accelerator);
      for (const key of keys) assert.ok(!search.includes(key as never), `${key} занято поиском`);
    });

    it('доступны только при проекте и открывают свою вкладку', () => {
      for (const tab of ['marketplaces', 'installed', 'mcp', 'hubs'] as ExtensionsTab[]) {
        const id = EXTENSIONS_MENU_IDS[tab];
        assert.equal(items('linux', { hasProject: false }).find((i) => i.id === id)?.enabled, false, tab);
        const calls: string[] = [];
        const item = items('darwin', { extensions: (t) => calls.push(t) }).find((i) => i.id === id);
        assert.equal(item?.enabled, true);
        (item?.click as () => void)();
        assert.deepEqual(calls, [tab]);
      }
    });
  });

  it('клики вызывают переданные функции, «Недавние» отдают путь', () => {
    const calls: string[] = [];
    const items = workspaceItems('linux', {
      recent: ['/home/u/a.cyborg.json', '/srv/b.json'],
      open: () => calls.push('open'),
      create: () => calls.push('create'),
      newProject: () => calls.push('new'),
      editProject: () => calls.push('edit'),
      openRecent: (file) => calls.push(`recent:${file}`),
    });
    for (const item of items) (item.click as (() => void) | undefined)?.();
    const recent = submenu(items.find((item) => item.label === 'Недавние'));
    assert.deepEqual(recent.map((item) => item.label), ['~/a.cyborg.json', '/srv/b.json']);
    (recent[1].click as () => void)();
    assert.deepEqual(calls, ['open', 'create', 'new', 'edit', 'recent:/srv/b.json']);
  });

  it('пустые «Недавние» - один недоступный пункт «Нет недавних»', () => {
    const recent = submenu(workspaceItems('linux').find((item) => item.label === 'Недавние'));
    assert.deepEqual(recent.map((item) => [item.label, item.enabled]), [['Нет недавних', false]]);
  });

  it('пересборка меню сохраняет состояние галочки уведомлений', () => {
    const view = appMenuTemplate('linux', () => {}, notifications, workspaceMenu(), false).find((item) => item.label === 'Вид');
    assert.equal(submenu(view).find((item) => item.id === NOTIFICATIONS_MENU_ID)?.checked, false);
  });

  it('подпись недавнего: домашний каталог - «~»', () => {
    assert.equal(recentLabel('/home/u/a.cyborg.json', '/home/u'), '~/a.cyborg.json');
    assert.equal(recentLabel('/srv/a.cyborg.json', '/home/u'), '/srv/a.cyborg.json');
  });
  it('шаблон меню не зависит от слоя хранения', () => {
    assert.ok(!/from '\.\/workspaces'/.test(fs.readFileSync('src/main/menu.ts', 'utf8')));
  });
});
