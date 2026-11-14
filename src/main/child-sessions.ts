import fs from 'node:fs';
import { isSessionId } from './history.ts';
import { writeJsonAtomic } from './jsonfile.ts';

// Журнал Claude Code не знает, кто открыл сессию: «История» помечает дочерние по этому перечню.
const LIMIT = 2000;

/** Номера разговоров Claude Code, открытых другой сессией (open_session, spawn_agent). */
export class ChildSessions {
  readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  private read(): string[] {
    try {
      const data: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(data) ? data.filter(isSessionId) : [];
    } catch {
      return [];
    }
  }

  add(id: string): void {
    if (!isSessionId(id)) return;
    const ids = this.read().filter((x) => x !== id);
    ids.push(id);
    try {
      writeJsonAtomic(this.file, ids.slice(-LIMIT));
    } catch (error) {
      console.error('Перечень дочерних сессий:', error);
    }
  }

  all(): Set<string> {
    return new Set(this.read());
  }
}
