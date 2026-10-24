import type { Project } from '../main/projects';
import type { Task, TaskRef, TasksResult } from '../main/trackers';
import { el } from './dom';
import { readChoice, writePref } from './prefs';
import type { PanelView } from './panel';
import { fetchTasks, RefreshGate, wireRefresh, type RefreshTrigger } from './task-flow';
import { emptyView, SORT_OPTIONS, sortTasks, sourceLabel, statusText, type SortKey } from './task-model';

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
  openSettings(): void;
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
  private sortKey: SortKey = 'updated';

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
    this.element.replaceChildren(header, this.body);
  }

  onProjectChanged(): void {
    this.gate.cancel();
    this.result = null;
    this.render();
  }

  async refresh(force = false, trigger: RefreshTrigger = 'open'): Promise<void> {
    const token = this.gate.begin(force);
    if (token === null) return;
    const project = this.host.project();
    this.result = null;
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
    this.result = result;
    this.host.applyStatuses(result);
    this.render();
  }

  private render(): void {
    for (const control of [this.assigned, this.sort, this.reload]) control.disabled = this.gate.loading;
    const hint = this.host.projectHint();
    if (hint || !this.host.project()) {
      this.body.replaceChildren(...(hint ?? ['Проекта нет.']).map((text) => el('p', 'tasks-note', text)));
      return;
    }
    const result = this.result;
    if (this.gate.loading || !result) {
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
      case 'disabled': {
        nodes.push(el('p', 'tasks-note', 'Источники задач не включены.'), el('p', 'tasks-note', '«⚙» слева вверху — включить GitHub или GitLab.'));
        const open = el('button', '', 'Открыть настройки');
        open.addEventListener('click', () => this.host.openSettings());
        nodes.push(open);
        break;
      }
      case 'no-remotes':
        nodes.push(el('p', 'tasks-note', 'У репозиториев проекта нет remote GitHub или GitLab, на который залогинен glab.'));
        break;
      case 'no-tasks':
        nodes.push(el('p', 'tasks-note', this.assigned.checked ? 'Открытых задач, назначенных вам, нет.' : 'Открытых задач нет.'));
        break;
      default:
        for (const task of sortTasks(result.tasks, this.sortKey)) nodes.push(this.row(task));
    }
    this.body.replaceChildren(...nodes);
  }

  private row(task: Task): HTMLElement {
    const open = this.host.sessionOf(task.key);
    const row = el('div', 'task-row');
    const main = el('div', 'task-main');
    const title = el('div', 'task-title');
    title.append(el('span', 'task-number', `#${task.number}`), el('span', '', ` ${task.title}`));
    title.title = task.title;
    const updated = Date.parse(task.updatedAt);
    main.append(
      title,
      el('div', 'task-meta', `${sourceLabel(task)} · ${statusText(task)}${Number.isNaN(updated) ? '' : ` · обновлена ${new Date(updated).toLocaleDateString('ru')}`}`),
    );
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
