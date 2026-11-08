import http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';

// Порт на 127.0.0.1 виден всем пользователям машины: вызывающую сессию называет только токен из её --mcp-config.

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpBackend {
  /** Инструменты зависят от вызывающей сессии: схема несёт её каталоги. */
  tools(caller: number): McpTool[];
  /** Текст результата; исключение - ошибка выполнения инструмента (isError), её текст видит модель. */
  call(caller: number, name: string, args: unknown): Promise<string>;
}

export const SERVER_NAME = 'cyborg';

// Клиенту отвечаем его же версией, если она известна: клиент SDK отвергает версию вне своего списка.
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** Тексты инструментов ограничены 100 КБ (session-tools.ts), остальное - конверт JSON-RPC с запасом. */
export const MAX_BODY_BYTES = 1024 * 1024;

type RpcId = string | number;
type RpcReply = { jsonrpc: '2.0'; id: RpcId | null } & ({ result: unknown } | { error: { code: number; message: string } });

const reply = (id: RpcId | null, result: unknown): RpcReply => ({ jsonrpc: '2.0', id, result });
const failure = (id: RpcId | null, code: number, message: string): RpcReply => ({ jsonrpc: '2.0', id, error: { code, message } });

/** Одно сообщение JSON-RPC. null - ответа нет: уведомление либо ответ клиента. */
export async function handleRpc(message: unknown, caller: number, backend: McpBackend, version: string): Promise<RpcReply | null> {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return failure(null, -32600, 'Invalid Request');
  const { id, method, params } = message as { id?: unknown; method?: unknown; params?: unknown };
  const hasId = typeof id === 'string' || typeof id === 'number';
  if (typeof method !== 'string') return hasId ? null : failure(null, -32600, 'Invalid Request');
  if (!hasId) return null;
  const p = (typeof params === 'object' && params !== null ? params : {}) as Record<string, unknown>;
  switch (method) {
    case 'initialize': {
      const asked = typeof p.protocolVersion === 'string' && PROTOCOL_VERSIONS.includes(p.protocolVersion) ? p.protocolVersion : PROTOCOL_VERSIONS[0];
      return reply(id, { protocolVersion: asked, capabilities: { tools: { listChanged: false } }, serverInfo: { name: SERVER_NAME, version } });
    }
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: backend.tools(caller) });
    case 'tools/call': {
      if (typeof p.name !== 'string' || !backend.tools(caller).some((t) => t.name === p.name)) return failure(id, -32602, `Unknown tool: ${String(p.name)}`);
      try {
        const text = await backend.call(caller, p.name, p.arguments ?? {});
        return reply(id, { content: [{ type: 'text', text }] });
      } catch (error) {
        return reply(id, { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true });
      }
    }
    default:
      return failure(id, -32601, `Method not found: ${method}`);
  }
}

export interface McpConfig {
  mcpServers: Record<string, { type: 'http'; url: string; headers: Record<string, string> }>;
}

export class McpServer {
  private readonly server: http.Server;
  private readonly callers = new Map<string, number>();
  private port = 0;

  constructor(
    private readonly backend: McpBackend,
    private readonly version: string,
  ) {
    this.server = http.createServer((req, res) => void this.serve(req, res));
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.port = (this.server.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  close(): void {
    this.server.close();
  }

  /** Конфиг для --mcp-config сессии с новым токеном; до listen порта нет. */
  connect(caller: number): McpConfig {
    if (!this.port) throw new Error('MCP-сервер не запущен');
    const token = randomBytes(32).toString('base64url');
    this.callers.set(token, caller);
    return {
      mcpServers: {
        [SERVER_NAME]: { type: 'http', url: `http://127.0.0.1:${this.port}/mcp`, headers: { Authorization: `Bearer ${token}` } },
      },
    };
  }

  disconnect(caller: number): void {
    for (const [token, id] of this.callers) if (id === caller) this.callers.delete(token);
  }

  private async serve(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body?: unknown, headers: Record<string, string> = {}): void => {
      if (body === undefined) res.writeHead(status, headers).end();
      else res.writeHead(status, { ...headers, 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    };
    if (new URL(req.url ?? '/', 'http://127.0.0.1').pathname !== '/mcp') return send(404);
    // Страница в браузере дотянется до 127.0.0.1, но всегда шлёт Origin; клиент CC его не шлёт.
    if (req.headers.origin !== undefined) return send(403);
    const caller = this.callers.get(/^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '');
    if (caller === undefined) return send(401);
    // Потока SSE сервер не держит: запросов клиенту он не шлёт, и GET по спецификации получает 405.
    if (req.method !== 'POST') return send(405, undefined, { Allow: 'POST' });
    let body: string;
    try {
      body = await readBody(req, MAX_BODY_BYTES);
    } catch {
      return send(413);
    }
    let message: unknown;
    try {
      message = JSON.parse(body);
    } catch {
      return send(400, failure(null, -32700, 'Parse error'));
    }
    const answer = await handleRpc(message, caller, this.backend, this.version);
    if (!answer) return send(202);
    send('error' in answer && answer.id === null ? 400 : 200, answer);
  }
}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new Error('too large'));
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
