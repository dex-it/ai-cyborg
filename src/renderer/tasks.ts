import type { Project } from '../main/projects';
import type { Task, TaskRef, TasksResult } from '../main/trackers';
import { el } from './dom';
import { readChoice, readPref, writePref } from './prefs';
import type { PanelView } from './panel';
import { fetchTasks, keepSnapshotOnError, RefreshGate, snapshotStale, wireRefresh, type RefreshTrigger } from './task-flow';
import {
  availableLabels,
  cycleLabel,
  descriptionText,
  DescriptionStore,
  detailsLines,
  emptyView,
  filterByLabels,
  labelEmpty,
  labelInk,
  parseLabelFilter,
  requireLabel,
  serializeLabelFilter,
  SORT_OPTIONS,
  sortTasks,
  sourceLabel,
  statusText,
  type LabelFilter,
  type SortKey,
} from './task-model';

/** Сессия, начатая из задачи: панелю нужно знать только, жива ли она. */
export interface OpenTaskSession {
  exited: boolean;
}

/** Кнопка в строке задачи; новое действие - новый элемент массива. */
export interface TaskAction {
  id: string;
  label: (task: Task, open: OpenTaskSession | undefined) => string;
  run: (task: Task, anchor: HTMLElement) => void;
}

export interface TasksViewHost {
  project(): Project | null;
  /** Пояснение вместо панели, пока нет проекта с репозиториями; null - проект готов. */
  projectHint(): string[] | null;
  trackedRefs(): TaskRef[];
  applyStatuses(result: TasksResult): void;
  sessionOf(key: string): OpenTaskSession | undefined;
  startTask(task: Task, anchor: HTMLElement): void;
}

const api = window.cyborg;

export class TasksView implements PanelView {
  readonly element = el('div', 'panel-view');
  private readonly body = el('div', 'tasks-body');
  private readonly assigned = document.createElement('input');
  private readonly sort = document.createElement('select');
  private readonly reload = el('button', '', 'Обновить') as HTMLButtonElement;
  private readonly actions: TaskAction[];
  private readonly gate = new RefreshGate();
  private result: TasksResult | null = null;
  private snapshotAt: number | null = null;
  /** Когда фоновая выборка не удалась, а прежний снимок остался: повтор не раньше TTL. */
  private failedAt: number | null = null;
  /** Задачи последнего ответа: полоса меток не исчезает и не теряет цвета, пока идёт повторная загрузка. */
  private labelSource: Task[] = [];
  private sortKey: SortKey = 'updated';
  private readonly labelsBar = el('div', 'tasks-labels');
  private labelFilter: LabelFilter = new Map();
  private labelsProject: string | null = null;
  /** Ключи задач, чьи детали раскрыты: держатся при сортировке, фильтрах и «Обновить». */
  private readonly expanded = new Set<string>();
  private readonly descriptions = new DescriptionStore();
  private readonly openErrors = new Map<string, string>();

  constructor(private readonly host: TasksViewHost) {
    this.actions = [
      {
        id: 'start',
        label: (_task, open) => (open ? 'К сессии' : 'Начать'),
        run: (task, anchor) => host.startTask(task, anchor),
      },
    ];
    this.assigned.type = 'checkbox';
    this.assigned.checked = readChoice('cyborg.tasks.assigned', ['1', '0'], '1') === '1';
    this.assigned.addEventListener('change', () => writePref('cyborg.tasks.assigned', this.assigned.checked ? '1' : '0'));
    for (const option of SORT_OPTIONS) {
      const node = el('option', '', option.label) as HTMLOptionElement;
      node.value = option.key;
      this.sort.append(node);
    }
    this.sortKey = readChoice('cyborg.tasks.sort', SORT_OPTIONS.map((o) => o.key), this.sortKey);
    this.sort.value = this.sortKey;
    this.sort.addEventListener('change', () => {
      this.sortKey = this.sort.value as SortKey;
      writePref('cyborg.tasks.sort', this.sortKey);
      this.render();
    });
    wireRefresh({ filter: this.assigned, reload: this.reload }, (force, trigger) => this.refresh(force, trigger));
    const filter = el('label', 'tasks-filter');
    filter.append(this.assigned, document.createTextNode(' Назначено мне'));
    const sortLabel = el('label', 'tasks-filter');
    sortLabel.append(document.createTextNode('Сортировка '), this.sort);
    const header = el('header', 'tasks-header');
    header.append(el('h2', '', 'Задачи'), filter, sortLabel, el('span', 'spacer'), this.reload);
    this.element.replaceChildren(header, this.labelsBar, this.body);
  }

  onProjectChanged(): void {
    this.gate.cancel();
    this.result = null;
    this.snapshotAt = null;
    this.failedAt = null;
    this.labelSource = [];
    this.expanded.clear();
    this.openErrors.clear();
    this.descriptions.reset();
    this.labelsProject = null;
    this.render();
  }

  loadedAt(): number | null {
    return this.snapshotAt;
  }

  repaint(): void {
    this.render();
  }

  /** Загрузка без снимка на экране: до первого ответа и после смены фильтра или проекта. */
  private get blank(): boolean {
    return this.gate.loading && !this.result;
  }

  private labelsKey = (id: string): string => `cyborg.tasks.labels:${id}`;

  private ensureLabelFilter(): void {
    const id = this.host.project()?.id ?? null;
    if (id === this.labelsProject) return;
    this.labelsProject = id;
    this.labelFilter = id ? parseLabelFilter(readPref(this.labelsKey(id))) : new Map();
  }

  private setLabelFilter(filter: LabelFilter): void {
    this.labelFilter = filter;
    if (this.labelsProject) writePref(this.labelsKey(this.labelsProject), serializeLabelFilter(filter));
    this.render();
  }

  private labelChip(name: string, color: string | null, onClick: () => void): HTMLButtonElement {
    const chip = el('button', 'task-label', name) as HTMLButtonElement;
    const ink = labelInk(color);
    if (color && ink) {
      chip.style.backgroundColor = color;
      chip.style.color = ink;
    } else chip.classList.add('neutral');
    chip.title = name;
    chip.addEventListener('click', (event) => {
      event.stopPropagation();
      onClick();
    });
    return chip;
  }

  private renderLabelsBar(): void {
    const labels = availableLabels(this.labelSource, this.labelFilter);
    if (!labels.size) {
      this.labelsBar.replaceChildren();
      this.labelsBar.hidden = true;
      return;
    }
    this.labelsBar.hidden = false;
    const nodes: HTMLElement[] = [el('span', 'tasks-labels-title', 'Метки:')];
    for (const [name, color] of labels) {
      const mode = this.labelFilter.get(name);
      const chip = this.labelChip(name, color, () => this.setLabelFilter(cycleLabel(this.labelFilter, name)));
      chip.textContent = `${mode === '+' ? '+ ' : mode === '-' ? '− ' : ''}${name}`;
      chip.classList.toggle('on', mode === '+');
      chip.classList.toggle('off', mode === '-');
      chip.disabled = this.blank;
      nodes.push(chip);
    }
    if (this.labelFilter.size) nodes.push(this.clearButton());
    this.labelsBar.replaceChildren(...nodes);
  }

  private clearButton(): HTMLButtonElement {
    const clear = el('button', 'tasks-labels-clear', '✕') as HTMLButtonElement;
    clear.title = 'Сбросить фильтр меток';
    clear.disabled = this.blank;
    clear.addEventListener('click', () => this.setLabelFilter(new Map()));
    return clear;
  }

  private async openInBrowser(task: Task): Promise<void> {
    const res = await api.openTask({ kind: task.kind, host: task.host, path: task.path, number: task.number });
    if (res.error) {
      this.expanded.add(task.key);
      this.openErrors.set(task.key, `Браузер не открылся: ${res.error}`);
    } else this.openErrors.delete(task.key);
    this.render();
  }

  private toggle(key: string): void {
    if (this.expanded.delete(key)) this.render();
    else {
      this.expanded.add(key);
      this.descriptions.forgetError(key);
      this.render();
    }
  }

  private loadDescription(task: Task): void {
    const generation = this.descriptions.begin(task.key);
    if (generation === null) return;
    const selection = this.result?.selection;
    const request =
      selection === undefined
        ? Promise.resolve({ error: 'выборка задач неизвестна: нажмите «Обновить»' })
        : api.taskDetails(selection, { kind: task.kind, host: task.host, path: task.path, number: task.number });
    request
      .catch((error: Error) => ({ error: error.message }))
      .then((res) => {
        if (this.descriptions.finish(task.key, generation, res)) this.render();
      });
  }

  async refresh(force = false, trigger: RefreshTrigger = 'open'): Promise<void> {
    if (trigger === 'timer' && !snapshotStale(this.failedAt, Date.now())) return;
    const token = this.gate.begin(force);
    if (token === null) return;
    const project = this.host.project();
    // Фон, открытие и «Обновить» держат прежний снимок на экране до ответа; фильтр и проект - другой вопрос, снимок прежнего ответа неверен.
    if (trigger === 'filter' || trigger === 'project') {
      this.result = null;
      this.snapshotAt = null;
    }
    if (!project || this.host.projectHint()) {
      this.gate.cancel();
      this.render();
      return;
    }
    this.render();
    let result: TasksResult;
    try {
      result = await fetchTasks(api, project.id, this.assigned.checked, this.host.trackedRefs(), trigger);
    } catch (error) {
      result = { tasks: [], sources: [], tracked: [], enabled: { github: false, gitlab: false }, error: (error as Error).message };
    }
    if (!this.gate.finish(token)) return;
    if (keepSnapshotOnError(trigger, !!this.result && !this.result.error, result.error)) {
      this.failedAt = Date.now();
      this.render();
      return;
    }
    this.failedAt = null;
    this.result = result;
    this.snapshotAt = Date.now();
    // Описания привязаны к выборке ответа: «Обновить» сбрасывает их с приходом новой, а не до неё.
    if (trigger === 'reload') this.descriptions.reset();
    this.labelSource = result.tasks;
    this.host.applyStatuses(result);
    this.render();
  }

  private render(): void {
    this.reload.disabled = this.gate.loading;
    this.reload.textContent = this.gate.loading ? 'Обновление…' : 'Обновить';
    this.reload.title = this.snapshotAt === null ? '' : `Снимок от ${new Date(this.snapshotAt).toLocaleTimeString('ru')}`;
    this.ensureLabelFilter();
    this.renderLabelsBar();
    const hint = this.host.projectHint();
    if (hint || !this.host.project()) {
      this.body.replaceChildren(...(hint ?? ['Проекта нет.']).map((text) => el('p', 'tasks-note', text)));
      return;
    }
    const result = this.result;
    if (!result) {
      this.body.replaceChildren(el('p', 'tasks-note', 'Загрузка…'));
      return;
    }
    if (result.error) {
      this.body.replaceChildren(el('p', 'tasks-note', result.error));
      return;
    }
    const nodes: HTMLElement[] = [];
    for (const source of result.sources) {
      if (source.error) nodes.push(el('p', 'tasks-error', `${sourceLabel(source)}: ${source.error}`));
      else if (source.note) nodes.push(el('p', 'tasks-note small', `${sourceLabel(source)}: ${source.note}`));
    }
    switch (emptyView(result)) {
      case 'disabled':
        nodes.push(el('p', 'tasks-note', 'Источники задач проекта не включены.'));
        break;
      case 'no-remotes':
        nodes.push(el('p', 'tasks-note', 'У репозиториев проекта нет remote GitHub или GitLab, на который залогинен glab.'));
        break;
      case 'no-tasks':
        nodes.push(el('p', 'tasks-note', this.assigned.checked ? 'Открытых задач, назначенных вам, нет.' : 'Открытых задач нет.'));
        break;
      default:
        if (labelEmpty(result.tasks, this.labelFilter)) {
          const note = el('p', 'tasks-note', 'Нет задач под фильтр меток ');
          note.append(this.clearButton());
          nodes.push(note);
          break;
        }
        for (const task of sortTasks(filterByLabels(result.tasks, this.labelFilter), this.sortKey)) nodes.push(this.item(task));
    }
    this.body.replaceChildren(...nodes);
  }

  private item(task: Task): HTMLElement {
    const item = el('div', 'task-item');
    item.append(this.row(task));
    if (this.expanded.has(task.key)) {
      this.loadDescription(task);
      item.append(this.details(task));
    }
    return item;
  }

  private details(task: Task): HTMLElement {
    const box = el('div', 'task-details');
    for (const line of detailsLines(task)) box.append(el('div', 'task-details-line', line));
    const description = this.descriptions.get(task.key);
    if (!description || description.state === 'loading') box.append(el('div', 'task-details-line', 'Загрузка…'));
    else if (description.state === 'error') box.append(el('div', 'tasks-error', description.message));
    else box.append(el('div', 'task-description', descriptionText(description.text)));
    const openError = this.openErrors.get(task.key);
    if (openError) box.append(el('div', 'tasks-error', openError));
    return box;
  }

  private row(task: Task): HTMLElement {
    const open = this.host.sessionOf(task.key);
    const row = el('div', 'task-row');
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-expanded', String(this.expanded.has(task.key)));
    row.addEventListener('click', () => this.toggle(task.key));
    row.addEventListener('keydown', (event) => {
      if (event.target !== row || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      this.toggle(task.key);
    });
    const main = el('div', 'task-main');
    const title = el('div', 'task-title');
    const number = el('button', 'task-number', `#${task.number}`);
    number.title = 'Открыть в браузере';
    number.addEventListener('click', (event) => {
      event.stopPropagation();
      void this.openInBrowser(task);
    });
    title.append(number, el('span', '', ` ${task.title}`));
    title.title = task.title;
    const updated = Date.parse(task.updatedAt);
    main.append(
      title,
      el('div', 'task-meta', `${sourceLabel(task)} · ${statusText(task)}${Number.isNaN(updated) ? '' : ` · обновлена ${new Date(updated).toLocaleDateString('ru')}`}`),
    );
    if (task.labels.length) {
      const labels = el('div', 'task-labels');
      for (const { name, color } of task.labels) {
        labels.append(this.labelChip(name, color, () => this.setLabelFilter(requireLabel(this.labelFilter, name))));
      }
      main.append(labels);
    }
    const actions = el('div', 'task-actions');
    for (const action of this.actions) {
      const button = el('button', '', action.label(task, open)) as HTMLButtonElement;
      button.dataset.action = action.id;
      button.addEventListener('click', (event) => {
        // Меню выбора репозитория закрывается кликом по документу: клик по кнопке не должен закрыть его сразу.
        event.stopPropagation();
        action.run(task, button);
      });
      actions.append(button);
    }
    row.append(main, actions);
    return row;
  }
}
