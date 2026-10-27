import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ipcErrorText } from '../src/renderer/ipc-error';

describe('ipcErrorText', () => {
  it('снимает обёртку Electron и «Error:», причина остаётся целиком', () => {
    const wrapped = new Error("Error invoking remote method 'session:create': Error: Промпт «mr.review»: text не может начинаться с «-». Исправьте файл.");
    assert.equal(ipcErrorText(wrapped), 'Промпт «mr.review»: text не может начинаться с «-». Исправьте файл.');
    assert.equal(ipcErrorText(new Error("Error invoking remote method 'a:b': Некорректный старт сессии")), 'Некорректный старт сессии');
  });
  it('прочие ошибки и не ошибки - как есть', () => {
    assert.equal(ipcErrorText(new Error('диск')), 'диск');
    assert.equal(ipcErrorText('строка'), 'строка');
    assert.equal(ipcErrorText(undefined), 'undefined');
  });
});
