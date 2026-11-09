import { randomUUID } from 'node:crypto';
import type { McpBackend, McpTool } from './mcp.ts';
import { branchNameProblem } from './branch-name.ts';
import type { SayResult, SessionInfo } from './sessions.ts';

export const OPEN_SESSION_TOOL = 'open_session';
export const LIST_SESSIONS_TOOL = 'list_sessions';
export const SEND_TO_SESSION_TOOL = 'send_to_session';
export const CLOSE_SESSION_TOOL = 'close_session';
export const SPAWN_AGENT_TOOL = 'spawn_agent';
export const CLOSE_AGENT_TOOL = 'close_agent';
export const REPORT_DONE_TOOL = 'report_done';

export type SessionKind = 'local' | 'remote';

export interface ToolContext {
  kind: SessionKind;
  /** Хосты проекта вызывающей: без них spawn_agent и close_agent не отдаются. */
  hosts: string[];
}

/** Промпт новой сессии уходит позиционным аргументом claude, а Linux ограничивает один аргумент 128 КиБ (MAX_ARG_STRLEN). */
export const MAX_TEXT_BYTES = 100_000;

export const HANDOFF_TIMEOUT_MS = 20_000;

/** Хвост ответа в list_sessions: итог работы обычно в конце ответа. */
export const ANSWER_TAIL = 1500;

/** Своя вкладка закрывается после ответа: иначе результат вызова не дошёл бы до её диалога и пропал бы из возобновлённой сессии. */
export const CLOSE_SELF_DELAY_MS = 1000;

/** Каталоги вызывающей сессии - перечень в схеме: модель видит, из чего выбирать активный каталог новой. */
export function sessionTools(dirs: string[], context: ToolContext = { kind: 'local', hosts: [] }): McpTool[] {
  const all = localTools(dirs);
  const byName = (...names: string[]): McpTool[] => all.filter((t) => names.includes(t.name));
  if (context.kind === 'remote') return [...byName(LIST_SESSIONS_TOOL, SEND_TO_SESSION_TOOL), reportDoneTool()];
  return context.hosts.length ? [...all, spawnAgentTool(dirs, context.hosts), closeAgentTool()] : all;
}

function reportDoneTool(): McpTool {
  return {
    name: REPORT_DONE_TOOL,
    description:
      'Сдаёт итог работы: Cyborg пересылает его сессии, которая тебя запустила, либо показывает человеку уведомлением. ' +
      'Вызывай один раз, когда закончил, упёрся в препятствие или не справился; ветку запушь и PR открой до вызова. ' +
      'Если ответ - ошибка связи с Cyborg, вызов не состоялся: повтори его позже.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['ok', 'failed', 'blocked'], description: 'ok - задача выполнена; failed - не вышло; blocked - нужен человек или чужое решение.' },
        summary: { type: 'string', minLength: 1, description: 'Итог: что сделано, что осталось, на что обратить внимание.' },
        branch: { type: 'string', description: 'Ветка с работой, запушенная в origin.' },
        pr: { type: 'string', description: 'Ссылка https на PR.' },
      },
      required: ['status', 'summary'],
      additionalProperties: false,
    },
  };
}

function spawnAgentTool(dirs: string[], hosts: string[]): McpTool {
  return {
    name: SPAWN_AGENT_TOOL,
    description:
      'Запускает агента - сессию Claude Code на сервере разработчика по SSH - и отправляет ему prompt первым сообщением. ' +
      'На хосте у агента свои клоны origin всех репозиториев проекта: repo - рабочий, остальные подключены как дополнительные; клоны стоят на ветке branch ' +
      '(нет такой ветки в origin - создаётся от ветки по умолчанию). Вкладка открывается в фоне, возвращается её номер. ' +
      'Агент этого диалога не видит: prompt - самодостаточное задание. Закончив, агент вызывает report_done, и его итог приходит тебе сообщением; ' +
      'после итога вкладка закрывается сама, а клон с незапушенной работой остаётся. keep: true оставляет вкладку и клоны до close_agent. ' +
      'Лимиты по умолчанию: 4 агента на хост, 4 ч на задачу, 30 мин простоя в работе; превышение закрывает агента с итогом failed. Вызов подтверждает человек.',
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', enum: hosts, description: 'Алиас хоста из ~/.ssh/config, заданный в проекте.' },
        repo: { type: 'string', enum: dirs, description: 'Рабочий репозиторий агента - один из каталогов проекта.' },
        branch: { type: 'string', description: 'Ветка, на которой агент работает; не начинается с «-».' },
        prompt: { type: 'string', minLength: 1, description: 'Первое сообщение агента: задание целиком. Не начинается с «-».' },
        limits: {
          type: 'object',
          properties: {
            max_agents_per_host: { type: 'integer', minimum: 1, maximum: 16 },
            task_timeout_min: { type: 'integer', minimum: 1, maximum: 1440 },
            idle_timeout_min: { type: 'integer', minimum: 1, maximum: 1440 },
          },
          additionalProperties: false,
        },
        keep: { type: 'boolean', description: 'Не закрывать вкладку и клоны после report_done.' },
      },
      required: ['host', 'repo', 'branch', 'prompt'],
      additionalProperties: false,
    },
  };
}

function closeAgentTool(): McpTool {
  return {
    name: CLOSE_AGENT_TOOL,
    description:
      'Завершает удалённого агента (вкладку проекта) в любом состоянии и удаляет его клоны на хосте. ' +
      'Клон с незапушенными коммитами, изменениями, stash остаётся: в ответе его путь на хосте. keep: true завершает сессию и оставляет клоны. Вызов подтверждает человек.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Номер удалённой сессии из list_sessions.' },
        keep: { type: 'boolean', description: 'Клоны не удалять.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  };
}

function localTools(dirs: string[]): McpTool[] {
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
        'queued - сколько сообщений send_to_session ждут конца её хода. У удалённой сессии есть host, а cwd - путь на хосте.',
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
    {
      name: CLOSE_SESSION_TOOL,
      description:
        'Закрывает вкладку Cyborg с сессией проекта - как крестик на вкладке: процесс Claude Code завершается, вкладка убирается, очередь её сообщений пропадает. ' +
        'Диалог остаётся в истории сессий проекта, его можно возобновить. ' +
        'Своя вкладка (номер с self: true в list_sessions) закрывается через секунду после ответа. ' +
        'Чужую вкладку в состоянии working, asking или starting инструмент не закрывает - её работа или вопрос человеку пропали бы; закрыть её всё же - force: true. ' +
        'Прежде чем закрыть соседку, прочитай её итог в list_sessions.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'Номер сессии из list_sessions.' },
          force: { type: 'boolean', description: 'Закрыть и работающую, и ждущую человека сессию.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
  ];
}

const args = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});

const tooLong = (text: string): boolean => Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES;

const SHELL_REFUSAL = 'текст не может начинаться с «!»: Claude Code выполнил бы его как команду оболочки без запроса разрешения';

/** Общие проверки промпта старта (ADR-0017 п.3, ADR-0019 п.8): ведущие «-» и «!», предел длины; null - годится. */
export function promptProblem(text: string, name: string, limitHint = ''): string | null {
  const head = text.trimStart();
  if (head.startsWith('-')) return `${name} не может начинаться с «-»: claude примет его за ключ командной строки`;
  if (head.startsWith('!')) return name === 'prompt' ? SHELL_REFUSAL : `${name} не может начинаться с «!»: Claude Code выполнил бы его как команду оболочки`;
  if (tooLong(text)) return `${name} длиннее ${MAX_TEXT_BYTES} байт${limitHint}`;
  return null;
}

export interface OpenSessionArgs {
  prompt: string;
  repo: string;
}

/** Аргументы от модели; ошибка - строка, её текст вернётся модели. */
export function validateOpenSession(value: unknown, dirs: string[]): OpenSessionArgs | string {
  const { prompt, repo } = args(value);
  if (typeof prompt !== 'string' || !prompt.trim()) return 'prompt - непустая строка';
  const problem = promptProblem(prompt, 'prompt', ': сократи задание или передай его файлом');
  if (problem) return problem;
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

export function validateClose(value: unknown, peers: SessionInfo[], caller: number): { id: number } | string {
  const { id, force } = args(value);
  if (force !== undefined && typeof force !== 'boolean') return 'force - true или false';
  const target = peers.find((p) => p.id === id);
  if (!target) return `сессии ${String(id)} нет среди открытых вкладок проекта: номера - в list_sessions`;
  // Вызывающая сессия в своём ходу всегда working: правило о работающих к ней не относится.
  if (force || target.id === caller || target.state === 'waiting') return { id: target.id };
  const busy =
    target.state === 'asking'
      ? `ждёт человека (${target.reason ?? 'вопрос'})`
      : target.state === 'starting'
        ? 'ещё запускается'
        : 'работает';
  return `сессия ${target.id} ${busy}: закрытие оборвёт её, закрыть всё же - force: true`;
}

export interface Limits {
  max_agents_per_host?: number;
  task_timeout_min?: number;
  idle_timeout_min?: number;
}

export interface SpawnArgs {
  host: string;
  repo: string;
  branch: string;
  prompt: string;
  limits?: Limits;
  keep: boolean;
}

const LIMIT_RANGES: Record<keyof Limits, [number, number]> = {
  max_agents_per_host: [1, 16],
  task_timeout_min: [1, 1440],
  idle_timeout_min: [1, 1440],
};

/** Аргументы spawn_agent от модели; ошибка - строка, её текст вернётся модели. */
export function validateSpawn(value: unknown, dirs: string[], hosts: string[]): SpawnArgs | string {
  const { host, repo, branch, prompt, limits, keep } = args(value);
  if (typeof host !== 'string' || !hosts.includes(host)) return `host - один из хостов проекта: ${hosts.join(', ')}`;
  if (typeof repo !== 'string' || !dirs.includes(repo)) return `repo - один из каталогов проекта: ${dirs.join(', ')}`;
  const bad = branchNameProblem(branch);
  if (bad) return bad;
  if (typeof prompt !== 'string' || !prompt.trim()) return 'prompt - непустая строка';
  const problem = promptProblem(prompt, 'prompt', ': сократи задание или передай его файлом');
  if (problem) return problem;
  if (keep !== undefined && typeof keep !== 'boolean') return 'keep - true или false';
  const out: SpawnArgs = { host, repo, branch: branch as string, prompt: prompt.trim(), keep: keep === true };
  if (limits === undefined) return out;
  if (typeof limits !== 'object' || limits === null || Array.isArray(limits)) return 'limits - объект';
  const parsed: Limits = {};
  for (const [key, val] of Object.entries(limits)) {
    const range = LIMIT_RANGES[key as keyof Limits];
    if (!range) return `limits: неизвестное поле ${key}`;
    if (typeof val !== 'number' || !Number.isInteger(val) || val < range[0] || val > range[1]) return `limits.${key} - целое от ${range[0]} до ${range[1]}`;
    parsed[key as keyof Limits] = val;
  }
  return { ...out, limits: parsed };
}

export type ReportStatus = 'ok' | 'failed' | 'blocked';

export interface ReportArgs {
  status: ReportStatus;
  summary: string;
  branch?: string;
  pr?: string;
}

/** Аргументы report_done: итог чистится как сообщение, ветка - имя ref, PR - https-ссылка. */
export function validateReport(value: unknown): ReportArgs | string {
  const { status, summary, branch, pr } = args(value);
  if (status !== 'ok' && status !== 'failed' && status !== 'blocked') return 'status - ok, failed или blocked';
  if (typeof summary !== 'string' || !cleanMessage(summary)) return 'summary - непустая строка';
  if (tooLong(summary)) return `summary длиннее ${MAX_TEXT_BYTES} байт`;
  const out: ReportArgs = { status, summary: cleanMessage(summary) };
  if (branch !== undefined) {
    const bad = branchNameProblem(branch);
    if (bad) return bad;
    out.branch = branch as string;
  }
  if (pr !== undefined) {
    if (typeof pr !== 'string' || pr.length > 2000 || !/^https:\/\/[^\s\x00-\x1f]+$/.test(pr)) return 'pr - ссылка https до 2000 знаков';
    out.pr = pr;
  }
  return out;
}

/** close_agent: цель - удалённая вкладка проекта вызывающей, в любом состоянии. */
export function validateCloseAgent(value: unknown, peers: SessionInfo[]): { id: number; keep: boolean } | string {
  const { id, keep } = args(value);
  if (keep !== undefined && typeof keep !== 'boolean') return 'keep - true или false';
  const target = peers.find((p) => p.id === id);
  if (!target) return `сессии ${String(id)} нет среди вкладок проекта: номера - в list_sessions`;
  if (!target.host) return `сессия ${target.id} локальная: закрывается close_session`;
  return { id: target.id, keep: keep === true };
}

const tail = (text: string): string => (text.length > ANSWER_TAIL ? `…${text.slice(-ANSWER_TAIL)}` : text);

export function describePeers(peers: SessionInfo[], caller: number): string {
  return JSON.stringify(
    peers.map((p) => ({
      id: p.id,
      tab: `CC${p.id}`,
      ...(p.id === caller ? { self: true } : {}),
      ...(p.host ? { host: p.host, ...(p.link ? { link: p.link } : {}) } : {}),
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
  /** Есть у spawn_agent: интерфейс открывает удалённую вкладку. */
  host?: string;
}

export interface RemoteHandoff {
  host: string;
  branch: string;
  limits?: Limits;
  keep: boolean;
}

interface Pending extends HandoffRequest {
  prompt: string;
  remote?: RemoteHandoff;
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
  request(from: number, repo: string, prompt: string, remote?: RemoteHandoff): Promise<number> {
    const hid = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(hid, `интерфейс Cyborg не открыл вкладку за ${this.timeoutMs / 1000} с`), this.timeoutMs);
      this.pending.set(hid, { hid, from, repo, prompt, remote, resolve, reject, timer });
      if (!this.send({ hid, from, repo, ...(remote ? { host: remote.host } : {}) })) this.fail(hid, 'окно Cyborg закрыто');
    });
  }

  /** Передача для session:create: ключ одноразовый, каталог - тот, что выбрала модель. */
  take(hid: unknown, cwd: unknown): Pick<Pending, 'prompt' | 'remote' | 'from' | 'resolve' | 'reject'> | null {
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
  /** Вид вызывающей: у удалённой другой набор инструментов. */
  kindOf?(id: number): SessionKind | null;
  /** Хосты проекта, у которого каталоги запуска - dirs. */
  hostsOf?(dirs: string[]): string[];
}

/** Удалённая часть: проверка хоста и лимитов, итог, завершение. Тексты результатов формирует она. */
export interface RemoteToolsPort {
  prepare(host: string, repo: string, limits?: Limits): Promise<void>;
  report(id: number, report: ReportArgs): Promise<string>;
  close(id: number, keep: boolean): Promise<string>;
}

export function createSessionTools(
  sessions: SessionsPort,
  handoffs: Pick<Handoffs, 'request'>,
  /** Закрывает вкладку сессии, а без окна - завершает её процесс. */
  close: (id: number) => void,
  closeSelfDelayMs = CLOSE_SELF_DELAY_MS,
  remote?: RemoteToolsPort,
): McpBackend {
  const contextOf = (caller: number, dirs: string[]): ToolContext => ({
    kind: sessions.kindOf?.(caller) ?? 'local',
    hosts: remote ? (sessions.hostsOf?.(dirs) ?? []) : [],
  });
  return {
    tools: (caller) => {
      const dirs = sessions.dirsOf(caller);
      return dirs ? sessionTools(dirs, contextOf(caller, dirs)) : [];
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
      if (name === CLOSE_SESSION_TOOL) {
        const valid = validateClose(value, peers, caller);
        if (typeof valid === 'string') throw new Error(valid);
        if (valid.id !== caller) {
          const target = peers.find((p) => p.id === valid.id);
          if (target?.host && remote) return remote.close(valid.id, false);
          close(valid.id);
          return `Вкладка сессии ${valid.id} закрыта.`;
        }
        setTimeout(() => close(caller), closeSelfDelayMs);
        return 'Эта вкладка закроется через секунду.';
      }
      if (name === REPORT_DONE_TOOL && remote) {
        const valid = validateReport(value);
        if (typeof valid === 'string') throw new Error(valid);
        return remote.report(caller, valid);
      }
      if ((name === CLOSE_AGENT_TOOL || name === SPAWN_AGENT_TOOL) && remote && contextOf(caller, dirs).kind === 'remote') throw new Error(`${name} недоступен удалённой сессии`);
      if (name === CLOSE_AGENT_TOOL && remote) {
        const valid = validateCloseAgent(value, peers);
        if (typeof valid === 'string') throw new Error(valid);
        return remote.close(valid.id, valid.keep);
      }
      if (name === SPAWN_AGENT_TOOL && remote) {
        const valid = validateSpawn(value, dirs, sessions.hostsOf?.(dirs) ?? []);
        if (typeof valid === 'string') throw new Error(valid);
        await remote.prepare(valid.host, valid.repo, valid.limits);
        const id = await handoffs.request(caller, valid.repo, valid.prompt, { host: valid.host, branch: valid.branch, limits: valid.limits, keep: valid.keep });
        return `Открыта вкладка удалённой сессии ${id} на ${valid.host}: клоны готовятся, итог придёт сообщением после report_done.`;
      }
      if (name !== OPEN_SESSION_TOOL) throw new Error(`неизвестный инструмент ${name}`);
      const valid = validateOpenSession(value, dirs);
      if (typeof valid === 'string') throw new Error(valid);
      const id = await handoffs.request(caller, valid.repo, valid.prompt);
      return `Открыта вкладка сессии ${id} в ${valid.repo}.`;
    },
  };
}
