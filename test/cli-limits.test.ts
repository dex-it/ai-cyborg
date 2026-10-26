import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CLI_LIMITS, createCliRunner } from '../src/main/trackers';

// Раннер запускает любую команду: подставляется сам node, чтобы проверить перевод его отказов (таймаут, переполнение) в failure.
const node = process.execPath as 'gh';

describe('пределы одного вызова gh и glab (NFR-1003)', () => {
  it('не больше 120 с ожидания и 64 МБ ответа', () => {
    assert.deepEqual(CLI_LIMITS, { timeoutMs: 120_000, maxBuffer: 64 * 1024 * 1024 });
  });

  it('вызов дольше предела - failure timeout', async () => {
    const run = createCliRunner(process.cwd(), { timeoutMs: 200, maxBuffer: CLI_LIMITS.maxBuffer });
    const result = await run(node, ['-e', 'setTimeout(() => {}, 10000)']);
    assert.equal(result.failure, 'timeout');
  });

  it('ответ больше предела - failure overflow', async () => {
    const run = createCliRunner(process.cwd(), { timeoutMs: CLI_LIMITS.timeoutMs, maxBuffer: 1024 });
    const result = await run(node, ['-e', 'process.stdout.write("x".repeat(100000))']);
    assert.equal(result.failure, 'overflow');
  });

  it('вызов в пределах - ответ без failure', async () => {
    const run = createCliRunner(process.cwd());
    const result = await run(node, ['-e', 'process.stdout.write("ok")']);
    assert.equal(result.failure, undefined);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, 'ok');
  });
});
