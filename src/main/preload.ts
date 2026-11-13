import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { ActionReply, ExtensionsAction, ExtensionsReply, ExtensionsRequest, Hub, HubContent, HubOp, ProbeReply, UsageReply } from '../shared/extensions';
import type { SearchReply, SearchRequest } from '../shared/search-pattern';
import type { CommandsConfig, CommandsScope } from './commands';
import type { DirEntry, WriteReply } from './files';
import type { Branches } from './git';
import type { HistoryEntry } from './history';
import type { JiraDetailsResult, JiraListResult, JiraProjectsResult, JiraStatus, JiraSuggestion } from './jira';
import type { MrDetailsResult, MrFilter, MrListResult, MrRef, SessionStart } from './mrs';
import type { ProjectsProblem, ProjectsState } from './projects';
import type { TaskDetailsResult } from './task-details';
import type { ClaudeTokenStatus } from './remote/claude-token';
import type { HostDisk, PurgeResult } from '../shared/host-disk';
import type { RemoteHistory, RemoteInfo } from './remote/remote-sessions';
import type { TaskRef, TasksResult, TrackersStatus } from './trackers';

export interface WorkspaceInfo {
  file: string | null;
  name: string | null;
  home: string;
  sep: string;
}

export type WorkspaceCreateReply = { error?: string; exists?: true };

const api = {
  platform: process.platform,
  pickDir: (defaultPath?: string): Promise<string | null> => ipcRenderer.invoke('dialog:pickDir', defaultPath),
  pickWorkspaceDir: (defaultPath?: string): Promise<string | null> => ipcRenderer.invoke('dialog:pickWorkspaceDir', defaultPath),
  workspaceInfo: (): Promise<WorkspaceInfo> => ipcRenderer.invoke('workspace:info'),
  createWorkspace: (request: unknown): Promise<WorkspaceCreateReply> => ipcRenderer.invoke('workspace:create', request),
  openWorkspace: (file: string): Promise<boolean> => ipcRenderer.invoke('workspace:open', file),
  projectSelected: (selected: boolean): void => ipcRenderer.send('project:selected', selected),
  loadProjects: (): Promise<ProjectsState> => ipcRenderer.invoke('projects:load'),
  projectsProblem: (): Promise<ProjectsProblem | null> => ipcRenderer.invoke('projects:problem'),
  saveProjects: (state: ProjectsState): Promise<void> => ipcRenderer.invoke('projects:save', state),
  loadCommands: (): Promise<CommandsConfig> => ipcRenderer.invoke('commands:load'),
  saveCommands: (text: string, scope: CommandsScope): Promise<{ error?: string }> => ipcRenderer.invoke('commands:save', text, scope),
  loadPrompts: (): Promise<{ raw: unknown; problem?: string }> => ipcRenderer.invoke('prompts:load'),
  savePrompts: (text: string): Promise<{ error?: string }> => ipcRenderer.invoke('prompts:save', text),
  /** Путь из вывода сессии - в приложении системы по умолчанию; о неудаче сообщает главный процесс. */
  openPath: (file: string): Promise<void> => ipcRenderer.invoke('path:open', file),
  /** http(s)-ссылка - в браузере системы; иные схемы главный процесс отбрасывает. */
  openUrl: (url: string): Promise<void> => ipcRenderer.invoke('url:open', url),
  /** Файл кнопок (воркспейса или общий) либо промптов - в приложении системы по умолчанию; о неудаче сообщает главный процесс. */
  revealConfig: (kind: 'commands' | 'commands-global' | 'prompts'): Promise<void> => ipcRenderer.invoke('config:reveal', kind),
  createSession: (cwd: string, addDirs: string[], start?: SessionStart): Promise<number> =>
    ipcRenderer.invoke('session:create', cwd, addDirs, start),
  /** Удалённая сессия: либо {projectId, host, repo, branch, prompt?}, либо {projectId, handoff, repo} по передаче от сессии. */
  createRemoteSession: (request: { projectId: string; host?: string; repo: string; branch?: string; handoff?: string }): Promise<RemoteInfo> =>
    ipcRenderer.invoke('remote:create', request),
  remoteDiscover: (projectId: string): Promise<RemoteInfo[]> => ipcRenderer.invoke('remote:discover', projectId),
  /** Чтение клонов удалённой сессии: записи и смены ветки у канала нет. */
  remoteFs: (id: number, op: 'list' | 'read' | 'root' | 'branch' | 'status' | 'head' | 'files', path: string): Promise<unknown> => ipcRenderer.invoke('remote:fs', id, op, path),
  /** Поиск по клонам удалённой сессии на хосте. */
  remoteSearch: (id: number, mode: 'text' | 'changes', request: SearchRequest): Promise<SearchReply> => ipcRenderer.invoke('remote:search', id, mode, request),
  listHistory: (projectId: string): Promise<HistoryEntry[]> => ipcRenderer.invoke('history:list', projectId),
  listRemoteHistory: (projectId: string): Promise<RemoteHistory> => ipcRenderer.invoke('history:remote', projectId),
  /** Спящая удалённая сессия из «Истории»: claude --resume на хосте. */
  remoteWake: (projectId: string, host: string, sid: string): Promise<RemoteInfo> => ipcRenderer.invoke('remote:wake', projectId, host, sid),
  /** Удаление спящей: клоны убираются; непустой ответ - отказ уборки для окна. */
  remoteRemoveAsleep: (projectId: string, host: string, sid: string): Promise<string> => ipcRenderer.invoke('remote:remove-asleep', projectId, host, sid),
  /** Место на хосте и сессии, которые его занимают. */
  remoteDisk: (projectId: string, host: string): Promise<HostDisk> => ipcRenderer.invoke('remote:disk', projectId, host),
  /** force - удалить и клоны с незапушенной работой. */
  remotePurge: (projectId: string, host: string, sids: string[], force: boolean): Promise<PurgeResult[]> =>
    ipcRenderer.invoke('remote:purge', projectId, host, sids, force),
  /** Токен claude setup-token удалённых агентов: значение в интерфейс не возвращается. */
  claudeTokenStatus: (): Promise<ClaudeTokenStatus> => ipcRenderer.invoke('remote:claude-token:status'),
  setClaudeToken: (value: string): Promise<ClaudeTokenStatus> => ipcRenderer.invoke('remote:claude-token:set', value),
  clearClaudeToken: (): Promise<ClaudeTokenStatus> => ipcRenderer.invoke('remote:claude-token:clear'),
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
  jiraProjects: (recheck: boolean): Promise<JiraProjectsResult> => ipcRenderer.invoke('jira:projects', recheck),
  jiraSuggest: (repos: string[]): Promise<JiraSuggestion[]> => ipcRenderer.invoke('jira:suggest', repos),
  jiraDetails: (projectId: string, key: string): Promise<JiraDetailsResult> => ipcRenderer.invoke('jira:details', projectId, key),
  openJira: (projectId: string, key: string): Promise<{ error?: string }> => ipcRenderer.invoke('jira:open', projectId, key),
  listMrs: (projectId: string, filter: MrFilter, tracked: MrRef[], recheck: boolean): Promise<MrListResult> =>
    ipcRenderer.invoke('mrs:list', projectId, filter, tracked, recheck),
  openMr: (ref: MrRef): Promise<{ error?: string }> => ipcRenderer.invoke('mrs:open', ref),
  mrDetails: (id: number): Promise<MrDetailsResult | null> => ipcRenderer.invoke('mrs:details', id),
  input: (id: number, data: string): void => ipcRenderer.send('session:input', id, data),
  /** Ответ на mic:start: null - захват начат, строка - отказ. */
  micStarted: (stream: number, refusal: string | null): void => ipcRenderer.send('mic:started', stream, refusal),
  micData: (stream: number, pcm: Uint8Array): void => ipcRenderer.send('mic:data', stream, pcm),
  micEnd: (stream: number): void => ipcRenderer.send('mic:end', stream),
  resize: (id: number, cols: number, rows: number): void => ipcRenderer.send('session:resize', id, cols, rows),
  kill: (id: number): void => ipcRenderer.send('session:kill', id),
  /** Вкладку по передаче от сессии открыть не удалось: причина вернётся передавшей модели. */
  handoffFailed: (hid: string, reason: string): void => ipcRenderer.send('session:handoffFailed', hid, reason),
  notify: (id: number, title: string, body: string): void => ipcRenderer.send('session:notify', id, title, body),
  unnotify: (id: number): void => ipcRenderer.send('session:unnotify', id),
  notificationsState: (enabled: boolean): void => ipcRenderer.send('notifications:state', enabled),
  listDir: (dir: string): Promise<DirEntry[]> => ipcRenderer.invoke('fs:list', dir),
  listFiles: (root: string): Promise<string[]> => ipcRenderer.invoke('fs:files', root),
  searchText: (request: SearchRequest): Promise<SearchReply> => ipcRenderer.invoke('search:text', request),
  searchChanges: (request: SearchRequest): Promise<SearchReply> => ipcRenderer.invoke('search:changes', request),
  loadExtensions: (request: ExtensionsRequest): Promise<ExtensionsReply> => ipcRenderer.invoke('extensions:load', request),
  probeMcp: (dir: string | null): Promise<ProbeReply> => ipcRenderer.invoke('extensions:probe', dir),
  extensionsAct: (action: ExtensionsAction): Promise<ActionReply> => ipcRenderer.invoke('extensions:act', action),
  extensionsUsage: (): Promise<UsageReply> => ipcRenderer.invoke('extensions:usage'),
  listHubs: (): Promise<Hub[]> => ipcRenderer.invoke('hubs:list'),
  changeHubs: (op: HubOp): Promise<{ hubs?: Hub[]; error?: string }> => ipcRenderer.invoke('hubs:change', op),
  fetchHub: (id: string, force = false): Promise<HubContent> => ipcRenderer.invoke('hubs:fetch', id, force),
  readFile: (file: string): Promise<{ content?: string; error?: string }> => ipcRenderer.invoke('fs:read', file),
  /** Перезапись Markdown правкой; разошёлся с base - conflict, если не force. */
  writeFile: (request: { file: string; content: string; base: string; force?: boolean }): Promise<WriteReply> => ipcRenderer.invoke('fs:write', request),
  /** Сколько файлов с несохранённой правкой: закрытие окна спросит про них. */
  reportUnsaved: (count: number): void => ipcRenderer.send('edits:unsaved', count),
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
