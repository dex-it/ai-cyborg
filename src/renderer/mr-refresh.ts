import type { MrDetailsResult, MrFilter, MrListResult, MrRef } from '../main/mrs';
import { applyMrDetails } from './mr-model';
import { recheckFor, type RefreshGate, type RefreshTrigger } from './task-flow';

export interface MrRefreshApi {
  listMrs(projectId: string, filter: MrFilter, tracked: MrRef[], recheck: boolean): Promise<MrListResult>;
  mrDetails(id: number): Promise<MrDetailsResult | null>;
}

/** Куда ложатся фазы выборки: список с ожидаемыми ключами, затем список с деталями. */
export interface MrRefreshSink {
  listed(result: MrListResult, pending: Set<string>): void;
  detailed(result: MrListResult): void;
}

/** Двухфазная выборка: список сразу, детали вторым вызовом; ответ не текущего токена отбрасывается. */
export async function refreshMrs(
  api: MrRefreshApi,
  gate: RefreshGate,
  token: number,
  args: { projectId: string; filter: MrFilter; tracked: MrRef[]; trigger: RefreshTrigger },
  sink: MrRefreshSink,
): Promise<void> {
  let list: MrListResult;
  try {
    list = await api.listMrs(args.projectId, args.filter, args.tracked, recheckFor(args.trigger));
  } catch (error) {
    list = { mrs: [], sources: [], tracked: [], enabled: { github: false, gitlab: false }, error: (error as Error).message, detailsId: null, awaiting: [] };
  }
  if (!gate.finish(token)) return;
  sink.listed(list, new Set(list.awaiting));
  if (list.detailsId === null) return;

  // Новая выборка меняет токен: детали прежней отбрасываются, её процессы CLI дорабатывают.
  const details = await api.mrDetails(list.detailsId).catch(() => null);
  if (!gate.isCurrent(token)) return;
  sink.detailed(applyMrDetails(list, details));
}
