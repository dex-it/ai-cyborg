import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OutputGate, UNFOCUSED_FLUSH_MS } from '../src/renderer/output-gate';

function rig(focused: boolean) {
  const state = { focused };
  const writes: [string, string][] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const gate = new OutputGate<string>({
    focused: () => state.focused,
    write: (key, data) => writes.push([key, data]),
    setTimer: (fn, ms) => timers.push({ fn, ms }),
  });
  const fire = () => timers.splice(0).forEach((t) => t.fn());
  return { state, writes, timers, gate, fire };
}

describe('OutputGate', () => {
  it('в окне с фокусом пишет сразу, таймер не ставит', () => {
    const r = rig(true);
    r.gate.push('a', 'x');
    r.gate.push('a', 'y');
    assert.deepEqual(r.writes, [['a', 'x'], ['a', 'y']]);
    assert.equal(r.timers.length, 0);
  });

  it('без фокуса копит вывод и отдаёт его одной записью на сессию по одному таймеру', () => {
    const r = rig(false);
    r.gate.push('a', 'x');
    r.gate.push('b', '1');
    r.gate.push('a', 'y');
    assert.deepEqual(r.writes, []);
    assert.deepEqual(r.timers.map((t) => t.ms), [UNFOCUSED_FLUSH_MS]);
    r.fire();
    assert.deepEqual(r.writes, [['a', 'xy'], ['b', '1']]);
    r.gate.push('a', 'z');
    assert.equal(r.timers.length, 1, 'после срабатывания следующий вывод ставит новый таймер');
  });

  it('с возвратом фокуса сначала отдаёт накопленное, потом новый кусок', () => {
    const r = rig(false);
    r.gate.push('a', 'x');
    r.state.focused = true;
    r.gate.push('a', 'y');
    assert.deepEqual(r.writes, [['a', 'x'], ['a', 'y']]);
    r.fire();
    assert.deepEqual(r.writes, [['a', 'x'], ['a', 'y']], 'таймер не повторяет уже отданное');
  });

  it('flush отдаёт накопленное одной сессии, drop его выбрасывает', () => {
    const r = rig(false);
    r.gate.push('a', 'x');
    r.gate.push('b', '1');
    r.gate.flush('a');
    r.gate.drop('b');
    r.fire();
    assert.deepEqual(r.writes, [['a', 'x']]);
  });

  it('без фокуса кусок с запросом терминалу уходит сразу, вслед за накопленным', () => {
    for (const query of ['\x1b[c', '\x1b[>c', '\x1b[6n', '\x1b[?u', '\x1b[?2026$p', '\x1b[14t', '\x1b]11;?\x07', '\x1bP+q544e\x1b\\']) {
      const r = rig(false);
      r.gate.push('a', 'x');
      r.gate.push('a', `ask${query}`);
      assert.deepEqual(r.writes, [['a', 'x'], ['a', `ask${query}`]], JSON.stringify(query));
    }
    const r = rig(false);
    r.gate.push('a', '\x1b[3A\x1b[2K\x1b[38;5;174m✻ Thinking\x1b[0m\n');
    r.gate.push('a', '\x1b[s\x1b[u\x1b[>1u\x1b[<u');
    assert.deepEqual(r.writes, [], 'перерисовка спиннера, сохранение курсора и флаги клавиатуры - не запрос');
  });
});
