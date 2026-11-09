import type * as Monaco from 'monaco-editor';
import { localFs, type FsPort } from './fs-port';
import { basename, el } from './dom';
import { loadFontSize } from './font-size';
import { monacoTheme } from './theme';

let fontSize = loadFontSize();
document.documentElement.style.setProperty('--viewer-font-size', `${fontSize}px`);
let monacoPromise: Promise<typeof Monaco> | null = null;

export function loadMonaco(): Promise<typeof Monaco> {
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
  document.documentElement.style.setProperty('--viewer-font-size', `${size}px`);
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

export const editorOptions = () => ({ theme: monacoTheme(), automaticLayout: true, fontSize, scrollBeyondLastLine: false });

/** Вкладка файла: что показывает просмотрщик и чем закрывается; кнопки режима просмотрщик кладёт в actions. */
export interface Viewer {
  readonly path: string;
  readonly actions: HTMLElement;
  readonly dirty: boolean;
  load(): Promise<void>;
  reveal(line: number): Promise<void>;
  close(): void;
}

/** Строка по номеру в центр окна и кратко подсвечена. */
export function revealLine(editor: Monaco.editor.ICodeEditor, line: number): void {
  const model = editor.getModel();
  if (!model) return;
  const target = Math.min(Math.max(1, Math.trunc(line)), model.getLineCount());
  editor.revealLineInCenter(target);
  editor.setPosition({ lineNumber: target, column: 1 });
  const mark = editor.createDecorationsCollection([
    { range: { startLineNumber: target, startColumn: 1, endLineNumber: target, endColumn: 1 }, options: { isWholeLine: true, className: 'search-target-line' } },
  ]);
  window.setTimeout(() => mark.clear(), 2000);
  editor.focus();
}

/** Сравнение рабочей версии с HEAD в одной колонке, только чтение. */
export class HeadDiff {
  private diff?: Monaco.editor.IStandaloneDiffEditor;

  constructor(
    private readonly body: HTMLElement,
    private readonly path: string,
  ) {}

  get shown(): boolean {
    return this.diff !== undefined;
  }

  get modified(): Monaco.editor.ICodeEditor | undefined {
    return this.diff?.getModifiedEditor();
  }

  show(monaco: typeof Monaco, original: string, content: string): void {
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
    const model = this.diff?.getModel();
    this.diff?.dispose();
    model?.original.dispose();
    model?.modified.dispose();
    this.diff = undefined;
  }
}

/** Просмотр одного файла; содержимое перечитывается с диска при каждом показе, изменённый против HEAD - сравнением. */
export class FileViewer implements Viewer {
  readonly actions = el('span', 'file-actions');
  readonly dirty = false;
  private editor?: Monaco.editor.IStandaloneCodeEditor;
  private readonly diff: HeadDiff;

  constructor(
    readonly path: string,
    private readonly body: HTMLElement,
    private readonly fs: FsPort = localFs,
  ) {
    this.diff = new HeadDiff(body, path);
  }

  /** Окончание последнего чтения: переход к строке ждёт, пока в редакторе появится содержимое. */
  private loading: Promise<void> = Promise.resolve();

  load(): Promise<void> {
    this.loading = this.read();
    return this.loading;
  }

  /** У диф-редактора строка ищется в рабочей версии файла. */
  async reveal(line: number): Promise<void> {
    await this.loading;
    const editor = this.editor ?? this.diff.modified;
    if (editor) revealLine(editor, line);
  }

  close(): void {
    this.dispose();
  }

  private async read(): Promise<void> {
    const [result, original] = await Promise.all([this.fs.read(this.path), this.fs.head(this.path)]);
    if (result.content === undefined) {
      this.dispose();
      this.body.replaceChildren(el('div', 'file-error', result.error ?? 'Файл не прочитан'));
      return;
    }
    const monaco = await loadMonaco();
    if (original !== null && original !== result.content) {
      if (this.editor) this.dispose();
      this.diff.show(monaco, original, result.content);
    } else this.showFile(monaco, result.content);
  }

  private showFile(monaco: typeof Monaco, content: string): void {
    if (this.diff.shown) this.dispose();
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

  dispose(): void {
    this.editor?.getModel()?.dispose();
    this.editor?.dispose();
    this.editor = undefined;
    this.diff.dispose();
  }
}
