// Пути и ссылки в выводе сессии: клик открывает файл приложением системы, URL - браузером системы.

import type { IBufferLine, ILink, ILinkHandler, ILinkProvider, Terminal } from '@xterm/xterm';

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

/** Логическая строка буфера: строка y и её продолжения, перенесённые xterm по ширине. */
function logicalLine(term: Terminal, y: number): { text: string; first: number } {
  const buffer = term.buffer.active;
  let first = y;
  while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
  let text = '';
  for (let row = first; ; row++) {
    const line: IBufferLine | undefined = buffer.getLine(row);
    if (!line || (row > first && !line.isWrapped)) break;
    // Строка, за которой идёт перенос, берётся во всю ширину: иначе смещения следующих строк съедут.
    text += line.translateToString(!buffer.getLine(row + 1)?.isWrapped);
  }
  return { text, first };
}

export interface LinkOpeners {
  openPath(path: string): void;
  openUrl(url: string): void;
}

export function termLinkProvider(term: Terminal, open: LinkOpeners): ILinkProvider {
  return {
    provideLinks(y, callback) {
      // y у xterm считается с 1, буфер - с 0.
      const { text, first } = logicalLine(term, y - 1);
      const at = (offset: number) => ({ x: (offset % term.cols) + 1, y: first + Math.floor(offset / term.cols) + 1 });
      const links: ILink[] = findLinks(text)
        .map((m) => ({
          text: m.target,
          range: { start: at(m.start), end: at(m.start + m.length - 1) },
          activate: () => (m.kind === 'url' ? open.openUrl(m.target) : open.openPath(m.target)),
        }))
        .filter((link) => link.range.start.y <= y && link.range.end.y >= y);
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
