import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ExtensionsReply, Hub, HubContent, InstalledPlugin, McpServer, ProbeEntry } from '../src/shared/extensions';
import {
  addableSource,
  compact,
  defaultView,
  filterTree,
  flatten,
  hubTree,
  installedTree,
  invocation,
  marketplaceTree,
  mcpTree,
  place,
  requestedDirs,
  sameSource,
  slice,
  viewNote,
  type ExtContext,
  type ExtData,
  type ExtNode,
} from '../src/renderer/extensions-model';
import { compileMatcher } from '../src/renderer/search-model';

const A = '/w/repoA';
const B = '/w/repoB';
const C = '/w/repoC';
const ctx: ExtContext = { repos: [A, B, C], session: { root: A, repo: A } };

const plugin = (over: Partial<InstalledPlugin>): InstalledPlugin => ({
  id: 'p@mk',
  name: 'p',
  marketplace: 'mk',
  version: '1.0.0',
  scope: 'user',
  enabledGlobal: true,
  enabledIn: {},
  components: [{ kind: 'skill', name: 'hello', description: 'Привет' }],
  mcp: [],
  errors: [],
  ...over,
});

const reply = (over: Partial<ExtensionsReply> = {}): ExtensionsReply => ({
  claude: {},
  marketplaces: [
    {
      name: 'mk',
      source: 'github o/r',
      known: true,
      declaredBy: [],
      plugins: [
        { name: 'p', description: 'Плагин', version: '1.0.0', remote: false, components: [{ kind: 'skill', name: 'hello', description: 'Привет' }] },
        { name: 'far', description: 'Далёкий', remote: true, components: null },
      ],
    },
    { name: 'team', source: 'github team/x', known: false, declaredBy: [B], plugins: [] },
  ],
  plugins: [
    plugin({}),
    plugin({ id: 'q@mk', name: 'q', scope: 'project', dir: A, enabledIn: { [A]: true }, components: [] }),
    plugin({ id: 'r@mk', name: 'r', scope: 'local', dir: B, enabledIn: { [B]: false }, components: [] }),
    plugin({ id: 'c@mk', name: 'c', scope: 'project', dir: C, components: [] }),
  ],
  standalone: [
    { kind: 'skill', name: 'mine', description: 'Личный', scope: 'user' },
    { kind: 'skill', name: 'proj', description: 'Проектный', scope: 'project', dir: A },
    { kind: 'agent', name: 'add', description: 'Из другого репо', scope: 'project', dir: B },
  ],
  mcp: [
    { name: 'g', scope: 'user', transport: 'http', target: 'https://g.io' },
    { name: 'shared', scope: 'project', dir: A, transport: 'stdio', target: 'srv', approval: 'pending' },
    { name: 'other', scope: 'project', dir: B, transport: 'stdio', target: 'o', approval: 'approved' },
    { name: 'psrv', scope: 'plugin', plugin: 'q@mk', transport: 'stdio', target: 'x' },
  ] as McpServer[],
  problems: [],
  ...over,
});

const data = (r = reply(), over: Partial<ExtData> = {}): ExtData => ({ reply: r, hubs: [], hubContent: new Map(), health: new Map(), ...over });

const labels = (nodes: ExtNode[]): string[] => nodes.map((n) => n.label);
const walk = (nodes: ExtNode[]): ExtNode[] => nodes.flatMap((n) => [n, ...walk(n.children)]);

describe('области', () => {
  it('«Сессия» видит репозиторий сессии, доп. каталоги отдельно; «Везде» - ни одного репозитория', () => {
    assert.deepEqual(slice('session', ctx), { own: [A], added: [B, C] });
    assert.deepEqual(slice('project', ctx), { own: [A, B, C], added: [] });
    assert.deepEqual(slice('everywhere', ctx), { own: [], added: [] });
  });

  it('сессия в worktree: видны и worktree, и репозиторий запуска', () => {
    const wt: ExtContext = { repos: [A], session: { root: '/w/repoA/.claude/worktrees/x', repo: A } };
    assert.deepEqual(slice('session', wt).own, ['/w/repoA/.claude/worktrees/x', A]);
  });

  it('без сессии область «Сессия» совпадает с «Проектом», а по умолчанию - «Проект»', () => {
    const none: ExtContext = { repos: [A], session: null };
    assert.deepEqual(slice('session', none).own, [A]);
    assert.equal(defaultView(none), 'project');
    assert.equal(defaultView(ctx), 'session');
  });

  it('place: пользовательское видно везде, репозиторное - по области; MCP доп. каталогов не берётся', () => {
    assert.deepEqual(place('everywhere', ctx, 'user', undefined, 'config'), { group: 'user' });
    assert.equal(place('everywhere', ctx, 'project', A, 'config'), null);
    assert.deepEqual(place('session', ctx, 'local', A, 'config'), { group: 'dir', dir: A, added: false });
    assert.deepEqual(place('session', ctx, 'project', B, 'config'), { group: 'dir', dir: B, added: true });
    assert.equal(place('session', ctx, 'project', B, 'mcp'), null);
    assert.equal(place('project', ctx, 'project', '/w/чужой', 'config'), null);
    assert.deepEqual(place('everywhere', ctx, 'managed', undefined, 'mcp'), { group: 'managed' });
  });

  it('какие каталоги читать и подпись области', () => {
    assert.deepEqual(requestedDirs(ctx), [A, B, C]);
    assert.deepEqual(requestedDirs({ repos: [A], session: { root: '/w/x', repo: A } }), [A, '/w/x']);
    assert.match(viewNote('everywhere', ctx), /во всех проектах и воркспейсах/);
    assert.match(viewNote('session', ctx), /доп\. каталог/);
  });
});

describe('вкладка «Установленные»', () => {
  it('«Везде»: только пользовательские плагины и скиллы', () => {
    const tree = installedTree(data(), 'everywhere', ctx);
    assert.equal(tree.length, 1);
    assert.match(tree[0].label, /^Везде/);
    assert.deepEqual(labels(tree[0].children), ['p', '/mine']);
  });

  it('«Сессия»: пользователь, репозиторий сессии, затем доп. каталоги', () => {
    const tree = installedTree(data(), 'session', ctx);
    assert.deepEqual(labels(tree), ['Везде · для вас во всех проектах', 'Сессия · repoA', 'Доп. каталог · repoB', 'Доп. каталог · repoC']);
    assert.deepEqual(labels(tree[1].children), ['q', '/proj']);
    assert.deepEqual(labels(tree[2].children), ['r', 'add']);
  });

  it('«Проект»: каждый репозиторий своей группой в порядке проекта', () => {
    const tree = installedTree(data(), 'project', ctx);
    assert.deepEqual(labels(tree).slice(1), ['Проект · repoA', 'Проект · repoB', 'Проект · repoC']);
  });

  it('метки: область, выключен, у плагина состав с вызовом /плагин:скилл и кнопка удаления', () => {
    const p = walk(installedTree(data(), 'project', ctx)).find((n) => n.label === 'r')!;
    assert.deepEqual(p.badges, ['локально', 'выключен']);
    const user = walk(installedTree(data(), 'everywhere', ctx)).find((n) => n.label === 'p')!;
    assert.deepEqual(labels(user.children), ['/p:hello']);
    assert.deepEqual(user.actions.map((a) => a.label), ['Удалить…', 'GitHub ↗']);
  });

  it('плагин организации и на сессию не удаляется из окна', () => {
    const r = reply({ plugins: [plugin({ id: 'm@mk', name: 'm', scope: 'managed' }), plugin({ id: 's@mk', name: 's', scope: 'session' })] });
    for (const n of walk(installedTree(data(r), 'everywhere', ctx)).filter((x) => x.kind === 'plugin')) assert.deepEqual(n.actions.map((a) => a.action.type), ['open-url'], n.label);
  });

  it('выключенный пользовательский плагин: «выключен» или «выключен в …» по репозиториям', () => {
    const r = reply({ plugins: [plugin({ enabledGlobal: true, enabledIn: { [A]: true, [B]: false, [C]: true } })] });
    const state = (view: 'everywhere' | 'project' | 'session') => walk(installedTree(data(r), view, ctx)).find((n) => n.label === 'p')!.badges;
    assert.deepEqual(state('everywhere'), ['везде']);
    assert.deepEqual(state('project'), ['везде', 'выключен в repoB']);
    assert.deepEqual(state('session'), ['везде']);
  });
});

describe('вкладка «Магазины»', () => {
  it('магазин → плагин → состав; удалённый плагин с пометкой о составе', () => {
    const tree = marketplaceTree(data(), 'everywhere', ctx);
    assert.deepEqual(labels(tree), ['mk']);
    const [p, far] = tree[0].children;
    assert.deepEqual(labels(p.children), ['/p:hello']);
    assert.match(far.children[0].label, /после установки/);
    assert.ok(far.actions.some((a) => a.label === 'Установить…'));
  });

  it('метка «установлен» берётся из области; магазин, названный репозиторием, виден в его области', () => {
    const p = marketplaceTree(data(), 'everywhere', ctx)[0].children[0];
    assert.deepEqual(p.badges, ['установлен · везде']);
    assert.deepEqual(labels(marketplaceTree(data(), 'everywhere', ctx)), ['mk']);
    assert.deepEqual(labels(marketplaceTree(data(), 'project', ctx)), ['mk', 'team']);
    assert.deepEqual(labels(marketplaceTree(data(), 'session', { ...ctx, session: { root: A, repo: A } })), ['mk', 'team'], 'repoB - доп. каталог: extraKnownMarketplaces оттуда подхватывается');
  });

  it('у подключённого магазина «Отключить…» со списком плагинов, которые удалятся; у названного - «Подключить»', () => {
    const [mk, team] = marketplaceTree(data(), 'project', ctx);
    const remove = mk.actions[0].action;
    assert.equal(remove.type, 'market-remove');
    assert.deepEqual(remove.type === 'market-remove' ? remove.installed.sort() : [], ['c@mk', 'p@mk', 'q@mk', 'r@mk']);
    assert.equal(team.actions[0].label, 'Подключить');
    assert.deepEqual(team.actions[0].action, { type: 'market-add', source: 'team/x', name: 'team' });
  });

  it('у неподключённого магазина плагины не устанавливаются', () => {
    const r = reply({ marketplaces: [{ name: 'x', source: 'github a/b', known: false, declaredBy: [A], plugins: [{ name: 'z', description: '', remote: true, components: null }] }] });
    assert.deepEqual(walk(marketplaceTree(data(r), 'project', ctx)).flatMap((n) => n.actions.map((a) => a.label)), ['Подключить', 'GitHub ↗']);
  });
});

describe('вкладка «MCP»', () => {
  it('серверы по областям; доп. каталоги и чужие репозитории не попадают в «Сессию»', () => {
    const tree = mcpTree(data(), 'session', ctx);
    const names = walk(tree).filter((n) => n.kind === 'mcp').map((n) => n.label);
    assert.deepEqual(names.sort(), ['g', 'psrv', 'shared']);
  });

  it('«Проект» показывает серверы всех репозиториев, «Везде» - только пользовательские', () => {
    assert.deepEqual(walk(mcpTree(data(), 'project', ctx)).filter((n) => n.kind === 'mcp').map((n) => n.label).sort(), ['g', 'other', 'psrv', 'shared']);
    assert.deepEqual(walk(mcpTree(data(), 'everywhere', ctx)).filter((n) => n.kind === 'mcp').map((n) => n.label), ['g']);
  });

  it('подпись, одобрение и результат проверки связи; коннекторы claude.ai появляются только после проверки', () => {
    const health = new Map<string, ProbeEntry>([
      ['shared', { name: 'shared', health: 'pending' }],
      ['claude.ai Gmail', { name: 'claude.ai Gmail', health: 'connected' }],
    ]);
    const nodes = walk(mcpTree(data(reply(), { health }), 'everywhere', ctx));
    assert.ok(nodes.some((n) => n.label === 'claude.ai Gmail' && n.badges.includes('подключён')));
    const shared = walk(mcpTree(data(reply(), { health }), 'session', ctx)).find((n) => n.label === 'shared')!;
    assert.equal(shared.detail, 'stdio · srv');
    assert.deepEqual(shared.badges, ['проект', 'ждёт одобрения', 'ждёт одобрения']);
    assert.ok(!walk(mcpTree(data(), 'everywhere', ctx)).some((n) => n.label.startsWith('claude.ai')));
  });
});

describe('вкладка «Хабы»', () => {
  const hubs: Hub[] = [
    { id: 'builtin', name: 'Рекомендуемые', description: 'Список для проверки', url: null, enabled: true, builtin: true },
    { id: 'h1', name: 'Команда', url: 'https://example.com/hub.json', enabled: false, builtin: false },
  ];
  const content = new Map<string, HubContent>([
    ['builtin', { entries: [{ name: 'mk', description: 'уже подключён', source: 'o/r', label: 'github o/r' }, { name: 'new', description: 'новый', source: 'n/m', label: 'github n/m', stars: 41994, plugins: 94 }], skipped: 2 }],
  ]);

  it('записи включённого хаба с пометкой «подключён» и кнопкой; отключённый хаб свёрнут', () => {
    const tree = hubTree(data(reply(), { hubs, hubContent: content }));
    assert.deepEqual(labels(tree), ['Рекомендуемые', 'Команда']);
    const [mk, fresh, skipped] = tree[0].children;
    assert.deepEqual(mk.badges, ['подключён']);
    assert.deepEqual(fresh.badges, ['★ 42k', 'плагинов 94']);
    assert.equal(tree[0].description, 'Список для проверки');
    assert.deepEqual(mk.actions.map((a) => a.label), ['GitHub ↗']);
    assert.deepEqual(fresh.actions[0].action, { type: 'market-add', source: 'n/m', name: 'new' });
    assert.match(skipped.label, /отброшено.*2/);
    assert.deepEqual(tree[1].badges, ['отключён']);
    assert.deepEqual(tree[1].children, []);
  });

  it('кнопки хаба: встроенный отключается, свой ещё и удаляется; загрузка и ошибка видны', () => {
    const tree = hubTree(data(reply(), { hubs, hubContent: new Map([['h1', { entries: [], error: 'Хаб ответил 404' }]]) }));
    assert.deepEqual(tree[0].actions.map((a) => a.label), ['Отключить']);
    assert.deepEqual(tree[1].actions.map((a) => a.label), ['Подключить', 'Удалить…']);
    assert.equal(tree[0].children[0].label, 'Загрузка…');
    const enabled = hubTree(data(reply(), { hubs: [{ ...hubs[1], enabled: true }], hubContent: new Map([['h1', { entries: [], error: 'Хаб ответил 404' }]]) }));
    assert.equal(enabled[0].children[0].label, 'Хаб ответил 404');
  });

  it('звёзды компактно', () => {
    assert.deepEqual([999, 1000, 1234, 9999, 10_000, 41_994, 238_491].map(compact), ['999', '1k', '1.2k', '10k', '10k', '42k', '238k']);
  });

  it('sameSource и addableSource', () => {
    assert.equal(sameSource('Owner/Repo', 'github owner/repo'), true);
    assert.equal(sameSource('https://x.io/a.git', 'git https://x.io/a'), true);
    assert.equal(sameSource('a/b', 'github a/c'), false);
    assert.equal(addableSource('github o/r'), 'o/r');
    assert.equal(addableSource('directory /srv/m'), null);
    assert.equal(addableSource(''), null);
  });
});

describe('фильтр и строки', () => {
  const matcher = (q: string, regex = false) => {
    const m = compileMatcher(q, { regex, caseSensitive: false, wholeWord: false });
    assert.ok(m.ok);
    return m as Extract<typeof m, { ok: true }>;
  };

  it('без запроса дерево не меняется; с запросом остаются совпавшие и их предки, ветки раскрыты', () => {
    const tree = marketplaceTree(data(), 'everywhere', ctx);
    assert.equal(filterTree(tree, null), tree);
    const found = filterTree(tree, matcher('hello'));
    assert.deepEqual(labels(found), ['mk']);
    assert.deepEqual(labels(found[0].children), ['p']);
    assert.equal(found[0].open, true);
    assert.equal(filterTree(tree, matcher('нет такого')).length, 0);
  });

  it('совпало имя плагина - виден и его состав; подписи групп и сносок не ищутся', () => {
    const tree = installedTree(data(), 'project', ctx);
    assert.equal(filterTree(tree, matcher('repoA')).length, 0, 'название группы не совпадение');
    const found = filterTree(tree, matcher('^p$', true));
    assert.deepEqual(labels(walk(found)), ['Везде · для вас во всех проектах', 'p', '/p:hello']);
  });

  it('по описанию тоже ищется', () => {
    assert.ok(walk(filterTree(installedTree(data(), 'project', ctx), matcher('проектный'))).some((n) => n.label === '/proj'));
  });

  it('flatten: раскрытие по умолчанию, выбор человека сильнее, предел строк', () => {
    const tree = installedTree(data(), 'project', ctx);
    const base = flatten(tree, new Map(), 100);
    assert.ok(base.rows.some((r) => r.node.label === 'p' && r.expanded === false), 'плагин свёрнут, пока не раскрыт');
    assert.ok(base.rows.every((r) => r.node.label !== '/p:hello'));
    const open = flatten(tree, new Map([[base.rows.find((r) => r.node.label === 'p')!.node.key, true]]), 100);
    assert.ok(open.rows.some((r) => r.node.label === '/p:hello'));
    const closed = flatten(tree, new Map([[tree[0].key, false]]), 100);
    assert.ok(closed.rows.length < base.rows.length);
    const limited = flatten(tree, new Map(), 3);
    assert.equal(limited.rows.length, 3);
    assert.ok(limited.hidden > 0);
  });

  it('вызов: скилл и команда с косой чертой, агент без неё', () => {
    assert.equal(invocation('pl', { kind: 'skill', name: 's', description: '' }), '/pl:s');
    assert.equal(invocation(null, { kind: 'command', name: 'c', description: '' }), '/c');
    assert.equal(invocation('pl', { kind: 'agent', name: 'a', description: '' }), 'pl:a');
  });

  it('ключи узлов уникальны во всех вкладках', () => {
    const h: Hub[] = [{ id: 'builtin', name: 'b', url: null, enabled: true, builtin: true }];
    const all = [...marketplaceTree(data(), 'project', ctx), ...installedTree(data(), 'project', ctx), ...mcpTree(data(), 'project', ctx), ...hubTree(data(reply(), { hubs: h }))];
    const keys = walk(all).map((n) => n.key);
    assert.equal(new Set(keys).size, keys.length);
  });
});
