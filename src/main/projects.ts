import fs from 'node:fs';
import { writeJsonAtomic } from './jsonfile';

export interface TrackerSettings {
  github: boolean;
  gitlab: boolean;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  repos: string[];
  /** Источники задач проекта (FR-1010). */
  trackers: TrackerSettings;
}

export interface ProjectsState {
  projects: Project[];
  lastProjectId: string | null;
}

/** Поле источников из файла: не обычный объект - null (поле считается отсутствующим); в объекте всё, кроме true, - «выключен». */
export function readTrackers(value: unknown): TrackerSettings | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  return { github: raw.github === true, gitlab: raw.gitlab === true };
}

export class ProjectStore {
  /** defaults - значения прежнего общего trackers.json для проекта без поля источников; читаются лениво. */
  constructor(
    private readonly file: string,
    private readonly defaults: () => TrackerSettings = () => ({ github: false, gitlab: false }),
  ) {}

  load(): ProjectsState {
    try {
      const state = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<ProjectsState>;
      let fallback: TrackerSettings | undefined;
      const projects = (state.projects ?? []).map((p) => ({
        ...p,
        trackers: readTrackers((p as Partial<Project>).trackers) ?? { ...(fallback ??= this.defaults()) },
      }));
      return { projects, lastProjectId: state.lastProjectId ?? null };
    } catch {
      return { projects: [], lastProjectId: null };
    }
  }

  save(state: ProjectsState): void {
    writeJsonAtomic(this.file, state);
  }
}
