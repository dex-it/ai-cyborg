import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AllowedPaths, createPathHandlers, isInside, type PathHandlerDeps } from '../src/main/allowed-paths';

const OUTSIDE = /Путь вне репозиториев проектов и каталогов сессий/;

let base: string;
// tmpdir на macOS лежит за ссылкой (/var -> /private/var): физический путь берётся от realpath каталога теста.
beforeEach(() => void (base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-paths-')))));
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

const mkdir = (...parts: string[]) => {
  const dir = path.join(base, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

describe('isInside', () => {
  it('сам каталог, вложенный путь - внутри', () => {
    assert.equal(isInside('/repo', '/repo'), true);
    assert.equal(isInside('/repo/src/a.ts', '/repo'), true);
    assert.equal(isInside('/repo/', '/repo'), true);
  });
  it('сосед с общим префиксом имени, родитель и чужой каталог - снаружи', () => {
    assert.equal(isInside('/repo-evil', '/repo'), false);
    assert.equal(isInside('/repo-evil/a', '/repo'), false);
    assert.equal(isInside('/', '/repo'), false);
    assert.equal(isInside('/etc/hosts', '/repo'), false);
  });
  it('имя, начинающееся с двух точек, - не выход из каталога', () => {
    assert.equal(isInside('/repo/..hidden/a', '/repo'), true);
  });
});

describe('AllowedPaths.allows', () => {
  it('репозиторий, его содержимое и вложенный несуществующий путь (удалённый файл) разрешены', () => {
    const repo = mkdir('repo');
    const allowed = new AllowedPaths(() => [repo]);
    assert.equal(allowed.allows(repo), true);
    assert.equal(allowed.allows(path.join(repo, 'src', 'a.ts')), true);
  });

  it('вне корней, сосед с общим префиксом и корень файловой системы - отказ', () => {
    const repo = mkdir('repo');
    mkdir('repo-evil');
    const allowed = new AllowedPaths(() => [repo]);
    assert.equal(allowed.allows(path.join(base, 'repo-evil')), false);
    assert.equal(allowed.allows(base), false);
    assert.equal(allowed.allows('/'), false);
    assert.equal(allowed.allows('/etc/hosts'), false);
  });

  it('не строка, пустая, относительная, с NUL и с сегментом .. - отказ', () => {
    const repo = mkdir('repo');
    const allowed = new AllowedPaths(() => [repo]);
    for (const bad of [undefined, null, 7, {}, ['/x'], '', 'repo', './repo', `${repo}\0/x`, path.join(repo, '..', 'repo-evil'), `${repo}/a/../../x`]) {
      assert.equal(allowed.allows(bad), false, String(bad));
    }
  });

  it('/repo/link/.. не проходит: строка внутри репозитория, ядро раскрыло бы её по ссылке наружу', () => {
    const repo = mkdir('repo');
    const outside = mkdir('outside', 'deep');
    fs.symlinkSync(outside, path.join(repo, 'link'));
    const allowed = new AllowedPaths(() => [repo]);
    assert.equal(allowed.allows(`${path.join(repo, 'link')}/..`), false);
  });

  it('символьная ссылка внутри репозитория ведёт наружу - читается, как и в самом репозитории', () => {
    const repo = mkdir('repo');
    const outside = mkdir('outside');
    fs.writeFileSync(path.join(outside, 'f.txt'), 'x');
    fs.symlinkSync(outside, path.join(repo, 'link'));
    const allowed = new AllowedPaths(() => [repo]);
    assert.equal(allowed.allows(path.join(repo, 'link')), true);
    assert.equal(allowed.allows(path.join(repo, 'link', 'f.txt')), true);
    assert.equal(allowed.allows(outside), false);
  });

  it('корень назван через символьную ссылку, путь - физическим именем (и наоборот): по физическим путям разрешён', () => {
    const real = mkdir('real');
    fs.writeFileSync(path.join(real, 'a.txt'), '');
    const link = path.join(base, 'link');
    fs.symlinkSync(real, link);
    assert.equal(new AllowedPaths(() => [link]).allows(path.join(real, 'a.txt')), true);
    assert.equal(new AllowedPaths(() => [real]).allows(path.join(link, 'a.txt')), true);
  });

  it('корни считаются при каждой проверке: проект добавлен - путь разрешён, репозиторий убран - отказ', () => {
    const repo = mkdir('repo');
    let roots: string[] = [];
    const allowed = new AllowedPaths(() => roots);
    assert.equal(allowed.allows(repo), false);
    roots = [repo];
    assert.equal(allowed.allows(repo), true);
    roots = [];
    assert.equal(allowed.allows(repo), false);
  });

  it('assert: отказ - исключение с причиной, разрешённый путь проходит', () => {
    const repo = mkdir('repo');
    const allowed = new AllowedPaths(() => [repo]);
    assert.throws(() => allowed.assert('/etc'), OUTSIDE);
    assert.throws(() => allowed.assert(undefined), OUTSIDE);
    assert.doesNotThrow(() => allowed.assert(repo));
  });

  it('grant: выданный каталог разрешён, относительный не выдаётся', () => {
    const picked = mkdir('picked');
    const allowed = new AllowedPaths(() => []);
    allowed.grant('picked');
    allowed.grant(undefined);
    assert.equal(allowed.allows(picked), false);
    allowed.grant(picked);
    assert.equal(allowed.allows(path.join(picked, 'sub')), true);
  });
});

describe('обработчики каналов fs:* и git:*', () => {
  const setup = (repo: string, live: string[] = []) => {
    const calls: string[] = [];
    const record = (name: string) => (arg: string) => {
      calls.push(`${name}:${arg}`);
      return Promise.resolve(null as never);
    };
    const deps: PathHandlerDeps = {
      allowed: new AllowedPaths(() => [repo, ...live]),
      liveDirs: () => live,
      listDir: (dir) => record('listDir')(dir).then(() => []),
      listFiles: (root) => record('listFiles')(root).then(() => []),
      readTextFile: (file) => record('readTextFile')(file).then(() => ({ content: '' })),
      gitRoot: (dir) => record('gitRoot')(dir).then(() => path.dirname(dir)),
      gitBranch: record('gitBranch'),
      gitStatus: (root) => record('gitStatus')(root).then(() => ({})),
      gitHeadContent: record('gitHeadContent'),
    };
    return { handlers: createPathHandlers(deps), calls, deps };
  };

  it('каждый канал отказывает вне репозиториев, не доходя до файловой системы и git', async () => {
    const repo = mkdir('repo');
    const { handlers, calls } = setup(repo);
    for (const outside of ['/etc', '/etc/hosts', path.dirname(repo), `${repo}-evil`, undefined, 42]) {
      await assert.rejects(async () => handlers.list(outside), OUTSIDE);
      await assert.rejects(async () => handlers.files(outside), OUTSIDE);
      await assert.rejects(async () => handlers.read(outside), OUTSIDE);
      await assert.rejects(async () => handlers.root(outside), OUTSIDE);
      await assert.rejects(async () => handlers.branch(outside), OUTSIDE);
      await assert.rejects(async () => handlers.status(outside), OUTSIDE);
      await assert.rejects(async () => handlers.headContent(outside), OUTSIDE);
    }
    assert.deepEqual(calls, []);
  });

  it('в репозитории проекта все семь каналов отвечают', async () => {
    const repo = mkdir('repo');
    const { handlers, calls } = setup(repo);
    const file = path.join(repo, 'a.ts');
    await handlers.list(repo);
    await handlers.files(repo);
    await handlers.read(file);
    await handlers.root(repo);
    await handlers.branch(repo);
    await handlers.status(repo);
    await handlers.headContent(file);
    assert.deepEqual(calls.map((c) => c.split(':')[0]), ['listDir', 'listFiles', 'readTextFile', 'gitRoot', 'gitBranch', 'gitStatus', 'gitHeadContent']);
  });

  it('сессия ушла из репозиториев (cd): её cwd и git-корень разрешены, соседний каталог - нет', async () => {
    const repo = mkdir('repo');
    const elsewhere = mkdir('elsewhere', 'proj', 'sub');
    const root = path.dirname(elsewhere);
    const { handlers } = setup(repo, [elsewhere]);
    await assert.doesNotReject(async () => handlers.list(elsewhere));
    await assert.rejects(async () => handlers.status(root), OUTSIDE);
    assert.equal(await handlers.root(elsewhere), root);
    await assert.doesNotReject(async () => handlers.status(root));
    await assert.doesNotReject(async () => handlers.list(path.join(root, 'sub')));
    await assert.rejects(async () => handlers.list(path.dirname(root)), OUTSIDE);
  });

  it('корень каталога, не принадлежащего сессии, не выдаётся: родитель выбранного каталога остаётся закрытым', async () => {
    const repo = mkdir('repo');
    const picked = mkdir('home', 'proj');
    const { handlers } = setup(repo);
    assert.equal(handlers.picked(picked), picked);
    assert.equal(await handlers.root(picked), path.dirname(picked));
    await assert.rejects(async () => handlers.status(path.dirname(picked)), OUTSIDE);
  });

  it('каталог, выбранный в диалоге, доступен до сохранения проекта; отмена диалога ничего не выдаёт', async () => {
    const repo = mkdir('repo');
    const picked = mkdir('picked');
    const { handlers } = setup(repo);
    await assert.rejects(async () => handlers.root(picked), OUTSIDE);
    assert.equal(handlers.picked(null), null);
    await assert.rejects(async () => handlers.root(picked), OUTSIDE);
    assert.equal(handlers.picked(picked), picked);
    await assert.doesNotReject(async () => handlers.root(picked));
  });
});
