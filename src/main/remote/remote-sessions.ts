import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DEFAULT_LIMITS, type Auth, type GitCred, type MirrorFile, type Msg, type RepoSpec } from '../../agentd/protocol';
import { cleanMessage } from '../clean-text';
import { lowSpace, readHostDisk, readPurge, type HostDisk, type PurgeResult } from '../../shared/host-disk';
import type { Project } from '../projects';
import { isSessionId, type HistoryEntry } from '../history';
import type { Limits, RemoteToolsPort, ReportArgs } from '../session-tools';
import { parseRemote } from '../trackers';
import { sameDirs, type SessionManager, type TermPort } from '../sessions';
import { marketplaceUrl, type ClaudeMirror } from './claude-config';
import type { AgentdBundle } from './install';
import { HostLink, realTimers, type Timers } from './host-link';
import { readSearchReply, type RemoteCreateArgs, type RemoteFsOp } from './remote-args';
import type { SearchReply, SearchRequest } from '../../shared/search-pattern';
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
  /** Токены хостингов origin у gh и glab оператора: берутся на каждый запуск и пробуждение. */
  gitAuth?: (urls: string[]) => Promise<GitCred[]>;
  /** Токен claude setup-token для входа агента. */
  claudeToken?: () => string | null;
  /** Настройка Claude оператора для хоста: собирается на каждый запуск, на хост уходит при смене хэша. */
  mirror?: () => Promise<ClaudeMirror | null>;
  /** Память проекта репозитория: уходит на хост с запуском сессии. */
  memory?: (repo: string) => Promise<MirrorFile[]>;
  /** Предел ожидания хоста для «Истории»; по умолчанию HISTORY_TIMEOUT_MS. */
  historyTimeoutMs?: number;
}

/** Спящие сессии хостов для «Истории» и хосты, которые не ответили. */
export interface RemoteHistory {
  entries: HistoryEntry[];
  unreachable: { host: string; reason: string }[];
}

/** Зеркало в десятки МиБ идёт по ssh одной строкой: обычных 15 с ответа на медленном канале не хватает. */
const CONFIG_TIMEOUT_MS = 180_000;
/** git grep и git diff на хосте ограничены своими 15 с на команду; сверху - запас на канал. */
const SEARCH_TIMEOUT_MS = 40_000;
/** du и git status по каждой сессии хоста. */
const DISK_TIMEOUT_MS = 120_000;
/** Недоступный хост держал бы строки «Истории» до ConnectTimeout ssh (15 с) и дольше. */
const HISTORY_TIMEOUT_MS = 8_000;

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
  /** Итог текущего круга работы сдан. */
  reported?: boolean;
  /** Чего агенту не хватает на хосте: интерфейс печатает в терминал вкладки. */
  notes?: string[];
  /** Размер pty на хосте: xterm берёт его до догона вывода, иначе экран Claude ляжет в чужую ширину. */
  size?: TermSize;
}

interface TermSize {
  cols: number;
  rows: number;
}

const START_SIZE: TermSize = { cols: 120, rows: 40 };

const sizeOf = (reply: Record<string, unknown>): TermSize | undefined =>
  Number.isInteger(reply.cols) && Number.isInteger(reply.rows) ? { cols: Number(reply.cols), rows: Number(reply.rows) } : undefined;

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
  /** Запись без вкладки: завершившуюся без клиента сессию держат только ради доставки её итога. */
  ghost?: boolean;
  /** Окно об отказе уборки уже показано: демон кладёт один и тот же результат уборки и в exit, и в ended. */
  refusalShown?: boolean;
  /** Итог close применён: повторный close и поздний ответ первого несут один результат демона. */
  settled?: boolean;
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ENDED_GRACE_MS = 60_000;
const CLOSE_WAIT_MS = 30_000;
const CLOSE_LATE_MS = 15 * 60_000;

class SlowClose extends Error {}
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

/** Номер вкладки для текста; у записи без вкладки - начало идентификатора сессии на хосте. */
const tag = (e: { id: number; sid: string; ghost?: boolean }): string => (e.ghost ? e.sid.slice(0, 8) : String(e.id));

const minutes = (value: number | undefined, fallback: number): number => (value === undefined ? fallback : value * 60_000);

/** Текст итога сессии вызвавшей и уведомления: одна форма для report_done и итога лимита. */
export function reportText(id: number | string, host: string, report: { status: string; summary: string; branch?: string; pr?: string }): string {
  return [`Итог удалённой сессии CC${id} (${host}): ${report.status}`, report.branch ? `ветка: ${report.branch}` : '', report.pr ? `PR: ${report.pr}` : '', '', report.summary]
    .filter((line, i) => line || i === 3)
    .join('\n');
}

export function closeText(id: number | string, host: string, result: Cleanup): string {
  const parts = [`Сессия ${id} завершена.`];
  if (result.removed.length) parts.push(`Клоны удалены: ${result.removed.join(', ')}.`);
  if (result.kept.length) parts.push(`Уборка отказана - оставлены ${result.kept.map((k) => `${host}:${k.path} (${k.reason})`).join(', ')}.`);
  return parts.join(' ');
}

export class RemoteSessions implements RemoteToolsPort {
  private readonly links = new Map<string, HostLink>();
  private readonly lowWarned = new Set<string>();
  private readonly bySid = new Map<string, Entry>();
  private readonly waking = new Set<string>();
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
      claudeToken: () => !!this.deps.claudeToken?.(),
      onMessage: (msg) => this.route(msg),
      onState: ({ online, reason }) => {
        for (const e of this.byId.values()) if (e.host === host) this.deps.sessions.setLink(e.id, online);
        this.deps.emit('remote:link', { host, online, reason });
        // Одно предупреждение на хост за запуск Cyborg: переподключения его не повторяют.
        if (online && link?.disk && !this.lowWarned.has(host) && lowSpace(link.disk)) {
          this.lowWarned.add(host);
          this.deps.emit('remote:disk-low', { host, ...link.disk });
        }
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
    const live = (list.sessions as { exited?: boolean; asleep?: boolean }[]).filter((s) => !s.exited && !s.asleep).length;
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
      const mirror = await this.mirror();
      const setupNotes = await this.configure(link, mirror);
      const auth = await this.auth(repos.map((r) => r.url), repos[selected].url);
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
        ...START_SIZE,
        auth,
        ...(mirror ? { env: mirror.env, mcp: mirror.mcp } : {}),
        memory: (await this.deps.memory?.(args.repo).catch(() => [])) ?? [],
      });
      entry.roots = (reply.clones as string[]) ?? [];
      const cwd = String(reply.cwd ?? args.repo);
      this.deps.sessions.setCwd(entry.id, cwd);
      return { id: entry.id, host: args.host, dirs, cwd, roots: [cwd, ...entry.roots.filter((r) => r !== cwd)], notes: [...this.notes(link, repos.map((r) => r.url), auth), ...setupNotes], size: START_SIZE };
    } catch (error) {
      this.forget(entry);
      this.deps.sessions.discard(entry.id);
      this.deps.mcp.disconnect(entry.id);
      throw error;
    }
  }

  /** Доступы агента собираются заново на каждый запуск: Cyborg их не хранит, отозванный токен не переживает перезапуск. */
  private async auth(urls: string[], primaryUrl: string | undefined): Promise<Auth> {
    const git = this.deps.gitAuth ? await this.deps.gitAuth(urls).catch(() => []) : [];
    const primary = primaryUrl ? parseRemote(primaryUrl)?.host : undefined;
    const claude = this.deps.claudeToken?.();
    return { git, ...(primary ? { primary } : {}), ...(claude ? { claude } : {}) };
  }

  private async mirror(): Promise<ClaudeMirror | null> {
    return this.deps.mirror ? await this.deps.mirror().catch(() => null) : null;
  }

  /** Настройка Claude на хост, если там другая: файлы ложатся до ответа, плагины демон ставит сам и запуск агента их ждёт. */
  private async configure(link: HostLink, mirror: ClaudeMirror | null): Promise<string[]> {
    if (!mirror) return [];
    const notes = [...mirror.skipped];
    if (link.config === mirror.hash) return notes;
    try {
      const { hash, files, marketplaces, plugins } = mirror;
      // Доступ только к маркетплейсам: токены хостингов проекта сессии сюда не нужны.
      const git = this.deps.gitAuth ? await this.deps.gitAuth(marketplaces.map((m) => marketplaceUrl(m.source))).catch(() => []) : [];
      const auth: Auth = { git };
      await link.request({ type: 'config', hash, files, marketplaces, plugins, auth }, CONFIG_TIMEOUT_MS);
      link.config = hash;
    } catch (error) {
      notes.push(`настройка Claude на хост не передана: ${(error as Error).message}`);
    }
    return notes;
  }

  private notes(link: HostLink, urls: string[], auth: Auth): string[] {
    const notes: string[] = [];
    const hosts = new Set(urls.map((u) => parseRemote(u)?.host).filter((h): h is string => !!h));
    for (const host of hosts) if (!auth.git.some((c) => c.host === host)) notes.push(`для ${host} нет токена gh или glab на этой машине: клон и push идут ключами хоста`);
    if (auth.git.some((c) => c.kind === 'github') && !link.tools.gh) notes.push('на хосте нет gh: агент не откроет PR');
    if (auth.git.some((c) => c.kind === 'gitlab') && !link.tools.glab) notes.push('на хосте нет glab: агент не откроет MR');
    return notes;
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
    if (this.bySid.get(entry.sid) === entry) this.bySid.delete(entry.sid);
    if (this.byId.get(entry.id) === entry) this.byId.delete(entry.id);
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
      this.closeIfIdle(host);
    }
    return found;
  }

  /** Канал без вкладок и без призраков, ждущих свой итог, не нужен: призрак закрывается сам, когда итог доставлен. */
  private closeIfIdle(host: string): void {
    const busy = [...this.byId.values(), ...this.bySid.values()].some((e) => e.host === host);
    if (!busy) this.links.get(host)?.close();
  }

  private async adopt(link: HostLink, project: Project, item: Record<string, unknown>): Promise<RemoteInfo | null> {
    const sid = String(item.sid);
    const dirs = item.dirs as string[];
    if (this.bySid.has(sid) || item.busy || item.asleep || !Array.isArray(dirs) || !sameDirs(dirs, project.repos)) return null;
    if (item.exited === true) {
      // Вкладки нет, но итог (ended) и оставленные клоны (exit) доходят до человека; запись на хосте снимает ack либо сам exit.
      const ghost: Entry = {
        id: 0,
        sid,
        host: link.host,
        origin: item.origin === 'tool' ? 'tool' : 'human',
        keep: item.keep === true,
        reported: item.reported === true,
        outPos: 0,
        evPos: 0,
        roots: [],
        ghost: true,
      };
      this.bySid.set(sid, ghost);
      await link.request({ type: 'attach', sid, outFrom: 0, evFrom: 'tail' }).catch(() => this.bySid.delete(sid));
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
    let size: TermSize | undefined;
    try {
      size = sizeOf(await link.request({ type: 'attach', sid, outFrom: 0, evFrom: 'tail' }));
    } catch {
      this.forget(entry);
      this.deps.sessions.discard(entry.id);
      this.deps.mcp.disconnect(entry.id);
      return null;
    }
    return { id: entry.id, host: link.host, dirs, cwd, roots: [cwd, ...entry.roots.filter((r) => r !== cwd)], reported: entry.reported, size };
  }

  /** Спящие сессии проекта на его хостах - строки «Истории»: хосты опрашиваются вместе, не ответивший за предел назван, а не ждётся. */
  async history(project: Project): Promise<RemoteHistory> {
    const limit = this.deps.historyTimeoutMs ?? HISTORY_TIMEOUT_MS;
    const out: RemoteHistory = { entries: [], unreachable: [] };
    await Promise.all(
      (project.hosts ?? []).map(async (host) => {
        let timer: unknown = null;
        const late = new Promise<never>((_, reject) => {
          timer = this.timers.set(() => reject(new Error(`хост не ответил за ${Math.round(limit / 1000)} с`)), limit);
        });
        try {
          out.entries.push(...(await Promise.race([this.asleepOn(project, host), late])));
        } catch (error) {
          out.unreachable.push({ host, reason: (error as Error).message });
        } finally {
          this.timers.clear(timer);
        }
      }),
    );
    return out;
  }

  private async asleepOn(project: Project, host: string): Promise<HistoryEntry[]> {
    const found: HistoryEntry[] = [];
    try {
      const link = this.link(host);
      await link.ensure();
      const list = await link.request({ type: 'list' });
      for (const item of list.sessions as Record<string, unknown>[]) {
        const dirs = item.dirs as string[];
        if (item.asleep !== true || !isSessionId(item.sid) || !Array.isArray(dirs) || !sameDirs(dirs, project.repos)) continue;
        const title = hostText(item.title) || hostText(item.branch) || String(item.sid).slice(0, 8);
        found.push({ id: item.sid, repo: dirs[0], title, updated: Number(item.lastActive) || 0, host });
      }
      return found;
    } catch (error) {
      this.deps.emit('remote:link', { host, online: false, reason: (error as Error).message });
      throw error;
    } finally {
      this.closeIfIdle(host);
    }
  }

  /** Пробуждение спящей сессии: claude --resume в тех же клонах, вкладка - как у подхваченной. */
  async wake(project: Project, host: string, sid: string): Promise<RemoteInfo> {
    if (!(project.hosts ?? []).includes(host) || !isSessionId(sid)) throw new Error('Некорректное пробуждение сессии');
    // Второе нажатие, пока первое пробуждение собирает зеркало и доступы, перезаписало бы запись сессии, а его отказ снял бы её у первой вкладки.
    if (this.bySid.has(sid) || this.waking.has(sid)) throw new Error('сессия уже просыпается или открыта');
    this.waking.add(sid);
    try {
      return await this.wakeOn(project, host, sid);
    } finally {
      this.waking.delete(sid);
    }
  }

  private async wakeOn(project: Project, host: string, sid: string): Promise<RemoteInfo> {
    const link = this.link(host);
    await link.ensure();
    const list = await link.request({ type: 'list' });
    const item = (list.sessions as Record<string, unknown>[]).find((s) => s.sid === sid);
    const dirs = item?.dirs as string[] | undefined;
    if (!item || item.asleep !== true || !Array.isArray(dirs) || !sameDirs(dirs, project.repos)) throw new Error(`спящая сессия не найдена на ${host}`);
    // Номер вызвавшей из прошлого сна указывал бы на чужую вкладку: разбуженную ведёт человек, и демон снимает с неё таймеры задачи.
    const entry: Entry = { id: 0, sid, host, origin: 'human', keep: item.keep === true, reported: false, outPos: 0, evPos: 0, roots: [] };
    const cwd0 = String(item.cwd);
    entry.id = this.deps.sessions.adopt({ term: this.term(entry), dirs, cwd: cwd0, remote: { host, origin: entry.origin, keep: entry.keep, online: true } });
    this.register(entry);
    try {
      const urls = new Map<string, string>();
      for (const dir of dirs) {
        const url = await this.deps.originUrl(dir);
        if (url) urls.set(dir, url);
      }
      const mirror = await this.mirror();
      const setupNotes = await this.configure(link, mirror);
      const auth = await this.auth([...urls.values()], urls.get(dirs[0]));
      const extra = mirror ? { env: mirror.env, mcp: mirror.mcp } : {};
      const reply = await link.request({ type: 'wake', sid, token: this.deps.mcp.issue(entry.id), ...START_SIZE, auth, ...extra });
      entry.roots = (reply.clones as string[]) ?? [];
      const cwd = String(reply.cwd ?? cwd0);
      this.deps.sessions.setCwd(entry.id, cwd);
      return { id: entry.id, host, dirs, cwd, roots: [cwd, ...entry.roots.filter((r) => r !== cwd)], reported: false, notes: [...this.notes(link, [...urls.values()], auth), ...setupNotes], size: START_SIZE };
    } catch (error) {
      this.forget(entry);
      this.deps.sessions.discard(entry.id);
      this.deps.mcp.disconnect(entry.id);
      this.closeIfIdle(host);
      throw error;
    }
  }

  /** Место на хосте и его сессии для окна «Место на хостах». */
  async disk(project: Project, host: string): Promise<HostDisk> {
    if (!(project.hosts ?? []).includes(host)) throw new Error('Хост не из проекта');
    const link = this.link(host);
    try {
      await link.ensure();
      return readHostDisk(host, await link.request({ type: 'disk' }, DISK_TIMEOUT_MS));
    } finally {
      this.closeIfIdle(host);
    }
  }

  /** Удаление отмеченных сессий на хосте; force - и клонов с незапушенной работой. */
  async purge(project: Project, host: string, sids: string[], force: boolean): Promise<PurgeResult[]> {
    if (!(project.hosts ?? []).includes(host) || !Array.isArray(sids) || !sids.every(isSessionId)) throw new Error('Некорректное удаление сессий');
    const link = this.link(host);
    try {
      await link.ensure();
      return readPurge(await link.request({ type: 'purge', sids, force }, CLOSE_LATE_MS));
    } finally {
      this.closeIfIdle(host);
    }
  }

  /** Удаление спящей сессии из «Истории»: уборка клонов по правилам close_agent; текст с отказом уборки - для окна. */
  async removeAsleep(project: Project, host: string, sid: string): Promise<string> {
    if (!(project.hosts ?? []).includes(host) || !isSessionId(sid)) throw new Error('Некорректное удаление сессии');
    const link = this.link(host);
    try {
      await link.ensure();
      const reply = await link.request({ type: 'close', sid, keep: false }, CLOSE_LATE_MS);
      const result = hostCleanup(reply);
      return result.kept.length ? closeText(sid.slice(0, 8), host, result) : '';
    } finally {
      this.closeIfIdle(host);
    }
  }

  private reattach(host: string): void {
    const link = this.links.get(host);
    if (!link) return;
    for (const e of [...this.byId.values()].filter((x) => x.host === host)) {
      link.request({ type: 'attach', sid: e.sid, outFrom: e.outPos, evFrom: e.evPos }).then(
        (reply) => {
          if (typeof reply.reported === 'boolean') this.setReported(e, reply.reported);
        },
        (error: Error) => {
          if (/не найдена/.test(error.message)) this.lost(e, 'сессия на хосте не найдена');
        },
      );
    }
  }

  private setReported(entry: Entry, reported: boolean): void {
    if (entry.reported === reported || entry.gone) return;
    entry.reported = reported;
    this.deps.emit('remote:state', { id: entry.id, reported });
  }

  /** Сон по простою: процесс на хосте остановлен, клоны и разговор целы - продолжить можно из «Истории». */
  private onSlept(entry: Entry): void {
    this.forget(entry);
    this.deps.mcp.disconnect(entry.id);
    this.deps.sessions.finish(entry.id, 0, 'сессия уснула');
    this.deps.closeTab(entry.id);
    const text = `Удалённая сессия CC${entry.id} (${entry.host}) уснула после простоя: клоны и разговор остались на хосте, продолжить её можно из «Истории».`;
    if (entry.spawnedBy === undefined || !this.deps.sessions.enqueue(entry.spawnedBy, text)) {
      this.deps.emit('remote:report', { id: entry.id, host: entry.host, title: `CC${entry.id} · ${entry.host}`, body: 'Сессия уснула после простоя: продолжить её можно из «Истории».' });
    }
    this.closeIfIdle(entry.host);
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
    if (entry.ghost && msg.type !== 'exit' && msg.type !== 'ended') return;
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
      case 'round':
        return this.setReported(entry, false);
      case 'slept':
        return this.onSlept(entry);
      case 'exit':
        return this.onExit(entry, msg);
      case 'ended':
        return this.onEnded(entry, msg);
    }
  }

  private onExit(entry: Entry, msg: Msg): void {
    const reason = hostText(msg.reason) || undefined;
    this.forget(entry);
    if (entry.origin === 'tool' && !entry.reported && !entry.ghost) {
      this.ending.set(entry.sid, { entry, timer: this.timers.set(() => this.ending.delete(entry.sid), ENDED_GRACE_MS) });
    }
    if (!entry.ghost) {
      this.deps.mcp.disconnect(entry.id);
      this.deps.sessions.finish(entry.id, Number(msg.code), reason);
    }
    if (entry.ghost) this.closeIfIdle(entry.host);
    const { kept } = hostCleanup({ kept: msg.kept });
    if (kept.length && !entry.closing && !entry.refusalShown) {
      entry.refusalShown = true;
      this.deps.alert(`Сессия ${tag(entry)} на ${entry.host}`, closeText(tag(entry), entry.host, { removed: [], kept }));
    }
    if (reason && entry.origin === 'human') this.deps.emit('remote:report', { id: entry.id, host: entry.host, title: `CC${tag(entry)} · ${entry.host}`, body: reason.slice(0, 200) });
  }

  private onEnded(entry: Entry, msg: Msg): void {
    const reason = hostText(msg.reason);
    const { kept } = hostCleanup(msg.cleanup);
    const refused = kept.length ? closeText(tag(entry), entry.host, { removed: [], kept }) : '';
    this.timers.clear(this.ending.get(entry.sid)?.timer ?? null);
    this.ending.delete(entry.sid);
    this.deliver(entry, { status: 'failed', summary: refused ? `${reason}\n${refused}` : reason });
    this.link(entry.host).send({ type: 'ack', sid: entry.sid });
    if (refused && !entry.refusalShown) {
      entry.refusalShown = true;
      this.deps.alert(`Сессия ${tag(entry)} на ${entry.host}`, refused);
    }
    if (!entry.ghost) this.deps.closeTab(entry.id);
  }

  /** Итог - вызвавшей spawn_agent в очередь, а если её нет либо вкладку открыл человек - уведомлением. */
  private deliver(entry: Entry, report: ReportArgs): void {
    const text = reportText(entry.id, entry.host, report);
    if (entry.spawnedBy !== undefined && this.deps.sessions.enqueue(entry.spawnedBy, text)) return;
    this.deps.emit('remote:report', { id: entry.id, host: entry.host, title: `CC${tag(entry)} · ${entry.host}`, body: `${report.status}: ${report.summary.slice(0, 200)}` });
  }

  async report(id: number, report: ReportArgs): Promise<string> {
    const entry = this.byId.get(id);
    if (!entry) throw new Error('сессия завершена');
    if (entry.reported) throw new Error('итог этого круга работы уже отправлен: новый круг начнётся со следующего сообщения сессии');
    const link = this.link(entry.host);
    if (link.state !== 'online') throw new Error(`нет связи с ${entry.host}: вызов не состоялся, повтори его позже`);
    await link.request({ type: 'report', sid: entry.sid });
    this.setReported(entry, true);
    this.deliver(entry, report);
    return 'Итог принят. Сессия остаётся открытой: следующее сообщение начнёт новый круг работы, и report_done снова станет доступен.';
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
    // Уборка клона с node_modules длится дольше, чем ждёт вызвавшая: поздний ответ не теряется.
    const reply = link.request({ type: 'close', sid: entry.sid, keep }, CLOSE_LATE_MS);
    let timer: unknown = null;
    const slow = new Promise<never>((_resolve, reject) => {
      timer = this.timers.set(() => reject(new SlowClose(`хост ${entry.host} не ответил за ${CLOSE_WAIT_MS / 1000} с: если уборка закончится позже, её итог придёт отдельно`)), CLOSE_WAIT_MS);
    });
    try {
      const done = this.settle(entry, keep, tab, await Promise.race([reply, slow]));
      return done ?? { text: closeText(entry.id, entry.host, { removed: [], kept: [] }), kept: false };
    } catch (error) {
      entry.closing = false;
      if (error instanceof SlowClose) {
        reply.then(
          (msg) => {
            const late = this.settle(entry, keep, tab, msg);
            if (late?.kept && entry.spawnedBy !== undefined) this.deps.sessions.enqueue(entry.spawnedBy, late.text);
          },
          () => undefined,
        );
      }
      throw error;
    } finally {
      this.timers.clear(timer);
    }
  }

  private settle(entry: Entry, keep: boolean, tab: boolean, reply: Msg): { text: string; kept: boolean } | null {
    if (entry.settled) return null;
    entry.settled = true;
    const result = hostCleanup(reply);
    const text = closeText(entry.id, entry.host, result);
    if (tab) this.deps.closeTab(entry.id);
    const kept = !keep && result.kept.length > 0;
    if (kept && !entry.refusalShown) {
      entry.refusalShown = true;
      this.deps.alert(`Сессия ${entry.id} на ${entry.host}`, text);
    }
    return { text, kept };
  }

  isRemote(id: number): boolean {
    return this.byId.has(id);
  }

  /** Файловая операция над клонами сессии: запись и смена ветки каналов не имеют. */
  async fsOp(id: number, op: RemoteFsOp, target: unknown): Promise<unknown> {
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

  /** Поиск по содержимому или изменениям клона: корень - каталог вкладки удалённой сессии. */
  async search(id: number, mode: 'text' | 'changes', request: SearchRequest): Promise<SearchReply> {
    const entry = this.byId.get(id);
    if (!entry) throw new Error('Сессия не удалённая');
    const { root } = request;
    if (!entry.roots.some((r) => root === r || root.startsWith(r + '/'))) throw new Error('Корень поиска вне каталогов удалённой сессии');
    const link = this.link(entry.host);
    if (link.state !== 'online') throw new Error(`нет связи с ${entry.host}`);
    const reply = await link.request({ type: 'search', sid: entry.sid, mode, request }, SEARCH_TIMEOUT_MS);
    if (typeof reply.error === 'string') throw new Error(reply.error);
    return readSearchReply(reply.value);
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
