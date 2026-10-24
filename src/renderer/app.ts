import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import type { Project, ProjectsState } from '../main/projects';
import type { Mr, MrIntent, MrListResult, MrRef } from '../main/mrs';
import type { Task, TaskRef, TasksResult } from '../main/trackers';
import { basename, byId, el } from './dom';
import { acceptsDrop, dropIntoSession } from './drop-path';
import { initSettings } from './settings';
import { decideStart, StartGuard, TaskSessionRegistry } from './task-flow';
import { findMr, mrSessionLabel, mrTooltip } from './mr-model';
import { TrackerPanel } from './panel';
import { findTask, sessionLabel, taskTooltip } from './task-model';
import { onThemeChange, sessionColor, terminalTheme } from './theme';
import { TreeView, type TreeRoot } from './tree';
import { applyMonacoTheme, FileViewer } from './viewer';

interface FileTab {
  viewer: FileViewer;
  rootLabel: string;
  tab: HTMLElement;
  pane: HTMLElement;
}

/** Сессия Claude Code со своим деревом и своими вкладками файлов - изолированное рабочее пространство. */
interface Session {
  id: number;
  project: Project;
  repo: string;
  cwd: string;
  root: string;
  exited: boolean;
  /** Задача трекера, из которой начата сессия; живёт только в памяти интерфейса. */
  task?: Task;
  /** MR/PR, из которого начата сессия; тоже только в памяти интерфейса. */
  mr?: Mr;
  color: string;
  term: Terminal;
  fit: FitAddon;
  stripTab: HTMLElement;
  container: HTMLElement;
  innerTabs: HTMLElement;
  innerPanes: HTMLElement;
  claudeTab: HTMLElement;
  termPane: HTMLElement;
  files: FileTab[];
  activeFile: FileTab | null;
  tree: TreeView;
}

const api = window.cyborg;
const sidebar = byId('sidebar');
const projectSelect = byId<HTMLSelectElement>('project-select');
const projectEdit = byId<HTMLButtonElement>('project-edit');
const treeEl = byId('tree');
const treeTitle = byId('tree-title');
const treeMeta = byId('tree-meta');
const sessionList = byId('session-list');
const newSessionButton = byId<HTMLButtonElement>('new-session');
const sessionsEl = byId('sessions');
const empty = byId('empty');
const repoMenu = byId('repo-menu');
const taskSessions = new TaskSessionRegistry<Session>();
const startGuard = new StartGuard();

let state: ProjectsState = { projects: [], lastProjectId: null };
let project: Project | null = null;
const sessions: Session[] = [];
const lastSessionOf = new Map<string, Session>();
let active: Session | null = null;
let colorIndex = 0;
let treeToken = 0;
// Вывод pty может прийти раньше, чем сессия создана в интерфейсе.
const pendingData = new Map<number, string[]>();

// ---------- проекты ----------

function renderProjectSelect(): void {
  projectSelect.replaceChildren(
    ...state.projects.map((p) => {
      const option = el('option', '', p.name) as HTMLOptionElement;
      option.value = p.id;
      return option;
    }),
  );
  if (!state.projects.length) projectSelect.append(el('option', '', 'Нет проектов'));
  projectSelect.value = project?.id ?? '';
  projectSelect.disabled = !state.projects.length;
  projectEdit.disabled = !project;
}

function selectProject(next: Project | null): void {
  project = next;
  state.lastProjectId = next?.id ?? null;
  void api.saveProjects(state);
  renderProjectSelect();
  for (const s of sessions) s.stripTab.hidden = s.project !== next;
  newSessionButton.disabled = !next?.repos.length;
  const session = next ? (lastSessionOf.get(next.id) ?? sessions.find((s) => s.project === next)) : undefined;
  if (session) activateSession(session, panel.isOpen);
  else showNoSession();
  panel.onProjectChanged();
}

const projectDialog = byId<HTMLDialogElement>('project-dialog');
const projectName = byId<HTMLInputElement>('project-name');
const projectDescription = byId<HTMLTextAreaElement>('project-description');
const projectRepos = byId('project-repos');
const projectDelete = byId<HTMLButtonElement>('project-delete');
let draft: Project | null = null;
let editing: Project | null = null;

function editProject(target: Project | null): void {
  editing = target;
  draft = target ? { ...target, repos: [...target.repos] } : { id: crypto.randomUUID(), name: '', description: '', repos: [] };
  byId('project-dialog-title').textContent = target ? 'Свойства проекта' : 'Новый проект';
  projectName.value = draft.name;
  projectDescription.value = draft.description;
  projectDelete.hidden = !target;
  renderDraftRepos();
  projectDialog.showModal();
}

function renderDraftRepos(): void {
  if (!draft) return;
  const current = draft;
  projectRepos.replaceChildren(
    ...current.repos.map((repo) => {
      const item = el('li');
      item.append(el('span', 'repo-name', basename(repo)), el('span', 'repo-path', repo));
      const remove = el('button', 'icon-button', '×');
      remove.title = 'Убрать из проекта';
      remove.addEventListener('click', () => {
        current.repos = current.repos.filter((r) => r !== repo);
        renderDraftRepos();
      });
      item.append(remove);
      return item;
    }),
  );
  if (!current.repos.length) projectRepos.append(el('li', 'hint', 'Репозиториев нет'));
}

byId('project-add-repo').addEventListener('click', async () => {
  if (!draft) return;
  const dir = await api.pickDir(draft.repos[0]);
  if (!dir) return;
  const root = await api.gitRoot(dir);
  if (!root && !confirm(`${dir} не git-репозиторий: изменений в дереве не будет видно. Добавить всё равно?`)) return;
  const repo = root ?? dir;
  if (!draft.repos.includes(repo)) draft.repos.push(repo);
  renderDraftRepos();
});

projectDialog.addEventListener('close', () => {
  if (projectDialog.returnValue !== 'save' || !draft) return;
  draft.name = projectName.value.trim();
  draft.description = projectDescription.value.trim();
  let target = editing;
  if (target) Object.assign(target, draft);
  else state.projects.push((target = draft));
  selectProject(target);
});

projectDelete.addEventListener('click', () => {
  const target = editing;
  if (!target) return;
  const running = sessions.filter((s) => s.project === target);
  const warning = running.length ? ` Его сессии (${running.length}) будут завершены.` : '';
  if (!confirm(`Удалить проект «${target.name}»?${warning} Репозитории на диске не трогаются.`)) return;
  for (const s of running) closeSession(s, true);
  state.projects = state.projects.filter((p) => p !== target);
  projectDialog.close('deleted');
  selectProject(state.projects[0] ?? null);
});

projectSelect.addEventListener('change', () => selectProject(state.projects.find((p) => p.id === projectSelect.value) ?? null));
projectEdit.addEventListener('click', () => project && editProject(project));
byId('project-new').addEventListener('click', () => editProject(null));

// ---------- сессии ----------

function rootLabel(s: Session): string {
  return s.root === s.repo ? basename(s.repo) : `${basename(s.repo)} ⎇ ${basename(s.root)}`;
}

function treeRoots(s: Session): TreeRoot[] {
  const own: TreeRoot = {
    path: s.root,
    label: rootLabel(s),
    hint: s.root === s.repo ? 'репозиторий сессии' : `worktree репозитория ${s.repo}`,
  };
  const others = s.project.repos
    .filter((r) => r !== s.repo)
    .map((r) => ({ path: r, label: basename(r), hint: 'другой репозиторий проекта, доступен сессии через --add-dir' }));
  return [own, ...others];
}

function updateSessionLabels(s: Session): void {
  const label = s.mr ? mrSessionLabel(s.id, s.mr) : s.task ? sessionLabel(s.id, s.task) : `CC${s.id} · ${rootLabel(s)}`;
  const tooltip = s.mr ? mrTooltip(s.mr) : s.task ? taskTooltip(s.task) : '';
  (s.stripTab.querySelector('.label') as HTMLElement).textContent = label;
  s.stripTab.title = tooltip ? `${tooltip}\n${s.cwd}` : s.cwd;
  s.stripTab.classList.toggle('exited', s.exited);
  if (s === active) {
    treeTitle.textContent = label;
    treeTitle.title = tooltip;
    // Шапка обрезает путь слева через direction: rtl; LRM не даёт ведущему «/» уехать в конец.
    treeMeta.textContent = `‎${s.exited ? `завершена · ${s.cwd}` : s.cwd}`;
  }
}

/** Пояснение, пока нет проекта с репозиториями; общее для пустой области и панели задач. */
function projectHint(): string[] | null {
  if (!state.projects.length) return ['Проектов нет.', '«+» слева вверху — создать проект и добавить в него репозитории.'];
  if (!project?.repos.length) return ['В проекте нет репозиториев.', '«✎» слева вверху — добавить.'];
  return null;
}

function showNoSession(): void {
  active = null;
  for (const s of sessions) {
    s.container.classList.remove('active');
    s.stripTab.classList.remove('active');
  }
  sidebar.style.removeProperty('--session');
  treeTitle.textContent = project ? 'Нет активной сессии' : 'Нет проекта';
  treeTitle.title = '';
  treeMeta.textContent = '';
  treeEl.replaceChildren();
  empty.replaceChildren(
    ...(projectHint() ?? ['Сессий нет.', '«+ CC» или Ctrl+Shift+N — запустить Claude Code в репозитории проекта.']).map((text) =>
      el('p', '', text),
    ),
  );
  empty.hidden = false;
}

function activateSession(s: Session, keepPanel = false): void {
  if (!keepPanel) panel.close();
  active = s;
  lastSessionOf.set(s.project.id, s);
  for (const other of sessions) {
    other.container.classList.toggle('active', other === s);
    other.stripTab.classList.toggle('active', other === s);
  }
  empty.hidden = true;
  sidebar.style.setProperty('--session', s.color);
  updateSessionLabels(s);
  s.tree.setRoots(treeRoots(s));
  treeEl.replaceChildren();
  void renderTree(s, false);
  showInner(s, s.activeFile);
}

function showInner(s: Session, file: FileTab | null): void {
  s.activeFile = file;
  s.claudeTab.classList.toggle('active', !file);
  s.termPane.classList.toggle('active', !file);
  for (const f of s.files) {
    f.tab.classList.toggle('active', f === file);
    f.pane.classList.toggle('active', f === file);
  }
  if (file) void file.viewer.load();
  else
    requestAnimationFrame(() => {
      fitSession(s);
      s.term.focus();
    });
}

async function renderTree(s: Session, onlyIfChanged: boolean): Promise<void> {
  if (s !== active) return;
  const token = ++treeToken;
  const fragment = await s.tree.render(onlyIfChanged);
  if (!fragment || token !== treeToken || s !== active) return;
  const scroll = treeEl.scrollTop;
  treeEl.replaceChildren(fragment);
  treeEl.scrollTop = scroll;
}

function fitSession(s: Session): void {
  if (s !== active || s.activeFile) return;
  s.fit.fit();
  api.resize(s.id, s.term.cols, s.term.rows);
}

function makeTab(className: string, label: string, onClose?: () => void): HTMLElement {
  const tab = el('div', `tab ${className}`);
  tab.append(el('span', 'icon'), el('span', 'label', label));
  if (onClose) {
    const close = el('button', 'close', '×');
    close.title = 'Закрыть';
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      onClose();
    });
    tab.append(close);
  }
  return tab;
}

function createTerminal(id: number): Terminal {
  const term = new Terminal({
    fontFamily: "'JetBrains Mono', 'DejaVu Sans Mono', 'Ubuntu Mono', monospace",
    fontSize: 13,
    cursorBlink: true,
    scrollback: 10000,
    theme: terminalTheme(),
  });
  term.onData((data) => api.input(id, data));
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;
    if (event.ctrlKey && event.shiftKey && event.code === 'KeyC') {
      const selection = term.getSelection();
      if (selection) void navigator.clipboard.writeText(selection);
      return false;
    }
    if (event.ctrlKey && event.shiftKey && event.code === 'KeyV') {
      void navigator.clipboard.readText().then((text) => term.paste(text));
      return false;
    }
    // Claude Code понимает ESC+CR как перевод строки в промпте; xterm.js сам Shift+Enter не различает.
    if (event.key === 'Enter' && event.shiftKey && !event.ctrlKey && !event.altKey) {
      api.input(id, '\x1b\r');
      return false;
    }
    return true;
  });
  return term;
}

type StartFrom = { task: Task } | { mr: Mr; intent: MrIntent };

const refOf = (x: MrRef): MrRef => ({ kind: x.kind, host: x.host, path: x.path, number: x.number });

async function newSession(repo: string, start?: StartFrom): Promise<void> {
  const owner = project;
  if (!owner) return;
  const key = start && ('task' in start ? start.task.key : start.mr.key);
  // Ключ держится до появления сессии в taskSessions: двойной клик «Начать» не создаст вторую.
  if (key) {
    if (!startGuard.begin(owner.id, key)) return;
  }
  try {
    await createSessionView(owner, repo, start);
  } finally {
    if (key) startGuard.end(owner.id, key);
  }
}

async function createSessionView(owner: Project, repo: string, start?: StartFrom): Promise<void> {
  // В канал идут только ссылка и намерение: название, ветки и автор в первое сообщение не попадают.
  const id = await api.createSession(
    repo,
    owner.repos.filter((r) => r !== repo),
    start && ('task' in start ? { task: refOf(start.task) } : { mr: refOf(start.mr), intent: start.intent }),
  );
  const root = (await api.gitRoot(repo)) ?? repo;
  const color = sessionColor(colorIndex++);
  const term = createTerminal(id);
  const fit = new FitAddon();
  term.loadAddon(fit);

  const container = el('div', 'workspace-pane');
  container.style.setProperty('--session', color);
  const innerTabs = el('nav', 'inner-tabs');
  const innerPanes = el('div', 'inner-panes');
  const termPane = el('div', 'pane terminal');
  const host = el('div', 'term-host');
  termPane.append(host);
  innerPanes.append(termPane);
  container.append(innerTabs, innerPanes);
  sessionsEl.append(container);
  term.open(host);

  const stripTab = makeTab('session', '', () => closeSession(session, false));
  stripTab.style.setProperty('--session', color);
  sessionList.append(stripTab);
  const claudeTab = makeTab('claude', 'Claude');
  innerTabs.append(claudeTab);

  const session: Session = {
    id,
    project: owner,
    repo,
    cwd: repo,
    root,
    exited: false,
    task: start && 'task' in start ? start.task : undefined,
    mr: start && 'mr' in start ? start.mr : undefined,
    color,
    term,
    fit,
    stripTab,
    container,
    innerTabs,
    innerPanes,
    claudeTab,
    termPane,
    files: [],
    activeFile: null,
    tree: new TreeView(
      (path, treeRoot) => openFile(session, path, treeRoot),
      () => void renderTree(session, false),
    ),
  };
  stripTab.addEventListener('click', () => activateSession(session));
  claudeTab.addEventListener('click', () => showInner(session, null));
  bindPathDrop(session, termPane);
  bindPathDrop(session, claudeTab);
  sessions.push(session);
  taskSessions.add(session);
  updateSessionLabels(session);
  for (const chunk of pendingData.get(id) ?? []) term.write(chunk);
  pendingData.delete(id);
  if (project === owner) activateSession(session);
  else stripTab.hidden = true;
}

/** Зона броска пути: терминал и вкладка Claude. Файл ОС и строка дерева вставляются через term.paste, как Ctrl+Shift+V. */
function bindPathDrop(s: Session, target: HTMLElement): void {
  target.addEventListener('dragover', (event) => {
    if (s.exited || !event.dataTransfer || !acceptsDrop(event.dataTransfer.types)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  target.addEventListener('drop', (event) => {
    if (!event.dataTransfer || !acceptsDrop(event.dataTransfer.types)) return;
    event.preventDefault();
    dropIntoSession(s, event.dataTransfer, api.pathForFile, () => showInner(s, null));
  });
}

// Без отмены dragover/drop Electron уводит окно на file:// при броске файла ОС мимо зон.
document.addEventListener('dragover', (event) => {
  if (!event.dataTransfer || !acceptsDrop(event.dataTransfer.types) || event.defaultPrevented) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'none';
});
document.addEventListener('drop', (event) => {
  if (event.dataTransfer && acceptsDrop(event.dataTransfer.types)) event.preventDefault();
});

function closeSession(s: Session, force: boolean): void {
  if (!s.exited && !force && !confirm('Сессия Claude Code ещё работает. Завершить её?')) return;
  if (!s.exited) api.kill(s.id);
  s.term.dispose();
  for (const f of s.files) f.viewer.dispose();
  s.stripTab.remove();
  s.container.remove();
  sessions.splice(sessions.indexOf(s), 1);
  if (lastSessionOf.get(s.project.id) === s) lastSessionOf.delete(s.project.id);
  taskSessions.remove(s);
  if (active === s) {
    const next = sessions.find((x) => x.project === project);
    if (next) activateSession(next, panel.isOpen);
    else showNoSession();
  }
}

function openFile(s: Session, path: string, root: TreeRoot): void {
  const existing = s.files.find((f) => f.viewer.path === path);
  if (existing) {
    showInner(s, existing);
    return;
  }
  const pane = el('div', 'pane file');
  const rel = path.startsWith(`${root.path}/`) ? path.slice(root.path.length + 1) : path;
  const header = el('div', 'file-header');
  header.append(el('span', 'file-root', root.label), el('span', '', ` / ${rel}`));
  header.title = path;
  const body = el('div', 'file-body');
  pane.append(header, body);
  s.innerPanes.append(pane);
  const file: FileTab = { viewer: new FileViewer(path, body), rootLabel: root.label, tab: null as unknown as HTMLElement, pane };
  file.tab = makeTab('file', basename(path), () => closeFile(s, file));
  file.tab.title = path;
  file.tab.addEventListener('click', () => showInner(s, file));
  s.innerTabs.append(file.tab);
  s.files.push(file);
  labelFiles(s);
  showInner(s, file);
}

function labelFiles(s: Session): void {
  for (const file of s.files) {
    const name = basename(file.viewer.path);
    const clash = s.files.some((other) => other !== file && basename(other.viewer.path) === name);
    file.tab.querySelector('.label')!.textContent = clash ? `${name} · ${file.rootLabel}` : name;
  }
}

function closeFile(s: Session, file: FileTab): void {
  const index = s.files.indexOf(file);
  file.viewer.dispose();
  file.tab.remove();
  file.pane.remove();
  s.files.splice(index, 1);
  labelFiles(s);
  if (s.activeFile === file) showInner(s, s.files[Math.min(index, s.files.length - 1)] ?? null);
}

function findSession(id: number): Session | undefined {
  return sessions.find((s) => s.id === id);
}

api.on<{ id: number; data: string }>('session:data', ({ id, data }) => {
  const session = findSession(id);
  if (session) session.term.write(data);
  else pendingData.set(id, [...(pendingData.get(id) ?? []), data]);
});

api.on<{ id: number; cwd: string }>('session:cwd', async ({ id, cwd }) => {
  const session = findSession(id);
  if (!session) return;
  session.cwd = cwd;
  const root = (await api.gitRoot(cwd)) ?? cwd;
  const rootChanged = root !== session.root;
  session.root = root;
  updateSessionLabels(session);
  if (rootChanged && session === active) {
    session.tree.setRoots(treeRoots(session));
    void renderTree(session, false);
  }
});

let refreshTimer: number | undefined;
api.on<{ id: number }>('session:activity', ({ id }) => {
  if (active?.id !== id) return;
  const session = active;
  clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => void renderTree(session, false), 250);
});

api.on<{ id: number; exitCode: number }>('session:exit', ({ id, exitCode }) => {
  const session = findSession(id);
  if (!session) return;
  session.exited = true;
  session.term.write(`\r\n\x1b[2m[сессия завершена, код ${exitCode}]\x1b[0m\r\n`);
  updateSessionLabels(session);
});

// Правки вне хуков (руками, другим процессом) подхватываются опросом git status.
setInterval(() => {
  if (active && !document.hidden) void renderTree(active, true);
}, 3000);

// ---------- запуск сессии ----------

function showRepoMenu(repos: string[], anchor: HTMLElement, title: string, onPick: (repo: string) => void): void {
  repoMenu.replaceChildren(
    el('div', 'menu-title', title),
    ...repos.map((repo) => {
      const item = el('div', 'menu-item');
      item.append(el('span', 'repo-name', basename(repo)), el('span', 'repo-path', repo));
      item.addEventListener('click', () => {
        repoMenu.hidden = true;
        onPick(repo);
      });
      return item;
    }),
  );
  const rect = anchor.getBoundingClientRect();
  repoMenu.style.top = `${rect.bottom + 2}px`;
  repoMenu.style.right = `${window.innerWidth - rect.right}px`;
  repoMenu.hidden = false;
}

function requestSession(): void {
  const repos = project?.repos ?? [];
  if (repos.length === 1) {
    void newSession(repos[0]);
    return;
  }
  if (!repos.length) return;
  showRepoMenu(repos, newSessionButton, 'Где запустить Claude Code', (repo) => void newSession(repo));
}

// ---------- задачи трекеров ----------

function startTask(task: Task, anchor: HTMLElement): void {
  if (!project) return;
  const existing = taskSessions.get(project.id, task.key);
  const decision = decideStart(!!existing, task.repos, project.repos);
  if (decision.action === 'switch' && existing) activateSession(existing);
  else if (decision.action === 'create') void newSession(decision.repo, { task });
  else if (decision.action === 'menu') showRepoMenu(decision.repos, anchor, 'Где начать задачу', (repo) => void newSession(repo, { task }));
}

function startMr(mr: Mr, intent: MrIntent, anchor: HTMLElement): void {
  if (!project) return;
  const existing = taskSessions.get(project.id, mr.key);
  const decision = decideStart(!!existing, mr.repos, project.repos);
  if (decision.action === 'switch' && existing) activateSession(existing);
  else if (decision.action === 'create') void newSession(decision.repo, { mr, intent });
  else if (decision.action === 'menu') showRepoMenu(decision.repos, anchor, 'Где открыть MR', (repo) => void newSession(repo, { mr, intent }));
}

function applyMrStatuses(result: MrListResult): void {
  for (const s of sessions) {
    if (!s.mr) continue;
    const fresh = findMr(result, s.mr.key);
    if (!fresh) continue;
    // pipeline null - вызов не удался: прежний пайплайн остаётся в заголовке.
    s.mr = { ...fresh, repos: s.mr.repos, pipeline: fresh.pipeline ?? s.mr.pipeline };
    updateSessionLabels(s);
  }
}

function trackedMrRefs(): MrRef[] {
  const refs = new Map<string, MrRef>();
  for (const s of sessions) {
    if (s.project === project && s.mr) refs.set(s.mr.key, refOf(s.mr));
  }
  return [...refs.values()];
}

function applyStatuses(result: TasksResult): void {
  for (const s of sessions) {
    if (!s.task) continue;
    const fresh = findTask(result, s.task.key);
    if (!fresh) continue;
    s.task = { ...fresh, repos: s.task.repos };
    updateSessionLabels(s);
  }
}

function trackedRefs(): TaskRef[] {
  const refs = new Map<string, TaskRef>();
  for (const s of sessions) {
    if (s.project === project && s.task) refs.set(s.task.key, { kind: s.task.kind, host: s.task.host, path: s.task.path, number: s.task.number });
  }
  return [...refs.values()];
}

const settings = initSettings(() => {
  if (panel.isOpen) void panel.refreshActive(true);
});
byId('settings-open').addEventListener('click', () => settings.open());

const panel = new TrackerPanel({
  tasks: {
    project: () => project,
    projectHint,
    trackedRefs,
    applyStatuses,
    sessionOf: (key) => (project ? taskSessions.get(project.id, key) : undefined),
    startTask,
    openSettings: () => settings.open(),
  },
  mrs: {
    project: () => project,
    projectHint,
    trackedRefs: trackedMrRefs,
    applyStatuses: applyMrStatuses,
    sessionOf: (key) => (project ? taskSessions.get(project.id, key) : undefined),
    startMr,
    openSettings: () => settings.open(),
  },
  onClosed: () =>
    requestAnimationFrame(() => {
      if (!active) return;
      fitSession(active);
      if (!active.activeFile) active.term.focus();
    }),
});

newSessionButton.addEventListener('click', (event) => {
  event.stopPropagation();
  if (repoMenu.hidden) requestSession();
  else repoMenu.hidden = true;
});
document.addEventListener('click', (event) => {
  if (!repoMenu.contains(event.target as Node)) repoMenu.hidden = true;
});
window.addEventListener(
  'keydown',
  (event) => {
    if (event.key === 'Escape') repoMenu.hidden = true;
    if (event.ctrlKey && event.shiftKey && event.code === 'KeyN') {
      event.preventDefault();
      event.stopPropagation();
      requestSession();
    }
  },
  true,
);

// ---------- окно ----------

onThemeChange(() => {
  for (const s of sessions) s.term.options.theme = terminalTheme();
  applyMonacoTheme();
});

new ResizeObserver(() => active && fitSession(active)).observe(sessionsEl);

const splitter = byId('splitter');
splitter.addEventListener('mousedown', (down) => {
  down.preventDefault();
  splitter.classList.add('dragging');
  const move = (event: MouseEvent) => {
    sidebar.style.width = `${Math.max(180, Math.min(event.clientX, window.innerWidth - 300))}px`;
  };
  const up = () => {
    splitter.classList.remove('dragging');
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
});

void api.loadProjects().then((loaded) => {
  state = loaded;
  selectProject(state.projects.find((p) => p.id === state.lastProjectId) ?? state.projects[0] ?? null);
});
