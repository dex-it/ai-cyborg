import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AllowedPaths } from '../src/main/allowed-paths';
import type { ClaudeResult, ClaudeRunner } from '../src/main/extensions';
import { actionArgs, actionMessage, createActionRunner, validateAction } from '../src/main/extensions-act';
import { createExtensionsHandlers } from '../src/main/extensions-handlers';
import { marketplaceSourceProblem } from '../src/shared/extensions';

const result = (over: Partial<ClaudeResult>): ClaudeResult => ({ code: 0, stdout: '', stderr: '', missing: false, timedOut: false, ...over });

describe('validateAction', () => {
  it('принимает установку, удаление, подключение и отключение магазина', () => {
    assert.deepEqual(validateAction({ kind: 'install', plugin: 'pa@mk', scope: 'user' }), { kind: 'install', plugin: 'pa@mk', scope: 'user' });
    assert.deepEqual(validateAction({ kind: 'uninstall', plugin: 'a.b-c@m_k', scope: 'local', dir: '/r' }), { kind: 'uninstall', plugin: 'a.b-c@m_k', scope: 'local', dir: '/r' });
    assert.deepEqual(validateAction({ kind: 'marketplace-add', source: ' owner/repo ', scope: 'project', dir: '/r' }), { kind: 'marketplace-add', source: 'owner/repo', scope: 'project', dir: '/r' });
    assert.deepEqual(validateAction({ kind: 'marketplace-remove', name: 'mk' }), { kind: 'marketplace-remove', name: 'mk' });
  });

  it('отказывает: флаг вместо имени, чужая область, каталог не к месту, лишнее', () => {
    const bad: unknown[] = [
      null,
      'install',
      { kind: 'install', plugin: '--scope@x', scope: 'user' },
      { kind: 'install', plugin: 'pa', scope: 'user' },
      { kind: 'install', plugin: 'pa@mk', scope: 'managed' },
      { kind: 'install', plugin: 'pa@mk', scope: 'local' },
      { kind: 'install', plugin: 'pa@mk', scope: 'user', dir: '/r' },
      { kind: 'install', plugin: 'pa@mk', scope: 'project', dir: 5 },
      { kind: 'marketplace-add', source: '--scope', scope: 'user' },
      { kind: 'marketplace-add', source: 'http://x.io/m', scope: 'user' },
      { kind: 'marketplace-remove', name: '-rf' },
      { kind: 'marketplace-remove', name: 'a b' },
      { kind: 'rm', plugin: 'pa@mk', scope: 'user' },
    ];
    for (const value of bad) assert.equal(validateAction(value), null, JSON.stringify(value));
  });
});

describe('marketplaceSourceProblem', () => {
  it('репозиторий, https, ssh и абсолютный путь допустимы; флаги, http, логин в адресе и «..» - нет', () => {
    for (const ok of ['owner/repo', 'https://git.example.com/a/b.git', 'git@github.com:o/r.git', '/srv/market']) assert.equal(marketplaceSourceProblem(ok), null, ok);
    for (const bad of ['', ' ', '-x', '--add', 'http://x.io', 'https://u:p@x.io/m', '/a/../b', 'file:///etc', 'a b', 'x'.repeat(501), 'a\nb']) assert.notEqual(marketplaceSourceProblem(bad), null, JSON.stringify(bad));
  });
});

describe('actionArgs', () => {
  it('значения идут отдельными аргументами и с явной областью', () => {
    assert.deepEqual(actionArgs({ kind: 'install', plugin: 'pa@mk', scope: 'project', dir: '/r' }), ['plugin', 'install', 'pa@mk', '--scope', 'project', '--json']);
    assert.deepEqual(actionArgs({ kind: 'uninstall', plugin: 'pa@mk', scope: 'user' }), ['plugin', 'uninstall', 'pa@mk', '--scope', 'user', '--json']);
    assert.deepEqual(actionArgs({ kind: 'marketplace-add', source: 'o/r', scope: 'user' }), ['plugin', 'marketplace', 'add', 'o/r', '--scope', 'user', '--json']);
    assert.deepEqual(actionArgs({ kind: 'marketplace-remove', name: 'mk' }), ['plugin', 'marketplace', 'remove', 'mk']);
  });

  it('подтверждение чужой команды установки не передаётся никогда', () => {
    for (const kind of ['install', 'uninstall'] as const) {
      const args = actionArgs({ kind, plugin: 'pa@mk', scope: 'user' });
      assert.ok(!args.includes('-y') && !args.includes('--yes') && !args.includes('--accept-command'));
    }
  });
});

describe('actionMessage', () => {
  it('итоговая JSON-строка: исход и сообщение', () => {
    assert.deepEqual(actionMessage('шум\n{"outcome":"ok","message":"Установлен"}\n', ''), { ok: true, message: 'Установлен' });
    assert.deepEqual(actionMessage('{"outcome":"failed","message":"Не найден"}', '✘ x'), { ok: false, message: 'Не найден' });
  });

  it('без JSON - первые строки вывода без значков', () => {
    assert.deepEqual(actionMessage('✔ Successfully removed marketplace: mk\nAlso uninstalled 1 plugins\n', ''), { ok: null, message: 'Successfully removed marketplace: mk. Also uninstalled 1 plugins' });
    assert.equal(actionMessage('', '✘ boom').message, 'boom');
  });
});

describe('createActionRunner', () => {
  it('запускает claude в каталоге репозитория (для области user - в нейтральном) и возвращает ответ', async () => {
    const seen: string[] = [];
    const run: ClaudeRunner = async (args, cwd) => (seen.push(`${args[1]}@${cwd}`), result({ stdout: '{"outcome":"ok","message":"Готово"}' }));
    const act = createActionRunner(run, '/neutral');
    assert.deepEqual(await act({ kind: 'install', plugin: 'p@m', scope: 'local', dir: '/repo' }), { ok: true, message: 'Готово' });
    await act({ kind: 'uninstall', plugin: 'p@m', scope: 'user' });
    assert.deepEqual(seen, ['install@/repo', 'uninstall@/neutral']);
  });

  it('отказ claude - ok: false с его сообщением; нет claude и таймаут - понятный текст', async () => {
    const fail = createActionRunner(async () => result({ code: 1, stdout: '{"outcome":"failed","message":"Не найден"}' }), '/n');
    assert.deepEqual(await fail({ kind: 'install', plugin: 'p@m', scope: 'user' }), { ok: false, message: 'Не найден' });
    assert.match((await createActionRunner(async () => result({ missing: true, code: null }), '/n')({ kind: 'marketplace-remove', name: 'm' })).message, /не найден/);
    assert.match((await createActionRunner(async () => result({ timedOut: true, code: null }), '/n')({ kind: 'marketplace-remove', name: 'm' })).message, /3 минуты/);
  });

  it('второе действие во время первого отклоняется', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const act = createActionRunner(async () => (await gate, result({ stdout: '{"outcome":"ok","message":"ок"}' })), '/n');
    const first = act({ kind: 'marketplace-remove', name: 'a' });
    assert.deepEqual(await act({ kind: 'marketplace-remove', name: 'b' }), { ok: false, message: 'Другое действие ещё выполняется' });
    release();
    assert.equal((await first).ok, true);
    assert.equal((await act({ kind: 'marketplace-remove', name: 'c' })).ok, true, 'после завершения снова можно');
  });
});

describe('обработчики каналов расширений', () => {
  const calls: string[] = [];
  const handlers = createExtensionsHandlers({
    allowed: new AllowedPaths(() => ['/repo']),
    load: async (dirs) => (calls.push(`load:${dirs.join(',')}`), { claude: {}, marketplaces: [], plugins: [], standalone: [], mcp: [], problems: [] }),
    probe: async (dir) => (calls.push(`probe:${dir}`), { entries: [] }),
    act: async (action) => (calls.push(`act:${action.kind}`), { ok: true, message: '' }),
    hubs: { list: () => [], apply: () => [], find: (id) => (id === 'anthropic' ? { id: 'anthropic', name: 'b', url: null, enabled: true, builtin: true } : undefined) },
    fetchHub: async (_hub, force) => ({ entries: [], ...(force ? { skipped: 1 } : {}) }),
    usage: async () => ({ calls: {}, files: 0 }),
  });

  it('читает только разрешённые каталоги, повторы отбрасывает', async () => {
    await handlers.load({ dirs: ['/repo', '/repo/sub', '/repo'] });
    assert.deepEqual(calls.pop(), 'load:/repo,/repo/sub');
    await assert.rejects(async () => handlers.load({ dirs: ['/etc'] }), /вне репозиториев/);
    await assert.rejects(async () => handlers.load({ dirs: ['/repo/../etc'] }), /вне репозиториев/);
    await assert.rejects(async () => handlers.load({ dirs: 'x' }), /аргументы/);
    await assert.rejects(async () => handlers.load({ dirs: Array.from({ length: 33 }, () => '/repo') }), /аргументы/);
    await assert.rejects(async () => handlers.load(null), /аргументы/);
  });

  it('проверка связи: null - нейтральный каталог, иначе только разрешённый', async () => {
    await handlers.probe(null);
    await handlers.probe('/repo');
    assert.deepEqual(calls.splice(-2), ['probe:null', 'probe:/repo']);
    await assert.rejects(async () => handlers.probe('/etc'), /вне репозиториев/);
  });

  it('действие: форма, затем каталог; до claude не доходит ничего лишнего', async () => {
    calls.length = 0;
    await assert.rejects(async () => handlers.act({ kind: 'install', plugin: '-x@y', scope: 'user' }), /Некорректное действие/);
    await assert.rejects(async () => handlers.act({ kind: 'install', plugin: 'p@m', scope: 'local', dir: '/etc' }), /вне репозиториев/);
    assert.deepEqual(calls, []);
    await handlers.act({ kind: 'install', plugin: 'p@m', scope: 'local', dir: '/repo' });
    assert.deepEqual(calls, ['act:install']);
  });

  it('содержимое хаба - только известного хаба', async () => {
    assert.deepEqual(await handlers.hubFetch('anthropic'), { entries: [] });
    assert.deepEqual(await handlers.hubFetch('anthropic', true), { entries: [], skipped: 1 });
    assert.deepEqual(await handlers.hubFetch('anthropic', 'да'), { entries: [] }, 'force - только булево');
    await assert.rejects(async () => handlers.hubFetch('нет'), /нет/);
  });
});
