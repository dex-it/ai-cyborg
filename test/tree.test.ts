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
  append(...nodes: (FakeNode | string)[]): void {
    for (const item of nodes) {
      const n = typeof item === 'string' ? Object.assign(new FakeNode(), { textContent: item }) : item;
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

// Что отдаёт канал fs:files по корням и сколько раз его спросили.
const filePaths: Record<string, string[]> = {
  '/r': ['README.md', 'a/c/deep.txt', 'a/x.txt', 'b/Readme.txt', 'f.txt'],
  '/o': ['a/y.txt', 'notes/readme-old.md'],
};
const listed: string[] = [];

(globalThis as any).document = {
  createElement: () => new FakeNode(),
  createDocumentFragment: () => new FakeNode(),
};
(globalThis as any).window = {
  cyborg: {
    gitStatus: async () => ({}),
    gitBranch: async () => null,
    listDir: async (dir: string) => (fs[dir] ?? []).map((e) => ({ ...e })),
    listFiles: async (root: string) => {
      listed.push(root);
      return filePaths[root] ?? [];
    },
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

describe('TreeView: опрос git', () => {
  const cyborg = (globalThis as any).window.cyborg;
  const saved = { gitStatus: cyborg.gitStatus, gitBranch: cyborg.gitBranch };
  const restore = () => Object.assign(cyborg, saved);

  it('статус и ветка корня запрашиваются одновременно, у всех корней сразу', async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    cyborg.gitStatus = async (root: string) => (started.push(`status ${root}`), await gate, { 'f.txt': 'M' });
    cyborg.gitBranch = async (root: string) => (started.push(`branch ${root}`), await gate, 'main');
    try {
      const { view } = await makeView();
      const drawing = view.render(false);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(started.sort(), ['branch /o', 'branch /r', 'status /o', 'status /r'], 'до ответа первого запроса запущены все');
      release();
      const frag = (await drawing)!;
      const file = frag.children.find((row) => row.title === '/r/f.txt')!;
      assert.equal(file.children.some((c) => c.className.includes('badge st-M')), true, 'статус применён');
    } finally {
      restore();
    }
  });

  it('опрос не накладывается на незаконченный опрос, отрисовка по клику не пропускается', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    cyborg.gitStatus = async () => (calls++, await gate, {});
    try {
      const { view } = await makeView();
      const first = view.render(true);
      const second = await view.render(true);
      assert.equal(second, null, 'второй опрос во время первого ничего не делает');
      assert.equal(calls, 2, 'статус запрошен только первым опросом (по числу корней)');
      const click = view.render(false);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(calls, 4, 'отрисовка не по опросу запущена, не дожидаясь опроса');
      release();
      assert.ok(await first);
      assert.ok(await click);
      cyborg.gitStatus = async () => (calls++, {});
      assert.equal(await view.render(true), null, 'после окончания опрос снова запускается; состояние то же - null');
      assert.equal(calls, 6);
    } finally {
      restore();
    }
  });

  it('зависший опрос старше предела не блокирует следующий', async () => {
    let calls = 0;
    cyborg.gitStatus = async () => {
      calls++;
      return calls <= 2 ? new Promise(() => {}) : {};
    };
    const realNow = Date.now;
    try {
      const { view } = await makeView();
      void view.render(true);
      Date.now = () => realNow() + 31_000;
      assert.ok(await view.render(true), 'опрос запущен, не дожидаясь зависшего');
    } finally {
      Date.now = realNow;
      restore();
    }
  });
});

describe('TreeView: поиск по части имени', () => {
  type Filtered = View & { setRoots(r: typeof roots): void; setFilter(text: string): void; filter: string };
  const makeFiltered = async () => {
    const { TreeView } = await import('../src/renderer/tree');
    const view = new TreeView(() => {}, () => {}) as unknown as Filtered;
    view.setRoots(roots);
    return view;
  };
  const text = (node: FakeNode): string => node.textContent + node.children.map(text).join('');
  // Строки с путём в подсказке; пояснения («нет совпадений», «ещё N») подсказки не имеют.
  const entries = (frag: FakeNode) => frag.children.filter((row) => row.title);
  const entry = (frag: FakeNode, title: string) => entries(frag).find((row) => row.title === title);
  const notes = (frag: FakeNode) => frag.children.filter((row) => !row.title).map(text);
  const files = (frag: FakeNode) => entries(frag).filter((row) => row.className.includes('file')).map((row) => row.title);

  it('остаются файлы с набранным в имени без учёта регистра, во всех корнях и в нераскрытых каталогах', async () => {
    const view = await makeFiltered();
    view.setFilter('readme');
    const frag = (await view.render(false))!;
    assert.deepEqual(files(frag), ['/r/b/Readme.txt', '/r/README.md', '/o/notes/readme-old.md']);
    assert.equal(entry(frag, '/r/a'), undefined, 'каталог без совпадений скрыт');
    assert.equal(entry(frag, '/r/b')!.getAttribute('aria-expanded'), 'true', 'каталог совпадения раскрыт');
    assert.equal(entry(frag, '/o/notes')!.getAttribute('aria-expanded'), 'true', 'и в свёрнутом корне');
  });

  it('ищет в имени, а не в пути: имя каталога не считается', async () => {
    const view = await makeFiltered();
    view.setFilter('notes');
    const frag = (await view.render(false))!;
    assert.deepEqual(files(frag), []);
    assert.equal(entry(frag, '/o/notes'), undefined);
    assert.deepEqual(notes(frag), ['нет совпадений', 'нет совпадений'], 'по строке под каждым корнем');
  });

  it('совпавшая часть имени лежит в mark, остальное рядом с ней', async () => {
    const view = await makeFiltered();
    view.setFilter('ead');
    const frag = (await view.render(false))!;
    const name = entry(frag, '/r/README.md')!.children.find((c) => c.className === 'name')!;
    assert.deepEqual(name.children.map((c) => c.textContent), ['R', 'EAD', 'ME.md']);
  });

  it('роли ARIA в найденном: treeitem с глубиной от корня, у файла aria-selected, у каталога aria-expanded', async () => {
    const view = await makeFiltered();
    view.setFilter('deep');
    const frag = (await view.render(false))!;
    const deep = entry(frag, '/r/a/c/deep.txt')!;
    assert.equal(deep.getAttribute('role'), 'treeitem');
    assert.equal(deep.getAttribute('aria-level'), '4');
    assert.equal(deep.getAttribute('aria-selected'), 'false');
    assert.equal(entry(frag, '/r/a')!.getAttribute('aria-expanded'), 'true');
    assert.equal(entry(frag, '/r/a/c')!.getAttribute('aria-level'), '3');
  });

  it('больше предела: показаны первые 500, ниже строка «ещё N - уточните запрос»', async () => {
    const view = await makeFiltered();
    const saved = filePaths['/r'];
    filePaths['/r'] = Array.from({ length: 520 }, (_, i) => `many/file${String(i).padStart(3, '0')}.txt`);
    try {
      view.setFilter('file');
      const frag = (await view.render(false))!;
      assert.equal(files(frag).filter((title) => title.startsWith('/r/many/')).length, 500);
      assert.ok(notes(frag).includes('ещё 20 - уточните запрос'));
    } finally {
      filePaths['/r'] = saved;
    }
  });

  it('список файлов перечитывается только при смене git status, а не на каждое нажатие', async () => {
    const view = await makeFiltered();
    listed.length = 0;
    for (const query of ['r', 're', 'rea']) {
      view.setFilter(query);
      await view.render(false);
    }
    assert.deepEqual(listed, ['/r', '/o'], 'по одному запросу на корень');
    const api = (globalThis as any).window.cyborg;
    const status = api.gitStatus;
    api.gitStatus = async () => ({ 'f.txt': 'M' });
    try {
      await view.render(false);
    } finally {
      api.gitStatus = status;
    }
    assert.deepEqual(listed, ['/r', '/o', '/r', '/o'], 'после смены статуса список перечитан');
  });

  it('клик по корню при фильтре его не сворачивает; пустой фильтр возвращает обычное дерево', async () => {
    const view = await makeFiltered();
    view.setFilter('readme');
    const frag = (await view.render(false))!;
    entries(frag).find((row) => row.className.includes('root'))!.click();
    assert.ok(entry((await view.render(false))!, '/r/README.md'), 'корень не свернулся');
    view.setFilter('');
    const plain = (await view.render(false))!;
    assert.ok(entry(plain, '/r/f.txt'));
    assert.equal(entry(plain, '/r/b/Readme.txt'), undefined, 'вернулись раскрытия по умолчанию');
    assert.equal(view.filter, '');
  });
});
