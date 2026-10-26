import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ProjectStore, type Project } from '../src/main/projects';
import { validateProjectsState } from '../src/main/trackers';
import {
  canonicalWorkspace,
  createAndOpen,
  createWorkspaceFile,
  directoryProblem,
  forgetRecent,
  isLegacyWorkspace,
  isWorkspaceBusy,
  launchArgs,
  launchInstance,
  lockPathOf,
  openRecentWorkspace,
  openWorkspaceFile,
  parseWorkspaceArg,
  readRecent,
  releaseLock,
  resolveStartup,
  sessionDirOf,
  touchRecent,
  tryLock,
  workspaceDisplayName,
  type OpenDeps,
  type OpenResult,
  type SpawnFn,
} from '../src/main/workspaces';

let dir: string;
beforeEach(() => void (dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-ws-')))));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const project = (over: Partial<Project> = {}): Project => ({ id: 'p1', name: 'Проект', description: '', repos: ['/repo'], trackers: { github: false, gitlab: false }, ...over });
const alive = (...pids: number[]) => (pid: number) => pids.includes(pid);
const mkfile = (name: string, text = '{}') => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
};

describe('parseWorkspaceArg', () => {
  it('без аргумента - none', () => assert.deepEqual(parseWorkspaceArg(['electron', '.'], '/x'), { kind: 'none' }));
  it('обе формы значения', () => {
    assert.deepEqual(parseWorkspaceArg(['--workspace', '/a/b.json'], '/x'), { kind: 'file', file: '/a/b.json' });
    assert.deepEqual(parseWorkspaceArg(['--workspace=/a/b.json'], '/x'), { kind: 'file', file: '/a/b.json' });
  });
  it('относительный путь разрешается от рабочего каталога', () => {
    assert.deepEqual(parseWorkspaceArg(['--workspace=relative.json'], '/tmp/x'), { kind: 'file', file: '/tmp/x/relative.json' });
  });
  it('без значения и со значением-флагом - ошибка с причиной, а не файл с именем флага', () => {
    for (const argv of [['--workspace'], ['--workspace='], ['--workspace', '--no-sandbox']]) {
      const result = parseWorkspaceArg(argv, '/x');
      assert.equal(result.kind, 'error');
      assert.match((result as { reason: string }).reason, /без пути/);
    }
  });
  it('каталог вместо файла называется причиной', () => {
    assert.match(directoryProblem(dir) ?? '', /каталог, а не файл/);
    assert.equal(directoryProblem(path.join(dir, 'нет.json')), null);
  });
});

describe('имена и пути воркспейса', () => {
  it('имя - файл без .cyborg.json, иначе без расширения', () => {
    assert.equal(workspaceDisplayName('/x/a.cyborg.json'), 'a');
    assert.equal(workspaceDisplayName('/x/work.json'), 'work');
    assert.equal(workspaceDisplayName('/x/plain'), 'plain');
  });
  it('sessionDirOf стабилен, различает одноимённые файлы разных папок, совпадает через ссылку', () => {
    const a = mkfile('a.json');
    fs.mkdirSync(path.join(dir, 'other'));
    const b = path.join(dir, 'other', 'a.json');
    fs.writeFileSync(b, '{}');
    const link = path.join(dir, 'link.json');
    fs.symlinkSync(a, link);
    assert.equal(sessionDirOf('/ud', a), sessionDirOf('/ud', a));
    assert.notEqual(sessionDirOf('/ud', a), sessionDirOf('/ud', b));
    assert.equal(sessionDirOf('/ud', a), sessionDirOf('/ud', link));
    assert.ok(sessionDirOf('/ud', a).startsWith(path.join('/ud', 'workspaces') + path.sep));
  });
  it('файла нет - ссылки разрешаются у каталога', () => {
    const real = path.join(dir, 'real');
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(dir, 'via'));
    assert.equal(canonicalWorkspace(path.join(dir, 'via', 'new.json')), path.join(real, 'new.json'));
  });
  it('прежний projects.json распознаётся и через ссылку', () => {
    const ud = path.join(dir, 'ud');
    fs.mkdirSync(ud);
    fs.writeFileSync(path.join(ud, 'projects.json'), '{}');
    const viaLink = path.join(dir, 'ud-link');
    fs.symlinkSync(ud, viaLink);
    assert.equal(isLegacyWorkspace(ud, path.join(viaLink, 'projects.json')), true);
    assert.equal(isLegacyWorkspace(ud, mkfile('other.json')), false);
  });
});

describe('замок открытого воркспейса', () => {
  it('свободный захват пишет pid', () => {
    const file = mkfile('w.json');
    assert.deepEqual(tryLock(file, 111, alive()), { status: 'locked' });
    assert.equal(fs.readFileSync(lockPathOf(file), 'utf8'), '111');
  });
  it('замок живого процесса - отказ с pid, замок не тронут', () => {
    const file = mkfile('w.json');
    tryLock(file, 111, alive());
    assert.deepEqual(tryLock(file, 222, alive(111)), { status: 'busy', pid: 111 });
    assert.equal(fs.readFileSync(lockPathOf(file), 'utf8'), '111');
    assert.deepEqual(isWorkspaceBusy(file, alive(111)), { busy: true, pid: 111 });
  });
  it('замок мёртвого процесса перехватывается', () => {
    const file = mkfile('w.json');
    tryLock(file, 111, alive());
    assert.deepEqual(isWorkspaceBusy(file, alive()), { busy: false });
    assert.deepEqual(tryLock(file, 222, alive()), { status: 'locked' });
    assert.equal(fs.readFileSync(lockPathOf(file), 'utf8'), '222');
  });
  it('старый мусор в замке перехватывается, свежий считается занятым', () => {
    const file = mkfile('w.json');
    const lock = lockPathOf(file);
    fs.writeFileSync(lock, 'мусор');
    assert.deepEqual(tryLock(file, 222, alive()), { status: 'busy', pid: null });
    const old = new Date(Date.now() - 10_000);
    fs.utimesSync(lock, old, old);
    assert.deepEqual(tryLock(file, 222, alive()), { status: 'locked' });
  });
  it('освобождение убирает только свой замок', () => {
    const file = mkfile('w.json');
    tryLock(file, 111, alive());
    releaseLock(file, 222);
    assert.ok(fs.existsSync(lockPathOf(file)));
    releaseLock(file, 111);
    assert.ok(!fs.existsSync(lockPathOf(file)));
  });
  it('каталога нет - воркспейс открывается без замка', () => {
    assert.deepEqual(tryLock(path.join(dir, 'нет', 'w.json'), 1, alive()), { status: 'unlocked' });
  });
});

describe('«Недавние»', () => {
  it('порядок, дедупликация и предел 10', () => {
    for (let i = 0; i < 12; i++) touchRecent(dir, `/w/${i}.json`);
    touchRecent(dir, '/w/5.json');
    const recent = readRecent(dir);
    assert.equal(recent.length, 10);
    assert.equal(recent[0], '/w/5.json');
    assert.equal(recent.filter((p) => p === '/w/5.json').length, 1);
    assert.ok(!recent.includes('/w/0.json'));
  });
  it('забыть убирает путь', () => {
    touchRecent(dir, '/a.json');
    touchRecent(dir, '/b.json');
    assert.deepEqual(forgetRecent(dir, '/a.json'), ['/b.json']);
    assert.deepEqual(readRecent(dir), ['/b.json']);
  });
  it('нет файла, не JSON и не та форма - пусто; относительные пути отбрасываются', () => {
    assert.deepEqual(readRecent(dir), []);
    fs.writeFileSync(path.join(dir, 'recent-workspaces.json'), '{oops');
    assert.deepEqual(readRecent(dir), []);
    fs.writeFileSync(path.join(dir, 'recent-workspaces.json'), JSON.stringify({ recent: ['/a', 'rel', 3, '/a', '/b'] }));
    assert.deepEqual(readRecent(dir), ['/a', '/b']);
  });
  it('повреждённый файл перезаписывается следующей вставкой, временного файла не остаётся', () => {
    fs.writeFileSync(path.join(dir, 'recent-workspaces.json'), '{oops');
    touchRecent(dir, '/a.json');
    assert.deepEqual(readRecent(dir), ['/a.json']);
    assert.deepEqual(fs.readdirSync(dir), ['recent-workspaces.json']);
  });
});

describe('resolveStartup', () => {
  const base = { legacyFile: '/ud/projects.json', isLegacy: (f: string) => f === '/ud/projects.json' };
  it('пустые «Недавние» и есть projects.json - открывается он как прежний', () => {
    const start = resolveStartup({ ...base, recent: [], isFile: () => true, tryLock: () => 'ok' });
    assert.deepEqual(start, { kind: 'workspace', file: '/ud/projects.json', legacy: true });
  });
  it('пустые «Недавние» и нет projects.json - первый запуск', () => {
    assert.deepEqual(resolveStartup({ ...base, recent: [], isFile: () => false, tryLock: () => 'ok' }), { kind: 'first-run' });
  });
  it('непустые «Недавние»: projects.json не рассматривается', () => {
    const start = resolveStartup({ ...base, recent: ['/a.json'], isFile: (f) => f === '/ud/projects.json', tryLock: () => 'ok' });
    assert.deepEqual(start, { kind: 'first-run' });
  });
  it('занятый живым инстансом пропускается, берётся следующий', () => {
    const tried: string[] = [];
    const start = resolveStartup({
      ...base,
      recent: ['/a.json', '/b.json'],
      isFile: () => true,
      tryLock: (f) => (tried.push(f), f === '/a.json' ? 'busy' : 'ok'),
    });
    assert.deepEqual(start, { kind: 'workspace', file: '/b.json', legacy: false });
    assert.deepEqual(tried, ['/a.json', '/b.json']);
  });
  it('пропавший файл пропускается без попытки замка', () => {
    const tried: string[] = [];
    const start = resolveStartup({ ...base, recent: ['/gone.json', '/b.json'], isFile: (f) => f !== '/gone.json', tryLock: (f) => (tried.push(f), 'ok') });
    assert.equal(start.kind === 'workspace' && start.file, '/b.json');
    assert.deepEqual(tried, ['/b.json']);
  });
  it('все заняты - первый запуск, без отказа', () => {
    assert.deepEqual(resolveStartup({ ...base, recent: ['/a.json', '/b.json'], isFile: () => true, tryLock: () => 'busy' }), { kind: 'first-run' });
  });
});

describe('файл воркспейса', () => {
  it('ProjectStore читает и пишет файл по произвольному пути', () => {
    const file = path.join(dir, 'team.cyborg.json');
    const state = { projects: [project()], lastProjectId: 'p1' };
    new ProjectStore(file).save(state);
    assert.deepEqual(new ProjectStore(file).load(), state);
  });
  it('файла нет - пустой перечень, файл не создаётся', () => {
    const file = path.join(dir, 'none.json');
    assert.deepEqual(new ProjectStore(file).load(), { projects: [], lastProjectId: null });
    assert.ok(!fs.existsSync(file));
  });
  it('повреждённый файл: копия рядом с ним, а не в каталоге данных', () => {
    const file = mkfile('bad.cyborg.json', '{oops');
    const store = new ProjectStore(file, undefined, () => new Date('2026-10-26T08:15:30Z'));
    store.load();
    assert.equal(store.problem()?.copy, `${file}.corrupt-20261026T081530`);
    assert.equal(fs.readFileSync(`${file}.corrupt-20261026T081530`, 'utf8'), '{oops');
  });
  it('созданный файл читается ProjectStore и проходит validateProjectsState', () => {
    const file = path.join(dir, 'new.cyborg.json');
    const result = createWorkspaceFile({ name: 'w', file, project: project() });
    assert.deepEqual(result, { file });
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(written, { projects: [project()], lastProjectId: 'p1' });
    assert.deepEqual(new ProjectStore(file).load(), written);
    assert.ok(validateProjectsState(written));
  });
  it('существующий файл цел побайтно, результат exists', () => {
    const bytes = Buffer.from([0, 1, 2, 255, 10]);
    const file = path.join(dir, 'old.json');
    fs.writeFileSync(file, bytes);
    assert.deepEqual(createWorkspaceFile({ name: 'w', file, project: project() }), { exists: true });
    assert.ok(fs.readFileSync(file).equals(bytes));
  });
  it('папки нет - ошибка, файл не пишется', () => {
    const result = createWorkspaceFile({ name: 'w', file: path.join(dir, 'нет', 'a.json'), project: project() });
    assert.deepEqual(result, { error: 'Папка не существует' });
  });
});

describe('запуск отдельного инстанса', () => {
  const ctx = { packaged: false, appPath: '/app', userData: '/ud', argv: ['electron', '.'], file: '/w/a.json' };
  it('неупакованный запуск: путь приложения первым, общий userData, форма --workspace=', () => {
    assert.deepEqual(launchArgs(ctx), ['/app', '--user-data-dir=/ud', '--workspace=/w/a.json']);
  });
  it('упакованный запуск без пути приложения, --no-sandbox пробрасывается', () => {
    assert.deepEqual(launchArgs({ ...ctx, packaged: true, argv: ['x', '--no-sandbox'] }), ['--user-data-dir=/ud', '--no-sandbox', '--workspace=/w/a.json']);
  });
  it('путь с ведущим «-» остаётся значением --workspace=', () => {
    assert.equal(launchArgs({ ...ctx, file: '-x.json' }).at(-1), '--workspace=-x.json');
  });

  const fakeSpawn = (emit: 'spawn' | 'error') => {
    const calls: { command: string; args: string[]; options: unknown }[] = [];
    let unref = 0;
    const spawnFn: SpawnFn = (command, args, options) => {
      calls.push({ command, args, options });
      const child = Object.assign(new EventEmitter(), { unref: () => void unref++ });
      queueMicrotask(() => (emit === 'spawn' ? child.emit('spawn') : child.emit('error', new Error('spawn x ENOENT'))));
      return child as never;
    };
    return { spawnFn, calls, unref: () => unref };
  };
  it('detached, stdio ignore, unref после spawn', async () => {
    const s = fakeSpawn('spawn');
    assert.deepEqual(await launchInstance(s.spawnFn, '/bin/e', ['a']), {});
    assert.deepEqual(s.calls, [{ command: '/bin/e', args: ['a'], options: { detached: true, stdio: 'ignore' } }]);
    assert.equal(s.unref(), 1);
  });
  it('ошибка запуска - в результате, unref не вызывается', async () => {
    const s = fakeSpawn('error');
    const result = await launchInstance(s.spawnFn, '/bin/e', []);
    assert.match(result.error ?? '', /ENOENT/);
    assert.equal(s.unref(), 0);
  });
  it('исключение spawn - тоже в результате', async () => {
    const result = await launchInstance(() => { throw new Error('boom'); }, '/bin/e', []);
    assert.deepEqual(result, { error: 'boom' });
  });
});

describe('открытие из меню', () => {
  const deps = (over: Partial<OpenDeps> & { workspace?: boolean } = {}) => {
    const launched: string[] = [];
    const opened: string[] = [];
    const d: OpenDeps = {
      userData: dir,
      hasWorkspace: () => over.workspace ?? true,
      openHere: (file): OpenResult => (opened.push(file), { ok: true }),
      launch: async (file) => (launched.push(file), {}),
      ...over,
    };
    return { d, launched, opened };
  };

  it('с воркспейсом - новый процесс', async () => {
    const file = mkfile('a.json');
    const { d, launched, opened } = deps();
    assert.deepEqual(await openWorkspaceFile(file, d), { ok: true });
    assert.deepEqual(launched, [file]);
    assert.deepEqual(opened, []);
  });
  it('без воркспейса - это окно, процесс не запускается', async () => {
    const file = mkfile('a.json');
    const { d, launched, opened } = deps({ workspace: false });
    await openWorkspaceFile(file, d);
    assert.deepEqual(launched, []);
    assert.deepEqual(opened, [file]);
  });
  it('занятый файл: «занят» с путём замка, процесс не запускается', async () => {
    const file = mkfile('a.json');
    tryLock(file, 4242, alive());
    const { d, launched, opened } = deps({ isAlive: alive(4242) });
    assert.deepEqual(await openWorkspaceFile(file, d), { busy: { pid: 4242, lock: lockPathOf(file) } });
    assert.deepEqual(launched.concat(opened), []);
  });
  it('свой файл тоже занят', async () => {
    const file = mkfile('a.json');
    tryLock(file, process.pid, alive());
    const { d, launched } = deps({ isAlive: alive(process.pid) });
    assert.ok('busy' in (await openWorkspaceFile(file, d)));
    assert.deepEqual(launched, []);
  });
  it('сбой запуска возвращается ошибкой', async () => {
    const file = mkfile('a.json');
    const { d } = deps({ launch: async () => ({ error: 'ENOENT' }) });
    assert.deepEqual(await openWorkspaceFile(file, d), { error: 'ENOENT' });
  });
  it('«Недавние»: пропавший путь убирается из списка, процесс не запускается', async () => {
    const gone = path.join(dir, 'gone.json');
    touchRecent(dir, gone);
    const { d, launched } = deps();
    assert.deepEqual(await openRecentWorkspace(gone, d), { missing: true });
    assert.deepEqual(readRecent(dir), []);
    assert.deepEqual(launched, []);
  });
  it('«Недавние»: каталог вместо файла - «не найден»', async () => {
    touchRecent(dir, dir);
    assert.deepEqual(await openRecentWorkspace(dir, deps().d), { missing: true });
    assert.deepEqual(readRecent(dir), []);
  });

  const request = (file: string, over: object = {}) => ({ name: 'w', file, project: project(), ...over });
  it('создание при открытом воркспейсе запускает новый процесс и кладёт файл в «Недавние»', async () => {
    const file = path.join(dir, 'c.cyborg.json');
    const { d, launched } = deps();
    assert.deepEqual(await createAndOpen(request(file), d), { opened: { ok: true } });
    assert.deepEqual(launched, [file]);
    assert.deepEqual(readRecent(dir), [file]);
  });
  it('создание без воркспейса открывает в этом окне, процесс не запускается', async () => {
    const file = path.join(dir, 'c.cyborg.json');
    const { d, launched, opened } = deps({ workspace: false });
    await createAndOpen(request(file), d);
    assert.deepEqual(launched, []);
    assert.deepEqual(opened, [file]);
  });
  it('создание без репозиториев, без имени, с относительным путём - отказ, файла нет', async () => {
    const file = path.join(dir, 'd.json');
    const { d, launched } = deps();
    for (const bad of [
      request(file, { project: project({ repos: [] }) }),
      request(file, { name: '  ' }),
      request(file, { project: project({ name: ' ' }) }),
      request(file, { project: project({ repos: ['rel'] }) }),
      request('rel.json'),
    ]) {
      assert.ok('error' in (await createAndOpen(bad, d)));
    }
    assert.ok(!fs.existsSync(file));
    assert.deepEqual(launched, []);
  });
  it('создание на существующий файл: exists, байты целы, процесс не запускается', async () => {
    const file = mkfile('e.json', 'x');
    const { d, launched } = deps();
    assert.deepEqual(await createAndOpen(request(file), d), { exists: true });
    assert.equal(fs.readFileSync(file, 'utf8'), 'x');
    assert.deepEqual(launched, []);
  });
});
