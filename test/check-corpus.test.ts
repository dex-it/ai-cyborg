import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { buildMatrix, checkCorpus, levelOf, requirements, writeMatrix } from '../scripts/corpus-lib.ts';

let root: string;
beforeEach(() => void (root = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-corpus-'))));
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const put = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};
const get = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');
const change = (file: string, from: string, to: string): void => {
  const text = get(file);
  assert.ok(text.includes(from), `в ${file} нет «${from}»`);
  fs.writeFileSync(path.join(root, file), text.replace(from, to));
};

const BRD = 'docs/01-product/brd.md';
const BRD_FEAT = 'docs/01-product/01-first/brd-feat.md';
const SRS = 'docs/01-product/01-first/srs.md';
const LOG = 'docs/01-product/01-first/decision-log.md';
const ADR1 = 'docs/03-architecture/adr/ADR-0001-first.md';

const front = (extra: string): string => `---\n${extra}\nstatus: review\ndate: 2026-10-26\n---\n\n`;

/** Малый согласованный корпус: BRD с BR-001, фича 01 с BR-1001 и FR-1001, ADR-0001, тест и счётчики. */
function validCorpus(): void {
  put(BRD, `${front('level: product')}# BRD\n\n### BR-001 Цель\n\n- **Требование:** цель.\n`);
  put(BRD_FEAT, `${front('feature: 01-first')}# BRD фичи\n\n### BR-1001 Возможность\n\n- **Требование:** возможность.\n- **traced from:** BR-001.\n`);
  put(
    SRS,
    `${front('feature: 01-first')}# SRS\n\n## 12. Functions\n\n### FR-1001 Действие\n\n- **Требование:** действие (D-01).\n- **traced from:** BR-1001.\n- **verification:** испытание - \`test/a.test.ts\`.\n- **класс:** Functions.\n\n## 13. Usability\n\n\`n/a\`.\n`,
  );
  put(LOG, `${front('feature: 01-first')}# decision-log\n\n| ID | Решение | Отвергнуто | Основание | Исход |\n|---|---|---|---|---|\n| D-01 | решение | - | - | принято |\n`);
  put(ADR1, `${front('id: ADR-0001')}# ADR-0001 Первое\n\n## Decision\n\n1. Решение.\n\n${'## Расхождения с текущим кодом'}\n\nРасхождений нет.\n`);
  put('test/a.test.ts', "import { it } from 'node:test';\nit('x', () => {});\n");
  put('src/a.ts', 'one\ntwo\nthree\n');
  for (const [key, value] of Object.entries({ BR: '1', '01.BR': '1001', '01.FR': '1001', ADR: '1', feature: '1' })) put(`docs/.req_counter/${key}`, `${value}\n`);
  writeMatrix(root);
}

const rules = (): string[] => checkCorpus(root).map((f) => `${f.rule}: ${f.message}`);
const expectFinding = (rule: string, part: string): void => {
  const found = rules();
  assert.ok(found.some((line) => line.startsWith(`${rule}:`) && line.includes(part)), `нет находки ${rule}/${part}; есть: ${JSON.stringify(found)}`);
};
/** Правка, после которой матрицу пересобирают: проверяется само правило, а не устаревшая матрица. */
const regenerate = (): void => writeMatrix(root);

describe('check-corpus: статус замены', () => {
  const ADR2 = 'docs/03-architecture/adr/ADR-0002-second.md';
  const second = `${front('id: ADR-0002')}# ADR-0002 Второе\n\n## Decision\n\n1. Решение.\n\n## Расхождения с текущим кодом\n\nРасхождений нет.\n`;
  const supersede = (extra: string): void => change(ADR1, 'status: review', `status: superseded${extra}`);
  it('superseded с заведённым superseded_by проходит', () => {
    validCorpus();
    put(ADR2, second);
    put('docs/.req_counter/ADR', '2\n');
    supersede('\nsuperseded_by: ADR-0002');
    regenerate();
    assert.deepEqual(checkCorpus(root), []);
  });
  it('без superseded_by - находка', () => {
    validCorpus();
    supersede('');
    expectFinding('status', 'без superseded_by');
  });
  it('superseded_by на незаведённый ADR - находка', () => {
    validCorpus();
    supersede('\nsuperseded_by: ADR-0009');
    expectFinding('status', 'ADR-0009 не заведён');
  });
});

describe('check-corpus: валидный корпус', () => {
  it('согласованный корпус проходит без находок', () => {
    validCorpus();
    assert.deepEqual(checkCorpus(root), []);
  });
  it('требования и уровни проверки берутся из SRS', () => {
    validCorpus();
    const [req] = requirements(root);
    assert.equal(req.id, 'FR-1001');
    assert.equal(levelOf(req.verification), 'автотест');
    assert.match(buildMatrix(root), /\| FR-1001 \| Действие \| 01-first \| автотест \| `test\/a\.test\.ts` \|/);
  });
  it('уровни: автотест со smoke, только smoke, ручная, осмотр', () => {
    assert.equal(levelOf('`test/a.test.ts`, `scripts/smoke.mjs`'), 'автотест + smoke');
    assert.equal(levelOf('`scripts/smoke.mjs`'), 'smoke');
    assert.equal(levelOf('`npm run measure`'), 'ручная');
    assert.equal(levelOf('осмотр кода'), 'осмотр и демонстрация');
  });
});

describe('check-corpus: каждое нарушение - находка', () => {
  beforeEach(validCorpus);

  it('нет front matter, неверный status, дата, feature не по каталогу', () => {
    change(SRS, 'status: review', 'status: draft');
    expectFinding('status', 'draft');
    change(SRS, 'status: draft', 'status: review');
    change(SRS, 'date: 2026-10-26', 'date: вчера');
    expectFinding('front-matter', 'date');
    change(SRS, 'date: вчера', 'date: 2026-10-26');
    change(SRS, 'feature: 01-first', 'feature: 02-second');
    expectFinding('front-matter', 'не совпадает с каталогом');
    put(LOG, '# без front matter\n');
    expectFinding('front-matter', 'нет front matter');
  });

  it('approved допустим', () => {
    change(SRS, 'status: review', 'status: approved');
    assert.deepEqual(checkCorpus(root), []);
  });

  it('ADR: пропуск номера, id не по имени файла, нет раздела расхождений, имя не по шаблону', () => {
    put('docs/03-architecture/adr/ADR-0003-third.md', get(ADR1).replace('ADR-0001', 'ADR-0003'));
    expectFinding('adr', 'ожидался 0002');
    fs.rmSync(path.join(root, 'docs/03-architecture/adr/ADR-0003-third.md'));
    change(ADR1, 'id: ADR-0001', 'id: ADR-0007');
    expectFinding('adr', 'не совпадает с именем файла');
    change(ADR1, 'id: ADR-0007', 'id: ADR-0001');
    change(ADR1, '## Расхождения с текущим кодом', '## Иное');
    expectFinding('adr', 'нет раздела');
    put('docs/03-architecture/adr/notes.md', front('id: X'));
    expectFinding('adr', 'имя файла не вида');
  });

  it('единица заведена повторно или не из диапазона своей фичи', () => {
    put('docs/01-product/02-second/srs.md', get(SRS).replace('feature: 01-first', 'feature: 02-second'));
    expectFinding('unit', 'FR-1001 заведён повторно');
    expectFinding('unit', 'не из диапазона фичи 02');
  });

  it('у требования нет verification', () => {
    change(SRS, '- **verification:** испытание - `test/a.test.ts`.\n', '');
    regenerate();
    expectFinding('verification', 'FR-1001: нет поля verification');
  });

  it('verification называет несуществующий файл', () => {
    change(SRS, '`test/a.test.ts`', '`test/ghost.test.ts`');
    regenerate();
    expectFinding('verification', 'test/ghost.test.ts');
  });

  it('traced from: нет поля, нет BR, BR не заведён; BR без требований', () => {
    change(SRS, '- **traced from:** BR-1001.\n', '');
    regenerate();
    expectFinding('traced-from', 'нет поля traced from');
    expectFinding('traced-from', 'BR-1001: ни одно требование на него не ссылается');
    change(SRS, '- **verification:**', '- **traced from:** без номера.\n- **verification:**');
    regenerate();
    expectFinding('traced-from', 'не называет BR');
    change(SRS, 'без номера.', 'BR-1999.');
    regenerate();
    expectFinding('traced-from', 'BR-1999 нет в корпусе');
  });

  it('ссылки на несуществующие FR, NFR, BR, ADR', () => {
    change(SRS, 'действие (D-01).', 'действие (D-01), см. FR-1999, NFR-1999, BR-1999 и ADR-0099.');
    regenerate();
    expectFinding('reference', 'FR-1999 не заведён');
    expectFinding('reference', 'NFR-1999 не заведён');
    expectFinding('reference', 'BR-1999 не заведён');
    expectFinding('reference', 'ADR-0099 не заведён');
  });

  it('решение D-NN: нет в decision-log своей фичи; «фичи NN» - в журнале названной фичи', () => {
    change(SRS, 'действие (D-01).', 'действие (D-02).');
    regenerate();
    expectFinding('reference', 'D-02 нет в decision-log фичи 01');
    change(SRS, 'D-02', 'D-01 фичи 02');
    regenerate();
    expectFinding('reference', 'фичи 02 нет');
  });

  it('ссылка файл:строка: файла нет или строка за пределами', () => {
    change(SRS, 'действие (D-01).', 'действие (D-01), `src/a.ts:3`, `src/a.ts:4`, `src/ghost.ts:1`, `src/a.ts:2-9`.');
    regenerate();
    const found = rules().filter((line) => line.startsWith('line-ref:'));
    assert.equal(found.length, 3, JSON.stringify(found));
    expectFinding('line-ref', 'src/a.ts:4');
    expectFinding('line-ref', 'src/ghost.ts:1`: файла нет');
    expectFinding('line-ref', 'src/a.ts:2-9');
  });

  it('счётчики: нет, меньше и больше последнего номера, не номер', () => {
    put('docs/.req_counter/01.FR', '1000\n');
    expectFinding('counter', 'счётчик 1000, в корпусе последний номер 1001');
    put('docs/.req_counter/01.FR', '1005\n');
    expectFinding('counter', 'счётчик 1005, в корпусе последний номер 1001');
    put('docs/.req_counter/01.FR', 'abc\n');
    expectFinding('counter', 'не номер');
    fs.rmSync(path.join(root, 'docs/.req_counter/01.FR'));
    expectFinding('counter', 'нет счётчика');
    put('docs/.req_counter/01.FR', '1001\n');
    put('docs/.req_counter/05.FR', '5001\n');
    expectFinding('counter', 'а единиц в корпусе нет');
  });

  it('матрица: нет, устарела', () => {
    fs.rmSync(path.join(root, 'docs/04-verification/verification-matrix.md'));
    expectFinding('matrix', 'матрицы нет');
    regenerate();
    change(SRS, '### FR-1001 Действие', '### FR-1001 Другое действие');
    expectFinding('matrix', 'устарела');
    regenerate();
    assert.deepEqual(checkCorpus(root), []);
  });
});

describe('check-corpus: истории с критериями приёмки', () => {
  const STORY = 'docs/01-product/01-first/stories/ST-1001-action.md';
  const story = (ac: string, extra = 'id: ST-1001'): string => `${front(`${extra}\nfeature: 01-first\norigin: derived`)}# ST-1001 Действие\n\n## Acceptance Criteria\n\n${ac}\n`;
  const withStory = (ac: string, extra?: string): void => {
    validCorpus();
    put(STORY, story(ac, extra));
    put('docs/.req_counter/01.ST', '1001\n');
    regenerate();
  };
  it('история с критерием, закрывающим каждое требование фичи, проходит', () => {
    withStory('- **AC-1.** Дано: а. Когда: б. Тогда: в. [FR-1001]');
    assert.deepEqual(checkCorpus(root), []);
  });
  it('метка на несуществующее требование - находка', () => {
    withStory('- **AC-1.** Тогда: в. [FR-1001] [FR-1999]');
    expectFinding('story', 'FR-1999');
  });
  it('метка на требование другой фичи - находка', () => {
    withStory('- **AC-1.** Тогда: в. [FR-1001]');
    put('docs/01-product/02-second/srs.md', `${front('feature: 02-second')}# SRS\n\n### FR-2001 Другое\n\n- **Требование:** х.\n- **traced from:** BR-001.\n- **verification:** испытание - \`test/a.test.ts\`.\n`);
    put('docs/.req_counter/02.FR', '2001\n');
    put('docs/.req_counter/feature', '2\n');
    put(STORY, story('- **AC-1.** Тогда: в. [FR-1001] [FR-2001]'));
    regenerate();
    expectFinding('story', 'требование из другой фичи');
  });
  it('у фичи с историями требование без критерия - находка', () => {
    withStory('- **AC-1.** Тогда: в. [FR-1001]');
    change(SRS, '## 13. Usability', '### FR-1002 Ещё\n\n- **Требование:** ещё.\n- **traced from:** BR-1001.\n- **verification:** испытание - `test/a.test.ts`.\n\n## 13. Usability');
    put('docs/.req_counter/01.FR', '1002\n');
    regenerate();
    expectFinding('story', 'FR-1002: у фичи есть истории, но ни один критерий его не закрывает');
  });
  it('критерии без меток - находка', () => {
    withStory('- **AC-1.** Тогда: в.');
    expectFinding('story', 'ни один критерий не несёт метки');
  });
  it('id не совпадает с именем файла либо с диапазоном фичи - находка', () => {
    withStory('- **AC-1.** Тогда: в. [FR-1001]', 'id: ST-1002');
    expectFinding('story', 'не совпадает с началом имени файла');
    withStory('- **AC-1.** Тогда: в. [FR-1001]', 'id: ST-2001');
    expectFinding('story', 'не совпадает с началом имени файла');
  });
  it('счётчик ST расходится с корпусом - находка', () => {
    withStory('- **AC-1.** Тогда: в. [FR-1001]');
    put('docs/.req_counter/01.ST', '1000\n');
    expectFinding('counter', 'счётчик 1000, в корпусе последний номер 1001');
  });
});
