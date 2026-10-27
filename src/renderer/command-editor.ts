// Правка кнопок команд (фича 12): действующий набор (встроенные и поле commands файла воркспейса) в Monaco.

import { commandsToText } from '../main/commands';
import { initConfigEditor } from './config-editor';

const api = window.cyborg;

export interface CommandEditorDeps {
  /** Замечания к файлу, как они сейчас видны у полосы. */
  problems(): readonly string[];
  /** Кнопки записаны: полоса перечитывает файл. */
  saved(): void;
}

export const initCommandEditor = (deps: CommandEditorDeps): { open(): Promise<void> } =>
  initConfigEditor({ prefix: 'commands', load: async () => commandsToText(await api.loadCommands()), save: (text) => api.saveCommands(text), reveal: () => api.revealConfig('commands'), ...deps });
