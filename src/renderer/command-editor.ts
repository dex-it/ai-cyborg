// Правка кнопок команд (фича 12): общий набор (userData) или набор воркспейса в Monaco, каждый поверх того, что под ним.

import { commandsToText, globalBase, type CommandsScope } from '../main/commands';
import { initConfigEditor, type ConfigEditor } from './config-editor';
import { byId } from './dom';

const api = window.cyborg;

export interface CommandEditorDeps {
  mac: boolean;
  /** Замечания к файлу, как они сейчас видны у полосы. */
  problems(): readonly string[];
  /** Кнопки записаны: полоса перечитывает файл. */
  saved(): void;
}

export function initCommandEditor(deps: CommandEditorDeps): ConfigEditor {
  let scope: CommandsScope = 'workspace';
  const tabs: Record<CommandsScope, HTMLElement> = { global: byId('commands-scope-global'), workspace: byId('commands-scope-workspace') };
  const hints: Record<CommandsScope, HTMLElement> = { global: byId('commands-hint-global'), workspace: byId('commands-hint-workspace') };
  const mark = (): void => {
    for (const key of Object.keys(tabs) as CommandsScope[]) {
      tabs[key].setAttribute('aria-pressed', String(key === scope));
      hints[key].hidden = key !== scope;
    }
  };
  const editor = initConfigEditor({
    prefix: 'commands',
    load: async () => {
      const config = await api.loadCommands();
      mark();
      return scope === 'global' ? commandsToText(config.global) : commandsToText(config.workspace, globalBase(config.global, deps.mac));
    },
    save: (text) => api.saveCommands(text, scope),
    reveal: () => api.revealConfig(scope === 'global' ? 'commands-global' : 'commands'),
    problems: deps.problems,
    saved: deps.saved,
  });
  for (const key of Object.keys(tabs) as CommandsScope[]) {
    tabs[key].addEventListener('click', async () => {
      if (key === scope) return;
      const before = scope;
      scope = key;
      if (!(await editor.reload())) scope = before;
      mark();
    });
  }
  return editor;
}
