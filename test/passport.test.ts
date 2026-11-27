import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CAPABILITIES, GROUPS, dotText, dotTitle, fileReasons } from '../src/shared/passport';
import { PassportService, docLinkOk, fixPrompt, loadState, parseState, probeOutcome, saveState, sourceResolves, validateAction, validateCloseItem, validateProbeReport } from '../src/main/passport';
import { gitCommonDir } from '../src/main/git';
import { sessionTools } from '../src/main/session-tools';
import { fixAction } from '../src/renderer/passport-fix';

function fixture(t: import('node:test').TestContext, repos = 1, sessionTree?: (sessionId: number, repo: string) => Promise<string>) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-passport-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dirs: string[] = [];
  for (let i = 0; i < repos; i++) {
    const dir = path.join(base, `repo${i}`);
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs', 'a.md'), 'one\ntwo\nthree\n');
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    execFileSync('git', ['-C', dir, 'add', '.']);
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']);
    dirs.push(dir);
  }
  const events: { channel: string; payload: unknown }[] = [];
  const service = new PassportService({
    projects: () => [{ id: 'p', name: 'P', description: '', repos: dirs, trackers: { github: false, gitlab: false } }],
    localFile: path.join(base, 'passport-local.json'),
    emit: (channel, payload) => events.push({ channel, payload }),
    claudeAvailable: async () => true,
    sessionTree,
  });
  const passportDir = (repo: string) => path.join(repo, '.cyborg', 'passport');
  const put = (repo: string, name: string, text: string) => {
    fs.mkdirSync(passportDir(repo), { recursive: true });
    fs.writeFileSync(path.join(passportDir(repo), name), text);
  };
  const porcelain = (repo: string) => execFileSync('git', ['-C', repo, 'status', '--porcelain', '-uall'], { encoding: 'utf8' });
  return { base, dirs, service, events, put, passportDir, porcelain };
}

// docs/a.md есть в каждом репозитории фикстуры; путь - от каталога паспорта.
const DOC = '[Док](../../docs/a.md)';

test('перечень: двенадцать способностей в четырёх группах, файлы без повторов', () => {
  assert.equal(CAPABILITIES.length, 12);
  assert.deepEqual(GROUPS.map((g) => g.id), ['product', 'tech', 'work', 'upkeep']);
  assert.equal(new Set(CAPABILITIES.map((c) => c.file)).size, 12);
  assert.equal(new Set(CAPABILITIES.map((c) => c.id)).size, 12);
});

test('пробел по файлу: нет файла, пуст, ⚠, неподтверждённое ≈', () => {
  assert.deepEqual(fileReasons(null, false, false), ['missing']);
  assert.deepEqual(fileReasons('  \n', false, false), ['empty']);
  assert.deepEqual(fileReasons('текст ⚠', false, true), ['warn']);
  assert.deepEqual(fileReasons('текст ≈', false, true), ['approx']);
  assert.deepEqual(fileReasons('текст ≈', true, true), []);
  assert.deepEqual(fileReasons('⚠ и ≈', false, true), ['warn', 'approx']);
  assert.deepEqual(fileReasons('всё хорошо', false, true), []);
  assert.deepEqual(fileReasons('нет ссылки', false, false), ['nolink']);
});

test('точка: число, «99+», «✓», «–», «…» и подсказки', () => {
  assert.equal(dotText('gaps', 4), '4');
  assert.equal(dotText('gaps', 100), '99+');
  assert.equal(dotText('clear', 0), '✓');
  assert.equal(dotText('unchecked', 0), '–');
  assert.equal(dotText('checking', 0), '…');
  assert.equal(dotTitle('gaps', 1), 'Паспорт проекта: 1 пробел');
  assert.equal(dotTitle('gaps', 3), 'Паспорт проекта: 3 пробела');
  assert.equal(dotTitle('gaps', 12), 'Паспорт проекта: 12 пробелов');
  assert.equal(dotTitle('clear', 0), 'Паспорт проекта: пробелов нет');
});

test('проект без каталога паспорта: пробелами считаются все двенадцать способностей', async (t) => {
  const f = fixture(t);
  const view = await f.service.view('p');
  assert.equal(view.count, 12);
  assert.equal(view.level, 'gaps');
  assert.ok(view.capabilities.every((c) => c.reasons.includes('файла нет')));
});

test('проверка файлов: четыре причины, подтверждение ≈ пишется в состояние, файл не меняется, изменение файла снимает подтверждение', async (t) => {
  const f = fixture(t);
  const [repo] = f.dirs;
  for (const cap of CAPABILITIES) f.put(repo, cap.file, `${DOC}\n`);
  f.put(repo, 'why.md', '');
  f.put(repo, 'behavior.md', `${DOC} ⚠`);
  f.put(repo, 'done.md', `${DOC} ≈`);
  fs.rmSync(path.join(f.passportDir(repo), 'domain.md'));
  const reasons = (view: Awaited<ReturnType<typeof f.service.view>>, id: string) => view.capabilities.find((c) => c.id === id)!.reasons;
  let view = await f.service.view('p');
  assert.equal(view.count, 4);
  assert.deepEqual(reasons(view, 'why'), ['файл пуст']);
  assert.deepEqual(reasons(view, 'behavior'), ['есть ⚠']);
  assert.deepEqual(reasons(view, 'done'), ['≈ не подтверждено']);
  assert.deepEqual(reasons(view, 'domain'), ['файла нет']);
  const before = fs.readFileSync(path.join(f.passportDir(repo), 'done.md'), 'utf8');
  view = await f.service.act('p', { op: 'confirmApprox', capability: 'done', repo });
  assert.equal(view.count, 3);
  assert.equal(fs.readFileSync(path.join(f.passportDir(repo), 'done.md'), 'utf8'), before);
  const status = f.porcelain(repo);
  assert.match(status, /\.cyborg\/passport\//);
  f.put(repo, 'done.md', `${DOC} ≈ изменён`);
  view = await f.service.view('p');
  assert.deepEqual(reasons(view, 'done'), ['≈ не подтверждено']);
});

test('ссылка паспорта (от каталога паспорта или от корня): нужен существующий файл или каталог проекта, не URL, не сам паспорт и не выход за репозиторий', async (t) => {
  const f = fixture(t);
  const [repo] = f.dirs;
  fs.writeFileSync(path.join(repo, 'outside-target.md'), 'x');
  const outside = path.join(f.base, 'out.md');
  fs.writeFileSync(outside, 'x');
  f.put(repo, 'why.md', 'x');
  assert.equal(await docLinkOk(repo, 'просто текст без ссылки'), false);
  assert.equal(await docLinkOk(repo, '[сайт](https://example.com/docs/a.md)'), false);
  assert.equal(await docLinkOk(repo, '[нет](../../docs/none.md)'), false);
  assert.equal(await docLinkOk(repo, '[сам паспорт](why.md)'), false);
  assert.equal(await docLinkOk(repo, '[корень](../..)'), false);
  assert.equal(await docLinkOk(repo, '[наружу](../../../out.md)'), false);
  assert.equal(await docLinkOk(repo, '[файл](../../docs/a.md#L2)'), true);
  assert.equal(await docLinkOk(repo, '[от корня](docs/a.md)'), true);
  assert.equal(await docLinkOk(repo, '[от корня со слэшем](/docs/a.md)'), true);
  assert.equal(await docLinkOk(repo, '[от корня нет](docs/none.md)'), false);
  assert.equal(await docLinkOk(repo, '[каталог паспорта от корня](.cyborg/passport/why.md)'), false);
  assert.equal(await docLinkOk(repo, '[наружу от корня](../out.md)'), false);
  assert.equal(await docLinkOk(repo, '[каталог](../../docs)'), true);
  assert.equal(await docLinkOk(repo, 'сначала [нет](../../x.md), потом [есть](../../docs/a.md)'), true);
  f.put(repo, 'why.md', 'описание без единой ссылки');
  const view = await f.service.view('p');
  assert.deepEqual(view.capabilities.find((c) => c.id === 'why')!.reasons, ['нет ссылки на документ проекта']);
});

test('найденный ответ пробы заменяет файл: принятый человеком снимает и метки, непринятый смысловой ждёт подтверждения', async (t) => {
  const f = fixture(t);
  const [repo] = f.dirs;
  f.put(repo, 'why.md', 'описание без ссылки ⚠');
  const state = { version: 1, approxConfirmed: {}, notNeeded: [], probe: { at: 'x', outcomes: {
    why: { outcome: 'found', answer: 'a', source: 'docs/a.md:1', confirmed: true },
    done: { outcome: 'found', answer: 'a', source: 'docs/a.md:1' },
    behavior: { outcome: 'found', answer: 'a', source: 'docs/a.md:1' },
    domain: { outcome: 'unknown', answer: 'a', source: '' },
  } } };
  f.put(repo, 'state.json', JSON.stringify(state));
  const view = await f.service.view('p');
  const reasons = (id: string) => view.capabilities.find((c) => c.id === id)!.reasons;
  assert.deepEqual(reasons('why'), []);
  assert.deepEqual(reasons('done'), ['ждёт подтверждения']);
  assert.deepEqual(reasons('behavior'), []);
  assert.deepEqual(reasons('domain'), ['файла нет', 'не знает']);
});

test('«Не нужно»: способность снята и не считается, «Нужно» возвращает, запись только в .cyborg/passport/', async (t) => {
  const f = fixture(t);
  const [repo] = f.dirs;
  for (const cap of CAPABILITIES) f.put(repo, cap.file, DOC);
  fs.rmSync(path.join(f.passportDir(repo), 'upkeep.md'));
  assert.equal((await f.service.view('p')).count, 1);
  let view = await f.service.act('p', { op: 'notNeeded', capability: 'upkeep' });
  assert.equal(view.count, 0);
  assert.equal(view.level, 'clear');
  assert.equal(view.capabilities.find((c) => c.id === 'upkeep')!.notNeeded, true);
  const lines = f.porcelain(repo).trim().split('\n').filter((l) => !l.includes('.cyborg/passport/'));
  assert.deepEqual(lines, []);
  view = await f.service.act('p', { op: 'needed', capability: 'upkeep' });
  assert.equal(view.count, 1);
});

test('состояние: повреждённый файл не читается как пустой и не затирается записью', (t) => {
  const f = fixture(t);
  const [repo] = f.dirs;
  fs.mkdirSync(f.passportDir(repo), { recursive: true });
  fs.writeFileSync(path.join(f.passportDir(repo), 'state.json'), '{ не json');
  assert.ok(loadState(repo).problem);
  assert.throws(() => saveState(repo, (s) => s.notNeeded.push('why')), /запись не выполнена/);
  assert.equal(fs.readFileSync(path.join(f.passportDir(repo), 'state.json'), 'utf8'), '{ не json');
  assert.equal(typeof parseState('[]'), 'string');
});

test('символьная ссылка на месте каталога паспорта или state.json: не читается и не пишется', (t) => {
  const f = fixture(t, 2);
  const [repo, other] = f.dirs;
  fs.mkdirSync(path.join(repo, '.cyborg'));
  fs.symlinkSync(other, path.join(repo, '.cyborg', 'passport'));
  assert.match(String(loadState(repo).problem), /символьная ссылка/);
  assert.throws(() => saveState(repo, (s) => s.notNeeded.push('why')), /запись не выполнена/);
  assert.deepEqual(fs.readdirSync(other).sort(), ['.git', 'docs']);
  const third = path.join(f.base, 'third');
  fs.mkdirSync(path.join(third, '.cyborg', 'passport'), { recursive: true });
  fs.writeFileSync(path.join(f.base, 'secret.json'), '{}');
  fs.symlinkSync(path.join(f.base, 'secret.json'), path.join(third, '.cyborg', 'passport', 'state.json'));
  assert.throws(() => saveState(third, (s) => s.notNeeded.push('why')), /запись не выполнена/);
  assert.equal(fs.readFileSync(path.join(f.base, 'secret.json'), 'utf8'), '{}');
});

test('состояние пишется с отсортированными ключами', (t) => {
  const f = fixture(t);
  const [repo] = f.dirs;
  saveState(repo, (s) => {
    s.approxConfirmed.why = 'b';
    s.approxConfirmed.done = 'a';
    s.notNeeded.push('upkeep', 'domain');
  });
  const text = fs.readFileSync(path.join(f.passportDir(repo), 'state.json'), 'utf8');
  assert.ok(text.indexOf('"done"') < text.indexOf('"why"'));
  assert.deepEqual(loadState(repo).state.notNeeded, ['domain', 'upkeep']);
});

test('источник: файл есть, каталог, строка за концом, путь вне копии, символьная ссылка наружу', (t) => {
  const f = fixture(t);
  const [repo] = f.dirs;
  fs.symlinkSync('/etc/hostname', path.join(repo, 'link'));
  assert.equal(sourceResolves('docs/a.md', [repo]), true);
  assert.equal(sourceResolves('docs/a.md:3', [repo]), true);
  assert.equal(sourceResolves('docs/a.md:4', [repo]), false);
  assert.equal(sourceResolves('docs/a.md:0', [repo]), false);
  assert.equal(sourceResolves('docs', [repo]), false);
  assert.equal(sourceResolves('docs/нет.md', [repo]), false);
  assert.equal(sourceResolves('../outside', [repo]), false);
  assert.equal(sourceResolves('/etc/hostname', [repo]), false);
  assert.equal(sourceResolves('link', [repo]), false);
});

test('исход пробы: нашёл с источником, выдумывает, не знает', (t) => {
  const f = fixture(t);
  const repos = f.dirs;
  assert.equal(probeOutcome({ id: 'why', outcome: 'found', answer: 'a', source: 'docs/a.md:1' }, repos), 'found');
  assert.equal(probeOutcome({ id: 'why', outcome: 'found', answer: 'a', source: 'docs/нет.md' }, repos), 'invented');
  assert.equal(probeOutcome({ id: 'why', outcome: 'found', answer: 'a', source: '' }, repos), 'invented');
  assert.equal(probeOutcome({ id: 'why', outcome: 'unknown', answer: '', source: '' }, repos), 'unknown');
});

test('report_passport: проверка аргументов', () => {
  const ids = ['why', 'done'];
  assert.match(String(validateProbeReport({}, ids)), /массив/);
  assert.match(String(validateProbeReport({ capabilities: [{ id: 'nope', outcome: 'found' }] }, ids)), /не участвует/);
  assert.match(String(validateProbeReport({ capabilities: [{ id: 'why', outcome: 'found' }, { id: 'why', outcome: 'found' }] }, ids)), /дважды/);
  assert.match(String(validateProbeReport({ capabilities: [{ id: 'why', outcome: 'maybe' }] }, ids)), /outcome/);
  assert.match(String(validateProbeReport({ capabilities: [{ id: 'why', outcome: 'found' }] }, ids)), /done/);
  assert.equal(Array.isArray(validateProbeReport({ capabilities: [{ id: 'why', outcome: 'unknown' }, { id: 'done', outcome: 'found', answer: 'x', source: 'a' }] }, ids)), true);
});

test('проба: итог пишет исходы в состояние, смысловая ждёт подтверждения, «Подтвердить» и «Не то», файлы не тронуты', async (t) => {
  const f = fixture(t);
  const [repo] = f.dirs;
  for (const cap of CAPABILITIES) f.put(repo, cap.file, DOC);
  const probe = await f.service.prepareProbe('p');
  assert.equal(probe.cwd, repo);
  assert.match(probe.prompt, /report_passport/);
  f.service.registerProbe(7, probe.run);
  assert.equal(f.service.isProbe(7), true);
  await assert.rejects(f.service.prepareProbe('p'), /Проба идёт/);
  assert.throws(() => f.service.report(7, { capabilities: [{ id: 'why', outcome: 'unknown' }] }), /нет ответа/);
  assert.equal(f.service.isProbe(7), true);
  const all = CAPABILITIES.map((c) => ({ id: c.id, outcome: 'found', answer: 'ответ', source: 'docs/a.md:2' }));
  all[1] = { id: 'behavior', outcome: 'found', answer: 'выдумка', source: 'docs/нет.md' };
  all[3] = { id: 'domain', outcome: 'unknown', answer: '', source: '' } as (typeof all)[number];
  const text = f.service.report(7, { capabilities: all });
  assert.match(text, /нашёл с источником 10, выдумывает 1, не знает 1/);
  assert.equal(f.service.isProbe(7), false);
  let view = await f.service.view('p');
  const reasons = (id: string) => view.capabilities.find((c) => c.id === id)!.reasons;
  assert.deepEqual(reasons('behavior'), ['выдумывает']);
  assert.deepEqual(reasons('domain'), ['не знает']);
  assert.deepEqual(reasons('why'), ['ждёт подтверждения']);
  assert.deepEqual(reasons('architecture'), []);
  const semantic = CAPABILITIES.filter((c) => c.semantic).length;
  assert.equal(view.count, 2 + semantic);
  view = await f.service.act('p', { op: 'confirmAnswer', capability: 'why', repo });
  assert.deepEqual(reasons('why'), []);
  view = await f.service.act('p', { op: 'rejectAnswer', capability: 'done', repo });
  assert.deepEqual(reasons('done'), ['выдумывает']);
  assert.equal(f.porcelain(repo).trim().split('\n').every((l) => l.includes('.cyborg/')), true);
  assert.ok(f.events.some((e) => e.channel === 'passport:changed'));
});

test('проба: закрытая до итога вкладка оставляет прежние исходы и называет причину', async (t) => {
  const f = fixture(t);
  const probe = await f.service.prepareProbe('p');
  f.service.registerProbe(3, probe.run);
  f.service.sessionEnded(3);
  const view = await f.service.view('p');
  assert.equal(view.probing, false);
  assert.match(String(view.probeNote), /Проба прервана/);
  assert.equal(loadState(f.dirs[0]).state.probe, null);
});

test('report_passport отдаётся только вкладке пробы', () => {
  const names = (passport: boolean) => sessionTools(['/r'], { kind: 'local', hosts: [], passport }).map((t) => t.name);
  assert.equal(names(true).includes('report_passport'), true);
  assert.equal(names(false).includes('report_passport'), false);
});

test('действия окна: проверка по проекту и перечню', () => {
  const repos = ['/a'];
  assert.deepEqual(validateAction({ op: 'notNeeded', capability: 'why' }, repos), { op: 'notNeeded', capability: 'why' });
  assert.equal(validateAction({ op: 'notNeeded', capability: 'nope' }, repos), null);
  assert.equal(validateAction({ op: 'confirmApprox', capability: 'why', repo: '/b' }, repos), null);
  assert.equal(validateAction({ op: 'setMain', repo: '/b' }, repos), null);
  assert.equal(validateAction({ op: 'rm -rf' }, repos), null);
});

test('проект из двух репозиториев: главный не отмечен - «–»; после отметки проектные только в главном, указатель обязателен', async (t) => {
  const f = fixture(t, 2);
  const [a, b] = f.dirs;
  let view = await f.service.view('p');
  assert.equal(view.mainRepo, null);
  assert.equal(view.capabilities.every((c) => c.group === 'tech'), true);
  await assert.rejects(f.service.act('p', { op: 'notNeeded', capability: 'why' }), /Отметьте главный репозиторий/);
  for (const cap of CAPABILITIES) {
    f.put(a, cap.file, DOC);
    if (cap.group === 'tech') f.put(b, cap.file, DOC);
  }
  view = await f.service.view('p');
  assert.equal(view.level, 'unchecked');
  view = await f.service.act('p', { op: 'setMain', repo: a });
  assert.equal(view.mainRepo, a);
  assert.equal(view.count, 1);
  assert.equal(view.repos.find((r) => r.repo === b)!.pointerOk, false);
  f.put(b, 'index.md', '[Паспорт проекта](../../../repo0/.cyborg/passport/index.md)');
  view = await f.service.view('p');
  assert.equal(view.count, 0);
  assert.equal(view.level, 'clear');
});

test('исправление: промпт называет способность и файл, правка не обещает коммит', async (t) => {
  const f = fixture(t);
  const fix = await f.service.prepareFix('p', 'architecture', f.dirs[0]);
  assert.match(fix.prompt, /architecture\.md/);
  assert.match(fix.prompt, /ПЛАН/);
  assert.match(fix.prompt, /не описание проекта, а указатель/);
  assert.match(fix.prompt, /документ положи в проект/);
  await assert.rejects(f.service.prepareFix('p', 'nope', f.dirs[0]), /Некорректные/);
  await assert.rejects(f.service.prepareFix('p', 'why', '/somewhere/else'), /Некорректные/);
});

// ---------- настройка паспорта: список пунктов, закрытие, дерево сессии ----------

type Fixture = ReturnType<typeof fixture>;

/** Открывает вкладку настройки с номером `id`: так делает main.ts после sessions.create. */
async function openFix(f: Fixture, id = 9, capability = 'why'): Promise<void> {
  const fix = await f.service.prepareFix('p', capability, f.dirs[0]);
  f.service.registerFix(id, fix.run);
}

const fillAll = (f: Fixture, repo = f.dirs[0]) => {
  for (const cap of CAPABILITIES) f.put(repo, cap.file, DOC);
};

const stateText = (f: Fixture, repo = f.dirs[0]): string | null => {
  const file = path.join(f.passportDir(repo), 'state.json');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
};

const closeArgs = (repo: string, over: Record<string, unknown> = {}) => ({ id: 'why', repo, answer: 'зафиксировано в docs/a.md', source: 'docs/a.md:1', ...over });

test('промпт настройки: цель на всю сессию, пункт по одному, три условия закрытия, пропуск, «стоп», прежнее требование плана', () => {
  const cap = CAPABILITIES.find((c) => c.id === 'architecture')!;
  const text = fixPrompt(cap, '/r');
  assert.match(text, /^Настройка паспорта проекта/);
  assert.match(text, /легко, чётко и консистентно получал/);
  assert.match(text, /architecture\.md/);
  assert.match(text, /list_passport_items/);
  assert.match(text, /close_passport_item/);
  assert.match(text, /по одному/);
  assert.match(text, /не противоречит другим пунктам/);
  assert.match(text, /человек согласился словами/);
  assert.match(text, /сам вызови list_passport_items и предложи человеку следующий/);
  assert.match(text, /пропусти его до конца сессии/);
  assert.match(text, /кнопкой «Не нужно»/);
  assert.match(text, /«стоп»/);
  assert.match(text, /ПЛАН/);
  assert.match(text, /До подтверждения плана человеком файлы не правь/);
  assert.match(text, /не описание проекта, а указатель/);
  assert.match(text, /документ положи в проект/);
  assert.match(text, /Не коммить и не сливай/);
  for (const reason of ['файла нет', 'есть ⚠', '≈ не подтверждено', 'нет ссылки на документ проекта']) assert.ok(text.includes(reason), reason);
});

test('настройка: инструменты - только список и закрытие, «Не нужно» агенту не отдаётся', () => {
  const names = sessionTools(['/r'], { kind: 'local', hosts: [], passportFix: true }).map((t) => t.name);
  assert.ok(names.includes('list_passport_items') && names.includes('close_passport_item'));
  assert.ok(!names.some((n) => /not_needed|needed/.test(n)));
});

test('validateCloseItem: неизвестный id, чужой repo, пустые answer и source, длинное режется', () => {
  const repos = ['/a'];
  assert.match(String(validateCloseItem({ id: 'nope', repo: '/a', answer: 'x', source: 'y' }, repos)), /способности nope нет/);
  assert.match(String(validateCloseItem({ id: 'why', repo: '/b', answer: 'x', source: 'y' }, repos)), /не входит в проект/);
  assert.match(String(validateCloseItem({ id: 'why', repo: '/a', answer: '  ', source: 'y' }, repos)), /answer пуст/);
  assert.match(String(validateCloseItem({ id: 'why', repo: '/a', answer: 'x', source: ' ' }, repos)), /source пуст/);
  assert.match(String(validateCloseItem('x', repos)), /объект/);
  const ok = validateCloseItem({ id: 'why', repo: '/a', answer: ' ' + 'я'.repeat(3000), source: 's'.repeat(900) }, repos);
  assert.ok(typeof ok === 'object' && ok.answer.length === 2000 && ok.source.length === 500);
});

test('список пунктов: способности с пробелом без снятых «Не нужно», числом как у точки; вкладка не настройки - отказ', async (t) => {
  const f = fixture(t);
  const [repo] = f.dirs;
  fillAll(f);
  fs.rmSync(path.join(f.passportDir(repo), 'why.md'));
  f.put(repo, 'behavior.md', `${DOC} ⚠`);
  fs.rmSync(path.join(f.passportDir(repo), 'upkeep.md'));
  await f.service.act('p', { op: 'notNeeded', capability: 'upkeep' });
  await assert.rejects(f.service.items(9), /не ведёт настройку/);
  await openFix(f);
  const list = JSON.parse(await f.service.items(9));
  assert.equal(list.tree, repo);
  assert.deepEqual(list.items.map((i: { id: string }) => i.id), ['why', 'behavior']);
  assert.deepEqual(list.items[0], { id: 'why', name: 'Зачем и для кого', question: 'Зачем продукт и для кого он?', repo, reasons: ['файла нет'], semantic: true, closable: true });
  assert.deepEqual(list.items[1].reasons, ['есть ⚠']);
  assert.deepEqual(list.pointers, []);
  assert.equal(list.items.length + list.pointers.length, (await f.service.view('p')).count);
  const before = stateText(f);
  await f.service.items(9);
  assert.equal(stateText(f), before, 'список ничего не пишет');
});

test('список пунктов: пробелов нет - «Открытых пунктов нет.»; несколько репозиториев без главного - заметка, указатель - пункт без закрытия', async (t) => {
  const f = fixture(t);
  fillAll(f);
  await openFix(f);
  assert.equal(await f.service.items(9), 'Открытых пунктов нет.');
  const g = fixture(t, 2);
  const [a, b] = g.dirs;
  for (const cap of CAPABILITIES) {
    g.put(a, cap.file, DOC);
    if (cap.group === 'tech') g.put(b, cap.file, DOC);
  }
  await openFix(g);
  assert.match(await g.service.items(9), /Главный репозиторий не отмечен/);
  await g.service.act('p', { op: 'setMain', repo: a });
  const list = JSON.parse(await g.service.items(9));
  assert.deepEqual(list.items, []);
  assert.equal(list.pointers.length, 1);
  assert.equal(list.pointers[0].repo, b);
  assert.equal(list.pointers[0].closable, false);
  assert.match(list.pointers[0].text, /нет ссылки на index\.md главного/);
});

test('закрытие: каждый отказ - причина и state.json прежний', async (t) => {
  const f = fixture(t, 2);
  const [a, b] = f.dirs;
  fillAll(f, a);
  for (const cap of CAPABILITIES) if (cap.group === 'tech') f.put(b, cap.file, DOC);
  f.put(a, 'why.md', DOC + ' ⚠');
  f.put(a, 'behavior.md', DOC + ' ≈');
  f.put(a, 'done.md', 'описание без ссылки');
  fs.rmSync(path.join(f.passportDir(a), 'domain.md'));
  await openFix(f);
  const refused = async (args: unknown, re: RegExp) => {
    const before = [stateText(f, a), stateText(f, b)];
    await assert.rejects(f.service.close(9, args), re);
    assert.deepEqual([stateText(f, a), stateText(f, b)], before);
  };
  await refused(closeArgs(a), /Отметьте главный репозиторий/);
  await f.service.act('p', { op: 'setMain', repo: a });
  await refused(closeArgs(a, { id: 'nope' }), /способности nope нет/);
  await refused(closeArgs('/нет/такого'), /не входит в проект/);
  await refused(closeArgs(a, { answer: ' ' }), /answer пуст/);
  await refused(closeArgs(a, { source: '' }), /source пуст/);
  await refused(closeArgs(b), /главном репозитории/);
  await refused(closeArgs(a, { id: 'autonomy' }), /нет пробела/);
  await refused(closeArgs(a), /есть ⚠/);
  await refused(closeArgs(a, { id: 'behavior' }), /≈ не подтверждено/);
  await refused(closeArgs(a, { id: 'done' }), /нет ссылки на документ проекта/);
  await refused(closeArgs(a, { id: 'domain' }), /файла нет/);
  await f.service.act('p', { op: 'notNeeded', capability: 'delivery' });
  await refused(closeArgs(a, { id: 'delivery' }), /Не нужно/);
  f.put(a, 'why.md', DOC);
  // без исхода пробы пробела при рабочей ссылке нет (D-40): закрывать нечего
  await refused(closeArgs(a), /нет пробела/);
  saveState(a, (s) => {
    s.probe = { at: 'x', outcomes: { why: { outcome: 'unknown', answer: '', source: '' } } };
  });
  await refused(closeArgs(a, { source: 'docs/нет.md' }), /Источник docs\/нет\.md не найден/);
  await refused(closeArgs(a, { source: 'docs/a.md:99' }), /не найден/);
  await refused(closeArgs(a, { source: 'docs' }), /не найден/);
  await refused(closeArgs(a, { source: '../вне' }), /не найден/);
  const probe = await f.service.prepareProbe('p');
  f.service.registerProbe(4, probe.run);
  await refused(closeArgs(a), /Идёт проба/);
  await assert.rejects(f.service.close(5, closeArgs(a)), /не ведёт настройку/);
});

test('закрытие смысловой способности вместо «Подтвердить»: ждёт подтверждения снято, подтверждение пробы не тронуто, правка файла переоткрывает', async (t) => {
  const f = fixture(t);
  const [repo] = f.dirs;
  fillAll(f);
  const probe = await f.service.prepareProbe('p');
  f.service.registerProbe(7, probe.run);
  f.service.report(7, { capabilities: CAPABILITIES.map((c) => ({ id: c.id, outcome: 'found', answer: 'ответ', source: 'docs/a.md:2' })) });
  const semantic = CAPABILITIES.filter((c) => c.semantic).length;
  let view = await f.service.view('p');
  assert.equal(view.count, semantic);
  await openFix(f);
  f.events.length = 0;
  const text = await f.service.close(9, closeArgs(repo));
  assert.match(text, new RegExp(`Открытых пунктов: ${semantic - 1}\\.`));
  assert.match(text, /list_passport_items/);
  assert.deepEqual(f.events, [{ channel: 'passport:changed', payload: { projectId: 'p' } }]);
  view = await f.service.view('p');
  assert.equal(view.count, semantic - 1);
  const why = view.capabilities.find((c) => c.id === 'why')!;
  assert.equal(why.closed, true);
  assert.deepEqual(why.reasons, []);
  assert.equal(why.gap, false);
  assert.equal(why.probe!.confirmed, undefined);
  const entry = loadState(repo).state.closed.why;
  assert.equal(entry.answer, 'зафиксировано в docs/a.md');
  assert.equal(entry.source, 'docs/a.md:1');
  await assert.rejects(f.service.close(9, closeArgs(repo)), /уже закрыт/);
  const list = JSON.parse(await f.service.items(9));
  assert.ok(!list.items.some((i: { id: string }) => i.id === 'why'));
  assert.equal(f.porcelain(repo).trim().split('\n').every((l) => l.includes('.cyborg/passport/')), true);
  assert.equal(execFileSync('git', ['-C', repo, 'diff', '--stat'], { encoding: 'utf8' }), '');
  // «Подтвердить» работает как прежде и не трогает закрытие
  await f.service.act('p', { op: 'confirmAnswer', capability: 'why', repo });
  assert.ok(loadState(repo).state.closed.why);
  // правка файла: закрытие снято, пробел по пробе вернулся (подтверждение снято «Не то»)
  await f.service.act('p', { op: 'rejectAnswer', capability: 'why', repo });
  f.put(repo, 'why.md', `${DOC} правка`);
  view = await f.service.view('p');
  const again = view.capabilities.find((c) => c.id === 'why')!;
  assert.equal(again.closed, false);
  assert.deepEqual(again.reasons, ['выдумывает']);
});

test('закрытие не заменяет пробел по файлам: ссылка сломалась после закрытия - пробел вернулся', async (t) => {
  const f = fixture(t);
  const [repo] = f.dirs;
  fillAll(f);
  f.put(repo, 'why.md', '[Док](../../docs/b.md)');
  fs.writeFileSync(path.join(repo, 'docs', 'b.md'), 'b\n');
  const probe = await f.service.prepareProbe('p');
  f.service.registerProbe(7, probe.run);
  f.service.report(7, { capabilities: CAPABILITIES.map((c) => ({ id: c.id, outcome: 'found', answer: 'ответ', source: 'docs/a.md:2' })) });
  await openFix(f);
  await f.service.close(9, closeArgs(repo));
  fs.rmSync(path.join(repo, 'docs', 'b.md'));
  const why = (await f.service.view('p')).capabilities.find((c) => c.id === 'why')!;
  assert.equal(why.closed, true);
  assert.deepEqual(why.reasons, ['нет ссылки на документ проекта']);
  assert.equal(why.gap, true);
});

test('найденный пробой ответ не заменяет файл при закрытии: файла нет - отказ', async (t) => {
  const f = fixture(t);
  const [repo] = f.dirs;
  const probe = await f.service.prepareProbe('p');
  f.service.registerProbe(7, probe.run);
  f.service.report(7, { capabilities: CAPABILITIES.map((c) => ({ id: c.id, outcome: 'found', answer: 'ответ', source: 'docs/a.md:2' })) });
  await openFix(f);
  const before = stateText(f);
  await assert.rejects(f.service.close(9, closeArgs(repo)), /файла нет/);
  assert.equal(stateText(f), before);
});

test('итог новой пробы снимает закрытия во всех репозиториях; прерванная проба не снимает; неглавный без закрытий state.json не получает', async (t) => {
  const f = fixture(t, 2);
  const [a, b] = f.dirs;
  for (const cap of CAPABILITIES) {
    f.put(a, cap.file, DOC);
    if (cap.group === 'tech') f.put(b, cap.file, DOC);
  }
  f.put(a, 'why.md', DOC + ' ⚠');
  f.put(b, 'architecture.md', DOC + ' ⚠');
  await f.service.act('p', { op: 'setMain', repo: a });
  await openFix(f);
  f.put(a, 'why.md', DOC);
  f.put(b, 'architecture.md', DOC);
  saveState(a, (s) => {
    s.closed.why = { hash: 'x', answer: '', source: '', at: '' };
    s.closed.architecture = { hash: 'x', answer: '', source: '', at: '' };
  });
  saveState(b, (s) => {
    s.closed.architecture = { hash: 'x', answer: '', source: '', at: '' };
  });
  const interrupted = await f.service.prepareProbe('p');
  f.service.registerProbe(3, interrupted.run);
  f.service.sessionEnded(3);
  assert.deepEqual(Object.keys(loadState(a).state.closed).sort(), ['architecture', 'why']);
  assert.deepEqual(Object.keys(loadState(b).state.closed), ['architecture']);
  const probe = await f.service.prepareProbe('p');
  f.service.registerProbe(4, probe.run);
  assert.throws(() => f.service.report(4, { capabilities: [] }), /нет ответа/);
  assert.deepEqual(Object.keys(loadState(a).state.closed).sort(), ['architecture', 'why'], 'отказ по форме закрытий не снимает');
  f.service.report(4, { capabilities: CAPABILITIES.map((c) => ({ id: c.id, outcome: 'unknown' })) });
  assert.deepEqual(loadState(a).state.closed, {});
  assert.deepEqual(loadState(b).state.closed, {});
  const c = fixture(t, 2);
  await c.service.act('p', { op: 'setMain', repo: c.dirs[0] });
  const run = await c.service.prepareProbe('p');
  c.service.registerProbe(4, run.run);
  c.service.report(4, { capabilities: CAPABILITIES.map((cap) => ({ id: cap.id, outcome: 'unknown' })) });
  assert.equal(stateText(c, c.dirs[1]), null);
  assert.equal(c.porcelain(c.dirs[1]), '');
});

test('дерево сессии: список и закрытие идут в worktree, рабочая копия и окно прежние до слияния', async (t) => {
  let tree = '';
  const f = fixture(t, 1, async (_id, repo) => (tree && repo === f.dirs[0] ? tree : repo));
  const [repo] = f.dirs;
  tree = path.join(f.base, 'wt');
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', tree]);
  assert.equal(await gitCommonDir(tree), await gitCommonDir(repo));
  assert.equal(await gitCommonDir(f.base), null);
  for (const cap of CAPABILITIES) f.put(tree, cap.file, DOC);
  fs.rmSync(path.join(f.passportDir(tree), 'why.md'));
  f.put(tree, 'state.json', JSON.stringify({ version: 1, probe: { at: 'x', outcomes: { why: { outcome: 'unknown', answer: '', source: '' } } } }));
  await openFix(f);
  assert.equal((await f.service.view('p')).count, 12);
  let list = JSON.parse(await f.service.items(9));
  assert.equal(list.tree, tree);
  assert.deepEqual(list.items.map((i: { id: string }) => i.id), ['why']);
  assert.deepEqual(list.items[0].reasons, ['файла нет', 'не знает']);
  await assert.rejects(f.service.close(9, closeArgs(repo)), /файла нет/);
  f.put(tree, 'why.md', DOC);
  const before = f.porcelain(repo);
  await f.service.close(9, closeArgs(repo));
  assert.equal(f.porcelain(repo), before, 'рабочая копия не тронута');
  assert.ok(loadState(tree).state.closed.why);
  assert.deepEqual(loadState(repo).state.closed, {});
  assert.equal((await f.service.view('p')).count, 12, 'окно смотрит на рабочую копию');
  assert.equal(await f.service.items(9), 'Открытых пунктов нет.');
});

test('«Не нужно» из рабочей копии действует и для дерева сессии', async (t) => {
  let tree = '';
  const f = fixture(t, 1, async (_id, repo) => (tree || repo));
  const [repo] = f.dirs;
  tree = path.join(f.base, 'wt');
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', tree]);
  await f.service.act('p', { op: 'notNeeded', capability: 'why' });
  await openFix(f);
  const ids = JSON.parse(await f.service.items(9)).items.map((i: { id: string }) => i.id);
  assert.ok(!ids.includes('why') && ids.includes('behavior'));
  await assert.rejects(f.service.close(9, closeArgs(repo)), /Не нужно/);
});

test('одна сессия настройки на проект: вторая не открывается, пока первая жива; view.fixSession; после выхода открывается новая', async (t) => {
  const f = fixture(t);
  assert.equal((await f.service.view('p')).fixSession, null);
  await openFix(f, 9, 'why');
  assert.equal((await f.service.view('p')).fixSession, 9);
  assert.equal(f.service.isFix(9), true);
  await assert.rejects(f.service.prepareFix('p', 'architecture', f.dirs[0]), /уже открыта/);
  assert.throws(() => f.service.ensureNoFix('p'), /уже открыта/);
  f.events.length = 0;
  f.service.sessionEnded(9);
  assert.deepEqual(f.events, [{ channel: 'passport:changed', payload: { projectId: 'p' } }]);
  assert.equal(f.service.isFix(9), false);
  assert.equal((await f.service.view('p')).fixSession, null);
  await assert.rejects(f.service.items(9), /не ведёт настройку/);
  await assert.rejects(f.service.close(9, closeArgs(f.dirs[0])), /не ведёт настройку/);
  await openFix(f, 10, 'architecture');
  assert.equal((await f.service.view('p')).fixSession, 10);
});

test('исправление: промпт на всю сессию начинается с нажатого пункта, возвращает запись вкладки', async (t) => {
  const f = fixture(t);
  const fix = await f.service.prepareFix('p', 'architecture', f.dirs[0]);
  assert.deepEqual(fix.run, { projectId: 'p', repo: f.dirs[0] });
  assert.match(fix.prompt, /^Настройка паспорта проекта/);
  assert.match(fix.prompt, /id architecture/);
});

test('состояние прежнего формата читается: закрытий нет; закрытие с неизвестным id или без хеша отбрасывается', () => {
  const old = parseState('{"version":1,"probe":null,"approxConfirmed":{},"notNeeded":["why"]}');
  assert.ok(typeof old === 'object');
  assert.deepEqual(old.closed, {});
  assert.deepEqual(old.notNeeded, ['why']);
  const mixed = parseState(JSON.stringify({ closed: { why: { hash: 'h', answer: 'a', source: 's', at: 't' }, nope: { hash: 'h' }, done: { hash: 5 }, upkeep: 'x' } }));
  assert.ok(typeof mixed === 'object');
  assert.deepEqual(mixed.closed, { why: { hash: 'h', answer: 'a', source: 's', at: 't' } });
});

test('старт вкладки настройки: два быстрых запроса открывают одну сессию, после её выхода открывается новая', async (t) => {
  const f = fixture(t);
  const created: string[] = [];
  const start = (capability: string, id: number) => f.service.startFix('p', capability, f.dirs[0], (fix) => (created.push(fix.prompt), id));
  const [a, b] = await Promise.allSettled([start('why', 3), start('architecture', 4)]);
  assert.equal(a.status, 'fulfilled');
  assert.equal(b.status, 'rejected');
  assert.match(String((b as PromiseRejectedResult).reason), /уже открыта/);
  assert.equal(created.length, 1, 'вторая сессия не создана');
  assert.equal(f.service.isFix(3), true);
  assert.equal(f.service.isFix(4), false);
  f.service.sessionEnded(3);
  assert.equal(await start('architecture', 5), 5);
  assert.equal((await f.service.view('p')).fixSession, 5);
});

test('«Исправить» в окне: живая вкладка - переход; вкладки уже нет при устаревшем виде - открывается новая; живой нет - открывается новая', () => {
  const calls: string[] = [];
  const host = (alive: boolean) => ({
    showSession: (id: number) => (calls.push(`show ${id}`), alive),
    startFix: (project: string, repo: string, capability: string) => void calls.push(`start ${project} ${repo} ${capability}`),
  });
  fixAction(host(true), 7, 'P', '/r', 'why');
  assert.deepEqual(calls.splice(0), ['show 7']);
  fixAction(host(false), 7, 'P', '/r', 'why');
  assert.deepEqual(calls.splice(0), ['show 7', 'start P /r why']);
  fixAction(host(true), null, 'P', '/r', 'why');
  assert.deepEqual(calls.splice(0), ['start P /r why']);
});
