/** Место на хосте удалённых сессий: общее для главного процесса и окна «Место на хостах». */

export type DiskState = 'live' | 'asleep' | 'done' | 'orphan';

export interface DiskSession {
  sid: string;
  /** live - работает (закрывается вкладкой); asleep - спит; done - завершена, клоны оставлены; orphan - каталог без записи сессии. */
  state: DiskState;
  title: string;
  branch: string;
  /** Локальные репозитории проекта сессии. */
  dirs: string[];
  lastActive: number;
  /** null - du не ответил за отведённое время. */
  bytes: number | null;
  /** Клоны, которые удаляются только вторым подтверждением, с причиной. */
  dirty: { path: string; reason: string }[];
}

export interface DiskSpace {
  free: number;
  total: number;
}

export interface HostDisk extends DiskSpace {
  host: string;
  sessions: DiskSession[];
}

export interface PurgeResult {
  sid: string;
  removed: string[];
  kept: { path: string; reason: string }[];
  error?: string;
}

/** Пороги предупреждения (допущение): меньше 5 ГиБ либо меньше 10 % свободно. */
export const LOW_FREE_BYTES = 5 * 1024 ** 3;
export const LOW_FREE_SHARE = 0.1;

export function lowSpace(space: DiskSpace | null | undefined): boolean {
  if (!space || !(space.total > 0)) return false;
  return space.free < LOW_FREE_BYTES || space.free / space.total < LOW_FREE_SHARE;
}

const UNITS = ['Б', 'КиБ', 'МиБ', 'ГиБ', 'ТиБ'];

export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const text = unit === 0 || value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace('.', ',');
  return `${text} ${UNITS[unit]}`;
}

// Строки с хоста идут в окно: управляющие символы вырезаются, длина ограничена.
const text = (v: unknown, max = 500): string => (typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, max) : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const STATES: DiskState[] = ['live', 'asleep', 'done', 'orphan'];
const pairs = (v: unknown): { path: string; reason: string }[] =>
  (Array.isArray(v) ? v : []).map((x) => ({ path: text((x as Record<string, unknown>)?.path, 4096), reason: text((x as Record<string, unknown>)?.reason) })).filter((x) => x.path);

export function readHostDisk(host: string, value: unknown): HostDisk {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const sessions = (Array.isArray(v.sessions) ? v.sessions : []).flatMap((item): DiskSession[] => {
    const s = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    const sid = text(s.sid, 64);
    if (!/^[0-9a-f-]{8,64}$/.test(sid)) return [];
    return [
      {
        sid,
        state: STATES.includes(s.state as DiskState) ? (s.state as DiskState) : 'orphan',
        title: text(s.title),
        branch: text(s.branch, 300),
        dirs: (Array.isArray(s.dirs) ? s.dirs : []).map((d) => text(d, 4096)).filter(Boolean),
        lastActive: num(s.lastActive),
        bytes: typeof s.bytes === 'number' ? num(s.bytes) : null,
        dirty: pairs(s.dirty),
      },
    ];
  });
  return { host, free: num(v.free), total: num(v.total), sessions };
}

export function readPurge(value: unknown): PurgeResult[] {
  const list = (value as { results?: unknown } | null)?.results;
  return (Array.isArray(list) ? list : []).map((item) => {
    const r = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    return {
      sid: text(r.sid, 64),
      removed: (Array.isArray(r.removed) ? r.removed : []).map((p) => text(p, 4096)).filter(Boolean),
      kept: pairs(r.kept),
      ...(typeof r.error === 'string' ? { error: text(r.error) } : {}),
    };
  });
}
