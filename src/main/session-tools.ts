import { randomUUID } from 'node:crypto';
import type { McpBackend, McpTool } from './mcp.ts';
import type { SayResult, SessionInfo } from './sessions.ts';

export const OPEN_SESSION_TOOL = 'open_session';
export const LIST_SESSIONS_TOOL = 'list_sessions';
export const SEND_TO_SESSION_TOOL = 'send_to_session';

/** Промпт новой сессии уходит позиционным аргументом claude, а Linux ограничивает один аргумент 128 КиБ (MAX_ARG_STRLEN). */
export const MAX_TEXT_BYTES = 100_000;

export const HANDOFF_TIMEOUT_MS = 20_000;

/** Хвост ответа в list_sessions: итог работы обычно в конце ответа. */
export const ANSWER_TAIL = 1500;

/** Каталоги вызывающей сессии - перечень в схеме: модель видит, из чего выбирать активный каталог новой. */
export function sessionTools(dirs: string[]): McpTool[] {
  return [
    {
      name: OPEN_SESSION_TOOL,
      description:
        'Открывает в Cyborg новую вкладку - сессию Claude Code в том же проекте - и отправляет ей prompt первым сообщением. ' +
        'Новая сессия работает параллельно и этого диалога не видит, поэтому prompt - самодостаточное задание: цель, контекст, пути, ветки, критерий готовности. ' +
        'Можно начать его слэш-командой. repo - рабочий (активный) каталог новой сессии; остальные каталоги проекта подключаются к ней через --add-dir. ' +
        'Вкладка открывается в фоне, текущая остаётся активной. Состояние и ответ новой сессии - в list_sessions, дописать ей - send_to_session.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', minLength: 1, description: 'Первое сообщение новой сессии: задание целиком. Не начинается с «-».' },
          repo: { type: 'string', enum: dirs, description: 'Рабочий каталог новой сессии - один из каталогов проекта.' },
        },
        required: ['prompt', 'repo'],
        additionalProperties: false,
      },
    },
    {
      name: LIST_SESSIONS_TOOL,
      description:
        'Открытые вкладки Cyborg в проекте этой сессии, включая её саму (self: true): номер, подпись вкладки, каталог запуска и текущий, состояние и хвост последнего ответа. ' +
        'state: starting - запускается или ждёт подтверждения доверия к каталогу; working - работает, в том числе ждёт своих фоновых задач; ' +
        'waiting - ход завершён, ждёт сообщения; asking - стоит на вопросе, разрешении или лимите и ждёт человека (причина в reason). ' +
        'queued - сколько сообщений send_to_session ждут конца её хода.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: SEND_TO_SESSION_TOOL,
      description:
        'Отправляет сообщение в другую открытую вкладку проекта - как если бы человек набрал его там и нажал Enter. ' +
        'Работающей сессии (working) Cyborg отдаст его, когда она закончит ход; сессиям в starting и asking не отправляет, иначе текст ушёл бы в её диалог. ' +
        'Сообщение - обычный текст: слэш-команды и ввод с «!» или «#» не принимаются. ' +
        'Получатель не знает отправителя: если нужен ответ, назови в сообщении свой номер из list_sessions и попроси ответить через send_to_session. ' +
        'Если человек в этот момент набирает текст в той вкладке, сообщение допишется к его вводу.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'Номер сессии из list_sessions.' },
          message: { type: 'string', minLength: 1, description: 'Текст сообщения, может быть многострочным; не начинается с «/», «!» или «#».' },
        },
        required: ['id', 'message'],
        additionalProperties: false,
      },
    },
  ];
}

const args = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});

const tooLong = (text: string): boolean => Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES;

const SHELL_REFUSAL = 'текст не может начинаться с «!»: Claude Code выполнил бы его как команду оболочки без запроса разрешения';

export interface OpenSessionArgs {
  prompt: string;
  repo: string;
}

/** Аргументы от модели; ошибка - строка, её текст вернётся модели. */
export function validateOpenSession(value: unknown, dirs: string[]): OpenSessionArgs | string {
  const { prompt, repo } = args(value);
  if (typeof prompt !== 'string' || !prompt.trim()) return 'prompt - непустая строка';
  if (prompt.trimStart().startsWith('-')) return 'prompt не может начинаться с «-»: claude примет его за ключ командной строки';
  if (prompt.trimStart().startsWith('!')) return SHELL_REFUSAL;
  if (tooLong(prompt)) return `prompt длиннее ${MAX_TEXT_BYTES} байт: сократи задание или передай его файлом`;
  if (typeof repo !== 'string' || !dirs.includes(repo)) return `repo - один из каталогов проекта: ${dirs.join(', ')}`;
  return { prompt: prompt.trim(), repo };
}

/** Управляющие символы (кроме перевода строки и табуляции) вычищаются: ESC закрыл бы вставку и дальше текст пошёл бы в TUI клавишами. */
export function cleanMessage(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').trim();
}

export function validateSend(value: unknown, peers: SessionInfo[], caller: number): { id: number; message: string } | string {
  const { id, message } = args(value);
  if (typeof message !== 'string' || !cleanMessage(message)) return 'message - непустая строка';
  if (cleanMessage(message).startsWith('!')) return SHELL_REFUSAL;
  // «/permissions», «/config» и «#» правят настройки и память получателя в обход его разрешений.
  if (/^[/#]/.test(cleanMessage(message))) return 'message не может начинаться с «/» или «#»: это команда Claude Code, а не сообщение сессии';
  if (tooLong(message)) return `message длиннее ${MAX_TEXT_BYTES} байт: передай содержимое файлом`;
  if (id === caller) return 'это номер этой же сессии';
  const target = peers.find((p) => p.id === id);
  if (!target) return `сессии ${String(id)} нет среди открытых вкладок проекта: номера - в list_sessions`;
  if (target.state === 'starting') return `сессия ${target.id} ещё запускается: повтори позже`;
  if (target.state === 'asking') return `сессия ${target.id} ждёт человека (${target.reason ?? 'вопрос'}): текст ушёл бы в её диалог, повтори после его ответа`;
  return { id: target.id, message: cleanMessage(message) };
}

const tail = (text: string): string => (text.length > ANSWER_TAIL ? `…${text.slice(-ANSWER_TAIL)}` : text);

export function describePeers(peers: SessionInfo[], caller: number): string {
  return JSON.stringify(
    peers.map((p) => ({
      id: p.id,
      tab: `CC${p.id}`,
      ...(p.id === caller ? { self: true } : {}),
      repo: p.dirs[0],
      cwd: p.cwd,
      state: p.state,
      ...(p.reason ? { reason: p.reason } : {}),
      ...(p.queued ? { queued: p.queued } : {}),
      ...(p.lastAnswer ? { last_answer: tail(p.lastAnswer) } : {}),
    })),
    null,
    2,
  );
}

export interface HandoffRequest {
  hid: string;
  from: number;
  repo: string;
}

interface Pending extends HandoffRequest {
  prompt: string;
  resolve: (id: number) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** Задача, переданная сессией в новую вкладку: интерфейс открывает вкладку, а промпт главный процесс берёт по одноразовому ключу. */
export class Handoffs {
  private readonly pending = new Map<string, Pending>();

  constructor(
    /** false - окна нет, передавать некому. */
    private readonly send: (request: HandoffRequest) => boolean,
    private readonly timeoutMs = HANDOFF_TIMEOUT_MS,
  ) {}

  /** Номер новой сессии, когда интерфейс её создал. */
  request(from: number, repo: string, prompt: string): Promise<number> {
    const hid = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(hid, `интерфейс Cyborg не открыл вкладку за ${this.timeoutMs / 1000} с`), this.timeoutMs);
      this.pending.set(hid, { hid, from, repo, prompt, resolve, reject, timer });
      if (!this.send({ hid, from, repo })) this.fail(hid, 'окно Cyborg закрыто');
    });
  }

  /** Передача для session:create: ключ одноразовый, каталог - тот, что выбрала модель. */
  take(hid: unknown, cwd: unknown): Pick<Pending, 'prompt' | 'resolve' | 'reject'> | null {
    const entry = typeof hid === 'string' ? this.pending.get(hid) : undefined;
    if (!entry || entry.repo !== cwd) return null;
    this.pending.delete(entry.hid);
    clearTimeout(entry.timer);
    return entry;
  }

  fail(hid: unknown, reason: unknown): void {
    const entry = typeof hid === 'string' ? this.pending.get(hid) : undefined;
    if (!entry) return;
    this.pending.delete(entry.hid);
    clearTimeout(entry.timer);
    entry.reject(new Error(typeof reason === 'string' && reason ? reason.slice(0, 500) : 'вкладка не открыта'));
  }
}

export interface SessionsPort {
  dirsOf(id: number): string[] | null;
  peers(id: number): SessionInfo[] | null;
  say(id: number, text: string): Promise<SayResult>;
}

export function createSessionTools(sessions: SessionsPort, handoffs: Pick<Handoffs, 'request'>): McpBackend {
  return {
    tools: (caller) => {
      const dirs = sessions.dirsOf(caller);
      return dirs ? sessionTools(dirs) : [];
    },
    call: async (caller, name, value) => {
      const dirs = sessions.dirsOf(caller);
      const peers = sessions.peers(caller);
      if (!dirs || !peers) throw new Error('сессия завершена');
      if (name === LIST_SESSIONS_TOOL) return describePeers(peers, caller);
      if (name === SEND_TO_SESSION_TOOL) {
        const valid = validateSend(value, peers, caller);
        if (typeof valid === 'string') throw new Error(valid);
        const result = await sessions.say(valid.id, valid.message);
        return result === 'queued'
          ? `Сессия ${valid.id} работает: сообщение в очереди Cyborg и уйдёт, когда она закончит ход.`
          : `Сообщение отправлено сессии ${valid.id}.`;
      }
      if (name !== OPEN_SESSION_TOOL) throw new Error(`неизвестный инструмент ${name}`);
      const valid = validateOpenSession(value, dirs);
      if (typeof valid === 'string') throw new Error(valid);
      const id = await handoffs.request(caller, valid.repo, valid.prompt);
      return `Открыта вкладка сессии ${id} в ${valid.repo}.`;
    },
  };
}
