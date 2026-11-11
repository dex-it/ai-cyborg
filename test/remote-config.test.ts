import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { lineReader } from '../src/agentd/agentd';
import { applyFiles, claudeHome, configHash, hostMcp, installPlugins, readEnv, trustClone, type SetupExec } from '../src/agentd/claude-setup';
import type { ConfigMsg, Msg, SpawnMsg } from '../src/agentd/protocol';
import { projectDirName } from '../src/main/history';
import { buildMirror, marketplaceUrl, MIRROR_MAX_BYTES, readMemory } from '../src/main/remote/claude-config';
import { client, rig, until, type Rig } from './daemon-rig';

function tmp(t: { after: (fn: () => void) => void }, prefix = 'cyborg-cc-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function put(file: string, content: string | object, mode = 0o644): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content), { mode });
}

/** Локальная настройка оператора: хук с абсолютным HOME, локальный и github-маркетплейсы, сервер MCP с токеном. */
function localClaude(home: string) {
  const configDir = path.join(home, '.claude');
  put(path.join(configDir, 'CLAUDE.md'), '# правила\n');
  put(path.join(configDir, 'settings.json'), {
    env: { FOO: 'bar', TOOLS: `${home}/tools` },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: `${home}/.claude/hooks/stop.sh --x` }] }] },
    statusLine: { type: 'command', command: `bash ${home}/.claude/bin/line.sh` },
    enabledPlugins: { 'a@gh': true, 'b@loc': true, 'c@gh': false },
    extraKnownMarketplaces: { loc: { source: { source: 'directory', path: '/w/loc' } } },
    model: 'opus',
  });
  put(path.join(configDir, 'plugins', 'known_marketplaces.json'), {
    gh: { source: { source: 'github', repo: 'org/market', ref: 'v2' }, installLocation: '/x' },
    loc: { source: { source: 'directory', path: '/w/loc' }, installLocation: '/w/loc' },
  });
  put(path.join(configDir, 'hooks', 'stop.sh'), '#!/bin/sh\n', 0o755);
  put(path.join(configDir, 'skills', 'x', 'SKILL.md'), 'skill');
  put(path.join(configDir, 'skills', 'x', 'node_modules', 'junk.js'), 'junk');
  put(path.join(configDir, 'projects', 'p', 'memory', 'MEMORY.md'), 'не зеркалится');
  put(path.join(home, '.claude.json'), {
    mcpServers: {
      jira: { command: `${home}/.local/bin/jira-mcp`, args: [`${home}/cfg.json`, '--v'], env: { JIRA_TOKEN: 'SECRET-J' } },
      web: { type: 'http', url: 'https://mcp.example.com', headers: { Authorization: 'Bearer SECRET-W' } },
      cyborg: { type: 'http', url: 'http://127.0.0.1:1/mcp' },
    },
  });
  return { home, configDir, claudeJson: path.join(home, '.claude.json') };
}

const fileOf = (m: Awaited<ReturnType<typeof buildMirror>>, rel: string) => m.files.find((f) => f.rel === rel);
const textOf = (m: Awaited<ReturnType<typeof buildMirror>>, rel: string) => Buffer.from(fileOf(m, rel)!.b64, 'base64').toString('utf8');

describe('зеркало настройки Claude: сборка в Cyborg', () => {
  it('файлы ~/.claude без служебных каталогов, хуки от $HOME, без env и плагинов локального маркетплейса', async (t) => {
    const paths = localClaude(tmp(t));
    const m = await buildMirror(paths);
    assert.deepEqual(m.files.map((f) => f.rel).sort(), ['CLAUDE.md', 'hooks/stop.sh', 'settings.json', 'skills/x/SKILL.md']);
    assert.equal(fileOf(m, 'hooks/stop.sh')!.mode, 0o755);
    assert.equal(fileOf(m, 'CLAUDE.md')!.mode, 0o644);
    const settings = JSON.parse(textOf(m, 'settings.json'));
    assert.equal(settings.hooks.Stop[0].hooks[0].command, '$HOME/.claude/hooks/stop.sh --x');
    assert.equal(settings.statusLine.command, 'bash $HOME/.claude/bin/line.sh');
    assert.equal('env' in settings, false);
    assert.deepEqual(settings.enabledPlugins, { 'a@gh': true, 'c@gh': false });
    assert.deepEqual(settings.extraKnownMarketplaces, {});
    assert.equal(settings.model, 'opus');
    assert.deepEqual(m.marketplaces, [{ name: 'gh', source: 'org/market#v2' }]);
    assert.deepEqual(m.plugins, ['a@gh']);
    assert.deepEqual(m.env, { FOO: 'bar', TOOLS: '~/tools' });
    assert.deepEqual(Object.keys(m.mcp).sort(), ['jira', 'web']);
    assert.equal(m.mcp.jira.command, '~/.local/bin/jira-mcp');
    assert.deepEqual(m.mcp.jira.args, ['~/cfg.json', '--v']);
    assert.match(m.skipped.join('\n'), /плагин b@loc: маркетплейс loc/);
  });

  it('хэш стабилен, не зависит от env и серверов MCP, меняется с файлом', async (t) => {
    const paths = localClaude(tmp(t));
    const a = (await buildMirror(paths)).hash;
    assert.equal((await buildMirror(paths)).hash, a);
    const s = JSON.parse(fs.readFileSync(path.join(paths.configDir, 'settings.json'), 'utf8'));
    s.env.FOO = 'другой';
    put(path.join(paths.configDir, 'settings.json'), s);
    put(paths.claudeJson, { mcpServers: {} });
    assert.equal((await buildMirror(paths)).hash, a);
    put(path.join(paths.configDir, 'skills', 'x', 'SKILL.md'), 'skill 2');
    assert.notEqual((await buildMirror(paths)).hash, a);
  });

  it('сверх предела файлы не идут, заметка называет предел; без настройки зеркало пустое', async (t) => {
    const paths = localClaude(tmp(t));
    put(path.join(paths.configDir, 'commands', 'big.md'), Buffer.alloc(MIRROR_MAX_BYTES + 1, 97).toString());
    const m = await buildMirror(paths);
    assert.equal(fileOf(m, 'commands/big.md'), undefined);
    assert.equal(fileOf(m, 'skills/x/SKILL.md'), undefined, 'после предела обход дальше не идёт');
    assert.match(m.skipped.join('\n'), /больше 20 МиБ/);
    const empty = tmp(t);
    const e = await buildMirror({ home: empty, configDir: path.join(empty, '.claude'), claudeJson: path.join(empty, '.claude.json') });
    assert.deepEqual([e.files, e.plugins, e.marketplaces, e.mcp, e.env], [[], [], [], {}, {}]);
  });

  it('память проекта - по каталогу репозитория; адрес маркетплейса github - https', async (t) => {
    const paths = localClaude(tmp(t));
    put(path.join(paths.configDir, 'projects', projectDirName('/w/repo'), 'memory', 'MEMORY.md'), '- запись');
    put(path.join(paths.configDir, 'projects', projectDirName('/w/repo'), 'memory', 'a', 'b.md'), 'b');
    assert.deepEqual((await readMemory(paths.configDir, '/w/repo')).map((f) => f.rel), ['MEMORY.md', 'a/b.md']);
    assert.deepEqual(await readMemory(paths.configDir, '/w/other'), []);
    assert.equal(marketplaceUrl('org/market#v2'), 'https://github.com/org/market.git');
    assert.equal(marketplaceUrl('https://gl.example.com/a/m.git#main'), 'https://gl.example.com/a/m.git');
  });
});

const b64 = (s: string) => Buffer.from(s).toString('base64');
const HASH = (c: string) => c.repeat(64);

describe('зеркало настройки Claude: приём на хосте', () => {
  it('файлы ложатся в ~/.claude, чужой прежний сохраняется рядом, снятые из зеркала удаляются', (t) => {
    const home = tmp(t);
    const root = path.join(home, '.cyborg');
    const ch = claudeHome(home);
    put(path.join(ch.configDir, 'settings.json'), '{"own":1}');
    const msg = (files: ConfigMsg['files'], hash: string): ConfigMsg => ({ hash, files, marketplaces: [], plugins: [] });
    applyFiles(root, ch, msg([
      { rel: 'settings.json', mode: 0o644, b64: b64('{"m":1}') },
      { rel: 'hooks/a.sh', mode: 0o755, b64: b64('#!/bin/sh\n') },
      { rel: '../evil', mode: 0o644, b64: b64('x') },
      { rel: 'projects/x/memory/m.md', mode: 0o644, b64: b64('x') },
    ], HASH('a')));
    assert.equal(fs.readFileSync(path.join(ch.configDir, 'settings.json'), 'utf8'), '{"m":1}');
    assert.equal(fs.readFileSync(path.join(ch.configDir, 'settings.json.cyborg-orig'), 'utf8'), '{"own":1}');
    assert.equal(fs.statSync(path.join(ch.configDir, 'hooks', 'a.sh')).mode & 0o777, 0o755);
    assert.equal(fs.existsSync(path.join(home, 'evil')), false);
    assert.equal(fs.existsSync(path.join(ch.configDir, 'projects')), false);
    assert.equal(configHash(root), HASH('a'));
    applyFiles(root, ch, msg([{ rel: 'settings.json', mode: 0o644, b64: b64('{"m":2}') }], HASH('b')));
    assert.equal(fs.readFileSync(path.join(ch.configDir, 'settings.json.cyborg-orig'), 'utf8'), '{"own":1}', 'свой прежний файл не затирает сохранённый чужой');
    assert.equal(fs.existsSync(path.join(ch.configDir, 'hooks', 'a.sh')), false);
    applyFiles(root, ch, msg([], HASH('c')));
    assert.equal(fs.readFileSync(path.join(ch.configDir, 'settings.json'), 'utf8'), '{"own":1}', 'снятый из зеркала файл возвращает чужой');
    assert.throws(() => applyFiles(root, ch, msg([], 'не хэш')), /некорректная/);
  });

  it('плагины: добавляются недостающие маркетплейсы, ставятся недостающие плагины, отказы - заметками', async () => {
    const calls: string[] = [];
    const exec: SetupExec = async (file, args) => {
      const line = `${file} ${args.join(' ')}`;
      calls.push(line);
      if (line.endsWith('marketplace list --json')) return { code: 0, stdout: JSON.stringify([{ name: 'have' }]), stderr: '' };
      if (line.endsWith('plugin list --json')) return { code: 0, stdout: JSON.stringify([{ id: 'p1@have', enabled: true }]), stderr: '' };
      if (line.includes('install p3@bad')) return { code: 1, stdout: '', stderr: 'Plugin not found' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const notes = await installPlugins(exec, { marketplaces: [{ name: 'have', source: 'o/have' }, { name: 'new', source: 'o/new#v1' }, { name: 'x', source: '--evil' }], plugins: ['p1@have', 'p2@new', 'p3@bad', 'bad id'] }, {});
    assert.deepEqual(calls, [
      'claude plugin marketplace list --json',
      'claude plugin marketplace add o/new#v1',
      'claude plugin list --json',
      'claude plugin install p2@new',
      'claude plugin install p3@bad',
    ]);
    assert.deepEqual(notes, ['плагин p3@bad не поставлен: Plugin not found']);
    assert.deepEqual(await installPlugins(exec, { marketplaces: [], plugins: [] }, {}), []);
  });

  it('доверие к клонам: онбординг и hasTrustDialogAccepted дописываются, чужие поля целы, неразборный файл не трогается', (t) => {
    const home = tmp(t);
    const ch = claudeHome(home);
    trustClone(ch, ['/w/a']);
    assert.deepEqual(JSON.parse(fs.readFileSync(ch.claudeJson, 'utf8')), { hasCompletedOnboarding: true, projects: { '/w/a': { hasTrustDialogAccepted: true } } });
    put(ch.claudeJson, { hasCompletedOnboarding: false, oauthAccount: { id: 1 }, projects: { '/w/a': { history: [1] } } }, 0o600);
    trustClone(ch, ['/w/a', '/w/b']);
    const data = JSON.parse(fs.readFileSync(ch.claudeJson, 'utf8'));
    assert.equal(data.hasCompletedOnboarding, false, 'явный ответ пользователя не переписывается');
    assert.deepEqual(data.oauthAccount, { id: 1 });
    assert.deepEqual(data.projects, { '/w/a': { history: [1], hasTrustDialogAccepted: true }, '/w/b': { hasTrustDialogAccepted: true } });
    assert.equal(fs.statSync(ch.claudeJson).mode & 0o777, 0o600);
    put(ch.claudeJson, '{битый');
    trustClone(ch, ['/w/c']);
    assert.equal(fs.readFileSync(ch.claudeJson, 'utf8'), '{битый');
    assert.equal(claudeHome(home, '/cfg').claudeJson, '/cfg/.claude.json');
  });

  it('серверы MCP: ~/ раскрывается в HOME хоста, stdio без команды на хосте пропускается, http идёт как есть', (t) => {
    const home = tmp(t);
    put(path.join(home, '.local', 'bin', 'jira-mcp'), '#!/bin/sh\n', 0o755);
    const { servers, skipped } = hostMcp(
      {
        jira: { command: '~/.local/bin/jira-mcp', args: ['~/cfg.json'], env: { T: 'S' } },
        sh: { command: 'sh', args: [] },
        gone: { command: '/nowhere/bin/x' },
        nope: { command: 'no-such-command-cyborg' },
        web: { type: 'http', url: 'https://mcp.example.com' },
        cyborg: { type: 'http', url: 'http://evil' },
      },
      home,
      `/usr/bin:/bin`,
    );
    assert.deepEqual(Object.keys(servers).sort(), ['jira', 'sh', 'web']);
    assert.equal(servers.jira.command, path.join(home, '.local/bin/jira-mcp'));
    assert.deepEqual(servers.jira.args, [path.join(home, 'cfg.json')]);
    assert.deepEqual(skipped, ['сервер MCP gone пропущен: на хосте нет /nowhere/bin/x', 'сервер MCP nope пропущен: на хосте нет no-such-command-cyborg']);
  });

  it('env настройки не переопределяет PATH, HOME и переменные Cyborg', () => {
    assert.deepEqual(readEnv({ FOO: 'a', PATH: '/x', HOME: '/h', CYBORG_DIR: '/d', 'bad-name': 'b', N: 1, P: '~/t' }, '/home/u'), { FOO: 'a', P: '/home/u/t' });
  });

  it('строки канала: длинная строка частями и несколько строк в одном куске', () => {
    const got: string[] = [];
    const feed = lineReader((l) => got.push(l));
    const big = 'я'.repeat(100_000);
    const data = Buffer.from(`${big}\nb\nc`);
    for (let i = 0; i < data.length; i += 7777) feed(data.subarray(i, i + 7777));
    feed(Buffer.from('\n'));
    assert.deepEqual(got, [big, 'b', 'c']);
  });
});

const spawnMsg = (over: Partial<SpawnMsg> = {}): Msg =>
  ({
    type: 'spawn',
    rid: 1,
    sid: 'aaaaaaaa-1',
    token: 'T'.repeat(43),
    repos: [{ local: '/loc/a', url: 'git@h:o/a.git', name: 'a' }],
    selected: 0,
    branch: 'feat/x',
    origin: 'human',
    keep: false,
    limits: { maxPerHost: 4, taskMs: 4 * 3600_000, idleMs: 30 * 60_000 },
    cols: 120,
    rows: 40,
    ...over,
  }) as unknown as Msg;

function connect(r: Rig) {
  const c = client();
  const conn = r.daemon.connect(c);
  conn.receive({ type: 'hello', rid: 0, proto: 2, instance: 'i' } as Msg);
  return { c, conn };
}

const output = (c: ReturnType<typeof client>) => c.of('data').map((m) => String(m.data)).join('');

describe('daemon: зеркало настройки Claude', () => {
  it('hello отдаёт хэш зеркала; config пишет файлы, запуск ждёт плагинов и печатает отказы', async (t) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const r = rig(t);
    const execs: string[] = [];
    const exec = r.daemon['deps'].exec;
    r.daemon['deps'].exec = async (file, args, opts) => {
      if (file === 'claude') {
        execs.push(args.join(' '));
        if (args[1] === 'marketplace' && args[2] === 'list') await gate;
        if (args[1] === 'install') return { code: 1, stdout: '', stderr: 'нет такого' };
        return { code: 0, stdout: '[]', stderr: '' };
      }
      return exec(file, args, opts);
    };
    const { c, conn } = connect(r);
    await until(() => c.of('hello').length === 1);
    assert.equal(c.of('hello')[0].config, null);
    conn.receive({ type: 'config', rid: 2, hash: HASH('d'), files: [{ rel: 'CLAUDE.md', mode: 0o644, b64: b64('# x') }], marketplaces: [{ name: 'm', source: 'o/m' }], plugins: ['p@m'], auth: { git: [{ kind: 'github', host: 'github.com', token: 'gho_X' }] } } as Msg);
    await until(() => c.of('config').length === 1);
    assert.equal(fs.readFileSync(path.join(r.home, '.claude', 'CLAUDE.md'), 'utf8'), '# x');
    conn.receive(spawnMsg());
    await until(() => output(c).includes('ставятся плагины Claude'));
    assert.equal(r.spawned.length, 0, 'claude не стартует до конца установки');
    release();
    await until(() => r.spawned.length === 1);
    assert.deepEqual(execs, ['plugin marketplace list --json', 'plugin marketplace add o/m', 'plugin list --json', 'plugin install p@m']);
    assert.match(output(c), /плагин p@m не поставлен: нет такого/);
    const second = connect(r);
    await until(() => second.c.of('hello').length === 1);
    assert.equal(second.c.of('hello')[0].config, HASH('d'));
  });

  it('отказ установки плагина переживает демона: запуск после пересоздания повторяет установку и печатает заметку, а чистый итог больше не повторяется', async (t) => {
    const r = rig(t);
    let failing = true;
    const claudeCalls: string[] = [];
    const wire = (rr: Rig) => {
      const exec = rr.daemon['deps'].exec;
      rr.daemon['deps'].exec = async (file, args, opts) => {
        if (file !== 'claude') return exec(file, args, opts);
        claudeCalls.push(args.join(' '));
        if (args[1] === 'install') return failing ? { code: 1, stdout: '', stderr: 'сеть' } : { code: 0, stdout: '', stderr: '' };
        return { code: 0, stdout: '[]', stderr: '' };
      };
    };
    wire(r);
    const first = connect(r);
    await until(() => first.c.of('hello').length === 1);
    first.conn.receive({ type: 'config', rid: 2, hash: HASH('e'), files: [], marketplaces: [{ name: 'm', source: 'o/m' }], plugins: ['p@m'] } as Msg);
    await until(() => first.c.of('config').length === 1);
    first.conn.receive(spawnMsg());
    await until(() => r.spawned.length === 1);
    assert.match(output(first.c), /плагин p@m не поставлен: сеть/);
    r.daemon.stop();

    const again = rig(t, {}, r.home);
    wire(again);
    claudeCalls.length = 0;
    const second = connect(again);
    await until(() => second.c.of('hello').length === 1);
    assert.equal(second.c.of('hello')[0].config, HASH('e'), 'зеркало на месте, Cyborg настройку заново не шлёт');
    second.conn.receive(spawnMsg({ sid: 'bbbbbbbb-2' }));
    await until(() => again.spawned.length === 1);
    assert.ok(claudeCalls.includes('plugin install p@m'), 'установка недостающего плагина повторена без нового config');
    assert.match(output(second.c), /плагин p@m не поставлен: сеть/);

    failing = false;
    claudeCalls.length = 0;
    second.conn.receive(spawnMsg({ sid: 'cccccccc-3' }));
    await until(() => again.spawned.length === 2);
    assert.ok(claudeCalls.includes('plugin install p@m'));
    claudeCalls.length = 0;
    second.conn.receive(spawnMsg({ sid: 'dddddddd-4' }));
    await until(() => again.spawned.length === 3);
    assert.deepEqual(claudeCalls, [], 'после чистого итога установка не повторяется');
  });

  it('плагины: отказ marketplace add, marketplace list и plugin list - заметками', async () => {
    const run = (fail: string) => {
      const exec: SetupExec = async (file, args) => {
        const line = `${file} ${args.join(' ')}`;
        if (line.includes(fail)) return { code: 1, stdout: '', stderr: `нет: ${fail}` };
        if (line.endsWith('marketplace list --json') || line.endsWith('plugin list --json')) return { code: 0, stdout: '[]', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      };
      return installPlugins(exec, { marketplaces: [{ name: 'm', source: 'o/m' }], plugins: ['p@m'] }, {});
    };
    assert.deepEqual(await run('marketplace add'), ['маркетплейс m не добавлен: нет: marketplace add']);
    assert.deepEqual(await run('marketplace list'), ['плагины Claude не поставлены: claude plugin marketplace list - нет: marketplace list']);
    assert.deepEqual(await run('plugin list'), ['плагины Claude не поставлены: claude plugin list - нет: plugin list']);
  });

  it('серверы MCP и env пользователя - в mcp.json 0600 и окружении агента, mcp.json удаляется с выходом; клон доверен, память записана', async (t) => {
    const r = rig(t);
    const { c, conn } = connect(r);
    conn.receive(
      spawnMsg({
        env: { FOO: 'bar', PATH: '/evil' },
        mcp: { web: { type: 'http', url: 'https://mcp.example.com', headers: { Authorization: 'Bearer SECRET-W' } }, gone: { command: '/nowhere/x' } },
        memory: [{ rel: 'MEMORY.md', mode: 0o644, b64: b64('- запись') }],
      }),
    );
    await until(() => r.spawned.length === 1);
    const dir = path.join(r.home, '.cyborg', 'sessions', 'aaaaaaaa-1');
    const mcp = JSON.parse(fs.readFileSync(path.join(dir, 'mcp.json'), 'utf8'));
    assert.deepEqual(Object.keys(mcp.mcpServers).sort(), ['cyborg', 'web']);
    assert.equal(fs.statSync(path.join(dir, 'mcp.json')).mode & 0o777, 0o600);
    assert.equal(r.spawned[0].env.FOO, 'bar');
    assert.notEqual(r.spawned[0].env.PATH, '/evil');
    assert.match(output(c), /сервер MCP gone пропущен/);
    assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'))).includes('SECRET-W'), false);
    const cwd = path.join(r.home, '.cyborg', 'work', 'aaaaaaaa-1', 'a');
    const claudeJson = JSON.parse(fs.readFileSync(path.join(r.home, '.claude.json'), 'utf8'));
    assert.equal(claudeJson.projects[cwd].hasTrustDialogAccepted, true);
    assert.equal(fs.readFileSync(path.join(r.home, '.claude', 'projects', projectDirName(cwd), 'memory', 'MEMORY.md'), 'utf8'), '- запись');
    r.procs[0].exit(0);
    await until(() => !fs.existsSync(path.join(dir, 'mcp.json')));
  });
});
