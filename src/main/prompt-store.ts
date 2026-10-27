import fs from 'node:fs';
import { writeJsonAtomic } from './jsonfile';

/** Чтение файла промптов: raw - корень как записан (нет файла - undefined), problem - файл есть, но не прочитан или не JSON. */
export interface PromptsRead {
  raw: unknown;
  problem?: string;
}

/** Промпты кнопок запуска сессий - один файл в userData на все воркспейсы: корень - объект `{ "<id>": { "text", "description" } }`. */
export class PromptStore {
  constructor(private readonly file: string) {}

  read(): PromptsRead {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { raw: undefined };
      return { raw: undefined, problem: `Файл промптов ${this.file} не прочитан (${code ?? (error as Error).message})` };
    }
    try {
      return { raw: JSON.parse(text) };
    } catch (error) {
      return { raw: undefined, problem: `Файл промптов ${this.file} не разобран (${(error as Error).message})` };
    }
  }

  /** Для старта сессии: файл, который не прочитан, - ошибка, а не молчаливая замена встроенными промптами. */
  load(): unknown {
    const { raw, problem } = this.read();
    if (problem) throw new Error(`${problem}. Исправьте его или меню «Воркспейс → Промпты кнопок…».`);
    return raw;
  }

  savePrompts(prompts: Record<string, unknown>): void {
    writeJsonAtomic(this.file, prompts);
  }
}
