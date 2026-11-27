import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { composeEnv } from '../src/main/child-env';
import type { EvalResult } from '../src/main/env-eval';
import { ManagedEnv, OWN_NAMES_LOCAL, OWN_NAMES_REMOTE, ownNotes, reservedName } from '../src/main/managed-env';
import { ID, expr, literal, managed, selected } from './env-rig';

const mode = (p: string) => fs.statSync(p).mode & 0o777;
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const fakeBin = path.resolve('fixtures', 'fake-bin');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 3000) => {
  for (let i = 0; i < ms / 10 && !cond(); i++) await sleep(10);
  assert.ok(cond(), 'условие не наступило');
};
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Хранилище подставного pass на временном каталоге и менеджер, который вычисляет выражения настоящей оболочкой с ним. */
function withPass(t: { after: (fn: () => void) => void }, secrets: Record<string, string>, defs: Parameters<typeof managed>[1], over: Partial<ConstructorParameters<typeof ManagedEnv>[0]> = {}) {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-store-'));
  t.after(() => fs.rmSync(store, { recursive: true, force: true }));
  for (const [name, value] of Object.entries(secrets)) {
    fs.mkdirSync(path.dirname(path.join(store, name)), { recursive: true });
    fs.writeFileSync(path.join(store, name), value + '\n');
  }
  const log = path.join(store, 'calls.log');
  const rig = managed(t, defs, {
    loginPath: async () => `${fakeBin}:${process.env.PATH}`,
    inherited: () => ({ ENVT_INHERITED: 'from-parent', FAKE_PASS_DIR: store, FAKE_PASS_LOG: log, PATH: process.env.PATH }),
    ...over,
  });
  return { ...rig, store, log, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) };
}

describe('ManagedEnv: чтение файла', () => {
  it('нет файла - пустое состояние без ошибок', (t) => {
    const { env } = managed(t);
    assert.deepEqual(env.view(), { vars: [], problems: [], starting: false });
    assert.equal(env.overlay().set.size + env.overlay().unset.size, 0);
  });

  it('имена для подсказки: унаследованные по алфавиту, без заведённых, служебных и негодных', (t) => {
    const { env } = managed(t, [{ name: 'ENVT_LIT', candidates: [literal(1, 'v')] }], {
      inherited: () => ({ ZED: 'secret', ENVT_LIT: 'x', CYBORG_CWD: '/tmp', 'BAD-NAME': '1', ALPHA: 'a' }),
    });
    assert.deepEqual(env.inheritedNames(), ['ALPHA', 'ZED']);
  });

  it('выбранный литерал действует сразу после запуска, снятая - тоже, не тронутая и выбранное выражение - нет', (t) => {
    const { env } = managed(t, [
      { name: 'ENVT_LIT', candidates: [literal(1, 'v')], choice: selected(1) },
      { name: 'ENVT_GONE', choice: { kind: 'unset' } },
      { name: 'ENVT_IDLE', candidates: [literal(1, 'x')] },
      { name: 'ENVT_EXPR', candidates: [expr(1, 'echo hi')], choice: selected(1) },
    ]);
    assert.deepEqual([...env.overlay().set], [['ENVT_LIT', 'v']]);
    assert.deepEqual([...env.overlay().unset], ['ENVT_GONE']);
    const view = Object.fromEntries(env.view().vars.map((v) => [v.name, v.unapplied]));
    assert.deepEqual(view, { ENVT_LIT: false, ENVT_GONE: false, ENVT_IDLE: false, ENVT_EXPR: true });
  });

  it('негодные записи пропускаются с причиной, годные остаются: служебное имя, плохое имя, повтор, NUL, чужой вид', (t) => {
    const { env, file } = managed(t);
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        vars: [
          { name: 'CLAUDECODE', candidates: [], choice: { kind: 'unset' } },
          { name: 'CYBORG_X', candidates: [] },
          { name: '1bad', candidates: [] },
          { name: 'ENVT_OK', candidates: [literal(1, 'ok')], choice: selected(1) },
          { name: 'ENVT_OK', candidates: [] },
          { name: 'ENVT_NUL', candidates: [{ id: ID(1), kind: 'literal', value: 'a\0b' }] },
          { name: 'ENVT_KIND', candidates: [{ id: ID(1), kind: 'file', path: '/x' }] },
          'мусор',
        ],
      }),
    );
    const reread = new ManagedEnv({ file, home: os.tmpdir(), loginPath: async () => '' });
    assert.deepEqual(reread.view().vars.map((v) => v.name), ['ENVT_OK']);
    assert.equal(reread.view().problems.length, 7);
    assert.ok(reread.view().problems.some((p) => /служебное имя/.test(p)));
    assert.ok(env);
  });

  it('повреждённый файл: копия 0600 рядом, причина названа, файл на месте до сохранения; после сохранения упрёка нет', (t) => {
    const { env, file, dir } = managed(t);
    fs.writeFileSync(file, '{ не json');
    const broken = new ManagedEnv({ file, home: dir, loginPath: async () => '' });
    assert.match(broken.view().problems[0], /повреждён/);
    const copies = fs.readdirSync(dir).filter((f) => f.startsWith('env-vars.json.corrupt-'));
    assert.equal(copies.length, 1);
    assert.equal(mode(path.join(dir, copies[0])), 0o600);
    assert.equal(fs.readFileSync(file, 'utf8'), '{ не json');
    broken.save([{ name: 'ENVT_A', candidates: [] }]);
    assert.deepEqual(broken.view().problems, []);
    assert.equal(read(file).vars[0].name, 'ENVT_A');
    assert.ok(env);
  });

  it('файл больше 8 МиБ не читается целиком: копия и причина', (t) => {
    const { file, dir } = managed(t);
    fs.writeFileSync(file, Buffer.alloc(8 * 1024 * 1024 + 1, 32));
    const big = new ManagedEnv({ file, home: dir, loginPath: async () => '' });
    assert.match(big.view().problems[0], /повреждён/);
    assert.equal(big.view().vars.length, 0);
  });

  it('файл не из объекта с vars - причина, а не исключение', (t) => {
    const { file, dir } = managed(t);
    fs.writeFileSync(file, '[1,2]');
    assert.match(new ManagedEnv({ file, home: dir, loginPath: async () => '' }).view().problems[0], /нет списка vars/);
  });
});

describe('ManagedEnv: выбор', () => {
  it('литерал: выбор сразу в overlay и в файле 0600, временных файлов не остаётся', async (t) => {
    const { env, file, dir } = managed(t, [{ name: 'ENVT_A', candidates: [literal(1, 'one'), literal(2, 'two')] }]);
    assert.deepEqual(await env.select('ENVT_A', ID(2)), { ok: true });
    assert.equal(env.overlay().set.get('ENVT_A'), 'two');
    assert.deepEqual(read(file).vars[0].choice, { kind: 'selected', candidate: ID(2) });
    assert.equal(mode(file), 0o600);
    assert.deepEqual(fs.readdirSync(dir), ['env-vars.json']);
  });

  it('выражение: значение из вывода команды, в файле его нет, повторный выбор вычисляет заново', async (t) => {
    const { env, file, calls, store } = withPass(t, { 'claude-agent/oauth': 'sk-ant-oat01-SECRET' }, [{ name: 'CLAUDE_CODE_OAUTH_TOKEN', candidates: [expr(1, 'pass show claude-agent/oauth')] }]);
    assert.deepEqual(await env.select('CLAUDE_CODE_OAUTH_TOKEN', ID(1)), { ok: true });
    assert.equal(env.overlay().set.get('CLAUDE_CODE_OAUTH_TOKEN'), 'sk-ant-oat01-SECRET');
    assert.equal(fs.readFileSync(file, 'utf8').includes('SECRET'), false, 'значение выражения на диск не пишется');
    fs.writeFileSync(path.join(store, 'claude-agent', 'oauth'), 'sk-ant-oat01-ROTATED\n');
    await env.select('CLAUDE_CODE_OAUTH_TOKEN', ID(1));
    assert.equal(env.overlay().set.get('CLAUDE_CODE_OAUTH_TOKEN'), 'sk-ant-oat01-ROTATED');
    assert.equal(calls().length, 2);
  });

  it('вычисление идёт с окружением Cyborg и управляемым поверх него, а не с одним process.env', async (t) => {
    const { env } = withPass(t, {}, [
      { name: 'ENVT_BASE', candidates: [literal(1, 'managed-base')], choice: selected(1) },
      { name: 'ENVT_DERIVED', candidates: [expr(1, 'echo "$ENVT_BASE+$ENVT_INHERITED"')] },
    ]);
    await env.select('ENVT_DERIVED', ID(1));
    assert.equal(env.overlay().set.get('ENVT_DERIVED'), 'managed-base+from-parent');
  });

  it('неудача: прежнее состояние сохранено, причина в статусе, вывод ошибки - только по запросу, значения нет', async (t) => {
    const { env, file } = withPass(t, {}, [{ name: 'ENVT_T', candidates: [literal(1, 'keep'), expr(2, 'pass show missing/entry')], choice: selected(1) }]);
    const before = fs.readFileSync(file, 'utf8');
    const r = await env.select('ENVT_T', ID(2));
    assert.equal(r.ok, false);
    assert.equal(env.overlay().set.get('ENVT_T'), 'keep');
    const v = env.view().vars[0];
    assert.deepEqual(v.choice, { kind: 'selected', candidate: ID(1) });
    assert.equal(v.status.kind, 'failed');
    assert.deepEqual(v.status, { kind: 'failed', reason: 'команда завершилась с ошибкой', output: true });
    assert.deepEqual(r, { ok: false, reason: 'exit' });
    assert.match(env.failureOutput('ENVT_T') ?? '', /not in the password store/);
    assert.throws(() => env.failureOutput('ENVT_NONE'), /Переменной нет в списке/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  });

  it('неудача у не тронутой: она остаётся не тронутой, процессы получают унаследованное', async (t) => {
    const { env } = withPass(t, {}, [{ name: 'ENVT_T', candidates: [expr(1, 'exit 4')] }]);
    await env.select('ENVT_T', ID(1));
    assert.deepEqual(env.view().vars[0].choice, { kind: 'untouched' });
    assert.equal(env.overlay().set.size, 0);
  });

  it('следующий успешный выбор снимает статус ошибки', async (t) => {
    const { env } = withPass(t, {}, [{ name: 'ENVT_T', candidates: [expr(1, 'exit 4'), literal(2, 'ok')] }]);
    await env.select('ENVT_T', ID(1));
    assert.equal(env.view().vars[0].status.kind, 'failed');
    await env.select('ENVT_T', ID(2));
    assert.equal(env.view().vars[0].status.kind, 'idle');
  });

  it('выбор несуществующих имени и кандидата - отказ без записи', async (t) => {
    const { env, file } = managed(t, [{ name: 'ENVT_A', candidates: [literal(1, 'x')] }]);
    const before = fs.readFileSync(file, 'utf8');
    await assert.rejects(env.select('ENVT_NOPE', ID(1)), /нет в списке/);
    await assert.rejects(env.select('ENVT_A', ID(9)), /Кандидата нет/);
    await assert.rejects(env.select({}, ID(1)), /нет в списке/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  });

  it('идущее вычисление в статусе evaluating, onChange сообщает о начале и конце', async (t) => {
    const { env, changes } = withPass(t, {}, [{ name: 'ENVT_S', candidates: [expr(1, 'sleep 0.3; echo done')] }]);
    const pending = env.select('ENVT_S', ID(1));
    await until(() => env.view().vars[0].status.kind === 'evaluating');
    assert.ok(changes.length >= 1);
    await pending;
    assert.equal(env.view().vars[0].status.kind, 'idle');
    assert.equal(env.overlay().set.get('ENVT_S'), 'done');
  });

  it('статус evaluating называет вычисляемого кандидата: при выборе человека и при старте', async (t) => {
    const { env } = withPass(t, {}, [{ name: 'ENVT_S', candidates: [expr(1, 'sleep 0.3; echo a'), expr(2, 'sleep 0.3; echo b')], choice: selected(1) }]);
    const ready = env.start();
    assert.deepEqual(env.view().vars[0].status, { kind: 'evaluating', candidate: ID(1) });
    await ready;
    const pending = env.select('ENVT_S', ID(2));
    await until(() => env.view().vars[0].status.kind === 'evaluating');
    assert.deepEqual(env.view().vars[0].status, { kind: 'evaluating', candidate: ID(2) });
    await pending;
  });

  it('последнее действие побеждает: выбор литерала во время вычисления отменяет его, результат вычисления состояния не меняет', async (t) => {
    const { env } = withPass(t, {}, [{ name: 'ENVT_S', candidates: [expr(1, 'sleep 5; echo late'), literal(2, 'now')] }]);
    const slow = env.select('ENVT_S', ID(1));
    await until(() => env.view().vars[0].status.kind === 'evaluating');
    assert.deepEqual(await env.select('ENVT_S', ID(2)), { ok: true });
    const result = await slow;
    assert.equal(result.ok === false && result.reason, 'cancelled');
    assert.equal(env.overlay().set.get('ENVT_S'), 'now');
    assert.deepEqual(env.view().vars[0].choice, { kind: 'selected', candidate: ID(2) });
  });

  it('cancel: вычисление снято вместе с процессами, прежнее состояние осталось, статус - отменено', async (t) => {
    const pidFile = path.join(os.tmpdir(), `cyborg-cancel-${process.pid}-${Date.now()}`);
    t.after(() => fs.rmSync(pidFile, { force: true }));
    const { env } = withPass(t, {}, [{ name: 'ENVT_S', candidates: [literal(1, 'keep'), expr(2, `echo $$ > '${pidFile}'; sleep 30`)], choice: selected(1) }], { evalOptions: { killGraceMs: 100 } });
    const pending = env.select('ENVT_S', ID(2));
    await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '');
    env.cancel('ENVT_S');
    const r = await pending;
    assert.equal(r.ok === false && r.reason, 'cancelled');
    const v = env.view().vars[0];
    assert.equal(v.status.kind, 'failed');
    assert.match((v.status as { reason: string }).reason, /отменено/);
    assert.equal(env.overlay().set.get('ENVT_S'), 'keep');
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    await until(() => !alive(pid), 5000);
  });

  it('cancel без вычисления ничего не меняет', (t) => {
    const { env, changes } = managed(t, [{ name: 'ENVT_A', candidates: [literal(1, 'x')] }]);
    env.cancel('ENVT_A');
    assert.equal(changes.length, 0);
  });

  it('таймаут вычисления - статус с причиной, состояние прежнее', async (t) => {
    const { env } = withPass(t, {}, [{ name: 'ENVT_S', candidates: [expr(1, 'sleep 30')] }], { evalOptions: { timeoutMs: 100, killGraceMs: 50 } });
    const r = await env.select('ENVT_S', ID(1));
    assert.equal(r.ok === false && r.reason, 'timeout');
    assert.match((env.view().vars[0].status as { reason: string }).reason, /60 с/);
  });
});

describe('ManagedEnv: снять, не трогать, удалить', () => {
  it('снять: имя без кандидатов заводится, унаследованное значение у процессов исчезает', (t) => {
    const { env, file } = managed(t);
    env.unset('ENVT_INHERITED');
    assert.deepEqual(read(file).vars, [{ name: 'ENVT_INHERITED', candidates: [], choice: { kind: 'unset' } }]);
    const composed = composeEnv({ ENVT_INHERITED: 'from-parent', KEEP: 'k' }, env.overlay());
    assert.deepEqual(composed, { KEEP: 'k' });
  });

  it('снять выбранную: значение забыто, кандидаты на месте; «не трогать» возвращает унаследованное', async (t) => {
    const { env } = managed(t, [{ name: 'ENVT_A', candidates: [literal(1, 'v')], choice: selected(1) }]);
    env.unset('ENVT_A');
    assert.equal(env.overlay().set.has('ENVT_A'), false);
    assert.equal(env.overlay().unset.has('ENVT_A'), true);
    assert.equal(env.view().vars[0].candidates.length, 1);
    env.untouch('ENVT_A');
    assert.equal(env.overlay().unset.has('ENVT_A'), false);
    assert.deepEqual(env.view().vars[0].choice, { kind: 'untouched' });
  });

  it('снять служебное имя и неверное имя - отказ без записи', (t) => {
    const { env, file } = managed(t);
    assert.throws(() => env.unset('CLAUDECODE'), /служебное имя/);
    assert.throws(() => env.unset('CYBORG_MCP'), /служебное имя/);
    assert.throws(() => env.unset('bad name'), /Некорректное имя/);
    assert.throws(() => env.unset(5), /Некорректное имя/);
    assert.equal(fs.existsSync(file), false);
  });

  it('удалить: имя уходит из списка и из overlay, вычисление снято', async (t) => {
    const { env, file } = managed(t, [{ name: 'ENVT_A', candidates: [literal(1, 'v')], choice: selected(1) }]);
    env.remove('ENVT_A');
    assert.deepEqual(read(file).vars, []);
    assert.equal(env.overlay().set.size, 0);
    assert.throws(() => env.remove('ENVT_A'), /нет в списке/);
  });

  it('снятие во время вычисления отменяет его', async (t) => {
    const { env } = withPass(t, {}, [{ name: 'ENVT_S', candidates: [expr(1, 'sleep 30')] }], { evalOptions: { killGraceMs: 50 } });
    const pending = env.select('ENVT_S', ID(1));
    await until(() => env.view().vars[0].status.kind === 'evaluating');
    env.unset('ENVT_S');
    assert.equal((await pending).ok, false);
    assert.deepEqual(env.view().vars[0].choice, { kind: 'unset' });
    assert.equal(env.view().vars[0].status.kind, 'idle');
  });

  it('сбой записи на диск: исключение, состояние в памяти прежнее', (t) => {
    const { env, dir } = managed(t, [{ name: 'ENVT_A', candidates: [literal(1, 'v')] }]);
    if (process.getuid?.() === 0) return;
    fs.chmodSync(dir, 0o500);
    try {
      assert.throws(() => env.unset('ENVT_A'));
      assert.deepEqual(env.view().vars[0].choice, { kind: 'untouched' });
      assert.equal(env.overlay().unset.size, 0);
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });
});

describe('ManagedEnv: сохранение определений', () => {
  it('новые кандидаты получают номера, выбор сохраняется, файл 0600', (t) => {
    const { env, file } = managed(t, [{ name: 'ENVT_A', candidates: [literal(1, 'v')], choice: selected(1) }]);
    env.save([{ name: 'ENVT_A', candidates: [literal(1, 'v'), { kind: 'literal', value: 'new' }] }, { name: 'ENVT_B', candidates: [{ kind: 'expr', command: 'echo b' }] }]);
    const saved = read(file).vars;
    assert.equal(saved.length, 2);
    assert.match(saved[0].candidates[1].id, /^[0-9a-f]{8}$/);
    assert.notEqual(saved[0].candidates[1].id, ID(1));
    assert.deepEqual(saved[0].choice, { kind: 'selected', candidate: ID(1) });
    assert.deepEqual(saved[1].choice, { kind: 'untouched' });
    assert.equal(mode(file), 0o600);
  });

  it('правка выбранного литерала действует сразу', (t) => {
    const { env } = managed(t, [{ name: 'ENVT_A', candidates: [literal(1, 'old')], choice: selected(1) }]);
    env.save([{ name: 'ENVT_A', candidates: [literal(1, 'new')] }]);
    assert.equal(env.overlay().set.get('ENVT_A'), 'new');
    assert.deepEqual(env.view().vars[0].choice, { kind: 'selected', candidate: ID(1) });
  });

  it('правка выбранного выражения возвращает «не трогать»: прежнее значение больше не подмешивается', async (t) => {
    const { env } = withPass(t, {}, [{ name: 'ENVT_A', candidates: [expr(1, 'echo old')] }]);
    await env.select('ENVT_A', ID(1));
    assert.equal(env.overlay().set.get('ENVT_A'), 'old');
    env.save([{ name: 'ENVT_A', candidates: [expr(1, 'echo new')] }]);
    assert.equal(env.overlay().set.has('ENVT_A'), false);
    assert.deepEqual(env.view().vars[0].choice, { kind: 'untouched' });
  });

  it('несвязанная правка выбранного выражения (другая переменная) значения не теряет', async (t) => {
    const { env } = withPass(t, {}, [{ name: 'ENVT_A', candidates: [expr(1, 'echo a')] }, { name: 'ENVT_B', candidates: [] }]);
    await env.select('ENVT_A', ID(1));
    env.save([{ name: 'ENVT_A', candidates: [expr(1, 'echo a')] }, { name: 'ENVT_B', candidates: [literal(1, 'b')] }]);
    assert.equal(env.overlay().set.get('ENVT_A'), 'a');
  });

  it('удалённый из списка выбранный кандидат возвращает «не трогать»; удалённая переменная уходит из overlay', (t) => {
    const { env } = managed(t, [
      { name: 'ENVT_A', candidates: [literal(1, 'x'), literal(2, 'y')], choice: selected(2) },
      { name: 'ENVT_B', candidates: [literal(1, 'b')], choice: selected(1) },
    ]);
    env.save([{ name: 'ENVT_A', candidates: [literal(1, 'x')] }]);
    assert.deepEqual(env.view().vars.map((v) => [v.name, v.choice.kind]), [['ENVT_A', 'untouched']]);
    assert.equal(env.overlay().set.size, 0);
  });

  it('отказы целиком, без частичной записи: повтор имени, плохое имя, служебное имя, NUL, пустая команда, не список, лишние кандидаты', (t) => {
    const { env, file } = managed(t, [{ name: 'ENVT_A', candidates: [literal(1, 'x')] }]);
    const before = fs.readFileSync(file, 'utf8');
    const bad: [unknown, RegExp][] = [
      [[{ name: 'ENVT_A', candidates: [] }, { name: 'ENVT_A', candidates: [] }], /повторено/],
      [[{ name: 'bad name', candidates: [] }], /не годится/],
      [[{ name: 'CYBORG_Z', candidates: [] }], /служебное/],
      [[{ name: 'ENVT_Z', candidates: [{ kind: 'literal', value: 'a\0b' }] }], /NUL/],
      [[{ name: 'ENVT_Z', candidates: [{ kind: 'expr', command: '  ' }] }], /пуста/],
      [[{ name: 'ENVT_Z', candidates: Array.from({ length: 33 }, () => ({ kind: 'literal', value: 'v' })) }], /кандидатов больше/],
      [[{ name: 'ENVT_Z', candidates: [{ kind: 'literal', value: 'x'.repeat(64 * 1024 + 1) }] }], /64 КиБ/],
      [{ vars: [] }, /Некорректный список/],
      [Array.from({ length: 129 }, (_, i) => ({ name: `ENVT_${i}`, candidates: [] })), /Переменных больше/],
    ];
    for (const [input, re] of bad) assert.throws(() => env.save(input), re);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  });

  it('повторяющиеся номера кандидатов перенумеровываются, номера не повторяются', (t) => {
    const { env, file } = managed(t);
    env.save([{ name: 'ENVT_A', candidates: [literal(1, 'a'), literal(1, 'b')] }]);
    const ids = read(file).vars[0].candidates.map((c: { id: string }) => c.id);
    assert.equal(new Set(ids).size, 2);
  });
});

describe('ManagedEnv: старт Cyborg', () => {
  it('выбранные выражения вычисляются заново по одному, запуски ждут конца, значения берутся свежие', async (t) => {
    let active = 0;
    let peak = 0;
    const order: string[] = [];
    const fake = async (command: string): Promise<EvalResult> => {
      active++;
      peak = Math.max(peak, active);
      order.push(command);
      await sleep(40);
      active--;
      return { ok: true, value: `fresh-${command}` };
    };
    const { env } = managed(
      t,
      [
        { name: 'ENVT_A', candidates: [expr(1, 'a')], choice: selected(1) },
        { name: 'ENVT_B', candidates: [expr(1, 'b')], choice: selected(1) },
        { name: 'ENVT_C', candidates: [literal(1, 'c')], choice: selected(1) },
        { name: 'ENVT_D', candidates: [expr(1, 'd')] },
      ],
      { evaluate: fake as never },
    );
    assert.equal(env.overlay().set.has('ENVT_A'), false);
    const ready = env.start();
    assert.equal(env.view().starting, true);
    await ready;
    assert.equal(env.view().starting, false);
    assert.equal(peak, 1, 'одновременно одно вычисление: один pinentry');
    assert.deepEqual(order, ['a', 'b']);
    assert.equal(env.overlay().set.get('ENVT_A'), 'fresh-a');
    assert.equal(env.overlay().set.get('ENVT_C'), 'c');
    assert.equal(env.overlay().set.has('ENVT_D'), false);
  });

  it('ready ждёт конца вычислений; без выражений - уже готов', async (t) => {
    const { env } = managed(t, [{ name: 'ENVT_A', candidates: [expr(1, 'a')], choice: selected(1) }], { evaluate: (async () => (await sleep(80), { ok: true, value: 'v' })) as never });
    let done = false;
    const ready = env.start();
    void env.ready().then(() => (done = true));
    await sleep(20);
    assert.equal(done, false);
    await ready;
    await sleep(5);
    assert.equal(done, true);
    const idle = managed(t).env;
    await idle.start();
    await idle.ready();
  });

  it('неудача на старте: выбор остаётся, значения нет, статус с причиной; остальные вычисляются', async (t) => {
    const { env } = managed(
      t,
      [
        { name: 'ENVT_A', candidates: [expr(1, 'bad')], choice: selected(1) },
        { name: 'ENVT_B', candidates: [expr(1, 'good')], choice: selected(1) },
      ],
      { evaluate: (async (command: string) => (command === 'bad' ? { ok: false, reason: 'exit', stderr: 'нет gpg-agent' } : { ok: true, value: 'ok' })) as never },
    );
    await env.start();
    const [a, b] = env.view().vars;
    assert.equal(a.unapplied, true);
    assert.equal(a.status.kind, 'failed');
    assert.deepEqual(a.choice, { kind: 'selected', candidate: ID(1) });
    assert.equal(b.unapplied, false);
    assert.equal(env.overlay().set.has('ENVT_A'), false);
    assert.equal(env.overlay().set.get('ENVT_B'), 'ok');
  });

  it('действие человека на старте: выбор литерала до конца вычисления не затирается его результатом', async (t) => {
    const { env } = managed(t, [{ name: 'ENVT_A', candidates: [expr(1, 'slow'), literal(2, 'human')], choice: selected(1) }], {
      evaluate: ((_c: string, o: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          const cancelled = () => resolve({ ok: false, reason: 'cancelled', stderr: '' });
          if (o.signal.aborted) cancelled();
          else o.signal.addEventListener('abort', cancelled);
        })) as never,
    });
    const ready = env.start();
    await env.select('ENVT_A', ID(2));
    await ready;
    assert.equal(env.overlay().set.get('ENVT_A'), 'human');
  });

  /** Вычисление, которое держится, пока тест не отпустит его по имени команды; отмена снимает с исходом cancelled. */
  const gated = () => {
    const calls: string[] = [];
    const gates = new Map<string, (value: string) => void>();
    const fake = ((command: string, o: { signal: AbortSignal }) =>
      new Promise((resolve) => {
        calls.push(command);
        gates.set(command, (value) => resolve({ ok: true, value }));
        o.signal.addEventListener('abort', () => resolve({ ok: false, reason: 'cancelled', stderr: '' }));
      })) as never;
    return { calls, gates, fake };
  };
  const choiceOf = (file: string, name: string) => read(file).vars.find((v: { name: string }) => v.name === name).choice;

  it('сохранение определений во время стартового вычисления не теряет выбор: значение, досчитанное стартом, попадает в overlay', async (t) => {
    const { calls, gates, fake } = gated();
    const { env, file } = managed(
      t,
      [
        { name: 'ENVT_A', candidates: [expr(1, 'cmdA')], choice: selected(1) },
        { name: 'ENVT_B', candidates: [expr(1, 'cmdB')], choice: selected(1) },
      ],
      { evaluate: fake },
    );
    const ready = env.start();
    await until(() => calls.includes('cmdA'));
    env.save([
      { name: 'ENVT_A', candidates: [expr(1, 'cmdA')] },
      { name: 'ENVT_B', candidates: [expr(1, 'cmdB')] },
      { name: 'ENVT_C', candidates: [] },
    ]);
    assert.deepEqual(choiceOf(file, 'ENVT_A'), { kind: 'selected', candidate: ID(1) });
    assert.deepEqual(choiceOf(file, 'ENVT_B'), { kind: 'selected', candidate: ID(1) });
    assert.equal(env.view().vars[0].status.kind, 'evaluating', 'стартовое вычисление идёт, его не отменили');
    gates.get('cmdA')?.('va');
    await until(() => calls.includes('cmdB'));
    gates.get('cmdB')?.('vb');
    await ready;
    assert.deepEqual(calls, ['cmdA', 'cmdB']);
    assert.equal(env.overlay().set.get('ENVT_A'), 'va');
    assert.equal(env.overlay().set.get('ENVT_B'), 'vb');
  });

  it('правка другого кандидата той же переменной не отменяет её стартовое вычисление', async (t) => {
    const { calls, gates, fake } = gated();
    const { env } = managed(t, [{ name: 'ENVT_A', candidates: [expr(1, 'cmdA'), literal(2, 'x')], choice: selected(1) }], { evaluate: fake });
    const ready = env.start();
    await until(() => calls.includes('cmdA'));
    env.save([{ name: 'ENVT_A', candidates: [expr(1, 'cmdA'), literal(2, 'y')] }]);
    gates.get('cmdA')?.('va');
    await ready;
    assert.deepEqual(calls, ['cmdA']);
    assert.equal(env.overlay().set.get('ENVT_A'), 'va');
  });

  it('сохранение определений после неудачного старта оставляет выбор и признак «не применена»', async (t) => {
    const { env, file } = managed(t, [{ name: 'ENVT_A', candidates: [expr(1, 'bad')], choice: selected(1) }], { evaluate: (async () => ({ ok: false, reason: 'exit', stderr: 'нет gpg-agent' })) as never });
    await env.start();
    assert.equal(env.view().vars[0].unapplied, true);
    env.save([{ name: 'ENVT_A', candidates: [expr(1, 'bad')] }, { name: 'ENVT_C', candidates: [] }]);
    assert.deepEqual(choiceOf(file, 'ENVT_A'), { kind: 'selected', candidate: ID(1) });
    const [a] = env.view().vars;
    assert.equal(a.unapplied, true);
    assert.equal(a.status.kind, 'failed', 'причина ошибки в окне не пропала');
  });

  it('правка текста выбранного выражения по-прежнему возвращает «не трогать»: вычисленное по старому тексту не действует', async (t) => {
    const { env, file } = managed(t, [{ name: 'ENVT_A', candidates: [expr(1, 'bad')], choice: selected(1) }], { evaluate: (async () => ({ ok: false, reason: 'exit', stderr: '' })) as never });
    await env.start();
    env.save([{ name: 'ENVT_A', candidates: [expr(1, 'other')] }]);
    assert.deepEqual(choiceOf(file, 'ENVT_A'), { kind: 'untouched' });
  });

  it('выбор другого выражения на старте побеждает: очередь не запускает прежний текст под тем же ключом', { timeout: 5000 }, async (t) => {
    const { calls, gates, fake } = gated();
    const { env, file } = managed(
      t,
      [
        { name: 'ENVT_A', candidates: [expr(1, 'cmdA')], choice: selected(1) },
        { name: 'ENVT_B', candidates: [expr(1, 'cmdB1'), expr(2, 'cmdB2')], choice: selected(1) },
      ],
      { evaluate: fake },
    );
    const ready = env.start();
    await until(() => calls.includes('cmdA'));
    const picked = env.select('ENVT_B', ID(2));
    await until(() => calls.includes('cmdB2'));
    gates.get('cmdA')?.('va');
    gates.get('cmdB2')?.('vb-new');
    assert.deepEqual(await picked, { ok: true });
    await ready;
    assert.deepEqual(calls, ['cmdA', 'cmdB2'], 'прежний кандидат B не запускался');
    assert.equal(env.overlay().set.get('ENVT_A'), 'va');
    assert.equal(env.overlay().set.get('ENVT_B'), 'vb-new');
    assert.deepEqual(choiceOf(file, 'ENVT_B'), { kind: 'selected', candidate: ID(2) });
  });

  it('снятие и «Отменить» на старте убирают переменную из очереди', async (t) => {
    const { calls, gates, fake } = gated();
    const { env } = managed(
      t,
      [
        { name: 'ENVT_A', candidates: [expr(1, 'cmdA')], choice: selected(1) },
        { name: 'ENVT_B', candidates: [expr(1, 'cmdB')], choice: selected(1) },
        { name: 'ENVT_C', candidates: [expr(1, 'cmdC')], choice: selected(1) },
      ],
      { evaluate: fake },
    );
    const ready = env.start();
    await until(() => calls.includes('cmdA'));
    env.unset('ENVT_B');
    env.cancel('ENVT_C');
    gates.get('cmdA')?.('va');
    await ready;
    assert.deepEqual(calls, ['cmdA']);
    assert.equal(env.overlay().unset.has('ENVT_B'), true);
    assert.equal(env.overlay().set.has('ENVT_C'), false);
    assert.equal(env.view().vars[2].status.kind, 'failed');
  });

  it('dispose снимает идущие вычисления', async (t) => {
    const pidFile = path.join(os.tmpdir(), `cyborg-dispose-${process.pid}-${Date.now()}`);
    t.after(() => fs.rmSync(pidFile, { force: true }));
    const { env } = withPass(t, {}, [{ name: 'ENVT_S', candidates: [expr(1, `echo $$ > '${pidFile}'; sleep 30`)], choice: selected(1) }], { evalOptions: { killGraceMs: 100 } });
    const ready = env.start();
    await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '');
    env.dispose();
    await ready;
    await until(() => !alive(Number(fs.readFileSync(pidFile, 'utf8').trim())), 5000);
  });
});

describe('ManagedEnv: показ значения и отметки устаревания', () => {
  it('reveal: действующее значение из памяти, унаследованное для не тронутой, null для снятой; чужое имя - отказ', (t) => {
    const { env } = managed(t, [
      { name: 'ENVT_SET', candidates: [literal(1, 'v')], choice: selected(1) },
      { name: 'ENVT_INHERITED', candidates: [] },
      { name: 'ENVT_GONE', choice: { kind: 'unset' } },
    ]);
    assert.equal(env.reveal('ENVT_SET'), 'v');
    assert.equal(env.reveal('ENVT_INHERITED'), 'from-parent');
    assert.equal(env.reveal('ENVT_GONE'), null);
    assert.throws(() => env.reveal('ENVT_NOPE'), /нет в списке/);
  });

  it('отметка: изменение значения управляемого имени делает сессию устаревшей, возврат значения - снова актуальной', async (t) => {
    const { env } = managed(t, [{ name: 'ENVT_A', candidates: [literal(1, 'v')] }, { name: 'ENVT_B', candidates: [literal(1, 'b')], choice: selected(1) }]);
    const stamp = env.stamp(false);
    assert.deepEqual(env.stale(stamp), []);
    await env.select('ENVT_A', ID(1));
    assert.deepEqual(env.stale(stamp), ['ENVT_A']);
    env.untouch('ENVT_A');
    assert.deepEqual(env.stale(stamp), []);
    env.unset('ENVT_B');
    assert.deepEqual(env.stale(stamp), ['ENVT_B']);
  });

  it('имя, заведённое после запуска сессии, сравнивается с унаследованным: снять унаследованную - устарело, заведённая без смены значения - нет', (t) => {
    const { env } = managed(t);
    const stamp = env.stamp(false);
    env.save([{ name: 'ENVT_NEW', candidates: [literal(1, 'x')] }]);
    assert.deepEqual(env.stale(stamp), []);
    env.unset('ENVT_INHERITED');
    assert.deepEqual(env.stale(stamp), ['ENVT_INHERITED']);
  });

  it('значение, совпавшее с унаследованным, устаревания не даёт', async (t) => {
    const { env } = managed(t, [{ name: 'ENVT_INHERITED', candidates: [literal(1, 'from-parent')] }]);
    const stamp = env.stamp(false);
    await env.select('ENVT_INHERITED', ID(1));
    assert.deepEqual(env.stale(stamp), []);
  });

  it('собственные имена Cyborg в отметку не входят: локально TERM и служебные, на хосте ещё и доступы хостинга', async (t) => {
    const { env } = managed(t, [{ name: 'TERM', candidates: [literal(1, 'dumb')] }, { name: 'GH_TOKEN', candidates: [literal(1, 't')] }]);
    const local = env.stamp(false);
    const remote = env.stamp(true);
    await env.select('TERM', ID(1));
    await env.select('GH_TOKEN', ID(1));
    assert.deepEqual(env.stale(local), ['GH_TOKEN']);
    assert.deepEqual(env.stale(remote), []);
    assert.equal(OWN_NAMES_LOCAL('TERM'), true);
    assert.equal(OWN_NAMES_LOCAL('GH_TOKEN'), false);
    assert.equal(OWN_NAMES_REMOTE('GH_TOKEN'), true);
  });

  it('отметка не хранит значений: только свёртки', async (t) => {
    const { env } = managed(t, [{ name: 'ENVT_A', candidates: [literal(1, 'sekret-value')], choice: selected(1) }]);
    const stamp = env.stamp(false);
    assert.equal(JSON.stringify([...stamp.digests]).includes('sekret-value'), false);
  });
});

describe('имена и пометки', () => {
  it('служебные имена Cyborg отвергаются, обычные - нет', () => {
    for (const name of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CYBORG_MCP', 'CYBORG_AGENTD']) assert.notEqual(reservedName(name), null, name);
    for (const name of ['PATH', 'CLAUDE_CODE_OAUTH_TOKEN', 'ENVT_A', 'CLAUDE_CONFIG_DIR']) assert.equal(reservedName(name), null, name);
  });

  it('пометки: где значение не действует, потому что Cyborg ставит или снимает переменную сам', () => {
    assert.match(ownNotes('TERM')[0], /не действует в сессиях/);
    assert.match(ownNotes('GH_PROMPT_DISABLED')[0], /gh, glab и jira/);
    assert.match(ownNotes('NO_COLOR')[0], /claude plugin/);
    assert.match(ownNotes('GH_TOKEN').join(' '), /токен не ушёл чужому хосту|не действует/);
    assert.match(ownNotes('SSH_ASKPASS_REQUIRE')[0], /ssh/);
    assert.match(ownNotes('GIT_SSH_COMMAND')[0], /демон/);
    const configNote = ownNotes('CLAUDE_CONFIG_DIR')[0];
    for (const reader of ['«Расширения»', 'зеркало', 'память', 'CLAUDE.md']) assert.ok(configNote.includes(reader), `заметка не называет чтение: ${reader}`);
    assert.match(configNote, /при запуске Cyborg/);
    assert.match(ownNotes('CLAUDE_CODE_OAUTH_TOKEN')[0], /заменяет токен/);
    assert.deepEqual(ownNotes('ENVT_PLAIN'), []);
  });
});

describe('ManagedEnv: общий файл двух окон', () => {
  const twin = (t: { after: (fn: () => void) => void }, file: string, store: string) => {
    const other = new ManagedEnv({
      file,
      home: path.dirname(file),
      loginPath: async () => `${fakeBin}:${process.env.PATH}`,
      inherited: () => ({ ENVT_INHERITED: 'from-parent', FAKE_PASS_DIR: store, FAKE_PASS_LOG: path.join(store, 'calls.log'), PATH: process.env.PATH }),
    });
    t.after(() => other.dispose());
    return other;
  };

  it('снятие в одном окне другое применяет к своим запускам', async (t) => {
    const { env, file, store } = withPass(t, { 'claude-agent/oauth': 'sk-ant-oat01-SECRET' }, [{ name: 'CLAUDE_CODE_OAUTH_TOKEN', candidates: [expr(1, 'pass show claude-agent/oauth')] }]);
    const other = twin(t, file, store);
    assert.deepEqual(await env.select('CLAUDE_CODE_OAUTH_TOKEN', ID(1)), { ok: true });
    other.reload();
    await until(() => other.overlay().set.get('CLAUDE_CODE_OAUTH_TOKEN') === 'sk-ant-oat01-SECRET');
    env.unset('CLAUDE_CODE_OAUTH_TOKEN');
    other.reload();
    assert.equal(other.overlay().set.has('CLAUDE_CODE_OAUTH_TOKEN'), false);
    assert.equal(other.overlay().unset.has('CLAUDE_CODE_OAUTH_TOKEN'), true);
  });

  it('выбранный литерал и удаление переменной доходят сразу', (t) => {
    const { env, file, store } = withPass(t, {}, [{ name: 'ENVT_L', candidates: [literal(1, 'a'), literal(2, 'b')], choice: selected(1) }]);
    const other = twin(t, file, store);
    void env.select('ENVT_L', ID(2));
    other.reload();
    assert.equal(other.overlay().set.get('ENVT_L'), 'b');
    env.remove('ENVT_L');
    other.reload();
    assert.equal(other.overlay().set.has('ENVT_L'), false);
    assert.deepEqual(other.view().vars, []);
  });

  it('своя запись и неизменный файл ничего не трогают', (t) => {
    const { env, changes } = withPass(t, {}, [{ name: 'ENVT_L', candidates: [literal(1, 'a')], choice: selected(1) }]);
    const before = changes.length;
    env.reload();
    assert.equal(changes.length, before);
    assert.equal(env.overlay().set.get('ENVT_L'), 'a');
  });

  it('испорченный файл прежнее состояние не трогает', (t) => {
    const { env, file } = withPass(t, {}, [{ name: 'ENVT_L', candidates: [literal(1, 'a')], choice: selected(1) }]);
    fs.writeFileSync(file, '{oops');
    env.reload();
    assert.equal(env.overlay().set.get('ENVT_L'), 'a');
  });

  it('наблюдение за каталогом подхватывает правку соседа без вызова reload', async (t) => {
    const { env, file, store } = withPass(t, {}, [{ name: 'ENVT_L', candidates: [literal(1, 'a'), literal(2, 'b')], choice: selected(1) }]);
    const other = twin(t, file, store);
    other.watch();
    await env.select('ENVT_L', ID(2));
    // FSEvents на macOS запускается с задержкой и теряет событие сразу после watch(): повторное касание файла даёт следующее.
    const touch = setInterval(() => fs.utimesSync(file, new Date(), new Date()), 300);
    t.after(() => clearInterval(touch));
    await until(() => other.overlay().set.get('ENVT_L') === 'b');
  });
});
