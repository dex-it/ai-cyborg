import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { childEnv, childEnvNow, composeEnv, envReady, useManagedEnv, type EnvPort, type Overlay } from '../src/main/child-env';

const overlay = (set: Record<string, string> = {}, unset: string[] = []): Overlay => ({ set: new Map(Object.entries(set)), unset: new Set(unset) });
const port = (o: Overlay, ready: Promise<void> = Promise.resolve()): EnvPort => ({ overlay: () => o, ready: () => ready, stamp: (remote) => ({ digests: new Map(), remote }), stale: () => [] });

afterEach(() => useManagedEnv(null));

describe('composeEnv', () => {
  it('порядок слоёв: унаследованное, управляемое, собственное Cyborg', () => {
    const env = composeEnv({ A: 'base', B: 'base', C: 'base', D: 'base' }, overlay({ B: 'managed', C: 'managed' }, ['A', 'D']), { set: { C: 'own' }, unset: ['B'] });
    assert.deepEqual(env, { C: 'own' });
  });

  it('снятая управляемая переменная исчезает, выбранная ставится, нетронутая остаётся унаследованной', () => {
    assert.deepEqual(composeEnv({ KEEP: 'k', GONE: 'g' }, overlay({ NEW: 'n' }, ['GONE'])), { KEEP: 'k', NEW: 'n' });
  });

  it('собственное значение Cyborg сильнее управляемого, в том числе снятого', () => {
    assert.equal(composeEnv({}, overlay({}, ['TERM']), { set: { TERM: 'xterm-256color' } }).TERM, 'xterm-256color');
    assert.equal(composeEnv({ TERM: 'dumb' }, overlay({ TERM: 'vt100' }), { set: { TERM: 'xterm-256color' } }).TERM, 'xterm-256color');
  });

  it('одно имя в собственных set и unset: побеждает set', () => {
    assert.equal(composeEnv({}, overlay(), { set: { X: '1' }, unset: ['X'] }).X, '1');
  });

  it('собственное unset убирает и унаследованное, и управляемое; undefined в set не ставит имя', () => {
    const env = composeEnv({ I: 'i' }, overlay({ M: 'm' }), { set: { U: undefined }, unset: ['I', 'M'] });
    assert.deepEqual(env, {});
  });

  it('значения undefined у базы пропускаются', () => {
    assert.deepEqual(composeEnv({ A: undefined, B: 'b' }, overlay()), { B: 'b' });
  });
});

describe('childEnvNow и childEnv', () => {
  it('без подключённого менеджера - окружение процесса как есть, process.env не меняется', () => {
    const before = JSON.stringify(process.env);
    assert.equal(childEnvNow().PATH, process.env.PATH);
    assert.equal(childEnvNow({ set: { ENVT_OWN: '1' } }).ENVT_OWN, '1');
    assert.equal(JSON.stringify(process.env), before);
  });

  it('управляемое окружение накладывается на process.env, но process.env остаётся прежним', () => {
    process.env.ENVT_PARENT = 'parent';
    try {
      useManagedEnv(port(overlay({ ENVT_NEW: 'n' }, ['ENVT_PARENT'])));
      const env = childEnvNow();
      assert.equal(env.ENVT_NEW, 'n');
      assert.equal('ENVT_PARENT' in env, false);
      assert.equal(process.env.ENVT_PARENT, 'parent');
      assert.equal(process.env.ENVT_NEW, undefined);
    } finally {
      delete process.env.ENVT_PARENT;
    }
  });

  it('childEnv ждёт готовности: до конца вычисления выражений при старте запуск не идёт', async () => {
    let release!: () => void;
    useManagedEnv(port(overlay({ ENVT_A: 'a' }), new Promise<void>((r) => (release = r))));
    let got: Record<string, string> | null = null;
    const pending = childEnv().then((env) => (got = env));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(got, null);
    release();
    await pending;
    assert.equal((got as unknown as Record<string, string>).ENVT_A, 'a');
  });

  it('после отключения менеджера overlay снова пуст, envReady готов', async () => {
    useManagedEnv(port(overlay({ ENVT_A: 'a' })));
    useManagedEnv(null);
    assert.equal('ENVT_A' in childEnvNow(), false);
    await envReady();
  });
});
