import type { Project } from '../main/projects';
import type { Task, TaskRef, TasksResult } from '../main/trackers';
import { byId, el } from './dom';
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

export interface TasksPanelHost {
  project(): Project | null;
  /** Пояснение вместо панели, пока нет проекта с репозиториями; null - проект готов. */
  projectHint(): string[] | null;
  trackedRefs(): TaskRef[];
  applyStatuses(result: TasksResult): void;
  sessionOf(key: string): OpenTaskSession | undefined;
  startTask(task: Task, anchor: HTMLElement): void;
  openSettings(): void;
  onClosed(): void;
}

const api = window.cyborg;

export class TasksPanel {
  private readonly root = byId('tasks-panel');
  private readonly toggle = byId<HTMLButtonElement>('tasks-toggle');
  private readonly sessionsEl = byId('sessions');
  private readonly body = el('div', 'tasks-body');
  private readonly assigned = document.createElement('input');
  private readonly sort = document.createElement('select');
  private readonly reload = el('button', '', 'Обновить') as HTMLButtonElement;
  private readonly actions: TaskAction[];
  private opened = false;
  private loading = false;
  private token = 0;
  private result: TasksResult | null = null;
  private sortKey: SortKey = 'updated';

  constructor(private readonly host: TasksPanelHost) {
    this.actions = [
      {
        id: 'start',
        label: (_task, open) => (open ? 'К сессии' : 'Начать'),
        run: (task, anchor) => host.startTask(task, anchor),
      },
    ];
    this.assigned.type = 'checkbox';
    this.assigned.checked = true;
    this.assigned.addEventListener('change', () => void this.refresh());
    for (const option of SORT_OPTIONS) {
      const node = el('option', '', option.label) as HTMLOptionElement;
      node.value = option.key;
      this.sort.append(node);
    }
    this.sort.addEventListener('change', () => {
      this.sortKey = this.sort.value as SortKey;
      this.render();
    });
    this.reload.addEventListener('click', () => void this.refresh());
    const filter = el('label', 'tasks-filter');
    filter.append(this.assigned, document.createTextNode(' Назначено мне'));
    const sortLabel = el('label', 'tasks-filter');
    sortLabel.append(document.createTextNode('Сортировка '), this.sort);
    const header = el('header', 'tasks-header');
    header.append(el('h2', '', 'Задачи'), filter, sortLabel, el('span', 'spacer'), this.reload);
    this.root.replaceChildren(header, this.body);
    this.toggle.addEventListener('click', () => (this.opened ? this.close() : this.open()));
  }

  get isOpen(): boolean {
    return this.opened;
  }

  open(): void {
    this.opened = true;
    this.root.hidden = false;
    this.sessionsEl.classList.add('tasks-open');
    this.toggle.classList.add('active');
    void this.refresh();
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.root.hidden = true;
    this.sessionsEl.classList.remove('tasks-open');
    this.toggle.classList.remove('active');
    this.host.onClosed();
  }

  onProjectChanged(): void {
    this.result = null;
    // Смена проекта - новый вопрос: идёт в обход флага загрузки, ответ прежнего отбросит токен.
    if (this.opened) void this.refresh(true);
  }

  async refresh(force = false): Promise<void> {
    if (this.loading && !force) return;
    const token = ++this.token;
    const project = this.host.project();
    this.result = null;
    if (!project || this.host.projectHint()) {
      this.loading = false;
      this.render();
      return;
    }
    this.loading = true;
    this.render();
    let result: TasksResult;
    try {
      result = await api.listTasks(project.id, this.assigned.checked, this.host.trackedRefs());
    } catch (error) {
      result = { tasks: [], sources: [], tracked: [], enabled: { github: false, gitlab: false }, error: (error as Error).message };
    }
    if (token !== this.token) return;
    this.loading = false;
    this.result = result;
    this.host.applyStatuses(result);
    this.render();
  }

  private render(): void {
    for (const control of [this.assigned, this.sort, this.reload]) control.disabled = this.loading;
    const hint = this.host.projectHint();
    if (hint || !this.host.project()) {
      this.body.replaceChildren(...(hint ?? ['Проекта нет.']).map((text) => el('p', 'tasks-note', text)));
      return;
    }
    const result = this.result;
    if (this.loading || !result) {
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
