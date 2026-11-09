import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DEFAULT_LIMITS, type Msg, type RepoSpec } from '../../agentd/protocol';
import { cleanMessage } from '../clean-text';
import type { Project } from '../projects';
import { CLOSE_SELF_DELAY_MS, type Limits, type RemoteToolsPort, type ReportArgs } from '../session-tools';
import { sameDirs, type SessionManager, type TermPort } from '../sessions';
import type { AgentdBundle } from './install';
import { HostLink, realTimers, type Timers } from './host-link';
import type { RemoteCreateArgs } from './remote-args';
import type { SshTransport } from './ssh';

export interface McpPort {
  issue(caller: number): string;
  accept(token: string, caller: number): void;
  disconnect(caller: number): void;
  readonly boundPort: number;
}

export interface RemoteDeps {
  ssh: SshTransport;
  bundle: AgentdBundle;
  sessions: SessionManager;
  mcp: McpPort;
  originUrl: (dir: string) => Promise<string | null>;
  emit: (channel: string, payload: unknown) => void;
  /** Снять вкладку: интерфейс закрывает её тем же путём, что крестик. */
  closeTab: (id: number) => void;
  /** Окно с отказом уборки и прочим, что должно быть видно и при выключенных уведомлениях. */
  alert: (title: string, text: string) => void;
  instance?: string;
  timers?: Timers;
  closeDelayMs?: number;
}

/** Вкладка удалённой сессии для интерфейса: локальный номер, хост и пути на хосте. */
export interface RemoteInfo {
  id: number;
  host: string;
  /** Локальные репозитории проекта, выбранный первым. */
  dirs: string[];
  /** Клон выбранного репозитория на хосте. */
  cwd: string;
  /** Клоны на хосте, выбранный первым: корни дерева. */
  roots: string[];
}

export interface CreateExtra {
  origin: 'tool' | 'human';
  keep?: boolean;
  spawnedBy?: number;
  limits?: Limits;
}

interface Entry {
  id: number;
  sid: string;
  host: string;
  origin: 'tool' | 'human';
  keep: boolean;
  spawnedBy?: number;
  reported: boolean;
  outPos: number;
  evPos: number;
  roots: string[];
  gone?: boolean;
  closing?: boolean;
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ENDED_GRACE_MS = 60_000;
const HOST_TEXT_MAX = 2000;

/** Текст с хоста недоверен (в stderr клона - ответ сервера origin): до очереди, окна и уведомления - без управляющих символов. */
const hostText = (value: unknown): string => Array.from(cleanMessage(typeof value === 'string' ? value : '')).slice(0, HOST_TEXT_MAX).join('');

type Cleanup = { removed: string[]; kept: { path: string; reason: string }[] };

function hostCleanup(value: unknown): Cleanup {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
  const field = (x: unknown, key: string): string => hostText(typeof x === 'object' && x !== null ? (x as Record<string, unknown>)[key] : undefined);
  return { removed: list(v.removed).map(hostText), kept: list(v.kept).map((k) => ({ path: field(k, 'path'), reason: field(k, 'reason') })) };
}

const minutes = (value: number | undefined, fallback: number): number => (value === undefined ? fallback : value * 60_000);

/** Текст итога сессии вызвавшей и уведомления: одна форма для report_done и итога лимита. */
export function reportText(id: number, host: string, report: { status: string; summary: string; branch?: string; pr?: string }): string {
  return [`Итог удалённой сессии CC${id} (${host}): ${report.status}`, report.branch ? `ветка: ${report.branch}` : '', report.pr ? `PR: ${report.pr}` : '', '', report.summary]
    .filter((line, i) => line || i === 3)
    .join('\n');
}

export function closeText(id: number, host: string, result: Cleanup): string {
  const parts = [`Сессия ${id} завершена.`];
  if (result.removed.length) parts.push(`Клоны удалены: ${result.removed.join(', ')}.`);
  if (result.kept.length) parts.push(`Уборка отказана - оставлены ${result.kept.map((k) => `${host}:${k.path} (${k.reason})`).join(', ')}.`);
  return parts.join(' ');
}

export class RemoteSessions implements RemoteToolsPort {
  private readonly links = new Map<string, HostLink>();
  private readonly bySid = new Map<string, Entry>();
  private readonly byId = new Map<number, Entry>();
  /** Завершённые, чей ended ещё может прийти: демон прежней версии шлёт его после exit. */
  private readonly ending = new Map<string, { entry: Entry; timer: unknown }>();
  private readonly timers: Timers;
  private readonly instance: string;

  constructor(private readonly deps: RemoteDeps) {
    this.instance = deps.instance ?? randomUUID();
    this.timers = deps.timers ?? realTimers;
  }

  private link(host: string): HostLink {
    let link = this.links.get(host);
    if (link) return link;
    link = new HostLink({
      host,
      ssh: this.deps.ssh,
      bundle: this.deps.bundle,
      instance: this.instance,
      mcpPort: () => this.deps.mcp.boundPort,
      wanted: () => [...this.byId.values()].some((e) => e.host === host),
      timers: this.deps.timers,
      onMessage: (msg) => this.route(msg),
      onState: ({ online, reason }) => {
        for (const e of this.byId.values()) if (e.host === host) this.deps.sessions.setLink(e.id, online);
        this.deps.emit('remote:link', { host, online, reason });
      },
      onReconnect: () => this.reattach(host),
    });
    this.links.set(host, link);
    return link;
  }

  /** Хост в порядке (проверка, демон) и под пределом числа сессий: для spawn_agent до передачи вкладки. */
  async prepare(host: string, _repo: string, limits?: Limits): Promise<void> {
    const link = this.link(host);
    await link.ensure();
    const list = await link.request({ type: 'list' });
    const live = (list.sessions as { exited: boolean }[]).filter((s) => !s.exited).length;
    const max = limits?.max_agents_per_host ?? DEFAULT_LIMITS.maxPerHost;
    if (live >= max) throw new Error(`на хосте ${host} уже ${live} удалённых сессий (предел ${max})`);
  }

  async create(project: Project, args: RemoteCreateArgs, extra: CreateExtra): Promise<RemoteInfo> {
    const repos: RepoSpec[] = [];
    for (const dir of project.repos) {
      const url = await this.deps.originUrl(dir);
      if (!url) throw new Error(`у репозитория ${dir} нет origin: удалённой сессии нечего клонировать`);
      if (url.startsWith('-')) throw new Error(`адрес origin репозитория ${dir} начинается с «-»`);
      repos.push({ local: dir, url, name: path.basename(dir) || 'repo' });
    }
    const selected = project.repos.indexOf(args.repo);
    const link = this.link(args.host);
    await link.ensure();
    const sid = randomUUID();
    const dirs = [args.repo, ...project.repos.filter((d) => d !== args.repo)];
    const entry: Entry = { id: 0, sid, host: args.host, origin: extra.origin, keep: extra.keep === true, spawnedBy: extra.spawnedBy, reported: false, outPos: 0, evPos: 0, roots: [] };
    entry.id = this.deps.sessions.adopt({
      term: this.term(entry),
      dirs,
      cwd: args.repo,
      remote: { host: args.host, origin: extra.origin, keep: entry.keep, spawnedBy: extra.spawnedBy, online: true },
    });
    this.register(entry);
    try {
      const token = this.deps.mcp.issue(entry.id);
      const reply = await link.request({
        type: 'spawn',
        sid,
        token,
        repos,
        selected,
        branch: args.branch,
        ...(args.prompt ? { prompt: args.prompt } : {}),
        origin: extra.origin,
        keep: entry.keep,
        ...(extra.spawnedBy ? { spawnedBy: extra.spawnedBy } : {}),
        limits: {
          maxPerHost: extra.limits?.max_agents_per_host ?? DEFAULT_LIMITS.maxPerHost,
          taskMs: minutes(extra.limits?.task_timeout_min, DEFAULT_LIMITS.taskMs),
          idleMs: minutes(extra.limits?.idle_timeout_min, DEFAULT_LIMITS.idleMs),
        },
        cols: 120,
        rows: 40,
      });
      entry.roots = (reply.clones as string[]) ?? [];
      const cwd = String(reply.cwd ?? args.repo);
      this.deps.sessions.setCwd(entry.id, cwd);
      return { id: entry.id, host: args.host, dirs, cwd, roots: [cwd, ...entry.roots.filter((r) => r !== cwd)] };
    } catch (error) {
      this.forget(entry);
      this.deps.sessions.discard(entry.id);
      this.deps.mcp.disconnect(entry.id);
      throw error;
    }
  }

  private term(entry: Entry): TermPort {
    const link = (): HostLink => this.link(entry.host);
    return {
      write: (data) => void link().send({ type: 'input', sid: entry.sid, data }),
      resize: (cols, rows) => void link().send({ type: 'resize', sid: entry.sid, cols, rows }),
      kill: () => void this.close(entry.id, false, false).catch((e: Error) => this.deps.alert(`Сессия ${entry.id} на ${entry.host}`, e.message)),
    };
  }

  private register(entry: Entry): void {
    this.bySid.set(entry.sid, entry);
    this.byId.set(entry.id, entry);
  }

  private forget(entry: Entry): void {
    entry.gone = true;
    this.bySid.delete(entry.sid);
    this.byId.delete(entry.id);
  }

  /** Живые сессии проекта на его хостах, не занятые другим окном: после запуска Cyborg открывает их вкладки. */
  async discover(project: Project): Promise<RemoteInfo[]> {
    const found: RemoteInfo[] = [];
    for (const host of project.hosts ?? []) {
      const link = this.link(host);
      try {
        await link.ensure();
        const list = await link.request({ type: 'list' });
        for (const item of list.sessions as Record<string, unknown>[]) {
          const info = await this.adopt(link, project, item);
          if (info) found.push(info);
        }
      } catch (error) {
        this.deps.emit('remote:link', { host, online: false, reason: (error as Error).message });
      }
      if (![...this.byId.values()].some((e) => e.host === host)) link.close();
    }
    return found;
  }

  private async adopt(link: HostLink, project: Project, item: Record<string, unknown>): Promise<RemoteInfo | null> {
    const sid = String(item.sid);
    const dirs = item.dirs as string[];
    if (this.bySid.has(sid) || item.busy || !Array.isArray(dirs) || !sameDirs(dirs, project.repos)) return null;
    if (item.exited === true) {
      // Завершившуюся без клиента сессию вкладкой не открывают; attach и ack забирают у демона exit и снимают запись.
      await link.request({ type: 'attach', sid, outFrom: 0, evFrom: 'tail' }).catch(() => undefined);
      link.send({ type: 'ack', sid });
      return null;
    }
    if (typeof item.token !== 'string' || !TOKEN.test(item.token)) return null;
    const entry: Entry = {
      id: 0,
      sid,
      host: link.host,
      origin: item.origin === 'tool' ? 'tool' : 'human',
      keep: item.keep === true,
      reported: item.reported === true,
      outPos: 0,
      evPos: 0,
      roots: (item.clones as string[]) ?? [],
    };
    const cwd = String(item.cwd);
    entry.id = this.deps.sessions.adopt({ term: this.term(entry), dirs, cwd, remote: { host: link.host, origin: entry.origin, keep: entry.keep, online: true } });
    this.register(entry);
    this.deps.mcp.accept(item.token, entry.id);
    try {
      await link.request({ type: 'attach', sid, outFrom: 0, evFrom: 'tail' });
    } catch {
      this.forget(entry);
      this.deps.sessions.discard(entry.id);
      this.deps.mcp.disconnect(entry.id);
      return null;
    }
    return { id: entry.id, host: link.host, dirs, cwd, roots: [cwd, ...entry.roots.filter((r) => r !== cwd)] };
  }

  private reattach(host: string): void {
    const link = this.links.get(host);
    if (!link) return;
    for (const e of [...this.byId.values()].filter((x) => x.host === host)) {
      link.request({ type: 'attach', sid: e.sid, outFrom: e.outPos, evFrom: e.evPos }).catch((error: Error) => {
        if (/не найдена/.test(error.message)) this.lost(e, 'сессия на хосте не найдена');
      });
    }
  }

  private lost(entry: Entry, reason: string): void {
    this.forget(entry);
    this.deps.mcp.disconnect(entry.id);
    this.deps.sessions.finish(entry.id, 1, reason);
  }

  private route(msg: Msg): void {
    const sid = typeof msg.sid === 'string' ? msg.sid : '';
    const entry = this.bySid.get(sid) ?? (msg.type === 'ended' ? this.ending.get(sid)?.entry : undefined);
    if (!entry) return;
    const { sessions } = this.deps;
    switch (msg.type) {
      case 'data':
        entry.outPos = Number(msg.at) + Buffer.byteLength(String(msg.data));
        sessions.feed(entry.id, String(msg.data));
        return;
      case 'reset':
        entry.outPos = Number(msg.at);
        sessions.feed(entry.id, '\x1bc');
        return;
      case 'events': {
        const items = msg.items as { off: number; line: string }[];
        if (!items.length) return;
        const last = items[items.length - 1];
        entry.evPos = last.off + Buffer.byteLength(last.line) + 1;
        sessions.ingest(entry.id, items.map((i) => i.line), { replay: msg.replay === true });
        return;
      }
      case 'exit':
        return this.onExit(entry, msg);
      case 'ended':
        return this.onEnded(entry, msg);
    }
  }

  private onExit(entry: Entry, msg: Msg): void {
    const reason = hostText(msg.reason) || undefined;
    this.forget(entry);
    if (entry.origin === 'tool' && !entry.reported) {
      this.ending.set(entry.sid, { entry, timer: this.timers.set(() => this.ending.delete(entry.sid), ENDED_GRACE_MS) });
    }
    this.deps.mcp.disconnect(entry.id);
    this.deps.sessions.finish(entry.id, Number(msg.code), reason);
    const { kept } = hostCleanup({ kept: msg.kept });
    if (kept.length && !entry.closing) this.deps.alert(`Сессия ${entry.id} на ${entry.host}`, closeText(entry.id, entry.host, { removed: [], kept }));
    if (reason && entry.origin === 'human') this.deps.emit('remote:report', { id: entry.id, host: entry.host, title: `CC${entry.id} · ${entry.host}`, body: reason.slice(0, 200) });
  }

  private onEnded(entry: Entry, msg: Msg): void {
    const reason = hostText(msg.reason);
    const { kept } = hostCleanup(msg.cleanup);
    const refused = kept.length ? closeText(entry.id, entry.host, { removed: [], kept }) : '';
    this.timers.clear(this.ending.get(entry.sid)?.timer ?? null);
    this.ending.delete(entry.sid);
    this.deliver(entry, { status: 'failed', summary: refused ? `${reason}\n${refused}` : reason });
    this.link(entry.host).send({ type: 'ack', sid: entry.sid });
    if (refused) this.deps.alert(`Сессия ${entry.id} на ${entry.host}`, refused);
    this.deps.closeTab(entry.id);
  }

  /** Итог - вызвавшей spawn_agent в очередь, а если её нет либо вкладку открыл человек - уведомлением. */
  private deliver(entry: Entry, report: ReportArgs): void {
    const text = reportText(entry.id, entry.host, report);
    if (entry.spawnedBy !== undefined && this.deps.sessions.enqueue(entry.spawnedBy, text)) return;
    this.deps.emit('remote:report', { id: entry.id, host: entry.host, title: `CC${entry.id} · ${entry.host}`, body: `${report.status}: ${report.summary.slice(0, 200)}` });
  }

  async report(id: number, report: ReportArgs): Promise<string> {
    const entry = this.byId.get(id);
    if (!entry) throw new Error('сессия завершена');
    if (entry.reported) throw new Error('итог этой сессии уже отправлен');
    const link = this.link(entry.host);
    if (link.state !== 'online') throw new Error(`нет связи с ${entry.host}: вызов не состоялся, повтори его позже`);
    await link.request({ type: 'report', sid: entry.sid });
    entry.reported = true;
    this.deliver(entry, report);
    if (entry.origin === 'tool' && !entry.keep) {
      const autoClose = async (): Promise<void> => {
        const { text, kept } = await this.shut(entry, false, true);
        if (kept && entry.spawnedBy !== undefined) this.deps.sessions.enqueue(entry.spawnedBy, text);
      };
      setTimeout(() => void autoClose().catch((e: Error) => this.deps.alert(`Сессия ${id} на ${entry.host}`, e.message)), this.deps.closeDelayMs ?? CLOSE_SELF_DELAY_MS);
      return 'Итог принят. Вкладка закроется через секунду, клоны с незапушенной работой останутся на хосте.';
    }
    return 'Итог принят.';
  }

  /** Завершение по правилам close_agent; tab - снять вкладку (инструмент), а не крестик, который её уже снял. */
  async close(id: number, keep: boolean, tab = true): Promise<string> {
    const entry = this.byId.get(id);
    if (!entry) throw new Error(`сессия ${id} не найдена`);
    return (await this.shut(entry, keep, tab)).text;
  }

  private async shut(entry: Entry, keep: boolean, tab: boolean): Promise<{ text: string; kept: boolean }> {
    const link = this.link(entry.host);
    if (link.state !== 'online') throw new Error(`нет связи с ${entry.host}`);
    entry.closing = true;
    const reply = await link.request({ type: 'close', sid: entry.sid, keep }, 30_000).catch((error: Error) => {
      entry.closing = false;
      throw error;
    });
    const result = hostCleanup(reply);
    const text = closeText(entry.id, entry.host, result);
    if (tab) this.deps.closeTab(entry.id);
    const kept = !keep && result.kept.length > 0;
    if (kept) this.deps.alert(`Сессия ${entry.id} на ${entry.host}`, text);
    return { text, kept };
  }

  isRemote(id: number): boolean {
    return this.byId.has(id);
  }

  /** Файловая операция над клонами сессии: запись и смена ветки каналов не имеют. */
  async fsOp(id: number, op: 'list' | 'read' | 'root' | 'branch' | 'status' | 'head', target: unknown): Promise<unknown> {
    const entry = this.byId.get(id);
    if (!entry) throw new Error('Сессия не удалённая');
    if (typeof target !== 'string' || !path.posix.isAbsolute(target) || target.split('/').includes('..')) throw new Error('Путь вне каталогов удалённой сессии');
    if (!entry.roots.some((r) => target === r || target.startsWith(r + '/'))) throw new Error('Путь вне каталогов удалённой сессии');
    const link = this.link(entry.host);
    if (link.state !== 'online') throw new Error(`нет связи с ${entry.host}`);
    const reply = await link.request({ type: 'fs', sid: entry.sid, op, path: target });
    if (typeof reply.error === 'string') throw new Error(reply.error);
    return reply.value;
  }

  /** Выход Cyborg либо смена воркспейса: каналы и записи закрываются, демон и сессии на хосте живут. */
  closeLinks(): void {
    for (const entry of [...this.byId.values()]) {
      this.forget(entry);
      this.deps.mcp.disconnect(entry.id);
      this.deps.sessions.discard(entry.id);
    }
    for (const { timer } of this.ending.values()) this.timers.clear(timer);
    this.ending.clear();
    for (const link of this.links.values()) link.close();
  }
}
