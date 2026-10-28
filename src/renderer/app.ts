import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import type { HistoryEntry } from '../main/history';
import type { CommandButton, Placeholder, PlaceholderValues } from '../main/commands';
import type { JiraIssue } from '../main/jira';
import type { Project, ProjectsState } from '../main/projects';
import type { Mr, MrIntent, MrListResult, MrRef } from '../main/mrs';
import type { Task, TaskRef, TasksResult } from '../main/trackers';
import { basename, byId, el } from './dom';
import { ago } from './ago';
import { acceptsDrop, dropIntoSession } from './drop-path';
import { moveItem } from './reorder';
import { windowTitle } from './title';
import { canCreateWorkspace, fileAfterDir, fileAfterEdit, fileAfterName, initialFileField, projectsProblemText, type FileField } from './workspace-text';
import { initSourcesSection } from './sources';
import { CommandBars, type CommandTarget } from './command-bar';
import { pickPr } from './command-values';
import { initCommandEditor } from './command-editor';
import { initPromptEditor } from './prompt-editor';
import { ipcErrorText } from './ipc-error';
import { taskHeader } from './task-header';
import { decideStart, StartGuard, TaskSessionRegistry } from './task-flow';
import { findMr, mrSessionLabel, mrTooltip } from './mr-model';
import { returnTarget } from './panel-return';
import { RenderTickets } from './render-ticket';
import { asMenuItem, bindList, rove } from './list-keys';
import { bindTablist, markTab, selectTab } from './tabs';
import { TrackerPanel } from './panel';
import { StatusHub } from './status';
import { findTask, hasSources, sessionLabel, taskTooltip } from './task-model';
import { onThemeChange, sessionColor, terminalTheme } from './theme';
import { rootLabel as sessionRootLabel, treeRoots as sessionTreeRoots } from './roots';
import { bindTree, replaceTree, TreeView, type TreeRoot } from './tree';
import { applyMonacoFontSize, applyMonacoTheme, FileViewer } from './viewer';
import { DEFAULT_FONT_SIZE, loadFontSize, saveFontSize, stepFontSize, WheelStepper } from './font-size';
import { WaitNotifier } from './notify';
import { hasCommandKey, isClipboardKey, isMac, shortcut, type ModifierState } from './platform';
import { osc8Handler, termLinkProvider, type LinkOpeners } from './term-links';

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
  /** Задача Jira, из которой начата сессия; тоже только в памяти интерфейса. */
  jira?: JiraIssue;
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
  /** Полоса кнопок-команд этой сессии (фича 12). */
  command: CommandTarget;
}

const api = window.cyborg;
const notifier = new WaitNotifier(api);
const mac = isMac(api.platform);
const commandKey = (event: ModifierState): boolean => hasCommandKey(event, mac);
const newSessionShortcut = shortcut(mac, 'Shift', 'N');
const sidebar = byId('sidebar');
const projectSelect = byId<HTMLSelectElement>('project-select');
const treeEl = byId('tree');
bindTree(treeEl, 'Файлы');
const treeTitle = byId('tree-title');
const treeMeta = byId('tree-meta');
const treeBack = byId<HTMLButtonElement>('tree-back');
const sessionList = byId('session-list');
const newSessionButton = byId<HTMLButtonElement>('new-session');
newSessionButton.title = `Новая сессия Claude Code (${newSessionShortcut})`;
const sessionsEl = byId('sessions');
const empty = byId('empty');
const repoMenu = byId('repo-menu');
const filePreview = byId('file-preview');
// Без активной сессии дерево показывает репозитории проекта; раскрытие держится за проектом.
const projectTrees = new Map<string, TreeView>();
let preview: FileViewer | null = null;
const treeHeader = byId('tree-header');
const historyEl = byId('history');
const sideFiles = byId<HTMLButtonElement>('side-files');
const sideHistory = byId<HTMLButtonElement>('side-history');
const taskSessions = new TaskSessionRegistry<Session>();
const startGuard = new StartGuard();
const commandBars = new CommandBars({
  mac,
  send: (id, data) => api.input(id, data),
  layout: () => requestAnimationFrame(() => active && fitSession(active)),
});

let state: ProjectsState = { projects: [], lastProjectId: null };
let workspaceFile: string | null = null;
let workspaceName: string | null = null;
let project: Project | null = null;
const sessions: Session[] = [];
const lastSessionOf = new Map<string, Session>();
let active: Session | null = null;
let colorIndex = 0;
let fontSize = loadFontSize();
const treeTickets = new RenderTickets();
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
}

/** `save: false` - начальный выбор при загрузке: файл воркспейса создаётся действием оператора, а не стартом (ADR-0014 п.3). */
function selectProject(next: Project | null, save = true): void {
  project = next;
  state.lastProjectId = next?.id ?? null;
  if (save) persist();
  renderProjectSelect();
  document.title = windowTitle(__APP_VERSION__, next?.name ?? null, workspaceName);
  api.projectSelected(!!next);
  for (const s of sessions) s.stripTab.hidden = s.project !== next;
  newSessionButton.disabled = !next?.repos.length;
  const session = next ? (lastSessionOf.get(next.id) ?? sessions.find((s) => s.project === next)) : undefined;
  if (session) activateSession(session, panel.isOpen);
  else showNoSession();
  panel.setAvailable(hasSources(next));
  updateBackButton(active);
  panel.onProjectChanged();
  statusHub.onProjectChanged();
  if (!historyEl.hidden) void loadHistory();
}

/** Отказ записи не откатывает состояние в памяти: оператор не теряет ввод, но знает, что на диск он не лёг. */
function persist(): void {
  if (!workspaceFile) return;
  api.saveProjects(state).catch((error: Error) => {
    alert(`Не удалось сохранить проекты: ${error.message}. Изменения действуют до закрытия приложения, на диск они не записаны.`);
  });
}

const projectDialog = byId<HTMLDialogElement>('project-dialog');
const projectName = byId<HTMLInputElement>('project-name');
const projectDescription = byId<HTMLTextAreaElement>('project-description');
const projectRepos = byId('project-repos');
const projectDelete = byId<HTMLButtonElement>('project-delete');
const sources = initSourcesSection();

document.title = windowTitle(__APP_VERSION__, null, workspaceName);
let draft: Project | null = null;
let editing: Project | null = null;

function editProject(target: Project | null): void {
  editing = target;
  draft = target
    ? { ...target, repos: [...target.repos], trackers: { ...target.trackers }, jira: target.jira && { ...target.jira, projects: [...target.jira.projects] } }
    : { id: crypto.randomUUID(), name: '', description: '', repos: [], trackers: { github: false, gitlab: false } };
  byId('project-dialog-title').textContent = target ? 'Свойства проекта' : 'Новый проект';
  projectName.value = draft.name;
  projectDescription.value = draft.description;
  projectDelete.hidden = !target;
  renderDraftRepos();
  sources.open(draft.trackers, draft.jira, draft.repos);
  projectDialog.returnValue = '';
  projectDialog.showModal();
}

// Свой тип данных: строка репозитория не принимается зонами броска пути (acceptsDrop).
const REPO_INDEX_MIME = 'application/x-cyborg-repo-index';

function renderRepoList(container: HTMLElement, repos: string[], setRepos: (next: string[]) => void): void {
  container.replaceChildren(
    ...repos.map((repo, index) => {
      const item = el('li');
      item.append(el('span', 'repo-name', basename(repo)), el('span', 'repo-path', repo));
      item.draggable = repos.length > 1;
      item.title = item.draggable ? 'Перетащите, чтобы изменить порядок' : '';
      item.addEventListener('dragstart', (event) => {
        event.dataTransfer?.setData(REPO_INDEX_MIME, String(index));
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        item.classList.add('dragging');
      });
      item.addEventListener('dragend', () => item.classList.remove('dragging'));
      item.addEventListener('dragover', (event) => {
        if (!event.dataTransfer?.types.includes(REPO_INDEX_MIME)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        item.classList.add('drop-target');
      });
      item.addEventListener('dragleave', () => item.classList.remove('drop-target'));
      item.addEventListener('drop', (event) => {
        const from = Number(event.dataTransfer?.getData(REPO_INDEX_MIME));
        if (!event.dataTransfer?.types.includes(REPO_INDEX_MIME) || !Number.isInteger(from)) return;
        event.preventDefault();
        setRepos(moveItem(repos, from, index));
      });
      const remove = el('button', 'icon-button', '×');
      remove.title = 'Убрать из проекта';
      remove.addEventListener('click', () => setRepos(repos.filter((r) => r !== repo)));
      item.append(remove);
      return item;
    }),
  );
  if (!repos.length) container.append(el('li', 'hint', 'Репозиториев нет'));
}

/** Каталог репозитория из диалога выбора: корень git либо каталог как есть, если оператор подтвердил. */
async function pickRepo(near: string | undefined): Promise<string | null> {
  const dir = await api.pickDir(near);
  if (!dir) return null;
  const root = await api.gitRoot(dir);
  if (!root && !confirm(`${dir} не git-репозиторий: изменений в дереве не будет видно. Добавить всё равно?`)) return null;
  return root ?? dir;
}

function renderDraftRepos(): void {
  const current = draft;
  if (!current) return;
  renderRepoList(projectRepos, current.repos, (next) => {
    current.repos = next;
    renderDraftRepos();
  });
}

byId('project-add-repo').addEventListener('click', async () => {
  if (!draft) return;
  const repo = await pickRepo(draft.repos[0]);
  if (!repo || !draft) return;
  if (!draft.repos.includes(repo)) draft.repos.push(repo);
  renderDraftRepos();
});

projectDialog.addEventListener('close', () => {
  sources.close();
  if (projectDialog.returnValue !== 'save' || !draft) return;
  draft.name = projectName.value.trim();
  draft.description = projectDescription.value.trim();
  const read = sources.read();
  draft.trackers = read.trackers;
  draft.jira = read.jira;
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

// ---------- воркспейс ----------

const workspaceDialog = byId<HTMLDialogElement>('workspace-dialog');
const workspaceNameInput = byId<HTMLInputElement>('workspace-name');
const workspaceFileInput = byId<HTMLInputElement>('workspace-file');
const workspaceProjectInput = byId<HTMLInputElement>('workspace-project');
const workspaceReposEl = byId('workspace-repos');
const workspaceError = byId('workspace-error');
const workspaceCreate = byId<HTMLButtonElement>('workspace-create');
let workspaceRepos: string[] = [];
let workspaceHome = '';
let workspaceSep = '/';
let fileField: FileField = initialFileField('');

const workspaceDraft = () => ({ name: workspaceNameInput.value, file: workspaceFileInput.value, projectName: workspaceProjectInput.value, repos: workspaceRepos });

function refreshWorkspaceDialog(): void {
  workspaceCreate.disabled = !canCreateWorkspace(workspaceDraft());
  renderRepoList(workspaceReposEl, workspaceRepos, (next) => {
    workspaceRepos = next;
    refreshWorkspaceDialog();
  });
}

function showWorkspaceError(text: string): void {
  workspaceError.textContent = text;
  workspaceError.hidden = !text;
}

function openWorkspaceDialog(): void {
  if (workspaceDialog.open) return;
  workspaceNameInput.value = '';
  workspaceFileInput.value = '';
  workspaceProjectInput.value = '';
  workspaceRepos = [];
  fileField = initialFileField(workspaceHome);
  showWorkspaceError('');
  refreshWorkspaceDialog();
  workspaceDialog.returnValue = '';
  workspaceDialog.showModal();
}

workspaceNameInput.addEventListener('input', () => {
  fileField = fileAfterName(fileField, workspaceNameInput.value, workspaceSep);
  workspaceFileInput.value = fileField.value;
  refreshWorkspaceDialog();
});
workspaceFileInput.addEventListener('input', () => {
  fileField = fileAfterEdit(fileField, workspaceFileInput.value);
  refreshWorkspaceDialog();
});
workspaceProjectInput.addEventListener('input', refreshWorkspaceDialog);

byId('workspace-pick-dir').addEventListener('click', async () => {
  const current = workspaceFileInput.value;
  const dir = await api.pickWorkspaceDir(current ? current.slice(0, Math.max(current.lastIndexOf('/'), current.lastIndexOf('\\'))) || undefined : workspaceHome);
  if (!dir) return;
  fileField = fileAfterDir({ ...fileField, value: current }, workspaceNameInput.value, dir, workspaceSep);
  workspaceFileInput.value = fileField.value;
  refreshWorkspaceDialog();
});

byId('workspace-add-repo').addEventListener('click', async () => {
  const repo = await pickRepo(workspaceRepos[0]);
  if (!repo) return;
  if (!workspaceRepos.includes(repo)) workspaceRepos.push(repo);
  refreshWorkspaceDialog();
});

byId('workspace-cancel').addEventListener('click', () => workspaceDialog.close('cancel'));

workspaceCreate.addEventListener('click', async () => {
  const draftValue = workspaceDraft();
  if (!canCreateWorkspace(draftValue)) return;
  showWorkspaceError('');
  workspaceCreate.disabled = true;
  const request = {
    name: draftValue.name.trim(),
    file: draftValue.file.trim(),
    project: {
      id: crypto.randomUUID(),
      name: draftValue.projectName.trim(),
      description: '',
      repos: [...workspaceRepos],
      trackers: { github: false, gitlab: false },
    },
  };
  try {
    const reply = await api.createWorkspace(request);
    if (reply.exists) {
      if (confirm(`Файл ${request.file} уже есть и не будет перезаписан. Открыть его?`)) {
        if (await api.openWorkspace(request.file)) workspaceDialog.close('opened');
      }
    } else if (reply.error) showWorkspaceError(reply.error);
    else workspaceDialog.close('created');
  } catch (error) {
    showWorkspaceError((error as Error).message);
  } finally {
    refreshWorkspaceDialog();
  }
});

api.on<void>('menu:create-workspace', openWorkspaceDialog);
api.on<'new' | 'edit'>('menu:project', (kind) => {
  if (!workspaceFile) return;
  if (kind === 'new') editProject(null);
  else if (project) editProject(project);
});

// ---------- сессии ----------

const rootLabel = (s: Session): string => sessionRootLabel({ ...s, repos: s.project.repos });
const treeRoots = (s: Session): TreeRoot[] => sessionTreeRoots({ ...s, repos: s.project.repos });

const sessionTitle = (s: Session): string =>
  s.mr
    ? mrSessionLabel(s.id, s.mr)
    : s.task
      ? sessionLabel(s.id, s.task)
      : s.jira
        ? `CC${s.id} · ${s.jira.key} ${s.jira.summary}`
        : `CC${s.id} · ${rootLabel(s)}`;

/** Из сессии по MR или задаче - обратно к её строке в списке панели; кнопка видна, пока у проекта есть источники. */
function updateBackButton(s: Session | null): void {
  const target = s && panel.isAvailable ? returnTarget(s) : null;
  treeBack.hidden = !target;
  if (!target) return;
  treeBack.textContent = target.label;
  treeBack.title = target.title;
}

treeBack.addEventListener('click', () => {
  const target = active ? returnTarget(active) : null;
  if (target) panel.reveal(target.tab, target.key);
});

function updateSessionLabels(s: Session): void {
  const label = sessionTitle(s);
  const tooltip = s.mr ? mrTooltip(s.mr) : s.task ? taskTooltip(s.task) : s.jira ? `${s.jira.key} ${s.jira.summary}\nСтатус: ${s.jira.status || '—'}` : '';
  (s.stripTab.querySelector('.label') as HTMLElement).textContent = label;
  s.stripTab.title = tooltip ? `${tooltip}\n${s.cwd}` : s.cwd;
  s.stripTab.classList.toggle('exited', s.exited);
  if (s === active) {
    treeTitle.textContent = label;
    treeTitle.title = tooltip;
    // Шапка обрезает путь слева через direction: rtl; LRM не даёт ведущему «/» уехать в конец.
    treeMeta.textContent = `‎${s.exited ? `завершена · ${s.cwd}` : s.cwd}`;
    updateBackButton(s);
  }
}

/** Пояснение, пока нет проекта с репозиториями; общее для пустой области и панели задач. */
function projectHint(): string[] | null {
  if (!workspaceFile) return ['Воркспейс не открыт.', 'Меню «Воркспейс»: «Создать…» или «Открыть в новом окне…».'];
  if (!state.projects.length) return ['Проектов нет.', 'Меню «Воркспейс» - «Новый проект»: создайте проект и добавьте в него репозитории.'];
  if (!project?.repos.length) return ['В проекте нет репозиториев.', 'Меню «Воркспейс» - «Свойства проекта»: добавьте репозиторий.'];
  return null;
}

function showNoSession(): void {
  active = null;
  for (const s of sessions) {
    s.container.classList.remove('active');
    selectTab(s.stripTab, false);
  }
  sidebar.style.removeProperty('--session');
  treeTitle.textContent = project ? project.name : 'Нет проекта';
  treeTitle.title = '';
  treeMeta.textContent = project ? 'нет активной сессии' : '';
  updateBackButton(null);
  treeEl.replaceChildren();
  closePreview();
  const tree = projectTree();
  tree?.setRoots(project!.repos.map((repo) => ({ path: repo, label: basename(repo), hint: 'репозиторий проекта' })));
  void renderProjectTree(false);
  const hint = projectHint();
  const [title, text] = hint ?? ['Сессий пока нет', 'Claude Code запустится в репозитории проекта. Сессий можно открыть несколько, у каждой свой цвет.'];
  const nodes = [el('p', 'empty-title', title), el('p', 'empty-text', text)];
  if (!hint) {
    const start = el('button', 'primary empty-action', 'Новая сессия');
    start.append(el('kbd', '', newSessionShortcut));
    start.addEventListener('click', (event) => {
      // Иначе общий обработчик клика на document тут же закроет открытое меню репозиториев.
      event.stopPropagation();
      toggleSessionMenu(start);
    });
    nodes.push(start);
  }
  empty.replaceChildren(...nodes);
  empty.hidden = false;
}

function projectTree(): TreeView | null {
  const owner = project;
  if (!owner?.repos.length) return null;
  let tree = projectTrees.get(owner.id);
  if (!tree) {
    tree = new TreeView(
      (path, root) => void showPreview(path, root),
      () => void renderProjectTree(false),
      (root, anchor) => void showBranchMenu(root, anchor),
    );
    projectTrees.set(owner.id, tree);
  }
  return tree;
}

async function renderProjectTree(onlyIfChanged: boolean): Promise<void> {
  const tree = active ? null : projectTree();
  if (!tree) return;
  const ticket = treeTickets.take(onlyIfChanged);
  const fragment = await tree.render(onlyIfChanged);
  if (!fragment || !treeTickets.valid(ticket) || active || projectTree() !== tree) return;
  replaceTree(treeEl, fragment);
}

function fileHeader(path: string, root: TreeRoot): HTMLElement {
  const rel = path.startsWith(`${root.path}/`) ? path.slice(root.path.length + 1) : path;
  const header = el('div', 'file-header');
  const name = el('span', 'file-name', ` / ${rel}`);
  name.title = path;
  const reveal = el('button', 'file-reveal', 'Открыть в системе');
  reveal.title = 'Открыть файл приложением системы по умолчанию';
  reveal.addEventListener('click', () => void api.openPath(path));
  header.append(el('span', 'file-root', root.label), name, reveal);
  return header;
}

async function showPreview(path: string, root: TreeRoot): Promise<void> {
  closePreview();
  const header = fileHeader(path, root);
  const close = el('button', 'close', '×');
  close.title = 'Закрыть';
  close.addEventListener('click', () => closePreview());
  header.prepend(close);
  const body = el('div', 'file-body');
  filePreview.replaceChildren(header, body);
  filePreview.classList.add('active');
  empty.hidden = true;
  preview = new FileViewer(path, body);
  await preview.load();
}

function closePreview(): void {
  preview?.dispose();
  preview = null;
  filePreview.replaceChildren();
  filePreview.classList.remove('active');
  if (!active) empty.hidden = false;
}

function activateSession(s: Session, keepPanel = false): void {
  if (!keepPanel) panel.close();
  const same = s === active;
  closePreview();
  active = s;
  lastSessionOf.set(s.project.id, s);
  if (document.hasFocus()) notifier.dismiss(s.id);
  for (const other of sessions) {
    other.container.classList.toggle('active', other === s);
    selectTab(other.stripTab, other === s);
  }
  // Полоса прокручивается: при десятке сессий активная вкладка (новая, «К сессии», уведомление) была бы за краем.
  s.stripTab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  empty.hidden = true;
  sidebar.style.setProperty('--session', s.color);
  updateSessionLabels(s);
  s.tree.setRoots(treeRoots(s));
  // Своё дерево заменится готовым целиком; очистка нужна только против чужого, иначе дерево мигает до ответа git status.
  if (!same) treeEl.replaceChildren();
  void renderTree(s, false);
  showInner(s, s.activeFile);
}

function showInner(s: Session, file: FileTab | null): void {
  s.activeFile = file;
  selectTab(s.claudeTab, !file);
  s.termPane.classList.toggle('active', !file);
  for (const f of s.files) {
    selectTab(f.tab, f === file);
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
  const ticket = treeTickets.take(onlyIfChanged);
  const fragment = await s.tree.render(onlyIfChanged);
  if (!fragment || !treeTickets.valid(ticket) || s !== active) return;
  replaceTree(treeEl, fragment);
}

function fitSession(s: Session): void {
  if (s !== active || s.activeFile) return;
  s.fit.fit();
  api.resize(s.id, s.term.cols, s.term.rows);
}

function makeTab(className: string, label: string, onClose?: () => void): HTMLElement {
  const tab = markTab(el('div', `tab ${className}`));
  tab.append(el('span', 'icon'), el('span', 'label', label));
  if (onClose) {
    const close = el('button', 'close', '×');
    close.title = 'Закрыть';
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      onClose();
    });
    tab.append(close);
    // Без preventDefault средняя кнопка включает автопрокрутку Chromium.
    tab.addEventListener('mousedown', (event) => {
      if (event.button === 1) event.preventDefault();
    });
    tab.addEventListener('auxclick', (event) => {
      if (event.button !== 1) return;
      event.preventDefault();
      onClose();
    });
  }
  return tab;
}

const linkOpeners: LinkOpeners = { openPath: (path) => void api.openPath(path), openUrl: (url) => void api.openUrl(url) };

function createTerminal(id: number): Terminal {
  const term = new Terminal({
    fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, 'DejaVu Sans Mono', 'Ubuntu Mono', monospace",
    fontSize,
    scrollback: 10000,
    // Claude Code сам рисует выделение фоном ANSI blue, не меняя цвет текста - без поправки текст сливается с фоном.
    minimumContrastRatio: 4.5,
    theme: terminalTheme(),
    linkHandler: osc8Handler(linkOpeners),
  });
  term.registerLinkProvider(termLinkProvider(term, linkOpeners));
  term.onData((data) => {
    // Прерывание хода Stop-хук не шлёт; ложное снятие (Esc закрыл подсказку) вернёт следующий PostToolUse.
    if (data === '\x1b' || data === '\x03') findSession(id)?.stripTab.classList.remove('busy');
    api.input(id, data);
  });
  term.attachCustomKeyEventHandler((event) => {
    // Claude Code понимает ESC+CR как перевод строки; keypress гасится, иначе xterm шлёт по нему свой \r и промпт уходит.
    if (event.key === 'Enter' && event.shiftKey && !event.ctrlKey && !event.altKey) {
      if (event.type === 'keydown') api.input(id, '\x1b\r');
      return false;
    }
    if (event.type !== 'keydown') return true;
    // На macOS Cmd+C/V выполняют пункты меню Electron (Copy/Paste): xterm копирует выделение и принимает вставку сам.
    if (!mac && isClipboardKey(event, 'KeyC')) {
      const selection = term.getSelection();
      if (selection) void navigator.clipboard.writeText(selection);
      return false;
    }
    if (!mac && isClipboardKey(event, 'KeyV')) {
      void navigator.clipboard.readText().then((text) => term.paste(text));
      return false;
    }
    return true;
  });
  return term;
}

type StartFrom = { task: Task } | { mr: Mr; intent: MrIntent } | { jira: JiraIssue };

const refOf = (x: MrRef): MrRef => ({ kind: x.kind, host: x.host, path: x.path, number: x.number });

async function newSession(repo: string, start?: StartFrom): Promise<void> {
  const owner = project;
  if (!owner) return;
  const key = start && ('task' in start ? start.task.key : 'mr' in start ? start.mr.key : `jira:${start.jira.key}`);
  // Ключ держится до появления сессии в taskSessions: двойной клик «Начать» не создаст вторую.
  if (key) {
    if (!startGuard.begin(owner.id, key)) return;
  }
  try {
    await createSessionView(owner, repo, start);
  } catch (error) {
    // Сессия не стартовала (например, негодный промпт кнопки в файле воркспейса): причина названа, а не потеряна в консоли.
    alert(ipcErrorText(error));
  } finally {
    if (key) startGuard.end(owner.id, key);
  }
}

async function createSessionView(owner: Project, repo: string, start?: StartFrom, resume?: string): Promise<void> {
  const addDirs = owner.repos.filter((r) => r !== repo);
  // В канал идут только ссылка и намерение: название, ветки и автор в первое сообщение не попадают.
  const id = resume
    ? await api.resumeSession(repo, addDirs, resume)
    : await api.createSession(
        repo,
        addDirs,
        start && ('task' in start ? { task: refOf(start.task) } : 'mr' in start ? { mr: refOf(start.mr), intent: start.intent } : { jira: { key: start.jira.key } }),
      );
  const root = (await api.gitRoot(repo)) ?? repo;
  const color = sessionColor(colorIndex++);
  const term = createTerminal(id);
  const fit = new FitAddon();
  term.loadAddon(fit);

  const container = el('div', 'workspace-pane');
  container.style.setProperty('--session', color);
  const innerTabs = el('nav', 'inner-tabs');
  bindTablist(innerTabs, 'Вкладки сессии');
  const innerPanes = el('div', 'inner-panes');
  const termPane = el('div', 'pane terminal');
  const host = el('div', 'term-host');
  termPane.append(host);
  innerPanes.append(termPane);
  if (start && 'task' in start) container.append(taskHeader(start.task, () => requestAnimationFrame(() => fitSession(session))));
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
    jira: start && 'jira' in start ? start.jira : undefined,
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
    command: {
      id,
      isExited: () => session.exited,
      values: (needs) => commandValues(session, needs),
      focus: () => session.term.focus(),
    },
  };
  container.append(commandBars.attach(session.command));
  stripTab.addEventListener('click', () => activateSession(session));
  claudeTab.addEventListener('click', () => showInner(session, null));
  bindPathDrop(session, termPane);
  bindPathDrop(session, claudeTab);
  sessions.push(session);
  taskSessions.add(session);
  updateSessionLabels(session);
  for (const chunk of pendingData.get(id) ?? []) term.write(chunk);
  pendingData.delete(id);
  // Невидимая сессия не получает fit до активации: pty стартует 120x40, а xterm скрыт и остаётся 80x24, поэтому размеры выравниваются сразу.
  const alignHidden = (): void => api.resize(id, term.cols, term.rows);
  if (project !== owner) {
    stripTab.hidden = true;
    alignHidden();
  } else if (start && panel.isOpen) {
    // Начатая из открытой панели сессия не уводит с панели: пользователь идёт по задачам дальше.
    if (!active) activateSession(session, true);
    else alignHidden();
    panel.repaint();
  } else activateSession(session);
}

/** PR/MR сессии: из которого она начата, иначе открытый PR/MR ветки сессии среди всех PR/MR проекта (свой приоритетнее чужого). */
async function prOfSession(s: Session, branch: string | null): Promise<string> {
  if (s.mr) return s.mr.url;
  if (!branch) throw new Error('у сессии нет ветки git');
  const list = await api.listMrs(s.project.id, 'all', [], false);
  if (list.error) throw new Error(`не удалось получить PR/MR: ${list.error}`);
  if (!list.enabled.github && !list.enabled.gitlab) throw new Error('в проекте не включены GitHub и GitLab: PR/MR не найти');
  const picked = pickPr(list.mrs, branch, s.repo);
  if ('reason' in picked) throw new Error(picked.reason);
  return picked.url;
}

/** Подстановки кнопок-команд (FR-12003): ветка - git сессии сейчас, PR - начальный либо найденный по ветке, задача - из которой начата сессия. */
async function commandValues(s: Session, needs: Placeholder[]): Promise<PlaceholderValues> {
  const values: PlaceholderValues = {};
  const branch = needs.includes('branch') || needs.includes('pr') ? await api.gitBranch(s.root) : null;
  if (needs.includes('branch')) values.branch = branch;
  if (needs.includes('task')) values.task = s.jira ? s.jira.key : (s.task?.url ?? null);
  if (needs.includes('pr')) values.pr = await prOfSession(s, branch);
  return values;
}

/** Зона броска пути: терминал и вкладка Claude. Файл ОС и строка дерева вставляются через term.paste, как вставка с клавиатуры. */
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
  notifier.dismiss(s.id);
  commandBars.detach(s.command);
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
  panel.repaint();
}

function openFile(s: Session, path: string, root: TreeRoot): void {
  const existing = s.files.find((f) => f.viewer.path === path);
  if (existing) {
    showInner(s, existing);
    return;
  }
  const pane = el('div', 'pane file');
  const header = fileHeader(path, root);
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
api.on<{ id: number; event?: string }>('session:activity', ({ id, event }) => {
  if (event === 'UserPromptSubmit') {
    notifier.dismiss(id);
    // Запрос человека делает прежние предложения модели неактуальными.
    const asked = findSession(id);
    if (asked) commandBars.suggest(asked.command, []);
  }
  if (event === 'UserPromptSubmit' || event === 'PostToolUse') findSession(id)?.stripTab.classList.add('busy');
  if (active?.id !== id) return;
  const session = active;
  clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => void renderTree(session, false), 250);
});

api.on<{ id: number; buttons: CommandButton[] }>('session:suggest', ({ id, buttons }) => {
  const session = findSession(id);
  if (session) commandBars.suggest(session.command, buttons);
});

api.on<boolean>('notifications:toggle', (enabled) => notifier.setEnabled(enabled));

api.on<{ id: number; reason: string }>('session:waiting', ({ id, reason }) => {
  const session = findSession(id);
  session?.stripTab.classList.remove('busy');
  if (session) notifier.waiting(id, `${sessionTitle(session)} · ${session.project.name}`, reason, session === active && document.hasFocus());
});

api.on<{ id: number }>('session:reveal', ({ id }) => {
  const session = findSession(id);
  if (!session) return;
  // Иначе выбор проекта сначала открыл бы его последнюю сессию и погасил её уведомление, которого человек не видел.
  lastSessionOf.set(session.project.id, session);
  if (session.project !== project) selectProject(session.project);
  else activateSession(session, panel.isOpen);
});

window.addEventListener('focus', () => {
  if (active) notifier.dismiss(active.id);
});

api.on<{ id: number; exitCode: number }>('session:exit', ({ id, exitCode }) => {
  const session = findSession(id);
  if (!session) return;
  session.exited = true;
  commandBars.refresh(session.command);
  session.stripTab.classList.remove('busy');
  notifier.dismiss(id);
  session.term.write(`\r\n\x1b[2m[сессия завершена, код ${exitCode}]\x1b[0m\r\n`);
  updateSessionLabels(session);
});

// Правки вне хуков (руками, другим процессом) подхватываются опросом git status.
setInterval(() => {
  if (document.hidden) return;
  if (active) void renderTree(active, true);
  else {
    void renderProjectTree(true);
    if (preview) void preview.load();
  }
}, 3000);

// ---------- запуск сессии ----------

/** Меню выбора закрыто Escape либо выбором: фокус возвращается на кнопку, которая его открыла. */
let menuOpener: HTMLElement | null = null;

function closeRepoMenu(restoreFocus: boolean): void {
  const hadFocus = repoMenu.contains(document.activeElement);
  repoMenu.hidden = true;
  if (restoreFocus && hadFocus && menuOpener?.isConnected) menuOpener.focus();
  menuOpener = null;
}

function openRepoMenu(anchor: HTMLElement, label: string, focus: 'first' | 'none'): void {
  const rect = anchor.getBoundingClientRect();
  repoMenu.setAttribute('role', 'menu');
  repoMenu.setAttribute('aria-label', label);
  menuOpener = anchor;
  repoMenu.style.top = `${rect.bottom + 2}px`;
  repoMenu.hidden = false;
  rove(repoMenu, '.menu-item');
  if (focus === 'first') repoMenu.querySelector<HTMLElement>('.menu-item')?.focus();
}

function showRepoMenu(repos: string[], anchor: HTMLElement, title: string, onPick: (repo: string) => void): void {
  repoMenu.replaceChildren(
    el('div', 'menu-title', title),
    ...repos.map((repo) => {
      const item = asMenuItem(el('div', 'menu-item'));
      item.append(el('span', 'repo-name', basename(repo)), el('span', 'repo-path', repo));
      item.addEventListener('click', () => {
        closeRepoMenu(true);
        onPick(repo);
      });
      return item;
    }),
  );
  const rect = anchor.getBoundingClientRect();
  repoMenu.style.left = '';
  repoMenu.style.right = `${window.innerWidth - rect.right}px`;
  openRepoMenu(anchor, title, 'first');
}

async function showBranchMenu(root: TreeRoot, anchor: HTMLElement): Promise<void> {
  const { current, local, remote } = await api.gitBranches(root.path);
  const filter = document.createElement('input');
  filter.className = 'menu-filter';
  filter.placeholder = 'Найти ветку';
  const error = el('div', 'tasks-error');
  error.hidden = true;
  const list = el('div', 'branch-list');
  const all = [...local.map((name) => ({ name, remote: false })), ...remote.map((name) => ({ name, remote: true }))];
  let shown = all;
  const pick = async (name: string): Promise<void> => {
    if (name === current) return;
    const res = await api.gitSwitch(root.path, name);
    if (res.error) {
      error.textContent = `Ветка не сменилась: ${res.error}`;
      error.hidden = false;
      return;
    }
    closeRepoMenu(true);
    void renderProjectTree(false);
  };
  const draw = (): void => {
    const query = filter.value.trim().toLowerCase();
    shown = all.filter((b) => b.name.toLowerCase().includes(query));
    list.replaceChildren(
      ...shown.slice(0, 200).map(({ name, remote: fromRemote }) => {
        const item = asMenuItem(el('div', `menu-item branch-item${name === current ? ' current' : ''}`), 'menuitemradio');
        item.setAttribute('aria-checked', String(name === current));
        item.append(el('span', '', `${name === current ? '✓ ' : ''}${name}`));
        if (fromRemote) item.append(el('span', 'repo-path', 'только на сервере'));
        item.addEventListener('click', () => void pick(name));
        return item;
      }),
    );
    if (!shown.length) list.append(el('div', 'menu-title', 'Нет веток'));
    rove(list, '.menu-item');
  };
  filter.addEventListener('input', draw);
  filter.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && shown[0]) void pick(shown[0].name);
  });
  draw();
  repoMenu.replaceChildren(el('div', 'menu-title', `Ветка ${root.label}`), filter, error, list);
  const rect = anchor.getBoundingClientRect();
  repoMenu.style.right = '';
  repoMenu.style.left = `${rect.left}px`;
  openRepoMenu(anchor, `Ветка ${root.label}`, 'none');
  filter.focus();
}

/** Кнопка «Новая сессия» (в полосе или на пустом экране): повторное нажатие при открытом меню закрывает его. */
function toggleSessionMenu(anchor: HTMLElement): void {
  if (repoMenu.hidden) requestSession(anchor);
  else closeRepoMenu(true);
}

function requestSession(anchor: HTMLElement = newSessionButton): void {
  const repos = project?.repos ?? [];
  if (repos.length === 1) {
    void newSession(repos[0]);
    return;
  }
  if (!repos.length) return;
  showRepoMenu(repos, anchor, 'Где запустить Claude Code', (repo) => void newSession(repo));
}

// ---------- прошлые сессии ----------

function renderHistory(owner: Project, entries: HistoryEntry[] | string): void {
  if (typeof entries === 'string') {
    historyEl.replaceChildren(el('div', 'menu-title', entries));
    return;
  }
  historyEl.replaceChildren(
    ...entries.map((entry) => {
      const item = asMenuItem(el('div', 'menu-item history-item'), 'option');
      item.title = `Продолжить: ${entry.title}`;
      const remove = el('button', 'close', '×');
      remove.title = 'Удалить сессию (Delete)';
      // Запись в порядке табуляции одна, поэтому кнопка удаления с клавиатуры - Delete на записи.
      remove.tabIndex = -1;
      remove.addEventListener('click', (event) => {
        event.stopPropagation();
        if (!confirm(`Удалить сессию «${entry.title}»? Её журнал будет стёрт, продолжить её станет нельзя.`)) return;
        api
          .deleteHistory(owner.id, entry.repo, entry.id)
          .then(() => item.remove())
          .catch((err) => alert(String(err)));
      });
      item.append(
        el('span', 'history-title', entry.title),
        el('span', 'repo-path', `${basename(entry.repo)} · ${ago(entry.updated, Date.now())}`),
        remove,
      );
      item.addEventListener('click', () => void createSessionView(owner, entry.repo, undefined, entry.id).catch((err) => alert(String(err))));
      item.addEventListener('keydown', (event) => {
        if (event.target === item && event.key === 'Delete') {
          event.preventDefault();
          remove.click();
        }
      });
      return item;
    }),
  );
  rove(historyEl, '.history-item');
}

async function loadHistory(): Promise<void> {
  const owner = project;
  if (!owner) {
    historyEl.replaceChildren(el('div', 'menu-title', 'Нет проекта'));
    return;
  }
  if (!historyEl.childElementCount) renderHistory(owner, 'Загрузка…');
  const entries = await api.listHistory(owner.id).catch((err) => String(err));
  if (project !== owner) return;
  renderHistory(owner, typeof entries === 'string' || entries.length ? entries : 'Прошлых сессий нет');
}

function showSideView(history: boolean): void {
  selectTab(sideFiles, !history);
  selectTab(sideHistory, history);
  treeHeader.hidden = treeEl.hidden = history;
  historyEl.hidden = !history;
  if (history) void loadHistory();
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

/** Сессия по задаче Jira: повторное действие возвращает к открытой; репозиторий - у связанного MR из проекта, иначе единственный либо по выбору. */
function startJira(issue: JiraIssue, linked: Mr | undefined, anchor: HTMLElement): void {
  if (!project) return;
  const existing = taskSessions.get(project.id, `jira:${issue.key}`);
  const { repos } = project;
  const ofMr = linked?.repos.filter((repo) => repos.includes(repo)) ?? [];
  const decision = decideStart(!!existing, ofMr.length ? ofMr : repos, repos);
  if (decision.action === 'switch' && existing) activateSession(existing);
  else if (decision.action === 'create') void newSession(decision.repo, { jira: issue });
  else if (decision.action === 'menu') showRepoMenu(decision.repos, anchor, 'Где начать задачу', (repo) => void newSession(repo, { jira: issue }));
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

const panel = new TrackerPanel({
  tasks: {
    project: () => project,
    projectHint,
    trackedRefs,
    applyStatuses,
    sessionOf: (key) => (project ? taskSessions.get(project.id, key) : undefined),
    startTask,
  },
  mrs: {
    project: () => project,
    projectHint,
    trackedRefs: trackedMrRefs,
    applyStatuses: applyMrStatuses,
    sessionOf: (key) => (project ? taskSessions.get(project.id, key) : undefined),
    startMr,
  },
  onClosed: () =>
    requestAnimationFrame(() => {
      if (!active) return;
      fitSession(active);
      if (!active.activeFile) active.term.focus();
    }),
});

const statusHub = new StatusHub({
  project: () => project,
  sessionOf: (key) => (project ? taskSessions.get(project.id, key) : undefined),
  startMr,
  startJira,
});

newSessionButton.addEventListener('click', (event) => {
  event.stopPropagation();
  toggleSessionMenu(newSessionButton);
});
bindTablist(byId('side-tabs'), 'Боковая панель');
bindTablist(sessionList, 'Сессии');
selectTab(sideFiles, true);
selectTab(sideHistory, false);
sideFiles.addEventListener('click', () => showSideView(false));
sideHistory.addEventListener('click', () => showSideView(true));
bindList(repoMenu, '.menu-item');
historyEl.setAttribute('role', 'listbox');
historyEl.setAttribute('aria-label', 'Прошлые сессии');
bindList(historyEl, '.history-item');
document.addEventListener('click', (event) => {
  if (!repoMenu.contains(event.target as Node)) closeRepoMenu(false);
});
window.addEventListener(
  'keydown',
  (event) => {
    if (commandBars.handleKey(event, active && !panel.isOpen ? active.command : null)) return;
    if (event.key === 'Escape' && !repoMenu.hidden) closeRepoMenu(true);
    if (commandKey(event) && !event.shiftKey && !event.altKey && event.key === '0') {
      event.preventDefault();
      event.stopPropagation();
      setFontSize(DEFAULT_FONT_SIZE);
    }
    if (commandKey(event) && event.shiftKey && event.code === 'KeyN') {
      event.preventDefault();
      event.stopPropagation();
      requestSession();
    }
  },
  true,
);

// ---------- окно ----------

function setFontSize(size: number): void {
  if (size === fontSize) return;
  fontSize = size;
  saveFontSize(size);
  for (const s of sessions) s.term.options.fontSize = size;
  applyMonacoFontSize(size);
  zoomTree();
  if (active) fitSession(active);
}

// zoom, а не font-size: высоты строк и бейджи дерева заданы в px и масштабируются вместе с текстом.
function zoomTree(): void {
  treeEl.style.zoom = String(fontSize / DEFAULT_FONT_SIZE);
}
zoomTree();

// В capture до xterm: иначе колесо с клавишей команд прокрутит историю терминала.
const wheelSteps = new WheelStepper();
window.addEventListener(
  'wheel',
  (event) => {
    if (!commandKey(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setFontSize(stepFontSize(fontSize, wheelSteps.push(event.deltaY, event.timeStamp)));
  },
  { capture: true, passive: false },
);

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

// Кнопки-команды живут в файле воркспейса: правка в нём (редактором Cyborg или чужим) подхватывается без перезапуска (FR-12006).
function reloadCommands(): Promise<void> {
  return api.loadCommands().then((raw) => commandBars.setConfig(raw));
}
window.addEventListener('focus', () => void reloadCommands());
const commandEditor = initCommandEditor({ problems: () => commandBars.configProblems, saved: () => void reloadCommands() });
api.on<void>('menu:commands', () => void commandEditor.open());
const promptEditor = initPromptEditor();
api.on<void>('menu:prompts', () => void promptEditor.open());

void Promise.all([api.workspaceInfo(), api.loadProjects()]).then(async ([info, loaded]) => {
  workspaceFile = info.file;
  workspaceName = info.name;
  workspaceHome = info.home;
  workspaceSep = info.sep;
  state = loaded;
  void reloadCommands();
  const problem = await api.projectsProblem();
  selectProject(state.projects.find((p) => p.id === state.lastProjectId) ?? state.projects[0] ?? null, false);
  if (problem) alert(projectsProblemText(problem, workspaceFile));
  if (!workspaceFile) openWorkspaceDialog();
});
