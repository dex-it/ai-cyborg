import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CAPABILITIES, GROUPS, dotText, dotTitle, fileReasons } from '../src/shared/passport';
import { PassportService, loadState, parseState, probeOutcome, saveState, sourceResolves, validateAction, validateProbeReport } from '../src/main/passport';
import { sessionTools } from '../src/main/session-tools';

function fixture(t: import('node:test').TestContext, repos = 1) {
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
  });
  const passportDir = (repo: string) => path.join(repo, '.cyborg', 'passport');
  const put = (repo: string, name: string, text: string) => {
    fs.mkdirSync(passportDir(repo), { recursive: true });
    fs.writeFileSync(path.join(passportDir(repo), name), text);
  };
  const porcelain = (repo: string) => execFileSync('git', ['-C', repo, 'status', '--porcelain', '-uall'], { encoding: 'utf8' });
  return { base, dirs, service, events, put, passportDir, porcelain };
}

test('перечень: двенадцать способностей в четырёх группах, файлы без повторов', () => {
  assert.equal(CAPABILITIES.length, 12);
  assert.deepEqual(GROUPS.map((g) => g.id), ['product', 'tech', 'work', 'upkeep']);
  assert.equal(new Set(CAPABILITIES.map((c) => c.file)).size, 12);
  assert.equal(new Set(CAPABILITIES.map((c) => c.id)).size, 12);
});

test('пробел по файлу: нет файла, пуст, ⚠, неподтверждённое ≈', () => {
  assert.deepEqual(fileReasons(null, false), ['missing']);
  assert.deepEqual(fileReasons('  \n', false), ['empty']);
  assert.deepEqual(fileReasons('текст ⚠', false), ['warn']);
  assert.deepEqual(fileReasons('текст ≈', false), ['approx']);
  assert.deepEqual(fileReasons('текст ≈', true), []);
  assert.deepEqual(fileReasons('⚠ и ≈', false), ['warn', 'approx']);
  assert.deepEqual(fileReasons('всё хорошо', false), []);
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
  for (const cap of CAPABILITIES) f.put(repo, cap.file, 'готово\n');
  f.put(repo, 'why.md', '');
  f.put(repo, 'behavior.md', 'тут ⚠');
  f.put(repo, 'done.md', 'черновик ≈');
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
  f.put(repo, 'done.md', 'черновик ≈ изменён');
  view = await f.service.view('p');
  assert.deepEqual(reasons(view, 'done'), ['≈ не подтверждено']);
});

test('«Не нужно»: способность снята и не считается, «Нужно» возвращает, запись только в .cyborg/passport/', async (t) => {
  const f = fixture(t);
  const [repo] = f.dirs;
  for (const cap of CAPABILITIES) f.put(repo, cap.file, 'ok');
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
  for (const cap of CAPABILITIES) f.put(repo, cap.file, 'ok');
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
    f.put(a, cap.file, 'ok');
    if (cap.group === 'tech') f.put(b, cap.file, 'ok');
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
  await assert.rejects(f.service.prepareFix('p', 'nope', f.dirs[0]), /Некорректные/);
  await assert.rejects(f.service.prepareFix('p', 'why', '/somewhere/else'), /Некорректные/);
});
