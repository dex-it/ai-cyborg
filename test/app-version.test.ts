import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatVersion } from '../scripts/app-version.mjs';

describe('formatVersion', () => {
  it('патч заменяет дата коммита ДДММ, за ней через дефис хеш', () => {
    assert.equal(formatVersion('0.1.0', { date: new Date(2026, 10, 8, 23, 59), hash: '5c98807' }), '0.1.0811-5c98807');
  });

  it('день и месяц из одной цифры дополняются нулём', () => {
    assert.equal(formatVersion('2.3.7', { date: new Date(2027, 0, 5), hash: 'abc1234' }), '2.3.0501-abc1234');
  });

  it('без коммита версия из package.json как есть', () => {
    assert.equal(formatVersion('0.1.0', null), '0.1.0');
  });
});
