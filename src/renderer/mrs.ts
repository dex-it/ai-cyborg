import type { Mr, MrFilter, MrIntent, MrListResult, MrRef } from '../main/mrs';
import type { Project } from '../main/projects';
import { el } from './dom';
import { MR_FILTER_OPTIONS, MR_SORT_OPTIONS, MrMetaSlots, mrActionLabel, mrEmptyView, mrIntent, mrMeta, mrNumber } from './mr-model';
import { refreshMrs } from './mr-refresh';
import type { PanelView } from './panel';
import { RefreshGate, wireRefresh, type RefreshTrigger } from './task-flow';
import { sortByKey, sourceLabel, type SortKey } from './task-model';

/** Сессия, начатая из MR: панелю нужно знать только, жива ли она. */
export interface OpenMrSession {
  exited: boolean;
}

/** Кнопка в строке MR; новое действие - новый элемент массива. */
export interface MrAction {
  id: string;
  label: (mr: Mr, open: OpenMrSession | undefined) => string;
  run: (mr: Mr, anchor: HTMLElement) => void;
}

export interface MrsViewHost {
  project(): Project | null;
  /** Пояснение вместо панели, пока нет проекта с репозиториями; null - проект готов. */
  projectHint(): string[] | null;
  trackedRefs(): MrRef[];
  applyStatuses(result: MrListResult): void;
  sessionOf(key: string): OpenMrSession | undefined;
  startMr(mr: Mr, intent: MrIntent, anchor: HTMLElement): void;
  openSettings(): void;
}

const api = window.cyborg;

export class MrsView implements PanelView {
  readonly element = el('div', 'panel-view');
  private readonly body = el('div', 'tasks-body');
  private readonly filter = document.createElement('select');
  private readonly sort = document.createElement('select');
  private readonly reload = el('button', '', 'Обновить') as HTMLButtonElement;
  private readonly actions: MrAction[];
  private readonly gate = new RefreshGate();
  private result: MrListResult | null = null;
  private sortKey: SortKey = 'updated';
  /** Ключи MR, чьи пайплайн и апрувы ещё не пришли: в строке «…». */
  private pending = new Set<string>();
  private readonly metas = new MrMetaSlots();

  constructor(private readonly host: MrsViewHost) {
    this.actions = [
      {
        id: 'start',
        label: (mr, open) => (open ? 'К сессии' : mrActionLabel(mr)),
        run: (mr, anchor) => host.startMr(mr, mrIntent(mr), anchor),
      },
    ];
    const fill = (select: HTMLSelectElement, options: { key: string; label: string }[]) => {
      for (const option of options) {
        const node = el('option', '', option.label) as HTMLOptionElement;
        node.value = option.key;
        select.append(node);
      }
    };
    fill(this.filter, MR_FILTER_OPTIONS);
    fill(this.sort, MR_SORT_OPTIONS);
    this.sort.addEventListener('change', () => {
      this.sortKey = this.sort.value as SortKey;
      this.render();
    });
    wireRefresh({ filter: this.filter, reload: this.reload }, (force, trigger) => this.refresh(force, trigger));
    const filterLabel = el('label', 'tasks-filter');
    filterLabel.append(document.createTextNode('Показать '), this.filter);
    const sortLabel = el('label', 'tasks-filter');
    sortLabel.append(document.createTextNode('Сортировка '), this.sort);
    const header = el('header', 'tasks-header');
    header.append(el('h2', '', 'MR/PR'), filterLabel, sortLabel, el('span', 'spacer'), this.reload);
    this.element.replaceChildren(header, this.body);
  }

  onProjectChanged(): void {
    this.gate.cancel();
    this.result = null;
    this.pending.clear();
    this.render();
  }

  async refresh(force = false, trigger: RefreshTrigger = 'open'): Promise<void> {
    const token = this.gate.begin(force);
    if (token === null) return;
    const project = this.host.project();
    this.result = null;
    this.pending.clear();
    if (!project || this.host.projectHint()) {
      this.gate.cancel();
      this.render();
      return;
    }
    this.render();
    await refreshMrs(api, this.gate, token, { projectId: project.id, filter: this.filter.value as MrFilter, tracked: this.host.trackedRefs(), trigger }, {
      listed: (list, pending) => {
        this.result = list;
        this.pending = pending;
        this.host.applyStatuses(list);
        this.render();
      },
      detailed: (result) => {
        this.result = result;
        this.pending.clear();
        this.host.applyStatuses(result);
        this.metas.fill(result);
      },
    });
  }

  private render(): void {
    for (const control of [this.filter, this.sort, this.reload]) control.disabled = this.gate.loading;
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
    this.metas.clear();
    const nodes: HTMLElement[] = [];
    for (const source of result.sources) {
      if (source.error) nodes.push(el('p', 'tasks-error', `${sourceLabel(source)}: ${source.error}`));
    }
    switch (mrEmptyView(result)) {
      case 'disabled': {
        nodes.push(el('p', 'tasks-note', 'Источники не включены.'), el('p', 'tasks-note', '«⚙» слева вверху — включить GitHub или GitLab.'));
        const open = el('button', '', 'Открыть настройки');
        open.addEventListener('click', () => this.host.openSettings());
        nodes.push(open);
        break;
      }
      case 'no-remotes':
        nodes.push(el('p', 'tasks-note', 'У репозиториев проекта нет remote GitHub или GitLab, на который залогинен glab.'));
        break;
      case 'no-mrs':
        nodes.push(el('p', 'tasks-note', this.filter.value === 'all' ? 'Открытых MR нет' : 'Открытых MR по фильтру нет'));
        break;
      default:
        for (const mr of sortByKey(result.mrs, this.sortKey)) nodes.push(this.row(mr));
    }
    this.body.replaceChildren(...nodes);
  }

  private row(mr: Mr): HTMLElement {
    const open = this.host.sessionOf(mr.key);
    const row = el('div', 'task-row');
    const main = el('div', 'task-main');
    const title = el('div', 'task-title');
    title.append(el('span', 'task-number', mrNumber(mr.kind, mr.number)), el('span', '', ` ${mr.title}`));
    title.title = mr.title;
    const meta = this.metas.register(mr.key, el('div', 'task-meta', mrMeta(mr, this.pending.has(mr.key))));
    meta.title = `${sourceLabel(mr)}\n${mr.url}`;
    main.append(title, meta);
    const actions = el('div', 'task-actions');
    for (const action of this.actions) {
      const button = el('button', '', action.label(mr, open)) as HTMLButtonElement;
      button.dataset.action = action.id;
      button.addEventListener('click', (event) => {
        // Меню выбора репозитория закрывается кликом по документу: клик по кнопке не должен закрыть его сразу.
        event.stopPropagation();
        action.run(mr, button);
      });
      actions.append(button);
    }
    row.append(main, actions);
    return row;
  }
}

