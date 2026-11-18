import fs from 'node:fs';
import path from 'node:path';

/** Чтение глобального CLAUDE.md: нет файла - пустой текст; problem - файл есть, но не прочитан. */
export interface ClaudeMdRead {
  text: string;
  problem?: string;
}

/** Глобальные инструкции Claude Code (`<configDir>/CLAUDE.md`): их подгружает каждая сессия на этой машине и зеркало удалённых. */
export class ClaudeMdStore {
  constructor(readonly file: string) {}

  read(): ClaudeMdRead {
    try {
      return { text: fs.readFileSync(this.file, 'utf8') };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { text: '' };
      return { text: '', problem: `Файл ${this.file} не прочитан (${code ?? (error as Error).message})` };
    }
  }

  /** base - текст, от которого шла правка: файл правят и сессии, поэтому расхождение - отказ, а не затирание. */
  save(text: unknown, base: unknown): { error?: string } {
    if (typeof text !== 'string' || typeof base !== 'string') return { error: 'Некорректная запись CLAUDE.md' };
    const current = this.read();
    if (current.problem) return { error: current.problem };
    if (current.text !== base) return { error: `${this.file} изменился на диске после открытия редактора. Скопируйте правку и откройте редактор заново.` };
    let target = this.file;
    try {
      // CLAUDE.md бывает ссылкой из dotfiles: rename на её месте заменил бы ссылку обычным файлом.
      target = fs.realpathSync(this.file);
    } catch {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
    }
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, target);
    } catch (error) {
      fs.rmSync(tmp, { force: true });
      return { error: `${this.file} не записан (${(error as Error).message})` };
    }
    return {};
  }
}
