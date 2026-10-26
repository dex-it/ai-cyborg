import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hasCommandKey, isClipboardKey, isMac, shortcut } from '../src/renderer/platform';

const keys = (over: Partial<Parameters<typeof isClipboardKey>[0]>) => ({ ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, code: 'KeyC', ...over });

describe('isMac', () => {
  it('macOS - только darwin', () => {
    assert.equal(isMac('darwin'), true);
    for (const platform of ['linux', 'win32', '']) assert.equal(isMac(platform), false);
  });
});

describe('hasCommandKey', () => {
  it('на macOS нужен Cmd без Ctrl', () => {
    assert.equal(hasCommandKey({ ctrlKey: false, metaKey: true }, true), true);
    assert.equal(hasCommandKey({ ctrlKey: true, metaKey: false }, true), false);
    assert.equal(hasCommandKey({ ctrlKey: true, metaKey: true }, true), false);
  });

  it('на остальных системах нужен Ctrl без Meta', () => {
    assert.equal(hasCommandKey({ ctrlKey: true, metaKey: false }, false), true);
    assert.equal(hasCommandKey({ ctrlKey: false, metaKey: true }, false), false);
    assert.equal(hasCommandKey({ ctrlKey: true, metaKey: true }, false), false);
  });
});

describe('shortcut', () => {
  it('подпись с клавишей своей системы', () => {
    assert.equal(shortcut(true, 'Shift', 'N'), 'Cmd+Shift+N');
    assert.equal(shortcut(false, 'Shift', 'N'), 'Ctrl+Shift+N');
    assert.equal(shortcut(true, '0'), 'Cmd+0');
  });
});

describe('isClipboardKey', () => {
  it('Ctrl+Shift+C и Ctrl+Shift+V', () => {
    assert.equal(isClipboardKey(keys({ ctrlKey: true, shiftKey: true }), 'KeyC'), true);
    assert.equal(isClipboardKey(keys({ ctrlKey: true, shiftKey: true, code: 'KeyV' }), 'KeyV'), true);
  });

  it('голый Ctrl+C - прерывание, не копирование', () => {
    assert.equal(isClipboardKey(keys({ ctrlKey: true }), 'KeyC'), false);
  });

  it('другая клавиша, Alt и Meta не подходят', () => {
    assert.equal(isClipboardKey(keys({ ctrlKey: true, shiftKey: true, code: 'KeyX' }), 'KeyC'), false);
    assert.equal(isClipboardKey(keys({ ctrlKey: true, shiftKey: true, altKey: true }), 'KeyC'), false);
    assert.equal(isClipboardKey(keys({ ctrlKey: true, shiftKey: true, metaKey: true }), 'KeyC'), false);
  });
});
