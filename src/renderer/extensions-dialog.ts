import type { ExtensionsTab } from '../main/menu';
import type { ActionScope, ExtensionsAction, ExtensionsReply, Hub, HubContent, ProbeEntry } from '../shared/extensions';
import { marketplaceSourceProblem } from '../shared/extensions';
import { queryProblem } from '../shared/search-pattern';
import { basename, byId, el } from './dom';
import {
  filterTree,
  flatten,
  hubTree,
  installedTree,
  marketplaceTree,
  mcpTree,
  requestedDirs,
  slice,
  viewNote,
  type ExtContext,
  type ExtData,
  type ExtNode,
  type ExtView,
  type NodeAction,
} from './extensions-model';
import { readChoice, readPref, writePref } from './prefs';
import { compileMatcher, type Matcher } from './search-model';
import { bindTablist, markTab, selectTab } from './tabs';
import { bindTree, markItem, replaceTree } from './tree';

export type { ExtensionsTab };

/** Окно «Расширения»: магазины, плагины, скиллы, серверы MCP и хабы в границах воркспейса, проекта и сессии (фича 14). */
export interface ExtensionsHost {
  context(): ExtContext;
}

const api = window.cyborg;

const TABS: { id: ExtensionsTab; label: string; list: string }[] = [
  { id: 'marketplaces', label: 'Магазины', list: 'Магазины плагинов и их плагины' },
  { id: 'installed', label: 'Установленные', list: 'Установленные плагины, скиллы, команды и агенты' },
  { id: 'mcp', label: 'MCP', list: 'Серверы MCP' },
  { id: 'hubs', label: 'Хабы', list: 'Хабы магазинов' },
];
const VIEWS: ExtView[] = ['session', 'project', 'everywhere'];
/** Больше строк DOM не потянет без задержки; остальное находят фильтром. */
const ROW_LIMIT = 1500;

const flag = (key: string): boolean => readPref(`cyborg.extensions.${key}`) === '1';

const last = {
  tab: readChoice<ExtensionsTab>('cyborg.extensions.tab', TABS.map((t) => t.id), 'marketplaces'),
  view: readChoice<ExtView>('cyborg.extensions.view', VIEWS, 'session'),
  regex: flag('regex'),
  caseSensitive: flag('caseSensitive'),
  query: '',
};

/** Что за форма открыта в панели действия. */
type Panel =
  | { kind: 'node'; action: NodeAction }
  | { kind: 'market-manual' }
  | { kind: 'hub-add' };

const EMPTY: ExtensionsReply = { claude: {}, marketplaces: [], plugins: [], standalone: [], mcp: [], problems: [] };

export class ExtensionsDialog {
  private readonly dialog = byId<HTMLDialogElement>('ext-dialog');
  private readonly tabs = new Map<ExtensionsTab, HTMLElement>();
  private readonly viewButtons = [...document.querySelectorAll<HTMLButtonElement>('.ext-view')];
  private readonly filter = byId<HTMLInputElement>('ext-filter');
  private readonly note = byId('ext-note');
  private readonly status = byId('ext-status');
  private readonly tree = byId('ext-tree');
  private readonly form = byId<HTMLFormElement>('ext-action');
  private readonly field = (id: string) => byId<HTMLElement>(`ext-action-${id}-field`);
  private ctx: ExtContext = { repos: [], session: null };
  private reply: ExtensionsReply = EMPTY;
  private loaded = false;
  private hubs: Hub[] = [];
  private readonly hubContent = new Map<string, HubContent>();
  private readonly health = new Map<string, ProbeEntry>();
  private readonly overrides = new Map<string, boolean>();
  private panel: Panel | null = null;
  private running = false;
  private message = '';
  /** Номер чтения: ответ прежнего чтения (окно закрыто, область сменилась) не рисуется. */
  private ticket = 0;

  constructor(private readonly host: ExtensionsHost) {
    const tabs = byId('ext-tabs');
    for (const tab of TABS) {
      const button = markTab(el('button', 'search-mode', tab.label));
      button.setAttribute('type', 'button');
      button.addEventListener('click', () => this.setTab(tab.id));
      this.tabs.set(tab.id, button);
      tabs.append(button);
    }
    bindTablist(tabs, 'Раздел');
    bindTree(this.tree, 'Расширения');

    for (const button of this.viewButtons) button.addEventListener('click', () => this.setView(button.dataset.view as ExtView));
    this.filter.addEventListener('input', () => {
      last.query = this.filter.value;
      this.overrides.clear();
      this.render();
    });
    for (const [id, key] of [['ext-case', 'caseSensitive'], ['ext-regex', 'regex']] as const) {
      byId(id).addEventListener('click', () => {
        last[key] = !last[key];
        writePref(`cyborg.extensions.${key}`, last[key] ? '1' : '0');
        this.overrides.clear();
        this.render();
      });
    }
    byId('ext-refresh').addEventListener('click', () => void this.reload(true));
    byId('ext-probe').addEventListener('click', () => void this.probe());
    byId('ext-add-market').addEventListener('click', () => this.openPanel({ kind: 'market-manual' }));
    byId('ext-add-hub').addEventListener('click', () => this.openPanel({ kind: 'hub-add' }));
    byId('ext-close').addEventListener('click', () => this.dialog.close());
    byId('ext-action-cancel').addEventListener('click', () => this.closePanel());
    byId<HTMLSelectElement>('ext-action-scope').addEventListener('change', () => this.syncPanelFields());
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.runPanel();
    });
    // Esc сначала закрывает форму действия, и только потом окно.
    this.dialog.addEventListener('cancel', (event) => {
      if (this.panel && !this.form.hidden) {
        event.preventDefault();
        this.closePanel();
      }
    });
    this.dialog.addEventListener('click', (event) => {
      if (event.target === this.dialog) this.dialog.close();
    });
    this.dialog.addEventListener('close', () => {
      if (this.dialog.open) return;
      this.ticket++;
      this.closePanel();
    });
  }

  open(tab: ExtensionsTab = last.tab): void {
    this.ctx = this.host.context();
    last.tab = tab;
    if (!this.dialog.open) this.dialog.showModal();
    this.filter.value = last.query;
    this.overrides.clear();
    this.render();
    this.filter.focus();
    this.filter.select();
    void this.reload(false);
  }

  private setTab(tab: ExtensionsTab): void {
    last.tab = tab;
    writePref('cyborg.extensions.tab', tab);
    this.closePanel();
    this.overrides.clear();
    this.render();
    if (tab === 'hubs') void this.loadHubs(false);
  }

  /** Область, которая действует: выбранная человеком, а «Сессия» без сессии - «Проект» (выбор при этом не затирается). */
  private view(): ExtView {
    return last.view === 'session' && !this.ctx.session ? 'project' : last.view;
  }

  private setView(view: ExtView): void {
    if (view === 'session' && !this.ctx.session) return;
    last.view = view;
    writePref('cyborg.extensions.view', view);
    this.overrides.clear();
    this.render();
  }

  private async reload(force: boolean): Promise<void> {
    const ticket = ++this.ticket;
    if (force) this.hubContent.clear();
    this.loaded = false;
    this.status.textContent = 'Читаю магазины, плагины и серверы…';
    try {
      const [reply, hubs] = await Promise.all([api.loadExtensions({ dirs: requestedDirs(this.ctx) }), api.listHubs()]);
      if (ticket !== this.ticket) return;
      this.reply = reply;
      this.hubs = hubs;
    } catch (error) {
      if (ticket !== this.ticket) return;
      this.reply = { ...EMPTY, claude: { problem: String(error instanceof Error ? error.message : error) } };
    }
    this.loaded = true;
    this.render();
    if (last.tab === 'hubs') void this.loadHubs(force);
  }

  private async loadHubs(force: boolean): Promise<void> {
    const ticket = this.ticket;
    const pending = this.hubs.filter((hub) => hub.enabled && (force || !this.hubContent.has(hub.id)));
    await Promise.all(
      pending.map(async (hub) => {
        const content = await api.fetchHub(hub.id, force).catch((error: unknown): HubContent => ({ entries: [], error: String(error) }));
        if (ticket !== this.ticket) return;
        this.hubContent.set(hub.id, content);
        this.render();
      }),
    );
  }

  private data(): ExtData {
    return { reply: this.reply, hubs: this.hubs, hubContent: this.hubContent, health: this.health };
  }

  private build(): ExtNode[] {
    const data = this.data();
    switch (last.tab) {
      case 'marketplaces':
        return marketplaceTree(data, this.view(), this.ctx);
      case 'installed':
        return installedTree(data, this.view(), this.ctx);
      case 'mcp':
        return mcpTree(data, this.view(), this.ctx);
      case 'hubs':
        return hubTree(data);
    }
  }

  private render(): void {
    for (const [id, tab] of this.tabs) selectTab(tab, id === last.tab);
    const info = TABS.find((t) => t.id === last.tab)!;
    this.tree.setAttribute('aria-label', info.list);
    const hubs = last.tab === 'hubs';
    byId('ext-views').hidden = hubs;
    for (const button of this.viewButtons) {
      const on = button.dataset.view === this.view();
      button.setAttribute('aria-pressed', String(on));
      button.disabled = button.dataset.view === 'session' && !this.ctx.session;
    }
    byId('ext-case').setAttribute('aria-pressed', String(last.caseSensitive));
    byId('ext-regex').setAttribute('aria-pressed', String(last.regex));
    byId('ext-probe').hidden = last.tab !== 'mcp';
    byId('ext-add-market').hidden = last.tab !== 'marketplaces' && !hubs;
    byId('ext-add-hub').hidden = !hubs;
    this.note.textContent = hubs ? 'Хаб - список магазинов, в котором ищут магазин и откуда его подключают. Хабы общие для всех воркспейсов; в списках GitHub магазины не проверялись Anthropic.' : viewNote(this.view(), this.ctx);

    this.filter.removeAttribute('aria-invalid');
    let matcher: (Matcher & { ok: true }) | null = null;
    let problem: string | null = null;
    const query = this.filter.value.trim();
    if (query) {
      const options = { regex: last.regex, caseSensitive: last.caseSensitive, wholeWord: false };
      problem = queryProblem(query, options);
      const compiled = problem ? null : compileMatcher(query, options);
      if (compiled && !compiled.ok) problem = compiled.error;
      else if (compiled) matcher = compiled;
    }
    if (problem) this.filter.setAttribute('aria-invalid', 'true');

    const nodes = this.loaded || hubs ? filterTree(this.build(), matcher) : [];
    const { rows, hidden } = flatten(nodes, this.overrides, ROW_LIMIT);
    const fragment = document.createDocumentFragment();
    for (const row of rows) fragment.append(this.rowOf(row.node, row.expanded));
    replaceTree(this.tree, fragment);

    const lines: string[] = [];
    if (problem) lines.push(problem);
    else if (!this.loaded && !hubs) lines.push('Читаю магазины, плагины и серверы…');
    else if (!rows.length) lines.push(query ? 'Нет совпадений' : 'Пусто');
    if (hidden) lines.push(`Показаны первые ${ROW_LIMIT}, уточните запрос`);
    if (this.message) lines.push(this.message);
    if (this.loaded && !hubs) {
      if (this.reply.claude.problem) lines.push(this.reply.claude.problem);
      lines.push(...this.reply.problems.slice(0, 2));
      if (this.reply.claude.version && !lines.length) lines.push(`Claude Code ${this.reply.claude.version}`);
    }
    this.status.textContent = lines.join('. ');
  }

  private rowOf(n: ExtNode, expanded: boolean | null): HTMLElement {
    const row = el('div', `row ext-row level-${n.level} ${n.kind}`);
    markItem(row, n.key, n.level, expanded, null);
    if (n.description) row.title = n.description;
    const twisty = el('span', 'twisty', expanded === null ? '' : expanded ? '▾' : '▸');
    twisty.setAttribute('aria-hidden', 'true');
    row.append(twisty, el('span', 'ext-label', n.label), el('span', 'ext-desc', n.description ?? ''));
    const meta = el('span', 'ext-meta');
    for (const badge of n.badges) meta.append(el('span', 'ext-badge', badge));
    if (n.detail) meta.append(el('span', '', n.detail));
    for (const { label, action } of n.actions) {
      const button = el('button', '', label);
      button.setAttribute('type', 'button');
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        void this.act(action);
      });
      meta.append(button);
    }
    row.append(meta);
    if (expanded !== null) {
      row.addEventListener('click', () => {
        this.overrides.set(n.key, !expanded);
        this.render();
      });
    }
    return row;
  }

  // ---------- проверка связи ----------

  private async probe(): Promise<void> {
    const ticket = this.ticket;
    const view = this.view();
    const dirs: (string | null)[] =
      view === 'everywhere' ? [null] : view === 'session' && this.ctx.session ? [this.ctx.session.root] : this.ctx.repos.length ? this.ctx.repos : [null];
    this.message = 'Проверяю связь: серверы запускаются…';
    this.render();
    const errors: string[] = [];
    for (const dir of dirs) {
      const reply = await api.probeMcp(dir).catch((error: unknown) => ({ entries: [] as ProbeEntry[], error: String(error) }));
      if (ticket !== this.ticket) return;
      for (const entry of reply.entries) this.health.set(entry.name, entry);
      if (reply.error) errors.push(reply.error);
    }
    this.message = errors.length ? `Проверка: ${errors[0]}` : `Связь проверена: ${this.health.size}`;
    this.render();
  }

  // ---------- действия ----------

  private async act(action: NodeAction): Promise<void> {
    if (action.type === 'hub-toggle') {
      const result = await api.changeHubs({ op: action.hub.enabled ? 'disable' : 'enable', id: action.hub.id });
      this.afterHubChange(result);
      return;
    }
    this.openPanel({ kind: 'node', action });
  }

  private afterHubChange(result: { hubs?: Hub[]; error?: string }): void {
    if (result.error) {
      this.message = result.error;
    } else if (result.hubs) {
      this.message = '';
      this.hubs = result.hubs;
    }
    this.render();
    if (last.tab === 'hubs') void this.loadHubs(false);
  }

  private text(id: string, value: string): void {
    byId(`ext-action-${id}`).textContent = value;
  }

  private openPanel(panel: Panel): void {
    this.panel = panel;
    this.running = false;
    const result = byId('ext-action-result');
    result.textContent = '';
    result.className = '';
    byId<HTMLButtonElement>('ext-action-run').disabled = false;
    byId('ext-action-cancel').textContent = 'Отмена';
    const name = byId<HTMLInputElement>('ext-action-name');
    const source = byId<HTMLInputElement>('ext-action-source');
    name.value = '';
    source.value = '';
    let fields = { name: false, source: false, scope: false };
    if (panel.kind === 'hub-add') {
      this.text('title', 'Добавить хаб');
      this.text('text', 'Хаб - JSON-файл по https-адресу со списком магазинов: {"name": "…", "marketplaces": [{"name", "description", "source": {"source": "github", "repo": "владелец/репозиторий"}}]}. Файл только читается, магазины подключаются отдельно и по вашей команде.');
      this.text('source-label', 'Адрес файла хаба (https)');
      byId('ext-action-run').textContent = 'Добавить';
      fields = { name: true, source: true, scope: false };
    } else if (panel.kind === 'market-manual') {
      this.text('title', 'Подключить магазин');
      this.text('text', 'Магазин - каталог плагинов. Подключение скачивает каталог и ничего не устанавливает. Подключайте магазины, которым доверяете: плагины из них запускают программы с вашими правами.');
      this.text('source-label', 'Адрес: владелец/репозиторий, https-адрес, git@хост:путь или путь на этом компьютере');
      byId('ext-action-run').textContent = 'Подключить';
      fields = { name: false, source: true, scope: true };
    } else {
      const a = panel.action;
      byId('ext-action-run').textContent = 'Выполнить';
      if (a.type === 'install') {
        this.text('title', `Установить ${a.plugin}`);
        this.text('text', 'Claude Code скачает плагин из магазина. Плагин может запускать программы и серверы MCP с вашими правами: ставьте плагины, которым доверяете. Запущенные сессии подхватят его после /reload-plugins, новые - сразу.');
        fields = { name: false, source: false, scope: true };
      } else if (a.type === 'uninstall') {
        this.text('title', `Удалить ${a.plugin.id}`);
        this.text('text', `Область: ${a.plugin.scope}${a.plugin.dir ? `, ${basename(a.plugin.dir)}` : ''}. Claude Code удалит плагин из этой области вместе с его данными.`);
      } else if (a.type === 'market-remove') {
        this.text('title', `Отключить магазин ${a.market.name}`);
        this.text('text', `Claude Code отключит магазин и удалит установленные из него плагины${a.installed.length ? `: ${a.installed.join(', ')}` : ' (установленных нет)'}. Вместе с плагинами удаляются их настройки и данные.`);
      } else if (a.type === 'market-add') {
        this.text('title', `Подключить магазин ${a.name}`);
        this.text('text', 'Магазин - каталог плагинов. Подключение скачивает каталог и ничего не устанавливает. Подключайте магазины, которым доверяете.');
        source.value = a.source;
        this.text('source-label', 'Адрес');
        fields = { name: false, source: true, scope: true };
      } else if (a.type === 'hub-remove') {
        this.text('title', `Удалить хаб ${a.hub.name}`);
        this.text('text', 'Хаб пропадёт из списка. Подключённые из него магазины останутся.');
      }
    }
    this.field('name').hidden = !fields.name;
    this.field('source').hidden = !fields.source;
    this.field('scope').hidden = !fields.scope;
    this.fillRepos();
    const scope = byId<HTMLSelectElement>('ext-action-scope');
    scope.value = this.view() === 'everywhere' || !this.ctx.repos.length ? 'user' : 'local';
    this.syncPanelFields();
    this.form.hidden = false;
    (fields.name ? name : fields.source ? source : byId('ext-action-run')).focus();
  }

  private fillRepos(): void {
    const select = byId<HTMLSelectElement>('ext-action-dir');
    const dirs = [...new Set([...(this.ctx.session ? slice('session', this.ctx).own : []), ...this.ctx.repos])];
    select.replaceChildren(
      ...dirs.map((dir) => {
        const option = el('option', '', basename(dir)) as HTMLOptionElement;
        option.value = dir;
        option.title = dir;
        return option;
      }),
    );
  }

  /** Репозиторий нужен только для областей «Проект» и «Локально». */
  private syncPanelFields(): void {
    const scopeShown = !this.field('scope').hidden;
    this.field('dir').hidden = !scopeShown || byId<HTMLSelectElement>('ext-action-scope').value === 'user';
    const noRepos = !byId<HTMLSelectElement>('ext-action-dir').options.length;
    for (const option of byId<HTMLSelectElement>('ext-action-scope').options) option.disabled = option.value !== 'user' && noRepos;
  }

  private closePanel(): void {
    this.panel = null;
    this.form.hidden = true;
  }

  private chosen(): { scope: ActionScope; dir?: string } {
    const scope = byId<HTMLSelectElement>('ext-action-scope').value as ActionScope;
    return scope === 'user' ? { scope } : { scope, dir: byId<HTMLSelectElement>('ext-action-dir').value };
  }

  private async runPanel(): Promise<void> {
    const panel = this.panel;
    if (!panel || this.running) return;
    const result = byId('ext-action-result');
    const fail = (message: string) => {
      result.textContent = message;
      result.className = 'failed';
    };
    this.running = true;
    byId<HTMLButtonElement>('ext-action-run').disabled = true;
    result.className = '';
    result.textContent = 'Выполняется…';
    try {
      if (panel.kind === 'hub-add') {
        const outcome = await api.changeHubs({ op: 'add', name: byId<HTMLInputElement>('ext-action-name').value, url: byId<HTMLInputElement>('ext-action-source').value });
        if (outcome.error) return this.again(fail, outcome.error);
        this.afterHubChange(outcome);
        return this.done('Хаб добавлен');
      }
      let action: ExtensionsAction;
      if (panel.kind === 'market-manual' || (panel.kind === 'node' && panel.action.type === 'market-add')) {
        const source = byId<HTMLInputElement>('ext-action-source').value.trim();
        const problem = marketplaceSourceProblem(source);
        if (problem) return this.again(fail, problem);
        action = { kind: 'marketplace-add', source, ...this.chosen() };
      } else if (panel.kind === 'node') {
        const a = panel.action;
        if (a.type === 'install') action = { kind: 'install', plugin: a.plugin, ...this.chosen() };
        else if (a.type === 'uninstall') action = { kind: 'uninstall', plugin: a.plugin.id, scope: a.plugin.scope as ActionScope, ...(a.plugin.dir ? { dir: a.plugin.dir } : {}) };
        else if (a.type === 'market-remove') action = { kind: 'marketplace-remove', name: a.market.name };
        else if (a.type === 'hub-remove') {
          const outcome = await api.changeHubs({ op: 'remove', id: a.hub.id });
          if (outcome.error) return this.again(fail, outcome.error);
          this.afterHubChange(outcome);
          return this.done('Хаб удалён');
        } else return this.again(fail, 'Действие не поддержано');
      } else return;
      const reply = await api.extensionsAct(action).catch((error: unknown) => ({ ok: false, message: String(error instanceof Error ? error.message : error) }));
      if (!reply.ok) return this.again(fail, reply.message);
      this.done(reply.message);
      this.hubContent.clear();
      void this.reload(false);
    } finally {
      this.running = false;
    }
  }

  private again(fail: (message: string) => void, message: string): void {
    fail(message);
    byId<HTMLButtonElement>('ext-action-run').disabled = false;
  }

  private done(message: string): void {
    const result = byId('ext-action-result');
    result.className = '';
    result.textContent = message;
    byId('ext-action-cancel').textContent = 'Закрыть';
  }
}
