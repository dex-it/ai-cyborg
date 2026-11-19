// Единственный писатель кнопок (фича 12): запись из окна, меню полосы и инструменты сессии идут через те же проверки и сжатие слоя.

import { checkLayer, canonicalJson, MAX_COMMANDS_TEXT, resolveBar, sameEntry, sameLabel, type ButtonIssue, type FileLayer } from './commands';
import { BUILTIN_LAUNCH, compactPrompts, DEFAULT_PROMPTS, MAX_PROMPTS_TEXT, parseLaunchButtons, type LaunchPlace, type PromptId } from './prompts';
import { modelText } from './suggestions';
import {
  addButton,
  addLaunchButton,
  buttonsView,
  layerCtx,
  promptsProblem,
  renameButton,
  resetField,
  setBuiltinPrompt,
  setDisabled,
  setFields,
  updateLaunchButton,
  validateButtonCall,
  type BarPatch,
  type ButtonCall,
  type ButtonsState,
  type OpResult,
} from '../shared/buttons';

export const UNDO_LOG_MAX = 50;

export interface ButtonsNotice {
  verb: 'added' | 'changed' | 'disabled' | 'enabled';
  place: ButtonCall['place'];
  label: string;
  hotkey?: string;
  took?: string[];
  undo: number;
  layer: 'workspace' | 'all';
}

export interface ButtonsSaveRequest {
  scope: FileLayer;
  commands: unknown[];
  prompts?: Record<string, unknown>;
  base: { commands: unknown; prompts?: unknown };
}

export interface ButtonsDeps {
  commands: { read(): { raw: unknown; problem?: string }; saveCommands(commands: unknown[]): void };
  prompts: { read(): { raw: unknown; problem?: string }; savePrompts(prompts: Record<string, unknown>): void };
  /** Воркспейс этого экземпляра: нет файла - слой воркспейса недоступен. */
  workspace(): { open: boolean; name: string | null; load(): unknown; save(commands: unknown[]): void };
  mac: boolean;
  announce?(caller: number, notice: ButtonsNotice): void;
}

interface JournalEntry {
  file: 'bar' | 'prompts';
  layer: FileLayer;
  /** Ключ записи: подпись кнопки полосы, id встроенного промпта или «место:подпись» своей кнопки запуска. */
  key: string;
  oldKey?: string;
  before: unknown;
  after: unknown;
  beforeIndex: number;
  done: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const norm = (value: unknown): string => canonicalJson(value ?? null) ?? 'null';
const messageOf = (issues: ButtonIssue[]): string => issues.map((i) => i.message).join('\n');
const labelAt = (entries: readonly unknown[], label: string): number => entries.findIndex((e) => isRecord(e) && typeof e.label === 'string' && sameLabel(e.label, label));
const NOT_OPEN = 'Воркспейс не открыт';
const ORIGIN = { builtin: 'builtin', global: 'all', workspace: 'workspace' } as const;

// Кнопка от инструмента остаётся надолго: ведущий «#» судится строже предложений модели, по образцу validateSend.
function toolText(text: string, submit: boolean): { refuse: string } | { submit: boolean; note?: string } {
  const filtered = modelText(text, submit);
  if ('refuse' in filtered || !text.trim().startsWith('#')) return filtered;
  return { submit: false, note: 'текст начинается с «#»: кнопка только вставляет, Enter нажмите сами' };
}

export class ButtonsService {
  private readonly journal = new Map<number, JournalEntry>();
  private nextUndo = 1;

  constructor(private readonly deps: ButtonsDeps) {}

  // ---------- состояние ----------

  /** problem - сбой commands.json (мешает кнопкам полосы), promptsProblem - сбой prompts.json (мешает кнопкам запуска): полоса файла промптов не касается. */
  private state(): { state: ButtonsState; problem?: string; promptsProblem?: string } {
    const global = this.deps.commands.read();
    const prompts = this.deps.prompts.read();
    const ws = this.deps.workspace();
    return {
      state: { commands: { global: global.raw, workspace: ws.open ? ws.load() : undefined }, prompts: prompts.raw, hasWorkspace: ws.open, mac: this.deps.mac },
      ...(global.problem ? { problem: global.problem } : {}),
      ...(prompts.problem ? { promptsProblem: prompts.problem } : {}),
    };
  }

  private rawLayer(layer: FileLayer): unknown {
    return layer === 'global' ? this.deps.commands.read().raw : this.deps.workspace().load();
  }

  // ---------- запись слоя ----------

  /** Проверка и сжатие слоя до записи: отказ - issues, файлы не меняются. */
  private prepare(layer: FileLayer, raw: unknown): { entries: unknown[] } | { error: string; issues?: ButtonIssue[] } {
    const { state, problem } = this.state();
    if (layer === 'workspace' && !state.hasWorkspace) return { error: NOT_OPEN };
    if (problem) return { error: problem };
    if (JSON.stringify(raw ?? null).length > MAX_COMMANDS_TEXT) return { error: 'Некорректный текст кнопок' };
    const checked = checkLayer(layer, raw, state.commands, state.mac);
    return checked.ok ? { entries: checked.entries } : { error: messageOf(checked.issues), issues: checked.issues };
  }

  private writeBar(layer: FileLayer, entries: unknown[]): void {
    if (layer === 'global') this.deps.commands.saveCommands(entries);
    else this.deps.workspace().save(entries);
  }

  private guard<T>(fn: () => T): T | { error: string } {
    try {
      return fn();
    } catch (error) {
      return { error: (error as Error).message };
    }
  }

  // ---------- окно ----------

  /** Запись из окна: слой и, в общем слое, файл промптов. base - файлы, как их прочитало окно: расхождение - отказ. */
  save(request: unknown): { error?: string; issues?: ButtonIssue[] } {
    if (!isRecord(request) || !Array.isArray(request.commands) || !isRecord(request.base)) return { error: 'Некорректный запрос кнопок' };
    const { scope, commands, prompts, base } = request;
    if (scope !== 'global' && scope !== 'workspace') return { error: 'Неизвестный набор кнопок' };
    if (scope === 'workspace' && prompts !== undefined) return { error: 'Кнопки запуска сессий правятся только во всех воркспейсах' };
    if (prompts !== undefined && !isRecord(prompts)) return { error: 'Некорректный текст промптов' };
    if (norm(this.rawLayer(scope)) !== norm(base.commands)) return { error: 'Кнопки изменились на диске после открытия окна' };
    const wantPrompts = prompts !== undefined ? compactPrompts(prompts) : undefined;
    const current = this.deps.prompts.read();
    if (wantPrompts !== undefined) {
      if (norm(current.raw) !== norm(base.prompts)) return { error: 'Кнопки изменились на диске после открытия окна' };
      if (JSON.stringify(wantPrompts).length > MAX_PROMPTS_TEXT) return { error: 'Некорректный текст промптов' };
    }
    const prepared = this.prepare(scope, commands);
    if ('error' in prepared) return prepared;
    const promptsChanged = wantPrompts !== undefined && norm(wantPrompts) !== norm(compactPrompts(isRecord(current.raw) ? current.raw : {}));
    if (promptsChanged) {
      if (current.problem) return { error: current.problem };
      const problem = promptsProblem(wantPrompts);
      if (problem) return { error: problem, issues: parseLaunchButtons(wantPrompts).issues };
    }
    const failed = this.guard(() => {
      this.writeBar(scope, prepared.entries);
      if (promptsChanged) this.deps.prompts.savePrompts(wantPrompts as Record<string, unknown>);
    });
    return failed && 'error' in failed ? failed : {};
  }

  /** commands:save прежнего вида: текст JSON одного слоя. */
  saveText(text: unknown, scope: unknown): { error?: string; issues?: ButtonIssue[] } {
    if (typeof text !== 'string' || text.length > MAX_COMMANDS_TEXT) return { error: 'Некорректный текст кнопок' };
    if (scope !== 'global' && scope !== 'workspace') return { error: 'Неизвестный набор кнопок' };
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      return { error: `Не JSON: ${(error as Error).message}` };
    }
    const prepared = this.prepare(scope, raw);
    if ('error' in prepared) return prepared;
    const failed = this.guard(() => this.writeBar(scope, prepared.entries));
    return failed && 'error' in failed ? failed : {};
  }

  /** Выключение из меню полосы: та же операция, что у инструмента, без фильтров и уведомления. */
  apply(request: unknown): { error?: string } {
    if (!isRecord(request) || request.op !== 'disable') return { error: 'Некорректный запрос кнопок' };
    const call = validateButtonCall('disable_button', { place: request.place, label: request.label, layer: request.layer === 'global' ? 'all' : request.layer, disabled: request.disabled });
    if (typeof call === 'string') return { error: call };
    const result = this.guard(() => this.run('disable_button', call));
    return 'error' in result ? result : {};
  }

  // ---------- инструменты ----------

  list(caller: number): string {
    void caller;
    const { state } = this.state();
    const layer: FileLayer = state.hasWorkspace ? 'workspace' : 'global';
    const view = buttonsView(state, layer);
    const entryLayers = (label: string): ('all' | 'workspace')[] =>
      (['global', 'workspace'] as const).filter((l) => Array.isArray(state.commands[l]) && (state.commands[l] as unknown[]).some((e) => isRecord(e) && typeof e.label === 'string' && sameLabel(e.label, label))).map((l) => (l === 'global' ? 'all' : 'workspace'));
    const out: Record<string, unknown> = { workspace: this.deps.workspace().name, layer: state.hasWorkspace ? 'workspace' : 'all' };
    for (const group of view.groups) {
      out[group.place] = group.rows.map((r) => {
        const changed = r.kind === 'bar' ? entryLayers(r.label) : r.from.text === 'global' && r.builtinId ? ['all'] : [];
        return {
          label: r.label,
          [r.kind === 'bar' ? 'text' : 'prompt']: r.text,
          ...(r.kind === 'bar' ? { submit: r.submit } : {}),
          ...(r.hotkey ? { hotkey: r.hotkey } : {}),
          ...(r.description ? { description: r.description } : {}),
          origin: ORIGIN[r.origin],
          ...(r.disabled ? { disabled: true } : {}),
          ...(changed.length ? { changed_in: changed } : {}),
          ...(r.hotkeyLostTo ? { hotkey_given_to: r.hotkeyLostTo } : {}),
          ...(r.issue ? { problem: r.issue } : {}),
        };
      });
    }
    return JSON.stringify(out, null, 1);
  }

  add(caller: number, args: unknown): string {
    return this.tool(caller, 'add_button', args);
  }

  update(caller: number, args: unknown): string {
    return this.tool(caller, 'update_button', args);
  }

  disable(caller: number, args: unknown): string {
    return this.tool(caller, 'disable_button', args);
  }

  private tool(caller: number, name: string, args: unknown): string {
    const call = validateButtonCall(name, args);
    if (typeof call === 'string') throw new Error(`${name}: ${call}`);
    const done = this.run(name, call);
    this.deps.announce?.(caller, done.notice);
    return done.message;
  }

  /** Одна операция над одной записью одного слоя; отказ - исключение с названием кнопки и поля. */
  private run(name: string, call: ButtonCall): { message: string; notice: ButtonsNotice } {
    const { state, problem, promptsProblem } = this.state();
    const { place, label } = call;
    if (place === 'bar' ? problem : promptsProblem) throw new Error((place === 'bar' ? problem : promptsProblem) as string);
    const refuse = (field: string, reason: string): never => {
      throw new Error(`«${label}», ${field}: ${reason}`);
    };
    if (place !== 'bar') return this.runLaunch(name, call, state);
    const layer: FileLayer = call.layer === 'all' ? 'global' : 'workspace';
    if (layer === 'workspace' && !state.hasWorkspace) refuse('layer', NOT_OPEN);
    const own = this.rawLayer(layer);
    const ownCheck = checkLayer(layer, own ?? [], state.commands, state.mac);
    if (!ownCheck.ok) refuse('слой', `в слое есть негодные записи, поправьте их в окне «Кнопки…»: ${messageOf(ownCheck.issues)}`);
    const ctx = layerCtx(state, layer);
    const all = resolveBar(state.commands, state.mac).rows;
    const existing = all.find((r) => sameLabel(r.label, label));
    let notes: string[] = [];
    let result: OpResult;
    let verb: ButtonsNotice['verb'] = 'changed';
    let finalLabel = existing?.label ?? label;
    const text = call.text;
    if (text !== undefined) {
      const filtered = toolText(text, call.submit ?? false);
      if ('refuse' in filtered) refuse('text', filtered.refuse);
    }
    if (name === 'add_button') {
      if (existing) refuse('label', `кнопка «${existing.label}» уже есть (${ORIGIN[existing.origin]}): поменять её - update_button, включить - disable_button с disabled: false`);
      if (text === undefined) refuse('text', 'нужен text');
      const filtered = toolText(text as string, call.submit ?? false) as { submit: boolean; note?: string };
      if (filtered.note) notes.push(filtered.note);
      result = addButton(ctx, { label, text: text as string, submit: filtered.submit, ...(call.hotkey ? { hotkey: call.hotkey } : {}), ...(call.description ? { description: call.description } : {}) });
      verb = 'added';
    } else if (name === 'update_button') {
      if (!existing) return refuse('label', `кнопки нет: завести её - add_button`);
      let entries: unknown[] = ctx.entries;
      let at = ctx;
      const step = (op: OpResult): void => {
        if (!op.ok) refuse(op.field ?? 'label', op.error);
        entries = (op as { entries: unknown[] }).entries;
        at = { ...ctx, entries };
      };
      if (call.newLabel !== undefined) {
        const renamed = renameButton(at, label, call.newLabel);
        if (!renamed.ok) refuse('new_label', 'подпись унаследованной кнопки не меняется: заведите новую - add_button, а эту выключите - disable_button');
        step(renamed);
        finalLabel = call.newLabel;
      }
      for (const field of call.reset ?? []) step(resetField(at, finalLabel, field));
      const patch: BarPatch = {};
      if (text !== undefined) {
        const filtered = toolText(text, call.submit ?? false) as { submit: boolean; note?: string };
        patch.text = text;
        patch.submit = filtered.submit || undefined;
        if (filtered.note) notes.push(filtered.note);
        else if (!filtered.submit) notes.push('кнопка только вставляет текст: Enter нажмите сами (submit: true отправляет с Enter)');
      } else if (call.submit !== undefined) {
        const effective = call.text ?? existing.text;
        const filtered = toolText(effective, call.submit) as { submit: boolean; note?: string };
        patch.submit = filtered.submit;
        if (filtered.note) notes.push(filtered.note);
      }
      if (call.hotkey !== undefined) patch.hotkey = call.hotkey;
      if (call.description !== undefined) patch.description = call.description;
      if (Object.keys(patch).length) step(setFields(at, finalLabel, patch));
      result = { ok: true, entries };
    } else {
      if (!existing) return refuse('label', 'кнопки нет');
      const off = call.disabled ?? true;
      result = setDisabled(ctx, label, off);
      verb = off ? 'disabled' : 'enabled';
    }
    if (!result.ok) return refuse(result.field ?? 'label', result.error);
    const prepared = this.prepare(layer, result.entries);
    if ('error' in prepared) {
      const first = 'issues' in prepared && prepared.issues?.[0];
      if (first) refuse(first.field ?? 'запись', first.message);
      throw new Error(prepared.error);
    }
    const before = ctx.entries.findIndex((e) => isRecord(e) && typeof e.label === 'string' && sameLabel(e.label, label));
    const afterIndex = labelAt(prepared.entries, finalLabel);
    const written = this.guard(() => this.writeBar(layer, prepared.entries));
    if (written && 'error' in written) throw new Error(written.error);
    const entry: JournalEntry = { file: 'bar', layer, key: finalLabel, ...(finalLabel !== label ? { oldKey: label } : {}), before: before >= 0 ? ctx.entries[before] : undefined, after: afterIndex >= 0 ? prepared.entries[afterIndex] : undefined, beforeIndex: before >= 0 ? before : ctx.entries.length, done: false };
    const undo = this.remember(entry);
    const after = resolveBar({ global: layer === 'global' ? prepared.entries : state.commands.global, workspace: layer === 'workspace' ? prepared.entries : state.commands.workspace }, state.mac).rows;
    const row = after.find((r) => sameLabel(r.label, finalLabel));
    const lostBefore = new Set(all.filter((r) => r.hotkeyLostTo).map((r) => r.label));
    const took = row && !row.disabled ? (row.hotkeyTakenFrom ?? []).filter((l) => !lostBefore.has(l)) : [];
    const hotkey = row && !row.disabled && !row.hotkeyLostTo ? row.hotkey : undefined;
    const where = layer === 'global' ? 'во всех воркспейсах' : 'в этом воркспейсе';
    const verbText = { added: 'добавлена', changed: 'изменена', disabled: 'выключена', enabled: 'включена' }[verb];
    if (took.length) notes = [...notes, `сочетание ${hotkey} забрано у ${took.map((l) => `«${l}»`).join(', ')}`];
    return {
      message: [`Кнопка «${finalLabel}» ${verbText} ${where}.`, ...notes].join(' '),
      notice: { verb, place, label: finalLabel, ...(hotkey ? { hotkey } : {}), ...(took.length ? { took } : {}), undo, layer: call.layer },
    };
  }

  private runLaunch(name: string, call: ButtonCall, state: ButtonsState): { message: string; notice: ButtonsNotice } {
    const { place, label } = call;
    const refuse = (field: string, reason: string): never => {
      throw new Error(`«${label}», ${field}: ${reason}`);
    };
    const resetOf = (field: string): ('text' | 'description')[] => {
      const fields = call.reset ?? [];
      if (fields.some((f) => f !== 'text' && f !== 'description')) refuse(field, 'у кнопок запуска сбрасываются text и description');
      return fields as ('text' | 'description')[];
    };
    if (call.layer !== 'all') refuse('layer', 'кнопки MR, задачи и Jira бывают только во всех воркспейсах: скажи это человеку и повтори с layer: "all"');
    for (const f of ['submit', 'hotkey'] as const) if (call[f] !== undefined) refuse(f, 'у кнопок запуска сессий этого поля нет');
    const lp = place as LaunchPlace;
    const builtin = BUILTIN_LAUNCH[lp].find((b) => sameLabel(b.label, label));
    const prompts = this.deps.prompts.read();
    const view = buttonsView(state, 'global').groups.find((g) => g.place === place)?.rows ?? [];
    const existing = view.find((r) => sameLabel(r.label, label));
    if (call.text !== undefined) {
      const filtered = modelText(call.text, false);
      if ('refuse' in filtered) refuse('text', filtered.refuse);
      if (call.text.trim().startsWith('#')) refuse('text', 'промпт не может начинаться с «#»: это команда Claude Code, а не задание сессии');
    }
    let next: Record<string, unknown> | null;
    let verb: ButtonsNotice['verb'] = 'changed';
    let key: string;
    let finalLabel = label;
    if (name === 'add_button') {
      if (existing) refuse('label', `кнопка «${existing.label}» уже есть (${ORIGIN[existing.origin]}): поменять её - update_button, включить - disable_button с disabled: false`);
      if (call.text === undefined) refuse('text', 'нужен text');
      next = addLaunchButton(prompts.raw, { place: lp, label, text: call.text as string, ...(call.description ? { description: call.description } : {}) });
      verb = 'added';
      key = `${place}:${label}`;
    } else if (builtin) {
      if (name === 'disable_button') return refuse('disabled', 'встроенные кнопки запуска не выключаются');
      if (call.newLabel !== undefined) refuse('new_label', 'подпись встроенной кнопки не меняется');
      key = builtin.id;
      const patch: { text?: string; description?: string } = {};
      for (const f of resetOf('reset')) patch[f] = DEFAULT_PROMPTS[builtin.id][f];
      if (call.text !== undefined) patch.text = call.text;
      if (call.description !== undefined) patch.description = call.description;
      next = setBuiltinPrompt(prompts.raw, builtin.id as PromptId, patch);
    } else {
      if (!existing) return refuse('label', 'кнопки нет: завести её - add_button');
      key = `${place}:${existing.label}`;
      if (name === 'disable_button') {
        const off = call.disabled ?? true;
        next = updateLaunchButton(prompts.raw, lp, existing.label, { disabled: off });
        verb = off ? 'disabled' : 'enabled';
      } else {
        const reset = resetOf('reset');
        if (reset.includes('text')) refuse('reset', 'у своей кнопки запуска нет нижнего слоя: text не сбрасывается, его задают или кнопку удаляют');
        next = updateLaunchButton(prompts.raw, lp, existing.label, { ...(reset.includes('description') ? { description: undefined } : {}), ...(call.text !== undefined ? { text: call.text } : {}), ...(call.description !== undefined ? { description: call.description } : {}), ...(call.newLabel !== undefined ? { label: call.newLabel } : {}) });
        if (call.newLabel !== undefined) finalLabel = call.newLabel;
      }
    }
    if (next === null) return refuse('label', 'кнопки нет');
    const wanted = compactPrompts(next);
    const problem = promptsProblem(wanted);
    if (problem) throw new Error(`«${label}»: ${problem}`);
    const read = (root: unknown, k: string): unknown => {
      if (!isRecord(root)) return undefined;
      if (!k.includes(':')) return root[k];
      const list = Array.isArray(root.buttons) ? root.buttons : [];
      const [p, ...l] = k.split(':');
      return list.find((item) => isRecord(item) && item.place === p && typeof item.label === 'string' && sameLabel(item.label, l.join(':')));
    };
    const written = this.guard(() => this.deps.prompts.savePrompts(wanted));
    if ('error' in (written ?? {})) throw new Error((written as { error: string }).error);
    const finalKey = key.includes(':') ? `${place}:${finalLabel}` : key;
    const undo = this.remember({ file: 'prompts', layer: 'global', key: finalKey, ...(finalKey !== key ? { oldKey: key } : {}), before: read(prompts.raw, key), after: read(wanted, finalKey), beforeIndex: key.includes(':') ? Math.max(0, (isRecord(prompts.raw) && Array.isArray(prompts.raw.buttons) ? prompts.raw.buttons : []).findIndex((item) => isRecord(item) && item.place === key.split(':')[0] && typeof item.label === 'string' && sameLabel(item.label, key.split(':').slice(1).join(':')))) : 0, done: false });
    const verbText = { added: 'добавлена', changed: 'изменена', disabled: 'выключена', enabled: 'включена' }[verb];
    return { message: `Кнопка запуска «${finalLabel}» ${verbText} во всех воркспейсах.`, notice: { verb, place, label: finalLabel, undo, layer: 'all' } };
  }

  // ---------- отмена ----------

  private remember(entry: JournalEntry): number {
    const id = this.nextUndo++;
    this.journal.set(id, entry);
    for (const old of [...this.journal.keys()]) if (this.journal.size > UNDO_LOG_MAX) this.journal.delete(old);
    return id;
  }

  /** Снимает только запись этого вызова: если запись с тех пор менялась, отмена отказывает, а не затирает чужую правку. */
  undo(id: unknown): { error?: string } {
    const rec = typeof id === 'number' ? this.journal.get(id) : undefined;
    if (!rec) return { error: 'Отменять нечего: журнал вызова не сохранился' };
    if (rec.done) return { error: 'Уже отменено' };
    const changed = (label: string): { error: string } => ({ error: `Кнопку «${label}» изменили после вызова: отмена сняла бы ту правку, поправьте её в окне «Кнопки…»` });
    if (rec.file === 'bar') {
      const current = this.rawLayer(rec.layer);
      const list = Array.isArray(current) ? current : [];
      const at = labelAt(list, rec.key);
      if (!sameEntry(at >= 0 ? list[at] : undefined, rec.after)) return changed(rec.key);
      if (rec.oldKey !== undefined && labelAt(list, rec.oldKey) >= 0) return changed(rec.oldKey);
      const rest = at >= 0 ? list.filter((_e, i) => i !== at) : [...list];
      const slot = Math.min(rec.beforeIndex, rest.length);
      const restored = rec.before === undefined ? rest : [...rest.slice(0, slot), rec.before, ...rest.slice(slot)];
      const prepared = this.prepare(rec.layer, restored);
      if ('error' in prepared) return { error: prepared.error };
      const failed = this.guard(() => this.writeBar(rec.layer, prepared.entries));
      if (failed && 'error' in failed) return failed;
    } else {
      const { raw, problem } = this.deps.prompts.read();
      if (problem) return { error: problem };
      const root: Record<string, unknown> = isRecord(raw) ? { ...raw } : {};
      const isButton = rec.key.includes(':');
      const match = (item: unknown, key: string): boolean => {
        const [p, ...l] = key.split(':');
        return isRecord(item) && item.place === p && typeof item.label === 'string' && sameLabel(item.label, l.join(':'));
      };
      if (isButton) {
        const list = Array.isArray(root.buttons) ? [...(root.buttons as unknown[])] : [];
        const at = list.findIndex((item) => match(item, rec.key));
        if (!sameEntry(at >= 0 ? list[at] : undefined, rec.after)) return changed(rec.key.split(':').slice(1).join(':'));
        if (at >= 0) list.splice(at, 1);
        if (rec.before !== undefined) {
          list.splice(Math.min(rec.beforeIndex, list.length), 0, rec.before);
        }
        root.buttons = list;
      } else {
        if (!sameEntry(root[rec.key], rec.after)) return changed(rec.key);
        if (rec.before === undefined) delete root[rec.key];
        else root[rec.key] = rec.before;
      }
      const failed = this.guard(() => this.deps.prompts.savePrompts(compactPrompts(root)));
      if (failed && 'error' in failed) return failed;
    }
    rec.done = true;
    return {};
  }
}
