import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MenuItemConstructorOptions } from 'electron';
import { appMenuTemplate, NOTIFICATIONS_MENU_ID } from '../src/main/menu';

const roles = (items: MenuItemConstructorOptions[]): string[] =>
  items.flatMap((item) => [...(item.role ? [String(item.role)] : []), ...(Array.isArray(item.submenu) ? roles(item.submenu) : [])]);

const notifications = () => {};

describe('appMenuTemplate', () => {
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    it(`${platform}: нет перезагрузки интерфейса и масштаба страницы`, () => {
      const present = roles(appMenuTemplate(platform, () => {}, notifications)).map((r) => r.toLowerCase());
      for (const forbidden of ['reload', 'forcereload', 'zoomin', 'zoomout', 'resetzoom']) assert.ok(!present.includes(forbidden), `в меню есть ${forbidden}`);
    });

    it(`${platform}: правка и окно на месте`, () => {
      const present = roles(appMenuTemplate(platform, () => {}, notifications));
      assert.ok(present.includes('editMenu'));
      assert.ok(present.includes('windowMenu'));
    });
  }

  it('выход - пункт с Cmd/Ctrl+Q, который вызывает переданную функцию, а не роль quit', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      let calls = 0;
      const items = (appMenuTemplate(platform, () => calls++, notifications)[0].submenu ?? []) as MenuItemConstructorOptions[];
      const quit = items.find((item) => item.accelerator === 'CmdOrCtrl+Q');
      assert.ok(quit, `${platform}: нет пункта выхода`);
      assert.equal(quit.role, undefined);
      (quit.click as () => void)();
      assert.equal(calls, 1);
    }
  });

  it('выключатель уведомлений - галочка в View с известным id, клик передаёт новое состояние', () => {
    const set: boolean[] = [];
    const view = appMenuTemplate('linux', () => {}, (value) => set.push(value)).find((item) => item.label === 'View');
    const toggle = ((view?.submenu ?? []) as MenuItemConstructorOptions[]).find((item) => item.id === NOTIFICATIONS_MENU_ID);
    assert.ok(toggle, 'нет выключателя уведомлений');
    assert.equal(toggle.type, 'checkbox');
    (toggle.click as (item: { checked: boolean }) => void)({ checked: false });
    assert.deepEqual(set, [false]);
  });
});
