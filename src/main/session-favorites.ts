import fs from 'node:fs';
import { isSessionId } from './history.ts';
import { writeJsonAtomic } from './jsonfile.ts';

const LIMIT = 500;

/** Избранные прошлые сессии по проектам: номера разговоров Claude Code, вкладка «Сессии» ставит их первыми и не отсекает лимитом. */
export class SessionFavorites {
  readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  private read(): Record<string, string[]> {
    try {
      const data: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (typeof data !== 'object' || data === null || Array.isArray(data)) return {};
      const out: Record<string, string[]> = {};
      for (const [project, ids] of Object.entries(data)) if (Array.isArray(ids)) out[project] = ids.filter(isSessionId);
      return out;
    } catch {
      return {};
    }
  }

  of(projectId: string): Set<string> {
    return new Set(this.read()[projectId] ?? []);
  }

  /** Отметка ставится или снимается; чужой номер - исключение с причиной для человека. */
  set(projectId: string, id: unknown, on: boolean): void {
    if (!isSessionId(id)) throw new Error('Некорректный номер сессии');
    const all = this.read();
    const ids = (all[projectId] ?? []).filter((x) => x !== id);
    if (on) ids.push(id);
    if (ids.length) all[projectId] = ids.slice(-LIMIT);
    else delete all[projectId];
    writeJsonAtomic(this.file, all);
  }
}
