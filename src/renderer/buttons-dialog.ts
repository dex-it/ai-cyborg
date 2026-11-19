// Окно «Кнопки»: одна форма на встроенные, общие и свои кнопки воркспейса (фича 12). Правки копятся в черновике, главный процесс проверяет и пишет слой целиком.

import {
  buttonsView,
  addButton,
  addLaunchButton,
  giveBackHotkey,
  layerCtx,
  moveButton,
  removeButton,
  removeLaunchButton,
  renameButton,
  replaceButton,
  resetField,
  setBuiltinPrompt,
  setDisabled,
  setFields,
  updateLaunchButton,
  LAYER_NAMES,
  type ButtonRow,
  type ButtonsState,
  type OpResult,
  type RowField,
} from '../shared/buttons';
import type { FileLayer } from '../main/commands';
import type { LaunchPlace } from '../main/prompts';
import { byId, el } from './dom';

const api = window.cyborg;

export interface ButtonsDialogDeps {
  mac: boolean;
  /** Кнопки записаны: полоса перечитывает файлы. */
  saved(): void;
}

export interface OpenRequest {
  layer?: FileLayer;
  place?: ButtonRow['place'];
  label?: string;
  /** Новая кнопка из предложенной моделью: подпись, текст, Enter. */
  draft?: { label: string; text: string; submit: boolean };
}

export interface ButtonsDialog {
  open(request?: OpenRequest): Promise<void>;
  /** Файлы поменялись снаружи: открытое окно перечитывает их, если нет несохранённой правки. */
  refresh(): Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function initButtonsDialog(deps: ButtonsDialogDeps): ButtonsDialog {
  const dialog = byId<HTMLDialogElement>('buttons-dialog');
  const listEl = byId('buttons-list');
  const formEl = byId('buttons-form');
  const problemsEl = byId('buttons-problems');
  const errorEl = byId('buttons-error');
  const saveButton = byId<HTMLButtonElement>('buttons-save');
  const tabs: Record<FileLayer, HTMLElement> = { global: byId('buttons-layer-global'), workspace: byId('buttons-layer-workspace') };
  const state: ButtonsState = { commands: { global: undefined, workspace: undefined }, prompts: undefined, hasWorkspace: false, mac: deps.mac };
  let layer: FileLayer = 'workspace';
  let selected: string | null = null;
  let initial = '';
  let base: { commands: unknown; prompts?: unknown } = { commands: undefined };
  let loadProblem = '';
  let compose: { place: ButtonRow['place']; replace?: string; label: string; text: string; submit: boolean } | null = null;

  const draftText = (): string => JSON.stringify([state.commands[layer] ?? null, layer === 'global' ? (state.prompts ?? null) : null]);
  const dirty = (): boolean => dialog.open && draftText() !== initial;
  const discardable = (): boolean => !dirty() || confirm('Закрыть без сохранения?');
  const showError = (text: string): void => {
    errorEl.textContent = text;
    errorEl.hidden = !text;
  };

  async function load(): Promise<void> {
    const [config, prompts, info] = await Promise.all([api.loadCommands(), api.loadPrompts(), api.workspaceInfo()]);
    state.commands = { global: config.global, workspace: config.workspace };
    state.prompts = prompts.raw;
    state.hasWorkspace = info.file !== null;
    loadProblem = [config.globalProblem, prompts.problem].filter(Boolean).join('\n');
    if (!state.hasWorkspace && layer === 'workspace') layer = 'global';
    base = { commands: state.commands[layer], ...(layer === 'global' ? { prompts: state.prompts } : {}) };
    initial = draftText();
    showError('');
  }

  const ctx = () => layerCtx(state, layer);
  const view = () => buttonsView(state, layer);
  const rowOf = (key: string | null): ButtonRow | undefined => view().groups.flatMap((g) => g.rows).find((r) => r.key === key);

  function applyOp(result: OpResult): boolean {
    if (!result.ok) {
      showError(result.error);
      return false;
    }
    showError('');
    state.commands = { ...state.commands, [layer]: result.entries };
    render();
    return true;
  }

  function setPrompts(next: Record<string, unknown> | null): void {
    if (!next) {
      showError('Кнопка не найдена');
      return;
    }
    showError('');
    state.prompts = next;
    render();
  }

  function render(): void {
    for (const key of ['global', 'workspace'] as const) {
      tabs[key].setAttribute('aria-pressed', String(key === layer));
      (tabs[key] as HTMLButtonElement).disabled = key === 'workspace' && !state.hasWorkspace;
    }
    const current = view();
    const problems = [...(loadProblem ? [loadProblem] : []), ...current.issues];
    problemsEl.textContent = problems.length ? `Замечания:\n${problems.join('\n')}` : '';
    problemsEl.hidden = !problems.length;
    listEl.replaceChildren();
    const rows = current.groups.flatMap((g) => g.rows);
    if (selected && !rows.some((r) => r.key === selected)) selected = null;
    for (const group of current.groups) {
      const head = el('h3', 'buttons-group', group.title);
      const add = el('button', 'buttons-add', 'Добавить') as HTMLButtonElement;
      add.type = 'button';
      add.disabled = group.place !== 'bar' && layer === 'workspace';
      add.addEventListener('click', () => addNew(group.place));
      head.append(add);
      listEl.append(head);
      group.rows.forEach((row, index) => listEl.append(rowNode(row, group.place === 'bar' ? index : -1)));
    }
    renderForm(rowOf(selected));
  }

  function rowNode(row: ButtonRow, index: number): HTMLElement {
    const node = el('div', `buttons-row${row.key === selected ? ' selected' : ''}${row.disabled ? ' off' : ''}${row.issue ? ' bad' : ''}`);
    node.tabIndex = 0;
    node.setAttribute('role', 'button');
    node.append(el('span', 'buttons-label', row.card && row.card !== row.label ? `${row.label} (${row.card})` : row.label));
    const marks = [LAYER_NAMES[row.origin], row.hotkey ? row.hotkey : '', row.disabled ? 'выключена' : '', row.hotkeyLostTo ? `сочетание отдано «${row.hotkeyLostTo}»` : '', row.replacedBy ? `заменена «${row.replacedBy}»` : '', row.replaces ? `вместо «${row.replaces}»` : '', row.readOnly ?? '', row.issue ?? ''].filter(Boolean);
    node.append(el('span', 'buttons-marks', marks.join(' · ')));
    if (index >= 0) {
      for (const [text, delta] of [['↑', -1], ['↓', 1]] as const) {
        const move = el('button', 'buttons-move', text) as HTMLButtonElement;
        move.type = 'button';
        move.title = delta < 0 ? 'Выше' : 'Ниже';
        move.addEventListener('click', (event) => {
          event.stopPropagation();
          selected = row.key;
          applyOp(moveButton(ctx(), index, index + delta));
        });
        node.append(move);
      }
    }
    const pick = (): void => {
      selected = row.key;
      render();
    };
    node.addEventListener('click', pick);
    node.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.target === node) pick();
    });
    return node;
  }

  function sourceNote(row: ButtonRow, field: RowField, reset: () => void): HTMLElement {
    const from = row.from[field];
    const note = el('span', 'buttons-from', from ? `из: ${LAYER_NAMES[from]}` : 'не задано');
    if (from === layer && row.origin !== layer && !row.readOnly) {
      const button = el('button', 'buttons-reset', 'сбросить') as HTMLButtonElement;
      button.type = 'button';
      button.addEventListener('click', reset);
      note.append(' ', button);
    }
    return note;
  }

  function field(name: string, input: HTMLElement, note?: HTMLElement): HTMLElement {
    const wrap = el('label', 'buttons-field');
    wrap.append(el('span', 'buttons-field-name', name), input);
    if (note) wrap.append(note);
    return wrap;
  }

  function textInput(value: string, readOnly: boolean, commit: (value: string) => void): HTMLInputElement {
    const input = el('input') as HTMLInputElement;
    input.type = 'text';
    input.value = value;
    input.readOnly = readOnly;
    input.addEventListener('change', () => commit(input.value));
    return input;
  }

  function renderForm(row: ButtonRow | undefined): void {
    formEl.replaceChildren();
    if (compose) {
      renderCompose(compose);
      return;
    }
    if (!row) {
      formEl.append(el('p', 'hint', 'Выберите кнопку слева или добавьте новую.'));
      return;
    }
    const locked = !!row.readOnly || (row.key.includes(':#'));
    if (row.kind === 'bar') renderBarForm(row, locked);
    else renderLaunchForm(row, locked);
  }

  function renderBarForm(row: ButtonRow, locked: boolean): void {
    const own = row.origin === layer;
    const patch = (fields: Parameters<typeof setFields>[2]): void => void applyOp(setFields(ctx(), row.label, fields));
    const reset = (name: RowField): void => void applyOp(resetField(ctx(), row.label, name));
    const label = textInput(row.label, locked || !own, (value) => {
      const next = value.trim();
      if (applyOp(renameButton(ctx(), row.label, next))) {
        selected = `bar:${next.toLowerCase()}`;
        render();
      }
    });
    formEl.append(field('Подпись', label, el('span', 'buttons-from', `${LAYER_NAMES[row.origin]}${own ? '' : ': подпись унаследованной кнопки не меняется'}`)));
    formEl.append(field('Текст', textInput(row.text, locked, (value) => patch({ text: value, submit: row.submit })), sourceNote(row, 'text', () => reset('text'))));
    const submit = el('input') as HTMLInputElement;
    submit.type = 'checkbox';
    submit.checked = row.submit;
    submit.disabled = locked;
    submit.addEventListener('change', () => patch({ submit: submit.checked }));
    formEl.append(field('Отправлять с Enter', submit, sourceNote(row, 'submit', () => reset('submit'))));
    formEl.append(field('Сочетание', textInput(row.hotkey ?? '', locked, (value) => patch({ hotkey: value.trim() || (row.hotkey ? null : undefined) })), sourceNote(row, 'hotkey', () => reset('hotkey'))));
    formEl.append(field('Описание', textInput(row.description ?? '', locked, (value) => patch({ description: value.trim() || undefined })), sourceNote(row, 'description', () => reset('description'))));
    if (row.hotkeyLostTo) {
      const back = el('button', '', `Вернуть сочетание этой кнопке (у «${row.hotkeyLostTo}» оно снимется)`) as HTMLButtonElement;
      back.type = 'button';
      back.addEventListener('click', () => void applyOp(giveBackHotkey(ctx(), row.label)));
      formEl.append(back);
    }
    const actions = el('div', 'buttons-actions');
    const act = (text: string, run: () => void): void => {
      const button = el('button', '', text) as HTMLButtonElement;
      button.type = 'button';
      button.disabled = locked;
      button.addEventListener('click', run);
      actions.append(button);
    };
    act(row.disabled ? 'Включить' : 'Выключить', () => void applyOp(setDisabled(ctx(), row.label, !row.disabled)));
    if (!own) {
      act('Заменить другой кнопкой…', () => {
        compose = { place: 'bar', replace: row.label, label: '', text: row.text, submit: row.submit };
        render();
      });
    } else {
      act('Удалить', () => void applyOp(removeButton(ctx(), row.label)));
    }
    formEl.append(actions);
  }

  function renderLaunchForm(row: ButtonRow, locked: boolean): void {
    const place = row.place as LaunchPlace;
    const custom = row.builtinId === undefined;
    formEl.append(field('Подпись', textInput(row.label, locked || !custom, (value) => void setPromptsFor(row, { label: value.trim() })), el('span', 'buttons-from', LAYER_NAMES[row.origin])));
    formEl.append(field('Промпт', textInput(row.text, locked, (value) => void setPromptsFor(row, { text: value })), sourceNote(row, 'text', () => setPrompts(setBuiltinPrompt(state.prompts, row.builtinId as never, null)))));
    formEl.append(field('Описание', textInput(row.description ?? '', locked, (value) => void setPromptsFor(row, { description: value.trim() || undefined }))));
    if (row.readOnly) formEl.append(el('p', 'hint', `Кнопки запуска сессий ${row.readOnly}.`));
    const actions = el('div', 'buttons-actions');
    if (custom && !locked) {
      const toggle = el('button', '', row.disabled ? 'Включить' : 'Выключить') as HTMLButtonElement;
      toggle.type = 'button';
      toggle.addEventListener('click', () => setPrompts(updateLaunchButton(state.prompts, place, row.label, { disabled: !row.disabled })));
      const remove = el('button', '', 'Удалить') as HTMLButtonElement;
      remove.type = 'button';
      remove.addEventListener('click', () => setPrompts(removeLaunchButton(state.prompts, place, row.label)));
      actions.append(toggle, remove);
    } else if (!locked && row.changed) {
      const back = el('button', '', 'Вернуть встроенный промпт') as HTMLButtonElement;
      back.type = 'button';
      back.addEventListener('click', () => setPrompts(setBuiltinPrompt(state.prompts, row.builtinId as never, null)));
      actions.append(back);
    }
    formEl.append(actions);
  }

  function setPromptsFor(row: ButtonRow, patch: { label?: string; text?: string; description?: string }): void {
    if (row.builtinId) {
      setPrompts(setBuiltinPrompt(state.prompts, row.builtinId, { ...(patch.text !== undefined ? { text: patch.text } : {}), ...('description' in patch ? { description: patch.description } : {}) }));
      return;
    }
    if (patch.label) selected = `${row.place}:${patch.label.toLowerCase()}`;
    setPrompts(updateLaunchButton(state.prompts, row.place as LaunchPlace, row.label, patch));
  }

  function addNew(place: ButtonRow['place'], draft?: { label: string; text: string; submit: boolean }): void {
    compose = { place, label: draft?.label ?? '', text: draft?.text ?? '', submit: draft?.submit ?? false };
    selected = null;
    render();
  }

  function renderCompose(form: NonNullable<typeof compose>): void {
    formEl.append(el('h3', '', form.replace ? `Заменить «${form.replace}»` : 'Новая кнопка'));
    formEl.append(field('Подпись', textInput(form.label, false, (value) => void (form.label = value.trim()))));
    formEl.append(field(form.place === 'bar' ? 'Текст' : 'Промпт', textInput(form.text, false, (value) => void (form.text = value))));
    if (form.place === 'bar') {
      const submit = el('input') as HTMLInputElement;
      submit.type = 'checkbox';
      submit.checked = form.submit;
      submit.addEventListener('change', () => void (form.submit = submit.checked));
      formEl.append(field('Отправлять с Enter', submit));
    }
    const create = el('button', 'primary', form.replace ? 'Заменить' : 'Создать') as HTMLButtonElement;
    create.id = 'buttons-compose-create';
    create.type = 'button';
    create.addEventListener('click', () => {
      const { place, label, text, submit, replace } = form;
      if (!label || !text) {
        showError('Нужны подпись и текст');
        return;
      }
      compose = null;
      if (place === 'bar') {
        const draft = { label, text, submit };
        const done = applyOp(replace ? replaceButton(ctx(), replace, { ...draft, hotkey: null }) : addButton(ctx(), draft));
        if (!done) compose = form;
        else selected = `bar:${label.toLowerCase()}`;
      } else {
        setPrompts(addLaunchButton(state.prompts, { place, label, text }));
        selected = `${place}:${label.toLowerCase()}`;
      }
      render();
    });
    const cancel = el('button', '', 'Отмена') as HTMLButtonElement;
    cancel.type = 'button';
    cancel.addEventListener('click', () => {
      compose = null;
      showError('');
      render();
    });
    const actions = el('div', 'buttons-actions');
    actions.append(create, cancel);
    formEl.append(actions);
  }

  async function save(): Promise<void> {
    showError('');
    saveButton.disabled = true;
    try {
      const entries = state.commands[layer];
      const reply = await api.saveButtons({
        scope: layer,
        commands: Array.isArray(entries) ? entries : [],
        ...(layer === 'global' && isRecord(state.prompts) ? { prompts: state.prompts } : layer === 'global' ? { prompts: {} } : {}),
        base,
      });
      if (reply.error) {
        showError(reply.error);
        return;
      }
      initial = draftText();
      dialog.close();
      deps.saved();
    } catch (error) {
      showError((error as Error).message);
    } finally {
      saveButton.disabled = false;
    }
  }

  async function switchLayer(next: FileLayer): Promise<void> {
    if (next === layer || !discardable()) return;
    layer = next;
    selected = null;
    compose = null;
    await load();
    render();
  }

  saveButton.addEventListener('click', () => void save());
  tabs.global.addEventListener('click', () => void switchLayer('global'));
  tabs.workspace.addEventListener('click', () => void switchLayer('workspace'));
  byId('buttons-cancel').addEventListener('click', () => {
    if (discardable()) dialog.close();
  });
  dialog.addEventListener('cancel', (event) => {
    if (!discardable()) event.preventDefault();
  });

  return {
    async open(request = {}): Promise<void> {
      if (dialog.open && !discardable()) return;
      layer = request.layer ?? layer;
      await load();
      compose = null;
      selected = request.label ? `${request.place ?? 'bar'}:${request.label.trim().toLowerCase()}` : null;
      if (!dialog.open) dialog.showModal();
      render();
      if (request.draft) addNew('bar', request.draft);
    },
    async refresh(): Promise<void> {
      if (!dialog.open || dirty()) return;
      await load();
      render();
    },
  };
}
