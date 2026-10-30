import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { BUILTIN_ENTRIES, fetchHub, HubStore, hubUrlProblem, parseHub } from '../src/main/hubs';
import { marketplaceSourceProblem } from '../src/shared/extensions';

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-hubs-')), 'hubs.json');

describe('хранилище хабов', () => {
  it('без файла есть встроенный хаб; его нельзя удалить, но можно отключить и включить', () => {
    const store = new HubStore(file());
    assert.deepEqual(store.list().map((h) => [h.id, h.builtin, h.enabled]), [['builtin', true, true]]);
    assert.throws(() => store.apply({ op: 'remove', id: 'builtin' }), /не удаляется/);
    assert.equal(store.apply({ op: 'disable', id: 'builtin' })[0].enabled, false);
    assert.equal(store.apply({ op: 'enable', id: 'builtin' })[0].enabled, true);
  });

  it('добавление проверяет название и адрес, не допускает повтор и переживает перечитывание', () => {
    const f = file();
    const store = new HubStore(f);
    const hubs = store.apply({ op: 'add', name: ' Команда ', url: 'https://example.com/hub.json' });
    assert.equal(hubs.length, 2);
    assert.equal(hubs[1].name, 'Команда');
    assert.equal(hubs[1].builtin, false);
    assert.throws(() => store.apply({ op: 'add', name: 'Ещё', url: 'https://example.com/hub.json' }), /уже есть/);
    for (const url of ['http://example.com/h.json', 'https://u:p@example.com/h.json', 'file:///etc/passwd', '', 'не адрес']) {
      assert.throws(() => store.apply({ op: 'add', name: 'X', url }), Error, url);
    }
    assert.throws(() => store.apply({ op: 'add', name: '', url: 'https://a.io/h.json' }), /Название/);
    assert.equal(new HubStore(f).list().length, 2);
  });

  it('отключение и удаление пользовательского хаба; неизвестный хаб и операция - отказ', () => {
    const store = new HubStore(file());
    const id = store.apply({ op: 'add', name: 'H', url: 'https://example.com/h.json' })[1].id;
    assert.equal(store.apply({ op: 'disable', id })[1].enabled, false);
    assert.equal(store.find(id)?.enabled, false);
    assert.equal(store.apply({ op: 'remove', id }).length, 1);
    assert.equal(store.find(id), undefined);
    assert.throws(() => store.apply({ op: 'enable', id: 'нет' }), /нет/);
    assert.throws(() => store.apply({ op: 'взорвать' }), /операция/);
    assert.throws(() => store.apply(null), /операция/);
  });

  it('повреждённый файл не роняет список', () => {
    const f = file();
    fs.writeFileSync(f, '{');
    assert.equal(new HubStore(f).list().length, 1);
    fs.writeFileSync(f, JSON.stringify({ custom: [{ name: 'x', url: 'http://плохо' }, 5], disabled: [1, 'builtin'] }));
    const list = new HubStore(f).list();
    assert.equal(list.length, 1);
    assert.equal(list[0].enabled, false);
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
    for (const e of BUILTIN_ENTRIES) assert.equal(marketplaceSourceProblem(e.source), null);
    assert.equal(hubUrlProblem('https://example.com/h.json'), null);
  });
});

describe('получение хаба', () => {
  const hub = { id: 'h1', name: 'H', url: 'https://example.com/hub.json', enabled: true, builtin: false };
  const body = (text: string) => new Response(text).body;
  const reply = (text: string, over: Partial<{ ok: boolean; status: number; url: string }> = {}) =>
    async () => ({ ok: true, status: 200, url: hub.url, body: body(text), ...over });

  it('встроенный хаб не ходит в сеть', async () => {
    const content = await fetchHub({ id: 'builtin', name: 'b', url: null, enabled: true, builtin: true }, async () => assert.fail('сеть'));
    assert.deepEqual(content.entries, BUILTIN_ENTRIES);
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
