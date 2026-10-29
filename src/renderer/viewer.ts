import type * as Monaco from 'monaco-editor';
import { basename, el } from './dom';
import { loadFontSize } from './font-size';
import { monacoTheme } from './theme';

let fontSize = loadFontSize();
let monacoPromise: Promise<typeof Monaco> | null = null;

function loadMonaco(): Promise<typeof Monaco> {
  monacoPromise ??= new Promise((resolve, reject) => {
    window.require.config({ paths: { vs: 'vs' } });
    window.require(['vs/editor/editor.main'], () => resolve(window.monaco!), reject);
  });
  return monacoPromise;
}

export function applyMonacoTheme(): void {
  window.monaco?.editor.setTheme(monacoTheme());
}

export function applyMonacoFontSize(size: number): void {
  fontSize = size;
  for (const editor of window.monaco?.editor.getEditors() ?? []) editor.updateOptions({ fontSize });
}

function detectLanguage(monaco: typeof Monaco, path: string): string {
  const name = basename(path).toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  const lang = monaco.languages
    .getLanguages()
    .find((l) => l.filenames?.some((f) => f.toLowerCase() === name) || (ext && l.extensions?.includes(ext)));
  return lang?.id ?? 'plaintext';
}

export interface JsonEditor {
  getValue(): string;
  focus(): void;
  dispose(): void;
}

/** Редактируемый JSON для диалога кнопок команд: тот же Monaco, тема и размер шрифта, что у просмотра файлов; Cmd/Ctrl+S зовёт onSave. */
export async function createJsonEditor(body: HTMLElement, value: string, onSave: () => void): Promise<JsonEditor> {
  const monaco = await loadMonaco();
  const editor = monaco.editor.create(body, {
    value,
    language: 'json',
    theme: monacoTheme(),
    automaticLayout: true,
    fontSize,
    scrollBeyondLastLine: false,
    minimap: { enabled: false },
    tabSize: 2,
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, onSave);
  return {
    getValue: () => editor.getValue(),
    focus: () => editor.focus(),
    dispose: () => {
      editor.getModel()?.dispose();
      editor.dispose();
    },
  };
}

/** Просмотр одного файла; содержимое перечитывается с диска при каждом показе, изменённый против HEAD - сравнением. */
export class FileViewer {
  private editor?: Monaco.editor.IStandaloneCodeEditor;
  private diff?: Monaco.editor.IStandaloneDiffEditor;

  constructor(
    readonly path: string,
    private readonly body: HTMLElement,
  ) {}

  /** Окончание последнего чтения: переход к строке ждёт, пока в редакторе появится содержимое. */
  private loading: Promise<void> = Promise.resolve();

  load(): Promise<void> {
    this.loading = this.read();
    return this.loading;
  }

  /** Строка по номеру в центр окна и кратко подсвечена; у диф-редактора - в рабочей версии файла. */
  async reveal(line: number): Promise<void> {
    await this.loading;
    const editor = this.editor ?? this.diff?.getModifiedEditor();
    const model = editor?.getModel();
    if (!editor || !model) return;
    const target = Math.min(Math.max(1, Math.trunc(line)), model.getLineCount());
    editor.revealLineInCenter(target);
    editor.setPosition({ lineNumber: target, column: 1 });
    const mark = editor.createDecorationsCollection([
      { range: { startLineNumber: target, startColumn: 1, endLineNumber: target, endColumn: 1 }, options: { isWholeLine: true, className: 'search-target-line' } },
    ]);
    window.setTimeout(() => mark.clear(), 2000);
    editor.focus();
  }

  private async read(): Promise<void> {
    const [result, original] = await Promise.all([window.cyborg.readFile(this.path), window.cyborg.gitHeadContent(this.path)]);
    if (result.content === undefined) {
      this.dispose();
      this.body.replaceChildren(el('div', 'file-error', result.error ?? 'Файл не прочитан'));
      return;
    }
    const monaco = await loadMonaco();
    if (original !== null && original !== result.content) this.showDiff(monaco, original, result.content);
    else this.showFile(monaco, result.content);
  }

  private showFile(monaco: typeof Monaco, content: string): void {
    if (this.diff) this.dispose();
    if (!this.editor) {
      this.body.replaceChildren();
      this.editor = monaco.editor.create(this.body, {
        value: content,
        language: detectLanguage(monaco, this.path),
        readOnly: true,
        theme: monacoTheme(),
        automaticLayout: true,
        fontSize,
        scrollBeyondLastLine: false,
      });
    } else if (this.editor.getValue() !== content) {
      this.editor.getModel()?.setValue(content);
    }
  }

  private showDiff(monaco: typeof Monaco, original: string, content: string): void {
    if (this.editor) this.dispose();
    if (!this.diff) {
      this.body.replaceChildren();
      const language = detectLanguage(monaco, this.path);
      this.diff = monaco.editor.createDiffEditor(this.body, {
        readOnly: true,
        originalEditable: false,
        theme: monacoTheme(),
        automaticLayout: true,
        fontSize,
        scrollBeyondLastLine: false,
        renderSideBySide: false,
      });
      this.diff.setModel({
        original: monaco.editor.createModel(original, language),
        modified: monaco.editor.createModel(content, language),
      });
      return;
    }
    const model = this.diff.getModel();
    if (model?.original.getValue() !== original) model?.original.setValue(original);
    if (model?.modified.getValue() !== content) model?.modified.setValue(content);
  }

  dispose(): void {
    this.editor?.getModel()?.dispose();
    this.editor?.dispose();
    this.editor = undefined;
    const model = this.diff?.getModel();
    this.diff?.dispose();
    model?.original.dispose();
    model?.modified.dispose();
    this.diff = undefined;
  }
}
