import type * as Monaco from 'monaco-editor';
import { basename, el } from './dom';
import { ipcErrorText } from './ipc-error';
import { anchorId, clickedLink, renderMarkdown } from './markdown';
import { slugger, type MdLink } from './md-links';
import { editorOptions, HeadDiff, loadMonaco, revealLine, type Viewer } from './viewer';

export interface MarkdownHost {
  /** Ссылка документа на сайт или файл. */
  open(link: MdLink): void;
  /** Правка стала несохранённой или сохранена. */
  dirtyChanged(dirty: boolean): void;
  /** Подпись сочетания сохранения для подсказок. */
  saveKey: string;
}

type WriteReply = Awaited<ReturnType<typeof window.cyborg.writeFile>>;

const unsaved = new Set<MarkdownViewer>();
const BOM = '﻿';
// Monaco отбрасывает BOM файла: без возврата сохранение меняло бы файл сверх правки.
const withBom = (text: string, base: string): string => (base.startsWith(BOM) && !text.startsWith(BOM) ? BOM + text : text);

async function write(file: string, content: string, base: string, force: boolean): Promise<WriteReply> {
  try {
    return await window.cyborg.writeFile({ file, content, base, force });
  } catch (error) {
    return { error: ipcErrorText(error) };
  }
}

const conflictQuestion = (name: string) => `Файл «${name}» изменён на диске после начала правки.\n\nOK - перезаписать его правкой, Отмена - не перезаписывать.`;

/** Markdown: по умолчанию отрендеренный документ, изменённый против HEAD - по кнопке сравнением, по кнопке «Править» - исходник в редакторе с сохранением по Ctrl/Cmd+S. */
export class MarkdownViewer implements Viewer {
  readonly actions = el('span', 'file-actions');
  private view?: HTMLElement;
  private editor?: Monaco.editor.IStandaloneCodeEditor;
  private readonly diff: HeadDiff;
  /** Чем показан файл вне правки; правка, закрывшись, возвращает этот же вид. */
  private mode: 'doc' | 'diff' = 'doc';
  /** Содержимое диска, от которого идёт правка; null - файл не прочитан. */
  private base: string | null = null;
  /** Версия в HEAD; null - файла в HEAD нет либо он не в git. */
  private head: string | null = null;
  private savedVersion = 0;
  private wasDirty = false;
  private saving = false;
  private closed = false;
  private loading: Promise<void> = Promise.resolve();
  private saveButton?: HTMLButtonElement;
  private mark?: HTMLElement;

  constructor(
    readonly path: string,
    private readonly body: HTMLElement,
    private readonly root: string,
    private readonly host: MarkdownHost,
  ) {
    this.diff = new HeadDiff(body, path);
  }

  private get changedFromHead(): boolean {
    return this.head !== null && this.base !== null && this.head !== this.base;
  }

  get dirty(): boolean {
    const model = this.editor?.getModel();
    return !!model && model.getAlternativeVersionId() !== this.savedVersion;
  }

  get editing(): boolean {
    return this.editor !== undefined;
  }

  load(): Promise<void> {
    this.loading = this.read();
    return this.loading;
  }

  /** Строка есть только у исходника: переход к ней (из поиска) открывает правку. */
  async reveal(line: number): Promise<void> {
    await this.loading;
    if (!this.editor) await this.edit();
    if (this.editor) revealLine(this.editor, line);
  }

  private async read(): Promise<void> {
    const [result, head] = await Promise.all([window.cyborg.readFile(this.path), window.cyborg.gitHeadContent(this.path)]);
    if (this.closed) return;
    const sameHead = head === this.head;
    this.head = head;
    if (this.editor) {
      // Несохранённая правка не затирается: расхождение с диском всплывёт конфликтом при сохранении.
      if (result.content !== undefined && result.content !== this.base && !this.dirty) this.reset(result.content);
      return;
    }
    if (result.content === undefined) {
      this.base = null;
      this.view = undefined;
      this.diff.dispose();
      this.body.replaceChildren(el('div', 'file-error', result.error ?? 'Файл не прочитан'));
      this.showActions();
      return;
    }
    const shown = this.mode === 'diff' ? this.diff.shown : this.view !== undefined;
    if (shown && sameHead && result.content === this.base) return;
    this.base = result.content;
    await this.present();
  }

  /** Вид вне правки: документ либо сравнение; файл сравнялся с HEAD - сравнивать нечего, показан документ. */
  private async present(): Promise<void> {
    if (this.base === null) return;
    if (!this.changedFromHead) this.mode = 'doc';
    if (this.mode === 'doc') {
      this.renderView(this.base);
      return;
    }
    const monaco = await loadMonaco();
    if (this.closed || this.editor || this.mode !== 'diff' || this.head === null || this.base === null) return;
    this.view = undefined;
    this.diff.show(monaco, this.head, this.base);
    this.showActions();
  }

  private toggleDiff(): void {
    this.mode = this.mode === 'doc' ? 'diff' : 'doc';
    void this.present();
  }

  private renderView(content: string): void {
    this.diff.dispose();
    const scroll = this.view?.scrollTop ?? 0;
    const view = el('div', 'md-view');
    view.tabIndex = 0;
    view.append(renderMarkdown(content, this.path, this.root));
    view.addEventListener('click', (event) => this.follow(event));
    this.body.replaceChildren(view);
    view.scrollTop = scroll;
    this.view = view;
    this.showActions();
  }

  private follow(event: MouseEvent): void {
    const link = clickedLink(event, this.path, this.root);
    if (!link) return;
    event.preventDefault();
    if (link.kind === 'anchor') this.view?.querySelector(`#${CSS.escape(anchorId(slugger()(link.id)))}`)?.scrollIntoView({ block: 'start' });
    else if (link.kind !== 'none') this.host.open(link);
  }

  async edit(): Promise<void> {
    if (this.editor) return;
    const [result, monaco] = await Promise.all([window.cyborg.readFile(this.path), loadMonaco()]);
    if (this.closed || this.editor) return;
    if (result.content === undefined) {
      alert(`Файл «${basename(this.path)}» не прочитан: ${result.error ?? ''}`);
      return;
    }
    this.base = result.content;
    this.view = undefined;
    this.diff.dispose();
    this.body.replaceChildren();
    const editor = monaco.editor.create(this.body, { ...editorOptions(), value: result.content, language: 'markdown', wordWrap: 'on', minimap: { enabled: false } });
    this.editor = editor;
    this.savedVersion = editor.getModel()!.getAlternativeVersionId();
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void this.save());
    editor.onDidChangeModelContent(() => this.changed());
    this.showActions();
    editor.focus();
  }

  /** Назад к документу либо сравнению; несохранённая правка теряется только с согласия. */
  done(): void {
    if (this.dirty && !confirm(`Выйти из правки «${basename(this.path)}» без сохранения? Правка будет потеряна.`)) return;
    this.closeEditor();
    void this.load();
  }

  async save(force = false): Promise<boolean> {
    const model = this.editor?.getModel();
    if (!model || this.base === null || this.saving) return false;
    const version = model.getAlternativeVersionId();
    const content = withBom(model.getValue(), this.base);
    this.saving = true;
    const reply = await write(this.path, content, this.base, force);
    this.saving = false;
    if (this.closed) return false;
    if ('saved' in reply) {
      this.base = content;
      this.savedVersion = version;
      this.changed();
      return true;
    }
    if ('error' in reply) {
      alert(`«${basename(this.path)}» не сохранён: ${reply.error}`);
      return false;
    }
    if (confirm(conflictQuestion(basename(this.path)))) return this.save(true);
    if (confirm(`Перечитать «${basename(this.path)}» с диска? Правка будет потеряна.`)) {
      const fresh = await window.cyborg.readFile(this.path);
      if (fresh.content !== undefined && this.editor) this.reset(fresh.content);
    }
    return false;
  }

  /** Закрытие вкладки: несохранённую правку можно сохранить - запись уходит уже после закрытия. */
  close(): void {
    if (this.dirty && this.base !== null && confirm(`В «${basename(this.path)}» несохранённая правка. Сохранить её?\n\nOK - сохранить, Отмена - отбросить.`)) {
      void this.flush(withBom(this.editor!.getValue(), this.base), this.base);
    }
    this.dispose();
  }

  private async flush(content: string, base: string): Promise<void> {
    let reply = await write(this.path, content, base, false);
    if ('conflict' in reply) reply = confirm(conflictQuestion(basename(this.path))) ? await write(this.path, content, base, true) : { error: 'файл изменён на диске' };
    if ('error' in reply) alert(`«${basename(this.path)}» не сохранён: ${reply.error}`);
  }

  private reset(content: string): void {
    const model = this.editor?.getModel();
    if (!model) return;
    this.base = content;
    model.setValue(content);
    this.savedVersion = model.getAlternativeVersionId();
    this.changed();
  }

  private changed(): void {
    const dirty = this.dirty;
    this.saveButton?.toggleAttribute('disabled', !dirty);
    if (this.mark) this.mark.hidden = !dirty;
    if (dirty === this.wasDirty) return;
    this.wasDirty = dirty;
    if (dirty) unsaved.add(this);
    else unsaved.delete(this);
    window.cyborg.reportUnsaved(unsaved.size);
    this.host.dirtyChanged(dirty);
  }

  private showActions(): void {
    this.saveButton = undefined;
    this.mark = undefined;
    if (this.editor) {
      const mark = el('span', 'file-unsaved', 'не сохранено');
      const save = el('button', 'file-action primary', 'Сохранить') as HTMLButtonElement;
      save.title = this.host.saveKey;
      save.addEventListener('click', () => void this.save());
      const done = el('button', 'file-action', 'Готово');
      done.title = this.mode === 'diff' ? 'Вернуться к сравнению с HEAD' : 'Вернуться к просмотру документа';
      done.addEventListener('click', () => this.done());
      this.mark = mark;
      this.saveButton = save;
      this.actions.replaceChildren(mark, save, done);
      this.changed();
    } else if (this.base !== null) {
      const edit = el('button', 'file-action', 'Править');
      edit.title = `Править исходник; ${this.host.saveKey} - сохранить`;
      edit.addEventListener('click', () => void this.edit());
      if (this.changedFromHead) {
        const diff = this.mode === 'diff';
        const toggle = el('button', 'file-action', diff ? 'Документ' : 'Сравнение');
        toggle.title = diff ? 'Показать отрендеренный документ' : 'Сравнить с версией в HEAD';
        toggle.addEventListener('click', () => this.toggleDiff());
        this.actions.replaceChildren(toggle, edit);
      } else this.actions.replaceChildren(edit);
    } else this.actions.replaceChildren();
  }

  private closeEditor(): void {
    const editor = this.editor;
    this.editor = undefined;
    editor?.getModel()?.dispose();
    editor?.dispose();
    this.changed();
  }

  dispose(): void {
    this.closed = true;
    this.closeEditor();
    this.diff.dispose();
    this.view = undefined;
  }
}
