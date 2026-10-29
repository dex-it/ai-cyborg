import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  checkCommandsText,
  commandsToText,
  DEFAULT_COMMANDS,
  DESCRIPTION_MAX,
  effectiveCommands,
  expandCommand,
  globalBase,
  hotkeyMatches,
  LABEL_MAX,
  MAX_COMMANDS,
  mergeCommands,
  ownEntries,
  parseCommands,
  parseHotkey,
  placeholdersOf,
  saveCommandsText,
  TEXT_MAX,
  type CommandButton,
  type Hotkey,
} from '../src/main/commands';

const ok = (value: Hotkey | { error: string }): Hotkey => {
  assert.ok(!('error' in value), 'error' in value ? value.error : '');
  return value;
};
const key = (code: string, mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}) => ({ ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, code, ...mods });

describe('Кнопки: сочетания клавиш', () => {
  it('Alt+S, Ctrl+Shift+K, CmdOrCtrl по платформе, F-клавиши и цифры', () => {
    assert.deepEqual(ok(parseHotkey('Alt+S', true)), { ctrl: false, alt: true, shift: false, meta: false, code: 'KeyS' });
    assert.deepEqual(ok(parseHotkey('ctrl+shift+k', false)), { ctrl: true, alt: false, shift: true, meta: false, code: 'KeyK' });
    assert.equal(ok(parseHotkey('CmdOrCtrl+Shift+M', true)).meta, true);
    assert.equal(ok(parseHotkey('CmdOrCtrl+Shift+M', false)).ctrl, true);
    assert.equal(ok(parseHotkey('Alt+F5', false)).code, 'F5');
    assert.equal(ok(parseHotkey('Option+7', true)).code, 'Digit7');
    assert.deepEqual(ok(parseHotkey('F2', false)), { ctrl: false, alt: false, shift: false, meta: false, code: 'F2' });
    assert.equal(ok(parseHotkey('Shift+F3', true)).shift, true);
  });

  it('сочетание сверяется по коду клавиши и точному набору модификаторов', () => {
    const alt = ok(parseHotkey('Alt+S', true));
    assert.equal(hotkeyMatches(alt, key('KeyS', { altKey: true })), true);
    assert.equal(hotkeyMatches(alt, key('KeyS', { altKey: true, shiftKey: true })), false, 'лишний Shift');
    assert.equal(hotkeyMatches(alt, key('KeyS')), false);
    assert.equal(hotkeyMatches(alt, key('KeyD', { altKey: true })), false);
  });

  it('отказ: без модификатора, Ctrl без Shift, чужая клавиша, повтор модификатора, занятое приложением', () => {
    assert.match((parseHotkey('S', true) as { error: string }).error, /Alt или Cmd/);
    assert.match((parseHotkey('Ctrl+C', false) as { error: string }).error, /терминалом/);
    assert.match((parseHotkey('CmdOrCtrl+K', false) as { error: string }).error, /терминалом/);
    assert.match((parseHotkey('Shift+K', true) as { error: string }).error, /Alt или Cmd/);
    assert.match((parseHotkey('Alt+Enter', true) as { error: string }).error, /допустимы буква/);
    assert.match((parseHotkey('Alt+Alt+S', true) as { error: string }).error, /повторён/);
    assert.match((parseHotkey('Hyper+S', true) as { error: string }).error, /не клавиша-модификатор/);
    assert.match((parseHotkey('Cmd+Q', true) as { error: string }).error, /занято приложением/);
    assert.match((parseHotkey('Cmd+Shift+N', true) as { error: string }).error, /занято приложением/);
    assert.match((parseHotkey('Ctrl+Shift+V', false) as { error: string }).error, /занято приложением/);
    assert.ok(!('error' in parseHotkey('Ctrl+Shift+N', true)), 'на macOS Ctrl+Shift+N свободно');
    assert.match((parseHotkey('F11', false) as { error: string }).error, /занято приложением/);
  });
});

describe('Кнопки: разбор commands', () => {
  it('нет поля - пусто без замечаний; не массив - замечание', () => {
    assert.deepEqual(parseCommands(undefined, true), { commands: [], problems: [] });
    assert.deepEqual(parseCommands({}, true).commands, []);
    assert.match(parseCommands('x', true).problems[0], /массивом/);
  });

  it('submit по умолчанию выключен: опасное действие само не отправляется', () => {
    const { commands, problems } = parseCommands([{ label: 'A', text: 'a' }, { label: 'B', text: 'b', submit: true }], true);
    assert.deepEqual(problems, []);
    assert.deepEqual(commands.map((c) => c.submit), [false, true]);
  });

  it('пробелы по краям срезаются, сочетание сохраняется', () => {
    const { commands } = parseCommands([{ label: ' Сливай ', text: ' сливай ', submit: true, hotkey: 'Alt+S' }], true);
    assert.deepEqual(commands, [{ label: 'Сливай', text: 'сливай', submit: true, hotkey: 'Alt+S' }]);
  });

  it('негодная кнопка пропускается с причиной и номером, остальные остаются', () => {
    const { commands, problems } = parseCommands(
      [
        { label: 'Ок', text: 'ok' },
        { label: '', text: 'x' },
        { label: 'Без текста', text: ' ' },
        { label: 'Две строки', text: 'a\nb' },
        { label: 'Submit', text: 's', submit: 'да' },
        { label: 'x'.repeat(LABEL_MAX + 1), text: 't' },
        { label: 'Длинный', text: 't'.repeat(TEXT_MAX + 1) },
        'строка',
        null,
      ],
      true,
    );
    assert.deepEqual(commands.map((c) => c.label), ['Ок']);
    assert.equal(problems.length, 8);
    assert.match(problems[0], /^Кнопка 2: label/);
    assert.match(problems[1], /^Кнопка 3 \(«Без текста»\): text/);
    assert.match(problems[2], /в одну строку/);
    assert.match(problems[3], /submit - true или false/);
    assert.match(problems[6], /^Кнопка 8: не объект/);
  });

  it('ошибка в сочетании оставляет кнопку без него; лишнее поле называется, кнопка остаётся', () => {
    const { commands, problems } = parseCommands([{ label: 'A', text: 'a', hotkey: 'S' }, { label: 'B', text: 'b', submt: true }], true);
    assert.deepEqual(commands.map((c) => [c.label, c.hotkey, c.submit]), [['A', undefined, false], ['B', undefined, false]]);
    assert.match(problems[0], /hotkey:.*Alt или Cmd/);
    assert.match(problems[1], /неизвестное поле submt/);
  });

  it('больше предела - лишние пропущены с замечанием', () => {
    const many = Array.from({ length: MAX_COMMANDS + 2 }, (_, i) => ({ label: `K${i}`, text: 't' }));
    const { commands, problems } = parseCommands(many, true);
    assert.equal(commands.length, MAX_COMMANDS);
    assert.match(problems[0], /больше 30/);
  });
});

describe('Кнопки: встроенные и из воркспейса', () => {
  const extra = (list: object[]) => parseCommands(list, true).commands;

  it('одноимённая кнопка заменяет встроенную на её месте, без учёта регистра; новые идут следом', () => {
    const { commands } = mergeCommands(DEFAULT_COMMANDS, extra([{ label: 'сливай', text: 'merge it', submit: false }, { label: 'Новая', text: 'n' }]), true);
    assert.deepEqual(commands.map((c) => c.label), ['сливай', 'Сделай PR', 'Мердж', 'Приберись', 'Новая']);
    assert.equal(commands[0].text, 'merge it');
    assert.equal(commands.length, DEFAULT_COMMANDS.length + 1);
  });

  it('пустые дополнения - встроенный набор', () => {
    assert.deepEqual(mergeCommands(DEFAULT_COMMANDS, [], true), { commands: [...DEFAULT_COMMANDS], problems: [] });
  });

  it('сочетание достаётся первой кнопке, вторая остаётся без него, замечание называет обе', () => {
    const { commands, problems } = mergeCommands([], extra([{ label: 'A', text: 'a', hotkey: 'Alt+S' }, { label: 'B', text: 'b', hotkey: 'alt+s' }]), true);
    assert.equal(commands[0].hotkey, 'Alt+S');
    assert.equal(commands[1].hotkey, undefined);
    assert.match(problems[0], /«B».*уже у кнопки «A»/);
  });

  it('встроенные кнопки подстановки и сочетаний не нарушают правил', () => {
    for (const b of DEFAULT_COMMANDS) {
      assert.ok(b.label.length <= LABEL_MAX && b.text.length <= TEXT_MAX);
      assert.equal(parseCommands([b], true).problems.length, 0, b.label);
    }
    assert.equal(DEFAULT_COMMANDS.find((b) => b.label === 'Мердж')?.submit, false, 'слияние PR не отправляется само');
    assert.deepEqual(DEFAULT_COMMANDS.map((b) => b.hotkey), ['F1', 'F2', 'F3', 'F4']);
  });
});

describe('Кнопки: проверка текста редактора', () => {
  it('корректный массив проходит и возвращается как есть', () => {
    const raw = [{ label: 'A', text: 'a', submit: true, hotkey: 'Alt+A' }];
    assert.deepEqual(checkCommandsText(JSON.stringify(raw), true), { ok: true, commands: raw });
    assert.deepEqual(checkCommandsText('[]', true), { ok: true, commands: [] });
  });

  it('не JSON, не массив и любая замеченная проблема - отказ с причиной', () => {
    assert.match((checkCommandsText('[{', true) as { error: string }).error, /^Не JSON/);
    assert.match((checkCommandsText('{"a":1}', true) as { error: string }).error, /Нужен массив/);
    assert.match((checkCommandsText('[{"label":"A"}]', true) as { error: string }).error, /«A»: запись только с label задаёт место кнопки/);
    assert.match((checkCommandsText('[{"label":"A","text":"a","submt":true}]', true) as { error: string }).error, /неизвестное поле submt/);
    const dup = checkCommandsText('[{"label":"A","text":"a","hotkey":"Alt+S"},{"label":"B","text":"b","hotkey":"Alt+S"}]', true);
    assert.match((dup as { error: string }).error, /уже у кнопки «A»/);
  });

  it('сочетание, годное только на этой системе, не записывается: файл переносят между системами', () => {
    const cmd = (hotkey: string) => JSON.stringify([{ label: 'A', text: 'a', hotkey }]);
    const onMac = checkCommandsText(cmd('CmdOrCtrl+K'), true);
    assert.match((onMac as { error: string }).error, /«A»: сочетание CmdOrCtrl\+K не годится на Linux и Windows: нужен Alt или Cmd/);
    assert.match((checkCommandsText(cmd('CmdOrCtrl+K'), false) as { error: string }).error, /hotkey: нужен Alt или Cmd/, 'на Linux та же ошибка названа самим разбором');
    assert.match((checkCommandsText(cmd('Ctrl+Shift+N'), true) as { error: string }).error, /не годится на Linux и Windows: сочетание занято приложением/);
    assert.match((checkCommandsText(cmd('Cmd+Shift+N'), false) as { error: string }).error, /не годится на macOS: сочетание занято приложением/);
    for (const portable of ['Alt+S', 'CmdOrCtrl+Shift+M', 'Ctrl+Shift+K', 'Cmd+K']) {
      assert.equal(checkCommandsText(cmd(portable), true).ok, true, `mac: ${portable}`);
      assert.equal(checkCommandsText(cmd(portable), false).ok, true, `linux: ${portable}`);
    }
  });

  it('текст редактора - действующий набор: встроенные с описаниями, затем записи файла как есть', () => {
    const builtIn = JSON.parse(commandsToText(undefined)) as { label: string; description?: string }[];
    assert.deepEqual(builtIn.map((b) => b.label), DEFAULT_COMMANDS.map((b) => b.label));
    assert.ok(builtIn.every((b) => b.description), 'у каждой встроенной кнопки есть описание');
    assert.deepEqual(JSON.parse(commandsToText('x')), JSON.parse(commandsToText(undefined)), 'негодное поле - как отсутствующее');
    const mine = { label: 'Моя', text: 'м' };
    const text = JSON.parse(commandsToText([mine])) as unknown[];
    assert.deepEqual(text.slice(-1), [mine]);
    assert.equal(text.length, DEFAULT_COMMANDS.length + 1);
  });

  it('действующий набор: одноимённая запись файла стоит на месте встроенной, негодная запись не теряется', () => {
    const replaced = { label: 'сливай', text: 'merge it', submit: true };
    const broken = { label: 'Битая', text: 'a\nb' };
    const list = effectiveCommands([replaced, broken]);
    assert.deepEqual(list[0], replaced);
    assert.deepEqual(list.slice(1, DEFAULT_COMMANDS.length), DEFAULT_COMMANDS.slice(1), 'неназванные встроенные идут за названной перед ними');
    assert.deepEqual(list.at(-1), broken, 'запись с ошибкой остаётся в тексте, чтобы её поправили');
  });

  it('порядок записей двигает и встроенные кнопки; кнопка, которую слой не назвал, идёт за названной перед ней', () => {
    const mine = { label: 'Моя', text: 'м' };
    const list = effectiveCommands([mine, { label: 'Приберись' }, { label: 'Сливай' }]) as CommandButton[];
    assert.deepEqual(list.map((b) => b.label), ['Моя', 'Приберись', 'Сливай', 'Сделай PR', 'Мердж']);
    assert.deepEqual(list[1], DEFAULT_COMMANDS[3], 'запись только с label берёт содержимое встроенной');
    const { commands } = mergeCommands(DEFAULT_COMMANDS, parseCommands([mine, { label: 'Приберись' }, { label: 'Сливай' }], true).commands, true);
    assert.deepEqual(commands.map((b) => b.label), ['Моя', 'Приберись', 'Сливай', 'Сделай PR', 'Мердж']);
    assert.equal(commands[1].hotkey, 'F4');
  });

  it('запись слоя: копии нижних кнопок сворачиваются в label и остаются, только если держат порядок', () => {
    assert.deepEqual(ownEntries(JSON.parse(commandsToText(undefined)), DEFAULT_COMMANDS), [], 'встроенные на своих местах в файл не пишутся');
    const moved = [DEFAULT_COMMANDS[3], ...DEFAULT_COMMANDS.slice(0, 3)];
    assert.deepEqual(ownEntries(moved, DEFAULT_COMMANDS), [{ label: 'Приберись' }, { label: 'Сливай' }]);
    assert.deepEqual(effectiveCommands(ownEntries(moved, DEFAULT_COMMANDS)), moved);
  });

  it('действующий набор: повтор подписи встроенной кнопки не теряется, а идёт в конец', () => {
    const first = { label: 'Сливай', text: 'a' };
    const second = { label: 'сливай', text: 'b' };
    const list = effectiveCommands([first, second]);
    assert.deepEqual(list[0], first);
    assert.deepEqual(list.at(-1), second);
    assert.equal(list.length, DEFAULT_COMMANDS.length + 1);
  });

  it('сохранённый набор из редактора при повторном открытии даёт тот же набор и проходит проверку', () => {
    const once = commandsToText([{ label: 'Моя', text: 'м', description: 'д', disabled: false }]);
    assert.equal(commandsToText(JSON.parse(once)), once);
    assert.deepEqual(checkCommandsText(once, true), { ok: true, commands: JSON.parse(once) });
    assert.deepEqual(checkCommandsText(commandsToText(undefined), false), { ok: true, commands: JSON.parse(commandsToText(undefined)) });
  });
});

describe('Кнопки: описание и отключение', () => {
  it('description сохраняется кнопкой, негодное называется, а кнопка остаётся без описания', () => {
    assert.equal(parseCommands([{ label: 'A', text: 'a', description: ' что делает ' }], true).commands[0].description, 'что делает');
    for (const bad of [5, '', '  ', 'a\nb', 'я'.repeat(DESCRIPTION_MAX + 1)]) {
      const { commands, problems } = parseCommands([{ label: 'A', text: 'a', description: bad }], true);
      assert.equal(commands.length, 1);
      assert.equal(commands[0].description, undefined);
      assert.match(problems[0], /description/);
    }
  });

  it('disabled: true скрывает кнопку, в том числе встроенную, и освобождает сочетание', () => {
    const user = parseCommands([{ label: 'сливай', text: 'x', disabled: true }, { label: 'Моя', text: 'м', hotkey: 'Alt+S' }], true).commands;
    const { commands, problems } = mergeCommands(DEFAULT_COMMANDS, user, true);
    assert.deepEqual(commands.map((c) => c.label), ['Сделай PR', 'Мердж', 'Приберись', 'Моя']);
    assert.deepEqual(problems, []);
    const hidden = mergeCommands([], parseCommands([{ label: 'A', text: 'a', hotkey: 'Alt+S', disabled: true }, { label: 'B', text: 'b', hotkey: 'Alt+S' }], true).commands, true);
    assert.deepEqual([hidden.commands.map((c) => c.hotkey), hidden.problems], [['Alt+S'], []]);
  });

  it('disabled не булев - замечание, кнопка остаётся видимой; disabled: false ничего не меняет', () => {
    const bad = parseCommands([{ label: 'A', text: 'a', disabled: 'да' }], true);
    assert.match(bad.problems[0], /disabled - true или false/);
    assert.equal(bad.commands[0].disabled, undefined);
    assert.deepEqual(parseCommands([{ label: 'A', text: 'a', disabled: false }], true).problems, []);
  });

  it('кнопка, потерявшая сочетание, сохраняет описание', () => {
    const { commands } = mergeCommands([], [{ label: 'A', text: 'a', submit: false, hotkey: 'Alt+S', description: 'd' }, { label: 'B', text: 'b', submit: false, hotkey: 'Alt+S', description: 'e' }], true);
    assert.deepEqual(commands[1], { label: 'B', text: 'b', submit: false, description: 'e' });
  });
});

describe('Кнопки: подстановки', () => {
  it('какие подстановки нужны тексту: без повторов, чужие фигурные скобки не трогаются', () => {
    assert.deepEqual(placeholdersOf('смерджи {pr} из {branch}, {pr}'), ['pr', 'branch']);
    assert.deepEqual(placeholdersOf('git log {1..3} {foo}'), []);
  });

  it('значения подставляются во все вхождения за один проход', () => {
    assert.deepEqual(expandCommand('{branch}: смерджи {pr} ({branch})', { branch: 'feat/x-1', pr: 'https://github.com/o/r/pull/5' }), {
      ok: true,
      text: 'feat/x-1: смерджи https://github.com/o/r/pull/5 (feat/x-1)',
    });
  });

  it('подставленное значение заново не разбирается', () => {
    assert.deepEqual(expandCommand('{task}', { task: '{pr}' }), { ok: true, text: '{pr}' });
  });

  it('текст без подстановок уходит как есть, значения не нужны', () => {
    assert.deepEqual(expandCommand('сливай', {}), { ok: true, text: 'сливай' });
    assert.deepEqual(expandCommand('git log {1..3}', {}), { ok: true, text: 'git log {1..3}' });
  });

  it('нет значения - отказ с названием подстановки и причиной, текст не уходит', () => {
    assert.deepEqual(expandCommand('PR {pr}', { pr: null }), { ok: false, reason: '{pr}: у ветки нет открытого PR/MR' });
    assert.deepEqual(expandCommand('{branch}', {}), { ok: false, reason: '{branch}: у сессии нет ветки git' });
    assert.deepEqual(expandCommand('{task}', { task: '' }), { ok: false, reason: '{task}: сессия начата не из задачи' });
  });

  it('небезопасное значение - отказ: пробелы, управляющие и служебные знаки в ветке', () => {
    for (const branch of ['a b', 'a\nb', 'a;rm', 'a`b`', '$(x)', 'x"y', "x'y"]) {
      assert.equal(expandCommand('{branch}', { branch }).ok, false, JSON.stringify(branch));
    }
    assert.equal(expandCommand('{pr}', { pr: 'https://x/y z' }).ok, false);
    assert.equal(expandCommand('{task}', { task: 'a\tb' }).ok, false);
    assert.equal(expandCommand('{branch}', { branch: 'release/1.2.3_rc-1' }).ok, true);
    assert.equal(expandCommand('{task}', { task: 'DEX-123' }).ok, true);
  });
});

describe('Кнопки команд: замечания проверки', () => {
  it('повтор подписи встроенной кнопки называется: вторая запись не попадает на полосу, молча терять её нельзя', () => {
    const text = JSON.stringify([{ label: 'Сливай', text: 'a' }, { label: 'сливай', text: 'b' }, { label: 'Своя', text: 'c' }]);
    const checked = checkCommandsText(text, true);
    assert.equal(checked.ok, false);
    assert.match((checked as { error: string }).error, /«Сливай»: подпись встроенной кнопки повторена/);
    const merged = mergeCommands(DEFAULT_COMMANDS, parseCommands(JSON.parse(text), true).commands, true);
    assert.equal(merged.commands.find((c) => c.label === 'Сливай')?.text, 'a');
    assert.equal(merged.problems.length, 1);
  });

  it('повтор подписи своей кнопки замечанием не становится: обе показываются', () => {
    const text = JSON.stringify([{ label: 'Своя', text: 'a' }, { label: 'Своя', text: 'b' }]);
    assert.equal(checkCommandsText(text, true).ok, true);
  });

  it('символы направления текста, C1 и разделители строк в подписи и тексте - ошибка кнопки', () => {
    for (const bad of ['‮', '⁧', '\u009b', ' ']) {
      for (const field of ['label', 'text']) {
        const parsed = parseCommands([{ label: 'A', text: 'a', [field]: `x${bad}y` }], true);
        assert.equal(parsed.commands.length, 0, `${field} ${bad.charCodeAt(0).toString(16)}`);
        assert.equal(parsed.problems.length, 1);
      }
    }
    assert.equal(parseCommands([{ label: '👨‍💻 Код', text: 'a' }], true).commands.length, 1, 'ZWJ в эмодзи допустим');
  });
});

describe('Кнопки: общий набор и набор воркспейса', () => {
  const shared = [{ label: 'Мердж', text: 'смерджи {pr}', submit: true, hotkey: 'F3' }, { label: 'Фикс', text: 'исправь', submit: true, hotkey: 'F5' }];
  const base = globalBase(shared, true);

  it('общий набор ложится на встроенные: замена на месте, новые следом', () => {
    assert.deepEqual(base.map((b) => b.label), ['Сливай', 'Сделай PR', 'Мердж', 'Приберись', 'Фикс']);
    assert.equal(base[2].text, 'смерджи {pr}');
  });

  it('воркспейс заменяет и скрывает общую кнопку, свои идут следом', () => {
    const own = parseCommands([{ label: 'фикс', text: 'чини тут', submit: true }, { label: 'Сливай', text: 'сливай', disabled: true }, { label: 'New', text: '/new' }], true).commands;
    const { commands } = mergeCommands(base, own, true);
    assert.deepEqual(commands.map((b) => b.label), ['фикс', 'Сделай PR', 'Мердж', 'Приберись', 'New']);
    assert.equal(commands.find((b) => b.label === 'фикс')?.hotkey, undefined, 'замена целиком: сочетание общей кнопки не наследуется');
  });

  it('копия встроенной кнопки в файле воркспейса не заслоняет общую кнопку', () => {
    const copies = parseCommands(JSON.parse(commandsToText(undefined)), true).commands;
    const { commands } = mergeCommands(base, copies, true);
    assert.equal(commands.find((b) => b.label === 'Мердж')?.text, 'смерджи {pr}');
    assert.equal(effectiveCommands(JSON.parse(commandsToText(undefined)), base).length, base.length);
  });

  it('сочетание общей кнопки занято: кнопка воркспейса без него и замечание при записи', () => {
    const text = JSON.stringify([{ label: 'New', text: '/new', hotkey: 'F5' }]);
    assert.equal(checkCommandsText(text, true).ok, true);
    assert.match((checkCommandsText(text, true, base) as { error: string }).error, /F5 уже у кнопки «Фикс»/);
  });

  it('запись слоя хранит только отличия от нижнего: правка общего набора доходит до воркспейса', () => {
    const saved: unknown[][] = [];
    const store = { saveCommands: (c: unknown[]) => void saved.push(c) };
    const mine = { label: 'New', text: '/new', submit: true };
    assert.deepEqual(saveCommandsText(commandsToText([mine], base), store, true, base), {});
    assert.deepEqual(saved, [[mine]]);
    const changed = { ...shared[1], text: 'исправь всё' };
    const edited = (JSON.parse(commandsToText(undefined, base)) as CommandButton[]).map((b) => (b.label === 'Фикс' ? changed : b));
    assert.deepEqual(ownEntries(edited, base), [changed]);
  });
});
