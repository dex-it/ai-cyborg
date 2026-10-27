// Правка настроек в файле воркспейса (фича 12): JSON поля в Monaco, без отдельной формы. Один диалог служит и кнопкам команд, и промптам кнопок.

import { byId } from './dom';
import { createJsonEditor, type JsonEditor } from './viewer';

export interface ConfigEditorDeps {
  /** Начало id элементов диалога: `<prefix>-dialog`, `-editor`, `-problems`, `-error`, `-save`, `-cancel`. */
  prefix: string;
  /** Текст для редактора: действующий набор. */
  load(): Promise<string>;
  /** Запись текста главным процессом, он проверяет его сам. */
  save(text: string): Promise<{ error?: string }>;
  /** Замечания к файлу, как они сейчас известны. */
  problems(): readonly string[];
  /** Записано: потребитель перечитывает файл. */
  saved(): void;
}

export function initConfigEditor(deps: ConfigEditorDeps): { open(): Promise<void> } {
  const dialog = byId<HTMLDialogElement>(`${deps.prefix}-dialog`);
  const host = byId(`${deps.prefix}-editor`);
  const problemsEl = byId(`${deps.prefix}-problems`);
  const errorEl = byId(`${deps.prefix}-error`);
  const saveButton = byId<HTMLButtonElement>(`${deps.prefix}-save`);
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
      const reply = await deps.save(text);
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
  byId(`${deps.prefix}-cancel`).addEventListener('click', () => {
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
      initial = await deps.load();
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
