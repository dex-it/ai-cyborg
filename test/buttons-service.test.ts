import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ButtonsService, type ButtonsNotice } from '../src/main/buttons-service';

function rig(opts: { workspace?: boolean; global?: unknown; ws?: unknown; prompts?: unknown } = {}) {
  const files = { global: opts.global, ws: opts.ws, prompts: opts.prompts };
  const writes: string[] = [];
  const notices: ButtonsNotice[] = [];
  const open = opts.workspace !== false;
  const service = new ButtonsService({
    commands: { read: () => ({ raw: files.global }), saveCommands: (c) => { files.global = c; writes.push('global'); } },
    prompts: { read: () => ({ raw: files.prompts }), savePrompts: (p) => { files.prompts = p; writes.push('prompts'); } },
    workspace: () => ({ open, name: open ? 'WS' : null, load: () => files.ws, save: (c) => { files.ws = c; writes.push('ws'); } }),
    mac: false,
    announce: (_caller, notice) => notices.push(notice),
  });
  return { files, writes, notices, service };
}
const throws = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: Error) => re.test(e.message), String(re));

describe('Кнопки: запись из окна', () => {
  it('слой общих меняет commands.json и не трогает воркспейс', () => {
    const r = rig({ ws: [{ label: 'Мой', text: 'м' }] });
    assert.deepEqual(r.service.save({ scope: 'global', commands: [{ label: 'Деплой', text: 'д' }], base: { commands: undefined } }), {});
    assert.deepEqual(r.files.global, [{ label: 'Деплой', text: 'д' }]);
    assert.deepEqual(r.writes, ['global']);
  });

  it('слой воркспейса пишет только поле commands и сжимает копии', () => {
    const r = rig();
    const copy = { label: 'Сливай', text: 'сливай', submit: true, hotkey: 'F1', description: 'Фраза «сливай»: слить PR текущей ветки.' };
    assert.deepEqual(r.service.save({ scope: 'workspace', commands: [copy, { label: 'Мердж', hotkey: 'Alt+M' }], base: { commands: undefined } }), {});
    assert.deepEqual(r.files.ws, [{ label: 'Мердж', hotkey: 'Alt+M' }]);
    assert.deepEqual(r.writes, ['ws']);
  });

  it('отказ: файлы не меняются, причина у кнопки и поля', () => {
    const r = rig();
    const reply = r.service.save({ scope: 'workspace', commands: [{ label: 'A', text: 'a', hotkey: 'Ctrl+C' }], base: { commands: undefined } });
    assert.ok(reply.error);
    assert.deepEqual([reply.issues?.[0].label, reply.issues?.[0].field], ['A', 'hotkey']);
    assert.deepEqual(r.writes, []);
  });

  it('без воркспейса слой воркспейса отказывает; промпты в слое воркспейса - тоже', () => {
    const none = rig({ workspace: false });
    assert.match(none.service.save({ scope: 'workspace', commands: [], base: {} }).error ?? '', /Воркспейс не открыт/);
    const r = rig();
    assert.ok(r.service.save({ scope: 'workspace', commands: [], prompts: {}, base: {} }).error);
    assert.match(r.service.save({ scope: 'other', commands: [], base: {} }).error ?? '', /Неизвестный набор/);
    assert.match(r.service.save('x').error ?? '', /Некорректный запрос/);
  });

  it('файл изменили снаружи после открытия окна: отказ, файл не затёрт', () => {
    const r = rig({ global: [{ label: 'Внешняя', text: 'в' }] });
    const reply = r.service.save({ scope: 'global', commands: [], base: { commands: [] } });
    assert.match(reply.error ?? '', /изменились на диске/);
    assert.deepEqual(r.files.global, [{ label: 'Внешняя', text: 'в' }]);
  });

  it('своя кнопка запуска пишется в prompts.json, промпт как встроенный не пишется', () => {
    const r = rig();
    const prompts = { buttons: [{ place: 'mr', label: 'Объясни', text: 'объясни {mr_url}' }] };
    assert.deepEqual(r.service.save({ scope: 'global', commands: [], prompts, base: { commands: undefined, prompts: undefined } }), {});
    assert.deepEqual(r.files.prompts, prompts);
    const bad = r.service.save({ scope: 'global', commands: [], prompts: { buttons: [{ place: 'task', label: 'Х', text: 'см {mr_url}' }] }, base: { commands: [], prompts: prompts } });
    assert.match(bad.error ?? '', /неизвестная подстановка \{mr_url\}/);
    assert.deepEqual(r.files.prompts, prompts);
  });
});

describe('Кнопки: инструменты сессии', () => {
  it('add_button по умолчанию пишет в воркспейс, с layer all - в общие; уведомление и «забрала у»', () => {
    const r = rig();
    const text = r.service.add(1, { label: 'Деплой', text: 'задеплой', hotkey: 'F2' });
    assert.deepEqual(r.files.ws, [{ label: 'Деплой', text: 'задеплой', hotkey: 'F2' }]);
    assert.match(text, /забрано у «Сделай PR»/);
    assert.deepEqual([r.notices[0].verb, r.notices[0].label, r.notices[0].took, r.notices[0].hotkey], ['added', 'Деплой', ['Сделай PR'], 'F2']);
    r.service.add(1, { label: 'Общая', text: 'о', layer: 'all' });
    assert.deepEqual(r.files.global, [{ label: 'Общая', text: 'о' }]);
  });

  it('отказ называет кнопку и поле, файлы не меняются', () => {
    const r = rig();
    throws(() => r.service.add(1, { label: 'А', text: 'а', hotkey: 'Ctrl+C' }), /«А», hotkey/);
    throws(() => r.service.add(1, { label: 'А', text: 'а', zzz: 1 }), /лишние поля/);
    throws(() => r.service.add(1, { label: 'А', text: 'а', layer: 'project' }), /layer - workspace или all/);
    assert.deepEqual(r.writes, []);
  });

  it('занятая подпись у add_button - отказ с подсказкой про update_button', () => {
    const r = rig();
    throws(() => r.service.add(1, { label: 'сливай', text: 'x' }), /update_button/);
  });

  it('фильтры: «!» отвергается, «/» пишется без Enter и ответ об этом говорит', () => {
    const r = rig();
    throws(() => r.service.add(1, { label: 'Опасная', text: '!rm -rf' }), /«!»/);
    throws(() => r.service.update(1, { label: 'Сливай', text: ' !x' }), /«!»/);
    assert.deepEqual(r.writes, []);
    const said = r.service.add(1, { label: 'Компакт', text: '/compact', submit: true });
    assert.match(said, /Enter нажмите сами/);
    assert.deepEqual(r.files.ws, [{ label: 'Компакт', text: '/compact' }]);
  });

  it('update_button у встроенной пишет частичную запись; ответ называет «только вставить»', () => {
    const r = rig({ global: [{ label: 'Мердж', text: 'T', submit: true }] });
    const said = r.service.update(1, { label: 'Мердж', text: 'T2' });
    assert.deepEqual(r.files.ws, [{ label: 'Мердж', text: 'T2' }]);
    assert.match(said, /только вставляет/);
    r.service.update(1, { label: 'Приберись', description: 'д' });
    assert.deepEqual(r.files.ws, [{ label: 'Мердж', text: 'T2' }, { label: 'Приберись', description: 'д' }]);
    r.service.update(1, { label: 'Сливай', hotkey: null });
    assert.deepEqual((r.files.ws as { label: string }[]).find((e) => e.label === 'Сливай'), { label: 'Сливай', hotkey: null });
  });

  it('update_button new_label у встроенной - отказ; своя кнопка переименовывается', () => {
    const r = rig();
    throws(() => r.service.update(1, { label: 'Сливай', new_label: 'Х' }), /подпись унаследованной кнопки не меняется/);
    r.service.add(1, { label: 'Своя', text: 'с' });
    r.service.update(1, { label: 'Своя', new_label: 'Другая' });
    assert.deepEqual(r.files.ws, [{ label: 'Другая', text: 'с' }]);
  });

  it('disable_button выключает и включает в слое; в воркспейсе включает выключенную в общих', () => {
    const r = rig({ global: [{ label: 'Сливай', disabled: true }] });
    r.service.disable(1, { label: 'Приберись' });
    assert.deepEqual(r.files.ws, [{ label: 'Приберись', disabled: true }]);
    r.service.disable(1, { label: 'Сливай', disabled: false });
    assert.deepEqual(r.files.ws, [{ label: 'Сливай', disabled: false }, { label: 'Приберись', disabled: true }]);
    r.service.disable(1, { label: 'Приберись', disabled: false });
    assert.deepEqual(r.files.ws, [{ label: 'Сливай', disabled: false }]);
    assert.equal(r.notices.at(-1)?.verb, 'enabled');
  });

  it('кнопки запуска: только в общем слое; встроенные не выключаются', () => {
    const r = rig();
    throws(() => r.service.add(1, { place: 'mr', label: 'Объясни', text: 'объясни {mr_url}' }), /layer: "all"/);
    r.service.add(1, { place: 'mr', label: 'Объясни', text: 'объясни {mr_url}', layer: 'all' });
    assert.deepEqual(r.files.prompts, { buttons: [{ place: 'mr', label: 'Объясни', text: 'объясни {mr_url}' }] });
    throws(() => r.service.disable(1, { place: 'mr', label: 'Ревью', layer: 'all' }), /не выключаются/);
    throws(() => r.service.add(1, { place: 'task', label: 'Х', text: '{mr_url}', layer: 'all' }), /неизвестная подстановка/);
    r.service.update(1, { place: 'mr', label: 'Ревью', text: 'сделай ревью {mr_url}', layer: 'all' });
    assert.equal((r.files.prompts as unknown as Record<string, { text: string }>)['mr.review'].text, 'сделай ревью {mr_url}');
    r.service.disable(1, { place: 'mr', label: 'Объясни', layer: 'all' });
    assert.equal(((r.files.prompts as { buttons: { disabled?: boolean }[] }).buttons[0]).disabled, true);
  });

  it('list_buttons отдаёт четыре места, выключенные и изменённые в воркспейсе', () => {
    const r = rig({ ws: [{ label: 'Сливай', disabled: true }, { label: 'Мердж', description: 'д' }] });
    const list = JSON.parse(r.service.list(1));
    assert.deepEqual(Object.keys(list).filter((k) => ['bar', 'mr', 'task', 'jira'].includes(k)), ['bar', 'mr', 'task', 'jira']);
    const sliv = list.bar.find((b: { label: string }) => b.label === 'Сливай');
    assert.equal(sliv.disabled, true);
    assert.deepEqual(list.bar.find((b: { label: string }) => b.label === 'Мердж').changed_in, ['workspace']);
    assert.equal(list.mr[0].label, 'Ревью');
  });
});

describe('Кнопки: отмена вызова', () => {
  it('возвращает слой к состоянию до вызова', () => {
    const r = rig({ ws: [{ label: 'Старая', text: 'с' }] });
    r.service.add(1, { label: 'Деплой', text: 'д' });
    assert.deepEqual(r.service.undo(r.notices[0].undo), {});
    assert.deepEqual(r.files.ws, [{ label: 'Старая', text: 'с' }]);
    assert.match(r.service.undo(r.notices[0].undo).error ?? '', /Уже отменено/);
  });

  it('не трогает правки других кнопок, сделанные после вызова', () => {
    const r = rig();
    r.service.add(1, { label: 'Деплой', text: 'д' });
    r.service.add(1, { label: 'Другая', text: 'д2' });
    assert.deepEqual(r.service.undo(r.notices[0].undo), {});
    assert.deepEqual(r.files.ws, [{ label: 'Другая', text: 'д2' }]);
  });

  it('отказывает, если ту же кнопку изменили после вызова', () => {
    const r = rig();
    r.service.add(1, { label: 'Деплой', text: 'д' });
    r.service.update(1, { label: 'Деплой', text: 'новый' });
    assert.match(r.service.undo(r.notices[0].undo).error ?? '', /изменили после вызова/);
    assert.deepEqual(r.files.ws, [{ label: 'Деплой', text: 'новый' }]);
  });

  it('возвращает изменённую встроенную и выключенную кнопку; отмена добавления кнопки запуска', () => {
    const r = rig();
    r.service.disable(1, { label: 'Сливай' });
    r.service.undo(r.notices[0].undo);
    assert.deepEqual(r.files.ws, []);
    r.service.add(1, { place: 'jira', label: 'Х', text: 'x {jira_key}', layer: 'all' });
    r.service.undo(r.notices[1].undo);
    assert.deepEqual(r.files.prompts, {});
    assert.match(r.service.undo(999).error ?? '', /журнал/);
  });
});