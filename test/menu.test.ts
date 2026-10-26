import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MenuItemConstructorOptions } from 'electron';
import { appMenuTemplate } from '../src/main/menu';

const roles = (items: MenuItemConstructorOptions[]): string[] =>
  items.flatMap((item) => [...(item.role ? [String(item.role)] : []), ...(Array.isArray(item.submenu) ? roles(item.submenu) : [])]);

describe('appMenuTemplate', () => {
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    it(`${platform}: нет перезагрузки интерфейса и масштаба страницы`, () => {
      const present = roles(appMenuTemplate(platform)).map((r) => r.toLowerCase());
      for (const forbidden of ['reload', 'forcereload', 'zoomin', 'zoomout', 'resetzoom']) assert.ok(!present.includes(forbidden), `в меню есть ${forbidden}`);
    });

    it(`${platform}: правка и окно на месте`, () => {
      const present = roles(appMenuTemplate(platform));
      assert.ok(present.includes('editMenu'));
      assert.ok(present.includes('windowMenu'));
    });
  }

  it('macOS начинается с меню приложения, остальные системы - с меню файла', () => {
    assert.equal(appMenuTemplate('darwin')[0].role, 'appMenu');
    assert.equal(appMenuTemplate('linux')[0].role, 'fileMenu');
  });
});
