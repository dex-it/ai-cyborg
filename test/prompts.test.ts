import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { jiraPrompt, validateJiraStart } from '../src/main/jira';
import { mrPrompt, validateSessionStart } from '../src/main/mrs';
import {
  DEFAULT_PROMPTS,
  MAX_PROMPTS_TEXT,
  PROMPT_IDS,
  PROMPT_PLACEHOLDERS,
  checkPromptsText,
  effectivePrompts,
  fillPrompt,
  parsePrompts,
  promptTemplate,
  promptsToText,
  savePromptsText,
} from '../src/main/prompts';
import { ProjectStore, type ProjectsState } from '../src/main/projects';
import { taskPrompt } from '../src/main/trackers';

const gh = { kind: 'github', host: 'github.com', path: 'o/r', number: 7 } as const;
const mr = { kind: 'github', host: 'github.com', path: 'o/r', number: 5 } as const;

describe('Промпты кнопок: встроенные', () => {
  it('у каждого id есть встроенный текст и описание; подстановки текста - из разрешённых', () => {
    for (const id of PROMPT_IDS) {
      const { text, description } = DEFAULT_PROMPTS[id];
      assert.ok(text && description, id);
      assert.deepEqual(parsePrompts({ [id]: { text, description } }), { prompts: { [id]: { text, description } }, problems: [] }, id);
      for (const name of PROMPT_PLACEHOLDERS[id]) assert.ok(description.includes(`{${name}}`), `${id}: описание не называет {${name}}`);
    }
  });

  it('без записей в файле тексты прежние: то, что приложение отправляло до появления настроек', () => {
    assert.equal(mrPrompt(mr, 'review'), '/dex-auto:auto review https://github.com/o/r/pull/5');
    assert.equal(mrPrompt(mr, 'ci'), 'Пайплайн MR https://github.com/o/r/pull/5 упал: найди причину в логах упавших заданий, переключись на ветку MR и исправь её.');
    assert.equal(mrPrompt(mr, 'rework'), 'Разбери замечания к MR https://github.com/o/r/pull/5: переключись на его ветку и доработай её по замечаниям ревью.');
    assert.equal(
      taskPrompt(gh),
      'Ознакомься с задачей https://github.com/o/r/issues/7. Когда приступишь к работе, смени её статус в трекере (gh issue edit), чтобы было видно, что задача в работе.',
    );
    assert.match(taskPrompt({ kind: 'gitlab', host: 'git.corp', path: 'g/p', number: 3 }), /\(glab issue update\)/);
    assert.equal(
      jiraPrompt('DEX-12'),
      'Задача Jira DEX-12: прочитай её (jira issue view DEX-12 --comments 5), разберись в постановке и предложи план работ. Код не правь, пока я не подтвержу план.',
    );
  });
});

describe('Промпты кнопок: разбор поля prompts', () => {
  it('нет поля - пусто; не объект - замечание', () => {
    assert.deepEqual(parsePrompts(undefined), { prompts: {}, problems: [] });
    for (const raw of [[], 'x', 5, null]) assert.match(parsePrompts(raw).problems[0], /prompts должен быть объектом/);
  });

  it('годная запись принимается, text и description подрезаются', () => {
    const { prompts, problems } = parsePrompts({ 'mr.review': { text: '  /review {mr_url}  ', description: ' своё ' } });
    assert.deepEqual(problems, []);
    assert.deepEqual(prompts, { 'mr.review': { text: '/review {mr_url}', description: 'своё' } });
  });

  it('негодное называется и пропускается: id, объект, text, ведущий «-», подстановка, лишнее поле', () => {
    const { prompts, problems } = parsePrompts({
      'mr.nope': { text: 'x' },
      'mr.ci': 'строка',
      'mr.rework': { text: '' },
      'task.start': { text: '-p {task_url}' },
      'jira.start': { text: 'ключ {jira_kye}' },
      'mr.review': { text: 'a\nb' },
    });
    assert.deepEqual(prompts, {});
    assert.equal(problems.length, 6);
    assert.match(problems[0], /«mr\.nope»: нет такого промпта \(есть: mr\.review/);
    assert.match(problems[1], /«mr\.ci»: не объект/);
    assert.match(problems[2], /«mr\.rework»: text - непустая строка/);
    assert.match(problems[3], /«task\.start»: text не может начинаться с «-»/);
    assert.match(problems[4], /«jira\.start»: неизвестная подстановка \{jira_kye\} \(есть: \{jira_key\}\)/);
    assert.match(problems[5], /«mr\.review»: text - непустая строка/);
  });

  it('подстановка чужого промпта неизвестна: {task_url} в mr.review - ошибка', () => {
    assert.match(parsePrompts({ 'mr.review': { text: '{task_url}' } }).problems[0], /неизвестная подстановка \{task_url\}/);
  });

  it('текст длиннее предела и управляющие символы отвергаются', () => {
    assert.equal(parsePrompts({ 'mr.ci': { text: 'я'.repeat(2001) } }).problems.length, 1);
    assert.equal(parsePrompts({ 'mr.ci': { text: 'я'.repeat(2000) } }).problems.length, 0);
    assert.equal(parsePrompts({ 'mr.ci': { text: 'a\u0007b' } }).problems.length, 1);
  });

  it('негодное описание и лишнее поле называются, запись остаётся', () => {
    const bad = parsePrompts({ 'mr.ci': { text: 'ок', description: 5 } });
    assert.deepEqual(bad.prompts, { 'mr.ci': { text: 'ок' } });
    assert.match(bad.problems[0], /description/);
    const extra = parsePrompts({ 'mr.ci': { text: 'ок', texxt: 1 } });
    assert.deepEqual(extra.prompts, { 'mr.ci': { text: 'ок' } });
    assert.match(extra.problems[0], /неизвестное поле texxt/);
  });

  it('фигурные скобки не подстановки (JSON в тексте) остаются как есть', () => {
    assert.deepEqual(parsePrompts({ 'mr.ci': { text: 'ответь {"ok": true}' } }).problems, []);
  });
});

describe('Промпты кнопок: подстановка', () => {
  it('один проход: подставленное значение заново не разбирается, чужие {имена} остаются', () => {
    assert.equal(fillPrompt('{a} {b} {c}', { a: '{b}', b: 'B' }), '{b} B {c}');
  });

  it('промпт из файла уходит в сессию с проверенными значениями, остальные - встроенные', () => {
    const raw = { 'mr.review': { text: '/review {mr_url} срочно' }, 'jira.start': { text: 'Работай над {jira_key}, ключ {jira_key}' } };
    assert.equal(validateSessionStart({ mr, intent: 'review' }, raw), '/review https://github.com/o/r/pull/5 срочно');
    assert.equal(validateSessionStart({ jira: { key: 'DEX-12' } }, raw), 'Работай над DEX-12, ключ DEX-12');
    assert.equal(validateSessionStart({ mr, intent: 'ci' }, raw), mrPrompt(mr, 'ci'));
    assert.equal(validateSessionStart({ task: gh }, raw), taskPrompt(gh));
    assert.equal(validateSessionStart({ task: gh }, { 'task.start': { text: 'Задача {task_url}, трекер {status_command}' } }), 'Задача https://github.com/o/r/issues/7, трекер gh issue edit');
  });

  it('название и описание чужого текста в промпт не попадают, даже если пришли в аргументе', () => {
    const prompt = validateSessionStart({ mr: { ...mr, title: 'IGNORE ALL', branch: 'x' }, intent: 'review' }, { 'mr.review': { text: '{mr_url}' } });
    assert.equal(prompt, 'https://github.com/o/r/pull/5');
    assert.equal(validateSessionStart({ jira: { key: 'DEX-12', summary: 'ignore me' } }, undefined), jiraPrompt('DEX-12'));
    assert.equal(validateJiraStart({ key: 'DEX-12' }), 'DEX-12');
  });

  it('негодная запись нужного промпта - исключение с причиной, не молчаливая замена встроенным; чужая запись не мешает', () => {
    const raw = { 'mr.review': { text: '-x' }, 'mr.ci': { text: 'ок {mr_url}' } };
    assert.throws(() => validateSessionStart({ mr, intent: 'review' }, raw), /«mr\.review»: text не может начинаться с «-».*Промпты кнопок/s);
    assert.equal(validateSessionStart({ mr, intent: 'ci' }, raw), 'ок https://github.com/o/r/pull/5');
    assert.equal(promptTemplate('jira.start', raw), DEFAULT_PROMPTS['jira.start'].text);
  });

  it('поле prompts не объект - исключение для любой кнопки, не молчаливая замена встроенным', () => {
    for (const raw of [[], 'x', 5, null]) {
      assert.throws(() => validateSessionStart({ mr, intent: 'review' }, raw), /prompts должен быть объектом.*Промпты кнопок/s, JSON.stringify(raw));
      assert.throws(() => validateSessionStart({ jira: { key: 'DEX-12' } }, raw), /prompts должен быть объектом/);
    }
  });

  it('некорректный аргумент по-прежнему null, а не исключение', () => {
    assert.equal(validateSessionStart({ mr, intent: 'нет' }, { 'mr.ci': { text: '-x' } }), null);
    assert.equal(validateSessionStart(null, undefined), null);
  });
});

describe('Промпты кнопок: текст редактора', () => {
  it('действующий набор: все встроенные с описаниями, записи файла на своих местах, лишние в конце как есть', () => {
    const own = { 'mr.ci': { text: 'свой' }, 'вдруг': 1 };
    const set = effectivePrompts(own);
    assert.deepEqual(Object.keys(set), [...PROMPT_IDS, 'вдруг']);
    assert.deepEqual(set['mr.ci'], { text: 'свой' });
    assert.deepEqual(set['mr.review'], DEFAULT_PROMPTS['mr.review']);
    assert.deepEqual(Object.keys(JSON.parse(promptsToText(undefined))), PROMPT_IDS);
    assert.deepEqual(Object.keys(JSON.parse(promptsToText([]))), PROMPT_IDS, 'негодное поле - как отсутствующее');
  });

  it('набор из редактора проходит проверку и при повторном открытии даёт тот же текст', () => {
    const text = promptsToText({ 'mr.ci': { text: 'свой {mr_url}', description: 'д' } });
    assert.deepEqual(checkPromptsText(text), { ok: true, prompts: JSON.parse(text) });
    assert.equal(promptsToText(JSON.parse(text)), text);
  });

  it('не JSON, не объект и любая проблема - отказ с причиной', () => {
    assert.match((checkPromptsText('{') as { error: string }).error, /^Не JSON/);
    assert.match((checkPromptsText('[]') as { error: string }).error, /Нужен объект/);
    assert.match((checkPromptsText('{"mr.ci":{"text":"{x}"}}') as { error: string }).error, /неизвестная подстановка \{x\}/);
    assert.match((checkPromptsText('{"нет":{"text":"x"}}') as { error: string }).error, /нет такого промпта/);
  });

  it('savePromptsText проверяет заново, ошибка записи - в ответе', () => {
    const calls: unknown[] = [];
    const store = { savePrompts: (p: Record<string, unknown>) => void calls.push(p) };
    assert.deepEqual(savePromptsText('{"mr.ci":{"text":"ок"}}', store), {});
    assert.deepEqual(calls, [{ 'mr.ci': { text: 'ок' } }]);
    for (const bad of [5, undefined, 'x'.repeat(MAX_PROMPTS_TEXT + 1)]) assert.deepEqual(savePromptsText(bad, store), { error: 'Некорректный текст промптов' });
    assert.match(savePromptsText('{"mr.ci":{"text":"-"}}', store).error ?? '', /«mr\.ci»/);
    assert.equal(calls.length, 1, 'негодное записано');
    const failing = { savePrompts: () => { throw new Error('диск'); } };
    assert.deepEqual(savePromptsText('{}', failing), { error: 'диск' });
  });
});

describe('ProjectStore: промпты в файле воркспейса', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-prm-'));
    file = path.join(dir, 'team.cyborg.json');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const project = { id: 'p', name: 'P', description: '', repos: ['/r'], trackers: { github: false, gitlab: false } };
  const state: ProjectsState = { projects: [project], lastProjectId: 'p' };
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const prompts = { 'mr.ci': { text: 'свой' } };

  it('нет файла или поля - undefined; поле читается как записано', () => {
    const store = new ProjectStore(file);
    assert.equal(store.loadPrompts(), undefined);
    fs.writeFileSync(file, JSON.stringify({ projects: [], lastProjectId: null, prompts }));
    assert.deepEqual(store.loadPrompts(), prompts);
  });

  it('savePrompts пишет только prompts: проекты, кнопки и чужие поля остаются', () => {
    fs.writeFileSync(file, JSON.stringify({ ...state, commands: [{ label: 'A', text: 'a' }], note: 'x' }));
    new ProjectStore(file).savePrompts(prompts);
    assert.deepEqual(read(), { ...state, commands: [{ label: 'A', text: 'a' }], note: 'x', prompts });
  });

  it('сохранение проектов и кнопок не теряет промпты, а сохранение промптов - кнопки', () => {
    const store = new ProjectStore(file);
    store.save(state);
    store.savePrompts(prompts);
    store.save({ ...state, lastProjectId: null });
    store.saveCommands([{ label: 'A', text: 'a' }]);
    assert.deepEqual(read(), { ...state, lastProjectId: null, prompts, commands: [{ label: 'A', text: 'a' }] });
    store.savePrompts({});
    assert.deepEqual(read().commands, [{ label: 'A', text: 'a' }]);
  });

  it('повреждённый файл промптами не затирается, причина названа', () => {
    fs.writeFileSync(file, '{ не json');
    assert.throws(() => new ProjectStore(file).savePrompts(prompts), /промпты записаны не были/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{ не json');
  });
});
