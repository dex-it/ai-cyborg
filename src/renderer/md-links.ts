export type MdLink = { kind: 'web'; url: string } | { kind: 'anchor'; id: string } | { kind: 'file'; path: string; line?: number } | { kind: 'none' };

export const isMarkdown = (path: string): boolean => /\.(md|markdown)$/i.test(path);

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Абсолютный путь из каталога и относительного пути без обращения к диску; `..` выше корня останавливается на корне. */
export function joinPath(dir: string, rel: string): string {
  const out: string[] = [];
  for (const part of `${dir}/${rel}`.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
}

const dirname = (file: string): string => file.slice(0, file.lastIndexOf('/')) || '/';

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Путь из ссылки документа: от его каталога, а `/docs/x.md` - от корня дерева, как на GitHub. */
function localPath(target: string, file: string, root: string): string {
  const decoded = decode(target);
  return decoded.startsWith('/') ? joinPath(root, decoded) : joinPath(dirname(file), decoded);
}

/** Куда ведёт ссылка Markdown-документа `file` из дерева с корнем `root`. */
export function resolveLink(href: string, file: string, root: string): MdLink {
  const value = href.trim();
  if (value.startsWith('#')) return value.length > 1 ? { kind: 'anchor', id: decode(value.slice(1)) } : { kind: 'none' };
  if (/^https?:\/\//i.test(value)) return { kind: 'web', url: value };
  if (SCHEME.test(value) || value.startsWith('//')) return { kind: 'none' };
  const hash = value.indexOf('#');
  const fragment = hash < 0 ? '' : value.slice(hash + 1);
  const target = (hash < 0 ? value : value.slice(0, hash)).replace(/\?.*$/, '');
  if (!target) return { kind: 'none' };
  const line = /^L(\d+)/.exec(fragment)?.[1];
  return line ? { kind: 'file', path: localPath(target, file, root), line: Number(line) } : { kind: 'file', path: localPath(target, file, root) };
}

/** Адрес картинки документа: локальная - file://, data:image как есть; из сети - null (границы BRD: сеть только к трекерам и хабам). */
export function imageSource(src: string, file: string, root: string): string | null {
  const value = src.trim();
  if (/^data:image\//i.test(value)) return value;
  if (!value || SCHEME.test(value) || value.startsWith('//')) return null;
  const target = value.replace(/[?#].*$/, '');
  if (!target) return null;
  return `file://${localPath(target, file, root).split('/').map(encodeURIComponent).join('/')}`;
}

/** Якорь заголовка как на GitHub: строчные, без знаков, пробел - дефис; повтор получает суффикс -1, -2. */
export function slugger(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text) => {
    const base = text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count ? `${base}-${count}` : base;
  };
}
