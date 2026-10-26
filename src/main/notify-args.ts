const TITLE_LENGTH = 200;
const BODY_LENGTH = 300;

export interface NotifyArgs {
  id: number;
  title: string;
  body: string;
}

const clip = (text: string, length: number): string => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

/** Интерфейсу не доверяем: id - целое неотрицательное, заголовок и текст - строки, длина ограничена. Иное - null, уведомления нет. */
export function validateNotifyArgs(id: unknown, title: unknown, body: unknown): NotifyArgs | null {
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 0) return null;
  if (typeof title !== 'string' || typeof body !== 'string' || !title.trim()) return null;
  return { id, title: clip(title, TITLE_LENGTH), body: clip(body, BODY_LENGTH) };
}
