import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { agentAuthEnv, gitAuthEnv, readAuth } from '../src/agentd/git-auth';
import { collectGitAuth, HOST_AGNOSTIC_TOKEN_ENV } from '../src/main/remote/auth';
import { ClaudeTokenStore, type TokenCrypt } from '../src/main/remote/claude-token';
import { createCliRunner, type CliRunner } from '../src/main/trackers';

const tmp = (t: { after: (fn: () => void) => void }): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-auth-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** git под чистым HOME: настройки машины разработчика не влияют на исход. */
const git = (home: string, env: Record<string, string>, args: string[], input?: string) =>
  spawnSync('git', args, {
    cwd: home,
    input,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...env },
  });

describe('gitAuthEnv на настоящем git', () => {
  const auth = readAuth({ git: [{ kind: 'gitlab', host: 'gl.example.com', token: 'glpat-ONE' }, { kind: 'github', host: 'github.com', token: 'gho_TWO' }], primary: 'gl.example.com' });

  it('git@ и ssh:// хоста идут по https', (t) => {
    const home = tmp(t);
    const env = gitAuthEnv(auth);
    assert.equal(git(home, env, ['ls-remote', '--get-url', 'git@gl.example.com:o/a.git']).stdout.trim(), 'https://gl.example.com/o/a.git');
    assert.equal(git(home, env, ['ls-remote', '--get-url', 'ssh://git@github.com/o/b.git']).stdout.trim(), 'https://github.com/o/b.git');
    assert.equal(git(home, env, ['ls-remote', '--get-url', 'git@other.example.com:o/c.git']).stdout.trim(), 'git@other.example.com:o/c.git', 'хост без токена не переписывается');
  });

  it('помощник учётных данных отдаёт токен своего хоста, а помощник из настроек хоста не спрашивается', (t) => {
    const home = tmp(t);
    fs.writeFileSync(path.join(home, '.gitconfig'), '[credential]\n\thelper = "!f() { echo username=u; echo password=WRONG; }; f"\n');
    const fill = (host: string) => git(home, gitAuthEnv(auth), ['credential', 'fill'], `protocol=https\nhost=${host}\n\n`).stdout;
    assert.match(fill('gl.example.com'), /^username=oauth2$/m);
    assert.match(fill('gl.example.com'), /^password=glpat-ONE$/m);
    assert.match(fill('github.com'), /^username=x-access-token$/m);
    assert.match(fill('github.com'), /^password=gho_TWO$/m);
    assert.match(fill('other.example.com'), /^password=WRONG$/m, 'чужой хост - прежние помощники');
  });

  it('gh получает токен github.com, glab - токен и хост рабочего репозитория; Claude - свой токен', () => {
    const env = agentAuthEnv({ ...auth, claude: 'sk-ant-oat01-XYZ' });
    assert.equal(env.GH_TOKEN, 'gho_TWO');
    assert.equal(env.GITLAB_TOKEN, 'glpat-ONE');
    assert.equal(env.GITLAB_HOST, 'https://gl.example.com');
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-XYZ');
    const two = gitAuthEnv(readAuth({ git: [{ kind: 'gitlab', host: 'a.example.com', token: 'A' }, { kind: 'gitlab', host: 'b.example.com', token: 'B' }], primary: 'b.example.com' }));
    assert.equal(two.GITLAB_HOST, 'https://b.example.com');
    assert.equal(two.GITLAB_TOKEN, 'B');
    const ghe = gitAuthEnv(readAuth({ git: [{ kind: 'github', host: 'ghe.example.com', token: 'E' }] }));
    assert.equal(ghe.GH_TOKEN, undefined);
    assert.equal(ghe.GH_ENTERPRISE_TOKEN, 'E');
    assert.equal(ghe.GH_HOST, undefined, 'репозиторий сессии не на этом хосте - gh выбирает хост сам');
    const primary = gitAuthEnv(readAuth({ git: [{ kind: 'github', host: 'a.example.com', token: 'A' }, { kind: 'github', host: 'b.example.com', token: 'B' }], primary: 'b.example.com' }));
    assert.equal(primary.GH_ENTERPRISE_TOKEN, 'B');
    assert.equal(primary.GH_HOST, 'b.example.com');
    assert.deepEqual(gitAuthEnv({ git: [] }), {});
  });
});

describe('readAuth', () => {
  it('отбрасывает токен с переводом строки, чужой вид, хост с путём и повтор хоста', () => {
    const auth = readAuth({
      git: [
        { kind: 'gitlab', host: 'a.example.com', token: 'ok' },
        { kind: 'gitlab', host: 'b.example.com', token: 'x\npassword=evil' },
        { kind: 'bitbucket', host: 'c.example.com', token: 'ok' },
        { kind: 'github', host: 'd.example.com/x', token: 'ok' },
        { kind: 'github', host: 'a.example.com', token: 'second' },
        'мусор',
      ],
      primary: 'a.example.com\n',
      claude: 'с пробелом токен',
    });
    assert.deepEqual(auth, { git: [{ kind: 'gitlab', host: 'a.example.com', token: 'ok' }] });
    assert.deepEqual(readAuth(undefined), { git: [] });
    assert.equal(readAuth({ git: Array.from({ length: 40 }, (_, i) => ({ kind: 'gitlab', host: `h${i}.example.com`, token: 't' })) }).git.length, 16);
  });
});

describe('collectGitAuth', () => {
  const runner = (answers: Record<string, string>, calls: string[]): CliRunner => async (cmd, args) => {
    const line = `${cmd} ${args.join(' ')}`;
    calls.push(line);
    const out = answers[line];
    return { code: out === undefined ? 1 : 0, stdout: out ?? '', stderr: '', missing: false };
  };

  it('github.com - у gh, прочий хост - у glab, затем у gh как GitHub Enterprise; хост без токена пропущен; каждый хост спрошен один раз', async () => {
    const calls: string[] = [];
    const creds = await collectGitAuth(
      ['git@github.com:o/a.git', 'https://github.com/o/b.git', 'git@gl.example.com:o/c.git', 'git@ghe.example.com:o/d.git', 'git@none.example.com:o/e.git', 'не адрес'],
      runner(
        {
          'gh auth token -h github.com': 'gho_A\n',
          'glab config get token -h gl.example.com': 'glpat-B\n',
          'gh auth token -h ghe.example.com': 'ghe_C\n',
        },
        calls,
      ),
    );
    assert.deepEqual(creds, [
      { kind: 'github', host: 'github.com', token: 'gho_A' },
      { kind: 'gitlab', host: 'gl.example.com', token: 'glpat-B' },
      { kind: 'github', host: 'ghe.example.com', token: 'ghe_C' },
    ]);
    assert.equal(calls.filter((c) => c.endsWith('-h github.com')).length, 1);
  });

  it('корневой токен glab для хоста без записи не уходит хосту, и хост доходит до gh как GitHub Enterprise', async () => {
    const creds = await collectGitAuth(
      ['git@ghe.example.com:o/d.git', 'git@gl.example.com:o/c.git'],
      runner(
        {
          'glab config get token -h ghe.example.com': 'ROOT\n',
          'glab config get token -h gl.example.com': 'glpat-B\n',
          'glab config get token -h cyborg-no-such-host.invalid': 'ROOT\n',
          'gh auth token -h ghe.example.com': 'ghe_C\n',
        },
        [],
      ),
    );
    assert.deepEqual(creds, [
      { kind: 'github', host: 'ghe.example.com', token: 'ghe_C' },
      { kind: 'gitlab', host: 'gl.example.com', token: 'glpat-B' },
    ]);
  });

  it('ответ с пробелом внутри не считается токеном', async () => {
    assert.deepEqual(await collectGitAuth(['git@github.com:o/a.git'], runner({ 'gh auth token -h github.com': 'not logged in\n' }, [])), []);
  });
});

describe('ClaudeTokenStore', () => {
  const TOKEN = 'sk-ant-oat01-' + 'a'.repeat(30);
  const crypt = (available: boolean, used: string[] = []): TokenCrypt => ({
    available: () => (used.push('available'), available),
    encrypt: (text) => Buffer.from('enc:' + [...text].reverse().join('')),
    decrypt: (data) => [...data.toString().slice(4)].reverse().join(''),
  });

  it('с шифрованием ОС - файл 0600 без открытого текста, новый экземпляр читает его; удаление стирает файл', (t) => {
    const file = path.join(tmp(t), 'token.bin');
    const used: string[] = [];
    const store = new ClaudeTokenStore(file, crypt(true, used));
    assert.deepEqual(used, [], 'safeStorage до ready приложения не трогается');
    assert.deepEqual(store.status(), { set: false, stored: null });
    assert.deepEqual(store.set(`  ${TOKEN}\n`), { set: true, stored: 'disk' });
    assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
    assert.equal(fs.readFileSync(file, 'utf8').includes(TOKEN), false);
    assert.equal(new ClaudeTokenStore(file, crypt(true)).get(), TOKEN);
    assert.deepEqual(store.clear(), { set: false, stored: null });
    assert.equal(fs.existsSync(file), false);
  });

  it('без шифрования ОС - только в памяти, прежний файл стёрт; неверный токен - отказ без изменений', (t) => {
    const file = path.join(tmp(t), 'token.bin');
    fs.writeFileSync(file, 'old');
    const store = new ClaudeTokenStore(file, crypt(false));
    assert.equal(store.get(), null);
    assert.deepEqual(store.set(TOKEN), { set: true, stored: 'memory' });
    assert.equal(fs.existsSync(file), false);
    assert.throws(() => store.set('короткий'), /claude setup-token/);
    assert.throws(() => store.set(`${TOKEN} ${TOKEN}`), /claude setup-token/);
    assert.equal(store.get(), TOKEN);
  });
});

describe('runner сбора доступов', () => {
  it('gh и glab не видят переменных токена, не привязанных к хосту: токен оператора не уходит хосту origin или маркетплейса', async (t) => {
    const names = [...HOST_AGNOSTIC_TOKEN_ENV, 'GH_TOKEN'];
    const saved = names.map((n) => [n, process.env[n]] as const);
    t.after(() => saved.forEach(([n, v]) => (v === undefined ? delete process.env[n] : (process.env[n] = v))));
    names.forEach((n) => (process.env[n] = `v-${n}`));
    // Вместо gh - node: проверяется окружение, которое runner отдаёт любой команде.
    const run = createCliRunner(os.tmpdir(), undefined, HOST_AGNOSTIC_TOKEN_ENV) as unknown as (cmd: string, args: string[]) => Promise<{ stdout: string }>;
    const res = await run(process.execPath, ['-e', `process.stdout.write(JSON.stringify(${JSON.stringify(names)}.map((n) => process.env[n] ?? null)))`]);
    assert.deepEqual(JSON.parse(res.stdout), [...HOST_AGNOSTIC_TOKEN_ENV.map(() => null), 'v-GH_TOKEN']);
    assert.equal(process.env.GITLAB_TOKEN, 'v-GITLAB_TOKEN', 'окружение самого Cyborg не тронуто');
  });
});
