import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { gitRemotes } from '../src/main/git';
import { writeJsonAtomic } from '../src/main/jsonfile';
import { ProjectStore } from '../src/main/projects';
import { TrackerSettingsStore } from '../src/main/trackers';

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
  it('выбор переживает «перезапуск» (новый экземпляр) и хранит только два флага', () => {
    const file = path.join(dir, 'trackers.json');
    new TrackerSettingsStore(file).save({ github: true, gitlab: false });
    assert.deepEqual(new TrackerSettingsStore(file).load(), { github: true, gitlab: false });
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).sort(), ['github', 'gitlab']);
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
  it('формат projects.json не изменился', () => {
    const file = path.join(dir, 'projects.json');
    const state = { projects: [{ id: '1', name: 'n', description: 'd', repos: ['/a'] }], lastProjectId: '1' };
    new ProjectStore(file).save(state);
    assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(state, null, 2));
    assert.deepEqual(new ProjectStore(file).load(), state);
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
