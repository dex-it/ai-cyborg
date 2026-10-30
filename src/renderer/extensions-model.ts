/**
 * Модель окна «Расширения»: какие записи попадают в область («Сессия», «Проект», «Везде»), из них строятся деревья вкладок
 * и фильтруются запросом. Без DOM: чистые функции, которые проверяют тесты (FR-14002, FR-14005, FR-14007).
 */

import type { Component, ExtensionsReply, Hub, HubContent, InstalledPlugin, Marketplace, McpHealth, McpServer, ProbeEntry, Scope, StandaloneComponent } from '../shared/extensions';
import { basename } from './dom';
import type { Matcher } from './search-model';

export type ExtView = 'session' | 'project' | 'everywhere';
export type ExtTab = 'marketplaces' | 'installed' | 'mcp' | 'hubs';

export interface ExtContext {
  /** Репозитории проекта. */
  repos: string[];
  /** Активная сессия: рабочий каталог и репозиторий запуска; null - сессии нет. */
  session: { root: string; repo: string } | null;
}

/** Каталоги, которые окно просит прочитать: репозитории проекта и рабочий каталог сессии. */
export function requestedDirs(ctx: ExtContext): string[] {
  return [...new Set([...ctx.repos, ...(ctx.session ? [ctx.session.root, ctx.session.repo] : [])])];
}

/** Область по умолчанию: «Сессия», пока она есть, иначе «Проект». */
export function defaultView(ctx: ExtContext): ExtView {
  return ctx.session ? 'session' : 'project';
}

/** Что узел делает по кнопке: окно строит по этому форму подтверждения. */
export type NodeAction =
  | { type: 'install'; plugin: string; marketplace: string }
  | { type: 'uninstall'; plugin: InstalledPlugin }
  | { type: 'market-remove'; market: Marketplace; installed: string[] }
  | { type: 'market-add'; source: string; name: string }
  | { type: 'hub-toggle'; hub: Hub }
  | { type: 'hub-remove'; hub: Hub };

export interface ExtNode {
  key: string;
  level: number;
  kind: 'group' | 'marketplace' | 'plugin' | 'component' | 'mcp' | 'hub' | 'entry' | 'note';
  label: string;
  /** Короткая подпись справа: версия, число, транспорт. */
  detail?: string;
  description?: string;
  badges: string[];
  actions: { label: string; action: NodeAction }[];
  children: ExtNode[];
  /** Раскрыт, пока человек не решил иначе. */
  open?: boolean;
}

const SCOPE_BADGE: Record<Scope | 'plugin' | 'claudeai', string> = {
  user: 'везде',
  project: 'проект',
  local: 'локально',
  managed: 'организация',
  session: 'на сессию',
  synced: 'claude.ai',
  plugin: 'плагин',
  claudeai: 'claude.ai',
};

const node = (key: string, level: number, kind: ExtNode['kind'], label: string, extra: Partial<ExtNode> = {}): ExtNode => ({
  key,
  level,
  kind,
  label,
  badges: [],
  actions: [],
  children: [],
  ...extra,
});

// ---------- области ----------

interface Slice {
  /** Каталоги, чьи project и local записи видны. */
  own: string[];
  /** Каталоги, подхваченные сессией через --add-dir: скиллы, команды, агенты и плагины, но не MCP. */
  added: string[];
}

export function slice(view: ExtView, ctx: ExtContext): Slice {
  if (view === 'everywhere') return { own: [], added: [] };
  if (view === 'project' || !ctx.session) return { own: ctx.repos, added: [] };
  const own = [...new Set([ctx.session.root, ctx.session.repo])];
  return { own, added: ctx.repos.filter((repo) => !own.includes(repo)) };
}

type Where = { group: 'user' } | { group: 'managed' } | { group: 'dir'; dir: string; added: boolean } | null;

/** Где запись стоит в выбранной области; null - в этой области её нет. */
export function place(view: ExtView, ctx: ExtContext, scope: Scope | 'plugin' | 'claudeai', dir: string | undefined, kind: 'config' | 'mcp'): Where {
  if (scope === 'managed') return { group: 'managed' };
  if (scope !== 'project' && scope !== 'local') return { group: 'user' };
  if (!dir) return null;
  const s = slice(view, ctx);
  if (s.own.includes(dir)) return { group: 'dir', dir, added: false };
  if (kind === 'config' && s.added.includes(dir)) return { group: 'dir', dir, added: true };
  return null;
}

/** Подпись области над списком. */
export function viewNote(view: ExtView, ctx: ExtContext): string {
  if (view === 'everywhere') return 'Действует во всех проектах и воркспейсах: настройки пользователя, организации и claude.ai';
  if (view === 'project' || !ctx.session) return `Проект: репозиториев ${ctx.repos.length}; общее для пользователя показано один раз`;
  const added = slice(view, ctx).added.length;
  return `Сессия: ${basename(ctx.session.root)} и общее для пользователя${added ? `; из доп. каталогов (--add-dir) скиллы, команды, агенты и плагины: ${added}` : ''}`;
}

// ---------- группы ----------

interface Group {
  node: ExtNode;
  order: number;
}

class Groups {
  private readonly groups = new Map<string, Group>();
  constructor(
    private readonly tab: string,
    private readonly ctx: ExtContext,
    private readonly view: ExtView,
  ) {}

  of(where: NonNullable<Where>): ExtNode {
    const key = where.group === 'dir' ? `dir:${where.dir}` : where.group;
    let group = this.groups.get(key);
    if (!group) {
      const label =
        where.group === 'user'
          ? 'Везде · для вас во всех проектах'
          : where.group === 'managed'
            ? 'Организация'
            : where.added
              ? `Доп. каталог · ${basename(where.dir)}`
              : this.view === 'session' && this.ctx.session && (where.dir === this.ctx.session.root || where.dir === this.ctx.session.repo)
                ? `Сессия · ${basename(where.dir)}`
                : `Проект · ${basename(where.dir)}`;
      const order = where.group === 'user' ? 0 : where.group === 'managed' ? 1 : (where.added ? 100 : 10) + this.ctx.repos.indexOf(where.dir);
      const n = node(`${this.tab}/${key}`, 1, 'group', label, { open: true, description: where.group === 'dir' ? where.dir : undefined });
      group = { node: n, order };
      this.groups.set(key, group);
    }
    return group.node;
  }

  result(): ExtNode[] {
    return [...this.groups.values()].sort((a, b) => a.order - b.order).map((g) => g.node);
  }
}

// ---------- имена ----------

/** Как вызывается компонент плагина: `/плагин:скилл`; агент называется `плагин:агент`. */
export function invocation(pluginName: string | null, c: Component): string {
  const name = pluginName ? `${pluginName}:${c.name}` : c.name;
  return c.kind === 'agent' ? name : `/${name}`;
}

const KIND_LABEL = { skill: 'скилл', command: 'команда', agent: 'агент' } as const;

function componentNode(key: string, level: number, pluginName: string | null, c: Component): ExtNode {
  return node(key, level, 'component', invocation(pluginName, c), { detail: KIND_LABEL[c.kind], description: c.description });
}

// ---------- вкладки ----------

export interface ExtData {
  reply: ExtensionsReply;
  /** Содержимое включённых хабов по идентификатору; нет записи - не загружено. */
  hubs: Hub[];
  hubContent: Map<string, HubContent>;
  health: Map<string, ProbeEntry>;
}

const enabledText = (p: InstalledPlugin, view: ExtView, ctx: ExtContext): string | null => {
  const dirs = view === 'everywhere' ? [] : slice(view, ctx).own;
  if (p.scope === 'project' || p.scope === 'local') {
    const on = p.dir ? p.enabledIn[p.dir] : undefined;
    return on === false ? 'выключен' : null;
  }
  if (!dirs.length) return p.enabledGlobal ? null : 'выключен';
  const off = dirs.filter((d) => p.enabledIn[d] === false);
  if (!off.length) return null;
  return off.length === dirs.length ? 'выключен' : `выключен в ${off.map(basename).join(', ')}`;
};

const installedHere = (data: ExtData, view: ExtView, ctx: ExtContext): InstalledPlugin[] =>
  data.reply.plugins.filter((p) => place(view, ctx, p.scope, p.dir, 'config') !== null);

/** Вкладка «Магазины»: магазин → плагин → скилл, команда, агент. */
export function marketplaceTree(data: ExtData, view: ExtView, ctx: ExtContext): ExtNode[] {
  const visibleDirs = new Set([...slice(view, ctx).own, ...slice(view, ctx).added]);
  const installed = installedHere(data, view, ctx);
  const out: ExtNode[] = [];
  for (const market of data.reply.marketplaces) {
    if (!market.known && !market.declaredBy.some((d) => visibleDirs.has(d))) continue;
    const key = `marketplaces/${market.name}`;
    const here = installed.filter((p) => p.marketplace === market.name);
    const top = node(key, 1, 'marketplace', market.name, {
      detail: market.known ? `плагинов ${market.plugins.length}${market.truncated ? '+' : ''}` : undefined,
      description: [market.source, market.updated ? `обновлён ${market.updated.slice(0, 10)}` : '', market.problem ?? ''].filter(Boolean).join(' · '),
      badges: market.known ? [] : ['назван в репозитории, не подключён'],
    });
    if (market.known) top.actions.push({ label: 'Отключить…', action: { type: 'market-remove', market, installed: here.map((p) => p.id) } });
    else {
      const source = addableSource(market.source);
      if (source) top.actions.push({ label: 'Подключить', action: { type: 'market-add', source, name: market.name } });
    }
    for (const plugin of market.plugins) {
      const id = `${plugin.name}@${market.name}`;
      const mine = here.filter((p) => p.name === plugin.name);
      const n = node(`${key}/${plugin.name}`, 2, 'plugin', plugin.name, {
        detail: plugin.version,
        description: [plugin.category, plugin.description].filter(Boolean).join(' · '),
        badges: mine.map((p) => `установлен · ${SCOPE_BADGE[p.scope]}${p.dir ? ` ${basename(p.dir)}` : ''}`),
      });
      if (market.known) n.actions.push({ label: 'Установить…', action: { type: 'install', plugin: id, marketplace: market.name } });
      if (plugin.components === null) n.children.push(node(`${n.key}/?`, 3, 'note', 'Состав виден после установки: исходники плагина не в клоне магазина'));
      else plugin.components.forEach((c, i) => n.children.push(componentNode(`${n.key}/${i}`, 3, plugin.name, c)));
      top.children.push(n);
    }
    out.push(top);
  }
  return out;
}

/** Вкладка «Установленные»: область → плагин (с составом) либо отдельный скилл, команда, агент. */
export function installedTree(data: ExtData, view: ExtView, ctx: ExtContext): ExtNode[] {
  const groups = new Groups('installed', ctx, view);
  for (const p of installedHere(data, view, ctx)) {
    const where = place(view, ctx, p.scope, p.dir, 'config')!;
    const state = enabledText(p, view, ctx);
    const n = node(`installed/${p.id}/${p.scope}/${p.dir ?? ''}`, 2, 'plugin', p.name, {
      detail: p.version,
      description: [`${p.id}`, ...p.errors].join(' · '),
      badges: [SCOPE_BADGE[p.scope], ...(state ? [state] : []), ...(p.errors.length ? ['ошибка'] : [])],
    });
    if (p.scope === 'user' || p.scope === 'project' || p.scope === 'local') n.actions.push({ label: 'Удалить…', action: { type: 'uninstall', plugin: p } });
    p.components.forEach((c, i) => n.children.push(componentNode(`${n.key}/c${i}`, 3, p.name, c)));
    p.mcp.forEach((name) => n.children.push(node(`${n.key}/m:${name}`, 3, 'component', name, { detail: 'MCP' })));
    groups.of(where).children.push(n);
  }
  for (const s of data.reply.standalone) {
    const where = place(view, ctx, s.scope, s.dir, 'config');
    if (!where) continue;
    groups.of(where).children.push(standaloneNode(s));
  }
  return groups.result();
}

function standaloneNode(s: StandaloneComponent): ExtNode {
  return node(`installed/own/${s.scope}/${s.dir ?? ''}/${s.kind}/${s.name}`, 2, 'component', invocation(null, s), {
    detail: KIND_LABEL[s.kind],
    description: s.description,
    badges: [SCOPE_BADGE[s.scope]],
  });
}

const HEALTH_TEXT: Record<McpHealth, string> = {
  connected: 'подключён',
  'needs-auth': 'нужна авторизация',
  failed: 'не подключился',
  pending: 'ждёт одобрения',
  unknown: 'состояние неизвестно',
};

const APPROVAL_TEXT = { approved: 'одобрен', pending: 'ждёт одобрения', disabled: 'отключён' } as const;

function mcpNode(server: McpServer, health: ProbeEntry | undefined, key: string): ExtNode {
  const badges = [SCOPE_BADGE[server.scope]];
  if (server.approval) badges.push(APPROVAL_TEXT[server.approval]);
  if (health) badges.push(HEALTH_TEXT[health.health]);
  return node(key, 2, 'mcp', server.name, {
    detail: `${server.transport}${server.target ? ` · ${server.target}` : ''}`,
    description: [server.plugin ? `плагин ${server.plugin}` : '', health?.detail ?? ''].filter(Boolean).join(' · '),
    badges,
  });
}

/** Вкладка «MCP»: область → сервер. Связь показана, только если её проверили. */
export function mcpTree(data: ExtData, view: ExtView, ctx: ExtContext): ExtNode[] {
  const groups = new Groups('mcp', ctx, view);
  const plugins = new Map(data.reply.plugins.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const add = (server: McpServer, where: Where) => {
    if (!where) return;
    const health = data.health.get(server.name) ?? data.health.get(`plugin:${server.plugin?.split('@')[0]}:${server.name}`);
    groups.of(where).children.push(mcpNode(server, health, `mcp/${server.scope}/${server.dir ?? ''}/${server.plugin ?? ''}/${server.name}`));
    seen.add(server.name);
  };
  for (const server of data.reply.mcp) {
    if (server.scope === 'plugin') {
      // Сервер плагина стоит там же, где плагин: плагин областей project и local - в своём репозитории.
      const owners = [...plugins.values()].filter((p) => p.id === server.plugin);
      for (const owner of owners) add(server, place(view, ctx, owner.scope, owner.dir, 'mcp'));
    } else {
      add(server, place(view, ctx, server.scope, server.dir, 'mcp'));
    }
  }
  // Коннекторы claude.ai в настройках не записаны, их называет только проверка связи.
  for (const entry of data.health.values()) {
    if (!entry.name.startsWith('claude.ai ') || seen.has(entry.name)) continue;
    groups.of({ group: 'user' }).children.push(mcpNode({ name: entry.name, scope: 'claudeai', transport: 'http', target: '' }, entry, `mcp/claudeai/${entry.name}`));
  }
  return groups.result();
}

/** Адрес для `marketplace add` из подписи источника (`github владелец/репо`, `git https://…`); иное - null. */
export function addableSource(descriptor: string): string | null {
  const m = /^(github|git|url)\s+(\S+)$/.exec(descriptor);
  return m ? m[2] : null;
}

/** Совпадает ли адрес из хаба с подписью подключённого магазина (регистр и `.git` не важны). */
export function sameSource(entrySource: string, marketSource: string): boolean {
  const target = marketSource.replace(/^\S+\s+/, '');
  const norm = (value: string) => value.toLowerCase().replace(/\.git$/, '').replace(/\/$/, '');
  return norm(entrySource) === norm(target);
}

/** Звёзды компактно: 1234 - 1.2k. */
export function compact(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k` : String(value);
}

/** Вкладка «Хабы»: хаб → магазины, которые в нём названы. */
export function hubTree(data: ExtData): ExtNode[] {
  const out: ExtNode[] = [];
  for (const hub of data.hubs) {
    const content = data.hubContent.get(hub.id);
    const top = node(`hubs/${hub.id}`, 1, 'hub', hub.name, {
      detail: hub.builtin ? 'встроенный' : hub.url ? new URL(hub.url).host : '',
      description: hub.description ?? hub.url ?? '',
      badges: hub.enabled ? [] : ['отключён'],
      open: hub.enabled,
    });
    top.actions.push({ label: hub.enabled ? 'Отключить' : 'Подключить', action: { type: 'hub-toggle', hub } });
    if (!hub.builtin) top.actions.push({ label: 'Удалить…', action: { type: 'hub-remove', hub } });
    if (hub.enabled) {
      if (!content) top.children.push(node(`${top.key}/…`, 2, 'note', 'Загрузка…'));
      else if (content.error) top.children.push(node(`${top.key}/!`, 2, 'note', content.error));
      else {
        for (const entry of content.entries) {
          const connected = data.reply.marketplaces.some((m) => m.known && sameSource(entry.source, m.source));
          const n = node(`${top.key}/${entry.source}`, 2, 'entry', entry.name, {
            detail: entry.label,
            description: entry.description,
            badges: [...(entry.stars !== undefined ? [`★ ${compact(entry.stars)}`] : []), ...(entry.plugins !== undefined ? [`плагинов ${entry.plugins}`] : []), ...(connected ? ['подключён'] : [])],
          });
          if (!connected) n.actions.push({ label: 'Подключить…', action: { type: 'market-add', source: entry.source, name: entry.name } });
          top.children.push(n);
        }
        if (content.skipped) top.children.push(node(`${top.key}/skipped`, 2, 'note', `Записей отброшено как негодные: ${content.skipped}`));
        if (!content.entries.length && !content.skipped) top.children.push(node(`${top.key}/empty`, 2, 'note', 'В хабе нет магазинов'));
      }
    }
    out.push(top);
  }
  return out;
}

// ---------- фильтр ----------

/** Узел, у которого совпал запрос в имени или описании, и его предки; ветка с совпавшим потомком раскрывается. */
export function filterTree(nodes: ExtNode[], matcher: (Matcher & { ok: true }) | null): ExtNode[] {
  if (!matcher) return nodes;
  const keep = (n: ExtNode): ExtNode | null => {
    const self = n.kind !== 'group' && n.kind !== 'note' && (matcher.match(n.label) !== null || (n.description ? matcher.match(n.description) !== null : false));
    const children = n.children.map(keep).filter((c): c is ExtNode => c !== null);
    if (self) return { ...n, children: children.length ? children : n.children, open: true };
    if (children.length) return { ...n, children, open: true };
    return null;
  };
  return nodes.map(keep).filter((n): n is ExtNode => n !== null);
}

export interface FlatRow {
  node: ExtNode;
  expanded: boolean | null;
}

/** Строки к показу: раскрытые узлы с детьми (выбор человека сильнее раскрытия по умолчанию); не больше limit, остальное считается. */
export function flatten(nodes: ExtNode[], overrides: ReadonlyMap<string, boolean>, limit: number): { rows: FlatRow[]; hidden: number } {
  const rows: FlatRow[] = [];
  let hidden = 0;
  const walk = (list: ExtNode[]) => {
    for (const n of list) {
      if (rows.length >= limit) {
        hidden++;
        continue;
      }
      const expandable = n.children.length > 0;
      const open = expandable && (overrides.get(n.key) ?? n.open === true);
      rows.push({ node: n, expanded: expandable ? open : null });
      if (open) walk(n.children);
    }
  };
  walk(nodes);
  return { rows, hidden };
}
