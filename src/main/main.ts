import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, nativeTheme } from 'electron';
import { listDir, readTextFile } from './files';
import { gitBranch, gitRemotes, gitRoot, gitStatus } from './git';
import { ProjectStore, type ProjectsState } from './projects';
import { SessionManager } from './sessions';
import {
  createCliRunner,
  sessionDirsAllowed,
  taskPrompt,
  TrackerSettingsStore,
  TrackersService,
  validateListArgs,
  validateRef,
  validateSettings,
} from './trackers';

let win: BrowserWindow | null = null;
const sessions = new SessionManager(app.getPath('userData'), (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
});
const projects = new ProjectStore(path.join(app.getPath('userData'), 'projects.json'));

const trackerSettings = new TrackerSettingsStore(path.join(app.getPath('userData'), 'trackers.json'));
const trackers = new TrackersService({
  run: createCliRunner(app.getPath('userData')),
  remotes: gitRemotes,
  projects: () => projects.load(),
  settings: () => trackerSettings.load(),
});

const windowBackground = () => (nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff');

function createWindow(): void {
  win = new BrowserWindow({
    width: 1600,
    height: 1000,
    title: 'Cyborg',
    backgroundColor: windowBackground(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

nativeTheme.on('updated', () => win?.setBackgroundColor(windowBackground()));

ipcMain.handle('dialog:pickDir', async (_event, defaultPath?: string) => {
  const result = await dialog.showOpenDialog(win!, { properties: ['openDirectory'], defaultPath });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle('projects:load', () => projects.load());
ipcMain.handle('projects:save', (_event, state: ProjectsState) => projects.save(state));
ipcMain.handle('session:create', (_event, cwd: string, addDirs: string[], ref?: unknown) => {
  if (ref === undefined) return sessions.create(cwd, addDirs);
  const taskRef = validateRef(ref);
  if (!taskRef) throw new Error('Некорректная задача');
  if (!sessionDirsAllowed(projects.load(), cwd, addDirs)) throw new Error('Каталог не входит в репозитории проектов');
  return sessions.create(cwd, addDirs, taskPrompt(taskRef));
});
ipcMain.handle('trackers:load', () => trackerSettings.load());
ipcMain.handle('trackers:save', (_event, settings: unknown) => {
  const valid = validateSettings(settings);
  if (!valid) throw new Error('Некорректные настройки трекеров');
  trackerSettings.save(valid);
});
ipcMain.handle('trackers:status', () => trackers.status());
ipcMain.handle('tasks:list', (_event, projectId: unknown, assignedToMe: unknown, tracked: unknown) => {
  const args = validateListArgs(projectId, assignedToMe, tracked);
  if (!args) throw new Error('Некорректные аргументы tasks:list');
  return trackers.list(args.projectId, args.assignedToMe, args.tracked);
});
ipcMain.on('session:input', (_event, id: number, data: string) => sessions.write(id, data));
ipcMain.on('session:resize', (_event, id: number, cols: number, rows: number) => sessions.resize(id, cols, rows));
ipcMain.on('session:kill', (_event, id: number) => sessions.kill(id));
ipcMain.handle('fs:list', (_event, dir: string) => listDir(dir));
ipcMain.handle('fs:read', (_event, file: string) => readTextFile(file));
ipcMain.handle('git:root', (_event, dir: string) => gitRoot(dir));
ipcMain.handle('git:branch', (_event, root: string) => gitBranch(root));
ipcMain.handle('git:status', (_event, root: string) => gitStatus(root));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  sessions.killAll();
  app.quit();
});
