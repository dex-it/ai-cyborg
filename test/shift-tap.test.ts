import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { APP_SELECTION_MS, AppSelection, SHIFT_TAP_MS, ShiftTap, type KeyLike } from '../src/renderer/shift-tap';

const key = (type: string, k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ type, key: k, ctrlKey: false, altKey: false, metaKey: false, ...mods });

describe('нажатие Shift при выделении', () => {
  it('Shift нажат и отпущен при выделении - срабатывает один раз', () => {
    const tap = new ShiftTap();
    assert.equal(tap.key(key('keydown', 'Shift'), 0, true), false);
    assert.equal(tap.key(key('keyup', 'Shift'), 120, true), true);
    assert.equal(tap.key(key('keyup', 'Shift'), 130, true), false);
  });

  it('без выделения, с другой клавишей, модификатором или долгим удержанием - нет', () => {
    const tap = new ShiftTap();
    tap.key(key('keydown', 'Shift'), 0, false);
    assert.equal(tap.key(key('keyup', 'Shift'), 50, true), false);
    tap.key(key('keydown', 'Shift'), 0, true);
    tap.key(key('keydown', 'A'), 10, true);
    assert.equal(tap.key(key('keyup', 'Shift'), 50, true), false, 'Shift+A - набор текста');
    tap.key(key('keydown', 'Shift', { ctrlKey: true }), 0, true);
    assert.equal(tap.key(key('keyup', 'Shift'), 50, true), false, 'Ctrl+Shift - сочетание');
    tap.key(key('keydown', 'Shift'), 0, true);
    assert.equal(tap.key(key('keyup', 'Shift'), SHIFT_TAP_MS + 1, true), false);
  });

  it('щелчок мыши при зажатом Shift - выделение, а не нажатие', () => {
    const tap = new ShiftTap();
    tap.key(key('keydown', 'Shift'), 0, true);
    tap.pointer();
    assert.equal(tap.key(key('keyup', 'Shift'), 100, true), false);
  });

  it('автоповтор keydown не сдвигает начало, выделение снято к отпусканию - нет', () => {
    const tap = new ShiftTap();
    tap.key(key('keydown', 'Shift'), 0, true);
    tap.key(key('keydown', 'Shift', { repeat: true }), SHIFT_TAP_MS - 10, true);
    assert.equal(tap.key(key('keyup', 'Shift'), SHIFT_TAP_MS + 5, true), false);
    tap.key(key('keydown', 'Shift'), 0, true);
    assert.equal(tap.key(key('keyup', 'Shift'), 50, false), false);
  });
});

describe('выделение, которое ведёт сама программа в терминале', () => {
  it('копия через OSC 52 - живое выделение с текстом; щелчок, клавиша или срок его снимают', () => {
    const app = new AppSelection();
    app.pointerDown(0, 0);
    app.pointerUp(100, 0, 10, false);
    app.copied('фрагмент', 20);
    assert.equal(app.copiedText(30), 'фрагмент');
    app.key('Shift');
    assert.equal(app.live(30), true, 'сам Shift выделение не снимает');
    assert.equal(app.live(20 + APP_SELECTION_MS + 1), false);
    app.key('a');
    assert.equal(app.live(30), false);
    app.copied('снова', 40);
    app.pointerDown(5, 5);
    assert.equal(app.live(41), false);
  });

  it('протяжка без выделения в xterm и без OSC 52 - живое выделение без текста (читать системный буфер)', () => {
    const app = new AppSelection();
    app.pointerDown(0, 0);
    app.pointerUp(50, 10, 100, false);
    assert.equal(app.live(200), true);
    assert.equal(app.copiedText(200), undefined);
    app.pointerDown(0, 0);
    app.pointerUp(1, 1, 300, false);
    assert.equal(app.live(310), false, 'щелчок без протяжки - не выделение');
    app.pointerDown(0, 0);
    app.pointerUp(80, 0, 400, true);
    assert.equal(app.live(410), false, 'выделение в xterm берётся у xterm');
  });
});
