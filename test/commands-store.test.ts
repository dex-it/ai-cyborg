import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { MAX_COMMANDS_TEXT, saveCommandsText } from '../src/main/commands';
import { ProjectStore, type ProjectsState } from '../src/main/projects';

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-cmd-'));
  file = path.join(dir, 'team.cyborg.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const project = { id: 'p', name: 'P', description: '', repos: ['/r'], trackers: { github: false, gitlab: false } };
const state: ProjectsState = { projects: [project], lastProjectId: 'p' };
const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
const button = { label: 'A', text: 'a', submit: true };

describe('ProjectStore: кнопки команд в файле воркспейса', () => {
  it('нет файла или поля - undefined; поле читается как записано', () => {
    const store = new ProjectStore(file);
    assert.equal(store.loadCommands(), undefined);
    fs.writeFileSync(file, JSON.stringify({ projects: [], lastProjectId: null }));
    assert.equal(store.loadCommands(), undefined);
    fs.writeFileSync(file, JSON.stringify({ projects: [], lastProjectId: null, commands: [button] }));
    assert.deepEqual(store.loadCommands(), [button]);
  });

  it('saveCommands пишет только commands: проекты и чужие поля остаются', () => {
    fs.writeFileSync(file, JSON.stringify({ ...state, note: 'x' }));
    new ProjectStore(file).saveCommands([button]);
    assert.deepEqual(read(), { ...state, note: 'x', commands: [button] });
  });

  it('saveCommands на отсутствующий файл создаёт воркспейс с пустым перечнем проектов', () => {
    new ProjectStore(file).saveCommands([button]);
    assert.deepEqual(read(), { projects: [], lastProjectId: null, commands: [button] });
  });

  it('сохранение проектов не теряет кнопки, записанные другим каналом', () => {
    const store = new ProjectStore(file);
    store.save(state);
    store.saveCommands([button]);
    store.save({ ...state, lastProjectId: null });
    assert.deepEqual(read(), { ...state, lastProjectId: null, commands: [button] });
    assert.equal(store.load().projects.length, 1);
  });

  it('повреждённый файл не затирается записью кнопок', () => {
    fs.writeFileSync(file, '{oops');
    assert.throws(() => new ProjectStore(file).saveCommands([button]), /не разобран.*кнопки записаны не были/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{oops');
    fs.writeFileSync(file, '[1]');
    assert.throws(() => new ProjectStore(file).saveCommands([button]), /корень файла не объект/);
    assert.equal(fs.readFileSync(file, 'utf8'), '[1]');
  });

  it('не прочитанный файл (нет доступа) записью кнопок не затирается', () => {
    fs.mkdirSync(file);
    const store = new ProjectStore(file);
    store.load();
    assert.throws(() => store.saveCommands([button]), /не прочитан/);
  });
});

describe('saveCommandsText: запись из редактора', () => {
  const fake = () => {
    const saved: unknown[][] = [];
    return { saved, store: { saveCommands: (c: unknown[]) => void saved.push(c) } };
  };

  it('корректный текст проверяется и пишется массивом', () => {
    const { saved, store } = fake();
    assert.deepEqual(saveCommandsText(JSON.stringify([button]), store, true), {});
    assert.deepEqual(saved, [[button]]);
  });

  it('не строка, слишком длинный, не JSON и негодная кнопка - ошибка в ответе, запись не вызвана', () => {
    const { saved, store } = fake();
    for (const text of [42, null, 'x'.repeat(MAX_COMMANDS_TEXT + 1), '[{', '{}', '[{"label":"A"}]']) {
      assert.ok(saveCommandsText(text, store, true).error, String(text).slice(0, 20));
    }
    assert.deepEqual(saved, []);
  });

  it('отказ записи хранилища - в ответе, без исключения', () => {
    const store = {
      saveCommands: () => {
        throw new Error('диск полон');
      },
    };
    assert.deepEqual(saveCommandsText('[]', store, true), { error: 'диск полон' });
  });
});
