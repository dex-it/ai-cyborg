// Правка промптов кнопок запуска сессий (фича 12): действующий набор (встроенные и общий для всех воркспейсов prompts.json в userData) в Monaco.

import { parsePrompts, promptsToText } from '../main/prompts';
import { initConfigEditor } from './config-editor';

const api = window.cyborg;

/** Замечания к файлу промптов, как он записан сейчас: открытие редактора показывает их, сессия по негодному промпту не стартует. */
let problems: string[] = [];

export const initPromptEditor = (): { open(): Promise<void> } =>
  initConfigEditor({
    prefix: 'prompts',
    load: async () => {
      const { raw, problem } = await api.loadPrompts();
      problems = problem ? [`${problem}: показан встроенный набор, сохранение заменит файл`] : parsePrompts(raw).problems;
      return promptsToText(raw);
    },
    save: (text) => api.savePrompts(text),
    reveal: () => api.revealConfig('prompts'),
    problems: () => problems,
    saved: () => {
      problems = [];
    },
  });
