import fs from 'node:fs';
import { writeJsonAtomic } from './jsonfile';

export interface Project {
  id: string;
  name: string;
  description: string;
  repos: string[];
}

export interface ProjectsState {
  projects: Project[];
  lastProjectId: string | null;
}

export class ProjectStore {
  constructor(private readonly file: string) {}

  load(): ProjectsState {
    try {
      const state = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<ProjectsState>;
      return { projects: state.projects ?? [], lastProjectId: state.lastProjectId ?? null };
    } catch {
      return { projects: [], lastProjectId: null };
    }
  }

  save(state: ProjectsState): void {
    writeJsonAtomic(this.file, state);
  }
}
