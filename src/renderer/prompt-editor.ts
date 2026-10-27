// Правка промптов кнопок запуска сессий (фича 12): действующий набор (встроенные и поле prompts файла воркспейса) в Monaco.

import { parsePrompts, promptsToText } from '../main/prompts';
import { initConfigEditor } from './config-editor';

const api = window.cyborg;

/** Замечания к полю `prompts`, как оно записано сейчас: открытие редактора показывает их, сессия по негодному промпту не стартует. */
let problems: string[] = [];

export const initPromptEditor = (): { open(): Promise<void> } =>
  initConfigEditor({
    prefix: 'prompts',
    load: async () => {
      const raw = await api.loadPrompts();
      problems = parsePrompts(raw).problems;
      return promptsToText(raw);
    },
    save: (text) => api.savePrompts(text),
    problems: () => problems,
    saved: () => {
      problems = [];
    },
  });
