import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { gitRemotes } from '../src/main/git';
import { writeJsonAtomic } from '../src/main/jsonfile';
import { ProjectStore, type ProjectsState } from '../src/main/projects';
import { saveProjectsState, TrackerSettingsStore, validateProjectsState } from '../src/main/trackers';

let dir: string;
beforeEach(() => void (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-store-'))));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('TrackerSettingsStore', () => {
  it('первый запуск и битый файл - обе галочки выключены', () => {
    const file = path.join(dir, 'trackers.json');
    assert.deepEqual(new TrackerSettingsStore(file).load(), { github: false, gitlab: false });
    fs.writeFileSync(file, '{oops');
    assert.deepEqual(new TrackerSettingsStore(file).load(), { github: false, gitlab: false });
  });
  it('нестрогие значения в файле не включают источник', () => {
    const file = path.join(dir, 'trackers.json');
    fs.writeFileSync(file, JSON.stringify({ github: 'true', gitlab: 1 }));
    assert.deepEqual(new TrackerSettingsStore(file).load(), { github: false, gitlab: false });
  });
});

describe('запись JSON', () => {
  it('атомарно: временного файла не остаётся', () => {
    const file = path.join(dir, 'x.json');
    writeJsonAtomic(file, { a: 1 });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1 });
    assert.deepEqual(fs.readdirSync(dir), ['x.json']);
  });
  it('состояние переживает «перезапуск» с флагами источников у каждого проекта', () => {
    const file = path.join(dir, 'projects.json');
    const mk = (id: string, trackers: { github: boolean; gitlab: boolean }) => ({ id, name: id, description: 'd', repos: ['/a'], trackers });
    const state = { projects: [mk('1', { github: true, gitlab: false }), mk('2', { github: false, gitlab: true })], lastProjectId: '1' };
    new ProjectStore(file).save(state);
    assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(state, null, 2));
    assert.deepEqual(new ProjectStore(file).load(), state);
  });
});

describe('ProjectStore: источники задач проекта', () => {
  const base = { id: '1', name: 'n', description: 'd', repos: ['/a'] };
  const write = (projects: object[]) => fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify({ projects, lastProjectId: null }));
  const legacy = (value: unknown) => fs.writeFileSync(path.join(dir, 'trackers.json'), typeof value === 'string' ? value : JSON.stringify(value));
  const store = (counter = { n: 0 }) =>
    new ProjectStore(path.join(dir, 'projects.json'), () => (counter.n++, new TrackerSettingsStore(path.join(dir, 'trackers.json')).load()));
  const flags = (s: ProjectsState) => s.projects.map((p) => p.trackers);

  it('проект без поля получает значения trackers.json', () => {
    legacy({ github: true, gitlab: false });
    write([base]);
    assert.deepEqual(flags(store().load()), [{ github: true, gitlab: false }]);
  });
  it('поле не объект (null, строка, число, массив) читается как отсутствующее', () => {
    legacy({ github: false, gitlab: true });
    write([1, 'x', null, 7, []].map((trackers, i) => ({ ...base, id: String(i), trackers })));
    assert.deepEqual(flags(store().load()), Array(5).fill({ github: false, gitlab: true }));
  });
  it('в объекте любое значение, кроме true, - выключен; trackers.json не подставляется, лишние ключи отброшены', () => {
    legacy({ github: true, gitlab: true });
    write([{ ...base, trackers: { github: 'true', gitlab: true, token: 'x' } }, { ...base, id: '2', trackers: {} }]);
    const counter = { n: 0 };
    assert.deepEqual(flags(store(counter).load()), [{ github: false, gitlab: true }, { github: false, gitlab: false }]);
    assert.equal(counter.n, 0);
  });
  it('нет и битый trackers.json - оба выключены', () => {
    write([base]);
    assert.deepEqual(flags(store().load()), [{ github: false, gitlab: false }]);
    legacy('{oops');
    assert.deepEqual(flags(store().load()), [{ github: false, gitlab: false }]);
  });
  it('trackers.json читается не больше одного раза за load и только если у проекта нет поля', () => {
    legacy({ github: true, gitlab: false });
    const counter = { n: 0 };
    write([base, { ...base, id: '2' }]);
    store(counter).load();
    assert.equal(counter.n, 1);
  });
  it('подстановка однократна: после сохранения смена trackers.json проект не меняет, trackers.json не пишется', () => {
    legacy({ github: true, gitlab: false });
    write([base]);
    const projects = store();
    const legacyBefore = fs.readFileSync(path.join(dir, 'trackers.json'), 'utf8');
    saveProjectsState(projects.load(), projects, { resetAuth: () => assert.fail('миграция не меняет источники') });
    legacy({ github: false, gitlab: true });
    const legacyAfterEdit = fs.readFileSync(path.join(dir, 'trackers.json'), 'utf8');
    assert.deepEqual(flags(projects.load()), [{ github: true, gitlab: false }]);
    assert.notEqual(legacyBefore, legacyAfterEdit);
    assert.equal(fs.readFileSync(path.join(dir, 'trackers.json'), 'utf8'), legacyAfterEdit);
  });
  it('trackers.json байт в байт прежний после сохранения проектов', () => {
    legacy({ github: true, gitlab: false });
    const before = fs.readFileSync(path.join(dir, 'trackers.json'), 'utf8');
    const projects = store();
    saveProjectsState({ projects: [{ ...base, trackers: { github: false, gitlab: true } }], lastProjectId: null }, projects, { resetAuth() {} });
    assert.equal(fs.readFileSync(path.join(dir, 'trackers.json'), 'utf8'), before);
    assert.deepEqual(validateProjectsState(projects.load())?.projects[0].trackers, { github: false, gitlab: true });
  });
  it('нет проектов или повреждён projects.json - пустое состояние, trackers.json не читается', () => {
    const counter = { n: 0 };
    assert.deepEqual(store(counter).load(), { projects: [], lastProjectId: null });
    fs.writeFileSync(path.join(dir, 'projects.json'), '{oops');
    assert.deepEqual(store(counter).load(), { projects: [], lastProjectId: null });
    assert.equal(counter.n, 0);
  });
});

describe('gitRemotes', () => {
  it('отдаёт fetch-URL всех remote, для не-git и репозитория без remote - пусто', async () => {
    execFileSync('git', ['init', '-q', dir]);
    assert.deepEqual(await gitRemotes(dir), []);
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'git@github.com:o/r.git']);
    execFileSync('git', ['-C', dir, 'remote', 'add', 'upstream', 'https://github.com/u/r']);
    assert.deepEqual((await gitRemotes(dir)).sort(), ['git@github.com:o/r.git', 'https://github.com/u/r']);
    assert.deepEqual(await gitRemotes(path.join(dir, 'missing')), []);
  });
  it('remote частичного клона: суффикс [blob:none] после (fetch) не прячет remote', async () => {
    execFileSync('git', ['init', '-q', dir]);
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'git@github.com:o/r.git']);
    execFileSync('git', ['-C', dir, 'config', 'remote.origin.partialclonefilter', 'blob:none']);
    assert.deepEqual(await gitRemotes(dir), ['git@github.com:o/r.git']);
  });
});
