// Кнопки-команды активной сессии (фича 12): форма кнопки, проверка файла, подстановки, сочетания клавиш.
// Чистый файл без Node: его читают и главный процесс (проверка при сохранении), и интерфейс (полоса кнопок).

export interface CommandButton {
  label: string;
  text: string;
  /** true - текст и Enter; false - текст вставляется, Enter нажимает человек. */
  submit: boolean;
  hotkey?: string;
  /** Что кнопка делает и когда нужна: подсказка кнопки и строка редактора. */
  description?: string;
  /** true - кнопка скрыта (так отключается и встроенная: удалённая из файла вернулась бы из набора по умолчанию). */
  disabled?: boolean;
}

export const MAX_COMMANDS = 30;
export const LABEL_MAX = 40;
export const TEXT_MAX = 2000;
export const DESCRIPTION_MAX = 200;
/** Предел текста файла кнопок, принимаемого главным процессом от интерфейса. */
export const MAX_COMMANDS_TEXT = 200_000;

/** Встроенные кнопки, нижний слой под общим набором и набором воркспейса: фразы, которыми Claude Code понимает типовое действие. */
export const DEFAULT_COMMANDS: readonly CommandButton[] = [
  { label: 'Сливай', text: 'сливай', submit: true, hotkey: 'F1', description: 'Фраза «сливай»: слить PR текущей ветки.' },
  { label: 'Сделай PR', text: 'сделай PR', submit: true, hotkey: 'F2', description: 'Фраза «сделай PR»: открыть PR из текущей ветки.' },
  {
    label: 'Мердж',
    text: 'открой PR текущей ветки, если его ещё нет, и смерджи его в целевую ветку',
    submit: false,
    hotkey: 'F3',
    description: 'Вставляет без Enter просьбу открыть PR ветки, если его нет, и слить его в целевую ветку: проверьте и нажмите Enter сами.',
  },
  { label: 'Приберись', text: 'приберись', submit: true, hotkey: 'F4', description: 'Фраза «приберись»: убрать за собой, например слитые ветки.' },
];

const KNOWN_FIELDS = new Set(['label', 'text', 'submit', 'hotkey', 'description', 'disabled']);
/**
 * Управляющие символы: C0 и C1 (в том числе U+009B, 8-битный CSI), разделители строк U+2028 и U+2029 и переопределения направления текста
 * (U+202A-202E, U+2066-2069): последние маскируют подпись и текст в подсказке кнопки. Нули ширины и ZWJ допустимы (эмодзи).
 */
export const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

// ---------- сочетания клавиш ----------

export interface Hotkey {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  /** KeyboardEvent.code: раскладка и Option на macOS (ß вместо s) на него не влияют. */
  code: string;
}

export interface KeyEventLike {
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  code: string;
}

const MODIFIERS: Record<string, 'ctrl' | 'alt' | 'shift' | 'meta' | 'cmdorctrl'> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
  cmd: 'meta',
  command: 'meta',
  meta: 'meta',
  cmdorctrl: 'cmdorctrl',
  commandorcontrol: 'cmdorctrl',
};

// Сочетания, которые уже заняты меню приложения либо самим окном: до кнопки они не дошли бы (запись в порядке canonical: ctrl, alt, shift, meta).
const RESERVED_MAC = ['meta+KeyQ', 'meta+KeyC', 'meta+KeyV', 'meta+KeyX', 'meta+KeyA', 'meta+KeyZ', 'meta+KeyW', 'meta+KeyM', 'meta+KeyH', 'meta+Digit0', 'shift+meta+KeyN', 'shift+meta+KeyZ'];
const RESERVED_OTHER = ['ctrl+shift+KeyN', 'ctrl+shift+KeyC', 'ctrl+shift+KeyV', 'F11'];

const canonical = (h: Hotkey): string => [h.ctrl && 'ctrl', h.alt && 'alt', h.shift && 'shift', h.meta && 'meta', h.code].filter(Boolean).join('+');

/** «Alt+S», «Ctrl+Shift+K», «CmdOrCtrl+Shift+M», «F2»; ошибка - текст причины. */
export function parseHotkey(text: string, mac: boolean): Hotkey | { error: string } {
  const parts = text.split('+').map((p) => p.trim());
  const key = parts.pop() ?? '';
  const hotkey: Hotkey = { ctrl: false, alt: false, shift: false, meta: false, code: '' };
  for (const part of parts) {
    const modifier = MODIFIERS[part.toLowerCase()];
    if (!modifier) return { error: `«${part}» - не клавиша-модификатор` };
    const name = modifier === 'cmdorctrl' ? (mac ? 'meta' : 'ctrl') : modifier;
    if (hotkey[name]) return { error: `модификатор «${part}» повторён` };
    hotkey[name] = true;
  }
  if (/^[A-Za-z]$/.test(key)) hotkey.code = `Key${key.toUpperCase()}`;
  else if (/^[0-9]$/.test(key)) hotkey.code = `Digit${key}`;
  else if (/^F([1-9]|1[0-2])$/i.test(key)) hotkey.code = key.toUpperCase();
  else return { error: `«${key}» - допустимы буква, цифра и F1-F12` };
  // Ctrl с буквой без других модификаторов - управляющие символы терминала (Ctrl+C, Ctrl+D): кнопка отняла бы их у сессии.
  if (!/^F/.test(hotkey.code) && !hotkey.alt && !hotkey.meta && !(hotkey.ctrl && hotkey.shift)) return { error: 'нужен Alt или Cmd, либо Ctrl с Shift, либо F-клавиша: остальное занято терминалом' };
  if ((mac ? RESERVED_MAC : RESERVED_OTHER).includes(canonical(hotkey))) return { error: 'сочетание занято приложением' };
  return hotkey;
}

export const hotkeyMatches = (h: Hotkey, e: KeyEventLike): boolean => h.code === e.code && h.ctrl === e.ctrlKey && h.alt === e.altKey && h.shift === e.shiftKey && h.meta === e.metaKey;

// ---------- проверка файла ----------

export interface ParsedCommands {
  commands: CommandButton[];
  problems: string[];
}

const where = (index: number, label: unknown): string => `Кнопка ${index + 1}${typeof label === 'string' && label.trim() ? ` («${label.trim()}»)` : ''}`;

/**
 * Поле `commands` файла воркспейса. Негодная кнопка пропускается, причина в problems; кнопка с ошибкой только в сочетании клавиш
 * остаётся без него; лишнее поле кнопки (опечатка `submt` оставила бы `submit` выключенным) называется, а кнопка остаётся.
 */
export function parseCommands(raw: unknown, mac: boolean): ParsedCommands {
  if (raw === undefined) return { commands: [], problems: [] };
  if (!Array.isArray(raw)) return { commands: [], problems: ['commands должен быть массивом кнопок'] };
  const problems: string[] = [];
  const commands: CommandButton[] = [];
  if (raw.length > MAX_COMMANDS) problems.push(`Кнопок больше ${MAX_COMMANDS}: лишние пропущены`);
  raw.slice(0, MAX_COMMANDS).forEach((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      problems.push(`${where(index, undefined)}: не объект`);
      return;
    }
    const { label, text, submit, hotkey, description, disabled } = item as Record<string, unknown>;
    const at = where(index, label);
    if (typeof label !== 'string' || !label.trim() || label.trim().length > LABEL_MAX || CONTROL.test(label)) {
      problems.push(`${at}: label - непустая строка до ${LABEL_MAX} знаков без управляющих символов`);
      return;
    }
    if (typeof text !== 'string' || !text.trim() || text.length > TEXT_MAX || CONTROL.test(text)) {
      problems.push(`${at}: text - непустая строка до ${TEXT_MAX} знаков в одну строку`);
      return;
    }
    if (submit !== undefined && typeof submit !== 'boolean') {
      problems.push(`${at}: submit - true или false`);
      return;
    }
    const button: CommandButton = { label: label.trim(), text: text.trim(), submit: submit === true };
    if (typeof hotkey === 'string') {
      const parsed = parseHotkey(hotkey.trim(), mac);
      if ('error' in parsed) problems.push(`${at}: hotkey: ${parsed.error}`);
      else button.hotkey = hotkey.trim();
    } else if (hotkey !== undefined) problems.push(`${at}: hotkey - строка вида «Alt+S»`);
    if (typeof description === 'string' && description.trim() && description.length <= DESCRIPTION_MAX && !CONTROL.test(description)) button.description = description.trim();
    else if (description !== undefined) problems.push(`${at}: description - непустая строка до ${DESCRIPTION_MAX} знаков в одну строку`);
    if (disabled === true) button.disabled = true;
    else if (disabled !== undefined && disabled !== false) problems.push(`${at}: disabled - true или false`);
    const extra = Object.keys(item).filter((key) => !KNOWN_FIELDS.has(key));
    if (extra.length) problems.push(`${at}: неизвестное поле ${extra.join(', ')}`);
    commands.push(button);
  });
  return { commands, problems };
}

export const sameLabel = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

export const canonicalJson = (value: unknown): string =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? JSON.stringify(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : JSON.stringify(value);
export const sameEntry = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

// ---------- слои: встроенные -> общие -> воркспейс ----------

export type Layer = 'builtin' | 'global' | 'workspace';
export type FileLayer = 'global' | 'workspace';
export type ButtonPlace = 'bar' | 'mr' | 'task' | 'jira';
export const LAYER_RANK: Record<Layer, number> = { builtin: 0, global: 1, workspace: 2 };

/** Запись слоя: полная кнопка либо правка кнопки нижнего слоя по полям (названо - заменяет нижнее значение). */
export interface CommandEntry {
  label: string;
  text?: string;
  submit?: boolean;
  /** null - снять сочетание нижней кнопки. */
  hotkey?: string | null;
  description?: string;
  disabled?: boolean;
}

export type EntryField = 'label' | 'text' | 'submit' | 'hotkey' | 'description' | 'disabled' | 'place';

/** Адрес отказа: кнопка и поле, чтобы окно и инструмент показали причину там, где она. message - целая фраза с номером кнопки. */
export interface ButtonIssue {
  place: ButtonPlace;
  layer: FileLayer;
  index?: number;
  label?: string;
  field?: EntryField;
  /** Запись разобрать нельзя и она не попала в набор: окно показывает её сырой строкой, чтобы поправить или удалить. */
  dropped?: boolean;
  message: string;
}

export interface ParsedLayer {
  entries: CommandEntry[];
  issues: ButtonIssue[];
  problems: string[];
}

/** Слой кнопок: commands.json либо поле commands файла воркспейса. Негодная запись пропускается, причина в issues; запись только с ошибкой в сочетании остаётся без него. Запись без text допустима как правка кнопки нижнего слоя, есть ли такая кнопка - судит resolveBar. */
export function parseLayer(raw: unknown, mac: boolean, layer: FileLayer = 'global'): ParsedLayer {
  const issues: ButtonIssue[] = [];
  const entries: CommandEntry[] = [];
  const issue = (index: number | undefined, label: unknown, field: EntryField | undefined, message: string, dropped = false): void => {
    issues.push({ place: 'bar', layer, ...(dropped ? { dropped: true } : {}), ...(index === undefined ? {} : { index }), ...(typeof label === 'string' && label.trim() ? { label: label.trim() } : {}), ...(field ? { field } : {}), message });
  };
  if (raw === undefined) return { entries, issues, problems: [] };
  if (!Array.isArray(raw)) {
    issue(undefined, undefined, undefined, 'commands должен быть массивом кнопок');
    return { entries, issues, problems: issues.map((i) => i.message) };
  }
  if (raw.length > MAX_COMMANDS) issue(undefined, undefined, undefined, `Кнопок больше ${MAX_COMMANDS}: лишние пропущены`);
  raw.slice(0, MAX_COMMANDS).forEach((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      issue(index, undefined, undefined, `${where(index, undefined)}: не объект`, true);
      return;
    }
    const { label, text, submit, hotkey, description, disabled } = item as Record<string, unknown>;
    const at = where(index, label);
    const bad = (field: EntryField | undefined, reason: string, dropped = false): void => issue(index, label, field, `${at}: ${reason}`, dropped);
    if (typeof label !== 'string' || !label.trim() || label.trim().length > LABEL_MAX || CONTROL.test(label)) {
      bad('label', `label - непустая строка до ${LABEL_MAX} знаков без управляющих символов`, true);
      return;
    }
    const entry: CommandEntry = { label: label.trim() };
    if (text !== undefined) {
      if (typeof text !== 'string' || !text.trim() || text.length > TEXT_MAX || CONTROL.test(text)) {
        bad('text', `text - непустая строка до ${TEXT_MAX} знаков в одну строку`, true);
        return;
      }
      entry.text = text.trim();
    }
    if (submit !== undefined) {
      if (typeof submit !== 'boolean') {
        bad('submit', 'submit - true или false', true);
        return;
      }
      entry.submit = submit;
    }
    if (hotkey === null) entry.hotkey = null;
    else if (typeof hotkey === 'string') {
      const parsed = parseHotkey(hotkey.trim(), mac);
      if ('error' in parsed) bad('hotkey', `hotkey: ${parsed.error}`);
      else entry.hotkey = hotkey.trim();
    } else if (hotkey !== undefined) bad('hotkey', 'hotkey - строка вида «Alt+S»');
    if (typeof description === 'string' && description.trim() && description.length <= DESCRIPTION_MAX && !CONTROL.test(description)) entry.description = description.trim();
    else if (description !== undefined) bad('description', `description - непустая строка до ${DESCRIPTION_MAX} знаков в одну строку`);
    if (typeof disabled === 'boolean') entry.disabled = disabled;
    else if (disabled !== undefined) bad('disabled', 'disabled - true или false');
    const extra = Object.keys(item).filter((key) => !KNOWN_FIELDS.has(key));
    if (extra.length) bad(undefined, `неизвестное поле ${extra.join(', ')}`);
    entries.push(entry);
  });
  return { entries, issues, problems: issues.map((i) => i.message) };
}

const isRefEntry = (e: CommandEntry): boolean => Object.keys(e).length === 1;
const hotkeyKey = (text: string | null | undefined, mac: boolean): string | null => {
  if (!text) return null;
  const parsed = parseHotkey(text, mac);
  return 'error' in parsed ? null : canonical(parsed);
};
export const sameHotkey = (a: string | null | undefined, b: string | null | undefined, mac: boolean): boolean => {
  const ka = hotkeyKey(a, mac);
  return ka !== null && ka === hotkeyKey(b, mac);
};

/** Копия встроенной кнопки: до общего набора редактор записывал встроенные кнопки в файл воркспейса целиком. Такая запись ничего не меняет, поэтому не заслоняет правку общего набора. */
const isBuiltinCopy = (entry: CommandEntry): boolean => {
  const builtin = DEFAULT_COMMANDS.find((d) => sameLabel(d.label, entry.label));
  return (
    builtin !== undefined &&
    entry.text === builtin.text &&
    (entry.submit === true) === builtin.submit &&
    entry.hotkey === builtin.hotkey &&
    entry.description === builtin.description &&
    entry.disabled === undefined
  );
};

type RowField = 'text' | 'submit' | 'hotkey' | 'description' | 'disabled';

/** Строка набора после наложения слоёв: действующие значения, слой каждого поля и слой, где кнопка появилась. */
export interface BarRow {
  label: string;
  text: string;
  submit: boolean;
  /** Сочетание строки как задано, до отдачи верхней кнопке. */
  hotkey?: string;
  description?: string;
  disabled?: boolean;
  origin: Layer;
  from: Partial<Record<RowField, Layer>>;
  /** Сочетание строки отдано этой кнопке верхнего слоя. */
  hotkeyLostTo?: string;
  /** Подписи кнопок, у которых эта строка забрала сочетание. */
  hotkeyTakenFrom?: string[];
  /** Для выключенной строки: у кого сейчас её сочетание. */
  hotkeyHolder?: string;
}

interface Placed<B, L> {
  below?: B;
  own?: L;
}

/** Записи слоя идут в своём порядке, неупомянутая кнопка нижнего слоя - сразу за упомянутой перед ней: слой называет только то, что двигает. */
function placeLayer<B, L>(base: readonly B[], layer: readonly L[], same: (below: B, own: L) => boolean): Placed<B, L>[] {
  const out: Placed<B, L>[] = [];
  const firstOf = (below: B): number => layer.findIndex((own) => same(below, own));
  const emit = (index: number): void => {
    const below = base.find((b) => firstOf(b) === index);
    out.push(below === undefined ? { own: layer[index] } : { below, own: layer[index] });
  };
  let next = 0;
  for (const below of base) {
    const at = firstOf(below);
    if (at === -1) out.push({ below });
    else for (; next <= at; next++) emit(next);
  }
  for (; next < layer.length; next++) emit(next);
  return out;
}

const rowsMatch = (below: { label: string }, own: { label: string }): boolean => sameLabel(below.label, own.label);

const builtinRows = (): BarRow[] =>
  DEFAULT_COMMANDS.map((d) => ({
    label: d.label,
    text: d.text,
    submit: d.submit,
    ...(d.hotkey ? { hotkey: d.hotkey } : {}),
    ...(d.description ? { description: d.description } : {}),
    origin: 'builtin' as Layer,
    from: { text: 'builtin', submit: 'builtin', ...(d.hotkey ? { hotkey: 'builtin' } : {}), ...(d.description ? { description: 'builtin' } : {}) } as BarRow['from'],
  }));

/** Правка по полям: названное поле заменяет нижнее. Запись со своим text задаёт и submit (нет поля - только вставить): submit снизу ей не достаётся. */
function applyEntry(row: BarRow, e: CommandEntry, layer: FileLayer): BarRow {
  if (isBuiltinCopy(e)) return row;
  const out: BarRow = { ...row, from: { ...row.from } };
  if (e.text !== undefined) {
    out.text = e.text;
    out.from.text = layer;
    out.submit = e.submit === true;
    out.from.submit = layer;
  } else if (e.submit !== undefined) {
    out.submit = e.submit;
    out.from.submit = layer;
  }
  if (e.hotkey === null) {
    delete out.hotkey;
    out.from.hotkey = layer;
  } else if (e.hotkey !== undefined) {
    out.hotkey = e.hotkey;
    out.from.hotkey = layer;
  }
  if (e.description !== undefined) {
    out.description = e.description;
    out.from.description = layer;
  }
  if (e.disabled !== undefined) {
    if (e.disabled) out.disabled = true;
    else delete out.disabled;
    out.from.disabled = layer;
  }
  return out;
}

function applyLayer(base: BarRow[], parsed: ParsedLayer, layer: FileLayer, issues: ButtonIssue[]): BarRow[] {
  const seen = new Set<string>();
  const own: CommandEntry[] = [];
  for (const e of parsed.entries) {
    const key = e.label.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      own.push(e);
      continue;
    }
    const builtin = base.some((b) => b.origin === 'builtin' && sameLabel(b.label, e.label));
    issues.push({ place: 'bar', layer, label: e.label, field: 'label', message: builtin ? `«${e.label}»: подпись встроенной кнопки повторена, действует первая запись` : `«${e.label}»: подпись повторена в слое, действует первая запись` });
  }
  return placeLayer(base, own, rowsMatch).flatMap(({ below, own: entry }) => {
    if (entry === undefined) return below ? [below] : [];
    if (below !== undefined) return [applyEntry(below, entry, layer)];
    if (entry.text === undefined) {
      issues.push({ place: 'bar', layer, label: entry.label, field: 'text', message: `«${entry.label}»: запись без text правит кнопку нижнего слоя, а кнопки «${entry.label}» ниже нет` });
      return [];
    }
    return [
      {
        label: entry.label,
        text: entry.text,
        submit: entry.submit === true,
        ...(entry.hotkey ? { hotkey: entry.hotkey } : {}),
        ...(entry.description ? { description: entry.description } : {}),
        ...(entry.disabled ? { disabled: true } : {}),
        origin: layer,
        from: { text: layer, submit: layer, ...(entry.hotkey ? { hotkey: layer } : {}), ...(entry.description ? { description: layer } : {}), ...(entry.disabled !== undefined ? { disabled: layer } : {}) },
      } as BarRow,
    ];
  });
}

/** Сочетание достаётся кнопке, чьё значение пришло из самого верхнего слоя; остальные включённые кнопки с ним его теряют без замечания. Две кнопки одного слоя (выше встроенного) с одним сочетанием - повтор: замечание, действует первая по порядку. */
function assignHotkeys(rows: BarRow[], mac: boolean, issues: ButtonIssue[]): void {
  const groups = new Map<string, BarRow[]>();
  for (const row of rows) {
    const key = row.disabled ? null : hotkeyKey(row.hotkey, mac);
    if (key !== null) groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const owners = new Map<string, BarRow>();
  for (const [key, group] of groups) {
    const rank = (r: BarRow): number => LAYER_RANK[r.from.hotkey ?? 'builtin'];
    const top = Math.max(...group.map(rank));
    const owner = group.find((r) => rank(r) === top) as BarRow;
    owners.set(key, owner);
    for (const row of group) {
      if (row === owner) continue;
      row.hotkeyLostTo = owner.label;
      owner.hotkeyTakenFrom = [...(owner.hotkeyTakenFrom ?? []), row.label];
    }
    // Повтор внутри слоя - замечание, даже когда сочетание забрала кнопка слоя повыше: она может его отдать.
    for (const layer of ['global', 'workspace'] as const) {
      const same = group.filter((r) => r.from.hotkey === layer);
      for (const row of same.slice(1)) issues.push({ place: 'bar', layer, label: row.label, field: 'hotkey', message: `«${row.label}»: сочетание ${row.hotkey} уже у кнопки «${same[0].label}»` });
    }
  }
  for (const row of rows) {
    if (!row.disabled) continue;
    const key = hotkeyKey(row.hotkey, mac);
    const owner = key === null ? undefined : owners.get(key);
    if (owner) row.hotkeyHolder = owner.label;
  }
}

export interface ResolvedBar {
  /** Все строки набора, в том числе выключенные. */
  rows: BarRow[];
  /** Кнопки полосы: включённые, сочетание только у владельца. */
  buttons: CommandButton[];
  issues: ButtonIssue[];
  problems: string[];
}

/** Набор полосы: встроенные кнопки, поверх них общий слой, поверх него слой воркспейса; оба слоя накладываются одним правилом по полям. */
export function resolveBar(config: Pick<CommandsConfig, 'global' | 'workspace'>, mac: boolean): ResolvedBar {
  const issues: ButtonIssue[] = [];
  let rows = builtinRows();
  for (const layer of ['global', 'workspace'] as const) {
    const parsed = parseLayer(config[layer], mac, layer);
    issues.push(...parsed.issues);
    rows = applyLayer(rows, parsed, layer, issues);
  }
  assignHotkeys(rows, mac, issues);
  const buttons = rows
    .filter((r) => !r.disabled)
    .map((r): CommandButton => ({ label: r.label, text: r.text, submit: r.submit, ...(r.hotkey && !r.hotkeyLostTo ? { hotkey: r.hotkey } : {}), ...(r.description ? { description: r.description } : {}) }));
  return { rows, buttons, issues, problems: issues.map((i) => i.message) };
}

/** Строки под слоем: встроенные для общего, встроенные и общий для воркспейса. */
export const rowsBelow = (layer: FileLayer, config: Pick<CommandsConfig, 'global'>, mac: boolean): BarRow[] => (layer === 'global' ? builtinRows() : resolveBar({ global: config.global, workspace: undefined }, mac).rows);

/** Порядок подписей, который даст слой поверх нижнего набора. */
export const layerOrder = (layer: readonly { label: string }[], base: readonly BarRow[]): string[] =>
  placeLayer(base, layer, rowsMatch).map(({ below, own }) => (below?.label ?? own?.label ?? '').toLowerCase());

const orderOf = (layer: readonly CommandEntry[], base: readonly BarRow[]): string => layerOrder(layer, base).join('\n');

/** Запись слоя сворачивается к полям, отличным от нижнего значения: копия кнопки нижнего слоя заслонила бы её правку снизу. Запись, от которой осталась одна подпись, держится, только если без неё сменится порядок. Своя кнопка слоя не сжимается. */
export function compactLayer(entries: readonly CommandEntry[], below: readonly BarRow[], mac: boolean): CommandEntry[] {
  let kept = entries.map((e): CommandEntry => {
    const base = below.find((b) => sameLabel(b.label, e.label));
    if (!base) return e;
    if (isBuiltinCopy(e)) return { label: e.label };
    const out: CommandEntry = { label: e.label };
    const submit = e.text !== undefined ? e.submit === true : (e.submit ?? base.submit);
    if (e.text !== undefined && e.text !== base.text) {
      out.text = e.text;
      if (submit) out.submit = true;
    } else if (submit !== base.submit) out.submit = submit;
    if (e.hotkey === null) {
      if (base.hotkey) out.hotkey = null;
    } else if (e.hotkey !== undefined && !sameHotkey(e.hotkey, base.hotkey, mac)) out.hotkey = e.hotkey;
    if (e.description !== undefined && e.description !== base.description) out.description = e.description;
    if (e.disabled === true && !base.disabled) out.disabled = true;
    else if (e.disabled === false && base.disabled) out.disabled = false;
    return out;
  });
  const wanted = orderOf(kept, below);
  for (const item of [...kept]) {
    if (!isRefEntry(item) || !below.some((b) => sameLabel(b.label, item.label))) continue;
    const without = kept.filter((other) => other !== item);
    if (orderOf(without, below) === wanted) kept = without;
  }
  return kept;
}

/** Набор кнопок как его отдаёт главный процесс: общий файл userData и поле `commands` файла воркспейса, оба как записаны. */
export interface CommandsConfig {
  global: unknown;
  /** Общий файл есть, но не прочитан или не JSON. */
  globalProblem?: string;
  workspace: unknown;
}

export type CommandsScope = FileLayer;

export type LayerCheck = { ok: true; entries: CommandEntry[] } | { ok: false; issues: ButtonIssue[] };

/** Проверка слоя перед записью: любое замечание в этом слое - отказ. Сочетания должны годиться на обеих системах (файл переносят). Повтор сочетания между слоями не замечание: верхняя кнопка забирает его у нижней. */
export function checkLayer(layer: FileLayer, raw: unknown, config: Pick<CommandsConfig, 'global' | 'workspace'>, mac: boolean): LayerCheck {
  if (!Array.isArray(raw)) return { ok: false, issues: [{ place: 'bar', layer, message: 'Нужен массив кнопок: [ { "label": ..., "text": ... } ]' }] };
  // Слой судится сам по себе: кнопка слоя повыше сочетание у него забрала бы, а повтор остался бы в файле.
  const resolved = resolveBar(layer === 'global' ? { global: raw, workspace: undefined } : { global: config.global, workspace: raw }, mac);
  const issues = resolved.issues.filter((i) => i.layer === layer);
  const parsed = parseLayer(raw, mac, layer);
  for (const entry of parsed.entries) {
    const other = typeof entry.hotkey === 'string' ? parseHotkey(entry.hotkey, !mac) : null;
    if (other && 'error' in other) issues.push({ place: 'bar', layer, label: entry.label, field: 'hotkey', message: `«${entry.label}»: сочетание ${entry.hotkey} не годится на ${mac ? 'Linux и Windows' : 'macOS'}: ${other.error}` });
  }
  if (issues.length) return { ok: false, issues };
  return { ok: true, entries: compactLayer(parsed.entries, rowsBelow(layer, config, mac), mac) };
}

// ---------- подстановки ----------

export type Placeholder = 'branch' | 'pr' | 'task';
/** Подстановки кнопки полосы в порядке показа в окне «Кнопки». */
export const BAR_PLACEHOLDERS: readonly Placeholder[] = ['branch', 'pr', 'task'];
export type PlaceholderValues = Partial<Record<Placeholder, string | null>>;
export type Expanded = { ok: true; text: string } | { ok: false; reason: string };

const PLACEHOLDER = /\{(branch|pr|task)\}/g;
// Ветка приходит из git и попадает в запрос к модели: пробелов и управляющих символов в имени ветки git не допускает, прочее отсекается здесь.
const SAFE_BRANCH = /^[A-Za-z0-9._/-]+$/;
const SAFE_REF = /^[^\s\u0000-\u001f\u007f]+$/;

const MISSING: Record<Placeholder, string> = {
  branch: '{branch}: у сессии нет ветки git',
  pr: '{pr}: у ветки нет открытого PR/MR',
  task: '{task}: сессия начата не из задачи',
};

/** Подстановки, которые нужны тексту: ветку, PR и задачу ищут только для них. */
export const placeholdersOf = (text: string): Placeholder[] => [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1] as Placeholder))];

/** Один проход: подставленное значение заново не разбирается. Нет значения либо оно небезопасно - отказ с причиной, текст не уходит. */
export function expandCommand(text: string, values: PlaceholderValues): Expanded {
  for (const name of placeholdersOf(text)) {
    const value = values[name];
    if (!value) return { ok: false, reason: MISSING[name] };
    if (!(name === 'branch' ? SAFE_BRANCH : SAFE_REF).test(value)) return { ok: false, reason: `{${name}}: значение содержит недопустимые знаки` };
  }
  return { ok: true, text: text.replace(PLACEHOLDER, (_all, name: Placeholder) => values[name] as string) };
}
