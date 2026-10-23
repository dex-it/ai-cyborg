import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, nativeTheme } from 'electron';
import { listDir, readTextFile } from './files';
import { gitBranch, gitRoot, gitStatus } from './git';
import { ProjectStore, type ProjectsState } from './projects';
import { SessionManager } from './sessions';

let win: BrowserWindow | null = null;
const sessions = new SessionManager(app.getPath('userData'), (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
});
const projects = new ProjectStore(path.join(app.getPath('userData'), 'projects.json'));

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
ipcMain.handle('session:create', (_event, cwd: string, addDirs: string[]) => sessions.create(cwd, addDirs));
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
