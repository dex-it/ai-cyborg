import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handleRpc, MAX_BODY_BYTES, McpServer, type McpBackend } from '../src/main/mcp';
import { sessionTools, validateOpenSession } from '../src/main/session-tools';

const DIRS = ['/repo/a', '/repo/b'];

const backend: McpBackend = {
  tools: (caller) => (caller === 1 ? sessionTools(DIRS) : []),
  call: async (caller, _name, args) => {
    const valid = validateOpenSession(args, DIRS);
    if (typeof valid === 'string') throw new Error(valid);
    return `${caller}:${valid.repo}`;
  },
};

const rpc = (method: string, params?: unknown, id: number | string = 1) => ({ jsonrpc: '2.0', id, method, params });

describe('handleRpc', () => {
  it('initialize отвечает версией клиента, неизвестной - последней своей; инструменты объявлены', async () => {
    const known = (await handleRpc(rpc('initialize', { protocolVersion: '2025-06-18' }), 1, backend, '0.1.0')) as any;
    assert.equal(known.result.protocolVersion, '2025-06-18');
    assert.deepEqual(known.result.capabilities, { tools: { listChanged: false } });
    assert.deepEqual(known.result.serverInfo, { name: 'cyborg', version: '0.1.0' });
    const unknown = (await handleRpc(rpc('initialize', { protocolVersion: '1999-01-01' }), 1, backend, '0.1.0')) as any;
    assert.equal(unknown.result.protocolVersion, '2025-11-25');
  });

  it('уведомления и ответы клиента остаются без ответа', async () => {
    assert.equal(await handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, 1, backend, 'v'), null);
    assert.equal(await handleRpc({ jsonrpc: '2.0', id: 5, result: {} }, 1, backend, 'v'), null);
  });

  it('tools/list отдаёт инструменты вызывающей сессии с её каталогами в схеме', async () => {
    const list = (await handleRpc(rpc('tools/list'), 1, backend, 'v')) as any;
    assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name), ['open_session', 'list_sessions', 'send_to_session']);
    assert.deepEqual(list.result.tools[0].inputSchema.properties.repo.enum, DIRS);
    assert.deepEqual(((await handleRpc(rpc('tools/list'), 2, backend, 'v')) as any).result.tools, []);
  });

  it('tools/call: результат текстом, ошибка выполнения - isError с причиной, чужой инструмент - ошибка протокола', async () => {
    const ok = (await handleRpc(rpc('tools/call', { name: 'open_session', arguments: { prompt: 'сделай', repo: '/repo/b' } }), 1, backend, 'v')) as any;
    assert.deepEqual(ok.result, { content: [{ type: 'text', text: '1:/repo/b' }] });
    const bad = (await handleRpc(rpc('tools/call', { name: 'open_session', arguments: { prompt: 'сделай', repo: '/etc' } }), 1, backend, 'v')) as any;
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /\/repo\/a, \/repo\/b/);
    const foreign = (await handleRpc(rpc('tools/call', { name: 'open_session', arguments: {} }), 2, backend, 'v')) as any;
    assert.equal(foreign.error.code, -32602);
  });

  it('неизвестный метод - -32601, не объект - -32600', async () => {
    assert.equal(((await handleRpc(rpc('resources/list'), 1, backend, 'v')) as any).error.code, -32601);
    for (const junk of [null, 1, 'x', [rpc('ping')]]) assert.equal(((await handleRpc(junk, 1, backend, 'v')) as any).error.code, -32600);
    assert.deepEqual(((await handleRpc(rpc('ping'), 1, backend, 'v')) as any).result, {});
  });
});

describe('McpServer', () => {
  async function started(t: { after: (fn: () => void) => void }) {
    const server = new McpServer(backend, 'v');
    await server.listen();
    t.after(() => server.close());
    const config = server.connect(1).mcpServers.cyborg;
    const post = (body: unknown, headers: Record<string, string> = config.headers, method = 'POST') =>
      fetch(config.url, { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: method === 'POST' ? JSON.stringify(body) : undefined });
    return { server, config, post };
  }

  it('конфиг - http на 127.0.0.1 с токеном в заголовке; по токену отвечает за его сессию', async (t) => {
    const { config, post } = await started(t);
    assert.equal(config.type, 'http');
    assert.match(config.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    assert.match(config.headers.Authorization, /^Bearer [\w-]{43}$/);
    const res = await post(rpc('tools/list'));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    assert.equal(((await res.json()) as any).result.tools[0].name, 'open_session');
    assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  });

  it('без токена, с чужим токеном и после disconnect - 401; с Origin браузера - 403', async (t) => {
    const { server, config, post } = await started(t);
    assert.equal((await post(rpc('tools/list'), {})).status, 401);
    assert.equal((await post(rpc('tools/list'), { Authorization: 'Bearer nope' })).status, 401);
    assert.equal((await post(rpc('tools/list'), { ...config.headers, Origin: 'https://evil.example' })).status, 403);
    server.disconnect(1);
    assert.equal((await post(rpc('tools/list'))).status, 401);
  });

  it('GET - 405, чужой путь - 404, не JSON - 400, тело больше предела - отказ', async (t) => {
    const { config, post } = await started(t);
    assert.equal((await post(undefined, config.headers, 'GET')).status, 405);
    assert.equal((await fetch(config.url.replace('/mcp', '/other'), { method: 'POST', headers: config.headers, body: '{}' })).status, 404);
    assert.equal((await fetch(config.url, { method: 'POST', headers: config.headers, body: '{не json' })).status, 400);
    const huge = await fetch(config.url, { method: 'POST', headers: config.headers, body: 'x'.repeat(MAX_BODY_BYTES + 1) }).then(
      (r) => r.status,
      () => 'reset',
    );
    assert.ok(huge === 413 || huge === 'reset', String(huge));
  });
});
