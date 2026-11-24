import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fitBox, parseBox, SIDE_MIN } from '../src/renderer/side-geometry';

describe('место окна вопроса', () => {
  it('сохранённое место вписывается в панель другого размера', () => {
    assert.deepEqual(fitBox({ left: 900, top: 500, width: 400, height: 300 }, 1000, 600), { left: 600, top: 300, width: 400, height: 300 });
    assert.deepEqual(fitBox({ left: -50, top: -10, width: 2000, height: 900 }, 1000, 600), { left: 0, top: 0, width: 1000, height: 600 });
    assert.deepEqual(fitBox({ left: 10, top: 10, width: 50, height: 50 }, 1000, 600), { left: 10, top: 10, ...SIDE_MIN });
    assert.deepEqual(fitBox({ left: 0, top: 0, width: 400, height: 300 }, 200, 100), { left: 0, top: 0, width: 200, height: 100 }, 'панель меньше минимума');
  });

  it('из хранилища берётся только целое место', () => {
    assert.deepEqual(parseBox('{"left":1,"top":2,"width":300,"height":250}'), { left: 1, top: 2, width: 300, height: 250 });
    assert.equal(parseBox('{"left":1}'), null);
    assert.equal(parseBox('не json'), null);
    assert.equal(parseBox(null), null);
  });
});
