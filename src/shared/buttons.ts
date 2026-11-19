// Окно «Кнопки» и инструменты кнопок сессии (фича 12): вид набора по местам и чистые операции над записями слоя.

import {
  DEFAULT_COMMANDS,
  layerOrder,
  parseLayer,
  resolveBar,
  rowsBelow,
  sameHotkey,
  sameLabel,
  type BarRow,
  type ButtonIssue,
  type ButtonPlace,
  type EntryField,
  type FileLayer,
  type Layer,
} from '../main/commands';
import { BUILTIN_LAUNCH, BUTTONS_KEY, DEFAULT_PROMPTS, parseLaunchButtons, parsePrompts, type LaunchPlace, type PromptId } from '../main/prompts';

export interface ButtonsState {
  commands: { global: unknown; workspace: unknown };
  /** prompts.json как записан. */
  prompts: unknown;
  hasWorkspace: boolean;
  mac: boolean;
}

export type RowField = 'text' | 'submit' | 'hotkey' | 'description' | 'disabled';

export interface ButtonRow {
  key: string;
  place: ButtonPlace;
  label: string;
  origin: Layer;
  /** Строка бара правится формой с полями, строка запуска - только текст и описание. */
  kind: 'bar' | 'launch';
  /** Номер записи в файле слоя: у строки, которой нет в наборе (негодной), адрес один - номер. */
  rawIndex?: number;
  builtinId?: PromptId;
  text: string;
  submit: boolean;
  hotkey?: string;
  description?: string;
  from: Partial<Record<RowField, Layer>>;
  /** В выбранном слое есть запись этой кнопки. */
  changed: boolean;
  disabled: boolean;
  disabledIn?: Layer;
  hotkeyLostTo?: string;
  hotkeyTakenFrom?: string[];
  hotkeyHolder?: string;
  replacedBy?: string;
  replaces?: string;
  readOnly?: string;
  /** Как кнопка подписана на карточке. */
  card?: string;
  issue?: string;
}

export interface ButtonGroup {
  place: ButtonPlace;
  title: string;
  rows: ButtonRow[];
}

export interface ButtonsView {
  groups: ButtonGroup[];
  /** Замечания без адреса кнопки. */
  issues: string[];
}

export const GROUP_TITLES: Record<ButtonPlace, string> = {
  bar: 'Полоса сессии · в открытую сессию',
  mr: 'Карточка MR · новая сессия',
  task: 'Задача GitHub / GitLab · новая сессия',
  jira: 'Задача Jira · новая сессия',
};

export const PLACES: readonly ButtonPlace[] = ['bar', 'mr', 'task', 'jira'];
export const READ_ONLY_LAUNCH = 'правятся во всех воркспейсах';
export const LAYER_NAMES: Record<Layer, string> = { builtin: 'встроенная', global: 'общая', workspace: 'этот воркспейс' };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const labelOf = (item: unknown): string | null => (isRecord(item) && typeof item.label === 'string' ? item.label : null);
const keyOf = (place: ButtonPlace, label: string): string => `${place}:${label.trim().toLowerCase()}`;

const barConfig = (state: ButtonsState, layer: FileLayer): { global: unknown; workspace: unknown } => ({ global: state.commands.global, workspace: layer === 'workspace' ? state.commands.workspace : undefined });

export function buttonsView(state: ButtonsState, layer: FileLayer): ButtonsView {
  const cfg = barConfig(state, layer);
  const resolved = resolveBar(cfg, state.mac);
  const own = parseLayer(cfg[layer], state.mac, layer).entries;
  const here = resolved.issues.filter((i) => i.layer === layer);
  const bar: ButtonRow[] = resolved.rows.map((row) => ({
    key: keyOf('bar', row.label),
    place: 'bar',
    label: row.label,
    origin: row.origin,
    kind: 'bar',
    text: row.text,
    submit: row.submit,
    ...(row.hotkey ? { hotkey: row.hotkey } : {}),
    ...(row.description ? { description: row.description } : {}),
    from: row.from,
    changed: own.some((e) => sameLabel(e.label, row.label)),
    disabled: row.disabled === true,
    ...(row.disabled && row.from.disabled ? { disabledIn: row.from.disabled } : {}),
    ...(row.hotkeyLostTo ? { hotkeyLostTo: row.hotkeyLostTo } : {}),
    ...(row.hotkeyTakenFrom ? { hotkeyTakenFrom: row.hotkeyTakenFrom } : {}),
    ...(row.hotkeyHolder ? { hotkeyHolder: row.hotkeyHolder } : {}),
  }));
  bar.forEach((row, i) => {
    const next = bar[i + 1];
    if (row.disabled && row.disabledIn === layer && row.origin !== layer && next && next.origin === layer && row.hotkey && sameHotkey(row.hotkey, next.hotkey, state.mac)) {
      row.replacedBy = next.label;
      next.replaces = row.label;
    }
  });
  const rawBar = Array.isArray(cfg[layer]) ? (cfg[layer] as unknown[]) : [];
  // Запись, которой нет в наборе (негодная либо без кнопки ниже), встаёт строкой по номеру в файле слоя: её можно поправить и удалить.
  for (const issue of here) {
    const row = issue.dropped || issue.label === undefined ? undefined : bar.find((r) => sameLabel(r.label, issue.label as string));
    if (row) {
      row.issue = row.issue ? `${row.issue}\n${issue.message}` : issue.message;
      continue;
    }
    const at = issue.index ?? (issue.label === undefined ? -1 : rawBar.findIndex((e) => labelOf(e) !== null && sameLabel(labelOf(e) as string, issue.label as string)));
    if (at < 0) continue;
    const key = `bar:#${at}`;
    const shown = bar.find((r) => r.key === key);
    if (shown) {
      shown.issue = `${shown.issue}\n${issue.message}`;
      continue;
    }
    const raw = isRecord(rawBar[at]) ? (rawBar[at] as Record<string, unknown>) : {};
    const str = (k: string): string | undefined => (typeof raw[k] === 'string' ? (raw[k] as string) : undefined);
    bar.push({
      key,
      place: 'bar',
      label: labelOf(rawBar[at]) ?? `Запись ${at + 1}`,
      origin: layer,
      kind: 'bar',
      rawIndex: at,
      text: str('text') ?? '',
      submit: raw.submit === true,
      ...(str('hotkey') ? { hotkey: str('hotkey') as string } : {}),
      ...(str('description') ? { description: str('description') as string } : {}),
      from: {},
      changed: true,
      disabled: false,
      issue: issue.message,
    });
  }
  const stray = here.filter((i) => i.index === undefined && i.label === undefined).map((i) => i.message);
  const groups: ButtonGroup[] = [{ place: 'bar', title: GROUP_TITLES.bar, rows: bar }];
  const parsedPrompts = parsePrompts(state.prompts);
  const custom = parseLaunchButtons(state.prompts);
  for (const place of ['mr', 'task', 'jira'] as LaunchPlace[]) {
    const readOnly = layer === 'workspace' ? READ_ONLY_LAUNCH : undefined;
    const rows: ButtonRow[] = BUILTIN_LAUNCH[place].map((b) => {
      const ownPrompt = parsedPrompts.prompts[b.id];
      const rawOwn = isRecord(state.prompts) ? state.prompts[b.id] : undefined;
      const problem = parsedPrompts.problems.filter((x) => x.startsWith(`Промпт «${b.id}»`)).join('\n');
      const description = ownPrompt ? ownPrompt.description : DEFAULT_PROMPTS[b.id].description;
      return {
        key: keyOf(place, b.label),
        place,
        label: b.label,
        origin: 'builtin',
        kind: 'launch',
        builtinId: b.id,
        text: ownPrompt?.text ?? (isRecord(rawOwn) && typeof rawOwn.text === 'string' ? rawOwn.text : DEFAULT_PROMPTS[b.id].text),
        submit: false,
        ...(description ? { description } : {}),
        from: { text: rawOwn !== undefined ? 'global' : 'builtin' },
        changed: layer === 'global' && rawOwn !== undefined,
        disabled: false,
        card: b.card,
        ...(readOnly ? { readOnly } : {}),
        ...(problem ? { issue: problem } : {}),
      };
    });
    for (const button of custom.buttons.filter((b) => b.place === place)) {
      rows.push({
        key: keyOf(place, button.label),
        place,
        label: button.label,
        origin: 'global',
        kind: 'launch',
        text: button.text,
        submit: false,
        ...(button.description ? { description: button.description } : {}),
        from: { text: 'global' },
        changed: false,
        disabled: button.disabled === true,
        ...(button.disabled ? { disabledIn: 'global' as Layer } : {}),
        ...(readOnly ? { readOnly } : {}),
      });
    }
    for (const bad of custom.bad.filter((b) => b.place === place)) {
      rows.push({ key: `${place}:#${bad.index}`, place, label: bad.label ?? `Кнопка ${bad.index + 1}`, origin: 'global', kind: 'launch', text: '', submit: false, from: {}, changed: false, disabled: false, issue: bad.message, ...(readOnly ? { readOnly } : {}) });
    }
    groups.push({ place, title: GROUP_TITLES[place], rows });
  }
  const loose = [...custom.issues.filter((i) => i.index === undefined).map((i) => i.message), ...custom.bad.filter((b) => b.place === undefined).map((b) => b.message)];
  const looseLaunch = [...parsedPrompts.problems.filter((x) => !BUILTIN_LAUNCH.mr.concat(BUILTIN_LAUNCH.task, BUILTIN_LAUNCH.jira).some((b) => x.startsWith(`Промпт «${b.id}»`)))];
  return { groups, issues: [...stray, ...looseLaunch, ...loose] };
}

// ---------- операции над записями слоя ----------

export type OpResult = { ok: true; entries: unknown[] } | { ok: false; error: string; label?: string; field?: EntryField };
const fail = (error: string, label?: string, field?: EntryField): OpResult => ({ ok: false, error, ...(label ? { label } : {}), ...(field ? { field } : {}) });

export interface LayerCtx {
  layer: FileLayer;
  /** Записи слоя как записаны. */
  entries: unknown[];
  /** Набор под слоем. */
  below: BarRow[];
  /** Действующий набор слоя: порядок и значения. */
  rows: BarRow[];
}

export function layerCtx(state: ButtonsState, layer: FileLayer): LayerCtx {
  const raw = state.commands[layer];
  return { layer, entries: Array.isArray(raw) ? raw : [], below: rowsBelow(layer, state.commands, state.mac), rows: resolveBar(barConfig(state, layer), state.mac).rows };
}

const findAt = (entries: readonly unknown[], label: string): number => entries.findIndex((e) => labelOf(e) !== null && sameLabel(labelOf(e) as string, label));
const named = (entries: readonly unknown[]): { label: string }[] => entries.filter((e) => labelOf(e) !== null) as { label: string }[];

/** Новая запись встаёт так, чтобы порядок кнопок, заданный слоем, не сменился. */
function insertKeepingOrder(entries: readonly unknown[], below: readonly BarRow[], entry: Record<string, unknown>, after?: number): unknown[] {
  const label = entry.label as string;
  if (after !== undefined) return [...entries.slice(0, after + 1), entry, ...entries.slice(after + 1)];
  if (!below.some((b) => sameLabel(b.label, label))) return [...entries, entry];
  const want = layerOrder(named(entries), below).join('\n');
  for (let at = 0; at <= entries.length; at++) {
    const next = [...entries.slice(0, at), entry, ...entries.slice(at)];
    if (layerOrder(named(next), below).join('\n') === want) return next;
  }
  return [...entries, entry];
}

export interface BarPatch {
  text?: string;
  submit?: boolean;
  hotkey?: string | null;
  description?: string;
}

const known = (ctx: LayerCtx, label: string): boolean => ctx.rows.some((r) => sameLabel(r.label, label)) || findAt(ctx.entries, label) >= 0;

/** Меняет названные поля кнопки: у унаследованной - частичной записью слоя. undefined в поле - убрать его из записи. */
export function setFields(ctx: LayerCtx, label: string, patch: BarPatch): OpResult {
  if (!known(ctx, label)) return fail(`кнопки «${label}» нет`, label);
  const at = findAt(ctx.entries, label);
  const entry: Record<string, unknown> = at >= 0 ? { ...(ctx.entries[at] as Record<string, unknown>) } : { label: ctx.rows.find((r) => sameLabel(r.label, label))?.label ?? label };
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) delete entry[field];
    else entry[field] = value;
  }
  if (at >= 0) return { ok: true, entries: ctx.entries.map((e, i) => (i === at ? entry : e)) };
  return { ok: true, entries: insertKeepingOrder(ctx.entries, ctx.below, entry) };
}

/** Убирает поле из записи слоя: значение снова берётся снизу. Действующий submit при сбросе text не меняется. */
export function resetField(ctx: LayerCtx, label: string, field: 'text' | 'submit' | 'hotkey' | 'description' | 'disabled'): OpResult {
  const at = findAt(ctx.entries, label);
  if (at < 0) return { ok: true, entries: ctx.entries };
  const entry = { ...(ctx.entries[at] as Record<string, unknown>) };
  if (field === 'text' && entry.text !== undefined && entry.submit === undefined) entry.submit = false;
  delete entry[field];
  return { ok: true, entries: ctx.entries.map((e, i) => (i === at ? entry : e)) };
}

/** Выключает или включает кнопку в слое. Включение снимает поле, а над кнопкой, выключенной ниже, пишет disabled: false. */
export function setDisabled(ctx: LayerCtx, label: string, off: boolean): OpResult {
  const own = !ctx.below.some((b) => sameLabel(b.label, label));
  if (!off && own) return resetField(ctx, label, 'disabled');
  return setFields(ctx, label, { disabled: off } as BarPatch);
}

export function removeButton(ctx: LayerCtx, label: string): OpResult {
  if (findAt(ctx.entries, label) < 0) return fail(`в слое нет записи «${label}»`, label);
  return { ok: true, entries: ctx.entries.filter((e) => !(labelOf(e) !== null && sameLabel(labelOf(e) as string, label))) };
}

/** Запись слоя по номеру в файле: негодную, у которой подписи может не быть, адресует только он. */
export function removeAt(ctx: LayerCtx, index: number): OpResult {
  if (!Number.isInteger(index) || index < 0 || index >= ctx.entries.length) return fail('записи с таким номером нет');
  return { ok: true, entries: ctx.entries.filter((_e, i) => i !== index) };
}

/** Правит поля записи по номеру в файле; undefined убирает поле. Работает и с негодной записью. */
export function patchAt(ctx: LayerCtx, index: number, patch: Record<string, unknown>): OpResult {
  const current = ctx.entries[index];
  if (!isRecord(current)) return fail('запись не объект: её только удаляют');
  const entry = { ...current };
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) delete entry[field];
    else entry[field] = value;
  }
  return { ok: true, entries: ctx.entries.map((e, i) => (i === index ? entry : e)) };
}

export interface BarDraft extends BarPatch {
  label: string;
  text: string;
}

function labelTaken(ctx: LayerCtx, label: string, except?: string): string | null {
  const row = ctx.rows.find((r) => sameLabel(r.label, label) && !(except && sameLabel(r.label, except)));
  if (row) return row.label;
  const at = findAt(ctx.entries, label);
  return at >= 0 && !(except && sameLabel(labelOf(ctx.entries[at]) as string, except)) ? (labelOf(ctx.entries[at]) as string) : null;
}

export function addButton(ctx: LayerCtx, draft: BarDraft): OpResult {
  const taken = labelTaken(ctx, draft.label);
  if (taken) return fail(`подпись занята кнопкой «${taken}»`, draft.label, 'label');
  const { hotkey, submit, description, text } = draft;
  const entry = { label: draft.label, text, ...(submit ? { submit: true } : {}), ...(typeof hotkey === 'string' ? { hotkey } : {}), ...(description ? { description } : {}) };
  return { ok: true, entries: [...ctx.entries, entry] };
}

/** Своя кнопка слоя меняет подпись на месте: подпись унаследованной - ключ записи, её другой подписью заменяют. */
export function renameButton(ctx: LayerCtx, label: string, next: string): OpResult {
  const row = ctx.rows.find((r) => sameLabel(r.label, label));
  const at = findAt(ctx.entries, label);
  if (!row || at < 0 || ctx.below.some((b) => sameLabel(b.label, label))) return fail('подпись унаследованной кнопки не меняется: другая подпись - «Заменить другой кнопкой…»', label, 'label');
  const taken = labelTaken(ctx, next, label);
  if (taken) return fail(`подпись занята кнопкой «${taken}»`, label, 'label');
  return { ok: true, entries: ctx.entries.map((e, i) => (i === at ? { ...(e as Record<string, unknown>), label: next } : e)) };
}

/** Заменяет кнопку нижнего слоя: она выключается в слое, на её месте встаёт новая кнопка слоя с её сочетанием. */
export function replaceButton(ctx: LayerCtx, target: string, draft: BarDraft): OpResult {
  const row = ctx.rows.find((r) => sameLabel(r.label, target));
  if (!row || !ctx.below.some((b) => sameLabel(b.label, target))) return fail(`заменить можно кнопку нижнего слоя, а «${target}» такой нет`, target);
  const below = ctx.below.find((b) => sameLabel(b.label, draft.label));
  if (below) return fail(`есть кнопка «${below.label}» ниже: её правят, а не заменяют`, draft.label, 'label');
  const taken = labelTaken(ctx, draft.label);
  if (taken) return fail(`подпись занята кнопкой «${taken}»`, draft.label, 'label');
  const off = setDisabled(ctx, target, true);
  if (!off.ok) return off;
  const at = findAt(off.entries, target);
  const hotkey = draft.hotkey === undefined ? row.hotkey : (draft.hotkey ?? undefined);
  const entry = { label: draft.label, text: draft.text, ...(draft.submit ? { submit: true } : {}), ...(hotkey ? { hotkey } : {}), ...(draft.description ? { description: draft.description } : {}) };
  // Без перечисленных следом кнопок новая ушла бы в конец набора, а не на место заменённой.
  const following = ctx.below.slice(ctx.below.findIndex((b) => sameLabel(b.label, target)) + 1).filter((b) => findAt(off.entries, b.label) < 0).map((b) => ({ label: b.label }));
  return { ok: true, entries: [...off.entries.slice(0, at + 1), entry, ...following, ...off.entries.slice(at + 1)] };
}

export interface ComposeForm {
  label: string;
  text: string;
  submit: boolean;
  description?: string;
  /** Подпись заменяемой кнопки нижнего слоя; нет - новая кнопка. */
  replace?: string;
  /** Сочетание задаёт человек; без него замена наследует сочетание заменяемой. */
  hotkey?: string;
}

/** Форма новой кнопки полосы: то, что окно делает по «Создать» и «Заменить». Сочетание заменяемой переходит к новой, если человек не назвал своё. */
export function composeBar(ctx: LayerCtx, form: ComposeForm): OpResult {
  const draft: BarDraft = { label: form.label, text: form.text, submit: form.submit, ...(form.description ? { description: form.description } : {}), ...(form.hotkey ? { hotkey: form.hotkey } : {}) };
  return form.replace ? replaceButton(ctx, form.replace, draft) : addButton(ctx, draft);
}

/** Новый порядок кнопок слоя: каждая нижняя кнопка, чьё место сменилось, получает запись, лишние записи уберёт сжатие. */
export function moveButton(ctx: LayerCtx, from: number, to: number): OpResult {
  const labels = ctx.rows.map((r) => r.label);
  if (from === to || from < 0 || to < 0 || from >= labels.length || to >= labels.length) return { ok: true, entries: ctx.entries };
  const order = [...labels];
  const [item] = order.splice(from, 1);
  order.splice(to, 0, item);
  const entries = order.map((label) => ctx.entries[findAt(ctx.entries, label)] ?? { label });
  const rest = ctx.entries.filter((e) => labelOf(e) === null || !order.some((l) => sameLabel(l, labelOf(e) as string)));
  return { ok: true, entries: [...entries, ...rest] };
}

/** Возвращает сочетание кнопке, потерявшей его: у забравшей оно убирается из записи слоя, а пришедшее снизу снимается записью hotkey: null. */
export function giveBackHotkey(ctx: LayerCtx, loser: string): OpResult {
  const lost = ctx.rows.find((r) => sameLabel(r.label, loser));
  const owner = lost?.hotkeyLostTo === undefined ? undefined : ctx.rows.find((r) => r.label === lost.hotkeyLostTo);
  if (!owner) return fail(`у «${loser}» сочетание не отнято`, loser, 'hotkey');
  if (owner.from.hotkey === ctx.layer) return resetField(ctx, owner.label, 'hotkey');
  return setFields(ctx, owner.label, { hotkey: null });
}

// ---------- кнопки запуска: prompts.json ----------

const promptsRoot = (raw: unknown): Record<string, unknown> => (isRecord(raw) ? { ...raw } : {});
const buttonList = (root: Record<string, unknown>): unknown[] => (Array.isArray(root[BUTTONS_KEY]) ? (root[BUTTONS_KEY] as unknown[]) : []);
const sameLaunch = (item: unknown, place: string, label: string): boolean => isRecord(item) && item.place === place && typeof item.label === 'string' && sameLabel(item.label, label);

export interface LaunchPatch {
  label?: string;
  text?: string;
  description?: string;
  disabled?: boolean;
}

/** Встроенный промпт: запись в файле под id (text и description), null - вернуть встроенный. */
export function setBuiltinPrompt(raw: unknown, id: PromptId, patch: { text?: string; description?: string } | null): Record<string, unknown> {
  const root = promptsRoot(raw);
  if (patch === null) {
    delete root[id];
    return root;
  }
  const current = isRecord(root[id]) ? (root[id] as Record<string, unknown>) : { text: DEFAULT_PROMPTS[id].text, description: DEFAULT_PROMPTS[id].description };
  root[id] = { ...current, ...patch };
  return root;
}

export function addLaunchButton(raw: unknown, button: { place: LaunchPlace; label: string; text: string; description?: string }): Record<string, unknown> {
  const root = promptsRoot(raw);
  root[BUTTONS_KEY] = [...buttonList(root), { place: button.place, label: button.label, text: button.text, ...(button.description ? { description: button.description } : {}) }];
  return root;
}

export function updateLaunchButton(raw: unknown, place: LaunchPlace, label: string, patch: LaunchPatch): Record<string, unknown> | null {
  const root = promptsRoot(raw);
  const list = buttonList(root);
  const at = list.findIndex((item) => sameLaunch(item, place, label));
  if (at < 0) return null;
  const next = { ...(list[at] as Record<string, unknown>) };
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined || (field === 'disabled' && value === false)) delete next[field];
    else next[field] = value;
  }
  root[BUTTONS_KEY] = list.map((item, i) => (i === at ? next : item));
  return root;
}

export function removeLaunchButton(raw: unknown, place: LaunchPlace, label: string): Record<string, unknown> | null {
  const root = promptsRoot(raw);
  const list = buttonList(root);
  if (!list.some((item) => sameLaunch(item, place, label))) return null;
  root[BUTTONS_KEY] = list.filter((item) => !sameLaunch(item, place, label));
  return root;
}

/** Первая причина отказа в файле промптов: встроенные промпты и свои кнопки. */
export function promptsProblem(raw: unknown): string | null {
  const parsed = parsePrompts(raw);
  const issues = parseLaunchButtons(raw).issues;
  return parsed.problems[0] ?? issues[0]?.message ?? null;
}

export const promptsIssues = (raw: unknown): ButtonIssue[] => parseLaunchButtons(raw).issues;

// ---------- вызовы инструментов ----------

export type ToolLayer = 'workspace' | 'all';

export interface ButtonCall {
  place: ButtonPlace;
  label: string;
  layer: ToolLayer;
  text?: string;
  submit?: boolean;
  hotkey?: string | null;
  description?: string;
  newLabel?: string;
  reset?: ('text' | 'submit' | 'hotkey' | 'description')[];
  disabled?: boolean;
}

const ARGS: Record<string, readonly string[]> = {
  add_button: ['place', 'label', 'text', 'submit', 'hotkey', 'description', 'layer'],
  update_button: ['place', 'label', 'layer', 'text', 'submit', 'hotkey', 'description', 'new_label', 'reset'],
  disable_button: ['place', 'label', 'layer', 'disabled'],
};

/** Форма аргументов инструмента: типы и лишние поля. Содержание полей судят те же правила, что запись из окна. */
export function validateButtonCall(name: string, value: unknown): ButtonCall | string {
  const allowed = ARGS[name];
  if (!allowed || !isRecord(value)) return 'аргументы - объект';
  const extra = Object.keys(value).filter((k) => !allowed.includes(k));
  if (extra.length) return `лишние поля: ${extra.join(', ')}`;
  const str = (k: string): string | undefined | null => (value[k] === undefined ? undefined : typeof value[k] === 'string' ? (value[k] as string) : null);
  const place = value.place === undefined ? 'bar' : value.place;
  if (!(PLACES as readonly unknown[]).includes(place)) return 'place - bar, mr, task или jira';
  const label = str('label');
  if (typeof label !== 'string' || !label.trim()) return 'label - непустая строка';
  const layer = value.layer === undefined ? 'workspace' : value.layer;
  if (layer !== 'workspace' && layer !== 'all') return 'layer - workspace или all';
  const call: ButtonCall = { place: place as ButtonPlace, label: label.trim(), layer };
  for (const [field, key] of [['text', 'text'], ['description', 'description'], ['newLabel', 'new_label']] as const) {
    const v = str(key);
    if (v === null) return `${key} - строка`;
    if (v !== undefined) call[field] = v;
  }
  if (value.submit !== undefined) {
    if (typeof value.submit !== 'boolean') return 'submit - true или false';
    call.submit = value.submit;
  }
  if (value.hotkey !== undefined) {
    if (value.hotkey !== null && typeof value.hotkey !== 'string') return 'hotkey - строка вида «Alt+M»' + (name === 'update_button' ? ' или null' : '');
    if (value.hotkey === null && name !== 'update_button') return 'hotkey - строка вида «Alt+M»';
    call.hotkey = value.hotkey as string | null;
  }
  if (value.disabled !== undefined) {
    if (typeof value.disabled !== 'boolean') return 'disabled - true или false';
    call.disabled = value.disabled;
  }
  if (value.reset !== undefined) {
    const fields = ['text', 'submit', 'hotkey', 'description'];
    if (!Array.isArray(value.reset) || value.reset.some((f) => !fields.includes(f as string))) return `reset - список из: ${fields.join(', ')}`;
    call.reset = value.reset as ButtonCall['reset'];
  }
  return call;
}

/** Подписи встроенных кнопок полосы - для сообщений. */
export const BUILTIN_BAR_LABELS = DEFAULT_COMMANDS.map((d) => d.label);
