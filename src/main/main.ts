import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron';
import { AllowedPaths, createPathHandlers } from './allowed-paths';
import { listDir, readTextFile } from './files';
import { deleteHistory, historyExists, isSessionId, listHistory } from './history';
import { JiraService } from './jira-service';
import { gitBranch, gitBranches, gitHeadContent, gitRemotes, gitRoot, gitStatus, gitSwitch } from './git';
import { appMenuTemplate } from './menu';
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

let win: BrowserWindow | null = null;
const sessions = new SessionManager(app.getPath('userData'), (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
});
const trackerSettings = new TrackerSettingsStore(path.join(app.getPath('userData'), 'trackers.json'));
const projects = new ProjectStore(path.join(app.getPath('userData'), 'projects.json'), () => trackerSettings.load());
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

function createWindow(): void {
  win = new BrowserWindow({
    width: 1600,
    height: 1000,
    title: 'Cyborg',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: windowBackground(),
    autoHideMenuBar: true,
    webPreferences: {
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
ipcMain.handle('projects:load', () => projects.load());
ipcMain.handle('projects:problem', () => {
  projects.load();
  return projects.problem();
});
ipcMain.handle('projects:save', (_event, state: unknown) => saveProjectsState(state, projects, trackers));
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

app.whenReady().then(() => {
  // icon у BrowserWindow на macOS не действует: в Dock остался бы значок Electron.
  app.dock?.setIcon(path.join(__dirname, 'icon.png'));
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      appMenuTemplate(process.platform, () => {
        if (confirmEndSessions()) app.quit();
      }),
    ),
  );
  void trackers.warmAuth();
  createWindow();
});
app.on('window-all-closed', () => {
  sessions.killAll();
  app.quit();
});
