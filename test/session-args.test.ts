import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_INPUT_LENGTH,
  MAX_SESSION_ID,
  MAX_TERMINAL_SIZE,
  validateInputArgs,
  validateResizeArgs,
  validateSessionId,
} from '../src/main/session-args';

const notIntegers = ['1', '', 1.5, -1, -0.5, NaN, Infinity, -Infinity, null, undefined, {}, [], [1], true, 1n, () => 1];

describe('validateSessionId', () => {
  it('принимает целые от 0 до безопасного предела', () => {
    for (const id of [0, 1, 42, 2 ** 31, MAX_SESSION_ID]) assert.equal(validateSessionId(id), id, String(id));
  });

  it('отвергает не числа, дроби, отрицательные, NaN, бесконечность и число выше предела', () => {
    for (const id of [...notIntegers, MAX_SESSION_ID + 1, 1e300]) assert.equal(validateSessionId(id), null, String(id));
  });
});

describe('validateInputArgs', () => {
  it('принимает номер и строку, включая пустую, многострочную и unicode', () => {
    assert.deepEqual(validateInputArgs(1, 'ls\r'), { id: 1, data: 'ls\r' });
    assert.deepEqual(validateInputArgs(0, ''), { id: 0, data: '' });
    assert.deepEqual(validateInputArgs(2, 'строка 1\nстрока 2\r\n\t\x1b[200~вставка 😀\x1b[201~'), {
      id: 2,
      data: 'строка 1\nстрока 2\r\n\t\x1b[200~вставка 😀\x1b[201~',
    });
  });

  it('принимает вставку 200 КБ и ровно предельную длину, отвергает на единицу длиннее и 5 МБ', () => {
    assert.equal(validateInputArgs(1, 'я'.repeat(200 * 1024))?.data.length, 200 * 1024);
    assert.equal(validateInputArgs(1, 'x'.repeat(MAX_INPUT_LENGTH))?.data.length, MAX_INPUT_LENGTH);
    assert.equal(validateInputArgs(1, 'x'.repeat(MAX_INPUT_LENGTH + 1)), null);
    assert.equal(validateInputArgs(1, 'x'.repeat(5 * 1024 * 1024)), null);
  });

  it('слишком длинное отбрасывается целиком, а не обрезается', () => {
    assert.equal(validateInputArgs(1, '😀'.repeat(MAX_INPUT_LENGTH)), null);
  });

  it('отвергает данные не строкой', () => {
    for (const data of [1, 0, NaN, null, undefined, {}, { length: 1 }, ['x'], true, 1n, Buffer.from('x'), new Uint8Array(1)]) {
      assert.equal(validateInputArgs(1, data), null, String(data));
    }
  });

  it('отвергает недопустимый номер при верной строке', () => {
    for (const id of notIntegers) assert.equal(validateInputArgs(id, 'x'), null, String(id));
  });
});

describe('validateResizeArgs', () => {
  it('принимает целые 1..1000', () => {
    assert.deepEqual(validateResizeArgs(1, 120, 40), { id: 1, cols: 120, rows: 40 });
    assert.deepEqual(validateResizeArgs(0, 1, 1), { id: 0, cols: 1, rows: 1 });
    assert.deepEqual(validateResizeArgs(3, MAX_TERMINAL_SIZE, MAX_TERMINAL_SIZE), { id: 3, cols: 1000, rows: 1000 });
  });

  it('отвергает нуль, отрицательные и выход за предел на единицу', () => {
    for (const size of [0, -1, -80, MAX_TERMINAL_SIZE + 1, 65535, 65536, 1e9, 2 ** 53]) {
      assert.equal(validateResizeArgs(1, size, 24), null, `cols ${size}`);
      assert.equal(validateResizeArgs(1, 80, size), null, `rows ${size}`);
    }
  });

  it('отвергает дроби, NaN, бесконечность, строки, null, объекты и прочие типы', () => {
    for (const size of notIntegers) {
      assert.equal(validateResizeArgs(1, size, 24), null, `cols ${String(size)}`);
      assert.equal(validateResizeArgs(1, 80, size), null, `rows ${String(size)}`);
    }
    assert.equal(validateResizeArgs(1, '80', '24'), null);
    assert.equal(validateResizeArgs(1, 80.5, 24.5), null);
  });

  it('отвергает недопустимый номер при верном размере', () => {
    for (const id of notIntegers) assert.equal(validateResizeArgs(id, 80, 24), null, String(id));
  });
});
