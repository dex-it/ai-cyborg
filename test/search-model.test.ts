import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compileMatcher, lineSummary, matchFiles, moveActive, resultSummary, MAX_PATTERN_LENGTH, type FileEntry, type SearchOptions } from '../src/renderer/search-model';

const plain: SearchOptions = { regex: false, caseSensitive: false, wholeWord: false };
const matcher = (query: string, options: SearchOptions = plain) => {
  const m = compileMatcher(query, options);
  assert.ok(m.ok, 'выражение разобрано');
  return m;
};

describe('compileMatcher: подстрока', () => {
  it('часть имени без учёта регистра, с границами совпадения', () => {
    assert.deepEqual(matcher('A.T').match('data.txt'), { start: 3, end: 6 });
    assert.deepEqual(matcher('a.T').match('Data.txt'), { start: 3, end: 6 });
    assert.equal(matcher('A.T').match('data.xml'), null);
    assert.deepEqual(matcher('TXT').match('data.txt'), { start: 5, end: 8 });
  });

  it('с учётом регистра', () => {
    const exact: SearchOptions = { ...plain, caseSensitive: true };
    assert.equal(matcher('Data', exact).match('data.txt'), null);
    assert.deepEqual(matcher('data', exact).match('data.txt'), { start: 0, end: 4 });
  });

  it('знаки регулярного выражения в подстроке - обычные знаки', () => {
    assert.deepEqual(matcher('a.t').match('a.txt'), { start: 0, end: 3 });
    assert.equal(matcher('a.t').match('abtxt'), null);
  });
});

describe('compileMatcher: целое слово', () => {
  const word: SearchOptions = { ...plain, wholeWord: true };

  it('совпадение не примыкает к буквам, цифрам и подчёркиванию, кириллица тоже', () => {
    assert.deepEqual(matcher('main', word).match('the main.ts'), { start: 4, end: 8 });
    assert.equal(matcher('main', word).match('domain.ts'), null);
    assert.equal(matcher('main', word).match('main_x.ts'), null);
    assert.equal(matcher('main', word).match('main2.ts'), null);
    assert.deepEqual(matcher('мир', word).match('Привет мир'), { start: 7, end: 10 });
    assert.equal(matcher('мир', word).match('мирный'), null);
  });

  it('знаки выражения в слове - обычные знаки; регистр по переключателю', () => {
    assert.deepEqual(matcher('a.b', word).match('see a.b!'), { start: 4, end: 7 });
    assert.equal(matcher('a.b', word).match('axb'), null);
    assert.equal(matcher('Main', { ...word, caseSensitive: true }).match('main'), null);
  });

  it('с выражением: слово вокруг всего выражения', () => {
    const both: SearchOptions = { ...word, regex: true };
    assert.deepEqual(matcher('v\\d+', both).match('ver v12 end'), { start: 4, end: 7 });
    assert.equal(matcher('v\\d+', both).match('rev12'), null);
    assert.equal(matcher('v\\d', both).match('v12'), null, 'выражение не должно оборваться посреди слова');
  });
});

describe('compileMatcher: регулярное выражение', () => {
  const re: SearchOptions = { ...plain, regex: true };

  it('находит по выражению и отдаёт границы', () => {
    assert.deepEqual(matcher('\\d+', re).match('file12.ts'), { start: 4, end: 6 });
    assert.deepEqual(matcher('^read', re).match('README.md'), { start: 0, end: 4 });
    assert.equal(matcher('^me', re).match('README.md'), null);
  });

  it('регистр: без учёта по умолчанию, с учётом по переключателю', () => {
    assert.ok(matcher('readme', re).match('README.md'));
    assert.equal(matcher('readme', { ...plain, regex: true, caseSensitive: true }).match('README.md'), null);
  });

  it('негодное выражение - сообщение, а не исключение', () => {
    const m = compileMatcher('(', re);
    assert.equal(m.ok, false);
    if (!m.ok) assert.match(m.error, /^Выражение не разобрано: /);
  });

  it('слишком длинное и с квантором над группой с квантором отклоняется', () => {
    const long = compileMatcher('a'.repeat(MAX_PATTERN_LENGTH + 1), re);
    assert.equal(long.ok, false);
    for (const bad of ['(a+)+$', '(.*)*x', '(a|b*)+', '(\\d+)*', '(a+){2,}']) {
      const m = compileMatcher(bad, re);
      assert.equal(m.ok, false, bad);
    }
    for (const good of ['(ab)+', 'a+b*', '(\\(a)+', '[+*]+', '(?:ab|cd)+x']) assert.ok(compileMatcher(good, re).ok, good);
  });

  it('вредное выражение не зависает: отклонено до первого разбора', () => {
    const started = Date.now();
    assert.equal(compileMatcher('(a+)+$', re).ok, false);
    assert.ok(Date.now() - started < 100);
  });
});

describe('matchFiles', () => {
  const entries: FileEntry[] = [
    { root: 0, rel: 'src/deep/readme.md' },
    { root: 0, rel: 'README.md' },
    { root: 1, rel: 'docs/old-readme.txt' },
    { root: 0, rel: 'src/a.ts' },
    { root: 0, rel: 'dir/readme/inner.txt' },
  ];

  it('ищет в имени, а не в пути', () => {
    const { hits } = matchFiles(entries, matcher('readme'), 10);
    assert.deepEqual(hits.map((h) => h.rel), ['README.md', 'src/deep/readme.md', 'docs/old-readme.txt']);
  });

  it('начало имени идёт вперёд, затем короткие пути, затем алфавит', () => {
    const list: FileEntry[] = ['z/aab.txt', 'xab.txt', 'ab.txt', 'b/ab2.txt', 'a/ab1.txt'].map((rel) => ({ root: 0, rel }));
    assert.deepEqual(matchFiles(list, matcher('ab'), 10).hits.map((h) => h.rel), ['ab.txt', 'a/ab1.txt', 'b/ab2.txt', 'xab.txt', 'z/aab.txt']);
  });

  it('предел: возвращает первые limit и общее число', () => {
    const many: FileEntry[] = Array.from({ length: 30 }, (_, i) => ({ root: 0, rel: `f${String(i).padStart(2, '0')}.txt` }));
    const { hits, total } = matchFiles(many, matcher('f'), 10);
    assert.equal(hits.length, 10);
    assert.equal(total, 30);
  });

  it('совпадение несёт имя и границы в имени', () => {
    const [hit] = matchFiles([{ root: 2, rel: 'a/b/Main.ts' }], matcher('ain'), 5).hits;
    assert.deepEqual({ root: hit.root, name: hit.name, range: hit.range }, { root: 2, name: 'Main.ts', range: { start: 1, end: 4 } });
  });

  it('без совпадений - пусто', () => {
    assert.deepEqual(matchFiles(entries, matcher('нет-такого'), 5), { hits: [], total: 0 });
  });
});

describe('resultSummary и moveActive', () => {
  it('подпись: нет, все, часть', () => {
    assert.equal(resultSummary(0, 0), 'Нет совпадений');
    assert.equal(resultSummary(3, 3), 'Найдено 3');
    assert.equal(resultSummary(500, 620), 'Найдено 620, показаны первые 500');
  });

  it('подпись поиска по строкам', () => {
    assert.equal(lineSummary(0, false), 'Нет совпадений');
    assert.equal(lineSummary(7, false), 'Найдено 7');
    assert.equal(lineSummary(500, true), 'Показаны первые 500, уточните запрос');
  });

  it('стрелки идут по кругу, прочие клавиши и пустой список - null', () => {
    assert.equal(moveActive('ArrowDown', 0, 3), 1);
    assert.equal(moveActive('ArrowDown', 2, 3), 0);
    assert.equal(moveActive('ArrowUp', 0, 3), 2);
    assert.equal(moveActive('Enter', 0, 3), null);
    assert.equal(moveActive('ArrowDown', 0, 0), null);
  });
});
