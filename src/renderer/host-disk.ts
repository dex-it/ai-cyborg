import { ago } from './ago';
import { formatBytes, type DiskState, type HostDisk, type PurgeResult } from '../shared/host-disk';

export interface DiskRow {
  sid: string;
  /** Работающую сессию закрывают вкладкой: флажка у неё нет. */
  selectable: boolean;
  title: string;
  state: string;
  branch: string;
  size: string;
  active: string;
  dirty: string;
}

const STATE_LABELS: Record<DiskState, string> = { live: 'работает', asleep: 'спит', done: 'завершена', orphan: 'без записи' };

/** Строки таблицы: крупные сессии первыми, неизмеренные в конце. */
export function diskRows(disk: HostDisk, now: number): DiskRow[] {
  return [...disk.sessions]
    .sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1))
    .map((s) => ({
      sid: s.sid,
      selectable: s.state !== 'live',
      title: s.title || s.sid.slice(0, 8),
      state: STATE_LABELS[s.state],
      branch: s.branch,
      size: s.bytes === null ? 'не посчитан' : formatBytes(s.bytes),
      active: s.lastActive ? ago(s.lastActive, now) : '',
      dirty: s.dirty.map((d) => d.reason).join('; '),
    }));
}

export function diskSummary(disk: HostDisk): string {
  if (!(disk.total > 0)) return `${disk.host}: место на диске неизвестно`;
  const share = Math.round((disk.free / disk.total) * 100);
  return `${disk.host}: свободно ${formatBytes(disk.free)} из ${formatBytes(disk.total)} (${share} %)`;
}

/** Что удалить и какие клоны требуют второго подтверждения. */
export function purgePlan(disk: HostDisk, checked: ReadonlySet<string>): { sids: string[]; dirty: string[] } {
  const chosen = disk.sessions.filter((s) => s.state !== 'live' && checked.has(s.sid));
  return { sids: chosen.map((s) => s.sid), dirty: chosen.flatMap((s) => s.dirty.map((d) => `${d.path} - ${d.reason}`)) };
}

/** Итог удаления для окна: пусто - всё удалено. */
export function purgeReport(results: PurgeResult[]): string {
  return results
    .flatMap((r) => [
      ...(r.error ? [`${r.sid.slice(0, 8)}: ${r.error}`] : []),
      ...r.kept.map((k) => `оставлен ${k.path}: ${k.reason}`),
    ])
    .join('\n');
}
