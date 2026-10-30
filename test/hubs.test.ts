import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { BUILTIN_ENTRIES, fetchHub, fetchTopicHub, forgetTopicCache, HubStore, hubUrlProblem, parseCatalog, parseHub, TOPIC_QUERY, type Fetch } from '../src/main/hubs';
import { marketplaceSourceProblem } from '../src/shared/extensions';

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-hubs-')), 'hubs.json');

describe('хранилище хабов', () => {
  it('без файла есть три встроенных хаба; их нельзя удалить, но можно отключить и включить', () => {
    const store = new HubStore(file());
    assert.deepEqual(store.list().map((h) => [h.id, h.builtin, h.enabled]), [['anthropic', true, true], ['dex-it', true, true], ['github-topic', true, true]]);
    for (const hub of store.list()) assert.ok(hub.description, `у ${hub.id} нет описания`);
    assert.throws(() => store.apply({ op: 'remove', id: 'anthropic' }), /не удаляется/);
    assert.equal(store.apply({ op: 'disable', id: 'github-topic' })[2].enabled, false);
    assert.equal(store.apply({ op: 'enable', id: 'github-topic' })[2].enabled, true);
  });

  it('добавление проверяет название и адрес, не допускает повтор и переживает перечитывание', () => {
    const f = file();
    const store = new HubStore(f);
    const hubs = store.apply({ op: 'add', name: ' Команда ', url: 'https://example.com/hub.json' });
    assert.equal(hubs.length, 4);
    assert.equal(hubs[3].name, 'Команда');
    assert.equal(hubs[3].builtin, false);
    assert.throws(() => store.apply({ op: 'add', name: 'Ещё', url: 'https://example.com/hub.json' }), /уже есть/);
    for (const url of ['http://example.com/h.json', 'https://u:p@example.com/h.json', 'file:///etc/passwd', '', 'не адрес']) {
      assert.throws(() => store.apply({ op: 'add', name: 'X', url }), Error, url);
    }
    assert.throws(() => store.apply({ op: 'add', name: '', url: 'https://a.io/h.json' }), /Название/);
    assert.equal(new HubStore(f).list().length, 4);
  });

  it('отключение и удаление пользовательского хаба; неизвестный хаб и операция - отказ', () => {
    const store = new HubStore(file());
    const id = store.apply({ op: 'add', name: 'H', url: 'https://example.com/h.json' })[3].id;
    assert.equal(store.apply({ op: 'disable', id })[3].enabled, false);
    assert.equal(store.find(id)?.enabled, false);
    assert.equal(store.apply({ op: 'remove', id }).length, 3);
    assert.equal(store.find(id), undefined);
    assert.throws(() => store.apply({ op: 'enable', id: 'нет' }), /нет/);
    assert.throws(() => store.apply({ op: 'взорвать' }), /операция/);
    assert.throws(() => store.apply(null), /операция/);
  });

  it('повреждённый файл не роняет список', () => {
    const f = file();
    fs.writeFileSync(f, '{');
    assert.equal(new HubStore(f).list().length, 3);
    fs.writeFileSync(f, JSON.stringify({ custom: [{ name: 'x', url: 'http://плохо' }, 5], disabled: [1, 'dex-it', 'builtin'] }));
    const list = new HubStore(f).list();
    assert.equal(list.length, 3);
    assert.deepEqual(list.map((h) => h.enabled), [true, false, true]);
  });
});

describe('разбор хаба', () => {
  const hub = (marketplaces: unknown[]) => JSON.stringify({ name: 'h', marketplaces });

  it('github, git и url принимаются, остальное отбрасывается и считается', () => {
    const content = parseHub(
      hub([
        { name: 'a', description: 'Первый', source: { source: 'github', repo: 'o/r' } },
        { name: 'b', source: { source: 'git', url: 'https://git.example.com/x.git' } },
        { name: 'c', source: { source: 'url', url: 'https://example.com/m.json' } },
        { name: 'd', source: { source: 'directory', path: '/etc' } },
        { name: 'e', source: { source: 'github', repo: '--evil' } },
        { name: 'f', source: { source: 'git', url: 'http://plain.io/x.git' } },
        { name: 'g', source: { source: 'git', url: '/etc/passwd' } },
        { source: { source: 'github', repo: 'o/r' } },
        'строка',
      ]),
    );
    assert.deepEqual(content.entries.map((e) => [e.name, e.source, e.label]), [
      ['a', 'o/r', 'github o/r'],
      ['b', 'https://git.example.com/x.git', 'git git.example.com'],
      ['c', 'https://example.com/m.json', 'url example.com'],
    ]);
    assert.equal(content.skipped, 6);
    for (const e of content.entries) assert.equal(marketplaceSourceProblem(e.source), null);
  });

  it('не JSON и не тот объект - причина', () => {
    assert.match(parseHub('<html>').error ?? '', /не JSON/);
    assert.match(parseHub('{"name":"h"}').error ?? '', /marketplaces/);
  });

  it('управляющие символы в описании заменяются, длинное обрезается', () => {
    const e = parseHub(hub([{ name: 'a', description: `x\n‮y${'я'.repeat(1000)}`, source: { source: 'github', repo: 'o/r' } }])).entries[0];
    assert.ok(!/[\n‮]/.test(e.description));
    assert.ok(e.description.length <= 400);
  });

  it('встроенные записи проходят ту же проверку адреса', () => {
    for (const e of Object.values(BUILTIN_ENTRIES).flat()) assert.equal(marketplaceSourceProblem(e.source), null);
    assert.equal(hubUrlProblem('https://example.com/h.json'), null);
  });
});

describe('получение хаба', () => {
  const hub = { id: 'h1', name: 'H', url: 'https://example.com/hub.json', enabled: true, builtin: false };
  const anthropic = { id: 'anthropic', name: 'A', url: null, enabled: true, builtin: true };
  const body = (text: string) => new Response(text).body;
  const reply = (text: string, over: Partial<{ ok: boolean; status: number; url: string }> = {}): Fetch =>
    async () => ({ ok: true, status: 200, url: hub.url, body: body(text), ...over });

  it('встроенные списки не ходят в сеть: магазины Anthropic и команды', async () => {
    const content = await fetchHub(anthropic, async () => assert.fail('сеть'));
    assert.deepEqual(content.entries.map((e) => [e.name, e.source]), [
      ['claude-plugins-official', 'anthropics/claude-plugins-official'],
      ['claude-community', 'anthropics/claude-plugins-community'],
      ['anthropic-agent-skills', 'anthropics/skills'],
      ['knowledge-work-plugins', 'anthropics/knowledge-work-plugins'],
    ]);
    assert.equal((await fetchHub({ ...anthropic, id: 'dex-it' }, async () => assert.fail('сеть'))).entries[0].source, 'dex-it/ai-kit');
  });

  it('читает и разбирает ответ', async () => {
    const content = await fetchHub(hub, reply(JSON.stringify({ marketplaces: [{ name: 'a', source: { source: 'github', repo: 'o/r' } }] })));
    assert.equal(content.entries.length, 1);
  });

  it('перенаправление не на https, статус, огромный ответ и сбой сети - причины, не исключения', async () => {
    assert.match((await fetchHub(hub, reply('{}', { url: 'http://evil.io/x' }))).error ?? '', /не на https/);
    assert.match((await fetchHub(hub, reply('', { ok: false, status: 404 }))).error ?? '', /404/);
    assert.match((await fetchHub(hub, reply('x'.repeat(1024 * 1024 + 10)))).error ?? '', /1 МиБ/);
    assert.match((await fetchHub(hub, async () => Promise.reject(new Error('ECONNRESET')))).error ?? '', /ECONNRESET/);
    const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
    assert.match((await fetchHub(hub, async () => Promise.reject(timeout))).error ?? '', /10 с/);
  });
});

describe('каталог репозитория', () => {
  it('настоящий магазин называет себя и перечисляет плагины', () => {
    assert.deepEqual(parseCatalog('{"name":"mk","plugins":[{},{}]}'), { name: 'mk', plugins: 2 });
    for (const bad of ['', '[]', '{"name":"mk"}', '{"plugins":[]}', '{"name":5,"plugins":[]}', '{"name":"","plugins":[]}', '{"name":"a\\nb","plugins":[]}', '<html>']) assert.equal(parseCatalog(bad), null, bad);
  });
});

describe('хаб по теме GitHub', () => {
  const search = (items: unknown[]) => JSON.stringify({ total_count: items.length, items });
  const catalog = (name: string, plugins = 3) => JSON.stringify({ name, plugins: Array.from({ length: plugins }, () => ({})) });

  /** GitHub и raw.githubusercontent: поиск отдаёт items, каталоги - по репозиторию; нет в таблице - 404. */
  const github = (items: unknown[], catalogs: Record<string, string>, log: string[] = []): Fetch => async (url, init) => {
    log.push(url);
    assert.ok(url.startsWith('https://'));
    if (url.startsWith('https://api.github.com/search/repositories')) {
      assert.equal(new URL(url).searchParams.get('q'), TOPIC_QUERY);
      assert.equal(new URL(url).searchParams.get('sort'), 'stars');
      assert.equal(init.headers?.['User-Agent'], 'Cyborg');
      return { ok: true, status: 200, url, body: new Response(search(items)).body };
    }
    const repo = /raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/HEAD\/\.claude-plugin\/marketplace\.json$/.exec(url)?.[1];
    const text = repo ? catalogs[repo] : undefined;
    return text === undefined ? { ok: false, status: 404, url, body: null } : { ok: true, status: 200, url, body: new Response(text).body };
  };

  it('оставляет репозитории с настоящим каталогом, называет их по каталогу, держит порядок звёзд', async () => {
    forgetTopicCache();
    const content = await fetchTopicHub(
      github(
        [
          { full_name: 'big/market', description: 'Большой магазин', stargazers_count: 42000 },
          { full_name: 'spam/desktop', description: 'Скачай Desktop Client', stargazers_count: 900 },
          { full_name: 'mid/skills', description: null, stargazers_count: 150 },
          { full_name: '-evil/--flag', stargazers_count: 100 },
        ],
        { 'big/market': catalog('big-market', 12), 'mid/skills': catalog('mid-skills'), 'spam/desktop': '{"hello":"world"}' },
      ),
    );
    assert.deepEqual(content.entries.map((e) => [e.name, e.source, e.stars, e.plugins]), [
      ['big-market', 'big/market', 42000, 12],
      ['mid-skills', 'mid/skills', 150, 3],
    ]);
    assert.equal(content.entries[0].description, 'Большой магазин');
    assert.equal(content.entries[1].description, '');
    assert.equal(content.skipped, 2, 'без каталога и с именем, которое не принял бы claude, - отброшены и посчитаны');
    for (const entry of content.entries) assert.equal(marketplaceSourceProblem(entry.source), null);
  });

  it('лимит запросов GitHub, сбой и не JSON называются причиной', async () => {
    const status = (code: number): Fetch => async (url) => ({ ok: false, status: code, url, body: null });
    assert.match((await fetchTopicHub(status(403))).error ?? '', /ограничил/);
    assert.match((await fetchTopicHub(status(429))).error ?? '', /ограничил/);
    assert.match((await fetchTopicHub(status(500))).error ?? '', /500/);
    assert.match((await fetchTopicHub(async (url) => ({ ok: true, status: 200, url, body: new Response('<html>').body }))).error ?? '', /не разобран/);
    assert.match((await fetchTopicHub(async () => Promise.reject(new Error('offline')))).error ?? '', /offline/);
  });

  it('каталог, ушедший не на https или слишком большой, репозиторий отбрасывает', async () => {
    const big = 'x'.repeat(4 * 1024 * 1024 + 10);
    const content = await fetchTopicHub(github([{ full_name: 'a/big', stargazers_count: 50 }, { full_name: 'a/ok', stargazers_count: 40 }], { 'a/big': big, 'a/ok': catalog('ok') }));
    assert.deepEqual(content.entries.map((e) => e.source), ['a/ok']);
    const moved: Fetch = async (url, init) => (url.includes('raw.') ? { ok: true, status: 200, url: 'http://evil.io/x', body: new Response(catalog('m')).body } : github([{ full_name: 'a/b', stargazers_count: 30 }], {})(url, init));
    assert.deepEqual((await fetchTopicHub(moved)).entries, []);
  });

  it('ответ держится в памяти пять минут и сбрасывается по «Обновить»; ошибка не запоминается', async () => {
    forgetTopicCache();
    const topic = { id: 'github-topic', name: 'T', url: null, enabled: true, builtin: true };
    const log: string[] = [];
    const net = github([{ full_name: 'a/b', stargazers_count: 30 }], { 'a/b': catalog('b') }, log);
    const t0 = 1_000_000;
    assert.equal((await fetchHub(topic, net, false, t0)).entries.length, 1);
    const calls = log.length;
    assert.equal((await fetchHub(topic, net, false, t0 + 60_000)).entries.length, 1);
    assert.equal(log.length, calls, 'из памяти, без сети');
    await fetchHub(topic, net, true, t0 + 61_000);
    assert.ok(log.length > calls, 'принудительно - снова в сеть');
    await fetchHub(topic, net, false, t0 + 61_000 + 6 * 60_000);
    assert.ok(log.length > calls * 2 - 1, 'через шесть минут устарело');
    forgetTopicCache();
    const failing: Fetch = async (url) => ({ ok: false, status: 403, url, body: null });
    assert.ok((await fetchHub(topic, failing, false, t0)).error);
    assert.equal((await fetchHub(topic, net, false, t0 + 1)).entries.length, 1, 'после отказа пробует снова');
  });
});
