import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rowKey } from '../src/renderer/tree-keys';

class FakeNode {
  className = '';
  textContent = '';
  title = '';
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  tabIndex = 0;
  attrs: Record<string, string> = {};
  children: FakeNode[] = [];
  parentElement: FakeNode | null = null;
  private listeners: { type: string; fn: () => void }[] = [];
  classList = {
    add: (c: string) => { this.className = `${this.className} ${c}`.trim(); },
    remove: (c: string) => { this.className = this.className.split(' ').filter((x) => x !== c).join(' '); },
  };
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
  append(...nodes: FakeNode[]): void {
    for (const n of nodes) {
      n.parentElement = this;
      this.children.push(n);
    }
  }
  addEventListener(type: string, fn: () => void): void {
    this.listeners.push({ type, fn });
  }
  click(): void {
    for (const l of this.listeners) if (l.type === 'click') l.fn();
  }
  querySelectorAll(): FakeNode[] {
    return [];
  }
}

const fs: Record<string, { name: string; isDir: boolean }[]> = {
  '/r': [{ name: 'a', isDir: true }, { name: 'b', isDir: true }, { name: 'f.txt', isDir: false }],
  '/r/a': [{ name: 'c', isDir: true }, { name: 'x.txt', isDir: false }],
  '/r/a/c': [{ name: 'deep.txt', isDir: false }],
  '/r/b': [{ name: 'c', isDir: true }],
  '/r/b/c': [],
  '/o': [{ name: 'a', isDir: true }],
  '/o/a': [{ name: 'y.txt', isDir: false }],
};

(globalThis as any).document = {
  createElement: () => new FakeNode(),
  createDocumentFragment: () => new FakeNode(),
};
(globalThis as any).window = {
  cyborg: {
    gitStatus: async () => ({}),
    gitBranch: async () => null,
    listDir: async (dir: string) => (fs[dir] ?? []).map((e) => ({ ...e })),
  },
};

const roots = [
  { path: '/r', label: 'r', hint: '' },
  { path: '/o', label: 'o', hint: '' },
];

type View = { render(onlyIfChanged: boolean): Promise<FakeNode | null> };

async function makeView(): Promise<{ view: View; draw: () => Promise<FakeNode> }> {
  const { TreeView } = await import('../src/renderer/tree');
  const view = new TreeView(() => {}, () => {}) as unknown as View & { setRoots(r: typeof roots): void };
  view.setRoots(roots);
  return { view, draw: async () => (await view.render(false))! };
}

// Строка дерева: имя, отступ (глубина) и свёрнут ли каталог - по треугольнику.
const rows = (frag: FakeNode) =>
  frag.children.map((row) => ({
    row,
    name: row.children.find((c) => c.className === 'name')!.textContent,
    pad: row.style.paddingLeft ?? '',
    title: row.title,
    open: row.children[0].textContent === '▾',
  }));
const byTitle = (frag: FakeNode, title: string) => rows(frag).find((r) => r.title === title);
const rootRow = (frag: FakeNode, label: string) => rows(frag).find((r) => r.row.className.includes('root') && r.name === label)!;

describe('TreeView: раскрытие по каждому каталогу независимо', () => {
  it('клик по каталогу раскрывает только его: соседний, одноимённый в другом корне и вложенные остаются свёрнутыми', async () => {
    const { draw } = await makeView();
    rootRow(await draw(), 'o').row.click();
    byTitle(await draw(), '/r/a')!.row.click();
    const frag = await draw();
    assert.equal(byTitle(frag, '/r/a')!.open, true, '/r/a раскрыт');
    assert.equal(byTitle(frag, '/r/b')!.open, false, 'соседний /r/b свёрнут');
    assert.equal(byTitle(frag, '/r/a/c')!.open, false, 'вложенный /r/a/c свёрнут');
    assert.equal(byTitle(frag, '/o/a')!.open, false, 'одноимённый /o/a в другом корне свёрнут');
    assert.equal(byTitle(frag, '/r/a/c/deep.txt'), undefined);
    assert.equal(byTitle(frag, '/r/b/c'), undefined);
  });

  it('повторный клик сворачивает только этот каталог; раскрытый внутри подкаталог при следующем раскрытии раскрыт', async () => {
    const { draw } = await makeView();
    byTitle(await draw(), '/r/a')!.row.click();
    byTitle(await draw(), '/r/b')!.row.click();
    byTitle(await draw(), '/r/a/c')!.row.click();
    byTitle(await draw(), '/r/a')!.row.click();
    let frag = await draw();
    assert.equal(byTitle(frag, '/r/a')!.open, false);
    assert.equal(byTitle(frag, '/r/a/c'), undefined);
    assert.equal(byTitle(frag, '/r/b')!.open, true, '/r/b не свёрнут');
    byTitle(frag, '/r/a')!.row.click();
    frag = await draw();
    assert.equal(byTitle(frag, '/r/a/c')!.open, true);
    assert.ok(byTitle(frag, '/r/a/c/deep.txt'));
  });

  // Дубль пути корня, каким его давал прежний фильтр прочих корней (`r !== s.repo`), когда cwd сессии ушёл в другой репозиторий проекта.
  it('cwd сессии в другом репозитории проекта: клик по каталогу раскрывает одну строку, а не одноимённую в другом корне', async () => {
    const { TreeView } = await import('../src/renderer/tree');
    const view = new TreeView(() => {}, () => {}) as unknown as View & { setRoots(r: typeof roots): void };
    const session = { repo: '/r', root: '/o', repos: ['/r', '/o'] };
    view.setRoots([
      { path: session.root, label: 'r ⎇ o', hint: '' },
      ...session.repos.filter((r) => r !== session.repo).map((r) => ({ path: r, label: 'o', hint: '' })),
    ]);
    const draw = async () => (await view.render(false))!;
    byTitle(await draw(), '/o/a')!.row.click();
    const open = rows(await draw()).filter((r) => r.title === '/o/a' && r.open);
    assert.equal(open.length, 1, `клик по /o/a раскрыл ${open.length} строк каталога`);
  });

  it('корень с повторным путём: клик по корню сворачивает один корень, строк корня одна', async () => {
    const { TreeView } = await import('../src/renderer/tree');
    const view = new TreeView(() => {}, () => {}) as unknown as View & { setRoots(r: typeof roots): void };
    view.setRoots([
      { path: '/o', label: 'own', hint: '' },
      { path: '/o', label: 'dup', hint: '' },
    ]);
    const frag = (await view.render(false))!;
    assert.equal(rows(frag).filter((r) => r.row.className.includes('root')).length, 1);
    rootRow(frag, 'own').row.click();
    const after = (await view.render(false))!;
    assert.equal(rows(after).filter((r) => r.title === '/o/a').length, 0);
  });

  it('раскрытие не делится между сессиями', async () => {
    const one = await makeView();
    const two = await makeView();
    byTitle(await one.draw(), '/r/a')!.row.click();
    assert.equal(byTitle(await two.draw(), '/r/a')!.open, false);
  });
});

describe('TreeView: роли и состояния ARIA', () => {
  const attr = (r: { row: FakeNode } | undefined, name: string) => r!.row.getAttribute(name);

  it('корни, каталоги и файлы - treeitem с глубиной; aria-expanded у корней и каталогов, у файлов его нет', async () => {
    const { draw } = await makeView();
    rootRow(await draw(), 'o').row.click();
    byTitle(await draw(), '/r/a')!.row.click();
    const frag = await draw();
    for (const r of rows(frag)) assert.equal(r.row.getAttribute('role'), 'treeitem', r.title);
    assert.equal(attr(rootRow(frag, 'r'), 'aria-level'), '1');
    assert.equal(attr(rootRow(frag, 'r'), 'aria-expanded'), 'true');
    assert.equal(attr(rootRow(frag, 'o'), 'aria-expanded'), 'true', 'корень o раскрыт кликом');
    assert.equal(attr(byTitle(frag, '/r/a'), 'aria-level'), '2');
    assert.equal(attr(byTitle(frag, '/r/a'), 'aria-expanded'), 'true');
    assert.equal(attr(byTitle(frag, '/r/b'), 'aria-expanded'), 'false');
    assert.equal(attr(byTitle(frag, '/r/a/c'), 'aria-level'), '3');
    assert.equal(attr(byTitle(frag, '/r/a/x.txt'), 'aria-level'), '3');
    assert.equal(attr(byTitle(frag, '/r/a/x.txt'), 'aria-expanded'), null);
  });

  it('свёрнутый корень: aria-expanded=false, потомков нет', async () => {
    const { draw } = await makeView();
    const frag = await draw();
    assert.equal(attr(rootRow(frag, 'o'), 'aria-expanded'), 'false');
    assert.equal(byTitle(frag, '/o/a'), undefined);
  });

  it('aria-selected: true у выбранного файла, false у остальных файлов, у каталогов нет', async () => {
    const { draw } = await makeView();
    byTitle(await draw(), '/r/f.txt')!.row.click();
    const frag = await draw();
    assert.equal(attr(byTitle(frag, '/r/f.txt'), 'aria-selected'), 'true');
    assert.equal(attr(byTitle(frag, '/r/a'), 'aria-selected'), null);
    byTitle(frag, '/r/a')!.row.click();
    byTitle(await draw(), '/r/a/x.txt')!.row.click();
    const after = await draw();
    assert.equal(attr(byTitle(after, '/r/a/x.txt'), 'aria-selected'), 'true');
    assert.equal(attr(byTitle(after, '/r/f.txt'), 'aria-selected'), 'false');
  });

  it('ключи строк уникальны, различают одноимённый путь в разных корнях', async () => {
    const { draw } = await makeView();
    rootRow(await draw(), 'o').row.click();
    byTitle(await draw(), '/r/a')!.row.click();
    byTitle(await draw(), '/o/a')!.row.click();
    const frag = await draw();
    const keys = rows(frag).map((r) => r.row.dataset.key);
    assert.equal(new Set(keys).size, keys.length, 'ключи уникальны');
    assert.equal(byTitle(frag, '/r/a')!.row.dataset.key, rowKey('/r', 'a'));
    assert.equal(byTitle(frag, '/o/a')!.row.dataset.key, rowKey('/o', 'a'));
    assert.equal(rootRow(frag, 'r').row.dataset.key, rowKey('/r', ''));
  });

  it('строки вне порядка табуляции: единственную выбирает replaceTree', async () => {
    const { draw } = await makeView();
    for (const r of rows(await draw())) assert.equal(r.row.tabIndex, -1, r.title);
  });
});
