import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanMessage } from '../src/main/clean-text';
import { childExitText, reportText } from '../src/main/report-text';
import type { SessionInfo } from '../src/main/sessions';
import {
  ANSWER_TAIL,
  createSessionTools,
  describePeers,
  Handoffs,
  type HandoffRequest,
  MAX_TEXT_BYTES,
  validateClose,
  validateOpenSession,
  validateSend,
  validateSetTask,
  TASK_SUMMARY_MAX,
} from '../src/main/session-tools';
import { AUTO_ALLOWED_TOOLS, hookSettings } from '../src/main/session-state';

const DIRS = ['/repo/a', '/repo/b'];

const peer = (id: number, state: SessionInfo['state'], extra: Partial<SessionInfo> = {}): SessionInfo => ({ id, dirs: DIRS, cwd: '/repo/a', state, queued: 0, ...extra });

describe('validateOpenSession', () => {
  it('принимает задание и каталог из перечня, края промпта обрезаны', () => {
    assert.deepEqual(validateOpenSession({ prompt: '  /dex-auto:auto X \n', repo: '/repo/a' }, DIRS), { prompt: '/dex-auto:auto X', repo: '/repo/a' });
  });

  it('отвергает пустой промпт, промпт с «-» и «!», больше предела и каталог вне перечня', () => {
    assert.match(validateOpenSession({ prompt: '  ', repo: '/repo/a' }, DIRS) as string, /непустая/);
    assert.match(validateOpenSession({ prompt: ' - пункт', repo: '/repo/a' }, DIRS) as string, /«-»/);
    assert.match(validateOpenSession({ prompt: '\x01!rm -rf ~', repo: '/repo/a' }, DIRS) as string, /«!»/);
    assert.match(validateOpenSession({ prompt: ' !rm -rf x', repo: '/repo/a' }, DIRS) as string, /«!»/);
    assert.match(validateOpenSession({ prompt: 'я'.repeat(MAX_TEXT_BYTES / 2 + 1), repo: '/repo/a' }, DIRS) as string, /байт/);
    assert.match(validateOpenSession({ prompt: 'x', repo: '/repo/c' }, DIRS) as string, /\/repo\/a, \/repo\/b/);
    assert.equal(typeof validateOpenSession(null, DIRS), 'string');
  });
});

describe('validateSend', () => {
  const peers = [peer(1, 'working'), peer(2, 'waiting'), peer(3, 'asking', { reason: 'Просит разрешение' }), peer(4, 'starting'), peer(5, 'working')];

  it('принимает сообщение ждущей и работающей сессии проекта', () => {
    assert.deepEqual(validateSend({ id: 2, message: 'строка\r\nвторая' }, peers, 1), { id: 2, message: 'строка\nвторая' });
    assert.deepEqual(validateSend({ id: 5, message: 'посмотри /tmp/x' }, peers, 1), { id: 5, message: 'посмотри /tmp/x' });
  });

  it('отвергает себя, чужую сессию, стоящую на вопросе, запускающуюся и завершённую, пустое, с «!», «/» и «#»', () => {
    assert.match(validateSend({ id: 2, message: ' /permissions' }, peers, 1) as string, /«\/» или «#»/);
    assert.match(validateSend({ id: 2, message: '\x1b# запомни' }, peers, 1) as string, /«\/» или «#»/);
    assert.match(validateSend({ id: 1, message: 'x' }, peers, 1) as string, /этой же/);
    assert.match(validateSend({ id: 9, message: 'x' }, peers, 1) as string, /нет среди/);
    assert.match(validateSend({ id: '2', message: 'x' }, peers, 1) as string, /нет среди/);
    assert.match(validateSend({ id: 3, message: 'x' }, peers, 1) as string, /Просит разрешение/);
    assert.match(validateSend({ id: 4, message: 'x' }, peers, 1) as string, /запускается/);
    assert.match(validateSend({ id: 6, message: 'x' }, [...peers, peer(6, 'exited', { exitCode: 0 })], 1) as string, /^сессия 6 завершилась: её вкладку закрывает close_session$/);
    assert.match(validateSend({ id: 2, message: '\x1b \n' }, peers, 1) as string, /непустая/);
    assert.match(validateSend({ id: 2, message: '\x07!ls' }, peers, 1) as string, /«!»/);
  });

  it('cleanMessage вычищает управляющие символы, закрывающие вставку', () => {
    assert.equal(cleanMessage('a\x1b[201~b\tc\u009bd'), 'a[201~b\tcd');
  });
});

describe('validateClose', () => {
  const peers = [peer(1, 'working'), peer(2, 'waiting'), peer(3, 'asking', { reason: 'Просит разрешение' }), peer(4, 'starting'), peer(5, 'working')];

  it('закрывает ждущую соседку и саму вызывающую, хотя она в своём ходу', () => {
    assert.deepEqual(validateClose({ id: 2 }, peers, 1), { id: 2 });
    assert.deepEqual(validateClose({ id: 1 }, peers, 1), { id: 1 });
  });

  it('работающую, ждущую человека и запускающуюся соседку закрывает только с force', () => {
    assert.match(validateClose({ id: 5 }, peers, 1) as string, /работает.*force: true/);
    assert.match(validateClose({ id: 3 }, peers, 1) as string, /ждёт человека \(Просит разрешение\)/);
    assert.match(validateClose({ id: 4 }, peers, 1) as string, /запускается/);
    for (const id of [3, 4, 5]) assert.deepEqual(validateClose({ id, force: true }, peers, 1), { id });
  });

  it('завершённую соседку закрывает без force', () => {
    assert.deepEqual(validateClose({ id: 6 }, [...peers, peer(6, 'exited', { exitCode: 1 })], 1), { id: 6 });
  });

  it('свою дочернюю закрывает в любом состоянии без force, чужую - нет', () => {
    const family = [peer(1, 'working'), peer(6, 'working', { parent: 1 }), peer(7, 'asking', { parent: 1, reason: 'вопрос' }), peer(8, 'starting', { parent: 1 }), peer(9, 'working', { parent: 5 })];
    for (const id of [6, 7, 8]) assert.deepEqual(validateClose({ id }, family, 1), { id });
    assert.match(validateClose({ id: 9 }, family, 1) as string, /force: true/);
  });

  it('отвергает номер вне проекта и force не логическим', () => {
    assert.match(validateClose({ id: 9 }, peers, 1) as string, /нет среди открытых/);
    assert.match(validateClose({ id: '2' }, peers, 1) as string, /нет среди открытых/);
    assert.match(validateClose({ id: 2, force: 'yes' }, peers, 1) as string, /force/);
  });
});

describe('describePeers', () => {
  it('сессия-вызывающая помечена, причина и хвост ответа - только когда есть', () => {
    const long = 'начало ' + 'x'.repeat(ANSWER_TAIL);
    const list = JSON.parse(describePeers([peer(1, 'working'), peer(2, 'asking', { reason: 'Задаёт вопрос', lastAnswer: long, cwd: '/w', queued: 2 })], 1));
    assert.deepEqual(list[0], { id: 1, tab: 'CC1', self: true, repo: '/repo/a', cwd: '/repo/a', state: 'working' });
    assert.equal(list[1].reason, 'Задаёт вопрос');
    assert.equal(list[1].queued, 2);
    assert.equal(list[1].cwd, '/w');
    assert.equal(list[1].last_answer, `…${'x'.repeat(ANSWER_TAIL)}`);
    assert.equal('self' in list[1], false);
  });

  it('parent - у сессий, открытых инструментом; child: true - только у дочерних вызывающей', () => {
    const list = JSON.parse(describePeers([peer(1, 'working'), peer(2, 'waiting', { parent: 1 }), peer(3, 'waiting', { parent: 2 }), peer(4, 'waiting')], 1));
    assert.deepEqual([list[1].parent, list[1].child], [1, true]);
    assert.deepEqual([list[2].parent, 'child' in list[2]], [2, false]);
    assert.deepEqual(['parent' in list[3], 'child' in list[3]], [false, false]);
  });

  it('чем занята: title и task - когда известны, last_request - только если отличается от task', () => {
    const list = JSON.parse(describePeers([peer(1, 'working'), peer(2, 'waiting', { title: 'Ревью', task: 'сделай ревью', lastPrompt: 'сделай ревью' }), peer(3, 'working', { task: 'почини тест', lastPrompt: '[CC2 → CC3] вопрос' })], 1));
    assert.deepEqual(['title' in list[0], 'task' in list[0], 'last_request' in list[0]], [false, false, false]);
    assert.deepEqual([list[1].title, list[1].task, 'last_request' in list[1]], ['Ревью', 'сделай ревью', false]);
    assert.deepEqual([list[2].task, list[2].last_request], ['почини тест', '[CC2 → CC3] вопрос']);
  });

  it('exit_code - только у завершённой', () => {
    const list = JSON.parse(describePeers([peer(1, 'working'), peer(2, 'exited', { exitCode: 0 })], 1));
    assert.deepEqual([list[1].state, list[1].exit_code], ['exited', 0]);
    assert.equal('exit_code' in list[0], false);
  });
});

describe('reportText', () => {
  it('у локальной - без хоста, у удалённой - с хостом; ветка и PR - строками до итога', () => {
    assert.equal(reportText(3, undefined, { status: 'ok', summary: 'сделано', branch: 'feat-x' }), 'Итог сессии CC3: ok\nветка: feat-x\n\nсделано');
    assert.equal(reportText(4, 'dev1', { status: 'failed', summary: 'нет', pr: 'https://x/1' }), 'Итог удалённой сессии CC4 (dev1): failed\nPR: https://x/1\n\nнет');
  });

  it('childExitText: вышла сама - код и как закрыть вкладку; вкладку закрыли - кто, в том числе она сама', () => {
    assert.equal(childExitText(8, { code: 1, released: false }), 'Сессия CC8 завершилась (код 1): её вкладка открыта, закрыть - close_session.');
    assert.equal(childExitText(8, { code: 0, released: true }), 'Вкладку сессии CC8 закрыл человек.');
    assert.equal(childExitText(8, { code: 0, released: true, closedBy: 5 }), 'Вкладку сессии CC8 закрыла сессия CC5.');
    assert.equal(childExitText(8, { code: 0, released: true, closedBy: 8 }), 'Сессия CC8 закрыла свою вкладку.');
  });
});

describe('set_task и подробность list_sessions', () => {
  it('validateSetTask: одна строка в пределах, ref необязателен', () => {
    assert.deepEqual(validateSetTask({ summary: ' ревью \n PR ' }), { summary: 'ревью PR' });
    assert.deepEqual(validateSetTask({ ref: ' DEX-12 ', summary: 'чиню тест' }), { ref: 'DEX-12', summary: 'чиню тест' });
    assert.match(validateSetTask({ summary: ' ' }) as string, /summary/);
    assert.match(validateSetTask({ summary: 'x'.repeat(TASK_SUMMARY_MAX + 1) }) as string, /длиннее/);
    assert.match(validateSetTask({ ref: 'x'.repeat(81), summary: 's' }) as string, /ref длиннее/);
    assert.match(validateSetTask({ ref: 5, summary: 's' }) as string, /ref/);
  });

  it('объявленная задача видна соседке: brief - номер и состояние, full - ещё summary и всё прочее', async () => {
    const declared = new Map<number, { ref?: string; summary: string }>();
    const peers = (): SessionInfo[] => [peer(1, 'working', { title: 'Ревью', lastAnswer: 'хвост' }), peer(2, 'waiting', { ...declared.get(2), parent: 1 })];
    const backend = createSessionTools(
      { dirsOf: () => DIRS, peers, say: async () => 'sent', setTask: (id, task) => void declared.set(id, task) },
      { request: async () => 1 },
      () => {},
    );
    assert.equal(await backend.call(2, 'set_task', { ref: 'DEX-7', summary: 'пишу миграцию, этап тестов' }), 'Задача DEX-7 названа соседним сессиям.');
    const brief = JSON.parse(await backend.call(1, 'list_sessions', { detail: 'brief' }));
    assert.deepEqual(brief, [{ id: 1, self: true, state: 'working', title: 'Ревью' }, { id: 2, child: true, state: 'waiting', ref: 'DEX-7' }]);
    const full = JSON.parse(await backend.call(1, 'list_sessions', {}));
    assert.deepEqual([full[1].ref, full[1].summary, full[0].last_answer], ['DEX-7', 'пишу миграцию, этап тестов', 'хвост']);
    await assert.rejects(backend.call(1, 'list_sessions', { detail: 'all' }), /brief или full/);
  });

  it('set_task разрешён настройками сессии: человек его не подтверждает', () => {
    assert.deepEqual(hookSettings().permissions.allow, AUTO_ALLOWED_TOOLS);
    assert.ok(AUTO_ALLOWED_TOOLS.every((t) => t.startsWith('mcp__cyborg__')) && AUTO_ALLOWED_TOOLS.includes('mcp__cyborg__set_task'));
  });
});

describe('createSessionTools', () => {
  function tools(peers: SessionInfo[] | null) {
    const said: [number, string][] = [];
    const requested: unknown[] = [];
    const closed: number[] = [];
    const reported: [number, unknown][] = [];
    const order: string[] = [];
    const backend = createSessionTools(
      {
        dirsOf: () => (peers ? DIRS : null),
        peers: () => peers,
        say: async (id, text) => {
          said.push([id, text]);
          const target = peers?.find((p) => p.id === id);
          if (target?.state !== 'working') return 'sent';
          return target.queued || target.host ? 'queued' : 'sent-working';
        },
        parentOf: (id) => peers?.find((p) => p.id === id)?.parent ?? null,
        reportLocal: (id, report) => (reported.push([id, report]), 'принят'),
        noteClosing: (id, caller) => void order.push(`note ${id} by ${caller}`),
      },
      { request: async (...args) => (requested.push(args), 42) },
      (id) => (closed.push(id), order.push(`close ${id}`)),
      10,
    );
    return { backend, said, requested, closed, reported, order };
  }

  it('report_done есть у локальной дочерней и уходит в reportLocal; у открытой человеком его нет', async () => {
    const { backend, reported } = tools([peer(1, 'working'), peer(2, 'working', { parent: 1 })]);
    assert.ok(backend.tools(2).some((t) => t.name === 'report_done'));
    assert.ok(!backend.tools(1).some((t) => t.name === 'report_done'));
    assert.equal(await backend.call(2, 'report_done', { status: 'ok', summary: 's', branch: 'b' }), 'принят');
    await assert.rejects(backend.call(1, 'report_done', { status: 'ok', summary: 's' }), /недоступен этой сессии/);
    await assert.rejects(backend.call(2, 'report_done', { status: 'done', summary: 's' }), /status/);
    assert.deepEqual(reported, [[2, { status: 'ok', summary: 's', branch: 'b' }]]);
  });

  it('close_session закрывает работающую дочернюю без force', async () => {
    const { backend, closed } = tools([peer(1, 'working'), peer(2, 'working', { parent: 1 })]);
    assert.match(await backend.call(1, 'close_session', { id: 2 }), /сессии 2 закрыта/);
    assert.deepEqual(closed, [2]);
  });

  it('close_session называет закрывающую сессию до закрытия вкладки: открывшей о выходе дочерней не сообщат зря', async () => {
    const { backend, order } = tools([peer(1, 'working'), peer(2, 'exited', { exitCode: 0, parent: 3 }), peer(3, 'working')]);
    assert.match(await backend.call(1, 'close_session', { id: 2 }), /сессии 2 закрыта/);
    assert.deepEqual(order, ['note 2 by 1', 'close 2']);
  });

  it('close_session своей вкладки отмечает закрывающей её саму: открывшей не скажут, что вкладку закрыл человек', async () => {
    const { backend, order } = tools([peer(1, 'working'), peer(2, 'working', { parent: 1 })]);
    assert.equal(await backend.call(2, 'close_session', { id: 2 }), 'Эта вкладка закроется через секунду.');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(order, ['note 2 by 2', 'close 2']);
  });

  it('send_to_session: ответ говорит, отправлено ли сообщение, передаст ли его Claude Code посреди хода или оно ждёт в очереди', async () => {
    const { backend, said } = tools([peer(1, 'working'), peer(2, 'waiting'), peer(3, 'working'), peer(4, 'working', { queued: 1 }), peer(5, 'working', { host: 'dev1' })]);
    assert.equal(await backend.call(1, 'send_to_session', { id: 2, message: 'привет' }), 'Сообщение отправлено сессии 2.');
    assert.equal(
      await backend.call(1, 'send_to_session', { id: 3, message: 'ещё' }),
      'Сообщение отправлено сессии 3: она работает, Claude Code передаст его после текущего вызова инструмента.',
    );
    assert.equal(
      await backend.call(1, 'send_to_session', { id: 4, message: 'и ещё' }),
      'Сообщение сессии 4 в очереди Cyborg: уйдёт, как только она примет ввод.',
    );
    assert.equal(await backend.call(1, 'send_to_session', { id: 5, message: 'хосту' }), 'Сессия 5 работает: сообщение в очереди Cyborg и уйдёт, когда она закончит ход.');
    assert.deepEqual(said, [
      [2, 'привет'],
      [3, 'ещё'],
      [4, 'и ещё'],
      [5, 'хосту'],
    ]);
    await assert.rejects(backend.call(1, 'send_to_session', { id: 1, message: 'x' }), /этой же/);
  });

  it('open_session передаёт задачу интерфейсу и называет номер новой сессии; list_sessions - перечень', async () => {
    const { backend, requested } = tools([peer(1, 'working')]);
    assert.match(await backend.call(1, 'open_session', { prompt: 'задача', repo: '/repo/b' }), /сессии 42 в \/repo\/b/);
    assert.deepEqual(requested, [[1, '/repo/b', 'задача']]);
    assert.equal(JSON.parse(await backend.call(1, 'list_sessions', {}))[0].self, true);
  });

  it('close_session закрывает соседку сразу, а свою вкладку - после ответа', async () => {
    const { backend, closed } = tools([peer(1, 'working'), peer(2, 'waiting'), peer(3, 'working')]);
    assert.match(await backend.call(1, 'close_session', { id: 2 }), /сессии 2 закрыта/);
    await assert.rejects(backend.call(1, 'close_session', { id: 3 }), /force: true/);
    assert.match(await backend.call(1, 'close_session', { id: 1 }), /закроется/);
    assert.deepEqual(closed, [2]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(closed, [2, 1]);
  });

  it('у завершённой сессии инструментов нет, вызов - ошибка', async () => {
    const { backend } = tools(null);
    assert.deepEqual(backend.tools(1), []);
    await assert.rejects(backend.call(1, 'list_sessions', {}), /завершена/);
  });
});

describe('Handoffs', () => {
  it('интерфейс получает ключ без промпта; take по ключу и каталогу отдаёт промпт один раз, resolve завершает запрос', async () => {
    const sent: HandoffRequest[] = [];
    const handoffs = new Handoffs((r) => (sent.push(r), true));
    const pending = handoffs.request(3, '/repo/a', 'задание');
    const { hid, ...rest } = sent[0];
    assert.deepEqual(rest, { from: 3, repo: '/repo/a' });
    assert.equal(handoffs.take(hid, '/repo/b'), null);
    const taken = handoffs.take(hid, '/repo/a');
    assert.equal(taken?.prompt, 'задание');
    assert.equal(handoffs.take(hid, '/repo/a'), null);
    taken!.resolve(7);
    assert.equal(await pending, 7);
  });

  it('отказ интерфейса, закрытое окно и истёкшее ожидание завершают запрос ошибкой с причиной', async () => {
    const sent: HandoffRequest[] = [];
    const handoffs = new Handoffs((r) => (sent.push(r), true), 20);
    const refused = handoffs.request(1, '/repo/a', 'x');
    handoffs.fail(sent[0].hid, 'каталог больше не входит в проект');
    await assert.rejects(refused, /больше не входит/);
    await assert.rejects(handoffs.request(1, '/repo/a', 'x'), /за 0.02 с/);
    assert.equal(handoffs.take(sent[1].hid, '/repo/a'), null);
    await assert.rejects(new Handoffs(() => false).request(1, '/repo/a', 'x'), /окно Cyborg закрыто/);
  });
});
