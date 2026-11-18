// Правка глобального CLAUDE.md Claude Code из меню: инструкции, которые подгружает каждая сессия.

import { initConfigEditor } from './config-editor';

const api = window.cyborg;

let problems: string[] = [];
let base = '';

export const initClaudeMdEditor = (): { open(): Promise<void> } =>
  initConfigEditor({
    prefix: 'claude-md',
    language: 'markdown',
    load: async () => {
      const { text, problem } = await api.loadClaudeMd();
      problems = problem ? [problem] : [];
      base = text;
      return text;
    },
    save: (text) => api.saveClaudeMd(text, base),
    reveal: () => api.revealConfig('claude-md'),
    problems: () => problems,
    saved: () => {
      problems = [];
    },
  });
