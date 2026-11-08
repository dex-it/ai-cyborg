import DOMPurify from 'dompurify';
import { Marked } from 'marked';
import { imageSource, resolveLink, slugger, type MdLink } from './md-links';

const marked = new Marked({ gfm: true });

// Документ из репозитория недоверенный: не грузит сеть, не задаёт стили окна и не затеняет имена window через id.
const PURIFY = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'iframe', 'frame', 'object', 'embed', 'video', 'audio', 'source', 'track', 'picture', 'base', 'link', 'meta'],
  FORBID_ATTR: ['style', 'id', 'name', 'srcset', 'background', 'poster', 'ping', 'action', 'formaction'],
  RETURN_DOM_FRAGMENT: true as const,
};

export const anchorId = (slug: string): string => `md-${slug}`;

/** Документ Markdown в разметку окна: санитизированный, картинки из сети не грузятся, заголовкам даны якоря. */
export function renderMarkdown(source: string, file: string, root: string): DocumentFragment {
  const html = marked.parse(source, { async: false }) as string;
  const fragment = DOMPurify.sanitize(html, PURIFY);
  const slug = slugger();
  for (const heading of fragment.querySelectorAll('h1, h2, h3, h4, h5, h6')) heading.id = anchorId(slug(heading.textContent ?? ''));
  for (const img of fragment.querySelectorAll('img')) {
    const src = imageSource(img.getAttribute('src') ?? '', file, root);
    if (src) img.src = src;
    else {
      img.removeAttribute('src');
      img.classList.add('md-blocked');
      img.title = 'Картинка из сети не загружается';
    }
  }
  for (const input of fragment.querySelectorAll('input')) input.disabled = true;
  for (const a of fragment.querySelectorAll<HTMLAnchorElement>('a[href]')) a.title = a.getAttribute('href') ?? '';
  return fragment;
}

/** Ссылка, по которой щёлкнули в отрендеренном документе, или null, если щелчок не по ссылке. */
export function clickedLink(event: MouseEvent, file: string, root: string): MdLink | null {
  const a = (event.target as Element | null)?.closest?.('a[href]');
  return a ? resolveLink(a.getAttribute('href') ?? '', file, root) : null;
}
