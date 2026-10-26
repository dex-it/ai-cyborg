import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MenuItemConstructorOptions } from 'electron';
import { appMenuTemplate, NOTIFICATIONS_MENU_ID, PROJECT_NEW_MENU_ID, PROJECT_PROPERTIES_MENU_ID, type WorkspaceMenu } from '../src/main/menu';

const roles = (items: MenuItemConstructorOptions[]): string[] =>
  items.flatMap((item) => [...(item.role ? [String(item.role)] : []), ...(Array.isArray(item.submenu) ? roles(item.submenu) : [])]);

const notifications = () => {};

const workspaceMenu = (over: Partial<WorkspaceMenu> = {}): WorkspaceMenu => ({
  recent: [],
  home: '/home/u',
  hasWorkspace: true,
  hasProject: true,
  open() {},
  create() {},
  openRecent() {},
  newProject() {},
  editProject() {},
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

  it('выключатель уведомлений - галочка в View с известным id, клик передаёт новое состояние', () => {
    const set: boolean[] = [];
    const view = appMenuTemplate('linux', () => {}, (value) => set.push(value), workspaceMenu()).find((item) => item.label === 'View');
    const toggle = ((view?.submenu ?? []) as MenuItemConstructorOptions[]).find((item) => item.id === NOTIFICATIONS_MENU_ID);
    assert.ok(toggle, 'нет выключателя уведомлений');
    assert.equal(toggle.type, 'checkbox');
    (toggle.click as (item: { checked: boolean }) => void)({ checked: false });
    assert.deepEqual(set, [false]);
  });

  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    it(`${platform}: «Воркспейс» с пятью пунктами в заданном порядке`, () => {
      const labels = workspaceItems(platform).filter((item) => item.type !== 'separator').map((item) => item.label);
      assert.deepEqual(labels, ['Открыть в новом окне…', 'Создать…', 'Недавние', 'Новый проект', 'Свойства проекта']);
    });
  }

  it('без выбранного проекта «Свойства проекта» недоступны, без воркспейса недоступен «Новый проект»', () => {
    const byId = (items: MenuItemConstructorOptions[], id: string) => items.find((item) => item.id === id);
    assert.equal(byId(workspaceItems('linux', { hasProject: false }), PROJECT_PROPERTIES_MENU_ID)?.enabled, false);
    assert.equal(byId(workspaceItems('linux', { hasProject: true }), PROJECT_PROPERTIES_MENU_ID)?.enabled, true);
    assert.equal(byId(workspaceItems('linux', { hasWorkspace: false }), PROJECT_NEW_MENU_ID)?.enabled, false);
    assert.equal(byId(workspaceItems('linux'), PROJECT_NEW_MENU_ID)?.enabled, true);
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
    const view = appMenuTemplate('linux', () => {}, notifications, workspaceMenu(), false).find((item) => item.label === 'View');
    assert.equal(submenu(view).find((item) => item.id === NOTIFICATIONS_MENU_ID)?.checked, false);
  });
});
