import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  approvalOf,
  describeMcp,
  describeSource,
  mapLimit,
  mcpServersOf,
  parseFrontmatter,
  readCatalog,
  readClaudeJson,
  readComponents,
  readSettings,
  readSyncedSkills,
} from '../src/main/extensions-read';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-ext-')));
const write = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

describe('parseFrontmatter', () => {
  it('имя и описание в одной строке, в кавычках и с BOM', () => {
    assert.deepEqual(parseFrontmatter('---\nname: pdf\ndescription: "Работа с PDF"\n---\nтело'), { name: 'pdf', description: 'Работа с PDF' });
    assert.deepEqual(parseFrontmatter('﻿---\ndescription: \'a: b\'\n---\n'), { description: 'a: b' });
  });

  it('блочное и продолженное описание склеивается', () => {
    assert.equal(parseFrontmatter('---\ndescription: >\n  первая\n  вторая\nname: x\n---\n').description, 'первая вторая');
    assert.equal(parseFrontmatter('---\ndescription: начало\n  продолжение\n---\n').description, 'начало продолжение');
  });

  it('без frontmatter и вне его ничего не читается', () => {
    assert.deepEqual(parseFrontmatter('# Заголовок\nname: x'), {});
    assert.deepEqual(parseFrontmatter('---\nname: a\n---\nname: b').name, 'a');
  });

  it('длинное описание обрезается', () => {
    assert.ok((parseFrontmatter(`---\ndescription: ${'я'.repeat(2000)}\n---\n`).description ?? '').length <= 400);
  });
});

describe('описание сервера MCP не несёт секретов', () => {
  it('stdio: только имя программы, без пути и аргументов', () => {
    assert.deepEqual(describeMcp({ command: '/usr/local/bin/npx', args: ['-y', 'srv', '--token', 'SECRET'], env: { KEY: 'SECRET' } }), { transport: 'stdio', target: 'npx' });
  });

  it('http и sse: схема и хост, без учётных данных, пути и запроса', () => {
    assert.deepEqual(describeMcp({ type: 'http', url: 'https://user:SECRET@mcp.example.com:8443/v1/x?key=SECRET', headers: { Authorization: 'Bearer SECRET' } }), {
      transport: 'http',
      target: 'https://mcp.example.com:8443',
    });
    assert.equal(describeMcp({ type: 'sse', url: 'https://a.b/sse' })?.transport, 'sse');
    assert.equal(describeMcp({ url: 'не адрес' })?.target, '');
  });

  it('не объект - null; в разобранном списке нет ни одного значения env и headers', () => {
    assert.equal(describeMcp('x'), null);
    const servers = mcpServersOf({ a: { command: 'x', env: { T: 'SECRET' } }, b: { type: 'http', url: 'https://h.io/p', headers: { A: 'SECRET' } }, c: 5 }, { scope: 'user' });
    assert.deepEqual(servers.map((s) => s.name), ['a', 'b']);
    assert.ok(!JSON.stringify(servers).includes('SECRET'));
  });
});

describe('одобрение серверов .mcp.json', () => {
  it('отключён сильнее разрешён; без записи ждёт одобрения; enableAll одобряет', () => {
    assert.equal(approvalOf('a', ['a'], ['a'], false), 'disabled');
    assert.equal(approvalOf('a', ['a'], [], false), 'approved');
    assert.equal(approvalOf('a', [], [], false), 'pending');
    assert.equal(approvalOf('a', [], [], true), 'approved');
    assert.equal(approvalOf('a', [], ['a'], true), 'disabled');
  });
});

describe('describeSource', () => {
  it('репозиторий, адрес без учётных данных и запроса, путь', () => {
    assert.equal(describeSource({ source: 'github', repo: 'a/b' }), 'github a/b');
    assert.equal(describeSource({ source: 'git', url: 'https://u:p@git.example.com/x.git?token=T' }), 'git https://git.example.com/x.git');
    assert.equal(describeSource({ source: 'directory', path: '/srv/m' }), 'directory /srv/m');
    assert.equal(describeSource(null), '');
  });
});

describe('состав плагина и скиллы', () => {
  it('скиллы, команды (в том числе из подкаталога) и агенты с описаниями', async () => {
    const dir = tmp();
    write(dir, 'skills/one/SKILL.md', '---\nname: one\ndescription: Первый\n---\n');
    write(dir, 'skills/two/SKILL.md', '---\ndescription: Второй\n---\n');
    write(dir, 'skills/empty/notes.txt', 'нет SKILL.md');
    write(dir, 'commands/build.md', '---\ndescription: Сборка\n---\n');
    write(dir, 'commands/git/pr.md', '---\ndescription: PR\n---\n');
    write(dir, 'agents/rev.md', '---\nname: reviewer\ndescription: Ревью\n---\n');
    const found = await readComponents(dir);
    assert.deepEqual(
      found.map((c) => `${c.kind}:${c.name}:${c.description}`),
      ['skill:one:Первый', 'skill:two:Второй', 'command:build:Сборка', 'command:git:pr:PR', 'agent:reviewer:Ревью'],
    );
  });

  it('нет каталогов - пусто, а не ошибка', async () => {
    assert.deepEqual(await readComponents(path.join(tmp(), 'нет')), []);
  });

  it('скиллы, синхронизированные с claude.ai, лежат на уровень глубже', async () => {
    const dir = tmp();
    write(dir, 'synced/abc/pdf/SKILL.md', '---\nname: pdf\ndescription: ПДФ\n---\n');
    write(dir, 'synced/abc/manifest.json', '{}');
    assert.deepEqual((await readSyncedSkills(dir)).map((c) => c.name), ['pdf']);
  });

  it('mapLimit держит порядок и не превышает предел', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return n * 2;
    });
    assert.deepEqual(out, [2, 4, 6, 8, 10, 12]);
    assert.ok(peak <= 2);
  });
});

describe('каталог магазина', () => {
  it('относительный source даёт каталог внутри клона, удалённый и выходящий наружу - нет', async () => {
    const dir = tmp();
    write(
      dir,
      '.claude-plugin/marketplace.json',
      JSON.stringify({
        name: 'm',
        metadata: { pluginRoot: './plugins' },
        plugins: [
          { name: 'local', source: './local', description: 'Свой', version: '1.0.0', category: 'dev' },
          { name: 'remote', source: { source: 'url', url: 'https://example.com/r.git' } },
          { name: 'escape', source: '../../etc' },
          { source: './no-name' },
        ],
      }),
    );
    const { plugins, truncated } = await readCatalog(dir);
    assert.equal(truncated, false);
    assert.deepEqual(plugins.map((p) => [p.name, p.folder]), [
      ['local', path.join(dir, 'plugins', 'local')],
      ['remote', null],
      ['escape', null],
    ]);
    assert.equal(plugins[0].version, '1.0.0');
  });

  it('нет файла или списка - исключение с причиной', async () => {
    await assert.rejects(readCatalog(tmp()));
    const dir = tmp();
    write(dir, '.claude-plugin/marketplace.json', '{"name":"m"}');
    await assert.rejects(readCatalog(dir), /plugins/);
  });
});

describe('файлы настроек и ~/.claude.json', () => {
  it('названные магазины и одобрения серверов; нет файла - пусто, битый - исключение', async () => {
    const dir = tmp();
    write(dir, 's.json', JSON.stringify({ extraKnownMarketplaces: { acme: { source: { source: 'github', repo: 'a/b' } } }, enabledMcpjsonServers: ['x', 5], disabledMcpjsonServers: ['y'], enableAllProjectMcpServers: true }));
    const s = await readSettings(path.join(dir, 's.json'));
    assert.deepEqual(s.declaredMarketplaces, [{ name: 'acme', source: 'github a/b' }]);
    assert.deepEqual([s.enabledMcp, s.disabledMcp, s.enableAllMcp], [['x'], ['y'], true]);
    assert.deepEqual((await readSettings(path.join(dir, 'нет.json'))).declaredMarketplaces, []);
    write(dir, 'bad.json', '{');
    await assert.rejects(readSettings(path.join(dir, 'bad.json')));
  });

  it('из .claude.json берутся серверы пользователя и проектов и их одобрения, остальное нет', async () => {
    const dir = tmp();
    write(
      dir,
      '.claude.json',
      JSON.stringify({ userID: 'SECRET', history: ['SECRET'], mcpServers: { u: { command: 'x' } }, projects: { '/r': { mcpServers: { l: { command: 'y' } }, enabledMcpjsonServers: ['p'], history: ['SECRET'] } } }),
    );
    const parsed = await readClaudeJson(path.join(dir, '.claude.json'));
    assert.deepEqual(Object.keys(parsed.mcpServers as object), ['u']);
    assert.deepEqual(parsed.projects.get('/r')?.enabled, ['p']);
    assert.ok(!JSON.stringify([...parsed.projects]).includes('SECRET'));
    assert.equal((await readClaudeJson(path.join(dir, 'нет'))).projects.size, 0);
  });
});
