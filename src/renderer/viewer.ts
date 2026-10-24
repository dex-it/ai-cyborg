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

/** Просмотр одного файла; содержимое перечитывается с диска при каждом показе. */
export class FileViewer {
  private editor?: Monaco.editor.IStandaloneCodeEditor;

  constructor(
    readonly path: string,
    private readonly body: HTMLElement,
  ) {}

  async load(): Promise<void> {
    const result = await window.cyborg.readFile(this.path);
    if (result.content === undefined) {
      this.dispose();
      this.body.replaceChildren(el('div', 'file-error', result.error ?? 'Файл не прочитан'));
      return;
    }
    const monaco = await loadMonaco();
    if (!this.editor) {
      this.body.replaceChildren();
      this.editor = monaco.editor.create(this.body, {
        value: result.content,
        language: detectLanguage(monaco, this.path),
        readOnly: true,
        theme: monacoTheme(),
        automaticLayout: true,
        fontSize,
        scrollBeyondLastLine: false,
      });
    } else if (this.editor.getValue() !== result.content) {
      this.editor.getModel()?.setValue(result.content);
    }
  }

  dispose(): void {
    this.editor?.getModel()?.dispose();
    this.editor?.dispose();
    this.editor = undefined;
  }
}
