import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { evaluate, loginPath, type EvalOptions } from '../src/main/env-eval';

const fakeBin = path.resolve('fixtures', 'fake-bin');
const home = fs.realpathSync(os.tmpdir());
const opts = (over: Partial<EvalOptions> = {}): EvalOptions => ({ env: { ENVT_A: 'from-env' }, home, path: process.env.PATH ?? '/usr/bin:/bin', signal: new AbortController().signal, ...over });
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitDead = async (pid: number): Promise<boolean> => {
  for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
  return !alive(pid);
};

describe('evaluate: значение', () => {
  it('stdout без одного завершающего перевода строки; внутренние переводы остаются', async () => {
    assert.deepEqual(await evaluate(String.raw`printf 'a\nb\n'`, opts()), { ok: true, value: 'a\nb' });
    assert.deepEqual(await evaluate(String.raw`printf 'a\n\n'`, opts()), { ok: true, value: 'a\n' });
    assert.deepEqual(await evaluate(String.raw`printf 'a\r\n'`, opts()), { ok: true, value: 'a' });
    assert.deepEqual(await evaluate(`printf 'no-newline'`, opts()), { ok: true, value: 'no-newline' });
  });

  it('окружение вычисления - переданное, PATH - переданный, cwd - домашний каталог, stdin - /dev/null', async () => {
    assert.deepEqual(await evaluate('echo "$ENVT_A"', opts()), { ok: true, value: 'from-env' });
    assert.deepEqual(await evaluate('echo "$PATH"', opts({ path: '/x:/y:/usr/bin:/bin' })), { ok: true, value: '/x:/y:/usr/bin:/bin' });
    assert.deepEqual(await evaluate('pwd -P', opts()), { ok: true, value: home });
    assert.deepEqual(await evaluate('cat; echo after-eof', opts()), { ok: true, value: 'after-eof' });
  });

  it('утилита из каталога PATH вычисления находится: подставной pass', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-pass-'));
    try {
      fs.mkdirSync(path.join(dir, 'claude-agent'));
      fs.writeFileSync(path.join(dir, 'claude-agent', 'oauth'), 'sk-ant-oat01-FAKE\n');
      const env = { FAKE_PASS_DIR: dir };
      assert.deepEqual(await evaluate('pass show claude-agent/oauth', opts({ env, path: `${fakeBin}:${process.env.PATH}` })), { ok: true, value: 'sk-ant-oat01-FAKE' });
      const miss = await evaluate('pass show nothing', opts({ env, path: `${fakeBin}:${process.env.PATH}` }));
      assert.equal(miss.ok, false);
      assert.match((miss as { stderr: string }).stderr, /not in the password store/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('evaluate: отказы', () => {
  it('ненулевой код - exit с хвостом stderr', async () => {
    const r = await evaluate('echo причина >&2; exit 3', opts());
    assert.deepEqual(r, { ok: false, reason: 'exit', stderr: 'причина\n' });
  });

  it('пустой вывод - empty; только перевод строки - тоже', async () => {
    assert.deepEqual(await evaluate('true', opts()), { ok: false, reason: 'empty', stderr: '' });
    assert.deepEqual(await evaluate('echo', opts()), { ok: false, reason: 'empty', stderr: '' });
  });

  it('NUL в выводе - nul', async () => {
    assert.deepEqual(await evaluate(String.raw`printf 'a\0b'`, opts()), { ok: false, reason: 'nul', stderr: '' });
  });

  it('вывод ровно 64 КиБ принят, на байт больше - overflow, процесс снят', async () => {
    const make = (n: number) => `head -c ${n} /dev/zero | tr '\\0' a`;
    const ok = await evaluate(make(64 * 1024), opts());
    assert.equal(ok.ok && ok.value.length, 64 * 1024);
    const over = await evaluate(make(64 * 1024 + 1), opts());
    assert.deepEqual(over, { ok: false, reason: 'overflow', stderr: '' });
  });

  it('предел вывода задаётся: больше - overflow, и поток не копится', async () => {
    const r = await evaluate("yes | head -c 100000", opts({ maxBytes: 50 }));
    assert.equal(r.ok === false && r.reason, 'overflow');
  });

  it('таймаут: timeout, а группа процессов снята целиком, в том числе фоновый потомок', async () => {
    const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-ev-')), 'pid');
    try {
      const started = Date.now();
      const r = await evaluate(`sleep 30 & echo $! > '${pidFile}'; wait`, opts({ timeoutMs: 200, killGraceMs: 100 }));
      assert.equal(r.ok === false && r.reason, 'timeout');
      assert.ok(Date.now() - started < 10_000);
      assert.equal(await waitDead(Number(fs.readFileSync(pidFile, 'utf8'))), true, 'фоновый sleep убит');
    } finally {
      fs.rmSync(path.dirname(pidFile), { recursive: true, force: true });
    }
  });

  it('оболочка, игнорирующая SIGTERM, добивается SIGKILL после паузы', async () => {
    const started = Date.now();
    const r = await evaluate("trap '' TERM; sleep 30", opts({ timeoutMs: 100, killGraceMs: 150 }));
    assert.equal(r.ok === false && r.reason, 'timeout');
    assert.ok(Date.now() - started < 10_000);
  });

  it('отмена сигналом: cancelled, процесс снят; уже отменённый сигнал - сразу', async () => {
    const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-ev-')), 'pid');
    try {
      const ac = new AbortController();
      const pending = evaluate(`echo $$ > '${pidFile}'; sleep 30`, opts({ signal: ac.signal, killGraceMs: 100 }));
      for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 20));
      ac.abort();
      assert.equal((await pending as { reason?: string }).reason, 'cancelled');
      assert.equal(await waitDead(Number(fs.readFileSync(pidFile, 'utf8').trim())), true);
      assert.equal(((await evaluate('echo x', opts({ signal: ac.signal }))) as { reason?: string }).reason, 'cancelled');
    } finally {
      fs.rmSync(path.dirname(pidFile), { recursive: true, force: true });
    }
  });

  it('фоновый остаток после выхода оболочки не задерживает ответ: группа снимается, значение отдано', async () => {
    const started = Date.now();
    const r = await evaluate('(sleep 30 >/dev/null 2>&1 &); echo ready', opts());
    assert.deepEqual(r, { ok: true, value: 'ready' });
    assert.ok(Date.now() - started < 10_000);
  });

  it('не запустилось - spawn с причиной, а не исключение', async () => {
    const boom = (() => {
      throw new Error('нет такой программы');
    }) as unknown as typeof import('node:child_process').spawn;
    assert.deepEqual(await evaluate('x', opts({ spawn: boom })), { ok: false, reason: 'spawn', stderr: 'нет такой программы' });
  });

  it('хвост stderr ограничен 4 КиБ', async () => {
    const r = await evaluate("head -c 20000 /dev/zero | tr '\\0' e >&2; exit 1", opts());
    assert.equal(r.ok === false && r.stderr.length, 4096);
  });
});

describe('loginPath', () => {
  it('PATH логин-оболочки: последняя строка с «/» из её вывода', async () => {
    const env = { PATH: '/usr/bin:/bin', HOME: home, FAKE_LOGIN_PATH: '/opt/login/bin:/usr/bin' };
    assert.equal(await loginPath(env, path.join(fakeBin, 'login-shell')), '/opt/login/bin:/usr/bin');
  });

  it('оболочка не отвечает или выходит с ошибкой - унаследованный PATH', async () => {
    const env = { PATH: '/usr/bin:/bin', HOME: home };
    assert.equal(await loginPath(env, '/nonexistent/shell'), '/usr/bin:/bin');
    assert.equal(await loginPath(env, '/bin/false'), '/usr/bin:/bin');
  });
});
