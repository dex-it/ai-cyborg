import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { candidateLabel, commandHint, defsOf, matchNames, readDef, readDefs, revealStamp, staleTitle, stateLabel, type EnvVarView, type EnvView } from '../src/shared/env-vars';

const none = () => null;
const view = (vars: Partial<EnvVarView>[], over: Partial<EnvView> = {}): EnvView => ({
  vars: vars.map((v) => ({ name: 'A', candidates: [], choice: { kind: 'untouched' }, status: { kind: 'idle' }, unapplied: false, notes: [], ...v })),
  problems: [],
  starting: false,
  ...over,
});

describe('readDef', () => {
  const lit = { id: 'aaaaaaaa', kind: 'literal', value: 'v' };

  it('годная запись: имя, кандидаты и выбор', () => {
    assert.deepEqual(readDef({ name: 'A_1', candidates: [lit, { id: 'bbbbbbbb', kind: 'expr', command: 'pass show x' }], choice: { kind: 'selected', candidate: 'aaaaaaaa' } }, none), {
      name: 'A_1',
      candidates: [lit, { id: 'bbbbbbbb', kind: 'expr', command: 'pass show x' }],
      choice: { kind: 'selected', candidate: 'aaaaaaaa' },
    });
  });

  it('имя: буквы, цифры, _, не с цифры, до 128 знаков', () => {
    for (const name of ['1A', 'A-B', 'A B', '', 'A=B', 'Я', 'A'.repeat(129), 5, null]) assert.equal(typeof readDef({ name, candidates: [] }, none), 'string', String(name));
    for (const name of ['a', '_', 'A'.repeat(128), 'PATH2']) assert.equal(typeof readDef({ name, candidates: [] }, none), 'object', name);
  });

  it('выбор на несуществующего кандидата и неизвестный выбор - «не трогать»; снятие сохраняется', () => {
    assert.deepEqual((readDef({ name: 'A', candidates: [lit], choice: { kind: 'selected', candidate: 'cccccccc' } }, none) as { choice: unknown }).choice, { kind: 'untouched' });
    assert.deepEqual((readDef({ name: 'A', candidates: [], choice: { kind: 'bogus' } }, none) as { choice: unknown }).choice, { kind: 'untouched' });
    assert.deepEqual((readDef({ name: 'A', candidates: [], choice: { kind: 'unset' } }, none) as { choice: unknown }).choice, { kind: 'unset' });
  });

  it('кандидат: номер из 8 hex, вид literal или expr, NUL и размер за 64 КиБ отвергаются по байтам, не по знакам', () => {
    const bad: unknown[] = [
      { id: 'zz', kind: 'literal', value: 'v' },
      { id: 'aaaaaaaa', kind: 'literal', value: 5 },
      { id: 'aaaaaaaa', kind: 'literal', value: 'a\0' },
      { id: 'aaaaaaaa', kind: 'literal', value: 'я'.repeat(32 * 1024 + 1) },
      { id: 'aaaaaaaa', kind: 'expr', command: '' },
      { id: 'aaaaaaaa', kind: 'expr', command: 'a\0' },
      { id: 'aaaaaaaa', kind: 'file' },
      'строка',
      null,
    ];
    for (const c of bad) assert.equal(typeof readDef({ name: 'A', candidates: [c] }, none), 'string', JSON.stringify(c)?.slice(0, 40));
    assert.equal(typeof readDef({ name: 'A', candidates: [{ id: 'aaaaaaaa', kind: 'literal', value: 'я'.repeat(32 * 1024) }] }, none), 'object');
  });

  it('повтор номера кандидата, больше 32 кандидатов, не объект - отказ', () => {
    assert.match(readDef({ name: 'A', candidates: [lit, lit] }, none) as string, /повторён/);
    assert.match(readDef({ name: 'A', candidates: Array.from({ length: 33 }, (_, i) => ({ ...lit, id: i.toString(16).padStart(8, '0') })) }, none) as string, /кандидатов больше/);
    assert.match(readDef([], none) as string, /не объект/);
    assert.match(readDef(null, none) as string, /не объект/);
  });

  it('служебное имя отвергается переданной проверкой', () => {
    assert.match(readDef({ name: 'X', candidates: [] }, (n) => (n === 'X' ? 'служебное' : null)) as string, /X: служебное/);
  });
});

describe('readDefs', () => {
  it('нет списка - причина; повтор имени - вторая запись пропущена; предел 128 с пометкой', () => {
    assert.deepEqual(readDefs({}, none), { vars: [], problems: ['в файле нет списка vars'] });
    const dup = readDefs({ vars: [{ name: 'A', candidates: [] }, { name: 'A', candidates: [] }] }, none);
    assert.equal(dup.vars.length, 1);
    assert.match(dup.problems[0], /A: имя повторено/);
    const many = readDefs({ vars: Array.from({ length: 130 }, (_, i) => ({ name: `V${i}`, candidates: [] })) }, none);
    assert.equal(many.vars.length, 128);
    assert.match(many.problems.at(-1) as string, /больше 128/);
  });
});

describe('показ состояния', () => {

  it('состояние переменной словами: не тронута, выбрана, снята, вычисляется, ошибка, значения нет', () => {
    const [a, b, c, d, e, f] = view([
      {},
      { choice: { kind: 'selected', candidate: 'a' } },
      { choice: { kind: 'unset' } },
      { status: { kind: 'evaluating' } },
      { status: { kind: 'failed', reason: 'не уложилась', output: false } },
      { choice: { kind: 'selected', candidate: 'a' }, unapplied: true },
    ]).vars;
    assert.match(stateLabel(a), /не тронута/);
    assert.equal(stateLabel(b), 'выбрана');
    assert.match(stateLabel(c), /снята/);
    assert.match(stateLabel(d), /вычисляется/);
    assert.match(stateLabel(e), /ошибка: не уложилась/);
    assert.match(stateLabel(f), /значения нет/);
  });

  it('определения для сохранения несут имя и кандидатов, но не выбор; подсказка вкладки называет имена', () => {
    const v = view([{ name: 'X', candidates: [{ id: 'aaaaaaaa', kind: 'literal', value: 'v' }], choice: { kind: 'unset' } }]);
    assert.deepEqual(defsOf(v), [{ name: 'X', candidates: [{ id: 'aaaaaaaa', kind: 'literal', value: 'v' }] }]);
    assert.match(staleTitle(['A', 'B']), /A, B/);
    assert.match(staleTitle(['A', 'B']), /Перезапуск продолжит разговор/);
    assert.match(staleTitle(['A'], true), /Перезапуск недоступен: сессию ведёт вызвавшая/);
  });

  it('отметка раскрытого значения зависит от текста выбранного кандидата: правка литерала «a» на «b» делает раскрытое устаревшим', () => {
    const pick = (value: string) => view([{ name: 'X', candidates: [{ id: 'aaaaaaaa', kind: 'literal', value }], choice: { kind: 'selected', candidate: 'aaaaaaaa' } }]).vars[0];
    assert.equal(revealStamp(pick('a')), revealStamp(pick('a')));
    assert.notEqual(revealStamp(pick('a')), revealStamp(pick('b')));
    const other = view([{ name: 'X', candidates: [{ id: 'aaaaaaaa', kind: 'literal', value: 'a' }, { id: 'bbbbbbbb', kind: 'literal', value: 'q' }], choice: { kind: 'selected', candidate: 'aaaaaaaa' } }]).vars[0];
    const edited = { ...other, candidates: [other.candidates[0], { id: 'bbbbbbbb', kind: 'literal', value: 'r' } as const] };
    assert.equal(revealStamp(other), revealStamp(edited), 'правка невыбранного кандидата раскрытого не сбрасывает');
    assert.notEqual(revealStamp(pick('a')), revealStamp({ ...pick('a'), choice: { kind: 'unset' } }));
  });

  it('подпись кандидата в списке: значение как есть, команда с пометкой, пустое названо, длинное обрезано', () => {
    assert.equal(candidateLabel({ id: 'a', kind: 'literal', value: 'abc' }), 'abc');
    assert.equal(candidateLabel({ id: 'a', kind: 'expr', command: 'pass show  x\n' }), 'команда: pass show x');
    assert.equal(candidateLabel({ id: 'a', kind: 'literal', value: '' }), '(пустое значение)');
    const long = candidateLabel({ id: 'a', kind: 'literal', value: 'x'.repeat(200) }, 20);
    assert.equal(long.length, 20);
    assert.ok(long.endsWith('…'));
  });
});

describe('подсказка имени', () => {
  it('без учёта регистра, начинающиеся с запроса - первыми; пустой запрос - все', () => {
    const names = ['LC_PAPER', 'PAPERSIZE', 'PATH', 'HOME'];
    assert.deepEqual(matchNames(names, 'pa'), ['PAPERSIZE', 'PATH', 'LC_PAPER']);
    assert.deepEqual(matchNames(names, ' '), names);
    assert.deepEqual(matchNames(names, 'zz'), []);
  });
});

describe('подсказка к тексту команды', () => {
  it('обёртка $(…), обратные кавычки, присваивание и export названы; обычная команда и префикс окружения - нет', () => {
    for (const wrapped of ['"$(pass show a/b)"', '$(pass show a/b)', "  '$(pass show a/b)' ", '`pass show a/b`']) assert.match(commandHint(wrapped) ?? '', /уберите обёртку/, wrapped);
    assert.match(commandHint('TOKEN="$(pass show a/b)"') ?? '', /присваивание/);
    assert.match(commandHint('export TOKEN=$(pass show a/b)') ?? '', /export/);
    for (const plain of ['pass show a/b', 'echo "$(date) $HOME"', 'LC_ALL=C pass show a/b', 'printf %s "$(cat ~/.token)"']) assert.equal(commandHint(plain), null, plain);
  });
});
