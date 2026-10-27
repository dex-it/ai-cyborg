import type { Mr, MrDetailsResult, MrFilter, MrIntent, MrListResult } from '../main/mrs';
import type { TrackerKind } from '../main/trackers';
import { emptyOf, type SortKey } from './task-model';

export const MR_FILTER_OPTIONS: { key: MrFilter; label: string }[] = [
  { key: 'all', label: 'Все' },
  { key: 'author', label: 'Author: я' },
  { key: 'assigned', label: 'Assignee: я' },
  { key: 'review', label: 'Reviewer: я' },
];

export const MR_SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'updated', label: 'Обновлён' },
  { key: 'created', label: 'Создан' },
  { key: 'number', label: 'Номер' },
];

export const mrNumber = (kind: TrackerKind, number: number): string => `${kind === 'github' ? '#' : '!'}${number}`;

type Titled = Pick<Mr, 'kind' | 'number' | 'title' | 'state' | 'draft' | 'pipeline'>;

export function mrStatusText(mr: Pick<Mr, 'state' | 'draft'>): string {
  if (mr.state === 'merged') return 'влит';
  if (mr.state === 'closed') return 'закрыт';
  return mr.draft ? 'черновик' : 'открыт';
}

export const mrSessionLabel = (sessionId: number, mr: Titled): string =>
  `CC${sessionId} · ${mrNumber(mr.kind, mr.number)} ${mr.title} · ${mrStatusText(mr)} · ${mr.pipeline ?? '—'}`;

export const mrTooltip = (mr: Titled & Pick<Mr, 'url'>): string =>
  `${mrNumber(mr.kind, mr.number)} ${mr.title}\nСтатус: ${mrStatusText(mr)}\nПайплайн: ${mr.pipeline ?? '—'}\n${mr.url}`;

export const mrIntent = (mr: Pick<Mr, 'own'>): MrIntent => (mr.own ? 'rework' : 'review');

/** Своему MR дорабатывать нечего, пока нет замечаний; чужой всегда можно ревьюить. */
export const mrActionVisible = (mr: Pick<Mr, 'own' | 'comments'>): boolean => !mr.own || mr.comments === true;

export const mrActionLabel = (mr: Pick<Mr, 'own'>): string => (mrIntent(mr) === 'rework' ? 'Доработать' : 'Ревью');

/** Строка под названием: автор, ветки, черновик, пайплайн, апрувы; не полученное - «—», ожидаемое (pending) - «…». */
export function mrMeta(mr: Pick<Mr, 'author' | 'sourceBranch' | 'targetBranch' | 'draft' | 'pipeline' | 'approvals'>, pending = false): string {
  return [
    mr.author,
    `${mr.sourceBranch} → ${mr.targetBranch}`,
    ...(mr.draft ? ['черновик'] : []),
    pending ? 'пайплайн: …' : `пайплайн: ${mr.pipeline ?? '—'}`,
    pending ? 'апрувов: …' : (mr.approvals ?? 'апрувов: —'),
  ].join(' · ');
}

/** Показанные строки MR по ключу: детали дописываются в них, список не пересоздаётся. */
export class MrMetaSlots {
  private readonly slots = new Map<string, { textContent: string | null }>();

  clear(): void {
    this.slots.clear();
  }

  /** Запоминает строку под ключом MR и возвращает её же. */
  register<T extends { textContent: string | null }>(key: string, slot: T): T {
    this.slots.set(key, slot);
    return slot;
  }

  fill(result: { mrs: (Parameters<typeof mrMeta>[0] & { key: string })[] }): void {
    for (const mr of result.mrs) {
      const slot = this.slots.get(mr.key);
      if (slot) slot.textContent = mrMeta(mr);
    }
  }
}

/** Список с пришедшими деталями; порядок строк прежний, MR без записи - «—». d = null - детали не получены. */
export function applyMrDetails(result: MrListResult, d: MrDetailsResult | null): MrListResult {
  const byKey = new Map((d?.details ?? []).map((x) => [x.key, x]));
  return {
    ...result,
    mrs: result.mrs.map((m) => ({
      ...m,
      pipeline: byKey.get(m.key)?.pipeline ?? null,
      approvals: byKey.get(m.key)?.approvals ?? null,
      comments: byKey.get(m.key)?.comments ?? m.comments,
    })),
    tracked: d?.tracked ?? [],
    detailsId: null,
    awaiting: [],
  };
}

/**
 * Фоновое обновление не затирает известное: пайплайн, апрувы и замечания, которых новый ответ не принёс (вызов деталей упал: лимит, таймаут),
 * берутся из прежнего снимка по ключу MR; не пришли MR вне списка - остаются прежние.
 */
export function keepKnownDetails(next: MrListResult, prev: MrListResult | null): MrListResult {
  if (!prev) return next;
  const before = new Map(prev.mrs.map((m) => [m.key, m]));
  return {
    ...next,
    mrs: next.mrs.map((m) => {
      const old = before.get(m.key);
      return old ? { ...m, pipeline: m.pipeline ?? old.pipeline, approvals: m.approvals ?? old.approvals, comments: m.comments ?? old.comments } : m;
    }),
    tracked: next.tracked.length ? next.tracked : prev.tracked,
  };
}

export const findMr = (result: MrListResult, key: string): Mr | undefined => result.mrs.find((m) => m.key === key) ?? result.tracked.find((m) => m.key === key);

export function mrEmptyView(result: MrListResult): 'disabled' | 'no-remotes' | 'no-mrs' | null {
  const view = emptyOf(result.enabled, result.mrs.length, result.sources, 'none');
  return view === 'none' ? 'no-mrs' : view;
}
