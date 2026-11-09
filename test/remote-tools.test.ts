import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { claudeArgs, REMOTE_SYSTEM_PROMPT, SESSION_PROMPT } from '../src/main/claude-args';
import { gitOriginUrl } from '../src/main/git';
import { McpServer, type McpBackend } from '../src/main/mcp';
import { bundleOf, installScript } from '../src/main/remote/install';
import { PREFLIGHT_SCRIPT } from '../src/main/remote/preflight';
import type { SessionInfo } from '../src/main/sessions';
import { createSessionTools, describePeers, sessionTools, validateCloseAgent, validateReport, validateSpawn, type RemoteToolsPort } from '../src/main/session-tools';

const DIRS = ['/repo/a', '/repo/b'];
const names = (tools: { name: string }[]): string[] => tools.map((t) => t.name);
const peer = (id: number, state: SessionInfo['state'], extra: Partial<SessionInfo> = {}): SessionInfo => ({ id, dirs: DIRS, cwd: '/repo/a', state, queued: 0, ...extra });

describe('набор инструментов по виду сессии', () => {
  it('локальная без хостов проекта - прежний набор, без spawn_agent и close_agent', () => {
    assert.deepEqual(names(sessionTools(DIRS)), ['open_session', 'list_sessions', 'send_to_session', 'close_session']);
  });

  it('локальная с хостами - плюс spawn_agent с перечнем хостов и close_agent', () => {
    const tools = sessionTools(DIRS, { kind: 'local', hosts: ['dev1', 'dev2'] });
    assert.ok(names(tools).includes('spawn_agent') && names(tools).includes('close_agent'));
    const spawn = tools.find((t) => t.name === 'spawn_agent') as unknown as { inputSchema: { properties: { host: { enum: string[] }; repo: { enum: string[] } } } };
    assert.deepEqual(spawn.inputSchema.properties.host.enum, ['dev1', 'dev2']);
    assert.deepEqual(spawn.inputSchema.properties.repo.enum, DIRS);
  });

  it('удалённая - список, сообщение и report_done; порождать и закрывать агентов нельзя', () => {
    assert.deepEqual(names(sessionTools(DIRS, { kind: 'remote', hosts: ['dev1'] })), ['list_sessions', 'send_to_session', 'report_done']);
  });
});

describe('validateSpawn', () => {
  const ok = { host: 'dev1', repo: '/repo/a', branch: 'feat/x', prompt: ' задание ' };

  it('принимает аргументы, keep по умолчанию false, промпт обрезан', () => {
    assert.deepEqual(validateSpawn(ok, DIRS, ['dev1']), { host: 'dev1', repo: '/repo/a', branch: 'feat/x', prompt: 'задание', keep: false });
    assert.deepEqual(validateSpawn({ ...ok, keep: true, limits: { max_agents_per_host: 2, task_timeout_min: 30 } }, DIRS, ['dev1']), {
      host: 'dev1',
      repo: '/repo/a',
      branch: 'feat/x',
      prompt: 'задание',
      keep: true,
      limits: { max_agents_per_host: 2, task_timeout_min: 30 },
    });
  });

  it('отвергает хост и каталог вне проекта, ветку-ключ, пустое задание, неверные пределы', () => {
    assert.match(validateSpawn({ ...ok, host: 'evil' }, DIRS, ['dev1']) as string, /dev1/);
    assert.match(validateSpawn({ ...ok, repo: '/etc' }, DIRS, ['dev1']) as string, /\/repo\/a/);
    assert.equal(typeof validateSpawn({ ...ok, branch: '--upload-pack=x' }, DIRS, ['dev1']), 'string');
    assert.match(validateSpawn({ ...ok, prompt: '  ' }, DIRS, ['dev1']) as string, /непустая/);
    assert.match(validateSpawn({ ...ok, prompt: '- x' }, DIRS, ['dev1']) as string, /«-»/);
    assert.match(validateSpawn({ ...ok, limits: { max_agents_per_host: 99 } }, DIRS, ['dev1']) as string, /от 1 до 16/);
    assert.match(validateSpawn({ ...ok, limits: { foo: 1 } }, DIRS, ['dev1']) as string, /неизвестное поле/);
    assert.match(validateSpawn({ ...ok, keep: 'yes' }, DIRS, ['dev1']) as string, /keep/);
  });
});

describe('validateReport и validateCloseAgent', () => {
  it('report_done: статус из перечня, итог непустой, ветка - имя ref, PR - https', () => {
    assert.deepEqual(validateReport({ status: 'ok', summary: ' готово ', branch: 'feat/x', pr: 'https://h/p/1' }), { status: 'ok', summary: 'готово', branch: 'feat/x', pr: 'https://h/p/1' });
    assert.match(validateReport({ status: 'done', summary: 'x' }) as string, /ok, failed или blocked/);
    assert.match(validateReport({ status: 'ok', summary: ' ' }) as string, /summary/);
    assert.equal(typeof validateReport({ status: 'ok', summary: 'x', branch: '-x' }), 'string');
    assert.match(validateReport({ status: 'ok', summary: 'x', pr: 'http://h' }) as string, /https/);
  });

  it('close_agent: цель - удалённая вкладка проекта', () => {
    const peers = [peer(1, 'waiting'), peer(2, 'waiting', { host: 'dev1' })];
    assert.deepEqual(validateCloseAgent({ id: 2, keep: true }, peers), { id: 2, keep: true });
    assert.deepEqual(validateCloseAgent({ id: 2 }, peers), { id: 2, keep: false });
    assert.match(validateCloseAgent({ id: 1 }, peers) as string, /close_session/);
    assert.match(validateCloseAgent({ id: 9 }, peers) as string, /нет среди вкладок/);
  });

  it('list_sessions показывает хост и обрыв связи удалённой вкладки', () => {
    const list = JSON.parse(describePeers([peer(1, 'waiting'), peer(2, 'waiting', { host: 'dev1', link: 'offline' })], 1)) as { id: number; host?: string; link?: string }[];
    assert.equal(list[0].host, undefined);
    assert.equal(list[1].host, 'dev1');
    assert.equal(list[1].link, 'offline');
  });
});

describe('createSessionTools: удалённая часть', () => {
  function rig(kind: 'local' | 'remote') {
    const calls: unknown[][] = [];
    const remote: RemoteToolsPort = {
      prepare: async (...a) => void calls.push(['prepare', ...a]),
      report: async (id, r) => (calls.push(['report', id, r]), 'принят'),
      close: async (id, keep) => (calls.push(['close', id, keep]), 'закрыта'),
    };
    const requested: unknown[][] = [];
    const peers = [peer(1, 'waiting'), peer(2, 'waiting', { host: 'dev1' })];
    const backend = createSessionTools(
      { dirsOf: () => DIRS, peers: () => peers, say: async () => 'sent', kindOf: () => kind, hostsOf: () => ['dev1'] },
      { request: async (...a) => (requested.push(a), 7) },
      () => undefined,
      10,
      remote,
    );
    return { backend, calls, requested };
  }

  it('spawn_agent проверяет хост, затем передаёт вкладку с хостом, веткой и keep', async () => {
    const { backend, calls, requested } = rig('local');
    assert.match(await backend.call(1, 'spawn_agent', { host: 'dev1', repo: '/repo/a', branch: 'b', prompt: 'p', keep: true }), /удалённой сессии 7 на dev1/);
    assert.deepEqual(calls, [['prepare', 'dev1', '/repo/a', undefined]]);
    assert.deepEqual(requested, [[1, '/repo/a', 'p', { host: 'dev1', branch: 'b', limits: undefined, keep: true }]]);
  });

  it('удалённая сессия не вызывает spawn_agent и close_agent, даже зная имя', async () => {
    const { backend, calls } = rig('remote');
    await assert.rejects(backend.call(1, 'spawn_agent', { host: 'dev1', repo: '/repo/a', branch: 'b', prompt: 'p' }), /недоступен удалённой сессии/);
    await assert.rejects(backend.call(1, 'close_agent', { id: 2 }), /недоступен удалённой сессии/);
    assert.deepEqual(calls, []);
  });

  it('report_done, close_agent и close_session над удалённой идут в удалённую часть', async () => {
    const { backend, calls } = rig('local');
    assert.equal(await backend.call(2, 'report_done', { status: 'ok', summary: 's' }), 'принят');
    assert.equal(await backend.call(1, 'close_agent', { id: 2, keep: true }), 'закрыта');
    assert.equal(await backend.call(1, 'close_session', { id: 2 }), 'закрыта');
    assert.deepEqual(calls, [
      ['report', 2, { status: 'ok', summary: 's' }],
      ['close', 2, true],
      ['close', 2, false],
    ]);
  });
});

describe('McpServer: токены удалённых сессий', () => {
  it('issue выдаёт токен без конфига, accept принимает известный; disconnect отзывает оба', async (t) => {
    const backend: McpBackend = { tools: () => [], call: async () => '' };
    const server = new McpServer(backend, 'v');
    await server.listen();
    t.after(() => server.close());
    const post = (token: string) =>
      fetch(`http://127.0.0.1:${server.boundPort}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }).then((r) => r.status);
    const issued = server.issue(5);
    assert.match(issued, /^[\w-]{43}$/);
    server.accept('known-token', 6);
    assert.equal(await post(issued), 200);
    assert.equal(await post('known-token'), 200);
    server.disconnect(5);
    server.disconnect(6);
    assert.equal(await post(issued), 401);
    assert.equal(await post('known-token'), 401);
  });
});

describe('аргументы claude', () => {
  it('удалённая сессия получает свой системный промпт, локальная - прежний', () => {
    assert.ok(claudeArgs(['/x']).includes(SESSION_PROMPT));
    assert.ok(!claudeArgs(['/x']).includes(REMOTE_SYSTEM_PROMPT));
    const remote = claudeArgs(['/x'], 'задание', undefined, REMOTE_SYSTEM_PROMPT);
    assert.ok(remote.includes(REMOTE_SYSTEM_PROMPT) && !remote.includes(SESSION_PROMPT));
    assert.match(REMOTE_SYSTEM_PROMPT, /report_done/);
  });
});

describe('gitOriginUrl', () => {
  it('адрес origin; без origin и вне репозитория - null', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-origin-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    assert.equal(await gitOriginUrl(dir), null);
    spawnSync('git', ['init', '-q'], { cwd: dir });
    assert.equal(await gitOriginUrl(dir), null);
    spawnSync('git', ['remote', 'add', 'origin', 'git@h:o/r.git'], { cwd: dir });
    assert.equal(await gitOriginUrl(dir), 'git@h:o/r.git');
  });
});

describe('установка агента и проверка хоста: скрипты на настоящем sh', () => {
  const sh = (script: string, home: string) => spawnSync('sh', ['-s'], { input: script, env: { ...process.env, HOME: home, SHELL: '/bin/sh' }, encoding: 'utf8' });
  const tmpHome = (t: { after: (fn: () => void) => void }): string => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-inst-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    return home;
  };

  it('установка кладёт agentd.js и connect.sh в каталог версии с правами 0700 и проверяет контрольную сумму', (t) => {
    const home = tmpHome(t);
    const bundle = bundleOf('console.log("agentd");\n');
    const done = sh(installScript(bundle), home);
    assert.equal(done.status, 0, done.stderr);
    const dir = path.join(home, '.cyborg', 'agentd', bundle.version);
    assert.equal(fs.readFileSync(path.join(dir, 'agentd.js'), 'utf8'), bundle.source + '\n');
    assert.match(fs.readFileSync(path.join(dir, 'connect.sh'), 'utf8'), /agentd\.js" connect/);
    assert.equal(fs.statSync(path.join(home, '.cyborg')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['agentd.js', 'connect.sh']);
  });

  it('не сошлась сумма - установка падает и версию не создаёт', (t) => {
    const home = tmpHome(t);
    const bundle = bundleOf('console.log("agentd");\n');
    const done = sh(installScript({ ...bundle, sha256: '0'.repeat(64) }), home);
    assert.notEqual(done.status, 0);
    assert.match(done.stderr, /контрольная сумма/);
    assert.equal(fs.existsSync(path.join(home, '.cyborg', 'agentd', bundle.version, 'agentd.js')), false);
  });

  it('исходник с разделителем heredoc внутри переносится целым', (t) => {
    const home = tmpHome(t);
    const bundle = bundleOf('const x = `\nCYBORG_EOF\n`;\n');
    assert.equal(sh(installScript(bundle), home).status, 0);
    assert.equal(fs.readFileSync(path.join(home, '.cyborg', 'agentd', bundle.version, 'agentd.js'), 'utf8'), bundle.source + '\n');
  });

  it('проверка хоста печатает home и установленные версии', (t) => {
    const home = tmpHome(t);
    fs.mkdirSync(path.join(home, '.cyborg', 'agentd', 'abc'), { recursive: true });
    const out = sh(PREFLIGHT_SCRIPT, home).stdout;
    assert.match(out, new RegExp(`^home=${home}$`, 'm'));
    assert.match(out, /^agentd=abc $/m);
  });
});
