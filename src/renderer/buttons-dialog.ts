// Окно «Кнопки»: одна форма на встроенные, общие и свои кнопки воркспейса (фича 12). Правки копятся в черновике, главный процесс проверяет и пишет слой целиком.

import {
  buttonsView,
  addLaunchButton,
  composeBar,
  giveBackHotkey,
  layerCtx,
  moveButton,
  patchAt,
  removeAt,
  removeButton,
  removeLaunchButton,
  renameButton,
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
import { BAR_PLACEHOLDERS, sameLabel, type ButtonIssue, type FileLayer } from '../main/commands';
import { PLACE_PLACEHOLDERS, type LaunchPlace } from '../main/prompts';
import { byId, el } from './dom';

const api = window.cyborg;

export interface ButtonsDialogDeps {
  mac: boolean;
  /** Кнопки записаны: полоса перечитывает файлы. */
  saved(): void;
  /** Кнопку (место:подпись) добавила или изменила сессия, и человек её ещё не видел. */
  isFresh(key: string): boolean;
  /** Человек открыл кнопку: пометка «новая» снимается. */
  seen(key: string): void;
}

export interface OpenRequest {
  layer?: FileLayer;
  place?: ButtonRow['place'];
  label?: string;
  /** Новая кнопка из предложенной моделью: подпись, текст, Enter. */
  draft?: { label: string; text: string; submit: boolean; description?: string };
}

export interface ButtonsDialog {
  open(request?: OpenRequest): Promise<void>;
  /** Файлы поменялись снаружи: открытое окно перечитывает их, при несохранённой правке - после подтверждения. */
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
  let compose: { place: ButtonRow['place']; replace?: string; label: string; text: string; submit: boolean; description: string; hotkey: string } | null = null;
  /** Отказы главного процесса при последнем сохранении: показываются у кнопки и поля, пока человек не правит. */
  let saveIssues: ButtonIssue[] = [];
  /** Строка, перетаскиваемая сейчас. */
  let dragFrom: number | null = null;
  /** Состояние файлов, от перечитывания которого человек уже отказался: заново об одном и том же не спрашиваем. */
  let declined = '';

  const draftText = (): string => JSON.stringify([state.commands[layer] ?? null, layer === 'global' ? (state.prompts ?? null) : null]);
  const dirty = (): boolean => dialog.open && draftText() !== initial;
  const discardable = (): boolean => !dirty() || confirm('Закрыть без сохранения?');
  const showError = (text: string): void => {
    errorEl.textContent = text;
    errorEl.hidden = !text;
  };

  interface Disk {
    config: Awaited<ReturnType<typeof api.loadCommands>>;
    prompts: Awaited<ReturnType<typeof api.loadPrompts>>;
    file: string | null;
  }
  const readDisk = async (): Promise<Disk> => {
    const [config, prompts, info] = await Promise.all([api.loadCommands(), api.loadPrompts(), api.workspaceInfo()]);
    return { config, prompts, file: info.file };
  };
  const baseOf = (disk: Disk, which: FileLayer): { commands: unknown; prompts?: unknown } => ({ commands: which === 'global' ? disk.config.global : disk.config.workspace, ...(which === 'global' ? { prompts: disk.prompts.raw } : {}) });

  function apply(disk: Disk): void {
    state.commands = { global: disk.config.global, workspace: disk.config.workspace };
    state.prompts = disk.prompts.raw;
    state.hasWorkspace = disk.file !== null;
    loadProblem = [disk.config.globalProblem, disk.prompts.problem].filter(Boolean).join('\n');
    if (!state.hasWorkspace && layer === 'workspace') layer = 'global';
    base = baseOf(disk, layer);
    initial = draftText();
    saveIssues = [];
    declined = '';
    showError('');
  }

  const load = async (): Promise<void> => apply(await readDisk());

  const ctx = () => layerCtx(state, layer);
  const view = () => buttonsView(state, layer);
  const rowOf = (key: string | null): ButtonRow | undefined => view().groups.flatMap((g) => g.rows).find((r) => r.key === key);

  /** Отказы сохранения, адресованные этой кнопке (и полю, если названо). */
  const issuesOf = (row: ButtonRow, field?: string): ButtonIssue[] =>
    saveIssues.filter((i) => (field === undefined || i.field === field) && ((row.rawIndex !== undefined && i.place === 'bar' && i.index === row.rawIndex) || (i.label !== undefined && i.place === row.place && sameLabel(i.label, row.label))));

  function select(key: string | null): void {
    selected = key;
    if (key) deps.seen(key);
  }

  function applyOp(result: OpResult): boolean {
    if (!result.ok) {
      showError(result.error);
      return false;
    }
    showError('');
    saveIssues = [];
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
    saveIssues = [];
    state.prompts = next;
    render();
  }

  function render(): void {
    for (const key of ['global', 'workspace'] as const) {
      tabs[key].setAttribute('aria-pressed', String(key === layer));
      (tabs[key] as HTMLButtonElement).disabled = key === 'workspace' && !state.hasWorkspace;
      if (key === 'workspace') tabs[key].title = state.hasWorkspace ? '' : 'Воркспейс не открыт';
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
      const add = el('button', 'buttons-add', '+ Кнопка') as HTMLButtonElement;
      add.type = 'button';
      add.disabled = group.place !== 'bar' && layer === 'workspace';
      add.addEventListener('click', () => addNew(group.place));
      head.append(add);
      head.dataset.place = group.place;
      listEl.append(head);
      group.rows.forEach((row, index) => listEl.append(rowNode(row, group.place === 'bar' && row.rawIndex === undefined ? index : -1)));
    }
    renderForm(rowOf(selected));
  }

  /** Подписи слоя у строки: откуда кнопка, изменена ли и выключена ли в каком слое. */
  function marksOf(row: ButtonRow): string[] {
    const here = layer === 'global' ? 'в общих' : 'здесь';
    const fromGlobal = row.kind === 'launch' && row.builtinId !== undefined && row.from.text === 'global';
    return [
      LAYER_NAMES[row.origin],
      row.hotkey ? row.hotkey : '',
      row.changed && row.origin !== layer && row.rawIndex === undefined ? `изменена ${here}` : fromGlobal && layer !== 'global' ? 'изменена в общих' : '',
      row.disabled ? (row.disabledIn ? `выключена ${row.disabledIn === layer ? here : 'в общих'}` : 'выключена') : '',
      row.hotkeyLostTo ? `сочетание отдано «${row.hotkeyLostTo}»` : '',
      row.replacedBy ? `заменена «${row.replacedBy}»` : '',
      row.replaces ? `вместо «${row.replaces}»` : '',
      row.readOnly ?? '',
      deps.isFresh(row.key) ? 'новая' : '',
      row.issue ?? '',
      ...issuesOf(row).map((i) => i.message),
    ].filter(Boolean);
  }

  function rowNode(row: ButtonRow, index: number): HTMLElement {
    const bad = row.issue || issuesOf(row).length;
    const node = el('div', `buttons-row${row.key === selected ? ' selected' : ''}${row.disabled ? ' off' : ''}${bad ? ' bad' : ''}`);
    node.tabIndex = 0;
    node.setAttribute('role', 'button');
    node.dataset.key = row.key;
    if (index >= 0) {
      const grip = el('span', 'buttons-grip', '⋮⋮');
      grip.title = 'Перетащить: порядок задаёт выбранный слой';
      node.append(grip);
      node.draggable = true;
      node.addEventListener('dragstart', (event) => {
        dragFrom = index;
        event.dataTransfer?.setData('text/plain', String(index));
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      });
      node.addEventListener('dragover', (event) => {
        if (dragFrom !== null) event.preventDefault();
      });
      node.addEventListener('drop', (event) => {
        event.preventDefault();
        const from = dragFrom;
        dragFrom = null;
        if (from !== null && from !== index) {
          select(row.key);
          applyOp(moveButton(ctx(), from, index));
        }
      });
      node.addEventListener('dragend', () => void (dragFrom = null));
    }
    node.append(el('span', 'buttons-label', row.card && row.card !== row.label ? `${row.label} (${row.card})` : row.label));
    node.append(el('span', 'buttons-marks', marksOf(row).join(' · ')));
    if (index >= 0) {
      for (const [text, delta] of [['↑', -1], ['↓', 1]] as const) {
        const move = el('button', 'buttons-move', text) as HTMLButtonElement;
        move.type = 'button';
        move.title = delta < 0 ? 'Выше' : 'Ниже';
        move.addEventListener('click', (event) => {
          event.stopPropagation();
          select(row.key);
          applyOp(moveButton(ctx(), index, index + delta));
        });
        node.append(move);
      }
    }
    const pick = (): void => {
      select(row.key);
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

  /** Отказ сохранения у поля: текст причины под ним. */
  const fieldIssue = (row: ButtonRow, field: string): HTMLElement[] => issuesOf(row, field).map((i) => el('span', 'buttons-field-error', i.message));

  function field(name: string, input: HTMLElement, ...notes: (HTMLElement | undefined)[]): HTMLElement {
    const wrap = el('label', 'buttons-field');
    wrap.append(el('span', 'buttons-field-name', name), input);
    for (const note of notes) if (note) wrap.append(note);
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

  /** Поле промпта: строка и под ней подстановки своего места, щелчок вставляет подстановку в позицию курсора. */
  function promptInput(value: string, readOnly: boolean, place: ButtonRow['place'], commit: (value: string) => void): HTMLElement {
    const input = textInput(value, readOnly, commit);
    const names = place === 'bar' ? BAR_PLACEHOLDERS : PLACE_PLACEHOLDERS[place as LaunchPlace];
    const box = el('div', 'buttons-prompt');
    box.append(input);
    if (!readOnly) {
      const chips = el('div', 'buttons-chips');
      for (const name of names) {
        const chip = el('button', 'buttons-chip', `{${name}}`) as HTMLButtonElement;
        chip.type = 'button';
        chip.title = `Вставить {${name}} в позицию курсора`;
        // Фокус остаётся в поле: иначе позиция курсора теряется раньше щелчка.
        chip.addEventListener('mousedown', (event) => event.preventDefault());
        chip.addEventListener('click', () => {
          const from = input.selectionStart ?? input.value.length;
          const to = input.selectionEnd ?? from;
          input.value = `${input.value.slice(0, from)}{${name}}${input.value.slice(to)}`;
          const caret = from + name.length + 2;
          input.setSelectionRange(caret, caret);
          commit(input.value);
        });
        chips.append(chip);
      }
      box.append(chips);
    }
    return box;
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
    if (row.rawIndex !== undefined) renderRawForm(row);
    else if (row.kind === 'bar') renderBarForm(row, !!row.readOnly);
    else renderLaunchForm(row, !!row.readOnly);
  }

  /** Негодная запись файла: поля как записаны, поправить их либо удалить запись целиком. */
  function renderRawForm(row: ButtonRow): void {
    const index = row.rawIndex as number;
    formEl.append(el('p', 'buttons-field-error', row.issue ?? 'Запись негодна'));
    const edit = (patch: Record<string, unknown>): void => {
      if (applyOp(patchAt(ctx(), index, patch)) && typeof patch.label === 'string') select(`bar:${patch.label.trim().toLowerCase()}`);
      render();
    };
    formEl.append(field('Подпись', textInput(row.label, false, (value) => edit({ label: value.trim() || undefined }))));
    formEl.append(field('Текст', promptInput(row.text, false, 'bar', (value) => edit({ text: value.trim() || undefined }))));
    const submit = el('input') as HTMLInputElement;
    submit.type = 'checkbox';
    submit.checked = row.submit;
    submit.addEventListener('change', () => edit({ submit: submit.checked }));
    formEl.append(field('Отправлять с Enter', submit));
    formEl.append(field('Сочетание', textInput(row.hotkey ?? '', false, (value) => edit({ hotkey: value.trim() || undefined }))));
    formEl.append(field('Описание', textInput(row.description ?? '', false, (value) => edit({ description: value.trim() || undefined }))));
    const remove = el('button', '', 'Удалить запись') as HTMLButtonElement;
    remove.type = 'button';
    remove.addEventListener('click', () => void applyOp(removeAt(ctx(), index)));
    const actions = el('div', 'buttons-actions');
    actions.append(remove);
    formEl.append(actions);
  }

  function renderBarForm(row: ButtonRow, locked: boolean): void {
    const own = row.origin === layer;
    const patch = (fields: Parameters<typeof setFields>[2]): void => void applyOp(setFields(ctx(), row.label, fields));
    const reset = (name: RowField): void => void applyOp(resetField(ctx(), row.label, name));
    const label = textInput(row.label, locked || !own, (value) => {
      const next = value.trim();
      if (applyOp(renameButton(ctx(), row.label, next))) {
        select(`bar:${next.toLowerCase()}`);
        render();
      }
    });
    formEl.append(field('Подпись', label, el('span', 'buttons-from', `${LAYER_NAMES[row.origin]}${own ? '' : ': подпись унаследованной кнопки не меняется'}`), ...fieldIssue(row, 'label')));
    formEl.append(field('Текст', promptInput(row.text, locked, 'bar', (value) => patch({ text: value, submit: row.submit })), sourceNote(row, 'text', () => reset('text')), ...fieldIssue(row, 'text')));
    const submit = el('input') as HTMLInputElement;
    submit.type = 'checkbox';
    submit.checked = row.submit;
    submit.disabled = locked;
    submit.addEventListener('change', () => patch({ submit: submit.checked }));
    formEl.append(field('Отправлять с Enter', submit, sourceNote(row, 'submit', () => reset('submit')), ...fieldIssue(row, 'submit')));
    formEl.append(field('Сочетание', textInput(row.hotkey ?? '', locked, (value) => patch({ hotkey: value.trim() || (row.hotkey ? null : undefined) })), sourceNote(row, 'hotkey', () => reset('hotkey')), ...fieldIssue(row, 'hotkey')));
    formEl.append(field('Описание', textInput(row.description ?? '', locked, (value) => patch({ description: value.trim() || undefined })), sourceNote(row, 'description', () => reset('description')), ...fieldIssue(row, 'description')));
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
        compose = { place: 'bar', replace: row.label, label: '', text: row.text, submit: row.submit, description: '', hotkey: '' };
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
    formEl.append(field('Подпись', textInput(row.label, locked || !custom, (value) => void setPromptsFor(row, { label: value.trim() })), el('span', 'buttons-from', LAYER_NAMES[row.origin]), ...fieldIssue(row, 'label')));
    formEl.append(field('Промпт', promptInput(row.text, locked, row.place, (value) => void setPromptsFor(row, { text: value })), sourceNote(row, 'text', () => setPrompts(setBuiltinPrompt(state.prompts, row.builtinId as never, null))), ...fieldIssue(row, 'text')));
    formEl.append(field('Описание', textInput(row.description ?? '', locked, (value) => void setPromptsFor(row, { description: value.trim() || undefined })), ...fieldIssue(row, 'description')));
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
    if (patch.label) select(`${row.place}:${patch.label.toLowerCase()}`);
    setPrompts(updateLaunchButton(state.prompts, row.place as LaunchPlace, row.label, patch));
  }

  function addNew(place: ButtonRow['place'], draft?: { label: string; text: string; submit: boolean; description?: string }): void {
    compose = { place, label: draft?.label ?? '', text: draft?.text ?? '', submit: draft?.submit ?? false, description: draft?.description ?? '', hotkey: '' };
    select(null);
    render();
  }

  function renderCompose(form: NonNullable<typeof compose>): void {
    formEl.append(el('h3', '', form.replace ? `Заменить «${form.replace}»` : 'Новая кнопка'));
    formEl.append(field('Подпись', textInput(form.label, false, (value) => void (form.label = value.trim()))));
    formEl.append(field(form.place === 'bar' ? 'Текст' : 'Промпт', promptInput(form.text, false, form.place, (value) => void (form.text = value))));
    if (form.place === 'bar') {
      const submit = el('input') as HTMLInputElement;
      submit.type = 'checkbox';
      submit.checked = form.submit;
      submit.addEventListener('change', () => void (form.submit = submit.checked));
      formEl.append(field('Отправлять с Enter', submit));
      formEl.append(field('Сочетание', textInput(form.hotkey, false, (value) => void (form.hotkey = value.trim())), el('span', 'buttons-from', form.replace ? 'пусто - сочетание заменяемой кнопки' : 'можно не задавать')));
    }
    formEl.append(field('Описание', textInput(form.description, false, (value) => void (form.description = value.trim()))));
    const create = el('button', 'primary', form.replace ? 'Заменить' : 'Создать') as HTMLButtonElement;
    create.id = 'buttons-compose-create';
    create.type = 'button';
    create.addEventListener('click', () => {
      const { place, label, text, submit, replace, description, hotkey } = form;
      if (!label || !text) {
        showError('Нужны подпись и текст');
        return;
      }
      compose = null;
      if (place === 'bar') {
        const done = applyOp(composeBar(ctx(), { label, text, submit, ...(description ? { description } : {}), ...(hotkey ? { hotkey } : {}), ...(replace ? { replace } : {}) }));
        if (!done) compose = form;
        else select(`bar:${label.toLowerCase()}`);
      } else {
        setPrompts(addLaunchButton(state.prompts, { place, label, text, ...(description ? { description } : {}) }));
        select(`${place}:${label.toLowerCase()}`);
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
        saveIssues = reply.issues ?? [];
        const first = saveIssues.length ? view().groups.flatMap((g) => g.rows).find((r) => issuesOf(r).length > 0) : undefined;
        if (first) selected = first.key;
        compose = null;
        render();
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
      selected = null;
      if (request.label) select(`${request.place ?? 'bar'}:${request.label.trim().toLowerCase()}`);
      if (!dialog.open) dialog.showModal();
      render();
      if (request.place && !request.label && !request.draft) listEl.querySelector(`[data-place="${request.place}"]`)?.scrollIntoView?.({ block: 'start' });
      if (request.draft) addNew('bar', request.draft);
    },
    async refresh(): Promise<void> {
      if (!dialog.open) return;
      const disk = await readDisk();
      const onDisk = JSON.stringify(baseOf(disk, layer));
      if (onDisk === JSON.stringify(base)) {
        declined = '';
        return;
      }
      if (dirty()) {
        if (onDisk === declined) return;
        if (!confirm('Кнопки изменились снаружи. Перечитать их и потерять несохранённую правку?')) {
          declined = onDisk;
          return;
        }
      }
      apply(disk);
      render();
    },
  };
}
