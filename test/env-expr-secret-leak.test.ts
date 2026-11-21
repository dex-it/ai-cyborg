import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ID, expr, literal, managed } from './env-rig';

const SECRET = 'sk-test-SECRET-123';

describe('ManagedEnv: значение выражения не утекает через вывод ошибки', () => {
  for (const [title, command] of [
    ['"$(printf <секрет>)": оболочка называет секрет ненайденной программой', `"$(printf ${SECRET})"`],
    ['set -x печатает значение в stderr, команда падает', `set -x; X=$(printf ${SECRET}); false`],
  ] as const) {
    it(`${title}: секрета нет ни в состоянии окна, ни в ответе select; вывод отдаётся только по запросу`, async (t) => {
      const { env } = managed(t, [{ name: 'ENVT_TOKEN', candidates: [expr(1, command)] }]);
      const result = await env.select('ENVT_TOKEN', ID(1));
      assert.deepEqual(result, { ok: false, reason: 'exit' });
      assert.equal(env.overlay().set.has('ENVT_TOKEN'), false);
      assert.deepEqual(env.view().vars[0].status, { kind: 'failed', reason: 'команда завершилась с ошибкой', output: true });
      assert.ok(env.failureOutput('ENVT_TOKEN')?.includes(SECRET));
    });
  }

  it('вывод ошибки пропадает вместе со статусом: успешный выбор, «не трогать», отмена', async (t) => {
    const { env } = managed(t, [{ name: 'ENVT_TOKEN', candidates: [expr(1, `"$(printf ${SECRET})"`), literal(2, 'v')] }]);
    await env.select('ENVT_TOKEN', ID(1));
    await env.select('ENVT_TOKEN', ID(2));
    assert.equal(env.failureOutput('ENVT_TOKEN'), null);
    await env.select('ENVT_TOKEN', ID(1));
    env.untouch('ENVT_TOKEN');
    assert.equal(env.failureOutput('ENVT_TOKEN'), null);
  });

  it('стартовое вычисление: вывод ошибки тоже не уходит в состояние окна', async (t) => {
    const { env } = managed(t, [{ name: 'ENVT_TOKEN', candidates: [expr(1, `"$(printf ${SECRET})"`)], choice: { kind: 'selected', candidate: ID(1) } }]);
    await env.start();
    assert.deepEqual(env.view().vars[0].status, { kind: 'failed', reason: 'команда завершилась с ошибкой', output: true });
    assert.ok(env.failureOutput('ENVT_TOKEN')?.includes(SECRET));
  });
});
