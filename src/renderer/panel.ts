import { byId, el } from './dom';
import { MrsView, type MrsViewHost } from './mrs';
import type { RefreshTrigger } from './task-flow';
import { TasksView, type TasksViewHost } from './tasks';

/** Вид внутри панели: свой заголовок и список, обновление запрашивает панель. */
export interface PanelView {
  element: HTMLElement;
  /** trigger 'reload' - «Обновить»: вход в трекеры проверяется заново. */
  refresh(force?: boolean, trigger?: RefreshTrigger): Promise<void>;
  onProjectChanged(): void;
}

type Tab = 'tasks' | 'mrs';

const TABS: { id: Tab; label: string }[] = [
  { id: 'tasks', label: 'Задачи' },
  { id: 'mrs', label: 'MR/PR' },
];

export interface TrackerPanelHosts {
  tasks: TasksViewHost;
  mrs: MrsViewHost;
  onClosed(): void;
}

/** Панель трекеров: кнопка «Задачи» открывает её, вкладки переключают виды. Выбранная вкладка живёт до перезапуска. */
export class TrackerPanel {
  private readonly root = byId('tasks-panel');
  private readonly toggle = byId<HTMLButtonElement>('tasks-toggle');
  private readonly sessionsEl = byId('sessions');
  private readonly nav = el('nav', 'panel-tabs');
  private readonly views: Record<Tab, PanelView>;
  private readonly buttons = new Map<Tab, HTMLButtonElement>();
  private tab: Tab = 'tasks';
  private opened = false;

  constructor(private readonly hosts: TrackerPanelHosts) {
    this.views = { tasks: new TasksView(hosts.tasks), mrs: new MrsView(hosts.mrs) };
    for (const { id, label } of TABS) {
      const button = el('button', 'panel-tab', label) as HTMLButtonElement;
      button.addEventListener('click', () => this.select(id));
      this.buttons.set(id, button);
      this.nav.append(button);
    }
    this.mount();
    this.toggle.addEventListener('click', () => (this.opened ? this.close() : this.open()));
  }

  get isOpen(): boolean {
    return this.opened;
  }

  private get view(): PanelView {
    return this.views[this.tab];
  }

  private mount(): void {
    for (const [id, button] of this.buttons) button.classList.toggle('active', id === this.tab);
    this.root.replaceChildren(this.nav, this.view.element);
  }

  private select(tab: Tab): void {
    if (tab === this.tab) return;
    this.tab = tab;
    this.mount();
    void this.view.refresh(false, 'tab');
  }

  open(): void {
    this.opened = true;
    this.root.hidden = false;
    this.sessionsEl.classList.add('tasks-open');
    this.toggle.classList.add('active');
    void this.view.refresh(false, 'open');
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.root.hidden = true;
    this.sessionsEl.classList.remove('tasks-open');
    this.toggle.classList.remove('active');
    this.hosts.onClosed();
  }

  onProjectChanged(): void {
    for (const view of Object.values(this.views)) view.onProjectChanged();
    // Смена проекта - новый вопрос: идёт в обход флага загрузки, ответ прежнего отбросит токен.
    if (this.opened) void this.view.refresh(true, 'project');
  }

  refreshActive(force = false): Promise<void> {
    return this.view.refresh(force, 'open');
  }
}
