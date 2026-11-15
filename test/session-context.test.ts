import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { contextTooltip } from '../src/renderer/session-context';

describe('подсказка вкладки: контекст сессии', () => {
  it('название, задача и последний запрос; совпавший с задачей последний не повторяется', () => {
    assert.equal(contextTooltip({ title: 'Дерево', first: 'почини', last: 'и тесты' }), 'Дерево\nЗадача: почини\nПоследний запрос: и тесты');
    assert.equal(contextTooltip({ first: 'почини', last: 'почини' }), 'Задача: почини');
    assert.equal(contextTooltip({}), '');
  });
});
