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

/** Кнопки по умолчанию, общие для всех воркспейсов: фразы, которыми Claude Code понимает типовое действие. */
export const DEFAULT_COMMANDS: readonly CommandButton[] = [
  { label: 'Сливай', text: 'сливай', submit: true, hotkey: 'F1', description: 'Фраза «сливай»: слить PR текущей ветки.' },
  { label: 'Сделай PR', text: 'сделай PR', submit: true, hotkey: 'F2', description: 'Фраза «сделай PR»: открыть PR из текущей ветки.' },
  { label: 'Мердж', text: 'смерджи PR {pr}', submit: false, hotkey: 'F3', description: 'Вставляет «смерджи PR» со ссылкой на PR ветки без Enter: проверьте и нажмите Enter сами. Нужен открытый PR/MR ветки.' },
  { label: 'Приберись', text: 'приберись', submit: true, hotkey: 'F4', description: 'Фраза «приберись»: убрать за собой, например слитые ветки.' },
];

const KNOWN_FIELDS = new Set(['label', 'text', 'submit', 'hotkey', 'description', 'disabled']);
const CONTROL = /[\u0000-\u001f\u007f]/;

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

const sameLabel = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Встроенные кнопки и дополнения воркспейса: одноимённая кнопка заменяет встроенную на её месте, остальные идут следом; сочетание достаётся первой. */
export function mergeCommands(defaults: readonly CommandButton[], extra: readonly CommandButton[], mac: boolean): ParsedCommands {
  const all = defaults.map((d) => extra.find((e) => sameLabel(e.label, d.label)) ?? d);
  all.push(...extra.filter((e) => !defaults.some((d) => sameLabel(e.label, d.label))));
  // Скрытая кнопка не занимает сочетание и не попадает на полосу.
  const merged = all.filter((button) => !button.disabled);
  const problems: string[] = [];
  const taken = new Map<string, string>();
  const commands = merged.map((button) => {
    if (!button.hotkey) return button;
    const parsed = parseHotkey(button.hotkey, mac);
    const key = 'error' in parsed ? null : canonical(parsed);
    const owner = key === null ? undefined : taken.get(key);
    if (key !== null && owner === undefined) {
      taken.set(key, button.label);
      return button;
    }
    if (owner !== undefined) problems.push(`«${button.label}»: сочетание ${button.hotkey} уже у кнопки «${owner}»`);
    const rest: CommandButton = { ...button };
    delete rest.hotkey;
    return rest;
  });
  return { commands, problems };
}

/** Текст для редактора и проверка того, что из него вернулось; любая замеченная проблема - отказ, файл не пишется. Сочетания должны годиться на обеих системах. */
export function checkCommandsText(text: string, mac: boolean): { ok: true; commands: unknown[] } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `Не JSON: ${(error as Error).message}` };
  }
  if (!Array.isArray(raw)) return { ok: false, error: 'Нужен массив кнопок: [ { "label": ..., "text": ... } ]' };
  const parsed = parseCommands(raw, mac);
  // Файл переносят между системами: сочетание, которое годится только здесь (CmdOrCtrl+K на macOS), там получило бы замечание.
  const elsewhere = parsed.commands.flatMap((button) => {
    const other = button.hotkey ? parseHotkey(button.hotkey, !mac) : null;
    return other && 'error' in other ? [`«${button.label}»: сочетание ${button.hotkey} не годится на ${mac ? 'Linux и Windows' : 'macOS'}: ${other.error}`] : [];
  });
  const problems = [...parsed.problems, ...elsewhere, ...mergeCommands(DEFAULT_COMMANDS, parsed.commands, mac).problems];
  return problems.length ? { ok: false, error: problems.join('\n') } : { ok: true, commands: raw };
}

const labelOf = (item: unknown): string | null =>
  typeof item === 'object' && item !== null && typeof (item as { label?: unknown }).label === 'string' ? (item as { label: string }).label : null;

/**
 * Действующий набор в том виде, как он записывается в файл: встроенные кнопки (с описаниями) и записи файла как они есть, в порядке полосы.
 * Записи файла берутся без разбора, чтобы негодную запись можно было увидеть и поправить, а не потерять при сохранении.
 */
export function effectiveCommands(raw: unknown): unknown[] {
  const own = Array.isArray(raw) ? raw : [];
  const found = (label: string): unknown => own.find((item) => labelOf(item) !== null && sameLabel(labelOf(item) as string, label));
  const placed = DEFAULT_COMMANDS.map((d) => found(d.label));
  const merged: unknown[] = DEFAULT_COMMANDS.map((d, i) => placed[i] ?? d);
  merged.push(...own.filter((item) => !placed.includes(item)));
  return merged;
}

export const commandsToText = (raw: unknown): string => JSON.stringify(effectiveCommands(raw), null, 2);

/** Запись из редактора: текст проверяется заново (интерфейсу не доверяют), ошибка проверки или записи - в ответе, а не исключением. */
export function saveCommandsText(text: unknown, store: { saveCommands(commands: unknown[]): void }, mac: boolean): { error?: string } {
  if (typeof text !== 'string' || text.length > MAX_COMMANDS_TEXT) return { error: 'Некорректный текст кнопок' };
  const checked = checkCommandsText(text, mac);
  if (!checked.ok) return { error: checked.error };
  try {
    store.saveCommands(checked.commands);
  } catch (error) {
    return { error: (error as Error).message };
  }
  return {};
}

// ---------- подстановки ----------

export type Placeholder = 'branch' | 'pr' | 'task';
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
