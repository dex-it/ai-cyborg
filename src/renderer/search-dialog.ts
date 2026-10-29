import { el } from './dom';
import { compileMatcher, matchFiles, moveActive, resultSummary, type FileEntry, type FileHit, type SearchOptions } from './search-model';
import type { TreeRoot } from './tree';

/** Окно поиска: не висит на экране, вызывается меню «Поиск» и его сочетаниями. */
export type SearchMode = 'files';

export interface SearchHost {
  /** Корни, которые человек видит в дереве: корни активной сессии, без сессии - репозитории проекта. */
  roots(): TreeRoot[];
  open(path: string, root: TreeRoot): void;
}

// Больше строк DOM не потянет без задержки на каждом нажатии.
export const RESULT_LIMIT = 500;

const api = window.cyborg;

/** Запрос и переключатели переживают закрытие окна: повторный вызов начинается с прежнего. */
const last = { query: '', options: { regex: false, caseSensitive: false } as SearchOptions };

export class SearchDialog {
  private readonly dialog: HTMLDialogElement;
  private readonly input: HTMLInputElement;
  private readonly status: HTMLElement;
  private readonly list: HTMLElement;
  private readonly caseButton: HTMLButtonElement;
  private readonly regexButton: HTMLButtonElement;
  private roots: TreeRoot[] = [];
  private entries: FileEntry[] | null = null;
  private hits: FileHit[] = [];
  private active = 0;
  /** Номер вызова open: ответ списка файлов от закрытого или переоткрытого окна отбрасывается. */
  private opened = 0;

  constructor(private readonly host: SearchHost) {
    const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
    this.dialog = byId<HTMLDialogElement>('search-dialog');
    this.input = byId<HTMLInputElement>('search-input');
    this.status = byId('search-status');
    this.list = byId('search-results');
    this.caseButton = byId<HTMLButtonElement>('search-case');
    this.regexButton = byId<HTMLButtonElement>('search-regex');

    this.input.addEventListener('input', () => this.run());
    this.input.addEventListener('keydown', (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const next = moveActive(event.key, this.active, this.hits.length);
      if (next !== null) {
        event.preventDefault();
        this.setActive(next);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        this.choose(this.active);
      }
    });
    for (const [button, key] of [
      [this.caseButton, 'caseSensitive'],
      [this.regexButton, 'regex'],
    ] as const) {
      button.addEventListener('click', () => {
        last.options[key] = !last.options[key];
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
      this.opened++;
      this.entries = null;
    });
  }

  open(_mode: SearchMode = 'files'): void {
    const ticket = ++this.opened;
    this.roots = this.host.roots();
    this.entries = null;
    this.hits = [];
    this.list.replaceChildren();
    this.input.value = last.query;
    this.syncToggles();
    this.status.textContent = this.roots.length ? 'Загрузка…' : 'Нет проекта с репозиториями';
    if (!this.dialog.open) this.dialog.showModal();
    this.input.focus();
    this.input.select();
    if (!this.roots.length) return;
    void this.load(ticket);
  }

  private async load(ticket: number): Promise<void> {
    const lists = await Promise.all(this.roots.map((root) => api.listFiles(root.path).catch(() => [] as string[])));
    if (ticket !== this.opened) return;
    this.entries = lists.flatMap((files, root) => files.map((rel) => ({ root, rel })));
    this.run();
  }

  private syncToggles(): void {
    this.caseButton.setAttribute('aria-pressed', String(last.options.caseSensitive));
    this.regexButton.setAttribute('aria-pressed', String(last.options.regex));
  }

  private run(): void {
    last.query = this.input.value;
    if (!this.entries) return;
    const query = this.input.value.trim();
    this.input.removeAttribute('aria-invalid');
    if (!query) {
      this.show([], `Файлов: ${this.entries.length}. Введите часть имени`);
      return;
    }
    const matcher = compileMatcher(query, last.options);
    if (!matcher.ok) {
      this.input.setAttribute('aria-invalid', 'true');
      this.show([], matcher.error);
      return;
    }
    const { hits, total } = matchFiles(this.entries, matcher, RESULT_LIMIT);
    this.show(hits, resultSummary(hits.length, total));
  }

  private show(hits: FileHit[], summary: string): void {
    this.hits = hits;
    this.active = 0;
    this.status.textContent = summary;
    const multiple = this.roots.length > 1;
    const rows = hits.map((hit, index) => {
      const row = el('div', 'search-hit');
      row.id = `search-hit-${index}`;
      row.dataset.index = String(index);
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(index === 0));
      row.classList.toggle('active', index === 0);
      const name = el('span', 'search-name');
      const { start, end } = hit.range;
      if (end > start) name.append(hit.name.slice(0, start), el('mark', '', hit.name.slice(start, end)), hit.name.slice(end));
      else name.textContent = hit.name;
      const dir = hit.rel.slice(0, hit.rel.length - hit.name.length).replace(/\/$/, '');
      const place = [multiple ? this.roots[hit.root].label : '', dir].filter(Boolean).join(' / ');
      row.append(name, el('span', 'search-dir', place));
      row.title = `${this.roots[hit.root].path}/${hit.rel}`;
      return row;
    });
    this.list.replaceChildren(...rows);
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
    if (this.hits.length) this.input.setAttribute('aria-activedescendant', `search-hit-${this.active}`);
    else this.input.removeAttribute('aria-activedescendant');
  }

  private choose(index: number): void {
    const hit = this.hits[index];
    if (!hit) return;
    const root = this.roots[hit.root];
    this.dialog.close();
    this.host.open(`${root.path}/${hit.rel}`, root);
  }
}
