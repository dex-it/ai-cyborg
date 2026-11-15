import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './jsonfile';

const LIMIT = 1000;
const SHA256 = /^[0-9a-f]{64}$/;

/** Одобренные запуски: realpath файла -> SHA-256 содержимого, одобренного человеком. Один файл на все воркспейсы. */
export class RunApprovals {
  constructor(readonly file: string) {}

  private read(): Record<string, string> {
    try {
      const data: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (typeof data !== 'object' || data === null || Array.isArray(data)) return {};
      return Object.fromEntries(Object.entries(data).filter((e): e is [string, string] => path.isAbsolute(e[0]) && typeof e[1] === 'string' && SHA256.test(e[1])));
    } catch {
      return {};
    }
  }

  get(real: string): string | undefined {
    return this.read()[real];
  }

  /** Сбой записи не бросает: запуск идёт, в следующий раз спросят снова. */
  set(real: string, sha256: string): boolean {
    const all = this.read();
    delete all[real];
    all[real] = sha256;
    try {
      writeJsonAtomic(this.file, Object.fromEntries(Object.entries(all).slice(-LIMIT)));
      return true;
    } catch (error) {
      console.error('Одобрения запуска:', error);
      return false;
    }
  }
}
