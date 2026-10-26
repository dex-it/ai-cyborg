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

/**
 * Путь репозитория без символьных ссылок: git (`rev-parse --show-toplevel`) и Claude Code (cwd события хука, имя каталога
 * журнала в ~/.claude/projects) называют репозиторий физическим путём, и с путём через ссылку (`/tmp`, `/var` на macOS,
 * ссылка на рабочий каталог) корень сессии, смена ветки и история расходились бы с репозиторием проекта. Каталога нет
 * (репозиторий удалён или перенесён) - путь остаётся как задан: проект с ним открывается, а дерево покажет ошибку.
 */
export function canonicalRepo(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return dir;
    throw error;
  }
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
        repos: Array.isArray(p.repos) ? [...new Set(p.repos.map((repo) => (typeof repo === 'string' ? canonicalRepo(repo) : repo)))] : p.repos,
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
