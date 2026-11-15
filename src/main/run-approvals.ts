import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './jsonfile';

const LIMIT = 1000;
const SHA256 = /^[0-9a-f]{64}$/;

/** Что человек одобрил: содержимое и команда, которой оно запускается (снятый бит исполнения меняет команду, а не хэш). */
export interface Approval {
  sha256: string;
  command: string[];
}

const isApproval = (value: unknown): value is Approval => {
  if (typeof value !== 'object' || value === null) return false;
  const { sha256, command } = value as Record<string, unknown>;
  return typeof sha256 === 'string' && SHA256.test(sha256) && Array.isArray(command) && command.length > 0 && command.every((word) => typeof word === 'string');
};

/** Одобренные запуски: realpath файла -> одобрение человека. Один файл на все воркспейсы. */
export class RunApprovals {
  constructor(readonly file: string) {}

  private read(): Record<string, Approval> {
    try {
      const data: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (typeof data !== 'object' || data === null || Array.isArray(data)) return {};
      return Object.fromEntries(Object.entries(data).filter((e): e is [string, Approval] => path.isAbsolute(e[0]) && isApproval(e[1])));
    } catch {
      return {};
    }
  }

  get(real: string): Approval | undefined {
    return this.read()[real];
  }

  /** Сбой записи не бросает: запуск идёт, в следующий раз спросят снова. */
  set(real: string, approval: Approval): boolean {
    const all = this.read();
    delete all[real];
    all[real] = { sha256: approval.sha256, command: [...approval.command] };
    try {
      writeJsonAtomic(this.file, Object.fromEntries(Object.entries(all).slice(-LIMIT)));
      return true;
    } catch (error) {
      console.error('Одобрения запуска:', error);
      return false;
    }
  }
}
