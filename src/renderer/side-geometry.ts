export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const SIDE_BOX_KEY = 'cyborg.sideDialog';
export const SIDE_MIN = { width: 280, height: 200 };

/** Окно целиком внутри панели терминала: панели разных проектов разного размера, а место одно на все. */
export function fitBox(box: Box, areaWidth: number, areaHeight: number): Box {
  const width = Math.max(Math.min(SIDE_MIN.width, areaWidth), Math.min(box.width, areaWidth));
  const height = Math.max(Math.min(SIDE_MIN.height, areaHeight), Math.min(box.height, areaHeight));
  const left = Math.min(Math.max(0, box.left), Math.max(0, areaWidth - width));
  const top = Math.min(Math.max(0, box.top), Math.max(0, areaHeight - height));
  return { left: Math.round(left), top: Math.round(top), width: Math.round(width), height: Math.round(height) };
}

export function parseBox(text: string | null): Box | null {
  if (!text) return null;
  try {
    const b = JSON.parse(text) as Record<string, unknown>;
    const n = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
    return n(b.left) && n(b.top) && n(b.width) && n(b.height) ? { left: b.left, top: b.top, width: b.width, height: b.height } : null;
  } catch {
    return null;
  }
}
