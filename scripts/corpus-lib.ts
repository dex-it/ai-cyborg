// Проверка согласованности корпуса docs/ с самим собой и с репозиторием и матрица верификации требований. Запуск - scripts/check-corpus.ts.
// Без зависимостей: Node 24 запускает TypeScript напрямую; модуль без import.meta, чтобы его собирал в тесты esbuild (cjs).
import fs from 'node:fs';
import path from 'node:path';

export interface Finding {
  rule: string;
  file: string;
  message: string;
}

export interface Requirement {
  id: string;
  title: string;
  kind: 'FR' | 'NFR';
  feature: string;
  file: string;
  tracedFrom: string;
  verification: string;
}

interface Heading {
  kind: 'BR' | 'FR' | 'NFR';
  id: string;
  number: number;
  title: string;
  body: string;
}

interface Doc {
  file: string;
  text: string;
  front: Record<string, string>;
}

export const MATRIX_FILE = 'docs/04-verification/verification-matrix.md';
const STATUSES = new Set(['review', 'approved']);
const ADR_SECTION = '## Расхождения с текущим кодом';
// Требования, которые автотестом не проверяются: замер на приватном GitLab у владельца (RESEARCH, Issue #10).
const MANUAL = /npm run measure|вручную/i;

const read = (root: string, file: string): string => fs.readFileSync(path.join(root, file), 'utf8');
const exists = (root: string, file: string): boolean => fs.existsSync(path.join(root, file));

function listDir(root: string, dir: string): string[] {
  try {
    return fs.readdirSync(path.join(root, dir));
  } catch {
    return [];
  }
}

function frontMatter(text: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const front: Record<string, string> = {};
  for (const line of (match?.[1] ?? '').split('\n')) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) front[kv[1]] = kv[2].trim();
  }
  return front;
}

function load(root: string, file: string): Doc {
  const text = read(root, file);
  return { file, text, front: frontMatter(text) };
}

/** Заголовки `### BR-/FR-/NFR-NNNN Название` и их тела до следующего заголовка. */
function headings(text: string): Heading[] {
  const found: Heading[] = [];
  const re = /^### (BR|FR|NFR)-(\d+) (.+)$/gm;
  const marks: { index: number; end: number; kind: Heading['kind']; digits: string; title: string }[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    marks.push({ index: m.index, end: m.index + m[0].length, kind: m[1] as Heading['kind'], digits: m[2], title: m[3] });
  }
  const next = (from: number): number => {
    const h = /^#{1,3} /gm;
    h.lastIndex = from;
    const m = h.exec(text);
    return m ? m.index : text.length;
  };
  for (const mark of marks) {
    found.push({ kind: mark.kind, id: `${mark.kind}-${mark.digits}`, number: Number(mark.digits), title: mark.title.trim(), body: text.slice(mark.end, next(mark.end)) });
  }
  return found;
}

/** Поле единицы `- **имя:** значение` (значение продолжается строками с отступом до следующего поля). */
function field(body: string, name: string): string | undefined {
  const lines = body.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`- **${name}:**`));
  if (start < 0) return undefined;
  const out = [lines[start].slice(`- **${name}:**`.length)];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^- \*\*/.test(lines[i]) || /^\S/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

const featureOf = (dir: string): string => dir.slice(0, 2);
const featureOfNumber = (n: number): string => String(Math.floor(n / 1000)).padStart(2, '0');

interface Corpus {
  features: string[];
  docs: Doc[];
  adrs: Doc[];
  headings: Map<string, { feature: string; file: string; heading: Heading }>;
  decisions: Map<string, Set<string>>;
  productBr: Heading[];
}

function loadCorpus(root: string): Corpus {
  const docs: Doc[] = [];
  const features = listDir(root, 'docs/01-product').filter((name) => /^\d\d-/.test(name)).sort();
  if (exists(root, 'docs/01-product/brd.md')) docs.push(load(root, 'docs/01-product/brd.md'));
  for (const dir of features) {
    for (const name of ['brd-feat.md', 'srs.md', 'decision-log.md']) {
      const file = `docs/01-product/${dir}/${name}`;
      if (exists(root, file)) docs.push(load(root, file));
    }
  }
  const adrs = listDir(root, 'docs/03-architecture/adr')
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => load(root, `docs/03-architecture/adr/${name}`));
  const index = new Map<string, { feature: string; file: string; heading: Heading }>();
  const decisions = new Map<string, Set<string>>();
  let productBr: Heading[] = [];
  for (const doc of docs) {
    const dir = /docs\/01-product\/(\d\d)-/.exec(doc.file);
    const feature = dir ? dir[1] : '';
    if (doc.file.endsWith('decision-log.md')) {
      const ids = new Set<string>();
      for (const m of doc.text.matchAll(/^\| (D-\d+) \|/gm)) ids.add(m[1]);
      decisions.set(feature, ids);
      continue;
    }
    const hs = headings(doc.text);
    if (doc.file === 'docs/01-product/brd.md') productBr = hs;
    for (const heading of hs) if (!index.has(heading.id)) index.set(heading.id, { feature, file: doc.file, heading });
  }
  return { features, docs, adrs, headings: index, decisions, productBr };
}

function checkFrontMatter(corpus: Corpus, out: Finding[]): void {
  for (const doc of [...corpus.docs, ...corpus.adrs]) {
    if (!doc.text.startsWith('---\n')) {
      out.push({ rule: 'front-matter', file: doc.file, message: 'нет front matter' });
      continue;
    }
    if (!STATUSES.has(doc.front.status ?? '')) out.push({ rule: 'status', file: doc.file, message: `status «${doc.front.status ?? ''}» не из review, approved` });
    if (!/^\d{4}-\d\d-\d\d$/.test(doc.front.date ?? '')) out.push({ rule: 'front-matter', file: doc.file, message: `date «${doc.front.date ?? ''}» не вида ГГГГ-ММ-ДД` });
    const dir = /docs\/01-product\/(\d\d-[^/]+)\//.exec(doc.file);
    if (dir && doc.front.feature !== dir[1]) out.push({ rule: 'front-matter', file: doc.file, message: `feature «${doc.front.feature ?? ''}» не совпадает с каталогом ${dir[1]}` });
  }
}

function checkAdrs(corpus: Corpus, out: Finding[]): void {
  let expected = 1;
  for (const doc of corpus.adrs) {
    const name = path.basename(doc.file);
    const fromName = /^ADR-(\d{4})-/.exec(name);
    if (!fromName) {
      out.push({ rule: 'adr', file: doc.file, message: 'имя файла не вида ADR-NNNN-слаг.md' });
      continue;
    }
    const number = Number(fromName[1]);
    if (doc.front.id !== `ADR-${fromName[1]}`) out.push({ rule: 'adr', file: doc.file, message: `id «${doc.front.id ?? ''}» не совпадает с именем файла` });
    if (number !== expected) out.push({ rule: 'adr', file: doc.file, message: `номер ${fromName[1]}, ожидался ${String(expected).padStart(4, '0')}: нумерация идёт подряд` });
    expected = number + 1;
    if (!doc.text.includes(ADR_SECTION)) out.push({ rule: 'adr', file: doc.file, message: `нет раздела «${ADR_SECTION.slice(3)}»` });
  }
}

function checkUnits(corpus: Corpus, out: Finding[]): void {
  const seen = new Map<string, string>();
  for (const doc of corpus.docs) {
    const dir = /docs\/01-product\/(\d\d)-/.exec(doc.file);
    if (!dir || doc.file.endsWith('decision-log.md')) continue;
    for (const h of headings(doc.text)) {
      const first = seen.get(h.id);
      if (first) out.push({ rule: 'unit', file: doc.file, message: `${h.id} заведён повторно (первый раз - ${first})` });
      else seen.set(h.id, doc.file);
      if (featureOfNumber(h.number) !== dir[1]) out.push({ rule: 'unit', file: doc.file, message: `${h.id} не из диапазона фичи ${dir[1]}` });
    }
  }
}

function checkRequirements(root: string, corpus: Corpus, out: Finding[]): void {
  const tracedBr = new Set<string>();
  for (const doc of corpus.docs) {
    if (!doc.file.endsWith('srs.md')) continue;
    for (const h of headings(doc.text)) {
      if (h.kind === 'BR') continue;
      const verification = field(h.body, 'verification');
      if (!verification) out.push({ rule: 'verification', file: doc.file, message: `${h.id}: нет поля verification` });
      else checkTestFiles(root, doc.file, h.id, verification, out);
      const traced = field(h.body, 'traced from');
      if (!traced) {
        out.push({ rule: 'traced-from', file: doc.file, message: `${h.id}: нет поля traced from` });
        continue;
      }
      const brs = [...traced.matchAll(/\bBR-\d+\b/g)].map((m) => m[0]);
      if (!brs.length) out.push({ rule: 'traced-from', file: doc.file, message: `${h.id}: traced from не называет BR` });
      for (const br of brs) {
        tracedBr.add(br);
        if (!corpus.headings.has(br)) out.push({ rule: 'traced-from', file: doc.file, message: `${h.id}: ${br} нет в корпусе` });
      }
    }
  }
  for (const doc of corpus.docs) {
    if (!doc.file.endsWith('brd-feat.md')) continue;
    for (const h of headings(doc.text)) if (h.kind === 'BR' && !tracedBr.has(h.id)) out.push({ rule: 'traced-from', file: doc.file, message: `${h.id}: ни одно требование на него не ссылается` });
  }
}

/** Пути тестов и скриптов из verification существуют. */
function checkTestFiles(root: string, file: string, id: string, verification: string, out: Finding[]): void {
  for (const m of verification.matchAll(/`((?:test|src|scripts)\/[\w./-]+\.(?:ts|mjs))`/g)) {
    if (!exists(root, m[1])) out.push({ rule: 'verification', file, message: `${id}: файл ${m[1]} из verification не найден` });
  }
}

function checkReferences(root: string, corpus: Corpus, out: Finding[]): void {
  const features = new Set(corpus.features.map(featureOf));
  for (const doc of [...corpus.docs, ...corpus.adrs]) {
    for (const m of doc.text.matchAll(/\b(NFR|FR)-(\d{4,5})\b/g)) {
      if (!corpus.headings.has(`${m[1]}-${m[2]}`)) out.push({ rule: 'reference', file: doc.file, message: `${m[0]} не заведён` });
    }
    for (const m of doc.text.matchAll(/\bBR-(\d+)\b/g)) {
      if (!corpus.headings.has(m[0])) out.push({ rule: 'reference', file: doc.file, message: `${m[0]} не заведён` });
    }
    for (const m of doc.text.matchAll(/\bADR-(\d{4})\b/g)) {
      if (!corpus.adrs.some((a) => a.front.id === m[0])) out.push({ rule: 'reference', file: doc.file, message: `${m[0]} не заведён` });
    }
    for (const m of doc.text.matchAll(/`([\w./-]+\.(?:ts|mjs|json|yml|sh)):(\d+)(?:-(\d+))?`/g)) {
      const [, file, from, to] = m;
      if (!exists(root, file)) {
        out.push({ rule: 'line-ref', file: doc.file, message: `${m[0]}: файла нет` });
        continue;
      }
      const lines = read(root, file).split('\n');
      const last = lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
      if (Number(from) < 1 || Number(to ?? from) > last || Number(to ?? from) < Number(from)) out.push({ rule: 'line-ref', file: doc.file, message: `${m[0]}: строка за пределами файла (${last} строк)` });
    }
  }
  // Решение D-NN: в SRS и BRD фичи - из её decision-log, с пометкой «фичи NN» - из decision-log названной фичи.
  for (const doc of corpus.docs) {
    const dir = /docs\/01-product\/(\d\d)-/.exec(doc.file);
    if (!dir || doc.file.endsWith('decision-log.md')) continue;
    // Хвост до конца фразы (точка, перенос, «;», «)») может назвать другую фичу: «D-27 и D-28 фичи 02» - обе из журнала фичи 02.
    for (const m of doc.text.matchAll(/\bD-(\d+)(?=([^.\n;)]{0,60}))/g)) {
      const named = /(?:^|\s)фичи (\d\d)(?!\d)/.exec(m[2]);
      const owner = named ? named[1] : dir[1];
      if (named && !features.has(owner)) {
        out.push({ rule: 'reference', file: doc.file, message: `D-${m[1]} фичи ${owner}: фичи ${owner} нет` });
        continue;
      }
      if (!corpus.decisions.get(owner)?.has(`D-${m[1]}`)) out.push({ rule: 'reference', file: doc.file, message: `D-${m[1]} нет в decision-log фичи ${owner}` });
    }
  }
}

function checkCounters(root: string, corpus: Corpus, out: Finding[]): void {
  const counters = new Map<string, number>();
  for (const name of listDir(root, 'docs/.req_counter')) {
    const text = read(root, `docs/.req_counter/${name}`).trim();
    if (!/^\d+$/.test(text)) out.push({ rule: 'counter', file: `docs/.req_counter/${name}`, message: `«${text}»: не номер` });
    else counters.set(name, Number(text));
  }
  const maxima = new Map<string, number>();
  const bump = (key: string, n: number): void => void maxima.set(key, Math.max(maxima.get(key) ?? 0, n));
  for (const entry of corpus.headings.values()) {
    if (entry.file === 'docs/01-product/brd.md') bump('BR', entry.heading.number);
    else bump(`${entry.feature}.${entry.heading.kind}`, entry.heading.number);
  }
  for (const adr of corpus.adrs) bump('ADR', Number(/^ADR-(\d+)/.exec(adr.front.id ?? '')?.[1] ?? 0));
  bump('feature', Math.max(0, ...corpus.features.map((f) => Number(featureOf(f)))));
  for (const [key, max] of maxima) {
    const value = counters.get(key);
    if (value === undefined) out.push({ rule: 'counter', file: `docs/.req_counter/${key}`, message: `нет счётчика, в корпусе последний номер ${max}` });
    else if (value !== max) out.push({ rule: 'counter', file: `docs/.req_counter/${key}`, message: `счётчик ${value}, в корпусе последний номер ${max}` });
  }
  for (const key of counters.keys()) {
    if (!maxima.has(key) && counters.get(key) !== 0) out.push({ rule: 'counter', file: `docs/.req_counter/${key}`, message: `счётчик ${counters.get(key)}, а единиц в корпусе нет` });
  }
}

export function requirements(root: string): Requirement[] {
  const corpus = loadCorpus(root);
  const list: Requirement[] = [];
  for (const doc of corpus.docs) {
    const dir = /docs\/01-product\/(\d\d-[^/]+)\//.exec(doc.file);
    if (!dir || !doc.file.endsWith('srs.md')) continue;
    for (const h of headings(doc.text)) {
      if (h.kind === 'BR') continue;
      list.push({
        id: h.id,
        title: h.title,
        kind: h.kind,
        feature: dir[1],
        file: doc.file,
        tracedFrom: field(h.body, 'traced from') ?? '',
        verification: field(h.body, 'verification') ?? '',
      });
    }
  }
  return list.sort((a, b) => Number(a.id.replace(/\D/g, '')) - Number(b.id.replace(/\D/g, '')));
}

/** Уровни проверки по тексту verification: автотест (названы `*.test.ts`), smoke (дымовой тест окна), ручная (замер у владельца). */
export function levelOf(verification: string): string {
  const levels: string[] = [];
  if (/`(?:test|src)\/[\w./-]+\.test\.ts`/.test(verification)) levels.push('автотест');
  if (/`scripts\/smoke\.mjs`/.test(verification)) levels.push('smoke');
  if (MANUAL.test(verification)) levels.push('ручная');
  return levels.length ? levels.join(' + ') : 'осмотр и демонстрация';
}

function testFiles(verification: string): string[] {
  return [...new Set([...verification.matchAll(/`((?:test|src|scripts)\/[\w./-]+\.(?:test\.ts|mjs))`/g)].map((m) => m[1]))];
}

export function buildMatrix(root: string): string {
  const rows = requirements(root).map((r) => {
    const files = testFiles(r.verification).map((f) => `\`${f}\``).join(', ') || '-';
    return `| ${r.id} | ${r.title.replace(/\|/g, '/')} | ${r.feature} | ${levelOf(r.verification)} | ${files} |`;
  });
  const all = requirements(root);
  const count = (level: string): number => all.filter((r) => levelOf(r.verification).split(' + ').includes(level)).length;
  const demo = all.filter((r) => levelOf(r.verification) === 'осмотр и демонстрация').length;
  return [
    '---',
    'status: review',
    'date: 2026-10-26',
    '---',
    '',
    '# Матрица верификации требований',
    '',
    'Сформирована `npm run corpus:matrix` из полей `verification` SRS фич; руками не правится, CI проверяет, что она не устарела.',
    'Уровень выводится из текста: `автотест` - названы файлы `*.test.ts`; `smoke` - назван `scripts/smoke.mjs`; `ручная` - замер у владельца',
    '(`npm run measure`); `осмотр и демонстрация` - ничего из перечисленного. Уровни складываются: `автотест + smoke`.',
    '',
    `Требований: ${all.length}; с автотестом - ${count('автотест')}, из них со smoke - ${all.filter((r) => levelOf(r.verification) === 'автотест + smoke').length}; только smoke - ${all.filter((r) => levelOf(r.verification) === 'smoke').length}; ручная - ${count('ручная')}; только осмотр и демонстрация - ${demo}.`,
    '',
    '| Требование | Название | Фича | Уровень | Файлы |',
    '|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

function checkMatrix(root: string, out: Finding[]): void {
  if (!exists(root, MATRIX_FILE)) {
    out.push({ rule: 'matrix', file: MATRIX_FILE, message: 'матрицы нет: npm run corpus:matrix' });
    return;
  }
  if (read(root, MATRIX_FILE) !== buildMatrix(root)) out.push({ rule: 'matrix', file: MATRIX_FILE, message: 'матрица устарела: npm run corpus:matrix' });
}

export function checkCorpus(root: string): Finding[] {
  const out: Finding[] = [];
  const corpus = loadCorpus(root);
  checkFrontMatter(corpus, out);
  checkAdrs(corpus, out);
  checkUnits(corpus, out);
  checkRequirements(root, corpus, out);
  checkReferences(root, corpus, out);
  checkCounters(root, corpus, out);
  checkMatrix(root, out);
  return out;
}

export function writeMatrix(root: string): void {
  fs.mkdirSync(path.join(root, path.dirname(MATRIX_FILE)), { recursive: true });
  fs.writeFileSync(path.join(root, MATRIX_FILE), buildMatrix(root));
}
