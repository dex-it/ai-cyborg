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
import { clickSelection, sessionsCount } from './selection';
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
import { neighborAfterClose } from './neighbor';
import { returnTarget } from './panel-return';
import { RenderTickets } from './render-ticket';
import { asMenuItem, bindList, rove } from './list-keys';
import { bindTabDrag, bindTablist, markTab, selectTab } from './tabs';
import { ExtensionsDialog, type ExtensionsTab } from './extensions-dialog';
import { SearchDialog, type SearchMode } from './search-dialog';
import { TrackerPanel } from './panel';
import { StatusHub } from './status';
import { findTask, hasSources, sessionLabel, taskTooltip } from './task-model';
import { onThemeChange, sessionColor, terminalTheme } from './theme';
import { rootLabel as sessionRootLabel, treeRoots as sessionTreeRoots } from './roots';
import { bindTree, replaceTree, TreeView, type TreeRoot } from './tree';
import { applyMonacoFontSize, applyMonacoTheme, FileViewer, type Viewer } from './viewer';
import { MarkdownViewer } from './md-viewer';
import { isMarkdown } from './md-links';
import { localFs, remoteFs, type FsPort } from './fs-port';
import type { ClaudeTokenStatus } from '../main/remote/claude-token';
import { diskRows, diskSummary, purgeCalls, purgePlan, purgeReport } from './host-disk';
import { formatBytes, type HostDisk } from '../shared/host-disk';
import type { RemoteInfo } from '../main/remote/remote-sessions';
import { DEFAULT_FONT_SIZE, loadFontSize, saveFontSize, stepFontSize, WheelStepper } from './font-size';
import { WaitNotifier } from './notify';
import { hasCommandKey, isClipboardKey, isMac, shortcut, type ModifierState } from './platform';
import { osc8Handler, termLinkProvider, type LinkOpeners } from './term-links';

interface FileTab {
  viewer: Viewer;
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
  /** Удалённая сессия: дерево и просмотр читают клоны на хосте, правки и смены ветки нет. */
  remote?: { host: string; roots: string[]; online: boolean; reported: boolean; fs: FsPort };
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
const startMenuButton = byId<HTMLButtonElement>('new-session-more');
newSessionButton.title = `Новая сессия Claude Code (${newSessionShortcut})`;
const sessionsEl = byId('sessions');
const empty = byId('empty');
const repoMenu = byId('repo-menu');
const filePreview = byId('file-preview');
// Без активной сессии дерево показывает репозитории проекта; раскрытие держится за проектом.
const projectTrees = new Map<string, TreeView>();
let preview: Viewer | null = null;
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
  startMenuButton.hidden = !next?.hosts?.length;
  startMenuButton.disabled = !next?.repos.length;
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
const projectHosts = byId<HTMLInputElement>('project-hosts');
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
  projectHosts.value = (draft.hosts ?? []).join(' ');
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
  const hosts = projectHosts.value.split(/[\s,]+/).filter(Boolean);
  draft.hosts = hosts.length ? [...new Set(hosts)] : undefined;
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

const rootLabel = (s: Session): string => (s.remote ? basename(s.root) : sessionRootLabel({ ...s, repos: s.project.repos }));
const treeRoots = (s: Session): TreeRoot[] =>
  s.remote
    ? s.remote.roots.map((path) => ({ path, label: basename(path), hint: `клон на ${s.remote?.host}` }))
    : sessionTreeRoots({ ...s, repos: s.project.repos });

const sessionTitle = (s: Session): string =>
  s.mr
    ? mrSessionLabel(s.id, s.mr)
    : s.task
      ? sessionLabel(s.id, s.task)
      : s.jira
        ? `CC${s.id} · ${s.jira.key} ${s.jira.summary}`
        : s.remote
          ? `CC${s.id} · ${s.remote.host}${remoteNote(s.remote)}`
          : `CC${s.id} · ${rootLabel(s)}`;

const remoteNote = (r: NonNullable<Session['remote']>): string => `${r.reported ? ' · итог сдан' : ''}${r.online ? '' : ' · нет связи'}`;

/** Подпись вкладки и шапки дерева: у удалённой - значок и плашка хоста, чтобы её не спутать с локальной (D-33). */
function fillLabel(target: HTMLElement, s: Session, label: string): void {
  if (!s.remote) return void (target.textContent = label);
  target.replaceChildren(el('span', 'remote-mark', '⇄'), `CC${s.id} `, el('span', 'host-chip', s.remote.host), remoteNote(s.remote));
}

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
  fillLabel(s.stripTab.querySelector('.label') as HTMLElement, s, label);
  s.stripTab.title = tooltip ? `${tooltip}\n${s.cwd}` : s.cwd;
  s.stripTab.classList.toggle('exited', s.exited);
  s.stripTab.classList.toggle('remote', !!s.remote);
  s.stripTab.classList.toggle('offline', !!s.remote && !s.remote.online && !s.exited);
  if (s === active) {
    const title = el('span', 'title-text');
    fillLabel(title, s, label);
    treeTitle.replaceChildren(title);
    treeTitle.title = tooltip || label;
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

/** Markdown рендерится и правится по кнопке; ссылка документа открывает файл там же, где открылся бы файл из дерева. */
function createViewer(path: string, body: HTMLElement, root: TreeRoot, onDirty: (dirty: boolean) => void = () => {}, remote?: FsPort): Viewer {
  if (remote) return new FileViewer(path, body, remote);
  if (!isMarkdown(path)) return new FileViewer(path, body);
  return new MarkdownViewer(path, body, root.path, {
    saveKey: shortcut(mac, 'S'),
    dirtyChanged: onDirty,
    open: (link) => {
      if (link.kind === 'web') void api.openUrl(link.url);
      else if (link.kind === 'file') openAnywhere(link.path, root, link.line);
    },
  });
}

function openAnywhere(path: string, root: TreeRoot, line?: number): void {
  if (active) openFile(active, path, root, line);
  else void showPreview(path, root, line);
}

function fileHeader(path: string, root: TreeRoot, actions: HTMLElement, remote = false): HTMLElement {
  const rel = path.startsWith(`${root.path}/`) ? path.slice(root.path.length + 1) : path;
  const header = el('div', 'file-header');
  const name = el('span', 'file-name', ` / ${rel}`);
  name.title = path;
  const reveal = el('button', 'file-reveal', 'Открыть в системе');
  reveal.title = 'Открыть файл приложением системы по умолчанию';
  reveal.addEventListener('click', () => void api.openPath(path));
  header.append(el('span', 'file-root', root.label), name, actions);
  if (!remote) header.append(reveal);
  return header;
}

async function showPreview(path: string, root: TreeRoot, line?: number): Promise<void> {
  closePreview();
  const body = el('div', 'file-body');
  const viewer = createViewer(path, body, root);
  const header = fileHeader(path, root, viewer.actions);
  const close = el('button', 'close', '×');
  close.title = 'Закрыть';
  close.addEventListener('click', () => closePreview());
  header.prepend(close);
  filePreview.replaceChildren(header, body);
  filePreview.classList.add('active');
  empty.hidden = true;
  preview = viewer;
  await viewer.load();
  if (line !== undefined) void viewer.reveal(line);
}

function closePreview(): void {
  preview?.close();
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
  // Завершившуюся удалённую сессию главный процесс уже забыл: опрос хоста давал бы только ошибки «Сессия не удалённая».
  if (s.remote && s.exited) {
    treeTickets.take(false);
    return void treeEl.replaceChildren(el('div', 'menu-title', `Сессия на ${s.remote.host} завершена: её файлы больше недоступны`));
  }
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

type TrackerStart = { task: Task } | { mr: Mr; intent: MrIntent } | { jira: JiraIssue };
/** handoff - задача, переданная другой сессией через MCP Cyborg: её текст держит главный процесс. */
type StartFrom = TrackerStart | { handoff: string };

const refOf = (x: MrRef): MrRef => ({ kind: x.kind, host: x.host, path: x.path, number: x.number });

async function newSession(repo: string, start?: TrackerStart): Promise<void> {
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

async function createSessionView(owner: Project, repo: string, start?: StartFrom, resume?: string, remote?: RemoteInfo): Promise<void> {
  const addDirs = owner.repos.filter((r) => r !== repo);
  // В канал идут только ссылка и намерение: название, ветки и автор в первое сообщение не попадают.
  const id = remote
    ? remote.id
    : resume
    ? await api.resumeSession(repo, addDirs, resume)
    : await api.createSession(
        repo,
        addDirs,
        start &&
          ('handoff' in start
            ? { handoff: start.handoff }
            : 'task' in start
              ? { task: refOf(start.task) }
              : 'mr' in start
                ? { mr: refOf(start.mr), intent: start.intent }
                : { jira: { key: start.jira.key } }),
      );
  const root = remote ? remote.cwd : ((await api.gitRoot(repo)) ?? repo);
  const color = sessionColor(colorIndex++);
  const term = createTerminal(id);
  const fit = new FitAddon();
  term.loadAddon(fit);

  const container = el('div', 'workspace-pane');
  container.style.setProperty('--session', color);
  const innerTabs = el('nav', 'inner-tabs');
  bindTablist(innerTabs, 'Вкладки сессии');
  bindTabDrag(innerTabs, (from, to) => {
    session.files = moveItem(
      session.files,
      session.files.findIndex((f) => f.tab === from),
      session.files.findIndex((f) => f.tab === to),
    );
    innerTabs.append(...session.files.map((f) => f.tab));
  });
  const innerPanes = el('div', 'inner-panes');
  const termPane = el('div', 'pane terminal');
  const host = el('div', 'term-host');
  termPane.append(host);
  innerPanes.append(termPane);
  if (start && 'task' in start) container.append(taskHeader(start.task, () => requestAnimationFrame(() => fitSession(session))));
  container.append(innerTabs, innerPanes);
  sessionsEl.append(container);
  term.open(host);
  for (const note of remote?.notes ?? []) term.write(`\x1b[2mCyborg: ${note}\x1b[0m\r\n`);

  const stripTab = makeTab('session', '', () => closeSession(session, false));
  stripTab.draggable = true;
  stripTab.style.setProperty('--session', color);
  sessionList.append(stripTab);
  const claudeTab = makeTab('claude', 'Claude');
  innerTabs.append(claudeTab);

  const session: Session = {
    id,
    project: owner,
    repo,
    cwd: remote ? remote.cwd : repo,
    root,
    exited: false,
    remote: remote && { host: remote.host, roots: remote.roots, online: true, reported: remote.reported === true, fs: remoteFs(id) },
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
      undefined,
      remote ? remoteFs(id) : localFs,
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
  if (remote?.size) term.resize(remote.size.cols, remote.size.rows);
  for (const chunk of pendingData.get(id) ?? []) term.write(chunk);
  pendingData.delete(id);
  // Невидимая сессия не получает fit до активации: pty стартует 120x40, а xterm скрыт и остаётся 80x24, поэтому размеры выравниваются сразу.
  const alignHidden = (): void => api.resize(id, term.cols, term.rows);
  if (project !== owner) {
    stripTab.hidden = true;
    alignHidden();
  } else if (start && (panel.isOpen || 'handoff' in start)) {
    // Начатая из открытой панели сессия не уводит с панели, переданная другой сессией - от неё: человек переключается сам.
    if (!active) activateSession(session, true);
    else alignHidden();
    if (panel.isOpen) panel.repaint();
  } else activateSession(session);
}

/** PR/MR сессии: из которого она начата, иначе открытый PR/MR ветки сессии среди всех PR/MR проекта (свой приоритетнее чужого). */
async function prOfSession(s: Session, branch: string | null): Promise<string> {
  if (s.mr) return s.mr.url;
  if (s.remote) throw new Error('PR удалённой сессии Cyborg не ищет: репозитории на хосте не входят в локальные трекеры');
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
  const branch = needs.includes('branch') || needs.includes('pr') ? await (s.remote?.fs ?? localFs).branch(s.root) : null;
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
  if (s.remote && !s.exited && !force) {
    if (!s.remote.online) return void alert(`Нет связи с ${s.remote.host}: закрыть сессию можно после переподключения.`);
    if (!confirm(`Завершить удалённую сессию на ${s.remote.host} и убрать её клоны? Клоны с незапушенной работой останутся на хосте.`)) return;
  } else if (!s.exited && !force && !confirm('Сессия Claude Code ещё работает. Завершить её?')) return;
  if (!s.exited) api.kill(s.id);
  notifier.dismiss(s.id);
  commandBars.detach(s.command);
  s.term.dispose();
  for (const f of s.files) f.viewer.close();
  s.stripTab.remove();
  s.container.remove();
  // sessions идёт в порядке полосы: после закрытия выбирается сосед справа, у последней - слева, а не первая вкладка проекта.
  const peers = sessions.filter((x) => x.project === s.project);
  sessions.splice(sessions.indexOf(s), 1);
  if (lastSessionOf.get(s.project.id) === s) lastSessionOf.delete(s.project.id);
  taskSessions.remove(s);
  if (active === s) {
    const next = neighborAfterClose(peers, s) ?? sessions.find((x) => x.project === project);
    if (next) activateSession(next, panel.isOpen);
    else showNoSession();
  }
  panel.repaint();
}

function openFile(s: Session, path: string, root: TreeRoot, line?: number): void {
  const existing = s.files.find((f) => f.viewer.path === path);
  if (existing) {
    showInner(s, existing);
    // Панель файла только что показана: редактору нужен кадр, чтобы взять размер, прежде чем прокручивать.
    if (line !== undefined) requestAnimationFrame(() => void existing.viewer.reveal(line));
    return;
  }
  const pane = el('div', 'pane file');
  const body = el('div', 'file-body');
  const file: FileTab = { viewer: null as unknown as Viewer, rootLabel: root.label, tab: null as unknown as HTMLElement, pane };
  file.viewer = createViewer(path, body, root, (dirty) => file.tab.classList.toggle('dirty', dirty), s.remote?.fs);
  pane.append(fileHeader(path, root, file.viewer.actions, !!s.remote), body);
  s.innerPanes.append(pane);
  file.tab = makeTab('file', basename(path), () => closeFile(s, file));
  file.tab.title = path;
  file.tab.draggable = true;
  file.tab.addEventListener('click', () => showInner(s, file));
  s.innerTabs.append(file.tab);
  s.files.push(file);
  labelFiles(s);
  showInner(s, file);
  if (line !== undefined) requestAnimationFrame(() => void file.viewer.reveal(line));
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
  file.viewer.close();
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
  const remoteRoots = session.remote?.roots;
  const root = remoteRoots ? (remoteRoots.find((r) => cwd === r || cwd.startsWith(`${r}/`)) ?? session.root) : ((await api.gitRoot(cwd)) ?? cwd);
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

api.on<{ hid: string; from: number; repo: string; host?: string }>('session:handoff', ({ hid, from, repo, host }) => {
  const caller = findSession(from);
  // Проект ищется по передавшей сессии: её вкладка уже в своём проекте, а главный процесс проектов сессий не знает.
  if (!caller) return api.handoffFailed(hid, 'вкладка передавшей сессии не найдена');
  if (!caller.project.repos.includes(repo)) return api.handoffFailed(hid, `каталог ${repo} больше не входит в проект ${caller.project.name}`);
  if (host) {
    // Ошибку создания главный процесс уже вернул вызвавшей модели через reject передачи.
    api
      .createRemoteSession({ projectId: caller.project.id, handoff: hid, repo })
      .then((info) => createSessionView(caller.project, repo, { handoff: hid }, undefined, info))
      .catch(() => undefined);
    return;
  }
  createSessionView(caller.project, repo, { handoff: hid }).catch((error) => api.handoffFailed(hid, ipcErrorText(error)));
});

api.on<{ id: number }>('session:close', ({ id }) => {
  const session = findSession(id);
  if (session) closeSession(session, true);
  else api.kill(id);
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

api.on<{ host: string; online: boolean }>('remote:link', ({ host, online }) => {
  for (const s of sessions) {
    if (s.remote?.host !== host) continue;
    s.remote.online = online;
    updateSessionLabels(s);
  }
});

api.on<{ id: number; reported: boolean }>('remote:state', ({ id, reported }) => {
  const session = findSession(id);
  if (!session?.remote) return;
  session.remote.reported = reported;
  updateSessionLabels(session);
});

api.on<{ id: number; title: string; body: string }>('remote:report', ({ id, title, body }) => {
  const session = findSession(id);
  notifier.waiting(id, `${title}${session ? ` · ${session.project.name}` : ''}`, body, !!session && session === active && document.hasFocus());
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
  if (session.remote) void renderTree(session, false);
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
  showPickMenu(anchor, title, [el('div', 'menu-title', title), ...repos.map((repo) => pickItem(basename(repo), repo, () => onPick(repo)))]);
}

function pickItem(name: string, detail: string | undefined, onPick: () => void): HTMLElement {
  const item = asMenuItem(el('div', 'menu-item'));
  item.append(el('span', 'repo-name', name));
  if (detail) item.append(el('span', 'repo-path', detail));
  item.addEventListener('click', (event) => {
    // Выбор может открыть следующее меню: клик, дошедший до document, закрыл бы его сразу.
    event.stopPropagation();
    closeRepoMenu(true);
    onPick();
  });
  return item;
}

function showPickMenu(anchor: HTMLElement, label: string, children: HTMLElement[]): void {
  repoMenu.replaceChildren(...children);
  const rect = anchor.getBoundingClientRect();
  repoMenu.style.left = '';
  repoMenu.style.right = `${window.innerWidth - rect.right}px`;
  openRepoMenu(anchor, label, 'first');
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

function renderHistory(owner: Project, entries: HistoryEntry[] | string, note = ''): void {
  historyEl.classList.remove('selecting');
  const noteEl = note ? [el('div', 'history-note', note)] : [];
  if (typeof entries === 'string') {
    historyEl.replaceChildren(el('div', 'menu-title', entries), ...noteEl);
    return;
  }
  const keyOf = (entry: HistoryEntry): string => `${entry.host ?? ''}\n${entry.repo}\n${entry.id}`;
  // Спящая удалённая сессия убирается с клонами на хосте; отказ уборки (незапушенная работа) - окном.
  const removeEntry = async (entry: HistoryEntry): Promise<void> => {
    if (!entry.host) return api.deleteHistory(owner.id, entry.repo, entry.id);
    const refused = await api.remoteRemoveAsleep(owner.id, entry.host, entry.id);
    if (refused) alert(refused);
  };
  const rows = new Map<string, { entry: HistoryEntry; item: HTMLElement; check: HTMLInputElement }>();
  let selected = new Set<string>();
  let anchor: string | null = null;
  const count = el('span', 'history-count');
  const selectAll = el('button', '', 'Все');
  const removeSelected = el('button', 'danger', 'Удалить') as HTMLButtonElement;
  const cancel = el('button', '', 'Отмена');
  const bar = el('div', 'history-bar');
  bar.append(count, selectAll, removeSelected, cancel);
  const sync = (): void => {
    bar.hidden = !selected.size;
    historyEl.classList.toggle('selecting', selected.size > 0);
    count.textContent = `Выбрано: ${selected.size}`;
    for (const [key, { item, check }] of rows) {
      const on = selected.has(key);
      item.classList.toggle('selected', on);
      item.setAttribute('aria-selected', String(on));
      check.checked = on;
    }
  };
  const pick = (key: string, mode: 'toggle' | 'range'): void => {
    selected = clickSelection([...rows.keys()], selected, anchor, key, mode);
    anchor = key;
    sync();
  };
  const clear = (): void => {
    selected = new Set();
    anchor = null;
    sync();
  };
  const dropRow = (key: string): void => {
    rows.get(key)?.item.remove();
    rows.delete(key);
    selected.delete(key);
  };
  const afterDelete = (): void => {
    sync();
    if (!rows.size) renderHistory(owner, 'Прошлых сессий нет', note);
    else rove(historyEl, '.history-item');
  };
  const deleteSelected = async (): Promise<void> => {
    const targets = [...rows].filter(([key]) => selected.has(key));
    const remote = targets.some(([, { entry }]) => entry.host) ? ' Клоны спящих удалённых сессий на хостах будут удалены, кроме клонов с незапушенной работой.' : '';
    if (!targets.length || !confirm(`Удалить ${sessionsCount(targets.length)}? Журналы будут стёрты, продолжить эти сессии станет нельзя.${remote}`)) return;
    removeSelected.disabled = true;
    const failed: string[] = [];
    for (const [key, { entry }] of targets) {
      try {
        await removeEntry(entry);
        dropRow(key);
      } catch (err) {
        failed.push(`«${entry.title}»: ${String(err)}`);
      }
    }
    removeSelected.disabled = false;
    afterDelete();
    if (failed.length) alert(`Не удалось удалить:\n${failed.join('\n')}`);
  };
  selectAll.addEventListener('click', () => {
    selected = new Set(rows.keys());
    sync();
  });
  removeSelected.addEventListener('click', () => void deleteSelected());
  cancel.addEventListener('click', clear);
  for (const entry of entries) {
    const key = keyOf(entry);
    const item = asMenuItem(el('div', 'menu-item history-item'), 'option');
    item.title = `${entry.host ? `Разбудить на ${entry.host}` : 'Продолжить'}: ${entry.title}\nВыделить: ${shortcut(mac, 'щелчок')}, диапазон: Shift+щелчок`;
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'history-check';
    check.title = 'Выделить';
    check.tabIndex = -1;
    check.addEventListener('click', (event) => {
      event.stopPropagation();
      pick(key, event.shiftKey ? 'range' : 'toggle');
    });
    const remove = el('button', 'close', '×');
    remove.title = 'Удалить сессию (Delete)';
    // Запись в порядке табуляции одна, поэтому кнопка удаления с клавиатуры - Delete на записи.
    remove.tabIndex = -1;
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      const what = entry.host
        ? `Удалить спящую сессию «${entry.title}» на ${entry.host}? Её клоны будут удалены, кроме клонов с незапушенной работой; продолжить её станет нельзя.`
        : `Удалить сессию «${entry.title}»? Её журнал будет стёрт, продолжить её станет нельзя.`;
      if (!confirm(what)) return;
      removeEntry(entry)
        .then(() => {
          dropRow(key);
          afterDelete();
        })
        .catch((err) => alert(String(err)));
    });
    item.append(
      check,
      el('span', 'history-title', entry.title),
      el('span', 'repo-path', `${basename(entry.repo)}${entry.host ? ` · ${entry.host} · спит` : ''} · ${ago(entry.updated, Date.now())}`),
      remove,
    );
    item.addEventListener('click', (event) => {
      // Пока что-то выделено, щелчок продолжает выделять: продолжить сессию случайно посреди отбора нельзя.
      if (event.shiftKey) pick(key, 'range');
      else if (commandKey(event) || selected.size) pick(key, 'toggle');
      else if (entry.host) void wakeSession(owner, entry.host, entry.id, item);
      else void createSessionView(owner, entry.repo, undefined, entry.id).catch((err) => alert(String(err)));
    });
    item.addEventListener('keydown', (event) => {
      if (event.target !== item) return;
      if (event.key === 'Delete') {
        event.preventDefault();
        if (selected.size) void deleteSelected();
        else remove.click();
      } else if (event.key === 'Escape' && selected.size) {
        event.preventDefault();
        clear();
      }
    });
    rows.set(key, { entry, item, check });
  }
  historyEl.replaceChildren(bar, ...noteEl, ...[...rows.values()].map((row) => row.item));
  sync();
  rove(historyEl, '.history-item');
}

const waking = new Set<string>();

/** Разбуженная сессия получает вкладку как подхваченная; из «Истории» её строка уходит при следующей загрузке. */
async function wakeSession(owner: Project, host: string, sid: string, item: HTMLElement): Promise<void> {
  // Пробуждение идёт секунды (зеркало, доступы, ssh): повторный щелчок по той же строке ничего не начинает.
  if (waking.has(sid)) return;
  waking.add(sid);
  item.classList.add('waking');
  item.setAttribute('aria-busy', 'true');
  try {
    const info = await api.remoteWake(owner.id, host, sid);
    await createSessionView(owner, info.dirs[0], undefined, undefined, info);
  } catch (err) {
    alert(`Сессия на ${host} не проснулась: ${ipcErrorText(err)}`);
  } finally {
    waking.delete(sid);
    item.classList.remove('waking');
    item.removeAttribute('aria-busy');
    void loadHistory();
  }
}

async function loadHistory(): Promise<void> {
  const owner = project;
  if (!owner) {
    historyEl.replaceChildren(el('div', 'menu-title', 'Нет проекта'));
    return;
  }
  if (!historyEl.childElementCount) renderHistory(owner, 'Загрузка…');
  const local = await api.listHistory(owner.id).catch((err) => String(err));
  if (project !== owner) return;
  const show = (entries: HistoryEntry[] | string, note = ''): void =>
    renderHistory(owner, typeof entries === 'string' || entries.length ? entries : 'Прошлых сессий нет', note);
  if (!owner.hosts?.length || typeof local === 'string') return show(local);
  // «Прошлых сессий нет» до ответа хостов было бы неправдой: их спящие ещё могут прийти.
  show(local.length ? local : 'Загрузка…', 'Спящие сессии на хостах загружаются…');
  const remote = await api.listRemoteHistory(owner.id).catch((err) => ({ entries: [], unreachable: [{ host: 'хосты', reason: ipcErrorText(err) }] }));
  if (project !== owner) return;
  const note = remote.unreachable.map(({ host, reason }) => `${host}: нет связи (${reason}), спящие сессии не показаны`).join('\n');
  show([...local, ...remote.entries].sort((a, b) => b.updated - a.updated), note);
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

// ---------- удалённая сессия ----------

let remoteStarts = 0;

function markRemoteStart(delta: number): void {
  remoteStarts += delta;
  startMenuButton.textContent = remoteStarts ? '⇄…' : '▾';
  startMenuButton.title = remoteStarts ? 'Запуск на хосте…' : 'Где запустить: локально или на хосте по SSH';
}

/** Стрелка у «Новой сессии»: локально - в репозитории, на хосте - затем меню репозитория; ветка - текущая локальная, задание человек пишет в терминал сам (D-32, D-33). */
function showStartMenu(anchor: HTMLElement): void {
  const owner = project;
  if (!owner?.repos.length) return;
  const onHost = (host: string): void => {
    if (owner.repos.length === 1) return void startRemote(owner, host, owner.repos[0]);
    showRepoMenu(owner.repos, anchor, `Репозиторий на ${host}`, (repo) => void startRemote(owner, host, repo));
  };
  showPickMenu(anchor, 'Где запустить Claude Code', [
    el('div', 'menu-title', 'Локально'),
    ...owner.repos.map((repo) => pickItem(basename(repo), repo, () => void newSession(repo))),
    el('div', 'menu-title', 'На хосте'),
    ...(owner.hosts ?? []).map((host) => pickItem(`⇄ ${host}`, undefined, () => onHost(host))),
  ]);
}

async function startRemote(owner: Project, host: string, repo: string): Promise<void> {
  const branch = await api.gitBranch(repo);
  if (!branch) return void alert(`Удалённая сессия на ${host}: у ${repo} нет текущей ветки, клонировать на хост нечего.`);
  markRemoteStart(1);
  try {
    const info = await api.createRemoteSession({ projectId: owner.id, host, repo, branch });
    await createSessionView(owner, info.dirs[0], undefined, undefined, info);
  } catch (error) {
    const text = `Удалённая сессия на ${host}: ${ipcErrorText(error)}`;
    if (!text.includes('Вход Claude на хостах')) alert(text);
    else if (confirm(`${text}\n\nОткрыть «Вход Claude на хостах»?`)) void openClaudeTokenDialog();
  } finally {
    markRemoteStart(-1);
  }
}

startMenuButton.addEventListener('click', (event) => {
  event.stopPropagation();
  if (repoMenu.hidden) showStartMenu(startMenuButton);
  else closeRepoMenu(true);
});

// ---------- вход Claude на хостах ----------

const claudeTokenDialog = byId<HTMLDialogElement>('claude-token-dialog');
const claudeTokenValue = byId<HTMLInputElement>('claude-token-value');
const claudeTokenStatus = byId('claude-token-status');
const claudeTokenError = byId('claude-token-error');
const claudeTokenClear = byId<HTMLButtonElement>('claude-token-clear');

function showClaudeTokenStatus(status: ClaudeTokenStatus): void {
  claudeTokenStatus.textContent = !status.set
    ? 'Токен не задан: агент работает, только если на хосте выполнен claude auth login.'
    : status.stored === 'disk'
      ? 'Токен задан и хранится на этой машине зашифрованным средствами системы.'
      : 'Токен задан только до выхода из Cyborg: шифрование системы недоступно (нет связки ключей), и на диск он не пишется.';
  claudeTokenClear.disabled = !status.set;
}

function showClaudeTokenError(text: string): void {
  claudeTokenError.textContent = text;
  claudeTokenError.hidden = !text;
}

async function openClaudeTokenDialog(): Promise<void> {
  if (claudeTokenDialog.open) return;
  claudeTokenValue.value = '';
  showClaudeTokenError('');
  showClaudeTokenStatus(await api.claudeTokenStatus());
  claudeTokenDialog.showModal();
}

byId('claude-token-cancel').addEventListener('click', () => claudeTokenDialog.close());
byId('claude-token-save').addEventListener('click', async () => {
  try {
    const status = await api.setClaudeToken(claudeTokenValue.value);
    claudeTokenValue.value = '';
    showClaudeTokenError('');
    showClaudeTokenStatus(status);
    if (status.stored === 'disk') claudeTokenDialog.close();
  } catch (error) {
    showClaudeTokenError(ipcErrorText(error));
  }
});
claudeTokenClear.addEventListener('click', async () => {
  try {
    showClaudeTokenStatus(await api.clearClaudeToken());
    showClaudeTokenError('');
  } catch (error) {
    showClaudeTokenError(ipcErrorText(error));
  }
});
api.on<void>('menu:claude-token', () => void openClaudeTokenDialog());

// ---------- место на хостах ----------

const hostDiskDialog = byId<HTMLDialogElement>('host-disk-dialog');
const hostDiskHost = byId<HTMLSelectElement>('host-disk-host');
const hostDiskWarning = byId('host-disk-warning');
const hostDiskSummary = byId('host-disk-summary');
const hostDiskBody = byId('host-disk-table').querySelector('tbody') as HTMLTableSectionElement;
const hostDiskError = byId('host-disk-error');
const hostDiskPurge = byId<HTMLButtonElement>('host-disk-purge');
const hostDiskRefresh = byId<HTMLButtonElement>('host-disk-refresh');
let hostDiskOwner: Project | null = null;
let hostDisk: HostDisk | null = null;
const hostDiskChecked = new Set<string>();

function showHostDiskError(text: string): void {
  hostDiskError.textContent = text;
  hostDiskError.hidden = !text;
}

function renderHostDisk(): void {
  const rows = hostDisk ? diskRows(hostDisk, Date.now()) : [];
  hostDiskBody.replaceChildren(
    ...rows.map((row) => {
      const tr = el('tr');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.disabled = !row.selectable;
      box.checked = hostDiskChecked.has(row.sid);
      box.addEventListener('change', () => {
        if (box.checked) hostDiskChecked.add(row.sid);
        else hostDiskChecked.delete(row.sid);
        hostDiskPurge.disabled = !hostDiskChecked.size;
      });
      const check = el('td');
      check.append(box);
      tr.append(check, ...[row.title, row.state, row.branch, row.size, row.active, row.dirty].map((text) => el('td', '', text)));
      return tr;
    }),
  );
  if (hostDisk && !rows.length) {
    const empty = el('td', 'hint', 'Сессий на хосте нет.') as HTMLTableCellElement;
    empty.colSpan = 7;
    const tr = el('tr');
    tr.append(empty);
    hostDiskBody.append(tr);
  }
  hostDiskPurge.disabled = !hostDiskChecked.size;
}

async function loadHostDisk(): Promise<void> {
  const owner = hostDiskOwner;
  const host = hostDiskHost.value;
  if (!owner || !host) return;
  hostDisk = null;
  hostDiskChecked.clear();
  showHostDiskError('');
  hostDiskSummary.textContent = `Считается место на ${host}…`;
  hostDiskRefresh.disabled = true;
  renderHostDisk();
  try {
    const disk = await api.remoteDisk(owner.id, host);
    if (hostDiskHost.value !== host || hostDiskOwner !== owner) return;
    hostDisk = disk;
    hostDiskSummary.textContent = diskSummary(disk);
  } catch (error) {
    hostDiskSummary.textContent = '';
    showHostDiskError(ipcErrorText(error));
  } finally {
    hostDiskRefresh.disabled = false;
    renderHostDisk();
  }
}

function openHostDiskDialog(owner: Project | null, host?: string, warning = ''): void {
  if (!owner?.hosts?.length || hostDiskDialog.open) return;
  hostDiskOwner = owner;
  hostDiskHost.replaceChildren(...owner.hosts.map((h) => new Option(h, h)));
  if (host) hostDiskHost.value = host;
  hostDiskWarning.textContent = warning;
  hostDiskWarning.hidden = !warning;
  hostDiskDialog.showModal();
  void loadHostDisk();
}

hostDiskHost.addEventListener('change', () => void loadHostDisk());
hostDiskRefresh.addEventListener('click', () => void loadHostDisk());
byId('host-disk-close').addEventListener('click', () => hostDiskDialog.close());
hostDiskPurge.addEventListener('click', async () => {
  const owner = hostDiskOwner;
  if (!owner || !hostDisk) return;
  const plan = purgePlan(hostDisk, hostDiskChecked);
  if (!plan.sids.length) return;
  if (!confirm(`Удалить отмеченные сессии (${plan.sids.length}) на ${hostDisk.host} вместе с клонами? Разговор спящей сессии тоже пропадёт.`)) return;
  const force = plan.dirty.length > 0 && confirm(`В этих клонах есть незапушенная работа:\n\n${plan.dirty.join('\n')}\n\nУдалить и их? «Отмена» - оставить их на хосте.`);
  hostDiskPurge.disabled = true;
  try {
    const results = [];
    for (const call of purgeCalls(plan, force)) results.push(...(await api.remotePurge(owner.id, hostDisk.host, call.sids, call.force)));
    const report = purgeReport(results);
    await loadHostDisk();
    showHostDiskError(report);
  } catch (error) {
    showHostDiskError(ipcErrorText(error));
    hostDiskPurge.disabled = false;
  }
});
api.on<void>('menu:host-disk', () => openHostDiskDialog(project));
api.on<{ host: string; free: number; total: number }>('remote:disk-low', ({ host, free }) => {
  const owner = project?.hosts?.includes(host) ? project : (state.projects.find((p) => p.hosts?.includes(host)) ?? null);
  openHostDiskDialog(owner, host, `На ${host} мало места: свободно ${formatBytes(free)}. Удалите ненужные сессии.`);
});

// Сессии, пережившие выход Cyborg, возвращаются вкладками: хосты проекта опрашиваются при открытии воркспейса.
async function discoverRemote(owner: Project): Promise<void> {
  if (!owner.hosts?.length) return;
  try {
    for (const info of await api.remoteDiscover(owner.id)) {
      if (!findSession(info.id)) await createSessionView(owner, info.dirs[0], undefined, undefined, info);
    }
  } catch (error) {
    console.error('Поиск удалённых сессий:', error);
  }
}

newSessionButton.addEventListener('click', (event) => {
  event.stopPropagation();
  toggleSessionMenu(newSessionButton);
});
bindTablist(byId('side-tabs'), 'Боковая панель');
bindTablist(sessionList, 'Сессии');
bindTabDrag(sessionList, (from, to) => {
  const moved = moveItem(
    sessions,
    sessions.findIndex((s) => s.stripTab === from),
    sessions.findIndex((s) => s.stripTab === to),
  );
  sessions.splice(0, sessions.length, ...moved);
  sessionList.append(...sessions.map((s) => s.stripTab));
});
selectTab(sideFiles, true);
selectTab(sideHistory, false);
sideFiles.addEventListener('click', () => showSideView(false));
sideHistory.addEventListener('click', () => showSideView(true));
bindList(repoMenu, '.menu-item');
historyEl.setAttribute('role', 'listbox');
historyEl.setAttribute('aria-label', 'Прошлые сессии');
historyEl.setAttribute('aria-multiselectable', 'true');
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

// Кнопки-команды живут в общем файле и в файле воркспейса: правка в них (редактором Cyborg или чужим) подхватывается без перезапуска (FR-12006).
function reloadCommands(): Promise<void> {
  return api.loadCommands().then((config) => commandBars.setConfig(config));
}
window.addEventListener('focus', () => void reloadCommands());
const commandEditor = initCommandEditor({ mac, problems: () => commandBars.configProblems, saved: () => void reloadCommands() });
api.on<void>('menu:commands', () => void commandEditor.open());
const promptEditor = initPromptEditor();
api.on<void>('menu:prompts', () => void promptEditor.open());
// Ищется по тем корням, которые человек видит в дереве: у сессии свои, без сессии - репозитории проекта; у удалённой вкладки - на хосте.
const searchDialog = new SearchDialog({
  roots: () => (active ? treeRoots(active) : (project?.repos ?? []).map((repo) => ({ path: repo, label: basename(repo), hint: 'репозиторий проекта' }))),
  open: openAnywhere,
  fs: () => active?.remote?.fs ?? localFs,
});
api.on<SearchMode>('menu:search', (mode) => searchDialog.open(mode));
// Расширения читаются по репозиториям проекта и по рабочему каталогу активной сессии.
const extensionsDialog = new ExtensionsDialog({
  context: () => ({ repos: project?.repos ?? [], session: active && !active.remote ? { root: active.root, repo: active.repo } : null }),
});
api.on<ExtensionsTab>('menu:extensions', (tab) => extensionsDialog.open(tab));

void Promise.all([api.workspaceInfo(), api.loadProjects()]).then(async ([info, loaded]) => {
  workspaceFile = info.file;
  workspaceName = info.name;
  workspaceHome = info.home;
  workspaceSep = info.sep;
  state = loaded;
  void reloadCommands();
  const problem = await api.projectsProblem();
  selectProject(state.projects.find((p) => p.id === state.lastProjectId) ?? state.projects[0] ?? null, false);
  for (const owner of state.projects) void discoverRemote(owner);
  if (problem) alert(projectsProblemText(problem, workspaceFile));
  if (!workspaceFile) openWorkspaceDialog();
});
