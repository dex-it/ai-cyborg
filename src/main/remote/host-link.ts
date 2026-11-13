import { randomBytes } from 'node:crypto';
import { PROTO, type Msg } from '../../agentd/protocol';
import type { DiskSpace } from '../../shared/host-disk';
import { installScript, type AgentdBundle } from './install';
import { parsePreflight, PREFLIGHT_SCRIPT, type HostTools } from './preflight';
import { classifySshError, type SshChannel, type SshTransport } from './ssh';

export type LinkState = 'connecting' | 'online' | 'offline';

/** Паузы переподключения: экспонента до минуты. */
export const RECONNECT_MS = [1000, 2000, 4000, 8000, 16000, 32000, 60000];

const REQUEST_TIMEOUT_MS = 15_000;
const SUN_PATH_MAX = 107;
const RESTART_ATTEMPTS = 4;

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as NodeJS.Timeout) };

export interface HostLinkDeps {
  host: string;
  ssh: SshTransport;
  bundle: AgentdBundle;
  /** Идентификатор экземпляра Cyborg: то же окно после обрыва забирает свои сессии у демона. */
  instance: string;
  mcpPort: () => number;
  /** Держать связь и переподключаться, пока у хоста есть сессии этого экземпляра. */
  wanted: () => boolean;
  onMessage: (msg: Msg) => void;
  onState: (state: { online: boolean; reason?: string }) => void;
  /** После переподключения (не первого подключения): забрать сессии с отметок. */
  onReconnect: () => void;
  /** Задан токен Claude: вход claude на хосте не требуется. */
  claudeToken?: () => boolean;
  /** Локальный сокет микрофона, если голосовой ввод для хоста включён; null - туннеля микрофона нет. */
  mic?: () => string | null;
  timers?: Timers;
}

/** Связь с демоном на одном хосте: один долгоживущий ssh на экземпляр Cyborg, запросы по rid. */
export class HostLink {
  state: LinkState = 'offline';
  home = '';
  tools: HostTools = { gh: false, glab: false };
  /** Хэш зеркала настройки Claude, лежащего на хосте; null - зеркала нет. */
  config: string | null = null;
  /** Место на диске ~/.cyborg хоста по ответу на hello. */
  disk: DiskSpace | null = null;
  /** Канал открыт с туннелем микрофона. */
  voice = false;
  private channel: SshChannel | null = null;
  private connecting: Promise<void> | null = null;
  private readonly pending = new Map<number, { resolve: (m: Msg) => void; reject: (e: Error) => void; timer: unknown }>();
  private rid = 1;
  private attempt = 0;
  private retry: unknown = null;
  private closed = false;
  private everOnline = false;
  private readonly timers: Timers;

  constructor(private readonly deps: HostLinkDeps) {
    this.timers = deps.timers ?? realTimers;
  }

  get host(): string {
    return this.deps.host;
  }

  /** Связь есть либо устанавливается; отказ - Error с причиной для человека. */
  ensure(): Promise<void> {
    if (this.state === 'online') return Promise.resolve();
    this.connecting ??= this.connect().finally(() => (this.connecting = null));
    return this.connecting;
  }

  private async connect(): Promise<void> {
    this.closed = false;
    this.state = 'connecting';
    this.timers.clear(this.retry);
    try {
      await this.dial();
    } catch (error) {
      this.state = 'offline';
      // Подключение могло начаться из окна, а не из таймера: повтор, снятый выше, иначе потерялся бы.
      this.scheduleRetry();
      throw error;
    }
    this.state = 'online';
    this.attempt = 0;
    const again = this.everOnline;
    this.everOnline = true;
    this.deps.onState({ online: true });
    if (again) this.deps.onReconnect();
  }

  private async dial(): Promise<void> {
    const { host, ssh, bundle } = this.deps;
    const pre = await ssh.run(host, PREFLIGHT_SCRIPT);
    if (pre.code !== 0) throw new Error(classifySshError(pre.stderr));
    const checked = parsePreflight(pre.stdout, this.deps.claudeToken?.() ?? false);
    if ('missing' in checked) throw new Error(checked.missing.join('; '));
    this.home = checked.home;
    this.tools = checked.tools;
    if (!checked.installed.includes(bundle.version)) {
      const done = await ssh.run(host, installScript(bundle));
      if (done.code !== 0) throw new Error(`установка агента на хосте: ${classifySshError(done.stderr)}`);
    }
    for (let attempt = 0; attempt < RESTART_ATTEMPTS; attempt++) {
      const hello = await this.open();
      this.config = typeof hello.config === 'string' ? hello.config : null;
      const disk = hello.disk as DiskSpace | null | undefined;
      this.disk = disk && Number.isFinite(disk.free) && Number.isFinite(disk.total) ? { free: disk.free, total: disk.total } : null;
      const sessions = Number(hello.sessions ?? 0);
      const compatible = hello.proto === PROTO;
      if (hello.version === bundle.version && compatible) return;
      if (sessions > 0 && compatible) return;
      if (sessions > 0) {
        this.drop();
        throw new Error(`на хосте работает демон несовместимой версии с ${sessions} сессиями`);
      }
      await this.request({ type: 'shutdown' }).catch(() => undefined);
      this.drop();
      await new Promise((resolve) => this.timers.set(() => resolve(undefined), 300));
    }
    throw new Error('демон на хосте не обновился');
  }

  private async open(): Promise<Msg> {
    const { host, ssh, bundle } = this.deps;
    const fwd = `${this.home}/.cyborg/run/fwd-${randomBytes(8).toString('hex')}.sock`;
    if (Buffer.byteLength(fwd) > SUN_PATH_MAX) throw new Error('путь домашнего каталога хоста слишком длинный для сокета туннеля');
    const port = this.deps.mcpPort();
    const local = this.deps.mic?.() ?? null;
    const mic = `${this.home}/.cyborg/run/mic-${randomBytes(8).toString('hex')}.sock`;
    this.voice = !!local;
    const extra = [...(port ? ['-R', `${fwd}:127.0.0.1:${port}`] : []), ...(local ? ['-R', `${mic}:${local}`] : [])];
    const channel = ssh.open(host, `sh .cyborg/agentd/${bundle.version}/connect.sh`, extra);
    this.channel = channel;
    channel.onLine((line) => this.receive(line));
    channel.onExit((_code, stderr) => this.exited(channel, stderr));
    try {
      return await this.request({ type: 'hello', proto: PROTO, instance: this.deps.instance, ...(port ? { fwd } : {}), ...(local ? { mic } : {}) });
    } catch (error) {
      this.drop();
      throw error;
    }
  }

  private drop(): void {
    const channel = this.channel;
    this.channel = null;
    channel?.close();
  }

  private receive(line: string): void {
    let msg: Msg;
    try {
      msg = JSON.parse(line) as Msg;
    } catch {
      return;
    }
    const waiting = typeof msg.rid === 'number' ? this.pending.get(msg.rid) : undefined;
    if (waiting) {
      this.pending.delete(msg.rid as number);
      this.timers.clear(waiting.timer);
      if (msg.type === 'error') waiting.reject(new Error(String(msg.message ?? 'ошибка демона')));
      else waiting.resolve(msg);
      return;
    }
    this.deps.onMessage(msg);
  }

  private exited(channel: SshChannel, stderr: string): void {
    if (this.channel !== channel) return;
    this.channel = null;
    const reason = classifySshError(stderr);
    for (const [, p] of this.pending) {
      this.timers.clear(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
    if (this.state === 'connecting') return;
    this.state = 'offline';
    this.deps.onState({ online: false, reason });
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.closed || !this.deps.wanted()) return;
    const delay = RECONNECT_MS[Math.min(this.attempt, RECONNECT_MS.length - 1)];
    this.attempt++;
    this.retry = this.timers.set(() => {
      this.ensure().catch((error: Error) => this.deps.onState({ online: false, reason: error.message }));
    }, delay);
  }

  request(msg: Msg | Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Msg> {
    const channel = this.channel;
    if (!channel) return Promise.reject(new Error(`нет связи с ${this.deps.host}`));
    const rid = this.rid++;
    return new Promise((resolve, reject) => {
      const timer = this.timers.set(() => {
        this.pending.delete(rid);
        reject(new Error(`хост ${this.deps.host} не ответил за ${timeoutMs / 1000} с`));
      }, timeoutMs);
      this.pending.set(rid, { resolve, reject, timer });
      channel.write(JSON.stringify({ ...msg, rid }));
    });
  }

  /** Сообщение без ответа (ввод, размер); без связи отбрасывается. */
  send(msg: Msg | Record<string, unknown>): boolean {
    if (this.state !== 'online' || !this.channel) return false;
    this.channel.write(JSON.stringify(msg));
    return true;
  }

  /** Открыть канал заново, если туннель микрофона разошёлся с настройкой: сессии подхватываются как после обрыва. */
  async relink(): Promise<void> {
    if (this.state !== 'online' || this.voice === !!this.deps.mic?.()) return;
    this.timers.clear(this.retry);
    this.state = 'offline';
    this.drop();
    await this.ensure();
  }

  /** Закрыть канал без переподключения: демон и его сессии на хосте живут дальше. */
  close(): void {
    this.closed = true;
    this.timers.clear(this.retry);
    this.state = 'offline';
    this.drop();
  }
}
