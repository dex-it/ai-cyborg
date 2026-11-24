import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { McpServer, type McpBackend } from '../src/main/mcp';
import { parseSideAnswer, SIDE_ALIVE_MS, SideQuestions } from '../src/main/side-questions';
import { DEFAULT_SIDE_QUESTION, MAX_HISTORY_TURNS, sideFailure, sidePrompt, sideUsageLine } from '../src/shared/side-question';

describe('очередь вопросов к моду сессии', () => {
  it('без опроса мода вопрос сразу получает no-mod', async () => {
    const side = new SideQuestions();
    assert.deepEqual(await side.ask(1, 'q'), { ok: false, reason: 'no-mod' });
  });

  it('ждущий мод получает вопрос сразу, его ответ возвращается спросившему', async () => {
    const side = new SideQuestions();
    const polled = side.next(1);
    const answered = side.ask(1, 'что это?');
    const ask = await polled;
    assert.equal(ask?.prompt, 'что это?');
    assert.equal(side.answer(2, ask!.id, { ok: true, text: 'чужой' }), false, 'ответ другой сессии не принимается');
    assert.equal(side.answer(1, ask!.id, { ok: true, text: 'ответ' }), true);
    assert.deepEqual(await answered, { ok: true, text: 'ответ' });
    assert.equal(side.answer(1, ask!.id, { ok: true, text: 'повтор' }), false);
  });

  it('вопрос между опросами ждёт в очереди; мод считается живым SIDE_ALIVE_MS', async () => {
    let now = 0;
    const side = new SideQuestions(() => now, 5);
    assert.equal(await side.next(1), null, 'опрос без вопроса заканчивается пустым');
    now = SIDE_ALIVE_MS - 1;
    const answered = side.ask(1, 'q');
    const ask = await side.next(1);
    side.answer(1, ask!.id, { ok: false, reason: 'empty-reply' });
    assert.deepEqual(await answered, { ok: false, reason: 'empty-reply' });
    now = 2 * SIDE_ALIVE_MS;
    assert.equal(side.ready(1), false);
  });

  it('вопрос, отданный в оборванное соединение, уходит следующему опросу', async () => {
    const side = new SideQuestions();
    const gone = new AbortController();
    const first = side.next(1, gone.signal);
    const answered = side.ask(1, 'q');
    const lost = await first;
    side.requeue(1, lost!);
    const again = await side.next(1);
    assert.equal(again?.id, lost?.id);
    side.answer(1, again!.id, { ok: true, text: 'a' });
    assert.equal((await answered).text, 'a');
  });

  it('без ответа мода - timeout; завершение сессии закрывает её вопросы', async () => {
    const slow = new SideQuestions(Date.now, 1000, 10);
    void slow.next(1);
    assert.deepEqual(await slow.ask(1, 'q'), { ok: false, reason: 'timeout' });
    const side = new SideQuestions();
    void side.next(1);
    const answered = side.ask(1, 'q');
    side.drop(1);
    assert.deepEqual(await answered, { ok: false, reason: 'session-ended' });
    assert.equal(side.ready(1), false);
  });

  it('ответ мода разбирается по известным полям', () => {
    assert.equal(parseSideAnswer({ text: 'x' }), null);
    assert.deepEqual(parseSideAnswer({ id: 'a', isAnswered: true, text: 't', ms: 12, usage: { cache_read_input_tokens: 5, input_tokens: 'x' }, extra: 1 }), {
      id: 'a',
      answer: { ok: true, text: 't', ms: 12, usage: { input_tokens: undefined, output_tokens: undefined, cache_read_input_tokens: 5, cache_creation_input_tokens: undefined } },
    });
    assert.deepEqual(parseSideAnswer({ id: 'b', isAnswered: false, reason: 'api-error', status: 529 }), { id: 'b', answer: { ok: false, reason: 'api-error', status: 529 } });
  });
});

describe('маршруты /side сервера Cyborg', () => {
  const backend: McpBackend = { tools: () => [], call: async () => '' };

  it('мод забирает вопрос по своему токену и присылает ответ; чужой токен - 401', async (t) => {
    const side = new SideQuestions();
    const server = new McpServer(backend, 'v', side);
    await server.listen();
    t.after(() => server.close());
    const config = server.connect(7).mcpServers.cyborg;
    const base = config.url.replace(/\/mcp$/, '/side');
    const post = (path: string, body: unknown, headers = config.headers) =>
      fetch(base + path, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post('/next', {}, { Authorization: 'Bearer wrong' })).status, 401);
    const polled = post('/next', {});
    await new Promise((r) => setTimeout(r, 20));
    const answered = side.ask(7, 'вопрос');
    const asked = await polled;
    assert.equal(asked.status, 200);
    const ask = (await asked.json()) as { id: string; prompt: string };
    assert.equal(ask.prompt, 'вопрос');
    assert.equal((await post('/answer', { id: 'нет такого', isAnswered: true, text: 'x' })).status, 404);
    assert.equal((await post('/answer', { id: ask.id, isAnswered: true, text: 'ответ', ms: 3 })).status, 204);
    assert.deepEqual(await answered, { ok: true, text: 'ответ', ms: 3 });
  });

  it('без очереди вопросов маршрутов /side нет', async (t) => {
    const server = new McpServer(backend, 'v');
    await server.listen();
    t.after(() => server.close());
    const config = server.connect(1).mcpServers.cyborg;
    const res = await fetch(config.url.replace(/\/mcp$/, '/side/next'), { method: 'POST', headers: config.headers, body: '{}' });
    assert.equal(res.status, 404);
  });
});

describe('текст вопроса форку', () => {
  it('обёртка, фрагмент, недавняя история и вопрос; пустой вопрос - пояснить фрагмент', () => {
    const history = Array.from({ length: MAX_HISTORY_TURNS + 2 }, (_, i) => ({ question: `в${i}`, answer: `о${i}` }));
    const prompt = sidePrompt('  фрагмент  ', history, '');
    assert.match(prompt, /^<system-reminder>This is a side question/);
    assert.match(prompt, /<fragment>\nфрагмент\n<\/fragment>/);
    assert.ok(!prompt.includes('Вопрос: в0\n'), 'старые вопросы окна отброшены');
    assert.ok(prompt.includes(`Вопрос: в${MAX_HISTORY_TURNS + 1}`));
    assert.ok(prompt.endsWith(`Вопрос: ${DEFAULT_SIDE_QUESTION}`));
  });

  it('причины без ответа и строка расхода', () => {
    assert.match(sideFailure({ ok: false, reason: 'no-mod' }), /cyborg-ask/);
    assert.match(sideFailure({ ok: false, reason: 'api-error', status: 529 }), /529/);
    assert.equal(sideUsageLine({ ok: true }), '');
    assert.equal(
      sideUsageLine({ ok: true, ms: 5100, usage: { cache_read_input_tokens: 44006, cache_creation_input_tokens: 0, input_tokens: 143, output_tokens: 25 } }),
      `из кэша ${(44006).toLocaleString('ru-RU')} · в кэш 0 · без кэша 143 · ответ 25 · 5,1 с`,
    );
  });
});
