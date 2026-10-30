import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { claudePaths, loadExtensions, parseJsonOutput, parseMcpList, probeMcp, type ClaudeResult, type ClaudeRunner, type ExtensionsEnv } from '../src/main/extensions';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-ext-')));
const write = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const ok = (stdout: string): ClaudeResult => ({ code: 0, stdout, stderr: '', missing: false, timedOut: false });

interface Lab {
  home: string;
  config: string;
  repoA: string;
  repoB: string;
  neutral: string;
  market: string;
  calls: string[];
}

/** Домашний каталог с настройками, два репозитория и магазин на диске; ответы claude подставляет тест. */
function lab(): Lab {
  const home = tmp();
  const config = path.join(home, '.claude');
  const repoA = path.join(home, 'repoA');
  const repoB = path.join(home, 'repoB');
  const market = path.join(home, 'market');
  const neutral = path.join(home, 'neutral');
  for (const dir of [repoA, repoB, neutral]) fs.mkdirSync(dir, { recursive: true });
  write(market, '.claude-plugin/marketplace.json', JSON.stringify({ name: 'mk', plugins: [{ name: 'pa', source: './plugins/pa', description: 'A' }, { name: 'far', source: { source: 'url', url: 'https://x.io/f.git' } }] }));
  write(market, 'plugins/pa/skills/hello/SKILL.md', '---\ndescription: Привет\n---\n');
  write(config, 'skills/mine/SKILL.md', '---\ndescription: Личный\n---\n');
  write(repoA, '.claude/skills/proj/SKILL.md', '---\ndescription: Проектный\n---\n');
  write(repoA, '.mcp.json', JSON.stringify({ mcpServers: { shared: { command: '/bin/srv', args: ['SECRET'], env: { T: 'SECRET' } }, off: { type: 'http', url: 'https://h.io/x?k=SECRET' } } }));
  write(repoA, '.claude/settings.json', JSON.stringify({ extraKnownMarketplaces: { team: { source: { source: 'github', repo: 'team/plugins' } } }, disabledMcpjsonServers: ['off'] }));
  write(home, '.claude.json', JSON.stringify({ mcpServers: { global: { type: 'http', url: 'https://g.io/mcp', headers: { Authorization: 'SECRET' } } }, projects: { [repoB]: { mcpServers: { mine: { command: 'z' } } } } }));
  return { home, config, repoA, repoB, neutral, market, calls: [] };
}

const pluginRecord = (over: Record<string, unknown>) => ({ version: '1.0.0', enabled: true, installPath: '', ...over });

function fakeRun(l: Lab, lists: Record<string, unknown[] | 'fail'>, extra?: (args: string[], cwd: string) => ClaudeResult | undefined): ClaudeRunner {
  return async (args, cwd) => {
    l.calls.push(`${args.join(' ')} @${path.basename(cwd)}`);
    const custom = extra?.(args, cwd);
    if (custom) return custom;
    if (args[0] === '--version') return ok('2.1.314 (Claude Code)\n');
    if (args.join(' ') === 'plugin marketplace list --json') return ok(JSON.stringify([{ name: 'mk', source: 'directory', path: l.market, installLocation: l.market }]));
    if (args.join(' ') === 'plugin list --json') {
      const list = lists[path.basename(cwd)] ?? [];
      return list === 'fail' ? { code: 1, stdout: '', stderr: 'boom\n', missing: false, timedOut: false } : ok(JSON.stringify(list));
    }
    return { code: 1, stdout: '', stderr: 'неизвестно', missing: false, timedOut: false };
  };
}

const envOf = (l: Lab, run: ClaudeRunner): ExtensionsEnv => ({ run, home: l.home, configDir: l.config, claudeJson: path.join(l.home, '.claude.json'), neutralDir: l.neutral, managedDir: null });

describe('claudePaths', () => {
  it('CLAUDE_CONFIG_DIR переносит и каталог, и .claude.json; организация только на macOS и Linux', () => {
    assert.deepEqual(claudePaths('/h', {}, 'linux'), { configDir: '/h/.claude', claudeJson: '/h/.claude.json', managedDir: '/etc/claude-code' });
    assert.equal(claudePaths('/h', {}, 'darwin').managedDir, '/Library/Application Support/ClaudeCode');
    assert.deepEqual(claudePaths('/h', { CLAUDE_CONFIG_DIR: '/c' }, 'darwin').claudeJson, '/c/.claude.json');
    assert.equal(claudePaths('/h', {}, 'win32').managedDir, null);
  });
});

describe('parseJsonOutput', () => {
  it('JSON с мусором от login-шелла впереди разбирается, не-JSON - исключение', () => {
    assert.deepEqual(parseJsonOutput('Last login: x\n[{"a":1}]'), [{ a: 1 }]);
    assert.deepEqual(parseJsonOutput('[]'), []);
    assert.throws(() => parseJsonOutput('нет данных'));
  });
});

describe('loadExtensions', () => {
  it('собирает магазины, плагины, скиллы и серверы по областям', async () => {
    const l = lab();
    const installPath = path.join(l.market, 'plugins/pa');
    const lists = {
      neutral: [pluginRecord({ id: 'pa@mk', scope: 'user', installPath }), pluginRecord({ id: 'pa@mk', scope: 'project', projectPath: l.repoA, installPath, enabled: false }), pluginRecord({ id: 'x@mk', scope: 'project', projectPath: '/чужой/репозиторий' })],
      repoA: [pluginRecord({ id: 'pa@mk', scope: 'user', installPath }), pluginRecord({ id: 'pa@mk', scope: 'project', projectPath: l.repoA, installPath, mcpServers: { psrv: { command: 'x', args: ['SECRET'] } } })],
      repoB: [pluginRecord({ id: 'pa@mk', scope: 'user', installPath, enabled: false })],
    };
    const reply = await loadExtensions([l.repoA, l.repoB], envOf(l, fakeRun(l, lists)));

    assert.equal(reply.claude.version, '2.1.314');
    assert.deepEqual(reply.problems, []);
    const market = reply.marketplaces.find((m) => m.name === 'mk')!;
    assert.deepEqual(market.plugins.map((p) => [p.name, p.remote, p.components?.map((c) => c.name) ?? null]), [['pa', false, ['hello']], ['far', true, null]]);
    assert.equal(reply.marketplaces.find((m) => m.name === 'team')?.known, false, 'магазин, названный в репозитории, но не подключённый');
    assert.deepEqual(reply.marketplaces.find((m) => m.name === 'team')?.declaredBy, [l.repoA]);

    assert.equal(reply.plugins.length, 2, 'установка в чужом репозитории не попала');
    const user = reply.plugins.find((p) => p.scope === 'user')!;
    assert.equal(user.enabledGlobal, true);
    assert.deepEqual(user.enabledIn, { [l.repoA]: true, [l.repoB]: false });
    const project = reply.plugins.find((p) => p.scope === 'project')!;
    assert.equal(project.dir, l.repoA);
    assert.deepEqual(project.mcp, ['psrv']);

    assert.deepEqual(reply.standalone.map((s) => `${s.scope}:${s.name}`).sort(), ['project:proj', 'user:mine']);

    const byName = Object.fromEntries(reply.mcp.map((s) => [s.name, s]));
    assert.equal(byName.global.scope, 'user');
    assert.equal(byName.mine.scope, 'local');
    assert.equal(byName.mine.dir, l.repoB);
    assert.equal(byName.shared.approval, 'pending');
    assert.equal(byName.off.approval, 'disabled');
    assert.equal(byName.psrv.scope, 'plugin');
  });

  it('в ответе нет ни одного секрета из конфигов серверов', async () => {
    const l = lab();
    const reply = await loadExtensions([l.repoA, l.repoB], envOf(l, fakeRun(l, { repoA: [pluginRecord({ id: 'p@mk', scope: 'user', mcpServers: { s: { command: 'x', env: { K: 'SECRET' } } } })] })));
    assert.ok(!JSON.stringify(reply).includes('SECRET'));
  });

  it('claude не найден: магазины и плагины не читаются, скиллы и серверы из файлов остаются', async () => {
    const l = lab();
    const run: ClaudeRunner = async () => ({ code: null, stdout: '', stderr: '', missing: true, timedOut: false });
    const reply = await loadExtensions([l.repoA], envOf(l, run));
    assert.match(reply.claude.problem ?? '', /не найден/);
    assert.deepEqual([reply.marketplaces.length, reply.plugins.length], [0, 0]);
    assert.ok(reply.standalone.length >= 2 && reply.mcp.length >= 3);
  });

  it('сбой списка плагинов виден в ответе, остальное читается', async () => {
    const l = lab();
    const reply = await loadExtensions([l.repoA], envOf(l, fakeRun(l, { neutral: 'fail', repoA: 'fail' })));
    assert.match(reply.claude.problem ?? '', /Список плагинов не получен: boom/);
    assert.equal(reply.marketplaces.length >= 1, true);
  });

  it('повреждённый файл настроек попадает в problems, а не роняет чтение', async () => {
    const l = lab();
    write(l.repoB, '.claude/settings.local.json', '{');
    const reply = await loadExtensions([l.repoA, l.repoB], envOf(l, fakeRun(l, {})));
    assert.ok(reply.problems.some((p) => p.includes('settings.local.json')), reply.problems.join('|'));
    assert.ok(reply.mcp.length > 0);
  });

  it('ничего не запускает, кроме чтения: ни mcp list, ни install', async () => {
    const l = lab();
    await loadExtensions([l.repoA, l.repoB], envOf(l, fakeRun(l, {})));
    assert.ok(l.calls.every((c) => /^(--version|plugin list --json|plugin marketplace list --json)/.test(c)), l.calls.join('\n'));
  });
});

describe('проверка связи', () => {
  const text = [
    'Checking MCP server health…',
    '',
    'claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected',
    'claude.ai Atlassian: https://mcp.atlassian.com/v1/sse - ! Needs authentication',
    'plugin:pa:pa-srv: echo PLUGIN_SECRET - ✘ Failed to connect — CONNECTION_CLOSED: Connection closed',
    'lab-echo: echo hi SECRET_ARG - ⏸ Pending approval (run `claude` to approve)',
  ].join('\n');

  it('разбирает текст claude mcp list: имя, состояние, причина; аргументы запуска не сохраняются', () => {
    const entries = parseMcpList(text);
    assert.deepEqual(entries.map((e) => [e.name, e.health]), [
      ['claude.ai Gmail', 'connected'],
      ['claude.ai Atlassian', 'needs-auth'],
      ['plugin:pa:pa-srv', 'failed'],
      ['lab-echo', 'pending'],
    ]);
    assert.equal(entries[2].detail, 'CONNECTION_CLOSED: Connection closed');
    assert.ok(!JSON.stringify(entries).includes('SECRET'));
  });

  it('probeMcp запускает claude mcp list в каталоге и сообщает о нехватке claude и таймауте', async () => {
    const seen: string[] = [];
    assert.equal((await probeMcp('/r', async (args, cwd) => (seen.push(`${args.join(' ')}@${cwd}`), ok(text)))).entries.length, 4);
    assert.deepEqual(seen, ['mcp list@/r']);
    assert.match((await probeMcp('/r', async () => ({ code: null, stdout: '', stderr: '', missing: true, timedOut: false }))).error ?? '', /не найден/);
    assert.match((await probeMcp('/r', async () => ({ code: null, stdout: '', stderr: '', missing: false, timedOut: true }))).error ?? '', /90 с/);
  });
});
