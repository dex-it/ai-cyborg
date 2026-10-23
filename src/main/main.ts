import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, nativeTheme } from 'electron';
import { listDir, readTextFile } from './files';
import { gitBranch, gitRemotes, gitRoot, gitStatus } from './git';
import { MrsService } from './mrs-service';
import { validateMrDetailsArgs, validateMrListArgs, validateSessionStart } from './mrs';
import { ProjectStore, type ProjectsState } from './projects';
import { SessionManager } from './sessions';
import {
  createCliRunner,
  sessionDirsAllowed,
  TrackerSettingsStore,
  TrackersService,
  validateListArgs,
  saveTrackerSettings,
} from './trackers';

let win: BrowserWindow | null = null;
const sessions = new SessionManager(app.getPath('userData'), (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
});
const projects = new ProjectStore(path.join(app.getPath('userData'), 'projects.json'));

const trackerSettings = new TrackerSettingsStore(path.join(app.getPath('userData'), 'trackers.json'));
const runCli = createCliRunner(app.getPath('userData'));
const trackers = new TrackersService({
  run: runCli,
  remotes: gitRemotes,
  projects: () => projects.load(),
  settings: () => trackerSettings.load(),
});

const mrs = new MrsService(trackers, runCli);

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
ipcMain.handle('session:create', (_event, cwd: string, addDirs: string[], start?: unknown) => {
  if (start === undefined) return sessions.create(cwd, addDirs);
  const prompt = validateSessionStart(start);
  if (!prompt) throw new Error('Некорректный старт сессии');
  if (!sessionDirsAllowed(projects.load(), cwd, addDirs)) throw new Error('Каталог не входит в репозитории проектов');
  return sessions.create(cwd, addDirs, prompt);
});
ipcMain.handle('trackers:load', () => trackerSettings.load());
ipcMain.handle('trackers:save', (_event, settings: unknown) => saveTrackerSettings(settings, trackerSettings, trackers));
ipcMain.handle('trackers:status', () => trackers.status());
ipcMain.handle('tasks:list', (_event, projectId: unknown, assignedToMe: unknown, tracked: unknown, recheck: unknown) => {
  const args = validateListArgs(projectId, assignedToMe, tracked, recheck);
  if (!args) throw new Error('Некорректные аргументы tasks:list');
  return trackers.list(args.projectId, args.assignedToMe, args.tracked, args.recheck);
});
ipcMain.handle('mrs:list', (_event, projectId: unknown, filter: unknown, tracked: unknown, recheck: unknown) => {
  const args = validateMrListArgs(projectId, filter, tracked, recheck);
  if (!args) throw new Error('Некорректные аргументы mrs:list');
  return mrs.listMrs(args.projectId, args.filter, args.tracked, args.recheck);
});
ipcMain.handle('mrs:details', (_event, id: unknown) => {
  const valid = validateMrDetailsArgs(id);
  if (valid === null) throw new Error('Некорректные аргументы mrs:details');
  return mrs.details(valid);
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
