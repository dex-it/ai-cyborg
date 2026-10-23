import { contextBridge, ipcRenderer } from 'electron';
import type { DirEntry } from './files';
import type { ProjectsState } from './projects';
import type { TaskRef, TasksResult, TrackerSettings, TrackersStatus } from './trackers';

const api = {
  pickDir: (defaultPath?: string): Promise<string | null> => ipcRenderer.invoke('dialog:pickDir', defaultPath),
  loadProjects: (): Promise<ProjectsState> => ipcRenderer.invoke('projects:load'),
  saveProjects: (state: ProjectsState): Promise<void> => ipcRenderer.invoke('projects:save', state),
  createSession: (cwd: string, addDirs: string[], task?: TaskRef): Promise<number> =>
    ipcRenderer.invoke('session:create', cwd, addDirs, task),
  loadTrackerSettings: (): Promise<TrackerSettings> => ipcRenderer.invoke('trackers:load'),
  saveTrackerSettings: (settings: TrackerSettings): Promise<void> => ipcRenderer.invoke('trackers:save', settings),
  trackersStatus: (): Promise<TrackersStatus> => ipcRenderer.invoke('trackers:status'),
  listTasks: (projectId: string, assignedToMe: boolean, tracked: TaskRef[]): Promise<TasksResult> =>
    ipcRenderer.invoke('tasks:list', projectId, assignedToMe, tracked),
  input: (id: number, data: string): void => ipcRenderer.send('session:input', id, data),
  resize: (id: number, cols: number, rows: number): void => ipcRenderer.send('session:resize', id, cols, rows),
  kill: (id: number): void => ipcRenderer.send('session:kill', id),
  listDir: (dir: string): Promise<DirEntry[]> => ipcRenderer.invoke('fs:list', dir),
  readFile: (file: string): Promise<{ content?: string; error?: string }> => ipcRenderer.invoke('fs:read', file),
  gitRoot: (dir: string): Promise<string | null> => ipcRenderer.invoke('git:root', dir),
  gitBranch: (root: string): Promise<string | null> => ipcRenderer.invoke('git:branch', root),
  gitStatus: (root: string): Promise<Record<string, string>> => ipcRenderer.invoke('git:status', root),
  on: <T>(channel: string, listener: (payload: T) => void): (() => void) => {
    const handler = (_event: unknown, payload: T) => listener(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
};

contextBridge.exposeInMainWorld('cyborg', api);

export type CyborgApi = typeof api;
