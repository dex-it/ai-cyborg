export const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

export const parentRel = (rel: string): string => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');

export const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export function el(tag: string, className = '', text = ''): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
