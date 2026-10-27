// Пути и ссылки в выводе сессии: клик открывает файл приложением системы, URL - браузером системы.

import type { IBuffer, IBufferCellPosition, IBufferLine, ILink, ILinkHandler, ILinkProvider, Terminal } from '@xterm/xterm';

export interface LinkMatch {
  /** Смещение первого знака в строке и длина. */
  start: number;
  length: number;
  target: string;
  kind: 'path' | 'url';
}

/** Абсолютный путь или путь от домашнего каталога; хвостовая пунктуация предложения в путь не входит. */
const PATH = /(?<=^|[\s(\[<"'`«])(?:~|\/)(?:[^\s()<>"'`«»\[\]]*[^\s()<>"'`«»\[\].,:;!?])?/g;
const URL_RE = /\bhttps?:\/\/[^\s<>"'`«»]+/g;

/** Хвост URL без пунктуации предложения и без закрывающей скобки, которой нет пары внутри (`(см. https://x/y)`). */
function trimUrl(url: string): string {
  let end = url.length;
  for (;;) {
    const last = url[end - 1];
    if ('.,:;!?'.includes(last)) end--;
    else if (last === ')' && url.slice(0, end).split('(').length <= url.slice(0, end).split(')').length - 1) end--;
    else if (last === ']' && url.slice(0, end).split('[').length <= url.slice(0, end).split(']').length - 1) end--;
    else return url.slice(0, end);
  }
}

export function findPaths(text: string): LinkMatch[] {
  return [...text.matchAll(PATH)]
    .filter((m) => m[0].length > 1 && m[0] !== '~/')
    .map((m) => ({ start: m.index, length: m[0].length, target: m[0], kind: 'path' }));
}

export function findUrls(text: string): LinkMatch[] {
  return [...text.matchAll(URL_RE)].flatMap((m) => {
    const url = trimUrl(m[0]);
    return url.length > 'https://'.length ? [{ start: m.index, length: url.length, target: url, kind: 'url' as const }] : [];
  });
}

export const findLinks = (text: string): LinkMatch[] => [...findUrls(text), ...findPaths(text)].sort((a, b) => a.start - b.start);

export type LinkBuffer = Pick<IBuffer, 'length' | 'getLine'>;

/** Текст строк и клетка (x, y с 1) каждого его знака. */
interface Span {
  text: string;
  cells: IBufferCellPosition[];
  /** Строка буфера сразу за отрезком. */
  next: number;
}

/** Последняя занятая клетка не дальше стольких от правого края: строку дописали до края и оборвали. */
const EDGE = 4;
/** Сколько оборванных строк вверх ищется начало ссылки. */
const MAX_HARD_ROWS = 20;

function lineStart(buffer: LinkBuffer, y: number): number {
  while (y > 0 && buffer.getLine(y)?.isWrapped) y--;
  return y;
}

/** Логическая строка: строка start и её продолжения, перенесённые xterm по ширине. */
function logicalLine(buffer: LinkBuffer, start: number): Span {
  const span: Span = { text: '', cells: [], next: start };
  for (let row = start; ; row++) {
    const line: IBufferLine | undefined = buffer.getLine(row);
    if (!line || (row > start && !line.isWrapped)) break;
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      // Вторая клетка широкого знака своего текста не несёт.
      if (!cell || cell.getWidth() === 0) continue;
      const chars = cell.getChars() || ' ';
      span.text += chars;
      for (let i = 0; i < chars.length; i++) span.cells.push({ x: x + 1, y: row + 1 });
    }
    span.next = row + 1;
  }
  return span;
}

/** Claude Code (Ink) рвёт слово длиннее строки сам - переводом строки и отступом, а не переносом xterm: b продолжает a. */
function breaksInto(a: Span, b: Span, cols: number): boolean {
  const end = a.text.trimEnd().length;
  return end > 0 && a.cells[end - 1].x > cols - EDGE && /^ +\S/.test(b.text);
}

function glue(a: Span, b: Span): Span {
  const end = a.text.trimEnd().length;
  const lead = b.text.length - b.text.trimStart().length;
  return { text: a.text.slice(0, end) + b.text.slice(lead), cells: [...a.cells.slice(0, end), ...b.cells.slice(lead)], next: b.next };
}

const endsWithLink = (text: string): boolean => findLinks(text).some((m) => m.start + m.length === text.trimEnd().length);

/** Ссылки, задевающие строку буфера y (с 0): по куску на каждую строку экрана, которую ссылка занимает. */
export function linksOnRow(buffer: LinkBuffer, cols: number, y: number): { match: LinkMatch; start: IBufferCellPosition; end: IBufferCellPosition }[] {
  let top = lineStart(buffer, y);
  for (let i = 0; i < MAX_HARD_ROWS && top > 0; i++) {
    const prev = lineStart(buffer, top - 1);
    if (!breaksInto(logicalLine(buffer, prev), logicalLine(buffer, top), cols)) break;
    top = prev;
  }
  const found: { match: LinkMatch; start: IBufferCellPosition; end: IBufferCellPosition }[] = [];
  for (let row = top; row <= y; ) {
    let span = logicalLine(buffer, row);
    // Склеивается только оборванная ссылка: проза, дописанная до края, со следующей строкой не сливается.
    while (span.next < buffer.length && endsWithLink(span.text)) {
      const next = logicalLine(buffer, span.next);
      if (!breaksInto(span, next, cols)) break;
      span = glue(span, next);
    }
    for (const match of findLinks(span.text)) {
      const cells = span.cells.slice(match.start, match.start + match.length).filter((cell) => cell.y === y + 1);
      if (cells.length) found.push({ match, start: cells[0], end: cells[cells.length - 1] });
    }
    row = span.next;
  }
  return found;
}

export interface LinkOpeners {
  openPath(path: string): void;
  openUrl(url: string): void;
}

export function termLinkProvider(term: Terminal, open: LinkOpeners): ILinkProvider {
  return {
    provideLinks(y, callback) {
      // y у xterm считается с 1, буфер - с 0.
      const links: ILink[] = linksOnRow(term.buffer.active, term.cols, y - 1).map(({ match, start, end }) => ({
        text: match.target,
        range: { start, end },
        activate: () => (match.kind === 'url' ? open.openUrl(match.target) : open.openPath(match.target)),
      }));
      callback(links.length ? links : undefined);
    },
  };
}

/** file:// - в путь, иначе null. */
export function fileUrlPath(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'file:' && (!parsed.host || parsed.host === 'localhost') ? decodeURIComponent(parsed.pathname) : null;
  } catch {
    return null;
  }
}

/** Скрытые ссылки OSC 8: без своего обработчика xterm открыл бы их через window.open с подтверждением. */
export function osc8Handler(open: LinkOpeners): ILinkHandler {
  return {
    allowNonHttpProtocols: true,
    activate(_event, text) {
      const file = fileUrlPath(text);
      if (file) open.openPath(file);
      else open.openUrl(text);
    },
  };
}
