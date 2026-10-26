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

/** Что не так с файлом проектов при последнем чтении (ADR-0004, п.4). */
export interface ProjectsProblem {
  /** corrupt - файл прочитан, но не разобран; unreadable - прочитать не удалось (права, ошибка ввода-вывода). */
  kind: 'corrupt' | 'unreadable';
  /** Подробности для пользователя: причина разбора или код ошибки чтения. */
  detail: string;
  /** corrupt: путь копии исходных байт рядом с файлом проектов. */
  copy?: string;
}

/** Файл разобран, но не в форме состояния проектов: причина или null. */
function shapeProblem(state: unknown): string | null {
  if (typeof state !== 'object' || state === null || Array.isArray(state)) return 'корень файла не объект';
  const projects = (state as { projects?: unknown }).projects;
  if (!Array.isArray(projects)) return 'поле projects не массив';
  if (projects.some((p) => typeof p !== 'object' || p === null || Array.isArray(p))) return 'проект не объект';
  return null;
}

/** Метка UTC для имени копии: 20261026T081530. */
function utcStamp(date: Date): string {
  return date.toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '');
}

export class ProjectStore {
  private lastProblem: ProjectsProblem | null = null;
  /** Байты повреждённого файла, для которых копия уже сделана: повторное чтение того же файла копий не плодит. */
  private copied: Buffer | null = null;
  private unreadable = false;

  /** defaults - значения прежнего общего trackers.json для проекта без поля источников; читаются лениво. */
  constructor(
    private readonly file: string,
    private readonly defaults: () => TrackerSettings = () => ({ github: false, gitlab: false }),
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Файла нет - пустой перечень без замечаний. Файл повреждён - рядом копия его байт, пустой перечень и problem();
   * исходный файл остаётся до первого save. Файл не прочитан - пустой перечень, problem(), save() отказывает.
   */
  load(): ProjectsState {
    this.unreadable = false;
    let raw: Buffer;
    try {
      raw = fs.readFileSync(this.file);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { projects: [], lastProjectId: null };
      if (!code) throw error;
      this.unreadable = true;
      this.lastProblem = { kind: 'unreadable', detail: code };
      return { projects: [], lastProjectId: null };
    }
    let parsed: unknown;
    let reason: string | null;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
      reason = shapeProblem(parsed);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      reason = error.message;
    }
    if (reason !== null) {
      this.lastProblem = { kind: 'corrupt', detail: reason, copy: this.keepCopy(raw) };
      return { projects: [], lastProjectId: null };
    }
    const state = parsed as Partial<ProjectsState>;
    let fallback: TrackerSettings | undefined;
    const projects = (state.projects ?? []).map((p) => ({
      ...p,
      repos: Array.isArray(p.repos) ? [...new Set(p.repos.map((repo) => (typeof repo === 'string' ? canonicalRepo(repo) : repo)))] : p.repos,
      trackers: readTrackers((p as Partial<Project>).trackers) ?? { ...(fallback ??= this.defaults()) },
    }));
    return { projects, lastProjectId: state.lastProjectId ?? null };
  }

  /** Замечание последнего чтения, пока приложение работает: после первого save файл заменён, а копия и замечание остаются. */
  problem(): ProjectsProblem | null {
    return this.lastProblem;
  }

  save(state: ProjectsState): void {
    if (this.unreadable) throw new Error(`Файл проектов не прочитан (${this.lastProblem?.detail}), запись затёрла бы его`);
    writeJsonAtomic(this.file, state);
  }

  /** Копия байт повреждённого файла рядом с ним; существующие копии не перезаписываются. Те же байты - прежняя копия. */
  private keepCopy(raw: Buffer): string {
    if (this.copied?.equals(raw) && this.lastProblem?.copy) return this.lastProblem.copy;
    const base = `${this.file}.corrupt-${utcStamp(this.now())}`;
    for (let n = 0; ; n++) {
      const target = n === 0 ? base : `${base}-${n}`;
      try {
        fs.writeFileSync(target, raw, { flag: 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw error;
      }
      this.copied = raw;
      return target;
    }
  }
}
