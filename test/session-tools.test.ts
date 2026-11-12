import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanMessage } from '../src/main/clean-text';
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
} from '../src/main/session-tools';

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

  it('отвергает себя, чужую сессию, стоящую на вопросе и запускающуюся, пустое, с «!», «/» и «#»', () => {
    assert.match(validateSend({ id: 2, message: ' /permissions' }, peers, 1) as string, /«\/» или «#»/);
    assert.match(validateSend({ id: 2, message: '\x1b# запомни' }, peers, 1) as string, /«\/» или «#»/);
    assert.match(validateSend({ id: 1, message: 'x' }, peers, 1) as string, /этой же/);
    assert.match(validateSend({ id: 9, message: 'x' }, peers, 1) as string, /нет среди/);
    assert.match(validateSend({ id: '2', message: 'x' }, peers, 1) as string, /нет среди/);
    assert.match(validateSend({ id: 3, message: 'x' }, peers, 1) as string, /Просит разрешение/);
    assert.match(validateSend({ id: 4, message: 'x' }, peers, 1) as string, /запускается/);
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
});

describe('createSessionTools', () => {
  function tools(peers: SessionInfo[] | null) {
    const said: [number, string][] = [];
    const requested: unknown[] = [];
    const closed: number[] = [];
    const backend = createSessionTools(
      {
        dirsOf: () => (peers ? DIRS : null),
        peers: () => peers,
        say: async (id, text) => (said.push([id, text]), peers?.find((p) => p.id === id)?.state === 'working' ? 'queued' : 'sent'),
      },
      { request: async (...args) => (requested.push(args), 42) },
      (id) => closed.push(id),
      10,
    );
    return { backend, said, requested, closed };
  }

  it('send_to_session пишет в ждущую сессию; о работающей говорит, что сообщение в очереди', async () => {
    const { backend, said } = tools([peer(1, 'working'), peer(2, 'waiting'), peer(3, 'working')]);
    assert.match(await backend.call(1, 'send_to_session', { id: 2, message: 'привет' }), /отправлено сессии 2/);
    assert.match(await backend.call(1, 'send_to_session', { id: 3, message: 'ещё' }), /в очереди Cyborg/);
    assert.deepEqual(said, [
      [2, 'привет'],
      [3, 'ещё'],
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
