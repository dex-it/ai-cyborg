import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import './legacy-commands';
import { checkLayer, compactLayer, parseLayer, resolveBar } from '../src/main/commands';
import {
  addButton,
  addLaunchButton,
  buttonsView,
  composeBar,
  giveBackHotkey,
  layerCtx,
  moveButton,
  patchAt,
  promptsProblem,
  removeAt,
  removeButton,
  removeLaunchButton,
  renameButton,
  replaceButton,
  resetField,
  setBuiltinPrompt,
  setDisabled,
  setFields,
  updateLaunchButton,
  validateButtonCall,
  type ButtonsState,
  type OpResult,
} from '../src/shared/buttons';

const state = (over: Partial<ButtonsState['commands']> = {}, prompts?: unknown, hasWorkspace = true): ButtonsState => ({ commands: { global: undefined, workspace: undefined, ...over }, prompts, hasWorkspace, mac: false });
const entries = (r: OpResult): unknown[] => {
  assert.ok(r.ok, r.ok ? '' : r.error);
  return r.entries;
};
const rowOf = (s: ButtonsState, layer: 'global' | 'workspace', label: string) => buttonsView(s, layer).groups.flatMap((g) => g.rows).find((r) => r.label === label);

describe('Окно «Кнопки»: вид', () => {
  it('четыре места: полоса и три места запуска; у встроенных кнопок запуска нет сочетаний и есть подпись карточки', () => {
    const view = buttonsView(state(), 'global');
    assert.deepEqual(view.groups.map((g) => g.place), ['bar', 'mr', 'task', 'jira']);
    assert.deepEqual(view.groups[1].rows.map((r) => [r.label, r.card]), [['Ревью', 'Ревью'], ['Доработать', 'Доработать'], ['CI', 'Разобрать пайплайн']]);
    assert.ok(view.groups[0].rows.every((r) => r.origin === 'builtin' && r.kind === 'bar'));
  });

  it('слой воркспейса: кнопки запуска только для чтения, у полей видно слой-источник', () => {
    const s = state({ global: [{ label: 'Сливай', hotkey: 'F6' }], workspace: [{ label: 'Сливай', text: 'свой' }] });
    const row = rowOf(s, 'workspace', 'Сливай');
    assert.deepEqual([row?.from.text, row?.from.hotkey, row?.origin], ['workspace', 'global', 'builtin']);
    assert.ok(buttonsView(s, 'workspace').groups.slice(1).flatMap((g) => g.rows).every((r) => r.readOnly));
    assert.ok(buttonsView(s, 'global').groups.slice(1).flatMap((g) => g.rows).every((r) => !r.readOnly));
  });

  it('сочетание, забранное верхней кнопкой, названо у проигравшей; выключенная замена видна парой', () => {
    const s = state({ global: [{ label: 'Сливай', hotkey: 'F6' }], workspace: [{ label: 'Моя', text: 'м', hotkey: 'F6' }] });
    assert.equal(rowOf(s, 'workspace', 'Сливай')?.hotkeyLostTo, 'Моя');
    const global = [{ label: 'Сливай', hotkey: 'F6' }];
    const replaced = state({ global, workspace: entries(replaceButton(layerCtx(state({ global }), 'workspace'), 'Сливай', { label: 'Новая', text: 'н' })) });
    assert.equal(rowOf(replaced, 'workspace', 'Сливай')?.replacedBy, 'Новая');
    assert.equal(rowOf(replaced, 'workspace', 'Новая')?.replaces, 'Сливай');
    assert.equal(rowOf(replaced, 'workspace', 'Сливай')?.disabled, true);
  });

  it('негодная запись слоя видна строкой с причиной, а не пропадает', () => {
    const view = buttonsView(state({ workspace: [{ label: 'X', text: '' }, 5] }), 'workspace');
    assert.ok(view.groups[0].rows.some((r) => r.label === 'X' && r.issue));
    assert.ok(view.groups[0].rows.some((r) => r.key.startsWith('bar:#') && r.issue));
  });

  it('негодные кнопки запуска и промпты названы в строках и общих замечаниях', () => {
    const view = buttonsView(state({}, { 'mr.ci': { text: '-x' }, buttons: [{ place: 'mr', label: 'Плохая', text: '-p' }, { place: 'jira', label: 'Хорошая', text: 'ок {jira_key}' }], 'чужой': 1 }), 'global');
    assert.ok(view.groups[1].rows.find((r) => r.label === 'CI')?.issue);
    assert.ok(view.groups[1].rows.find((r) => r.label === 'Плохая')?.issue);
    assert.equal(view.groups[3].rows.find((r) => r.label === 'Хорошая')?.kind, 'launch');
    assert.ok(view.issues.some((i) => /чужой/.test(i)));
  });
});

describe('Окно «Кнопки»: операции над слоем', () => {
  const ws = (workspace?: unknown[], global?: unknown[]) => layerCtx(state({ workspace, global }), 'workspace');

  it('правка поля унаследованной кнопки пишет частичную запись; сброс убирает поле', () => {
    const edited = entries(setFields(ws(), 'Сливай', { hotkey: 'Alt+L' }));
    assert.deepEqual(edited, [{ label: 'Сливай', hotkey: 'Alt+L' }]);
    assert.deepEqual(entries(resetField(ws(edited), 'Сливай', 'hotkey')), [{ label: 'Сливай' }]);
    assert.ok(!setFields(ws(), 'Нет такой', { text: 'x' }).ok);
  });

  it('выключение и включение: у унаследованной - disabled: false, у своей - поле снимается', () => {
    const off = entries(setDisabled(ws(), 'Мердж', true));
    assert.deepEqual(off, [{ label: 'Мердж', disabled: true }]);
    assert.deepEqual(entries(setDisabled(ws(off), 'Мердж', false)), [{ label: 'Мердж', disabled: false }]);
    const own = entries(addButton(ws(), { label: 'Моя', text: 'м' }));
    const ownOff = entries(setDisabled(ws(own), 'Моя', true));
    assert.deepEqual(entries(setDisabled(ws(ownOff), 'Моя', false)), own);
  });

  it('добавление: занятая подпись отказ; переименование своей на месте, унаследованной - отказ', () => {
    const own = entries(addButton(ws(), { label: 'Моя', text: 'м', submit: true }));
    assert.deepEqual(own, [{ label: 'Моя', text: 'м', submit: true }]);
    const dup = addButton(ws(own), { label: 'моя', text: 'x' });
    assert.ok(!dup.ok && dup.field === 'label');
    assert.ok(!addButton(ws(), { label: 'сливай', text: 'x' }).ok);
    assert.deepEqual(entries(renameButton(ws(own), 'Моя', 'Другая')), [{ label: 'Другая', text: 'м', submit: true }]);
    assert.ok(!renameButton(ws(), 'Сливай', 'Другая').ok);
  });

  it('замена: нижняя кнопка выключена в слое, новая встаёт на её место с её сочетанием', () => {
    const base = ws([], [{ label: 'Сливай', hotkey: 'F6' }]);
    const out = entries(replaceButton(base, 'Сливай', { label: 'Новая', text: 'н', submit: true }));
    const rest = layerCtx(state({ global: base.below.length ? [{ label: 'Сливай', hotkey: 'F6' }] : undefined }), 'workspace').rows.slice(1).map((r) => ({ label: r.label }));
    assert.deepEqual(out, [{ label: 'Сливай', disabled: true }, { label: 'Новая', text: 'н', submit: true, hotkey: 'F6' }, ...rest]);
    const saved = compactLayer(parseLayer(out, false, 'workspace').entries, base.below, false);
    const placed = resolveBar({ global: [{ label: 'Сливай', hotkey: 'F6' }], workspace: saved }, false).rows.map((r) => r.label);
    assert.deepEqual(placed.slice(0, 2), ['Сливай', 'Новая']);
    assert.ok(!replaceButton(ws(), 'Сливай', { label: 'Мердж', text: 'x' }).ok);
    assert.ok(!replaceButton(ws(), 'Нет', { label: 'Н', text: 'x' }).ok);
  });

  it('перестановка: порядок слоя пишется для всех кнопок; удаление своей записи', () => {
    const labels = layerCtx(state(), 'workspace').rows.map((r) => r.label);
    const moved = entries(moveButton(ws(), 3, 0)) as { label: string }[];
    assert.deepEqual(moved.map((e) => e.label), [labels[3], ...labels.slice(0, 3)]);
    assert.deepEqual(entries(moveButton(ws(), 1, 1)), []);
    const own = entries(addButton(ws(), { label: 'Моя', text: 'м' }));
    assert.deepEqual(entries(removeButton(ws(own), 'Моя')), []);
    assert.ok(!removeButton(ws(), 'Моя').ok);
  });

  it('вернуть сочетание проигравшей: у забравшей запись слоя убирается либо снимается снизу', () => {
    const own = [{ label: 'Моя', text: 'м', hotkey: 'F6' }];
    const lower = ws(own, [{ label: 'Сливай', hotkey: 'F6' }]);
    assert.deepEqual(entries(giveBackHotkey(lower, 'Сливай')), [{ label: 'Моя', text: 'м' }]);
    const fromBelow = layerCtx(state({ global: [{ label: 'Сливай', hotkey: 'F6' }, { label: 'Другая', text: 'д', hotkey: 'F6' }] }), 'workspace');
    assert.ok(!giveBackHotkey(fromBelow, 'Мердж').ok);
  });
});

describe('Окно «Кнопки»: кнопки запуска', () => {
  it('встроенный промпт: запись под id, null возвращает встроенный', () => {
    const set = setBuiltinPrompt(undefined, 'mr.ci', { text: 'свой {mr_url}' });
    assert.equal((set['mr.ci'] as { text: string }).text, 'свой {mr_url}');
    assert.deepEqual(setBuiltinPrompt(set, 'mr.ci', null), {});
  });

  it('своя кнопка: добавить, обновить, выключить, удалить; чужой ключ файла сохраняется', () => {
    const added = addLaunchButton({ 'чужой': 1 }, { place: 'mr', label: 'Объясни', text: 'объясни {mr_url}' });
    assert.equal(added['чужой'], 1);
    const off = updateLaunchButton(added, 'mr', 'объясни', { disabled: true });
    assert.deepEqual(off?.buttons, [{ place: 'mr', label: 'Объясни', text: 'объясни {mr_url}', disabled: true }]);
    assert.deepEqual(updateLaunchButton(off, 'mr', 'Объясни', { disabled: false })?.buttons, [{ place: 'mr', label: 'Объясни', text: 'объясни {mr_url}' }]);
    assert.equal(updateLaunchButton(added, 'mr', 'Нет', { text: 'x' }), null);
    assert.deepEqual(removeLaunchButton(added, 'mr', 'Объясни')?.buttons, []);
    assert.equal(removeLaunchButton(added, 'task', 'Объясни'), null);
  });

  it('promptsProblem называет первую причину: промпт, затем своя кнопка', () => {
    assert.equal(promptsProblem({}), null);
    assert.match(promptsProblem({ 'jira.start': { text: 'x {jira_kye}' } }) ?? '', /jira_kye/);
    assert.match(promptsProblem({ buttons: [{ place: 'mr', label: 'А', text: '-p' }] }) ?? '', /«-»/);
  });
});

describe('Инструменты кнопок: форма аргументов', () => {
  it('по умолчанию место bar и слой workspace; лишнее поле, чужой тип и пустая подпись - отказ с причиной', () => {
    assert.deepEqual(validateButtonCall('add_button', { label: ' Деплой ', text: 'д' }), { place: 'bar', label: 'Деплой', layer: 'workspace', text: 'д' });
    for (const [name, args, re] of [
      ['add_button', { label: 'A', text: 'a', extra: 1 }, /лишние/],
      ['add_button', { label: '', text: 'a' }, /label/],
      ['add_button', { label: 'A', place: 'x' }, /place/],
      ['add_button', { label: 'A', layer: 'global' }, /layer/],
      ['add_button', { label: 'A', hotkey: null }, /hotkey/],
      ['update_button', { label: 'A', submit: 'да' }, /submit/],
      ['update_button', { label: 'A', reset: ['label'] }, /reset/],
      ['disable_button', { label: 'A', disabled: 1 }, /disabled/],
      ['nope', {}, /объект/],
    ] as const) {
      const r = validateButtonCall(name, args);
      assert.ok(typeof r === 'string' && re.test(r), `${name} ${JSON.stringify(args)}: ${String(r)}`);
    }
    assert.deepEqual(validateButtonCall('update_button', { label: 'A', hotkey: null, reset: ['text'], new_label: 'B' }), { place: 'bar', label: 'A', layer: 'workspace', hotkey: null, reset: ['text'], newLabel: 'B' });
  });
});

describe('Окно «Кнопки»: путь формы', () => {
  const global = [{ label: 'Сливай', hotkey: 'F6' }];

  it('замена встроенной через форму окна сохраняет её сочетание у новой кнопки', () => {
    const s = state({ global });
    const out = entries(composeBar(layerCtx(s, 'workspace'), { label: 'Слить в release', text: 'x', submit: false, replace: 'Сливай' }));
    const mine = out.find((e) => (e as { label: string }).label === 'Слить в release');
    assert.equal((mine as { hotkey?: string }).hotkey, 'F6');
    const after = resolveBar({ global, workspace: out }, false);
    assert.equal(after.buttons.find((b) => b.label === 'Слить в release')?.hotkey, 'F6');
    assert.ok(!after.buttons.some((b) => b.label === 'Сливай'));
    const own = entries(composeBar(layerCtx(s, 'workspace'), { label: 'Другая', text: 'x', submit: false, replace: 'Сливай', hotkey: 'Alt+Q' }));
    assert.equal((own.find((e) => (e as { label: string }).label === 'Другая') as { hotkey?: string }).hotkey, 'Alt+Q');
  });

  it('форма новой кнопки несёт описание', () => {
    const out = entries(composeBar(layerCtx(state(), 'workspace'), { label: 'Н', text: 'x', submit: true, description: 'д' }));
    assert.deepEqual(out, [{ label: 'Н', text: 'x', submit: true, description: 'д' }]);
  });

  it('частичная запись без кнопки ниже видна строкой, её можно поправить и удалить, после чего слой сохраняется', () => {
    const s = state({ workspace: [{ label: 'Нет такой', hotkey: 'Alt+N' }] });
    const row = rowOf(s, 'workspace', 'Нет такой');
    assert.ok(row?.issue && row.rawIndex === 0);
    const ctx = layerCtx(s, 'workspace');
    const fixed = entries(patchAt(ctx, 0, { text: 'ок' }));
    assert.equal(checkLayer('workspace', fixed, { global: undefined, workspace: undefined }, false).ok, true);
    const gone = entries(removeAt(ctx, 0));
    assert.equal(checkLayer('workspace', gone, { global: undefined, workspace: undefined }, false).ok, true);
  });

  it('запись с пустым text видна строкой по номеру, исправляется текстом и удаляется; запись не объект - только удалением', () => {
    const s = state({ workspace: [{ label: 'X', text: '' }, 5] });
    const rows = buttonsView(s, 'workspace').groups[0].rows.filter((r) => r.rawIndex !== undefined);
    assert.deepEqual(rows.map((r) => [r.rawIndex, !!r.issue]), [[0, true], [1, true]]);
    const ctx = layerCtx(s, 'workspace');
    assert.deepEqual(entries(patchAt(ctx, 0, { text: 'т' })), [{ label: 'X', text: 'т' }, 5]);
    assert.ok(!patchAt(ctx, 1, { text: 'т' }).ok);
    assert.deepEqual(entries(removeAt(ctx, 1)), [{ label: 'X', text: '' }]);
    assert.ok(!removeAt(ctx, 7).ok);
  });

  it('негодная запись над встроенной подписью тоже получает свою строку', () => {
    const rows = buttonsView(state({ workspace: [{ label: 'Сливай', text: '' }] }), 'workspace').groups[0].rows;
    assert.ok(rows.some((r) => r.key === 'bar:#0' && r.issue));
    assert.ok(!rows.find((r) => r.key === 'bar:сливай')?.issue);
  });

  it('встроенная кнопка запуска с правкой в prompts.json остаётся встроенной, правка видна в from и changed', () => {
    const s = state({}, { 'mr.review': { text: 'мой {mr_url}' } });
    const row = rowOf(s, 'global', 'Ревью');
    assert.deepEqual([row?.origin, row?.from.text, row?.changed], ['builtin', 'global', true]);
    assert.equal(rowOf(s, 'workspace', 'Ревью')?.changed, false);
  });
});
