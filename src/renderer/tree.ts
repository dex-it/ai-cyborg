import { basename, el, parentRel } from './dom';
import { makeDraggable } from './drop-path';

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

function statusLabel(code: string): string {
  if (code === '?') return 'U';
  if (code === 'U') return '!';
  return code;
}

/** Дерево одной сессии: раскрытые каталоги и выбор не делятся с другими сессиями. */
export class TreeView {
  private roots: TreeRoot[] = [];
  private readonly states = new Map<string, RootState>();
  private statusKey = '';
  private selected: string | null = null;

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

  /** Строит дерево заново; null - git-состояние не менялось и onlyIfChanged просил не перерисовывать. */
  async render(onlyIfChanged: boolean): Promise<DocumentFragment | null> {
    const roots = this.roots;
    const results = await Promise.all(
      roots.map(async (root) => ({ status: await api.gitStatus(root.path), branch: await api.gitBranch(root.path) })),
    );
    const key = JSON.stringify(results);
    if (onlyIfChanged && key === this.statusKey) return null;
    this.statusKey = key;

    const fragment = document.createDocumentFragment();
    for (const [index, root] of roots.entries()) {
      const state = this.states.get(root.path)!;
      state.status = results[index].status;
      state.branch = results[index].branch;
      fragment.append(this.rootRow(root, state, index === 0));
      if (!state.collapsed) await this.renderDir(root, state, root.path, '', 1, fragment);
    }
    return fragment;
  }

  private rootRow(root: TreeRoot, state: RootState, primary: boolean): HTMLElement {
    const row = el('div', `row root${primary ? ' primary' : ''}`);
    row.title = `${root.path}\n${root.hint}`;
    makeDraggable(row, root.path);
    row.append(el('span', 'twisty', state.collapsed ? '▸' : '▾'), el('span', 'name', root.label));
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
    const changedDirs = new Set<string>();
    for (const file of Object.keys(state.status)) {
      for (let dir = parentRel(file); dir; dir = parentRel(dir)) changedDirs.add(dir);
    }

    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const childAbs = `${abs}/${entry.name}`;
      const expanded = entry.isDir && state.expanded.has(childRel);
      const code = state.status[childRel];

      const row = el('div', `row ${entry.isDir ? 'dir' : 'file'}`);
      row.style.paddingLeft = `${4 + depth * 12}px`;
      row.title = childAbs;
      makeDraggable(row, childAbs);
      row.append(el('span', 'twisty', entry.isDir ? (expanded ? '▾' : '▸') : ''));
      const name = el('span', 'name', entry.name);
      row.append(name);
      if (code) {
        name.classList.add(`st-${code}`);
        row.append(el('span', `badge st-${code}`, statusLabel(code)));
      } else if (entry.isDir && changedDirs.has(childRel)) {
        row.classList.add('has-changes');
        row.append(el('span', 'badge st-M', '•'));
      }
      if (this.selected === childAbs) row.classList.add('selected');

      row.addEventListener('click', () => {
        if (entry.isDir) {
          if (expanded) state.expanded.delete(childRel);
          else state.expanded.add(childRel);
          this.redraw();
        } else {
          this.selected = childAbs;
          row.parentElement?.querySelectorAll('.row.selected').forEach((r) => r.classList.remove('selected'));
          row.classList.add('selected');
          this.onOpenFile(childAbs, root);
        }
      });
      container.append(row);
      if (expanded) await this.renderDir(root, state, childAbs, childRel, depth + 1, container);
    }
  }

  private redraw(): void {
    this.statusKey = '';
    this.onChange();
  }
}
