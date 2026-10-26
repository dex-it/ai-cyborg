import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateNotifyArgs } from '../src/main/notify-args';

describe('validateNotifyArgs', () => {
  it('принимает номер сессии, заголовок и текст', () => {
    assert.deepEqual(validateNotifyArgs(3, 'CC3 · проект', 'ждёт'), { id: 3, title: 'CC3 · проект', body: 'ждёт' });
    assert.deepEqual(validateNotifyArgs(0, 'CC0', ''), { id: 0, title: 'CC0', body: '' });
  });

  it('отвергает не числа, дроби, отрицательные и нечисловые номера', () => {
    for (const id of ['1', 1.5, -1, NaN, Infinity, null, undefined, {}, [1]]) assert.equal(validateNotifyArgs(id, 'CC', 'x'), null, String(id));
  });

  it('отвергает заголовок и текст не строкой, пустой заголовок тоже', () => {
    for (const bad of [1, null, undefined, {}, ['a']]) {
      assert.equal(validateNotifyArgs(1, bad, 'x'), null);
      assert.equal(validateNotifyArgs(1, 'CC', bad), null);
    }
    assert.equal(validateNotifyArgs(1, '   ', 'x'), null);
  });

  it('обрезает длинные заголовок и текст с многоточием', () => {
    const args = validateNotifyArgs(1, 'я'.repeat(1000), 'ы'.repeat(1000))!;
    assert.equal(args.title.length, 200);
    assert.equal(args.body.length, 300);
    assert.ok(args.title.endsWith('…') && args.body.endsWith('…'));
    assert.equal(validateNotifyArgs(1, 'я'.repeat(200), 'ы'.repeat(300))!.body.length, 300);
    assert.ok(!validateNotifyArgs(1, 'я'.repeat(200), 'ы'.repeat(300))!.body.endsWith('…'));
  });
});
