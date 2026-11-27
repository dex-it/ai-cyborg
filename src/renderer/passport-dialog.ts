/** Точка паспорта у списка проектов и окно «Паспорт проекта» (FR-20004, FR-20005); всё из репозитория и от агента идёт текстом (NFR-20002). */
import { GROUPS, OUTCOME_TEXT, dotText, dotTitle, type CapabilityView, type PassportView } from '../shared/passport';
import type { Project } from '../main/projects';
import { byId, el } from './dom';
import { ipcErrorText } from './ipc-error';
import { fixAction } from './passport-fix';

const api = window.cyborg;

export interface PassportHost {
  project(): Project | null;
  startProbe(project: Project, repo: string): void;
  startFix(project: Project, repo: string, capability: string): void;
  /** Переводит к вкладке сессии; false - вкладки нет (закрыта, процесс вышел). */
  showSession(id: number): boolean;
}

const shortRepo = (repo: string): string => repo.slice(repo.lastIndexOf('/') + 1) || repo;

export class PassportUi {
  private readonly dot = byId<HTMLButtonElement>('passport-dot');
  private readonly dialog = byId<HTMLDialogElement>('passport-dialog');
  private readonly body = byId('passport-body');
  private readonly note = byId('passport-note');
  private readonly error = byId('passport-error');
  private view: PassportView | null = null;
  private ticket = 0;

  constructor(private readonly host: PassportHost) {
    this.dot.addEventListener('click', () => void this.open());
    byId('passport-close').addEventListener('click', () => this.dialog.close());
    api.on<{ projectId: string }>('passport:changed', ({ projectId }) => {
      if (projectId === this.host.project()?.id) void this.refresh();
    });
    this.paintDot('unchecked', 0);
  }

  /** Смена проекта: точка пересчитывается, окно показывает новый проект (FR-20003, FR-20005). */
  onProjectChanged(): void {
    this.view = null;
    this.error.hidden = true;
    const project = this.host.project();
    this.dot.hidden = !project;
    if (this.dialog.open) this.dialog.close();
    if (project) void this.refresh();
  }

  private paintDot(level: 'checking' | 'unchecked' | 'gaps' | 'clear', count: number): void {
    this.dot.dataset.level = level;
    this.dot.textContent = dotText(level, count);
    this.dot.title = dotTitle(level, count);
    this.dot.setAttribute('aria-label', dotTitle(level, count));
  }

  private async refresh(): Promise<void> {
    const project = this.host.project();
    if (!project) return;
    const ticket = ++this.ticket;
    if (!this.view) this.paintDot('checking', 0);
    try {
      const view = await api.passportView(project.id);
      if (ticket !== this.ticket || this.host.project()?.id !== project.id) return;
      this.view = view;
      this.paintDot(view.level, view.count);
      if (this.dialog.open) this.render();
    } catch (error) {
      if (ticket !== this.ticket) return;
      this.paintDot('unchecked', 0);
      this.show(ipcErrorText(error));
    }
  }

  private show(message: string): void {
    this.error.textContent = message;
    this.error.hidden = !message;
  }

  private async open(): Promise<void> {
    if (!this.host.project()) return;
    this.dialog.showModal();
    this.show('');
    await this.refresh();
    this.render();
  }

  private async act(action: Record<string, unknown>): Promise<void> {
    const project = this.host.project();
    if (!project) return;
    try {
      this.view = await api.passportAct(project.id, action);
      this.show('');
      this.paintDot(this.view.level, this.view.count);
    } catch (error) {
      this.show(ipcErrorText(error));
    }
    this.render();
  }

  private button(label: string, run: () => void, disabledReason?: string | null, className = ''): HTMLButtonElement {
    const b = el('button', className, label) as HTMLButtonElement;
    b.type = 'button';
    if (disabledReason) {
      b.disabled = true;
      b.title = disabledReason;
    }
    b.addEventListener('click', run);
    return b;
  }

  private render(): void {
    const view = this.view;
    const project = this.host.project();
    this.body.replaceChildren();
    if (!view || !project) return;
    byId('passport-title').textContent = `Паспорт проекта: ${project.name}`;
    const notes = [...view.problems, ...(view.probeNote ? [view.probeNote] : []), ...(view.agentUnavailable ? [view.agentUnavailable] : [])];
    this.note.textContent = notes.join(' ');
    this.note.hidden = !notes.length;

    const head = el('div', 'passport-head');
    if (project.repos.length > 1) {
      const label = el('label', 'passport-main', 'Главный репозиторий: ');
      const select = el('select') as HTMLSelectElement;
      select.setAttribute('aria-label', 'Главный репозиторий');
      if (!view.mainRepo) select.append(new Option('не отмечен', ''));
      for (const r of view.repos) select.append(new Option(shortRepo(r.repo) + (r.pointerOk === false ? ' · нет указателя на главный' : ''), r.repo));
      select.value = view.mainRepo ?? '';
      select.addEventListener('change', () => select.value && void this.act({ op: 'setMain', repo: select.value }));
      label.append(select);
      head.append(label);
    }
    const mainRepo = view.mainRepo;
    const probeOff = view.probing ? 'Проба идёт…' : (view.agentUnavailable ?? (mainRepo ? null : 'Отметьте главный репозиторий'));
    head.append(this.button(view.probing ? 'Проба идёт…' : 'Проверить агентом', () => mainRepo && this.launch(() => this.host.startProbe(project, mainRepo)), probeOff, 'primary'));
    this.body.append(head);

    for (const group of GROUPS) {
      const section = el('section', 'passport-group');
      section.append(el('h3', '', group.title));
      for (const cap of view.capabilities.filter((c) => c.group === group.id)) section.append(this.row(cap, view, project));
      this.body.append(section);
    }
  }

  private launch(run: () => void): void {
    this.dialog.close();
    run();
  }

  private row(cap: CapabilityView, view: PassportView, project: Project): HTMLElement {
    const row = el('div', 'passport-row');
    row.dataset.capability = cap.id;
    if (cap.notNeeded) row.classList.add('off');
    else if (cap.gap) row.classList.add('gap');
    const info = el('div', 'passport-info');
    const title = el('div', 'passport-name', cap.name + (project.repos.length > 1 && cap.group === 'tech' ? ` · ${shortRepo(cap.repo)}` : ''));
    info.append(title, el('div', 'passport-question', cap.question));
    const state = cap.notNeeded ? 'не нужно' : cap.reasons.length ? cap.reasons.join(', ') : cap.closed ? 'закрыт в сессии' : 'в порядке';
    info.append(el('div', 'passport-state', state));
    if (cap.probe && cap.probe.outcome === 'found' && cap.semantic && !cap.notNeeded) {
      info.append(el('div', 'passport-answer', `Ответ агента: ${cap.probe.answer}`), el('div', 'passport-source', `Источник: ${cap.probe.source}`));
    } else if (cap.probe) {
      info.append(el('div', 'passport-source', `Проба: ${OUTCOME_TEXT[cap.probe.outcome]}`));
    }
    const actions = el('div', 'passport-actions');
    const agentOff = view.agentUnavailable;
    if (cap.gap && !cap.notNeeded) {
      const live = view.fixSession;
      const fix = this.button('Исправить', () => this.launch(() => fixAction(this.host, live, project, cap.repo, cap.id)), agentOff);
      if (live !== null && !agentOff) fix.title = 'Перейти к сессии настройки паспорта';
      actions.append(fix);
    }
    if (cap.hasApprox && cap.fileReasons.includes('approx')) actions.append(this.button('Подтвердить черновик', () => void this.act({ op: 'confirmApprox', capability: cap.id, repo: cap.repo })));
    if (cap.probe?.outcome === 'found' && cap.semantic && !cap.probe.confirmed && !cap.notNeeded) {
      actions.append(this.button('Подтвердить', () => void this.act({ op: 'confirmAnswer', capability: cap.id, repo: cap.repo })));
      actions.append(this.button('Не то', () => void this.act({ op: 'rejectAnswer', capability: cap.id, repo: cap.repo })));
    }
    const needMain = view.mainRepo ? null : 'Отметьте главный репозиторий';
    if (!(cap.group === 'tech' && cap.repo !== view.mainRepo && project.repos.length > 1)) {
      actions.append(
        cap.notNeeded
          ? this.button('Нужно', () => void this.act({ op: 'needed', capability: cap.id }), needMain)
          : this.button('Не нужно', () => void this.act({ op: 'notNeeded', capability: cap.id }), needMain),
      );
    }
    row.append(info, actions);
    return row;
  }
}
