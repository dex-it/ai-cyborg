import type { ProjectsState } from './projects';
import { sessionProject } from './trackers';

export interface ResumeDeps {
  envReady(): Promise<void>;
  projects(): ProjectsState;
  historyExists(cwd: string, id: string): boolean;
  isSessionId(id: unknown): id is string;
  projectOf(session: number): string | null | undefined;
  create(project: string, cwd: string, addDirs: string[], prompt: undefined, resume: string, opener: number | undefined): number;
}

/** Продолжение разговора: открывшая приходит при перезапуске дочерней вкладки; чужая и закрытая отбрасываются. */
export async function resumeSession(deps: ResumeDeps, projectId: unknown, cwd: unknown, addDirs: unknown, id: unknown, parent?: unknown): Promise<number> {
  await deps.envReady();
  const project = sessionProject(deps.projects(), projectId, cwd, addDirs)?.id;
  if (!deps.isSessionId(id) || !project) throw new Error('Некорректное продолжение сессии');
  if (!deps.historyExists(cwd as string, id)) throw new Error('Журнал сессии не найден');
  const opener = typeof parent === 'number' && deps.projectOf(parent) === project ? parent : undefined;
  return deps.create(project, cwd as string, addDirs as string[], undefined, id, opener);
}
