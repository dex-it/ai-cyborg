/** Кнопка «Статус» полосы сессий и её карточка (FR-11002..FR-11009): Jira, мои MR/PR и MR на ревью проекта с итоговым индикатором. */

import type { JiraDetailsResult, JiraIssue, JiraListResult } from '../main/jira';
import type { Mr, MrIntent, MrListResult } from '../main/mrs';
import type { Project } from '../main/projects';
import { ago } from './ago';
import { byId, el } from './dom';
import { applyMrDetails, mrNumber } from './mr-model';
import { attentionOf, ATTENTION_TEXT, groupIssues, jiraTime, levelOf, LEVEL_TEXT, mrsOfIssue, pipelineTone, usable, type Attention, type Level } from './status-model';

const api = window.cyborg;

/** Как часто данные обновляются сами, пока окно на виду (D-06 фичи 11), и насколько свежими открывается карточка. */
export const REFRESH_MS = 5 * 60_000;
const FRESH_MS = 60_000;

export interface StatusHost {
  project(): Project | null;
  /** Открытая сессия по ключу MR либо `jira:KEY`: кнопка тогда ведёт к ней. */
  sessionOf(key: string): { exited: boolean } | undefined;
  startMr(mr: Mr, intent: MrIntent, anchor: HTMLElement): void;
  startJira(issue: JiraIssue, linked: Mr | undefined, anchor: HTMLElement): void;
}

interface Snapshot {
  projectId: string;
  at: number;
  mine: MrListResult | null;
  review: MrListResult | null;
  jira: JiraListResult | null;
}

/** Источники кода проекта и Jira: без них кнопки «Статус» нет. */
export const hasStatusSources = (p: Project | null): boolean => !!p && (p.trackers.github || p.trackers.gitlab || !!p.jira?.enabled);

const FAILED = (message: string): MrListResult => ({
  mrs: [],
  sources: [],
  tracked: [],
  enabled: { github: false, gitlab: false },
  error: message,
  detailsId: null,
  awaiting: [],
});

/** Список MR с деталями (пайплайн, апрувы, замечания): два вызова, как во вкладке «MR/PR». */
async function fetchMrs(projectId: string, filter: 'author' | 'review', recheck: boolean): Promise<MrListResult> {
  let list: MrListResult;
  try {
    list = await api.listMrs(projectId, filter, [], recheck);
  } catch (error) {
    return FAILED((error as Error).message);
  }
  if (list.detailsId === null) return list;
  const details = await api.mrDetails(list.detailsId).catch(() => null);
  return applyMrDetails(list, details);
}

export class StatusHub {
  private readonly button = byId<HTMLButtonElement>('status-toggle');
  private readonly dot = this.button.querySelector('.status-dot') as HTMLElement;
  private readonly count = this.button.querySelector('.status-count') as HTMLElement;
  private readonly popover = byId('status-popover');
  private data: Snapshot | null = null;
  private loading = false;
  private seq = 0;
  private opened = false;
  private readonly expanded = new Set<string>();
  private readonly details = new Map<string, JiraDetailsResult | 'loading'>();
  private readonly openErrors = new Map<string, string>();
  private timer: number | undefined;

  constructor(private readonly host: StatusHost) {
    this.button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (this.opened) this.close();
      else this.open();
    });
    document.addEventListener('click', (event) => {
      // Путь события берётся при отправке: кнопка внутри карточки, перерисовавшая её в обработчике, всё равно считается «внутри».
      const path = event.composedPath();
      if (this.opened && !path.includes(this.popover) && !path.includes(this.button)) this.close();
    });
    document.addEventListener('keydown', (event) => {
      if (this.opened && event.key === 'Escape') {
        this.close();
        this.button.focus();
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.stale(REFRESH_MS)) void this.refresh('timer');
    });
    window.addEventListener('resize', () => this.opened && this.place());
  }

  get isOpen(): boolean {
    return this.opened;
  }

  /** Проект выбран либо его источники изменились: данные прежнего проекта сброшены, кнопка показана по источникам. */
  onProjectChanged(): void {
    this.seq++;
    this.loading = false;
    this.data = null;
    this.expanded.clear();
    this.details.clear();
    this.openErrors.clear();
    window.clearInterval(this.timer);
    const available = hasStatusSources(this.host.project());
    this.button.hidden = !available;
    if (!available) {
      this.close();
      return;
    }
    this.paintButton();
    this.timer = window.setInterval(() => {
      if (!document.hidden) void this.refresh('timer');
    }, REFRESH_MS);
    void this.refresh('project');
    if (this.opened) this.render();
  }

  private stale(ms: number): boolean {
    return !this.data || Date.now() - this.data.at > ms;
  }

  private open(): void {
    this.opened = true;
    this.button.setAttribute('aria-expanded', 'true');
    this.popover.hidden = false;
    this.render();
    this.place();
    // Фокус уходит из терминала в карточку: xterm гасит Escape на своём поле ввода, и без этого клавиша её бы не закрыла.
    this.popover.focus({ preventScroll: true });
    if (this.stale(FRESH_MS) && !this.loading) void this.refresh('open');
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.button.setAttribute('aria-expanded', 'false');
    this.popover.hidden = true;
  }

  private place(): void {
    const rect = this.button.getBoundingClientRect();
    this.popover.style.top = `${rect.bottom + 6}px`;
    this.popover.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
  }

  /** trigger: project/open/timer - вход трекеров не перепроверяется; reload («Обновить») - перепроверяется и Jira снова пробует войти. */
  async refresh(trigger: 'project' | 'open' | 'timer' | 'reload'): Promise<void> {
    const project = this.host.project();
    if (!project || !hasStatusSources(project)) return;
    // Идущий опрос таймер и открытие карточки не дублируют; выбор проекта и «Обновить» его вытесняют.
    if (this.loading && (trigger === 'timer' || trigger === 'open')) return;
    const token = ++this.seq;
    const recheck = trigger === 'reload';
    this.loading = true;
    if (recheck) {
      this.details.clear();
      this.openErrors.clear();
    }
    if (this.opened) this.render();
    const codeHost = project.trackers.github || project.trackers.gitlab;
    const jira = project.jira?.enabled ? api.listJira(project.id, recheck).catch((e: Error): JiraListResult => ({ issues: [], truncated: false, problem: 'error', error: e.message })) : Promise.resolve(null);
    // Выборки MR идут по очереди: их общий пул процессов CLI не должен делиться надвое.
    const mine = codeHost ? await fetchMrs(project.id, 'author', recheck) : null;
    const review = codeHost ? await fetchMrs(project.id, 'review', false) : null;
    const jiraResult = await jira;
    if (token !== this.seq) return;
    this.loading = false;
    this.data = { projectId: project.id, at: Date.now(), mine, review, jira: jiraResult };
    this.paintButton();
    if (this.opened) this.render();
  }

  // ---------- кнопка ----------

  private level(): Level {
    return this.data ? levelOf(usable(this.data.mine), usable(this.data.review)) : 'unknown';
  }

  private attention(): Attention[] {
    return this.data ? attentionOf(usable(this.data.mine) ?? [], usable(this.data.review) ?? []) : [];
  }

  private paintButton(): void {
    const level = this.level();
    const items = this.attention().length;
    this.dot.dataset.level = level;
    this.count.hidden = items === 0;
    this.count.textContent = items > 99 ? '99+' : String(items);
    this.button.title = `Статус: ${LEVEL_TEXT[level]}${items ? ` (${items})` : ''}`;
  }

  // ---------- карточка ----------

  private render(): void {
    const body = this.popover.querySelector('.popover-body');
    const scroll = body?.scrollTop ?? 0;
    const project = this.host.project();
    const level = this.level();
    const head = el('header', 'popover-head');
    const title = el('div', 'popover-title');
    const dot = el('span', 'status-dot');
    dot.dataset.level = level;
    title.append(dot, el('span', '', project ? project.name : 'Статус'));
    const reload = el('button', '', this.loading ? 'Обновляется…' : 'Обновить') as HTMLButtonElement;
    reload.disabled = this.loading;
    reload.addEventListener('click', () => void this.refresh('reload'));
    head.append(title, el('span', 'popover-spacer'), el('span', 'popover-time', this.data ? `обновлено ${ago(this.data.at, Date.now())}` : ''), reload);
    const content = el('div', 'popover-body');
    if (!project || !hasStatusSources(project)) content.append(el('p', 'status-note', 'У проекта нет источников: включите GitHub, GitLab или Jira в свойствах проекта.'));
    else if (!this.data) content.append(el('p', 'status-note', 'Загрузка…'));
    else this.renderData(content, this.data, project, level);
    this.popover.replaceChildren(head, content);
    content.scrollTop = scroll;
  }

  private renderData(into: HTMLElement, data: Snapshot, project: Project, level: Level): void {
    const mine = usable(data.mine);
    const review = usable(data.review);
    const codeHost = project.trackers.github || project.trackers.gitlab;
    if (codeHost) {
      const items = this.attention();
      into.append(el('p', `status-summary level-${level}`, `${LEVEL_TEXT[level]}${items.length ? ` · требует внимания: ${items.length}` : ''}`));
    }
    const errors = this.codeErrors(data);
    for (const message of errors) into.append(el('p', 'status-note error', message));
    // Ни ошибки, ни данных: у репозиториев нет remote GitHub либо GitLab, откуда брать MR.
    if (codeHost && mine === null && review === null && !errors.length) {
      into.append(el('p', 'status-note', 'MR/PR недоступны: у репозиториев проекта нет remote GitHub или GitLab, на который залогинены gh или glab.'));
    }
    if (project.jira?.enabled) this.renderJira(into, data, [...(mine ?? []), ...(review ?? [])]);
    if (codeHost) {
      this.renderMrs(into, 'Мои MR/PR', (mine ?? []).filter((mr) => mr.state === 'open'), 'У вас нет открытых MR/PR.', mine !== null);
      this.renderMrs(into, 'Ждут моего ревью', (review ?? []).filter((mr) => mr.state === 'open' && !mr.own), 'Ревью от вас никто не ждёт.', review !== null);
    }
  }

  private codeErrors(data: Snapshot): string[] {
    const messages = new Set<string>();
    for (const result of [data.mine, data.review]) {
      if (!result) continue;
      if (result.error) messages.add(result.error);
      for (const source of result.sources) {
        if (source.error) messages.add(`${source.kind === 'github' ? 'GitHub' : 'GitLab'}${source.path ? ` ${source.path}` : ''}: ${source.error}`);
      }
    }
    return [...messages];
  }

  // ---------- Jira ----------

  private renderJira(into: HTMLElement, data: Snapshot, mrs: Mr[]): void {
    const section = el('section', 'status-section');
    const result = data.jira;
    section.append(el('h3', '', result && !result.error ? `Jira · на мне: ${result.issues.length}${result.truncated ? '+' : ''}` : 'Jira'));
    if (!result) section.append(el('p', 'status-note', 'Загрузка…'));
    else if (result.error) section.append(el('p', 'status-note error', result.error));
    else if (!result.issues.length) section.append(el('p', 'status-note', 'Открытых задач на вас нет.'));
    else {
      for (const group of groupIssues(result.issues)) {
        section.append(el('div', 'status-group', group.title));
        for (const issue of group.issues) section.append(this.issueRow(issue, mrsOfIssue(issue, mrs)));
      }
    }
    into.append(section);
  }

  private issueRow(issue: JiraIssue, linked: Mr[]): HTMLElement {
    const open = this.expanded.has(issue.key);
    const item = el('div', 'status-item');
    const row = el('div', 'status-row');
    const main = el('div', 'status-main');
    const title = el('div', 'status-title');
    const key = el('button', 'status-link', issue.key) as HTMLButtonElement;
    key.title = open ? 'Свернуть детали' : 'Показать детали задачи';
    key.setAttribute('aria-expanded', String(open));
    key.addEventListener('click', () => this.toggleIssue(issue));
    title.append(key, el('span', '', ` ${issue.summary}`));
    main.append(title);
    const meta = el('div', 'status-meta');
    meta.append(el('span', `chip ${issue.category === 'indeterminate' ? 'tone-progress' : ''}`, issue.status || '—'));
    if (issue.priority) meta.append(el('span', 'chip', issue.priority));
    for (const mr of linked) meta.append(this.mrChip(mr));
    const updated = jiraTime(issue.updated);
    if (updated) meta.append(el('span', 'status-when', `обновлена ${ago(updated, Date.now())}`));
    main.append(meta);
    const actions = el('div', 'status-actions');
    const open1 = this.host.sessionOf(`jira:${issue.key}`);
    const start = el('button', open1 ? '' : 'primary', open1 ? 'К сессии' : 'Начать') as HTMLButtonElement;
    start.title = open1 ? 'Перейти к открытой сессии задачи' : 'Открыть сессию Claude Code по задаче: прочитает её и предложит план';
    start.addEventListener('click', () => {
      this.close();
      this.host.startJira(issue, linked[0], this.button);
    });
    actions.append(start);
    row.append(main, actions);
    item.append(row);
    if (open) item.append(this.issueDetails(issue));
    return item;
  }

  private toggleIssue(issue: JiraIssue): void {
    if (this.expanded.delete(issue.key)) {
      this.render();
      return;
    }
    this.expanded.add(issue.key);
    const project = this.host.project();
    if (project && !this.details.has(issue.key)) {
      this.details.set(issue.key, 'loading');
      const id = project.id;
      void api
        .jiraDetails(id, issue.key)
        .catch((e: Error): JiraDetailsResult => ({ problem: 'error', error: e.message }))
        .then((res) => {
          if (this.host.project()?.id !== id) return;
          this.details.set(issue.key, res);
          if (this.opened) this.render();
        });
    }
    this.render();
  }

  private issueDetails(issue: JiraIssue): HTMLElement {
    const box = el('div', 'status-details');
    const entry = this.details.get(issue.key);
    if (!entry || entry === 'loading') {
      box.append(el('p', 'status-note', 'Загрузка…'));
      return box;
    }
    if ('error' in entry) {
      box.append(el('p', 'status-note error', entry.error));
    } else {
      const { issue: full, comments, total } = entry.details;
      const facts = [
        full.type && `Тип: ${full.type}`,
        `Статус: ${full.status || '—'}`,
        full.priority && `Приоритет: ${full.priority}`,
        `Исполнитель: ${full.assignee ?? 'не назначен'}`,
        full.reporter && `Автор: ${full.reporter}`,
        full.labels.length && `Метки: ${full.labels.join(', ')}`,
      ].filter(Boolean) as string[];
      for (const fact of facts) box.append(el('div', 'status-fact', fact));
      box.append(el('div', 'status-description', full.description || 'Описания нет.'));
      if (comments.length) {
        box.append(el('div', 'status-group', `Комментарии (последние ${comments.length} из ${total})`));
        for (const comment of comments) {
          const when = jiraTime(comment.created);
          box.append(el('div', 'status-comment-head', `${comment.author}${when ? ` · ${ago(when, Date.now())}` : ''}`), el('div', 'status-comment', comment.text));
        }
      }
    }
    const project = this.host.project();
    const browser = el('button', '', 'Открыть в Jira') as HTMLButtonElement;
    browser.addEventListener('click', () => {
      if (!project) return;
      void api.openJira(project.id, issue.key).then((res) => {
        if (res.error) this.openErrors.set(issue.key, `Браузер не открылся: ${res.error}`);
        else this.openErrors.delete(issue.key);
        if (this.opened) this.render();
      });
    });
    box.append(browser);
    const openError = this.openErrors.get(issue.key);
    if (openError) box.append(el('p', 'status-note error', openError));
    return box;
  }

  // ---------- MR/PR ----------

  private mrChip(mr: Mr): HTMLElement {
    const tone = pipelineTone(mr.pipeline);
    const glyph = tone === 'good' ? '✓' : tone === 'bad' ? '✕' : tone === 'wait' ? '…' : '–';
    const chip = el('span', `chip tone-${tone}`, `${mrNumber(mr.kind, mr.number)} ${glyph}`);
    chip.title = `${mrNumber(mr.kind, mr.number)} ${mr.title}\nПайплайн: ${mr.pipeline ?? '—'}`;
    return chip;
  }

  private renderMrs(into: HTMLElement, title: string, mrs: Mr[], empty: string, received: boolean): void {
    if (!received) return;
    const attention = new Map(this.attention().map((a) => [a.mr.key, a]));
    const section = el('section', 'status-section');
    section.append(el('h3', '', `${title}: ${mrs.length}`));
    if (!mrs.length) section.append(el('p', 'status-note', empty));
    const ordered = [...mrs].sort((a, b) => Number(attention.has(b.key)) - Number(attention.has(a.key)));
    for (const mr of ordered) section.append(this.mrRow(mr, attention.get(mr.key)));
    into.append(section);
  }

  private mrRow(mr: Mr, why: Attention | undefined): HTMLElement {
    const item = el('div', 'status-item');
    const row = el('div', `status-row${why ? ' attention' : ''}`);
    const main = el('div', 'status-main');
    const title = el('div', 'status-title');
    const link = el('button', 'status-link', mrNumber(mr.kind, mr.number)) as HTMLButtonElement;
    link.title = 'Открыть в браузере';
    link.addEventListener('click', () => void api.openMr({ kind: mr.kind, host: mr.host, path: mr.path, number: mr.number }));
    title.append(link, el('span', '', ` ${mr.title}`));
    const meta = el('div', 'status-meta');
    meta.append(this.pipelineChip(mr));
    if (mr.approvals) meta.append(el('span', 'chip', mr.approvals));
    if (mr.draft) meta.append(el('span', 'chip', 'черновик'));
    // Упавший пайплайн уже назван красной меткой пайплайна: повторять его причиной не нужно.
    for (const kind of why?.kinds ?? []) if (kind !== 'pipeline-failed') meta.append(el('span', 'chip tone-attention', ATTENTION_TEXT[kind]));
    meta.append(el('span', 'status-when', `${mr.path} · ${mr.sourceBranch}`));
    main.append(title, meta);
    const actions = el('div', 'status-actions');
    const session = this.host.sessionOf(mr.key);
    const add = (label: string, intent: MrIntent, primary: boolean): void => {
      const button = el('button', primary && !session ? 'primary' : '', session ? 'К сессии' : label) as HTMLButtonElement;
      button.addEventListener('click', () => {
        this.close();
        this.host.startMr(mr, intent, this.button);
      });
      actions.append(button);
    };
    // У MR одна сессия на все намерения: есть она - одна кнопка «К сессии», иначе по кнопке на причину.
    if (session) add('', mr.own ? 'rework' : 'review', false);
    else if (mr.own) {
      if (why?.kinds.includes('pipeline-failed')) add('Разобрать пайплайн', 'ci', true);
      if (why?.kinds.includes('has-comments')) add('Доработать', 'rework', !why.kinds.includes('pipeline-failed'));
    } else add('Ревью', 'review', !!why);
    row.append(main, actions);
    item.append(row);
    return item;
  }

  private pipelineChip(mr: Mr): HTMLElement {
    const tone = pipelineTone(mr.pipeline);
    return el('span', `chip tone-${tone}`, `пайплайн: ${mr.pipeline ?? '—'}`);
  }
}
