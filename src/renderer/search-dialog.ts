import type { SearchMode } from '../main/menu';
import { isHeavyPattern, MAX_HITS, queryProblem, type LineHit, type SearchReply } from '../shared/search-pattern';
import { el } from './dom';
import { readChoice, readPref, writePref } from './prefs';
import { compileMatcher, lineSummary, matchFiles, moveActive, resultSummary, type FileEntry, type FileHit, type SearchOptions } from './search-model';
import { bindTablist, markTab, selectTab } from './tabs';
import type { TreeRoot } from './tree';

export type { SearchMode };

/** Окно поиска: не висит на экране, вызывается меню «Поиск» и его сочетаниями. */
export interface SearchHost {
  /** Корни, которые человек видит в дереве: корни активной сессии, без сессии - репозитории проекта. */
  roots(): TreeRoot[];
  /** Открыть файл; line - строка, к которой перейти (поиск по содержимому и изменениям). */
  open(path: string, root: TreeRoot, line?: number): void;
}

// Больше строк DOM не потянет без задержки на каждом нажатии.
export const RESULT_LIMIT = MAX_HITS;
/** Поиск по содержимому и изменениям идёт в git: запрос уходит, когда набор на мгновение остановился. */
const TYPING_PAUSE_MS = 250;

const MODES: { id: SearchMode; label: string; title: string; placeholder: string; list: string }[] = [
  { id: 'files', label: 'Файлы', title: 'Поиск файла', placeholder: 'Часть имени файла', list: 'Найденные файлы' },
  { id: 'text', label: 'Текст', title: 'Поиск в файлах', placeholder: 'Текст в файлах', list: 'Найденные строки' },
  { id: 'changes', label: 'Изменения', title: 'Поиск в изменениях', placeholder: 'Текст в добавленных и удалённых строках', list: 'Найденные строки изменений' },
];

const api = window.cyborg;

const flag = (key: string): boolean => readPref(`cyborg.search.${key}`) === '1';

/** Запрос живёт до закрытия приложения; режим и переключатели помнятся и между запусками. */
const last = {
  mode: readChoice<SearchMode>('cyborg.search.mode', MODES.map((m) => m.id), 'files'),
  query: '',
  options: { regex: flag('regex'), caseSensitive: flag('caseSensitive'), wholeWord: flag('wholeWord') } as SearchOptions,
};

/** Строка результата: поиск по имени даёт файл, по содержимому и изменениям - строку. */
type Row = { root: number; rel: string; line?: number };

export class SearchDialog {
  private readonly dialog: HTMLDialogElement;
  private readonly title: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly status: HTMLElement;
  private readonly list: HTMLElement;
  private readonly tabs = new Map<SearchMode, HTMLElement>();
  private readonly toggles: Record<keyof SearchOptions, HTMLButtonElement>;
  private roots: TreeRoot[] = [];
  private entries: FileEntry[] | null = null;
  private rows: Row[] = [];
  private active = 0;
  /** Номер вызова open: ответ списка файлов от закрытого или переоткрытого окна отбрасывается. */
  private opened = 0;
  /** Номер запроса к git: ответ вытесненного запроса не рисуется. */
  private requested = 0;
  private pause: number | undefined;

  constructor(private readonly host: SearchHost) {
    const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
    this.dialog = byId<HTMLDialogElement>('search-dialog');
    this.title = byId('search-dialog-title');
    this.input = byId<HTMLInputElement>('search-input');
    this.status = byId('search-status');
    this.list = byId('search-results');
    this.toggles = {
      caseSensitive: byId<HTMLButtonElement>('search-case'),
      wholeWord: byId<HTMLButtonElement>('search-word'),
      regex: byId<HTMLButtonElement>('search-regex'),
    };

    const modes = byId('search-modes');
    for (const mode of MODES) {
      const tab = markTab(el('button', 'search-mode', mode.label));
      tab.setAttribute('type', 'button');
      tab.addEventListener('click', () => this.setMode(mode.id, true));
      this.tabs.set(mode.id, tab);
      modes.append(tab);
    }
    bindTablist(modes, 'Вид поиска');

    this.input.addEventListener('input', () => this.schedule());
    this.input.addEventListener('keydown', (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const next = moveActive(event.key, this.active, this.rows.length);
      if (next !== null) {
        event.preventDefault();
        this.setActive(next);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        this.choose(this.active);
      }
    });
    for (const key of Object.keys(this.toggles) as (keyof SearchOptions)[]) {
      this.toggles[key].addEventListener('click', () => {
        last.options[key] = !last.options[key];
        writePref(`cyborg.search.${key}`, last.options[key] ? '1' : '0');
        this.syncToggles();
        this.run();
        this.input.focus();
      });
    }
    // Клик по затемнению (по самому <dialog>, а не по его содержимому) закрывает окно.
    this.dialog.addEventListener('click', (event) => {
      if (event.target === this.dialog) this.dialog.close();
    });
    this.list.addEventListener('click', (event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>('[role="option"]');
      if (row) this.choose(Number(row.dataset.index));
    });
    this.dialog.addEventListener('close', () => {
      // Событие закрытия приходит отдельной задачей и может опоздать к повторному открытию: оно не должно сбросить уже начатый поиск.
      if (this.dialog.open) return;
      this.opened++;
      this.requested++;
      window.clearTimeout(this.pause);
      this.entries = null;
    });
  }

  open(mode: SearchMode = last.mode): void {
    this.opened++;
    this.roots = this.host.roots();
    this.entries = null;
    this.input.value = last.query;
    this.syncToggles();
    this.setMode(mode, false);
    if (!this.dialog.open) this.dialog.showModal();
    this.input.focus();
    this.input.select();
    this.run();
  }

  private setMode(mode: SearchMode, focusInput: boolean): void {
    last.mode = mode;
    // Ответ git, начатого в прежнем виде, в новом не рисуется.
    this.requested++;
    window.clearTimeout(this.pause);
    writePref('cyborg.search.mode', mode);
    const info = MODES.find((m) => m.id === mode)!;
    for (const [id, tab] of this.tabs) selectTab(tab, id === mode);
    this.title.textContent = info.title;
    this.input.placeholder = info.placeholder;
    this.input.setAttribute('aria-label', info.placeholder);
    this.list.setAttribute('aria-label', info.list);
    this.clearRows();
    if (focusInput) {
      this.input.focus();
      this.run();
    }
  }

  private syncToggles(): void {
    for (const key of Object.keys(this.toggles) as (keyof SearchOptions)[]) this.toggles[key].setAttribute('aria-pressed', String(last.options[key]));
  }

  /** Набор остановился: по файлам ищет сам интерфейс сразу, по содержимому и изменениям - после паузы. */
  private schedule(): void {
    last.query = this.input.value;
    window.clearTimeout(this.pause);
    if (last.mode === 'files') this.run();
    else {
      this.requested++;
      this.pause = window.setTimeout(() => this.run(), TYPING_PAUSE_MS);
    }
  }

  private run(): void {
    window.clearTimeout(this.pause);
    last.query = this.input.value;
    this.input.removeAttribute('aria-invalid');
    if (!this.roots.length) {
      this.clearRows('Нет проекта с репозиториями');
      return;
    }
    if (last.mode === 'files') this.runFiles();
    else void this.runLines(last.mode);
  }

  private runFiles(): void {
    if (!this.entries) {
      this.clearRows('Загрузка…');
      void this.load(this.opened);
      return;
    }
    const query = this.input.value.trim();
    if (!query) {
      this.clearRows(`Файлов: ${this.entries.length}. Введите часть имени`);
      return;
    }
    const problem = queryProblem(query, last.options);
    const matcher = problem ? null : compileMatcher(query, last.options);
    if (problem || !matcher || !matcher.ok) {
      this.invalid(problem ?? (matcher && !matcher.ok ? matcher.error : ''));
      return;
    }
    const { hits, total } = matchFiles(this.entries, matcher, RESULT_LIMIT);
    this.showFiles(hits, resultSummary(hits.length, total));
  }

  private async load(ticket: number): Promise<void> {
    const lists = await Promise.all(this.roots.map((root) => api.listFiles(root.path).catch(() => [] as string[])));
    if (ticket !== this.opened) return;
    this.entries = lists.flatMap((files, root) => files.map((rel) => ({ root, rel })));
    if (last.mode === 'files') this.run();
  }

  private async runLines(mode: 'text' | 'changes'): Promise<void> {
    const query = this.input.value.trim();
    if (!query) {
      this.clearRows('Введите запрос');
      return;
    }
    const problem = queryProblem(query, last.options);
    if (problem) {
      this.invalid(problem);
      return;
    }
    // Выражение для JavaScript проверяется здесь и в главном процессе; git -P разбирает своё, поэтому для «Текста» разбор не дублируется.
    if (mode === 'changes' && last.options.regex && isHeavyPattern(query)) {
      this.invalid('Выражение слишком сложное: квантор над группой с квантором');
      return;
    }
    const ticket = ++this.requested;
    this.clearRows('Поиск…');
    const ask = mode === 'text' ? api.searchText : api.searchChanges;
    const replies = await Promise.all(
      this.roots.map((root) =>
        ask({ root: root.path, query, options: { ...last.options } }).catch((error: unknown): SearchReply => ({ hits: [], truncated: false, error: String(error) })),
      ),
    );
    if (ticket !== this.requested || replies.some((reply) => reply.cancelled)) return;
    const hits: { root: number; hit: LineHit }[] = [];
    let truncated = false;
    const errors: string[] = [];
    replies.forEach((reply, root) => {
      truncated ||= reply.truncated;
      if (reply.error) errors.push(this.roots.length > 1 ? `${this.roots[root].label}: ${reply.error}` : reply.error);
      for (const hit of reply.hits) hits.push({ root, hit });
    });
    if (!hits.length && errors.length) {
      this.invalid(errors[0]);
      return;
    }
    const shown = hits.slice(0, RESULT_LIMIT);
    this.showLines(shown, lineSummary(shown.length, truncated || hits.length > shown.length) + (errors.length ? `. ${errors[0]}` : ''));
  }

  private invalid(message: string): void {
    this.input.setAttribute('aria-invalid', 'true');
    this.clearRows(message);
  }

  private clearRows(summary = ''): void {
    this.rows = [];
    this.active = 0;
    this.status.textContent = summary;
    this.list.replaceChildren();
    this.syncActive();
  }

  private place(root: number, rel: string, name: string): string {
    const dir = rel.slice(0, rel.length - name.length).replace(/\/$/, '');
    return [this.roots.length > 1 ? this.roots[root].label : '', dir].filter(Boolean).join(' / ');
  }

  private showFiles(hits: FileHit[], summary: string): void {
    const rows = hits.map((hit, index) => {
      const row = this.row(index, `${this.roots[hit.root].path}/${hit.rel}`);
      const name = el('span', 'search-name');
      this.highlight(name, hit.name, hit.range);
      row.append(name, el('span', 'search-dir', this.place(hit.root, hit.rel, hit.name)));
      return row;
    });
    this.fill(
      hits.map((hit) => ({ root: hit.root, rel: hit.rel })),
      rows,
      summary,
    );
  }

  private showLines(hits: { root: number; hit: LineHit }[], summary: string): void {
    const rows = hits.map(({ root, hit }, index) => {
      const row = this.row(index, `${this.roots[root].path}/${hit.rel}:${hit.line}`);
      if (hit.sign) row.append(el('span', `search-sign ${hit.sign === '+' ? 'added' : 'removed'}`, hit.sign));
      const text = el('span', 'search-text');
      this.highlight(text, hit.text, hit.range);
      const place = [this.roots.length > 1 ? this.roots[root].label : '', `${hit.rel}:${hit.line}`].filter(Boolean).join(' / ');
      row.append(text, el('span', 'search-dir', place));
      return row;
    });
    this.fill(
      hits.map(({ root, hit }) => ({ root, rel: hit.rel, line: hit.line })),
      rows,
      summary,
    );
  }

  private row(index: number, title: string): HTMLElement {
    const row = el('div', 'search-hit');
    row.id = `search-hit-${index}`;
    row.dataset.index = String(index);
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(index === 0));
    row.classList.toggle('active', index === 0);
    row.title = title;
    return row;
  }

  private highlight(node: HTMLElement, text: string, range: { start: number; end: number } | null): void {
    if (range && range.end > range.start) node.append(text.slice(0, range.start), el('mark', '', text.slice(range.start, range.end)), text.slice(range.end));
    else node.textContent = text;
  }

  private fill(rows: Row[], nodes: HTMLElement[], summary: string): void {
    this.rows = rows;
    this.active = 0;
    this.status.textContent = summary;
    this.list.replaceChildren(...nodes);
    this.list.scrollTop = 0;
    this.syncActive();
  }

  private setActive(index: number): void {
    this.active = index;
    for (const row of this.list.children) {
      const on = Number((row as HTMLElement).dataset.index) === index;
      row.classList.toggle('active', on);
      row.setAttribute('aria-selected', String(on));
      if (on) (row as HTMLElement).scrollIntoView({ block: 'nearest' });
    }
    this.syncActive();
  }

  private syncActive(): void {
    if (this.rows.length) this.input.setAttribute('aria-activedescendant', `search-hit-${this.active}`);
    else this.input.removeAttribute('aria-activedescendant');
  }

  private choose(index: number): void {
    const row = this.rows[index];
    if (!row) return;
    const root = this.roots[row.root];
    this.dialog.close();
    this.host.open(`${root.path}/${row.rel}`, root, row.line);
  }
}
