import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_FONT_SIZE, parseFontSize, stepFontSize, WHEEL_IDLE_MS, WHEEL_STEP_PX, WheelStepper } from '../src/renderer/font-size';

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

describe('WheelStepper', () => {
  it('деление колеса мыши (deltaY 100) - ровно один шаг, в обе стороны', () => {
    const w = new WheelStepper();
    assert.equal(w.push(-100, 0), -1);
    assert.equal(w.push(100, 1000), 1);
    assert.equal(w.push(-100, 2000), -1);
  });

  it('тачпад: жест из сорока событий по -3 пикселя - один шаг, а не сорок', () => {
    const w = new WheelStepper();
    let steps = 0;
    for (let i = 0; i < 40; i++) steps += Math.abs(w.push(-3, i * 16));
    assert.equal(steps, 1, '120 пикселей прокрутки: один шаг');
  });

  it('размер растёт пропорционально прокрутке жеста, а не числу событий', () => {
    const w = new WheelStepper();
    let size = 13;
    for (let i = 0; i < 100; i++) size = stepFontSize(size, w.push(-5, i * 8));
    assert.equal(size, 13 + 5, '500 пикселей: пять шагов');
  });

  it('мелкая прокрутка, не набравшая шага, размер не меняет', () => {
    const w = new WheelStepper();
    for (let i = 0; i < 10; i++) assert.equal(w.push(-4, i * 10), 0);
  });

  it('смена направления и пауза сбрасывают накопленное', () => {
    const w = new WheelStepper();
    assert.equal(w.push(-80, 0), 0);
    assert.equal(w.push(60, 10), 0, 'обратное направление начинает счёт заново');
    assert.equal(w.push(60, 20), 1);
    assert.equal(w.push(-80, 100), 0);
    assert.equal(w.push(-80, 100 + WHEEL_IDLE_MS + 1), 0, 'после паузы остаток прошлого жеста не доедает');
  });

  it('горизонтальная прокрутка (deltaY 0) шага не даёт и накопленное не трогает', () => {
    const w = new WheelStepper();
    assert.equal(w.push(-60, 0), 0);
    assert.equal(w.push(0, 10), 0);
    assert.equal(w.push(-60, 20), -1);
    assert.ok(WHEEL_STEP_PX > 0);
  });
});
