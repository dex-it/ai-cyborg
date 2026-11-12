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
      dirty: s.measured ? s.dirty.map((d) => d.reason).join('; ') : 'не проверены',
    }));
}

export function diskSummary(disk: HostDisk): string {
  if (!(disk.total > 0)) return `${disk.host}: место на диске неизвестно`;
  const share = Math.round((disk.free / disk.total) * 100);
  const unmeasured = disk.sessions.filter((s) => !s.measured).length;
  const note = unmeasured ? `; не уложились в отведённое время, размер и клоны не проверены: ${unmeasured}` : '';
  return `${disk.host}: свободно ${formatBytes(disk.free)} из ${formatBytes(disk.total)} (${share} %)${note}`;
}

export interface PurgePlan {
  sids: string[];
  /** Сессии с грязными клонами, которые человек увидит во втором подтверждении. */
  dirtySids: string[];
  dirty: string[];
}

/** Что удалить и какие клоны требуют второго подтверждения. */
export function purgePlan(disk: HostDisk, checked: ReadonlySet<string>): PurgePlan {
  const chosen = disk.sessions.filter((s) => s.state !== 'live' && checked.has(s.sid));
  const dirty = chosen.filter((s) => s.dirty.length);
  return { sids: chosen.map((s) => s.sid), dirtySids: dirty.map((s) => s.sid), dirty: dirty.flatMap((s) => s.dirty.map((d) => `${d.path} - ${d.reason}`)) };
}

/** Вызовы удаления: force только у сессий из перечня второго подтверждения, остальные демон перепроверит и грязное оставит. */
export function purgeCalls(plan: PurgePlan, force: boolean): { sids: string[]; force: boolean }[] {
  const forced = force ? plan.dirtySids : [];
  const plain = plan.sids.filter((sid) => !forced.includes(sid));
  return [...(plain.length ? [{ sids: plain, force: false }] : []), ...(forced.length ? [{ sids: forced, force: true }] : [])];
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
