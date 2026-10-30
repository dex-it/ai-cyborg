import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { callsOfLine, UsageStore } from '../src/main/extensions-usage';
import type { ExtensionsReply, Hub, HubContent, InstalledPlugin } from '../src/shared/extensions';
import { callKey, hubTree, installedTree, marketplaceTree, mcpKey, mcpTree, sourceLink, type ExtContext, type ExtData, type ExtNode } from '../src/renderer/extensions-model';

const line = (record: object): string => JSON.stringify(record);
const AT = '2026-10-30T10:00:00.000Z';
const tool = (name: string, input: object) => line({ type: 'assistant', timestamp: AT, message: { content: [{ type: 'tool_use', id: `t-${name}`, name, input }] } });

describe('вызовы в журнале сессии', () => {
  it('Skill, Agent, Task и инструмент MCP в ответе модели', () => {
    assert.deepEqual(callsOfLine(tool('Skill', { skill: 'p:hello' })), [{ key: '/p:hello', at: Date.parse(AT) }]);
    assert.deepEqual(callsOfLine(tool('Agent', { description: 'x', subagent_type: 'p:rev' }))[0].key, 'agent:p:rev');
    assert.deepEqual(callsOfLine(tool('Task', { subagent_type: 'p:rev' }))[0].key, 'agent:p:rev');
    assert.deepEqual(callsOfLine(tool('mcp__plugin_p_srv__do_it', {}))[0].key, 'mcp:plugin_p_srv');
  });

  it('прочие инструменты и агент без типа не считаются', () => {
    assert.deepEqual(callsOfLine(tool('Bash', { command: 'ls' })), []);
    assert.deepEqual(callsOfLine(tool('Agent', { description: 'x' })), []);
  });

  it('набранная человеком команда - строкой и блоком текста', () => {
    const text = '<command-message>p:hello</command-message>\n<command-name>/p:hello</command-name>';
    assert.deepEqual(callsOfLine(line({ type: 'user', timestamp: AT, message: { content: text } }))[0].key, '/p:hello');
    assert.deepEqual(callsOfLine(line({ type: 'user', message: { content: [{ type: 'text', text }] } }))[0], { key: '/p:hello', at: 0 });
  });

  it('снимок запроса к API повторяет переписку и вызовом не считается', () => {
    const snapshot = line({ type: 'api-request-blob', timestamp: AT, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'p:hello' } }] } });
    assert.deepEqual(callsOfLine(snapshot), []);
  });

  it('повреждённая строка - без вызовов', () => {
    assert.deepEqual(callsOfLine('{"type":"assistant","message":{"content":[{"type":"tool_u'), []);
  });
});

describe('кэш статистики', () => {
  const setup = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-usage-'));
    const projects = path.join(root, 'projects');
    fs.mkdirSync(path.join(projects, '-w-a', 'sess', 'subagents'), { recursive: true });
    return { root, projects, cache: path.join(root, 'usage.json') };
  };

  it('считает журналы и субагентов, снимок запроса к API в журнале счёта не меняет', async () => {
    const { root, projects, cache } = setup();
    try {
      const snapshot = line({ type: 'api-request-blob', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'p:hello' } }] } });
      fs.writeFileSync(path.join(projects, '-w-a', 'one.jsonl'), `${tool('Skill', { skill: 'p:hello' })}\n${snapshot}\n`);
      fs.writeFileSync(path.join(projects, '-w-a', 'sess', 'subagents', 'agent-1.jsonl'), `${tool('Skill', { skill: 'p:hello' })}\n`);
      const reply = await new UsageStore(projects, cache).read();
      assert.equal(reply.files, 2);
      assert.deepEqual(reply.calls['/p:hello'], { count: 2, last: Date.parse(AT) });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('дочитывает только хвост, недописанную строку берёт следующим чтением, переписанный журнал читает заново', async () => {
    const { root, projects, cache } = setup();
    try {
      const file = path.join(projects, '-w-a', 'one.jsonl');
      const full = tool('Skill', { skill: 'p:hello' });
      fs.writeFileSync(file, `${full}\n${full.slice(0, 20)}`);
      assert.equal((await new UsageStore(projects, cache).read()).calls['/p:hello'].count, 1);
      fs.appendFileSync(file, `${full.slice(20)}\n`);
      // Новый экземпляр - как после перезапуска: состояние берётся из файла кэша.
      assert.equal((await new UsageStore(projects, cache).read()).calls['/p:hello'].count, 2);
      fs.writeFileSync(file, `${tool('Agent', { subagent_type: 'p:rev' })}\n`);
      const reply = await new UsageStore(projects, cache).read();
      assert.equal(reply.calls['/p:hello'], undefined);
      assert.equal(reply.calls['agent:p:rev'].count, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

const ctx: ExtContext = { repos: [], session: null };
const plugin = (over: Partial<InstalledPlugin> = {}): InstalledPlugin => ({
  id: 'p@mk',
  name: 'p',
  marketplace: 'mk',
  version: '1.0.0',
  scope: 'user',
  enabledGlobal: true,
  enabledIn: {},
  components: [{ kind: 'skill', name: 'hello', description: '' }],
  mcp: [],
  errors: [],
  ...over,
});
const reply = (over: Partial<ExtensionsReply> = {}): ExtensionsReply => ({
  claude: {},
  marketplaces: [{ name: 'mk', source: 'github o/r', known: true, declaredBy: [], plugins: [] }],
  plugins: [plugin()],
  standalone: [{ kind: 'skill', name: 'mine', description: '', scope: 'user' }],
  mcp: [{ name: 'g', scope: 'user', transport: 'http', target: 'https://g.io' }],
  problems: [],
  ...over,
});
const data = (r = reply(), over: Partial<ExtData> = {}): ExtData => ({ reply: r, hubs: [], hubContent: new Map(), health: new Map(), ...over });
const walk = (nodes: ExtNode[]): ExtNode[] => nodes.flatMap((n) => [n, ...walk(n.children)]);
const link = (n: ExtNode | undefined) => n?.actions.find((a) => a.action.type === 'open-url')?.action;

describe('ссылка на магазин', () => {
  it('источник GitHub, git по https и ssh, raw-файл каталога ведут на страницу репозитория', () => {
    assert.deepEqual(sourceLink('github o/r'), { label: 'GitHub', url: 'https://github.com/o/r' });
    assert.deepEqual(sourceLink('git https://github.com/o/r.git'), { label: 'GitHub', url: 'https://github.com/o/r' });
    assert.deepEqual(sourceLink('git github.com:o/r.git'), { label: 'GitHub', url: 'https://github.com/o/r' });
    assert.deepEqual(sourceLink('url https://raw.githubusercontent.com/o/r/main/marketplace.json'), { label: 'GitHub', url: 'https://github.com/o/r' });
  });

  it('другой https-хост открывается как есть, путь на диске ссылки не даёт', () => {
    assert.deepEqual(sourceLink('git https://gitlab.com/g/x.git'), { label: 'Открыть', url: 'https://gitlab.com/g/x' });
    assert.equal(sourceLink('directory /home/me/mk'), null);
    assert.equal(sourceLink('git file:///srv/mk'), null);
  });

  it('кнопка перехода у магазина, установленного плагина и записи хаба', () => {
    assert.deepEqual(link(marketplaceTree(data(), 'everywhere', ctx)[0]), { type: 'open-url', url: 'https://github.com/o/r' });
    assert.deepEqual(link(walk(installedTree(data(), 'everywhere', ctx)).find((n) => n.kind === 'plugin')), { type: 'open-url', url: 'https://github.com/o/r' });
    const hub: Hub = { id: 'h', name: 'H', url: null, enabled: true, builtin: true };
    const content: HubContent = {
      entries: [
        { name: 'e', description: '', source: 'x/y', label: 'github x/y' },
        { name: 'g', description: '', source: 'https://github.com/o/git-mk.git', label: 'git github.com' },
      ],
    };
    const entries = walk(hubTree(data(reply(), { hubs: [hub], hubContent: new Map([['h', content]]) }))).filter((n) => n.kind === 'entry');
    assert.deepEqual(entries.map(link), [
      { type: 'open-url', url: 'https://github.com/x/y' },
      { type: 'open-url', url: 'https://github.com/o/git-mk' },
    ]);
  });
});

describe('статистика вызовов в дереве', () => {
  it('ключи: скилл и команда через `/`, агент через `agent:`, сервер плагина - `plugin_<плагин>_<сервер>`', () => {
    assert.equal(callKey('p', { kind: 'skill', name: 'hello', description: '' }), '/p:hello');
    assert.equal(callKey('p', { kind: 'agent', name: 'rev', description: '' }), 'agent:p:rev');
    assert.equal(callKey(null, { kind: 'command', name: 'mine', description: '' }), '/mine');
    assert.equal(mcpKey('srv', 'q@mk'), 'mcp:plugin_q_srv');
    assert.equal(mcpKey('claude.ai Claude Docs'), 'mcp:claude_ai_Claude_Docs');
  });

  it('у плагина - сумма по составу и серверам, у компонента - свой счёт, без вызовов - ноль', () => {
    const usage = { '/p:hello': { count: 3, last: 10 }, 'agent:p:rev': { count: 2, last: 30 }, 'mcp:plugin_p_srv': { count: 1, last: 20 }, '/mine': { count: 5, last: 1 } };
    const p = plugin({ components: [{ kind: 'skill', name: 'hello', description: '' }, { kind: 'agent', name: 'rev', description: '' }, { kind: 'skill', name: 'idle', description: '' }], mcp: ['srv'] });
    const nodes = walk(installedTree(data(reply({ plugins: [p] }), { usage }), 'everywhere', ctx));
    assert.deepEqual(nodes.find((n) => n.kind === 'plugin')?.calls, { count: 6, last: 30 });
    assert.deepEqual(nodes.find((n) => n.label === '/p:idle')?.calls, { count: 0, last: 0 });
    assert.deepEqual(nodes.find((n) => n.label === '/mine')?.calls, { count: 5, last: 1 });
  });

  it('у плагина без состава и серверов счёта нет, «не вызывался» не пишется', () => {
    const nodes = walk(installedTree(data(reply({ plugins: [plugin({ components: [] })] }), { usage: {} }), 'everywhere', ctx));
    assert.equal(nodes.find((n) => n.kind === 'plugin')?.calls, undefined);
  });

  it('в магазине счёт только у состава установленного плагина', () => {
    const market = (plugins: InstalledPlugin[]) =>
      walk(marketplaceTree(data(reply({ plugins, marketplaces: [{ name: 'mk', source: 'github o/r', known: true, declaredBy: [], plugins: [{ name: 'p', description: '', remote: false, components: [{ kind: 'skill', name: 'hello', description: '' }] }] }] }), { usage: { '/p:hello': { count: 2, last: 1 } } }), 'everywhere', ctx)).find((n) => n.label === '/p:hello');
    assert.deepEqual(market([plugin()])?.calls, { count: 2, last: 1 });
    assert.equal(market([])?.calls, undefined);
  });

  it('пока статистика не прочитана, счёта у узлов нет', () => {
    assert.ok(walk(installedTree(data(), 'everywhere', ctx)).every((n) => n.calls === undefined));
  });

  it('у сервера вкладки «MCP» - свой счёт', () => {
    const nodes = walk(mcpTree(data(reply(), { usage: { 'mcp:g': { count: 4, last: 5 } } }), 'everywhere', ctx));
    assert.deepEqual(nodes.find((n) => n.label === 'g')?.calls, { count: 4, last: 5 });
  });
});
