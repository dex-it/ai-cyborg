import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { useManagedEnv, type EnvPort, type Overlay } from '../src/main/child-env';
import { createClaudeRunner } from '../src/main/extensions';
import { filterOverrides, gitOriginUrl, gitRoot } from '../src/main/git';
import { gitGrep } from '../src/main/git-search';
import { openTarget, type OpenSpawn } from '../src/main/open-external';
import { systemClaudeAvailable } from '../src/main/passport';
import { systemSsh } from '../src/main/remote/ssh';
import { createCliRunner } from '../src/main/trackers';

const fakeBin = path.resolve('fixtures', 'fake-bin');
const overlay = (set: Record<string, string> = {}, unset: string[] = []): Overlay => ({ set: new Map(Object.entries(set)), unset: new Set(unset) });
const portOf = (o: Overlay, ready: Promise<void> = Promise.resolve()): EnvPort => ({ overlay: () => o, ready: () => ready, stamp: (remote) => ({ digests: new Map(), remote }), stale: () => [] });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

let dir: string;
let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-spawn-')));
  saved = { ...process.env };
  process.env.ENVT_INHERITED = 'from-parent';
  process.env.ENVT_PROBE_LOG = path.join(dir, 'probe.log');
});
afterEach(() => {
  useManagedEnv(null);
  for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
  Object.assign(process.env, saved);
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Подставная программа: пишет в журнал, что увидела в окружении и аргументах, и выполняет ответ. */
function probe(name: string, answer = ''): string {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nprintf '%s|%s|%s\\n' "$ENVT_SET" "\${ENVT_INHERITED-unset}" "$*" >> "$ENVT_PROBE_LOG"\n${answer}\n`, { mode: 0o755 });
  return bin;
}
const logged = (): string[] => (fs.existsSync(process.env.ENVT_PROBE_LOG as string) ? fs.readFileSync(process.env.ENVT_PROBE_LOG as string, 'utf8').trim().split('\n') : []);
const use = (bin: string, set: Record<string, string> = {}, unset: string[] = ['ENVT_INHERITED']) => useManagedEnv(portOf(overlay({ PATH: `${bin}:${process.env.PATH}`, ENVT_SET: 'managed', ...set }, unset)));

describe('процессы Cyborg получают управляемое окружение', () => {
  it('git: выбранное видно, снятое - нет, process.env не тронут', async () => {
    use(probe('git', `echo '${dir}'`));
    assert.equal(await gitRoot(dir), dir);
    assert.match(logged()[0], /^managed\|unset\|/);
    assert.equal(process.env.ENVT_INHERITED, 'from-parent');
    assert.equal(process.env.ENVT_SET, undefined);
  });

  it('git: управляемое GIT_CONFIG_COUNT не теряется при добавлении ключей фильтров', async () => {
    useManagedEnv(portOf(overlay({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'managed' })));
    execFileSync('git', ['init', '-q', dir]);
    execFileSync('git', ['-C', dir, 'config', 'filter.lfsx.clean', 'cat']);
    const env = await filterOverrides(dir);
    assert.equal(env.GIT_CONFIG_COUNT, '2', 'ключи фильтров добавлены после управляемого, а не поверх него');
    assert.equal(env.GIT_CONFIG_KEY_1, 'filter.lfsx.clean');
    assert.equal(env.GIT_CONFIG_KEY_0, undefined);
  });

  it('git grep: окружение поиска - то же управляемое', async () => {
    use(probe('git', 'exit 1'));
    await gitGrep({ root: dir, query: 'x', options: { regex: false, caseSensitive: false, wholeWord: false } } as never, new AbortController().signal).catch(() => undefined);
    assert.ok(logged().some((l) => l.startsWith('managed|unset|')), logged().join('\n'));
  });

  it('gh: управляемое видно, собственные GH_PROMPT_DISABLED и NO_COLOR сильнее, имена из dropEnv сняты даже если выбраны', async () => {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\necho "$GH_PROMPT_DISABLED|$NO_COLOR|\${ENVT_SET-unset}|\${GH_TOKEN-unset}"\n', { mode: 0o755 });
    use(bin, { GH_PROMPT_DISABLED: '0', NO_COLOR: '', GH_TOKEN: 'user-token' }, []);
    const r = await createCliRunner(dir, undefined, ['GH_TOKEN'])('gh', ['x']);
    assert.equal(r.stdout.trim(), '1|1|managed|unset');
  });

  it('claude plugin: оболочку выбирает унаследованный SHELL, а не выбранный; PATH управляемый', async () => {
    probe('claude', 'echo ran-claude');
    process.env.SHELL = path.join(fakeBin, 'shell');
    use(path.join(dir, 'bin'), { SHELL: '/nonexistent/managed-shell' });
    const r = await createClaudeRunner()(['plugin', 'list'], dir, 10_000);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /ran-claude/);
    assert.match(logged()[0], /^managed\|unset\|plugin list/);
  });

  it('проверка claude паспорта: оболочка унаследованная, claude ищется в управляемом PATH', async () => {
    process.env.SHELL = path.join(fakeBin, 'shell');
    useManagedEnv(portOf(overlay({ SHELL: '/nonexistent/managed-shell', PATH: `${path.join(dir, 'bin')}:/usr/bin:/bin` })));
    assert.equal(await systemClaudeAvailable(), false);
    probe('claude');
    assert.equal(await systemClaudeAvailable(), true);
  });

  it('ssh: управляемое окружение видно клиенту, SSH_ASKPASS_REQUIRE=never сильнее', async () => {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'ssh'), '#!/bin/sh\ncat >/dev/null\necho "$ENVT_SET|$SSH_ASKPASS_REQUIRE"\n', { mode: 0o755 });
    use(bin, { SSH_ASKPASS_REQUIRE: 'force' });
    const r = await systemSsh.run('alias', 'true');
    assert.equal(r.stdout.trim(), 'managed|never');
  });
});

describe('запуск ждёт готовности окружения', () => {
  it('git не стартует, пока вычисляются выражения при старте Cyborg', async () => {
    let release!: () => void;
    useManagedEnv(portOf(overlay({ PATH: `${probe('git', `echo '${dir}'`)}:${process.env.PATH}`, ENVT_SET: 'late' }), new Promise<void>((r) => (release = r))));
    const pending = gitOriginUrl(dir);
    await pause(80);
    assert.deepEqual(logged(), []);
    release();
    await pending;
    assert.match(logged()[0], /^late\|/);
  });

  it('gh ждёт готовности', async () => {
    let release!: () => void;
    const bin = probe('gh', 'echo out');
    useManagedEnv(portOf(overlay({ PATH: `${bin}:${process.env.PATH}`, ENVT_SET: 'late' }), new Promise<void>((r) => (release = r))));
    const pending = createCliRunner(dir)('gh', []);
    await pause(80);
    assert.deepEqual(logged(), []);
    release();
    assert.equal((await pending).code, 0);
    assert.match(logged()[0], /^late\|/);
  });
});

describe('openTarget: открытие адреса и файла системной программой', () => {
  type Call = { command: string; args: string[]; env: NodeJS.ProcessEnv };
  const fakeSpawn = (calls: Call[], failWith?: string, exitCode: number | null = 0): OpenSpawn => (command, args, options) => {
    calls.push({ command, args, env: options.env });
    const handlers: Record<string, (arg?: any) => void> = {};
    setImmediate(() => {
      if (failWith) return handlers.error?.(Object.assign(new Error(failWith), { code: failWith }));
      handlers.spawn?.();
      if (exitCode !== null) setImmediate(() => handlers.exit?.(exitCode));
    });
    return { once: (event: string, cb: (arg?: any) => void) => void (handlers[event] = cb), unref() {} } as never;
  };

  it('Linux: xdg-open с управляемым окружением, адрес отдельным аргументом', async () => {
    useManagedEnv(portOf(overlay({ BROWSER: 'managed-browser' }, ['ENVT_INHERITED'])));
    const calls: Call[] = [];
    assert.equal(await openTarget('https://example.com/a b', { platform: 'linux', spawn: fakeSpawn(calls), fallback: async () => 'не должно вызываться' }), '');
    assert.equal(calls[0].command, 'xdg-open');
    assert.deepEqual(calls[0].args, ['https://example.com/a b']);
    assert.equal(calls[0].env.BROWSER, 'managed-browser');
    assert.equal('ENVT_INHERITED' in calls[0].env, false);
  });

  it('macOS: open; программа не найдена (ENOENT) - открытие средствами Electron, его ответ возвращается', async () => {
    const calls: Call[] = [];
    const seen: string[] = [];
    const reason = await openTarget('/tmp/x', { platform: 'darwin', spawn: fakeSpawn(calls, 'ENOENT'), fallback: async (t) => (seen.push(t), 'fallback-ответ') });
    assert.equal(calls[0].command, 'open');
    assert.deepEqual(seen, ['/tmp/x']);
    assert.equal(reason, 'fallback-ответ');
  });

  it('иная ошибка запуска - её причина без запасного пути; исключение spawn - тоже причина', async () => {
    assert.equal(await openTarget('x', { platform: 'linux', spawn: fakeSpawn([], 'EACCES'), fallback: async () => 'fb' }), 'EACCES');
    const boom: OpenSpawn = () => {
      throw new Error('не запустить');
    };
    assert.equal(await openTarget('x', { platform: 'linux', spawn: boom, fallback: async () => 'fb' }), 'не запустить');
  });

  it('открыватель вышел с ненулевым кодом - отказ с кодом; нулевой - открыто; не вышел за срок - открыто', async () => {
    assert.equal(await openTarget('x', { platform: 'linux', spawn: fakeSpawn([], undefined, 3), fallback: async () => 'fb' }), 'xdg-open завершился с кодом 3');
    assert.equal(await openTarget('x', { platform: 'darwin', spawn: fakeSpawn([], undefined, 1), fallback: async () => 'fb' }), 'open завершился с кодом 1');
    assert.equal(await openTarget('x', { platform: 'linux', spawn: fakeSpawn([], undefined, 0), fallback: async () => 'fb' }), '');
    assert.equal(await openTarget('x', { platform: 'linux', spawn: fakeSpawn([], undefined, null), exitWaitMs: 20, fallback: async () => 'fb' }), '');
  });

  it('платформа без xdg-open и open - сразу запасной путь', async () => {
    assert.equal(await openTarget('x', { platform: 'win32', fallback: async () => 'win' }), 'win');
  });

  it('открытие ждёт готовности окружения', async () => {
    let release!: () => void;
    useManagedEnv(portOf(overlay({ BROWSER: 'late' }), new Promise<void>((r) => (release = r))));
    const calls: Call[] = [];
    const pending = openTarget('x', { platform: 'linux', spawn: fakeSpawn(calls), fallback: async () => '' });
    await pause(50);
    assert.equal(calls.length, 0);
    release();
    await pending;
    assert.equal(calls[0].env.BROWSER, 'late');
  });
});
