import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DecModes } from '../src/agentd/term-modes';
import { OSC52_USER_WINDOW_MS, osc52Allowed, osc52Text } from '../src/renderer/osc52';

const fed = (...chunks: string[]): string => {
  const m = new DecModes();
  for (const c of chunks) m.feed(Buffer.from(c));
  return m.restore();
};

describe('DecModes: режимы терминала на начало кольца', () => {
  it('последнее значение каждого режима, альтернативный экран первым', () => {
    assert.equal(fed('\x1b[?2004h\x1b[?25l text \x1b[?1000;1006h\x1b[?1049h\x1b[?25h'), '\x1b[?1049h\x1b[?2004h\x1b[?25h\x1b[?1000h\x1b[?1006h');
  });

  it('последовательность, разрезанная границей кусков, учитывается', () => {
    assert.equal(fed('abc\x1b', '[?20', '04h'), '\x1b[?2004h');
  });

  it('выключенный режим восстанавливается выключенным, RIS в выводе снимает прежние', () => {
    assert.equal(fed('\x1b[?2004h\x1b[?2004l'), '\x1b[?2004l');
    assert.equal(fed('\x1b[?2004h\x1bc\x1b[?1004h'), '\x1b[?1004h');
  });

  it('обычные CSI и OSC режимами не считаются', () => {
    assert.equal(fed('\x1b[0m\x1b[2J\x1b]0;?2004h\x07\x1b[>4;1m'), '');
  });
});

describe('osc52Text: запись в буфер обмена из OSC 52', () => {
  it('base64 в UTF-8 декодируется', () => {
    assert.equal(osc52Text(`c;${Buffer.from('копия\nтекста').toString('base64')}`), 'копия\nтекста');
    assert.equal(osc52Text('c;'), '');
  });

  it('запрос чтения, негодный base64 и тело без цели - не запись', () => {
    assert.equal(osc52Text('c;?'), undefined);
    assert.equal(osc52Text('c;не base64'), undefined);
    assert.equal(osc52Text(Buffer.from('abc').toString('base64')), undefined);
    assert.equal(osc52Text(`c;${Buffer.from([0xff, 0xfe]).toString('base64')}`), undefined);
  });

  it('запись сверх предела размера отклоняется', () => {
    assert.equal(osc52Text(`c;${'A'.repeat(4 * 1024 * 1024 + 4)}`), undefined);
  });

  it('запись принимается от терминала в фокусе и только вскоре после действия человека', () => {
    assert.equal(osc52Allowed(true, 1000 + OSC52_USER_WINDOW_MS, 1000), true);
    assert.equal(osc52Allowed(true, 1001 + OSC52_USER_WINDOW_MS, 1000), false, 'вывод без действия человека буфер не подменяет');
    assert.equal(osc52Allowed(false, 1100, 1000), false, 'терминал не в фокусе');
    assert.equal(osc52Allowed(true, 1000, -Infinity), false, 'человек ещё ничего не нажимал');
  });
});
