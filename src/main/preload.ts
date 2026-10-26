import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DirEntry } from './files';
import type { Branches } from './git';
import type { HistoryEntry } from './history';
import type { JiraDetailsResult, JiraListResult, JiraStatus } from './jira';
import type { MrDetailsResult, MrFilter, MrListResult, MrRef, SessionStart } from './mrs';
import type { ProjectsProblem, ProjectsState } from './projects';
import type { TaskDetailsResult } from './task-details';
import type { TaskRef, TasksResult, TrackersStatus } from './trackers';

const api = {
  platform: process.platform,
  pickDir: (defaultPath?: string): Promise<string | null> => ipcRenderer.invoke('dialog:pickDir', defaultPath),
  loadProjects: (): Promise<ProjectsState> => ipcRenderer.invoke('projects:load'),
  projectsProblem: (): Promise<ProjectsProblem | null> => ipcRenderer.invoke('projects:problem'),
  saveProjects: (state: ProjectsState): Promise<void> => ipcRenderer.invoke('projects:save', state),
  createSession: (cwd: string, addDirs: string[], start?: SessionStart): Promise<number> =>
    ipcRenderer.invoke('session:create', cwd, addDirs, start),
  listHistory: (projectId: string): Promise<HistoryEntry[]> => ipcRenderer.invoke('history:list', projectId),
  deleteHistory: (projectId: string, repo: string, id: string): Promise<void> =>
    ipcRenderer.invoke('history:delete', projectId, repo, id),
  resumeSession: (cwd: string, addDirs: string[], id: string): Promise<number> =>
    ipcRenderer.invoke('session:resume', cwd, addDirs, id),
  trackersStatus: (): Promise<TrackersStatus> => ipcRenderer.invoke('trackers:status'),
  listTasks: (projectId: string, assignedToMe: boolean, tracked: TaskRef[], recheck: boolean): Promise<TasksResult> =>
    ipcRenderer.invoke('tasks:list', projectId, assignedToMe, tracked, recheck),
  taskDetails: (selection: number, ref: TaskRef): Promise<TaskDetailsResult> => ipcRenderer.invoke('tasks:details', selection, ref),
  sessionTaskDetails: (ref: TaskRef): Promise<TaskDetailsResult> => ipcRenderer.invoke('tasks:sessionDetails', ref),
  openTask: (ref: TaskRef): Promise<{ error?: string }> => ipcRenderer.invoke('tasks:open', ref),
  jiraStatus: (): Promise<JiraStatus> => ipcRenderer.invoke('jira:status'),
  listJira: (projectId: string, recheck: boolean): Promise<JiraListResult> => ipcRenderer.invoke('jira:list', projectId, recheck),
  jiraDetails: (projectId: string, key: string): Promise<JiraDetailsResult> => ipcRenderer.invoke('jira:details', projectId, key),
  openJira: (projectId: string, key: string): Promise<{ error?: string }> => ipcRenderer.invoke('jira:open', projectId, key),
  listMrs: (projectId: string, filter: MrFilter, tracked: MrRef[], recheck: boolean): Promise<MrListResult> =>
    ipcRenderer.invoke('mrs:list', projectId, filter, tracked, recheck),
  openMr: (ref: MrRef): Promise<{ error?: string }> => ipcRenderer.invoke('mrs:open', ref),
  mrDetails: (id: number): Promise<MrDetailsResult | null> => ipcRenderer.invoke('mrs:details', id),
  input: (id: number, data: string): void => ipcRenderer.send('session:input', id, data),
  resize: (id: number, cols: number, rows: number): void => ipcRenderer.send('session:resize', id, cols, rows),
  kill: (id: number): void => ipcRenderer.send('session:kill', id),
  listDir: (dir: string): Promise<DirEntry[]> => ipcRenderer.invoke('fs:list', dir),
  readFile: (file: string): Promise<{ content?: string; error?: string }> => ipcRenderer.invoke('fs:read', file),
  gitRoot: (dir: string): Promise<string | null> => ipcRenderer.invoke('git:root', dir),
  gitBranch: (root: string): Promise<string | null> => ipcRenderer.invoke('git:branch', root),
  gitStatus: (root: string): Promise<Record<string, string>> => ipcRenderer.invoke('git:status', root),
  gitBranches: (root: string): Promise<Branches> => ipcRenderer.invoke('git:branches', root),
  gitSwitch: (root: string, branch: string): Promise<{ error?: string }> => ipcRenderer.invoke('git:switch', root, branch),
  gitHeadContent: (file: string): Promise<string | null> => ipcRenderer.invoke('git:headContent', file),
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  on: <T>(channel: string, listener: (payload: T) => void): (() => void) => {
    const handler = (_event: unknown, payload: T) => listener(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
};

contextBridge.exposeInMainWorld('cyborg', api);

export type CyborgApi = typeof api;
