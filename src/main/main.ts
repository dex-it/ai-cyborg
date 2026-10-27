import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, Notification, session, shell } from 'electron';
import { AllowedPaths, createPathHandlers } from './allowed-paths';
import { saveCommandsText } from './commands';
import { listDir, readTextFile } from './files';
import { deleteHistory, historyExists, isSessionId, listHistory } from './history';
import { JiraService } from './jira-service';
import { gitBranch, gitBranches, gitHeadContent, gitRemotes, gitRoot, gitStatus, gitSwitch } from './git';
import { appMenuTemplate, NOTIFICATIONS_MENU_ID, PROJECT_NEW_MENU_ID, PROJECT_PROPERTIES_MENU_ID, type WorkspaceMenu } from './menu';
import { validateNotifyArgs } from './notify-args';
import { MrsService } from './mrs-service';
import { mrUrl, validateMrDetailsArgs, validateMrListArgs, validateSessionStart } from './mrs';
import { ProjectStore } from './projects';
import { SessionManager } from './sessions';
import { createTaskHandlers, TaskDetailsService } from './task-details';
import {
  createCliRunner,
  sessionDirsAllowed,
  TrackerSettingsStore,
  TrackersService,
  saveProjectsState,
  validateRef,
} from './trackers';
import {
  argvCwd,
  canonicalWorkspace,
  createAndOpen,
  directoryProblem,
  isLegacyWorkspace,
  isRegularFile,
  launchArgs,
  launchInstance,
  legacyFileOf,
  lockPathOf,
  openRecentWorkspace,
  openWorkspaceFile,
  parseWorkspaceArg,
  readRecent,
  releaseLock,
  resolveStartup,
  sessionDirOf,
  touchRecent,
  tryLock,
  workspaceDisplayName,
  type OpenDeps,
  type OpenResult,
  type SpawnFn,
} from './workspaces';

let win: BrowserWindow | null = null;
const sessions = new SessionManager(app.getPath('userData'), (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
});
const trackerSettings = new TrackerSettingsStore(path.join(app.getPath('userData'), 'trackers.json'));
const userData = app.getPath('userData');
type Projects = Pick<ProjectStore, 'load' | 'save' | 'problem' | 'loadCommands' | 'saveCommands'>;
// Инстанс без воркспейса (отмена окна первого запуска): проектов нет, писать некуда.
const noWorkspace: Projects = {
  load: () => ({ projects: [], lastProjectId: null }),
  save: () => {
    throw new Error('Воркспейс не открыт');
  },
  problem: () => null,
  loadCommands: () => undefined,
  saveCommands: () => {
    throw new Error('Воркспейс не открыт');
  },
};
// Воркспейс выбирается в whenReady; замыкания ниже читают переменную при вызове.
let projects: Projects = noWorkspace;
let current: { file: string | null; legacy: boolean } = { file: null, legacy: false };
let heldLock: string | null = null;
const paths = createPathHandlers({
  allowed: new AllowedPaths(() => [...projects.load().projects.flatMap((p) => p.repos), ...sessions.liveDirs()]),
  liveDirs: () => sessions.liveDirs(),
  listDir,
  readTextFile,
  gitRoot,
  gitBranch,
  gitStatus,
  gitHeadContent,
});
const runCli = createCliRunner(app.getPath('userData'));
const trackers = new TrackersService({
  run: runCli,
  remotes: gitRemotes,
  projects: () => projects.load(),
});

const mrs = new MrsService(trackers, runCli);
const jira = new JiraService(runCli, () => projects.load());
const taskHandlers = createTaskHandlers(trackers, new TaskDetailsService(runCli), (url) => shell.openExternal(url));

let quitting = false;
app.on('before-quit', () => {
  quitting = true;
});

/** Закрытие окна и выход завершают все сессии: как и закрытие вкладки, они спрашивают, пока сессия работает. */
function confirmEndSessions(): boolean {
  const running = sessions.count();
  if (!running) return true;
  const choice = dialog.showMessageBoxSync(win!, {
    type: 'warning',
    buttons: ['Закрыть', 'Отмена'],
    defaultId: 1,
    cancelId: 1,
    message: `Работающих сессий Claude Code: ${running}`,
    detail: 'При закрытии окна они будут завершены.',
  });
  return choice === 0;
}

const windowBackground = () => (nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff');

// Настройки интерфейса (localStorage) живут в сессии воркспейса; прежний projects.json остаётся в сессии по умолчанию.
function windowSession(): Electron.Session {
  if (!current.file) return session.fromPartition('cyborg-no-workspace');
  if (current.legacy) return session.defaultSession;
  const dir = sessionDirOf(userData, current.file);
  fs.mkdirSync(dir, { recursive: true });
  return session.fromPath(dir);
}

function createWindow(bounds?: Electron.Rectangle): void {
  win = new BrowserWindow({
    width: 1600,
    height: 1000,
    ...bounds,
    title: 'Cyborg',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: windowBackground(),
    webPreferences: {
      session: windowSession(),
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Выход уже начался (before-quit: подтверждено в меню, сигнал SIGINT/SIGTERM, завершение сеанса ОС) - окно не спрашивает.
  win.on('close', (event) => {
    if (!quitting && !confirmEndSessions()) event.preventDefault();
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

nativeTheme.on('updated', () => win?.setBackgroundColor(windowBackground()));

ipcMain.handle('dialog:pickDir', async (_event, defaultPath?: string) => {
  const result = await dialog.showOpenDialog(win!, { properties: ['openDirectory'], defaultPath });
  return paths.picked(result.canceled ? null : result.filePaths[0]);
});
ipcMain.handle('dialog:pickWorkspaceDir', async (_event, defaultPath?: unknown) => {
  const result = await dialog.showOpenDialog(win!, {
    title: 'Папка файла воркспейса',
    buttonLabel: 'Выбрать',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: typeof defaultPath === 'string' ? defaultPath : undefined,
  });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle('workspace:info', () => ({
  file: current.file,
  name: current.file && !current.legacy ? workspaceDisplayName(current.file) : null,
  home: os.homedir(),
  sep: path.sep,
}));
// Путь от интерфейса открывается, только если главный процесс сам предложил его ответом exists: иначе открытый чужой файл затирался бы первым сохранением.
let offeredWorkspace: string | null = null;
ipcMain.handle('workspace:create', async (_event, raw: unknown) => {
  offeredWorkspace = null;
  const outcome = await createAndOpen(raw, openDeps);
  if ('exists' in outcome) offeredWorkspace = canonicalWorkspace((raw as { file: string }).file);
  if ('error' in outcome || 'exists' in outcome) return outcome;
  await report(outcome.opened, '');
  return {};
});
ipcMain.handle('workspace:open', async (_event, file: unknown) => {
  if (typeof file !== 'string' || offeredWorkspace === null || canonicalWorkspace(file) !== offeredWorkspace) throw new Error('Некорректные аргументы workspace:open');
  offeredWorkspace = null;
  return report(await openWorkspaceFile(file, openDeps), file);
});
ipcMain.handle('projects:load', () => projects.load());
ipcMain.handle('projects:problem', () => {
  projects.load();
  return projects.problem();
});
ipcMain.handle('projects:save', (_event, state: unknown) => saveProjectsState(state, projects, trackers));
ipcMain.handle('commands:load', () => projects.loadCommands());
ipcMain.handle('commands:save', (_event, text: unknown) => saveCommandsText(text, projects, process.platform === 'darwin'));
ipcMain.handle('session:create', (_event, cwd: unknown, addDirs: unknown, start?: unknown) => {
  if (!sessionDirsAllowed(projects.load(), cwd, addDirs)) throw new Error('Каталог не входит в репозитории проектов');
  if (start === undefined) return sessions.create(cwd as string, addDirs as string[]);
  const prompt = validateSessionStart(start);
  if (!prompt) throw new Error('Некорректный старт сессии');
  return sessions.create(cwd as string, addDirs as string[], prompt);
});
ipcMain.handle('history:list', (_event, projectId: unknown) => {
  const project = projects.load().projects.find((p) => p.id === projectId);
  return project ? listHistory(project.repos) : [];
});
ipcMain.handle('history:delete', (_event, projectId: unknown, repo: unknown, id: unknown) => {
  const project = projects.load().projects.find((p) => p.id === projectId);
  if (!project || typeof repo !== 'string' || !project.repos.includes(repo) || !isSessionId(id)) throw new Error('Некорректное удаление сессии');
  deleteHistory(repo, id);
});
ipcMain.handle('session:resume', (_event, cwd: unknown, addDirs: unknown, id: unknown) => {
  if (!isSessionId(id) || !sessionDirsAllowed(projects.load(), cwd, addDirs)) throw new Error('Некорректное продолжение сессии');
  if (!historyExists(cwd as string, id)) throw new Error('Журнал сессии не найден');
  return sessions.create(cwd as string, addDirs as string[], undefined, id);
});
ipcMain.handle('trackers:status', () => trackers.status());
ipcMain.handle('tasks:list', (_event, projectId: unknown, assignedToMe: unknown, tracked: unknown, recheck: unknown) =>
  taskHandlers.list(projectId, assignedToMe, tracked, recheck),
);
ipcMain.handle('tasks:details', (_event, selection: unknown, ref: unknown) => taskHandlers.details(selection, ref));
ipcMain.handle('tasks:sessionDetails', (_event, ref: unknown) => taskHandlers.sessionDetails(ref));
ipcMain.handle('tasks:open', (_event, arg: unknown) => taskHandlers.open(arg));
ipcMain.handle('jira:status', () => jira.status());
ipcMain.handle('jira:list', (_event, projectId: unknown, recheck: unknown) => {
  if (typeof projectId !== 'string' || typeof recheck !== 'boolean') throw new Error('Некорректные аргументы jira:list');
  return jira.list(projectId, recheck);
});
ipcMain.handle('jira:projects', (_event, recheck: unknown) => {
  if (typeof recheck !== 'boolean') throw new Error('Некорректные аргументы jira:projects');
  return jira.projects(recheck);
});
ipcMain.handle('jira:suggest', async (_event, repos: unknown) => {
  if (!Array.isArray(repos)) throw new Error('Некорректные аргументы jira:suggest');
  // Ветки читаются только у репозиториев сохранённых проектов (как git:branches); прочие пути молча пропускаются.
  const names: string[] = [];
  for (const repo of repos.slice(0, 20)) {
    if (!projectRepo(repo)) continue;
    const { local, remote } = await gitBranches(repo);
    names.push(...local, ...remote);
  }
  return jira.suggest(names);
});
ipcMain.handle('jira:details', (_event, projectId: unknown, key: unknown) => {
  if (typeof projectId !== 'string') throw new Error('Некорректные аргументы jira:details');
  return jira.details(projectId, key);
});
ipcMain.handle('jira:open', async (_event, projectId: unknown, key: unknown) => {
  if (typeof projectId !== 'string') throw new Error('Некорректные аргументы jira:open');
  const res = await jira.url(projectId, key);
  if ('error' in res) return { error: res.error };
  try {
    await shell.openExternal(res.url);
    return {};
  } catch (error) {
    return { error: (error as Error).message || 'браузер не открылся' };
  }
});
ipcMain.handle('mrs:list', (_event, projectId: unknown, filter: unknown, tracked: unknown, recheck: unknown) => {
  const args = validateMrListArgs(projectId, filter, tracked, recheck);
  if (!args) throw new Error('Некорректные аргументы mrs:list');
  return mrs.listMrs(args.projectId, args.filter, args.tracked, args.recheck);
});
ipcMain.handle('mrs:open', async (_event, arg: unknown) => {
  const ref = validateRef(arg);
  if (!ref) throw new Error('Некорректные аргументы mrs:open');
  try {
    await shell.openExternal(mrUrl(ref));
    return {};
  } catch (error) {
    return { error: (error as Error).message || 'браузер не открылся' };
  }
});
ipcMain.handle('mrs:details', (_event, id: unknown) => {
  const valid = validateMrDetailsArgs(id);
  if (valid === null) throw new Error('Некорректные аргументы mrs:details');
  return mrs.details(valid);
});
ipcMain.on('session:input', (_event, id: number, data: string) => sessions.write(id, data));
ipcMain.on('session:resize', (_event, id: number, cols: number, rows: number) => sessions.resize(id, cols, rows));
ipcMain.on('session:kill', (_event, id: number) => sessions.kill(id));

// Без ссылки уведомление собирает GC, и клик по нему уже некому обработать.
const shownNotifications = new Map<number, Notification>();
ipcMain.on('session:notify', (_event, rawId: unknown, rawTitle: unknown, rawBody: unknown) => {
  const args = validateNotifyArgs(rawId, rawTitle, rawBody);
  if (!args || !Notification.isSupported()) return;
  const { id, title, body } = args;
  shownNotifications.get(id)?.close();
  const notification = new Notification({ title, body, icon: path.join(__dirname, 'icon.png') });
  const forget = () => {
    if (shownNotifications.get(id) === notification) shownNotifications.delete(id);
  };
  notification.on('click', () => {
    forget();
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send('session:reveal', { id });
  });
  notification.on('close', forget);
  // Разрешение на уведомления снято или демона уведомлений нет: показа не будет, держать ссылку незачем.
  notification.on('failed', forget);
  shownNotifications.set(id, notification);
  notification.show();
});
ipcMain.on('session:unnotify', (_event, id: unknown) => {
  if (typeof id !== 'number') return;
  shownNotifications.get(id)?.close();
  shownNotifications.delete(id);
});

// Выключатель хранит интерфейс (FR-1015: главный процесс на диск настроек не пишет); меню только отражает его.
ipcMain.on('notifications:state', (_event, enabled: boolean) => {
  menuState.notifications = enabled === true;
  const item = Menu.getApplicationMenu()?.getMenuItemById(NOTIFICATIONS_MENU_ID);
  if (item) item.checked = enabled === true;
  if (enabled !== true) {
    for (const notification of shownNotifications.values()) notification.close();
    shownNotifications.clear();
  }
});
ipcMain.on('project:selected', (_event, selected: unknown) => {
  menuState.hasProject = selected === true;
  const item = Menu.getApplicationMenu()?.getMenuItemById(PROJECT_PROPERTIES_MENU_ID);
  if (item) item.enabled = menuState.hasProject;
});
ipcMain.handle('fs:list', (_event, dir: unknown) => paths.list(dir));
ipcMain.handle('fs:read', (_event, file: unknown) => paths.read(file));
ipcMain.handle('git:root', (_event, dir: unknown) => paths.root(dir));
ipcMain.handle('git:branch', (_event, root: unknown) => paths.branch(root));
ipcMain.handle('git:status', (_event, root: unknown) => paths.status(root));
const projectRepo = (root: unknown): root is string => typeof root === 'string' && projects.load().projects.some((p) => p.repos.includes(root));
ipcMain.handle('git:branches', (_event, root: unknown) => {
  if (!projectRepo(root)) throw new Error('Некорректные аргументы git:branches');
  return gitBranches(root);
});
ipcMain.handle('git:switch', async (_event, root: unknown, branch: unknown) => {
  if (!projectRepo(root) || typeof branch !== 'string') throw new Error('Некорректные аргументы git:switch');
  if (sessions.uses(root)) return { error: 'в репозитории работает сессия Claude: веткой управляет она' };
  try {
    await gitSwitch(root, branch);
    return {};
  } catch (error) {
    return { error: (error as Error).message };
  }
});
ipcMain.handle('git:headContent', (_event, file: unknown) => paths.headContent(file));

const menuState = { hasProject: false, notifications: true };

const fail = (reason: string): void => {
  dialog.showErrorBox('Cyborg', reason);
  app.exit(1);
};

function quitWithConfirm(): void {
  if (confirmEndSessions()) app.quit();
}

function rebuildMenu(): void {
  const workspace: WorkspaceMenu = {
    recent: readRecent(userData),
    home: os.homedir(),
    hasWorkspace: current.file !== null,
    hasProject: menuState.hasProject,
    open: () => void chooseWorkspace(),
    create: () => win?.webContents.send('menu:create-workspace'),
    openRecent: (file) => void openRecent(file),
    newProject: () => win?.webContents.send('menu:project', 'new'),
    editProject: () => win?.webContents.send('menu:project', 'edit'),
  };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      appMenuTemplate(
        process.platform,
        quitWithConfirm,
        (enabled) => {
          if (win && !win.isDestroyed()) win.webContents.send('notifications:toggle', enabled);
        },
        workspace,
        menuState.notifications,
      ),
    ),
  );
}

/** Воркспейс становится текущим: хранилище проектов, замок (уже взятый вызывающим), «Недавние». */
function adoptWorkspace(input: string, locked: boolean): void {
  const file = canonicalWorkspace(input);
  current = { file, legacy: isLegacyWorkspace(userData, file) };
  projects = new ProjectStore(file, () => trackerSettings.load());
  heldLock = locked ? file : null;
  touchRecent(userData, file);
}

function openHere(input: string): OpenResult {
  const file = canonicalWorkspace(input);
  const lock = tryLock(file);
  if (lock.status === 'busy') return { busy: { pid: lock.pid, lock: lockPathOf(file) } };
  adoptWorkspace(file, lock.status === 'locked');
  const old = win;
  createWindow(old && !old.isDestroyed() ? old.getBounds() : undefined);
  // Новое окно уже есть, поэтому window-all-closed не срабатывает; ответ на вызов из старого окна уходит до его уничтожения.
  if (old && !old.isDestroyed()) setImmediate(() => old.destroy());
  menuState.hasProject = false;
  rebuildMenu();
  return { ok: true };
}

const openDeps: OpenDeps = {
  userData,
  hasWorkspace: () => current.file !== null,
  openHere,
  launch: (file) =>
    launchInstance(
      spawn as unknown as SpawnFn,
      process.execPath,
      launchArgs({ packaged: app.isPackaged, appPath: app.getAppPath(), userData, argv: process.argv, file }),
    ),
};

/** true - воркспейс открыт; иначе исход назван окном, и вызывающий не закрывает свои диалоги. */
async function report(result: OpenResult, file: string): Promise<boolean> {
  if ('ok' in result) return true;
  if (!win || win.isDestroyed()) return false;
  if ('busy' in result) {
    const { pid, lock } = result.busy;
    await dialog.showMessageBox(win, {
      type: 'info',
      message: 'Воркспейс уже открыт',
      detail: `${lock.slice(0, -'.lock'.length)}${pid ? `\nПроцесс ${pid}` : ''}\nЕсли Cyborg с ним не запущен, удалите ${lock}`,
    });
  } else if ('missing' in result) {
    await dialog.showMessageBox(win, { type: 'error', message: 'Файл воркспейса не найден', detail: file });
  } else {
    await dialog.showMessageBox(win, { type: 'error', message: 'Не удалось запустить Cyborg', detail: result.error });
  }
  return false;
}

async function chooseWorkspace(): Promise<void> {
  if (!win) return;
  const result = await dialog.showOpenDialog(win, {
    title: 'Открыть воркспейс в новом окне',
    buttonLabel: 'Открыть',
    properties: ['openFile'],
    filters: [{ name: 'Воркспейс Cyborg', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePaths[0]) return;
  await report(await openWorkspaceFile(result.filePaths[0], openDeps), result.filePaths[0]);
}

async function openRecent(file: string): Promise<void> {
  const result = await openRecentWorkspace(file, openDeps);
  await report(result, file);
  if ('missing' in result) rebuildMenu();
}

/** Воркспейс запуска: --workspace, иначе последний свободный из «Недавних», иначе прежний projects.json, иначе пусто (окно первого запуска). */
function chooseStartupWorkspace(): boolean {
  const arg = parseWorkspaceArg(process.argv, argvCwd(process.env, process.cwd()));
  if (arg.kind === 'error') {
    fail(arg.reason);
    return false;
  }
  if (arg.kind === 'file') {
    const file = canonicalWorkspace(arg.file);
    const problem = directoryProblem(file);
    if (problem) {
      fail(problem);
      return false;
    }
    const lock = tryLock(file);
    if (lock.status === 'busy') {
      fail(`Воркспейс уже открыт\n${file}${lock.pid ? `\nПроцесс ${lock.pid}` : ''}\nЕсли Cyborg с ним не запущен, удалите ${lockPathOf(file)}`);
      return false;
    }
    adoptWorkspace(file, lock.status === 'locked');
    return true;
  }
  let locked = false;
  const start = resolveStartup({
    recent: readRecent(userData),
    legacyFile: canonicalWorkspace(legacyFileOf(userData)),
    isFile: isRegularFile,
    isLegacy: (file) => isLegacyWorkspace(userData, file),
    tryLock: (file) => {
      const lock = tryLock(file);
      locked = lock.status === 'locked';
      return lock.status === 'busy' ? 'busy' : 'ok';
    },
  });
  if (start.kind === 'workspace') adoptWorkspace(start.file, locked);
  return true;
}

const releaseHeldLock = (): void => {
  if (heldLock) releaseLock(heldLock);
};
app.on('will-quit', releaseHeldLock);
process.on('exit', releaseHeldLock);

app.whenReady().then(() => {
  // icon у BrowserWindow на macOS не действует: в Dock остался бы значок Electron.
  app.dock?.setIcon(path.join(__dirname, 'icon.png'));
  if (!chooseStartupWorkspace()) return;
  rebuildMenu();
  // Список «Недавних» общий для инстансов: другой мог изменить его, пока это окно было в фоне.
  app.on('browser-window-focus', rebuildMenu);
  void trackers.warmAuth();
  createWindow();
});
app.on('window-all-closed', () => {
  sessions.killAll();
  app.quit();
});
