import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { jiraPrompt, validateJiraStart } from '../src/main/jira';
import { mrPrompt, validateSessionStart } from '../src/main/mrs';
import {
  DEFAULT_PROMPTS,
  PROMPT_IDS,
  PROMPT_PLACEHOLDERS,
  compactPrompts,
  effectivePrompts,
  fillPrompt,
  launchTemplate,
  launchTitle,
  parseLaunchButtons,
  parsePrompts,
  promptTemplate,
} from '../src/main/prompts';
import { PromptStore } from '../src/main/prompt-store';
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
    assert.throws(() => validateSessionStart({ mr, intent: 'review' }, raw), /«mr\.review»: text не может начинаться с «-».*Кнопки/s);
    assert.equal(validateSessionStart({ mr, intent: 'ci' }, raw), 'ок https://github.com/o/r/pull/5');
    assert.equal(promptTemplate('jira.start', raw), DEFAULT_PROMPTS['jira.start'].text);
  });

  it('поле prompts не объект - исключение для любой кнопки, не молчаливая замена встроенным', () => {
    for (const raw of [[], 'x', 5, null]) {
      assert.throws(() => validateSessionStart({ mr, intent: 'review' }, raw), /prompts должен быть объектом.*Кнопки/s, JSON.stringify(raw));
      assert.throws(() => validateSessionStart({ jira: { key: 'DEX-12' } }, raw), /prompts должен быть объектом/);
    }
  });

  it('некорректный аргумент по-прежнему null, а не исключение', () => {
    assert.equal(validateSessionStart({ mr, intent: 'нет' }, { 'mr.ci': { text: '-x' } }), null);
    assert.equal(validateSessionStart(null, undefined), null);
  });
});

describe('Промпты кнопок: действующий набор и compactPrompts', () => {
  it('действующий набор: все встроенные с описаниями, записи файла на своих местах, лишние в конце, buttons не в счёт', () => {
    const own = { 'mr.ci': { text: 'свой' }, 'вдруг': 1, buttons: [] };
    const set = effectivePrompts(own);
    assert.deepEqual(Object.keys(set), [...PROMPT_IDS, 'вдруг']);
    assert.deepEqual(set['mr.ci'], { text: 'свой' });
    assert.deepEqual(set['mr.review'], DEFAULT_PROMPTS['mr.review']);
  });

  it('compactPrompts убирает совпавшие со встроенными и пустой buttons', () => {
    assert.deepEqual(compactPrompts({ 'mr.ci': DEFAULT_PROMPTS['mr.ci'], 'mr.review': { text: 'свой' }, buttons: [] }), { 'mr.review': { text: 'свой' } });
  });
});

describe('Свои кнопки запуска: prompts.json', () => {
  const own = { place: 'mr', label: 'Объясни MR', text: 'Объясни {mr_url}', description: 'д' };

  it('ключ buttons не считается промптом с неизвестным id', () => {
    assert.deepEqual(parsePrompts({ buttons: [own] }), { prompts: {}, problems: [] });
  });

  it('годная кнопка разбирается; пустой файл - нет кнопок и замечаний', () => {
    assert.deepEqual(parseLaunchButtons({ buttons: [own] }).buttons, [{ place: 'mr', label: 'Объясни MR', text: 'Объясни {mr_url}', description: 'д' }]);
    assert.deepEqual(parseLaunchButtons(undefined), { buttons: [], bad: [], issues: [] });
  });

  it('негодная пропускается с причиной, прочие остаются', () => {
    const raw = { buttons: [{ ...own, label: 'Ревью' }, { ...own, text: '-p' }, { ...own, place: 'task', text: 'см {mr_url}' }, { ...own, label: 'Ок' }, 5, { ...own, label: 'Ок', text: 'повтор' }] };
    const parsed = parseLaunchButtons(raw);
    assert.deepEqual(parsed.buttons.map((b) => b.label), ['Ок']);
    assert.equal(parsed.bad.length, 5);
    assert.match(parsed.bad[0].message, /подпись встроенной кнопки/);
    assert.match(parsed.bad[2].message, /неизвестная подстановка \{mr_url\} \(есть: \{task_url\}, \{status_command\}\)/);
  });

  it('не больше 30 кнопок; buttons не массив - замечание', () => {
    const many = Array.from({ length: 31 }, (_, i) => ({ ...own, label: `К${i}` }));
    assert.equal(parseLaunchButtons({ buttons: many }).buttons.length, 30);
    assert.match(parseLaunchButtons({ buttons: many }).issues[0].message, /больше 30/);
    assert.match(parseLaunchButtons({ buttons: {} }).issues[0].message, /массив кнопок/);
  });

  it('launchTemplate: годная, негодная, исчезнувшая, выключенная', () => {
    assert.equal(launchTemplate('mr', 'объясни mr', { buttons: [own] }), 'Объясни {mr_url}');
    assert.throws(() => launchTemplate('mr', 'Объясни MR', { buttons: [{ ...own, text: '-p' }] }), /«-».*Воркспейс → Кнопки…/s);
    assert.throws(() => launchTemplate('mr', 'Нет', { buttons: [own] }), /больше нет/);
    assert.throws(() => launchTemplate('mr', 'Объясни MR', { buttons: [{ ...own, disabled: true }] }), /выключена/);
  });

  it('старт сессии по своей кнопке: подстановки места; негодная не мешает встроенной и другой своей', () => {
    const raw = { buttons: [own, { ...own, label: 'Плохая', text: '-p' }, { ...own, label: 'Другая', text: 'Смотри {mr_url}' }] };
    assert.equal(validateSessionStart({ mr, button: 'Объясни MR' }, raw), 'Объясни https://github.com/o/r/pull/5');
    assert.equal(validateSessionStart({ mr, button: 'Другая' }, raw), 'Смотри https://github.com/o/r/pull/5');
    assert.throws(() => validateSessionStart({ mr, button: 'Плохая' }, raw), /Плохая/);
    assert.equal(validateSessionStart({ mr, intent: 'review' }, raw), 'https://github.com/o/r/pull/5'.replace(/.*/, '/dex-auto:auto review https://github.com/o/r/pull/5'));
    const task = { buttons: [{ place: 'task', label: 'Задача', text: '{task_url} {status_command}' }, { place: 'jira', label: 'Ж', text: 'ключ {jira_key}' }] };
    assert.equal(validateSessionStart({ task: gh, button: 'Задача' }, task), 'https://github.com/o/r/issues/7 gh issue edit');
    assert.equal(validateSessionStart({ jira: { key: 'DEX-1' }, button: 'Ж' }, task), 'ключ DEX-1');
    assert.equal(validateSessionStart({ mr, button: '' }, raw), null);
    assert.equal(validateSessionStart({ mr, button: 'Объясни MR', intent: 'review' }, raw), null);
  });

  it('launchTitle: описание и промпт; у негодной - причина', () => {
    assert.equal(launchTitle('mr', 'Объясни MR', { buttons: [own] }), 'д\n\nОбъясни {mr_url}');
    assert.equal(launchTitle('mr', 'mr.review', undefined), `${DEFAULT_PROMPTS['mr.review'].description}\n\n${DEFAULT_PROMPTS['mr.review'].text}`);
    assert.match(launchTitle('mr', 'mr.review', { 'mr.review': { text: '-x' } }), /«mr\.review»/);
    assert.match(launchTitle('mr', 'Плохая', { buttons: [{ ...own, label: 'Плохая', text: '-x' }] }), /Плохая/);
  });
});


describe('PromptStore: общий файл промптов', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-prm-'));
    file = path.join(dir, 'prompts.json');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const prompts = { 'mr.ci': { text: 'свой' } };

  it('нет файла - undefined без замечаний; записанное читается как есть', () => {
    const store = new PromptStore(file);
    assert.deepEqual(store.read(), { raw: undefined });
    assert.equal(store.load(), undefined);
    store.savePrompts(prompts);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), prompts);
    assert.deepEqual(store.load(), prompts);
  });

  it('файл не JSON: редактору - замечание, старту сессии - ошибка, а не встроенный промпт молча', () => {
    fs.writeFileSync(file, '{ не json');
    const store = new PromptStore(file);
    assert.match(store.read().problem ?? '', /не разобран/);
    assert.throws(() => store.load(), /не разобран.*Кнопки/s);
  });
});