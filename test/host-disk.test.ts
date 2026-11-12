import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatBytes, lowSpace, readHostDisk, readPurge, type HostDisk } from '../src/shared/host-disk';
import { diskRows, diskSummary, purgeCalls, purgePlan, purgeReport } from '../src/renderer/host-disk';

const GiB = 1024 ** 3;

describe('host-disk: пороги и размеры', () => {
  it('мало места - меньше 5 ГиБ либо меньше 10 %; без данных предупреждения нет', () => {
    assert.equal(lowSpace({ free: 4 * GiB, total: 1000 * GiB }), true);
    assert.equal(lowSpace({ free: 50 * GiB, total: 1000 * GiB }), true);
    assert.equal(lowSpace({ free: 6 * GiB, total: 20 * GiB }), false);
    assert.equal(lowSpace({ free: 0, total: 0 }), false);
    assert.equal(lowSpace(null), false);
  });

  it('formatBytes: двоичные единицы, запятая, без дробей у больших чисел', () => {
    assert.equal(formatBytes(512), '512 Б');
    assert.equal(formatBytes(1.25 * GiB), '1,3 ГиБ');
    assert.equal(formatBytes(150 * 1024 ** 2), '150 МиБ');
  });
});

describe('host-disk: разбор ответа хоста', () => {
  it('управляющие символы вырезаны, чужой sid отброшен, неизвестное состояние - сирота, нечисловой размер - не посчитан', () => {
    const disk = readHostDisk('dev1', {
      free: 10,
      total: -5,
      sessions: [
        { sid: 'aaaaaaaa-1', state: 'asleep', title: 'Заголовок\x1b[31m', branch: 'feat/x', dirs: ['/loc/a', 7], lastActive: 5, bytes: 100, dirty: [{ path: '/w/a', reason: 'stash\n' }, { reason: 'без пути' }] },
        { sid: '../../etc', state: 'done' },
        { sid: 'bbbbbbbb-2', state: 'зомби', bytes: 'много' },
      ],
    });
    assert.equal(disk.total, 0);
    assert.deepEqual(disk.sessions.map((s) => s.sid), ['aaaaaaaa-1', 'bbbbbbbb-2']);
    assert.equal(disk.sessions[0].title, 'Заголовок [31m');
    assert.deepEqual(disk.sessions[0].dirs, ['/loc/a']);
    assert.deepEqual(disk.sessions[0].dirty, [{ path: '/w/a', reason: 'stash ' }]);
    assert.equal(disk.sessions[1].state, 'orphan');
    assert.equal(disk.sessions[1].bytes, null);
    assert.deepEqual(disk.sessions.map((s) => s.measured), [true, true], 'ответ демона без measured - замер был');
    assert.equal(readHostDisk('dev1', { sessions: [{ sid: 'aaaaaaaa-1', measured: false }] }).sessions[0].measured, false);
    assert.deepEqual(readPurge({ results: [{ sid: 'aaaaaaaa-1', removed: ['/w/a'], kept: [], error: 7 }] }), [{ sid: 'aaaaaaaa-1', removed: ['/w/a'], kept: [] }]);
    assert.deepEqual(readPurge(null), []);
  });
});

describe('host-disk: окно', () => {
  const now = 10 * 3_600_000;
  const disk: HostDisk = {
    host: 'dev1',
    free: 3 * GiB,
    total: 30 * GiB,
    sessions: [
      { sid: 'aaaaaaaa-1', state: 'live', title: 'идёт', branch: 'a', dirs: [], lastActive: now, bytes: 10, dirty: [], measured: true },
      { sid: 'bbbbbbbb-2', state: 'asleep', title: '', branch: 'b', dirs: [], lastActive: now - 3 * 3_600_000, bytes: 5 * GiB, dirty: [{ path: '/w/b/a', reason: 'незапушенные коммиты' }], measured: true },
      { sid: 'cccccccc-3', state: 'orphan', title: '', branch: '', dirs: [], lastActive: 0, bytes: null, dirty: [], measured: true },
      { sid: 'dddddddd-4', state: 'done', title: '', branch: '', dirs: [], lastActive: 0, bytes: null, dirty: [], measured: false },
    ],
  };

  it('строки: крупные первыми, неизмеренные в конце, работающая без флажка', () => {
    const rows = diskRows(disk, now);
    assert.deepEqual(rows.map((r) => [r.sid, r.selectable, r.state, r.size, r.active]), [
      ['bbbbbbbb-2', true, 'спит', '5,0 ГиБ', '3 ч'],
      ['aaaaaaaa-1', false, 'работает', '10 Б', 'только что'],
      ['cccccccc-3', true, 'без записи', 'не посчитан', ''],
      ['dddddddd-4', true, 'завершена', 'не посчитан', ''],
    ]);
    assert.equal(rows[3].dirty, 'не проверены');
    assert.equal(rows[0].title, 'bbbbbbbb');
    assert.equal(rows[0].dirty, 'незапушенные коммиты');
    assert.equal(diskSummary(disk), 'dev1: свободно 3,0 ГиБ из 30,0 ГиБ (10 %); не уложились в отведённое время, размер и клоны не проверены: 1');
    assert.equal(diskSummary({ ...disk, sessions: disk.sessions.slice(0, 3) }), 'dev1: свободно 3,0 ГиБ из 30,0 ГиБ (10 %)');
  });

  it('план удаления: работающая не попадает даже отмеченной, грязные пути - для второго подтверждения', () => {
    const plan = purgePlan(disk, new Set(['aaaaaaaa-1', 'bbbbbbbb-2', 'cccccccc-3', 'dddddddd-4']));
    assert.deepEqual(plan, {
      sids: ['bbbbbbbb-2', 'cccccccc-3', 'dddddddd-4'],
      dirtySids: ['bbbbbbbb-2'],
      dirty: ['/w/b/a - незапушенные коммиты'],
    });
    assert.equal(purgeReport([{ sid: 'bbbbbbbb-2', removed: [], kept: [{ path: '/w/b/a', reason: 'stash' }], error: 'нет' }]), 'bbbbbbbb: нет\nоставлен /w/b/a: stash');
    assert.equal(purgeReport([{ sid: 'cccccccc-3', removed: ['/w/c'], kept: [] }]), '');
  });

  it('удаление: с подтверждением force уходит только сессиям из перечня, непроверенные и чистые - без force', () => {
    const plan = { sids: ['bbbbbbbb-2', 'cccccccc-3', 'dddddddd-4'], dirtySids: ['bbbbbbbb-2'], dirty: ['/w/b/a - незапушенные коммиты'] };
    assert.deepEqual(purgeCalls(plan, true), [
      { sids: ['cccccccc-3', 'dddddddd-4'], force: false },
      { sids: ['bbbbbbbb-2'], force: true },
    ]);
    assert.deepEqual(purgeCalls(plan, false), [{ sids: plan.sids, force: false }]);
    assert.deepEqual(purgeCalls({ sids: ['bbbbbbbb-2'], dirtySids: ['bbbbbbbb-2'], dirty: [] }, true), [{ sids: ['bbbbbbbb-2'], force: true }]);
  });
});
