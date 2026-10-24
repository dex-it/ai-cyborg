import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_FONT_SIZE, parseFontSize, stepFontSize } from '../src/renderer/font-size';

describe('stepFontSize', () => {
  it('колесо вверх крупнее, вниз мельче на 1', () => {
    assert.equal(stepFontSize(13, -100), 14);
    assert.equal(stepFontSize(13, 3), 12);
  });

  it('нулевой deltaY (горизонтальная прокрутка) размер не меняет', () => {
    assert.equal(stepFontSize(13, 0), 13);
  });

  it('держится в пределах 8..32', () => {
    assert.equal(stepFontSize(8, 1), 8);
    assert.equal(stepFontSize(32, -1), 32);
  });
});

describe('parseFontSize', () => {
  it('сохранённое целое в пределах берётся как есть', () => {
    assert.equal(parseFontSize('18'), 18);
  });

  it('пусто, мусор, дробь и выход за пределы дают размер по умолчанию', () => {
    for (const raw of [null, '', 'abc', '13.5', '7', '33']) assert.equal(parseFontSize(raw), DEFAULT_FONT_SIZE);
  });
});
