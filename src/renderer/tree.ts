import { basename, el, parentRel } from './dom';
import { makeDraggable } from './drop-path';
import { filterPaths, matchAt, type FilterNode } from './tree-filter';
import { restoreIndex, rowKey, tabStopIndex, treeKeyAction, type KeyRow } from './tree-keys';

export interface TreeRoot {
  path: string;
  label: string;
  hint: string;
}

interface RootState {
  expanded: Set<string>;
  collapsed: boolean;
  status: Record<string, string>;
  branch: string | null;
}

interface Entry {
  name: string;
  isDir: boolean;
}

const api = window.cyborg;
// Больше строк DOM не потянет без задержки на каждом нажатии.
const FILTER_LIMIT = 500;

/** Опрос, не ответивший дольше этого, считается зависшим: следующий тик запускается, не дожидаясь его. */
const POLL_STALE_MS = 30_000;

function statusLabel(code: string): string {
  if (code === '?') return 'U';
  if (code === 'U') return '!';
  return code;
}

function changedDirs(state: RootState): Set<string> {
  const dirs = new Set<string>();
  for (const file of Object.keys(state.status)) {
    for (let dir = parentRel(file); dir; dir = parentRel(dir)) dirs.add(dir);
  }
  return dirs;
}

const ITEM = '[role="treeitem"]';

/** Роль и состояние строки для чтения с экрана; ключ нужен, чтобы после перерисовки найти ту же строку. */
function markItem(row: HTMLElement, key: string, level: number, expanded: boolean | null, selected: boolean | null): void {
  row.setAttribute('role', 'treeitem');
  row.setAttribute('aria-level', String(level));
  if (expanded !== null) row.setAttribute('aria-expanded', String(expanded));
  if (selected !== null) row.setAttribute('aria-selected', String(selected));
  row.dataset.key = key;
  // В порядке табуляции остаётся одна строка; replaceTree выбирает её после отрисовки.
  row.tabIndex = -1;
}

const itemOf = (node: EventTarget | Element | null): HTMLElement | null => (node as HTMLElement | null)?.closest?.<HTMLElement>(ITEM) ?? null;

const itemsOf = (container: HTMLElement): HTMLElement[] => [...container.querySelectorAll<HTMLElement>(ITEM)];

function setTabStop(container: HTMLElement, row: HTMLElement): void {
  for (const item of itemsOf(container)) item.tabIndex = item === row ? 0 : -1;
}

/**
 * Дерево как WAI-ARIA tree: стрелки, Home и End переводят фокус, вправо и влево раскрывают и сворачивают, Enter и пробел
 * нажимают строку. Работает на контейнере: строки пересоздаются при каждой перерисовке.
 */
export function bindTree(container: HTMLElement, label: string): void {
  container.setAttribute('role', 'tree');
  container.setAttribute('aria-label', label);
  container.addEventListener('focusin', (event) => {
    const row = itemOf(event.target as Element);
    if (row && container.contains(row)) setTabStop(container, row);
  });
  container.addEventListener('keydown', (event) => {
    // Кнопка ветки внутри строки корня и прочие вложенные элементы управляются сами.
    if (event.altKey || event.ctrlKey || event.metaKey || !(event.target as HTMLElement).matches?.(ITEM)) return;
    const items = itemsOf(container);
    const rows: KeyRow[] = items.map((item) => ({
      level: Number(item.getAttribute('aria-level')),
      expandable: item.hasAttribute('aria-expanded'),
      expanded: item.getAttribute('aria-expanded') === 'true',
    }));
    const action = treeKeyAction(event.key, rows, items.indexOf(event.target as HTMLElement));
    if (!action) return;
    event.preventDefault();
    if (action.kind === 'focus') items[action.index].focus();
    else if (action.kind === 'click') items[action.index].click();
  });
}

/** Подменяет строки дерева готовыми; прокрутка и фокус клавиатуры остаются там, где были (строка с тем же путём, иначе родитель, иначе первая). */
export function replaceTree(container: HTMLElement, fragment: DocumentFragment): void {
  const scroll = container.scrollTop;
  const focused = container.contains(document.activeElement) ? itemOf(document.activeElement) : null;
  const wanted = focused?.dataset.key ?? null;
  container.replaceChildren(fragment);
  container.scrollTop = scroll;
  const items = itemsOf(container);
  const stop = tabStopIndex(items.map((item) => item.getAttribute('aria-selected') === 'true'));
  if (stop >= 0) items[stop].tabIndex = 0;
  if (focused) items[restoreIndex(items.map((item) => item.dataset.key ?? ''), wanted)]?.focus({ preventScroll: true });
}

/** Дерево одной сессии: раскрытые каталоги и выбор не делятся с другими сессиями. */
export class TreeView {
  private roots: TreeRoot[] = [];
  private readonly states = new Map<string, RootState>();
  private statusKey = '';
  private selected: string | null = null;
  private filterText = '';
  // Набор файлов меняется вместе с git status: пока он тот же, ввод фильтра не перечитывает списки.
  private files: { key: string; lists: Promise<string[][]> } | null = null;
  /** Когда начался ещё не законченный опрос; null - опрос не идёт. */
  private pollStartedAt: number | null = null;

  constructor(
    private readonly onOpenFile: (path: string, root: TreeRoot) => void,
    private readonly onChange: () => void,
    /** Нет - веткой управляет сессия, сменить её из дерева нельзя. */
    private readonly onBranch?: (root: TreeRoot, anchor: HTMLElement) => void,
  ) {}

  setRoots(roots: TreeRoot[]): void {
    const seen = new Set<string>();
    this.roots = roots.filter((root) => !seen.has(root.path) && !!seen.add(root.path));
    this.roots.forEach((root, index) => {
      if (!this.states.has(root.path)) {
        this.states.set(root.path, { expanded: new Set(), collapsed: index > 0, status: {}, branch: null });
      }
    });
    this.statusKey = '';
  }

  get filter(): string {
    return this.filterText;
  }

  setFilter(text: string): void {
    if (text === this.filterText) return;
    this.filterText = text;
    this.redraw();
  }

  /**
   * Строит дерево заново; null - git-состояние не менялось и onlyIfChanged просил не перерисовывать.
   * Опрос не накладывается сам на себя: пока предыдущий не закончил (медленный git status у большого репозитория или
   * загруженной машины), очередной тик ничего не запускает. Отрисовки по клику и по событию не пропускаются.
   */
  async render(onlyIfChanged: boolean): Promise<DocumentFragment | null> {
    if (!onlyIfChanged) return this.build(false);
    if (this.pollStartedAt !== null && Date.now() - this.pollStartedAt < POLL_STALE_MS) return null;
    const started = Date.now();
    this.pollStartedAt = started;
    try {
      return await this.build(true);
    } finally {
      if (this.pollStartedAt === started) this.pollStartedAt = null;
    }
  }

  private async build(onlyIfChanged: boolean): Promise<DocumentFragment | null> {
    const roots = this.roots;
    // Статус и ветка независимы: два запроса к git идут одновременно, а не друг за другом.
    const results = await Promise.all(
      roots.map(async (root) => {
        const [status, branch] = await Promise.all([api.gitStatus(root.path), api.gitBranch(root.path)]);
        return { status, branch };
      }),
    );
    const key = JSON.stringify(results);
    if (onlyIfChanged && key === this.statusKey) return null;
    this.statusKey = key;

    const query = this.filterText;
    const filesKey = JSON.stringify([roots.map((root) => root.path), key]);
    if (query && this.files?.key !== filesKey) {
      this.files = { key: filesKey, lists: Promise.all(roots.map((root) => api.listFiles(root.path).catch(() => []))) };
    }
    const files = query ? await this.files!.lists : [];
    const fragment = document.createDocumentFragment();
    let left = FILTER_LIMIT;
    for (const [index, root] of roots.entries()) {
      const state = this.states.get(root.path)!;
      state.status = results[index].status;
      state.branch = results[index].branch;
      fragment.append(this.rootRow(root, state, index === 0));
      if (query) {
        const { nodes, matched } = filterPaths(files[index], query, left);
        const shown = Math.min(matched, left);
        left -= shown;
        this.renderFiltered(root, state, nodes, root.path, 1, changedDirs(state), fragment);
        if (!matched) fragment.append(this.noteRow('нет совпадений'));
        else if (matched > shown) fragment.append(this.noteRow(`ещё ${matched - shown} - уточните запрос`));
      } else if (!state.collapsed) await this.renderDir(root, state, root.path, '', 1, fragment);
    }
    return fragment;
  }

  private rootRow(root: TreeRoot, state: RootState, primary: boolean): HTMLElement {
    const row = el('div', `row root${primary ? ' primary' : ''}`);
    row.title = `${root.path}\n${root.hint}`;
    markItem(row, rowKey(root.path, ''), 1, !state.collapsed || !!this.filterText, null);
    makeDraggable(row, root.path);
    row.append(this.twisty(state.collapsed && !this.filterText ? '▸' : '▾'), el('span', 'name', root.label));
    const changes = Object.keys(state.status).length;
    const meta = el('span', 'meta');
    if (!state.branch) meta.append(el('span', '', 'не git'));
    else if (this.onBranch) {
      const branch = el('button', 'branch', `⎇ ${state.branch}`);
      branch.title = 'Сменить ветку';
      branch.addEventListener('click', (event) => {
        event.stopPropagation();
        this.onBranch!(root, branch);
      });
      meta.append(branch);
    } else {
      const branch = el('span', '', `⎇ ${state.branch}`);
      branch.title = 'Веткой управляет сессия Claude';
      meta.append(branch);
    }
    if (changes) meta.append(el('span', '', `  ±${changes}`));
    row.append(meta);
    row.addEventListener('click', () => {
      if (this.filterText) return;
      state.collapsed = !state.collapsed;
      this.redraw();
    });
    return row;
  }

  private async renderDir(root: TreeRoot, state: RootState, abs: string, rel: string, depth: number, container: DocumentFragment): Promise<void> {
    let entries: Entry[];
    try {
      entries = await api.listDir(abs);
    } catch {
      return;
    }
    // Удалённые файлы на диске уже не видны, но в дереве их надо показать.
    const names = new Set(entries.map((e) => e.name));
    for (const [file, code] of Object.entries(state.status)) {
      if (code === 'D' && parentRel(file) === rel && !names.has(basename(file))) entries.push({ name: basename(file), isDir: false });
    }
    entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    const dirs = changedDirs(state);
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const childAbs = `${abs}/${entry.name}`;
      const expanded = entry.isDir && state.expanded.has(childRel);
      container.append(
        this.entryRow(root, state, entry, childAbs, childRel, depth, dirs, expanded, () => {
          if (expanded) state.expanded.delete(childRel);
          else state.expanded.add(childRel);
          this.redraw();
        }),
      );
      if (expanded) await this.renderDir(root, state, childAbs, childRel, depth + 1, container);
    }
  }

  private renderFiltered(
    root: TreeRoot,
    state: RootState,
    nodes: FilterNode[],
    abs: string,
    depth: number,
    dirs: Set<string>,
    container: DocumentFragment,
  ): void {
    for (const node of nodes) {
      const childAbs = `${abs}/${node.name}`;
      container.append(this.entryRow(root, state, node, childAbs, node.rel, depth, dirs, node.isDir, null));
      this.renderFiltered(root, state, node.children, childAbs, depth + 1, dirs, container);
    }
  }

  /** onDirClick null - каталог раскрыт фильтром, свернуть его нельзя. */
  private entryRow(
    root: TreeRoot,
    state: RootState,
    entry: Entry,
    abs: string,
    rel: string,
    depth: number,
    dirs: Set<string>,
    expanded: boolean,
    onDirClick: (() => void) | null,
  ): HTMLElement {
    const code = state.status[rel];
    const row = el('div', `row ${entry.isDir ? 'dir' : 'file'}`);
    row.style.paddingLeft = `${4 + depth * 12}px`;
    row.title = abs;
    markItem(row, rowKey(root.path, rel), depth + 1, entry.isDir ? expanded : null, entry.isDir ? null : this.selected === abs);
    makeDraggable(row, abs);
    row.append(this.twisty(entry.isDir ? (expanded ? '▾' : '▸') : ''));
    const name = el('span', 'name');
    const at = entry.isDir || !this.filterText ? -1 : matchAt(entry.name, this.filterText);
    if (at < 0) name.textContent = entry.name;
    else {
      const end = at + this.filterText.length;
      name.append(entry.name.slice(0, at), el('mark', '', entry.name.slice(at, end)), entry.name.slice(end));
    }
    row.append(name);
    if (code) {
      name.classList.add(`st-${code}`);
      row.append(el('span', `badge st-${code}`, statusLabel(code)));
    } else if (entry.isDir && dirs.has(rel)) {
      row.classList.add('has-changes');
      row.append(el('span', 'badge st-M', '•'));
    }
    if (this.selected === abs) row.classList.add('selected');

    row.addEventListener('click', () => {
      if (entry.isDir) onDirClick?.();
      else {
        this.selected = abs;
        row.parentElement?.querySelectorAll('.row.selected').forEach((r) => {
          r.classList.remove('selected');
          r.setAttribute('aria-selected', 'false');
        });
        row.classList.add('selected');
        row.setAttribute('aria-selected', 'true');
        this.onOpenFile(abs, root);
      }
    });
    return row;
  }

  private noteRow(text: string): HTMLElement {
    const row = el('div', 'row note', text);
    row.style.paddingLeft = '16px';
    return row;
  }

  /** Треугольник - украшение: состояние читается из aria-expanded. */
  private twisty(sign: string): HTMLElement {
    const twisty = el('span', 'twisty', sign);
    twisty.setAttribute('aria-hidden', 'true');
    return twisty;
  }

  private redraw(): void {
    this.statusKey = '';
    this.onChange();
  }
}
