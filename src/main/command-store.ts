import fs from 'node:fs';
import { writeJsonAtomic } from './jsonfile';

/** Общий набор кнопок команд - один файл в userData на все воркспейсы: корень - массив кнопок того же вида, что поле `commands` воркспейса. */
export class CommandStore {
  constructor(readonly file: string) {}

  /** raw - корень как записан (нет файла - undefined), problem - файл есть, но не прочитан или не JSON. */
  read(): { raw: unknown; problem?: string } {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { raw: undefined };
      return { raw: undefined, problem: `Файл общих кнопок ${this.file} не прочитан (${code ?? (error as Error).message})` };
    }
    try {
      return { raw: JSON.parse(text) };
    } catch (error) {
      return { raw: undefined, problem: `Файл общих кнопок ${this.file} не разобран (${(error as Error).message})` };
    }
  }

  /** Не прочитанный файл не затирается: в редакторе был встроенный набор вместо записанного. */
  saveCommands(commands: unknown[]): void {
    const { problem } = this.read();
    if (problem) throw new Error(`${problem}: исправьте его, кнопки записаны не были`);
    writeJsonAtomic(this.file, commands);
  }
}
