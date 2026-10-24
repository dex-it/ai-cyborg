import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

class FakeNode {
  className = '';
  textContent = '';
  title = '';
  style: Record<string, string> = {};
  children: FakeNode[] = [];
  parentElement: FakeNode | null = null;
  private listeners: (() => void)[] = [];
  classList = {
    add: (c: string) => { this.className = `${this.className} ${c}`.trim(); },
    remove: (c: string) => { this.className = this.className.split(' ').filter((x) => x !== c).join(' '); },
  };
  append(...nodes: FakeNode[]): void {
    for (const n of nodes) {
      n.parentElement = this;
      this.children.push(n);
    }
  }
  addEventListener(_type: string, fn: () => void): void {
    this.listeners.push(fn);
  }
  click(): void {
    for (const fn of this.listeners) fn();
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

  // Корни, как их строит treeRoots (src/renderer/app.ts:185-194), когда cwd сессии ушёл в другой репозиторий проекта.
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
