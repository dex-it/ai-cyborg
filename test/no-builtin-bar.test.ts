import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_COMMANDS, resolveBar } from '../src/main/commands';

describe('Полоса без встроенных кнопок', () => {
  it('без файлов полоса пуста', () => {
    assert.deepEqual(DEFAULT_COMMANDS, []);
    const r = resolveBar({ global: undefined, workspace: undefined }, false);
    assert.deepEqual(r.buttons, []);
  });

  it('кнопка общего слоя появляется сама, а не поверх встроенной', () => {
    const r = resolveBar({ global: [{ label: 'Сливай', text: 'слей', submit: true, hotkey: 'F1' }], workspace: undefined }, false);
    assert.deepEqual(r.rows.map((x) => [x.label, x.origin]), [['Сливай', 'global']]);
  });
});
