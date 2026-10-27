// Правка кнопок команд (фича 12): JSON поля commands файла воркспейса в Monaco, без отдельной формы.

import { commandsToText } from '../main/commands';
import { byId } from './dom';
import { createJsonEditor, type JsonEditor } from './viewer';

const api = window.cyborg;

export interface CommandEditorDeps {
  /** Замечания к файлу, как они сейчас видны у полосы. */
  problems(): readonly string[];
  /** Кнопки записаны: полоса перечитывает файл. */
  saved(): void;
}

export function initCommandEditor(deps: CommandEditorDeps): { open(): Promise<void> } {
  const dialog = byId<HTMLDialogElement>('commands-dialog');
  const host = byId('commands-editor');
  const problemsEl = byId('commands-problems');
  const errorEl = byId('commands-error');
  const saveButton = byId<HTMLButtonElement>('commands-save');
  let editor: JsonEditor | null = null;
  let initial = '';

  const showError = (text: string): void => {
    errorEl.textContent = text;
    errorEl.hidden = !text;
  };
  const dirty = (): boolean => editor !== null && editor.getValue() !== initial;
  const discardable = (): boolean => !dirty() || confirm('Закрыть без сохранения?');

  async function save(): Promise<void> {
    if (!editor) return;
    const text = editor.getValue();
    showError('');
    saveButton.disabled = true;
    try {
      const reply = await api.saveCommands(text);
      if (reply.error) {
        showError(reply.error);
        return;
      }
      initial = text;
      dialog.close();
      deps.saved();
    } catch (error) {
      showError((error as Error).message);
    } finally {
      saveButton.disabled = false;
    }
  }

  saveButton.addEventListener('click', () => void save());
  byId('commands-cancel').addEventListener('click', () => {
    if (discardable()) dialog.close();
  });
  // Escape закрывает диалог сам: незаписанная правка спрашивает подтверждение.
  dialog.addEventListener('cancel', (event) => {
    if (!discardable()) event.preventDefault();
  });
  dialog.addEventListener('close', () => {
    editor?.dispose();
    editor = null;
  });

  return {
    async open(): Promise<void> {
      if (dialog.open) return;
      initial = commandsToText(await api.loadCommands());
      showError('');
      const problems = deps.problems();
      problemsEl.textContent = problems.length ? `Замечания к текущему файлу:\n${problems.join('\n')}` : '';
      problemsEl.hidden = !problems.length;
      dialog.showModal();
      const created = await createJsonEditor(host, initial, () => void save());
      if (!dialog.open) {
        created.dispose();
        return;
      }
      editor = created;
      editor.focus();
    },
  };
}
