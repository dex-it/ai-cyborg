import type { Mr, MrFilter, MrIntent, MrListResult } from '../main/mrs';
import type { TrackerKind } from '../main/trackers';
import { emptyOf, type SortKey } from './task-model';

export const MR_FILTER_OPTIONS: { key: MrFilter; label: string }[] = [
  { key: 'all', label: 'Все' },
  { key: 'assigned', label: 'Назначено мне' },
  { key: 'review', label: 'Я ревьюер' },
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

export const mrActionLabel = (mr: Pick<Mr, 'own'>): string => (mrIntent(mr) === 'rework' ? 'Доработать' : 'Ревью');

/** Строка под названием: автор, ветки, черновик, пайплайн, апрувы; не полученное - «—». */
export function mrMeta(mr: Pick<Mr, 'author' | 'sourceBranch' | 'targetBranch' | 'draft' | 'pipeline' | 'approvals'>): string {
  return [
    mr.author,
    `${mr.sourceBranch} → ${mr.targetBranch}`,
    ...(mr.draft ? ['черновик'] : []),
    `пайплайн: ${mr.pipeline ?? '—'}`,
    mr.approvals ?? 'апрувов: —',
  ].join(' · ');
}

export const findMr = (result: MrListResult, key: string): Mr | undefined => result.mrs.find((m) => m.key === key) ?? result.tracked.find((m) => m.key === key);

export function mrEmptyView(result: MrListResult): 'disabled' | 'no-remotes' | 'no-mrs' | null {
  const view = emptyOf(result.enabled, result.mrs.length, result.sources, 'none');
  return view === 'none' ? 'no-mrs' : view;
}
