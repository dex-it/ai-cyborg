import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  checkLayer,
  compactLayer,
  DEFAULT_COMMANDS,
  DESCRIPTION_MAX,
  expandCommand,
  hotkeyMatches,
  LABEL_MAX,
  MAX_COMMANDS,
  parseCommands,
  parseHotkey,
  parseLayer,
  placeholdersOf,
  resolveBar,
  rowsBelow,
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


describe('Кнопки: управляющие символы', () => {
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

const bar = (global?: unknown, workspace?: unknown) => resolveBar({ global, workspace }, false);
const byLabel = (rows: CommandButton[], label: string) => rows.find((b) => b.label === label);

describe('Кнопки: правило по полям', () => {
  it('пустые файлы - встроенный набор без замечаний', () => {
    assert.deepEqual(bar().buttons, [...DEFAULT_COMMANDS]);
    assert.deepEqual(bar().problems, []);
  });

  it('запись со своим text задаёт и submit; сочетание и описание берутся снизу', () => {
    const b = byLabel(bar(undefined, [{ label: 'Сливай', text: 'слей в release' }]).buttons, 'Сливай');
    assert.deepEqual(b, { label: 'Сливай', text: 'слей в release', submit: false, hotkey: 'F1', description: DEFAULT_COMMANDS[0].description });
  });

  it('запись с одним сочетанием: текст и Enter из общих, правка общих доходит до воркспейса', () => {
    const ws = [{ label: 'Мердж', hotkey: 'Alt+M' }];
    const first = byLabel(bar([{ label: 'Мердж', text: 'T', submit: true }], ws).buttons, 'Мердж');
    assert.deepEqual([first?.text, first?.submit, first?.hotkey], ['T', true, 'Alt+M']);
    assert.equal(byLabel(bar([{ label: 'Мердж', text: 'T2', submit: true }], ws).buttons, 'Мердж')?.text, 'T2');
  });

  it('hotkey null снимает сочетание, и оно свободно для другой кнопки', () => {
    const { buttons, problems } = bar(undefined, [{ label: 'Сливай', hotkey: null }, { label: 'Новая', text: 'н', hotkey: 'F1' }]);
    assert.equal(byLabel(buttons, 'Сливай')?.hotkey, undefined);
    assert.equal(byLabel(buttons, 'Новая')?.hotkey, 'F1');
    assert.deepEqual(problems, []);
  });

  it('submit без text меняет только Enter', () => {
    const b = byLabel(bar(undefined, [{ label: 'Сделай PR', submit: false }]).buttons, 'Сделай PR');
    assert.deepEqual([b?.text, b?.submit], ['сделай PR', false]);
  });

  it('общий слой над встроенными действует тем же правилом', () => {
    const { buttons } = bar([{ label: 'Приберись', description: 'д' }, { label: 'Сливай', text: 'x' }]);
    assert.deepEqual([byLabel(buttons, 'Приберись')?.text, byLabel(buttons, 'Приберись')?.hotkey, byLabel(buttons, 'Приберись')?.description], ['приберись', 'F4', 'д']);
    assert.equal(byLabel(buttons, 'Сливай')?.hotkey, 'F1');
    assert.equal(byLabel(buttons, 'Сливай')?.submit, false);
  });

  it('запись без text без кнопки ниже - замечание, на полосу не попадает', () => {
    const r = bar(undefined, [{ label: 'Нет такой', hotkey: 'Alt+N' }]);
    assert.equal(r.buttons.length, DEFAULT_COMMANDS.length);
    assert.match(r.problems[0], /«Нет такой»: запись без text/);
  });

  it('прежние файлы читаются: полная запись над общей кнопкой, копия встроенной, {label} как место', () => {
    const copies = DEFAULT_COMMANDS.map((d) => ({ ...d }));
    assert.deepEqual(bar([{ label: 'Сливай', text: 'г', submit: true, hotkey: 'F9' }], copies).buttons.find((b) => b.label === 'Сливай')?.text, 'г');
    const moved = bar(undefined, [{ label: 'Приберись' }, { label: 'Сливай' }]).buttons.map((b) => b.label);
    assert.deepEqual(moved.slice(0, 2), ['Приберись', 'Сливай']);
  });

  it('повтор подписи в слое: замечание, действует первая', () => {
    const r = bar(undefined, [{ label: 'Сливай', text: 'а' }, { label: 'сливай', text: 'б' }, { label: 'Моя', text: 'м' }, { label: 'моя', text: 'н' }]);
    assert.equal(r.problems.length, 2);
    assert.equal(byLabel(r.buttons, 'Сливай')?.text, 'а');
    assert.equal(r.buttons.filter((b) => b.label.toLowerCase() === 'моя').length, 1);
  });
});

describe('Кнопки: владение сочетанием', () => {
  it('сочетание кнопки верхнего слоя забирается у нижней без замечания', () => {
    const r = bar([{ label: 'Деплой', text: 'д', hotkey: 'F2' }]);
    assert.deepEqual(r.problems, []);
    assert.equal(byLabel(r.buttons, 'Деплой')?.hotkey, 'F2');
    assert.equal(byLabel(r.buttons, 'Сделай PR')?.hotkey, undefined);
    const lost = r.rows.find((x) => x.label === 'Сделай PR');
    assert.equal(lost?.hotkeyLostTo, 'Деплой');
  });

  it('верхняя кнопка выключена, удалена или сняла сочетание - оно снова у нижней', () => {
    const own = { label: 'Деплой', text: 'д', hotkey: 'F2' };
    assert.equal(byLabel(bar([{ ...own, disabled: true }]).buttons, 'Сделай PR')?.hotkey, 'F2');
    assert.equal(byLabel(bar([]).buttons, 'Сделай PR')?.hotkey, 'F2');
    assert.equal(byLabel(bar([own], [{ label: 'Деплой', hotkey: null }]).buttons, 'Сделай PR')?.hotkey, 'F2');
    assert.equal(byLabel(bar([own], [{ label: 'Деплой', disabled: true }]).buttons, 'Сделай PR')?.hotkey, 'F2');
  });

  it('повтор внутри одного слоя: замечание, действует первая; между слоями - без замечаний', () => {
    const r = bar([{ label: 'A', text: 'a', hotkey: 'Alt+S' }, { label: 'B', text: 'b', hotkey: 'alt+s' }]);
    assert.match(r.problems[0], /сочетание alt\+s уже у кнопки «A»/);
    assert.equal(byLabel(r.buttons, 'B')?.hotkey, undefined);
    const across = bar([{ label: 'A', text: 'a', hotkey: 'Alt+S' }], [{ label: 'B', text: 'b', hotkey: 'Alt+S' }]);
    assert.deepEqual(across.problems, []);
    assert.equal(byLabel(across.buttons, 'B')?.hotkey, 'Alt+S');
    assert.equal(byLabel(across.buttons, 'A')?.hotkey, undefined);
  });

  it('воркспейс дал «Мердж» F2: «Сделай PR» теряет F2, hotkeyHolder у выключенной', () => {
    const r = bar(undefined, [{ label: 'Мердж', hotkey: 'F2' }, { label: 'Приберись', disabled: true }]);
    assert.equal(r.rows.find((x) => x.label === 'Сделай PR')?.hotkeyLostTo, 'Мердж');
    assert.equal(r.rows.find((x) => x.label === 'Приберись')?.hotkeyHolder, undefined);
  });
});

describe('Кнопки: выключение', () => {
  it('выключенная не на полосе; disabled: false верхнего слоя перекрывает нижний', () => {
    const off = bar([{ label: 'Сливай', disabled: true }]);
    assert.equal(byLabel(off.buttons, 'Сливай'), undefined);
    assert.equal(off.rows.find((x) => x.label === 'Сливай')?.disabled, true);
    assert.ok(byLabel(bar([{ label: 'Сливай', disabled: true }], [{ label: 'Сливай', disabled: false }]).buttons, 'Сливай'));
  });
});

describe('Кнопки: предел и проверка слоя', () => {
  const cfg = { global: undefined, workspace: undefined };
  it('частичные записи, выключения и места считаются в предел', () => {
    const many = Array.from({ length: MAX_COMMANDS + 1 }, (_, i) => ({ label: `К${i}`, text: 'x' }));
    assert.equal(checkLayer('workspace', many, cfg, false).ok, false);
    const parsed = parseLayer(Array.from({ length: MAX_COMMANDS + 1 }, () => ({ label: 'Сливай', disabled: true })), false);
    assert.match(parsed.problems[0], /Кнопок больше 30/);
  });

  it('отказ: запись без кнопки ниже, повтор сочетания в слое, чужая система', () => {
    assert.equal(checkLayer('workspace', [{ label: 'Нет', hotkey: 'Alt+N' }], cfg, false).ok, false);
    assert.equal(checkLayer('global', [{ label: 'A', text: 'a', hotkey: 'Alt+S' }, { label: 'B', text: 'b', hotkey: 'Alt+S' }], cfg, false).ok, false);
    const mac = checkLayer('global', [{ label: 'A', text: 'a', hotkey: 'CmdOrCtrl+K' }], cfg, true);
    assert.equal(mac.ok, false);
    assert.equal(checkLayer('workspace', [{ label: 'A', text: 'a', hotkey: 'Alt+S' }], { global: [{ label: 'B', text: 'b', hotkey: 'Alt+S' }], workspace: undefined }, false).ok, true, 'между слоями не отказ');
  });

  it('отказ называет кнопку и поле', () => {
    const r = checkLayer('workspace', [{ label: 'A', text: 'a', hotkey: 'Ctrl+C' }], cfg, false);
    assert.ok(!r.ok);
    assert.deepEqual([r.issues[0].label, r.issues[0].field], ['A', 'hotkey']);
  });

  it('не массив - отказ', () => {
    assert.equal(checkLayer('global', {}, cfg, false).ok, false);
  });
});

describe('Кнопки: сжатие слоя', () => {
  const below = rowsBelow('global', { global: undefined }, false);
  const compact = (entries: unknown[]) => {
    const parsed = parseLayer(entries, false);
    return compactLayer(parsed.entries, below, false);
  };

  it('правка одного сочетания пишет только его', () => {
    assert.deepEqual(compact([{ label: 'Мердж', text: DEFAULT_COMMANDS[2].text, submit: false, hotkey: 'Alt+M', description: DEFAULT_COMMANDS[2].description }]), [{ label: 'Мердж', hotkey: 'Alt+M' }]);
  });

  it('полная копия встроенной сворачивается и не держится без нужды', () => {
    assert.deepEqual(compact(DEFAULT_COMMANDS.map((d) => ({ ...d }))), []);
  });

  it('запись, дающая тот же текст, но другой Enter, пишет submit', () => {
    assert.deepEqual(compact([{ label: 'Сливай', text: 'сливай', submit: false }]), [{ label: 'Сливай', submit: false }]);
  });

  it('hotkey null у кнопки без сочетания не пишется; у кнопки с сочетанием остаётся', () => {
    assert.deepEqual(compact([{ label: 'Сливай', hotkey: null }]), [{ label: 'Сливай', hotkey: null }]);
    const mine = rowsBelow('workspace', { global: [{ label: 'Свой', text: 'с' }] }, false);
    assert.deepEqual(compactLayer(parseLayer([{ label: 'Свой', hotkey: null }], false).entries, mine, false), []);
  });

  it('выключение держится, disabled: false над невыключенной не пишется', () => {
    assert.deepEqual(compact([{ label: 'Сливай', disabled: true }]), [{ label: 'Сливай', disabled: true }]);
    assert.deepEqual(compact([{ label: 'Сливай', disabled: false }]), []);
  });

  it('место держится, только если без него сменится порядок', () => {
    assert.deepEqual(compact([{ label: 'Приберись' }, { label: 'Сливай' }]), [{ label: 'Приберись' }, { label: 'Сливай' }]);
    assert.deepEqual(compact([{ label: 'Сливай' }, { label: 'Сделай PR' }]), []);
  });

  it('своя кнопка слоя не сжимается', () => {
    assert.deepEqual(compact([{ label: 'Моя', text: 'м', submit: true }]), [{ label: 'Моя', text: 'м', submit: true }]);
  });
});

describe('Повтор сочетания внутри слоя', () => {
  const dup = [{ label: 'A', text: 'a', hotkey: 'Alt+1' }, { label: 'B', text: 'b', hotkey: 'Alt+1' }];

  it('общий слой с повтором отказывает при любом содержимом воркспейса: сочетание забрала кнопка воркспейса, но может отдать', () => {
    assert.equal(checkLayer('global', dup, { global: undefined, workspace: undefined }, false).ok, false);
    assert.equal(checkLayer('global', dup, { global: undefined, workspace: [{ label: 'C', text: 'c', hotkey: 'Alt+1' }] }, false).ok, false);
    assert.equal(checkLayer('global', dup, { global: undefined, workspace: [{ label: 'A', disabled: true }] }, false).ok, false);
  });

  it('при чтении повтор в нижнем слое назван, даже когда сочетание забрал воркспейс', () => {
    const resolved = resolveBar({ global: dup, workspace: [{ label: 'C', text: 'c', hotkey: 'Alt+1' }] }, false);
    assert.deepEqual(resolved.issues.map((i) => [i.layer, i.label]), [['global', 'B']]);
    assert.equal(resolved.buttons.find((b) => b.label === 'C')?.hotkey, 'Alt+1');
  });

  it('то же сочетание в разных слоях по-прежнему не замечание', () => {
    const cfg = { global: [dup[0]], workspace: [{ label: 'C', text: 'c', hotkey: 'Alt+1' }] };
    assert.deepEqual(resolveBar(cfg, false).issues, []);
    assert.equal(checkLayer('workspace', cfg.workspace, { global: cfg.global, workspace: undefined }, false).ok, true);
  });
});
