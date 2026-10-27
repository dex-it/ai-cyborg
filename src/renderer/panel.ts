import { byId } from './dom';
import { MrsView, type MrsViewHost } from './mrs';
import { refreshOnPanelEvent, SNAPSHOT_TICK_MS, snapshotStale, type PanelEvent, type RefreshTrigger } from './task-flow';
import { TasksView, type TasksViewHost } from './tasks';

/** Вид внутри панели: свой заголовок и список, обновление запрашивает панель. */
export interface PanelView {
  element: HTMLElement;
  /** trigger 'reload' - «Обновить»: вход в трекеры проверяется заново. */
  refresh(force?: boolean, trigger?: RefreshTrigger): Promise<void>;
  onProjectChanged(): void;
  /** Время снимка текущего проекта; null - снимка нет. */
  loadedAt(): number | null;
  /** Перерисовать снимок без выборки: сессии задач могли открыться или закрыться. */
  repaint(): void;
}

type Tab = 'tasks' | 'mrs';

const TOGGLES: Record<Tab, string> = { tasks: 'tasks-toggle', mrs: 'mrs-toggle' };

export interface TrackerPanelHosts {
  tasks: TasksViewHost;
  mrs: MrsViewHost;
  onClosed(): void;
}

/**
 * Панель трекеров: кнопки «Задачи» и «MR/PR» полосы сессий открывают каждая свой вид, повторный клик закрывает. Выбранный вид живёт до перезапуска.
 * Вид показывает снимок; уже загруженный снимок обновляется в фоне по устареванию, а не при каждом открытии.
 */
export class TrackerPanel {
  private readonly root = byId('tasks-panel');
  private readonly sessionsEl = byId('sessions');
  private readonly views: Record<Tab, PanelView>;
  private readonly buttons = new Map<Tab, HTMLButtonElement>();
  private tab: Tab = 'tasks';
  private opened = false;

  constructor(private readonly hosts: TrackerPanelHosts) {
    this.views = { tasks: new TasksView(hosts.tasks), mrs: new MrsView(hosts.mrs) };
    for (const [id, buttonId] of Object.entries(TOGGLES) as [Tab, string][]) {
      const button = byId<HTMLButtonElement>(buttonId);
      button.addEventListener('click', () => this.press(id));
      this.buttons.set(id, button);
    }
    this.mount();
    window.setInterval(() => this.tick(), SNAPSHOT_TICK_MS);
  }

  /** Фон обновляет только виды, которые уже смотрели в этом проекте: нетронутый вид трекеры не опрашивает. */
  private tick(): void {
    if (document.hidden) return;
    const now = Date.now();
    for (const view of Object.values(this.views)) {
      const at = view.loadedAt();
      if (at !== null && snapshotStale(at, now)) void view.refresh(false, 'timer');
    }
  }

  private panelEvent(event: PanelEvent): void {
    void refreshOnPanelEvent((force, trigger) => this.view.refresh(force, trigger), event, this.view.loadedAt());
  }

  get isOpen(): boolean {
    return this.opened;
  }

  private get view(): PanelView {
    return this.views[this.tab];
  }

  private mount(): void {
    this.markButtons();
    this.root.replaceChildren(this.view.element);
  }

  private markButtons(): void {
    for (const [id, button] of this.buttons) button.classList.toggle('active', this.opened && id === this.tab);
  }

  private press(tab: Tab): void {
    if (!this.opened) {
      if (tab !== this.tab) {
        this.tab = tab;
        this.mount();
      }
      this.open();
    } else if (tab === this.tab) this.close();
    else this.select(tab);
  }

  private select(tab: Tab): void {
    this.tab = tab;
    this.mount();
    this.view.repaint();
    this.panelEvent('tab');
  }

  open(): void {
    this.opened = true;
    this.root.hidden = false;
    this.sessionsEl.classList.add('tasks-open');
    this.markButtons();
    this.view.repaint();
    this.panelEvent('open');
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.root.hidden = true;
    this.sessionsEl.classList.remove('tasks-open');
    this.markButtons();
    this.hosts.onClosed();
  }

  /** Кнопки есть, только когда у выбранного проекта включён источник; без него открытая панель закрывается. */
  setAvailable(available: boolean): void {
    for (const button of this.buttons.values()) button.hidden = !available;
    if (!available) this.close();
  }

  onProjectChanged(): void {
    for (const view of Object.values(this.views)) view.onProjectChanged();
    // Смена проекта - новый вопрос: идёт в обход флага загрузки, ответ прежнего отбросит токен.
    if (this.opened) this.panelEvent('project');
  }

  repaint(): void {
    if (this.opened) this.view.repaint();
  }
}
