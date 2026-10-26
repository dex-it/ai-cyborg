/** Правила сводки статуса без DOM (FR-11004, FR-11005): уровень индикатора, что требует внимания, связь задач Jira с MR. Проверяются в npm test. */

import type { JiraIssue, JiraListResult } from '../main/jira';
import type { Mr, MrIntent, MrListResult } from '../main/mrs';

/** bad - упал пайплайн своего MR; attention - замечания к своему MR либо чужой MR ждёт моего ревью; wait - пайплайн идёт; ok - всё спокойно; unknown - данных нет. */
export type Level = 'bad' | 'attention' | 'wait' | 'ok' | 'unknown';

export type PipelineTone = 'bad' | 'wait' | 'good' | 'none';

// Слова пайплайна задаёт главный процесс (mrs.ts: githubPipeline, gitlabPipeline); mrs.ts тянет Node, поэтому они повторены здесь.
export function pipelineTone(pipeline: string | null): PipelineTone {
  if (pipeline === 'упал') return 'bad';
  if (pipeline === 'идёт' || pipeline === 'ожидает') return 'wait';
  if (pipeline === 'успешен') return 'good';
  return 'none';
}

export type AttentionKind = 'pipeline-failed' | 'has-comments' | 'review-requested';

export interface Attention {
  mr: Mr;
  /** Все причины MR: у своего может упасть пайплайн и быть замечания сразу. */
  kinds: AttentionKind[];
}

/** Что просит внимания: свои открытые MR с упавшим пайплайном или замечаниями, чужие открытые не-черновики, где я ревьюер. Упавшие первыми. */
export function attentionOf(mine: readonly Mr[], review: readonly Mr[]): Attention[] {
  const items: Attention[] = [];
  const seen = new Set<string>();
  for (const mr of mine) {
    if (mr.state !== 'open' || seen.has(mr.key)) continue;
    const kinds: AttentionKind[] = [];
    if (pipelineTone(mr.pipeline) === 'bad') kinds.push('pipeline-failed');
    if (mr.comments === true) kinds.push('has-comments');
    if (!kinds.length) continue;
    seen.add(mr.key);
    items.push({ mr, kinds });
  }
  for (const mr of review) {
    if (mr.state !== 'open' || mr.draft || mr.own || seen.has(mr.key)) continue;
    seen.add(mr.key);
    items.push({ mr, kinds: ['review-requested'] });
  }
  const rank = (a: Attention): number => (a.kinds.includes('pipeline-failed') ? 0 : a.kinds.includes('has-comments') ? 1 : 2);
  return items.sort((a, b) => rank(a) - rank(b));
}

/** Уровень индикатора. mine === null - ни один источник кода ничего не вернул. */
export function levelOf(mine: readonly Mr[] | null, review: readonly Mr[] | null): Level {
  if (mine === null && review === null) return 'unknown';
  const items = attentionOf(mine ?? [], review ?? []);
  if (items.some((i) => i.kinds.includes('pipeline-failed'))) return 'bad';
  if (items.length) return 'attention';
  if ((mine ?? []).some((mr) => mr.state === 'open' && pipelineTone(mr.pipeline) === 'wait')) return 'wait';
  return 'ok';
}

/** Проект без источников кода: список Jira получен - ok, иначе данных нет; задачи Jira уровень не поднимают (D-10). */
export const jiraOnlyLevel = (jira: Pick<JiraListResult, 'error'> | null): Level => (jira && !jira.error ? 'ok' : 'unknown');

/** MR, которыми можно судить об уровне: источник кода включён и хотя бы один его репозиторий ответил без ошибки (нет входа, нет remote - данных нет). */
export const usable = (result: MrListResult | null): Mr[] | null =>
  result && !result.error && (result.enabled.github || result.enabled.gitlab) && result.sources.some((source) => source.path && !source.error) ? result.mrs : null;

// ---------- записи MR ----------

export interface MrAction {
  label: string;
  intent: MrIntent;
  primary: boolean;
}

/** Кнопки записи MR (FR-11007, FR-11009): у MR одна сессия на все намерения - есть она, кнопка одна; иначе по кнопке на причину. */
export function mrActions(mr: Pick<Mr, 'own'>, kinds: readonly AttentionKind[], hasSession: boolean): MrAction[] {
  if (hasSession) return [{ label: 'К сессии', intent: mr.own ? 'rework' : 'review', primary: false }];
  if (!mr.own) return [{ label: 'Ревью', intent: 'review', primary: kinds.length > 0 }];
  const failed = kinds.includes('pipeline-failed');
  const actions: MrAction[] = [];
  if (failed) actions.push({ label: 'Разобрать пайплайн', intent: 'ci', primary: true });
  if (kinds.includes('has-comments')) actions.push({ label: 'Доработать', intent: 'rework', primary: !failed });
  return actions;
}

/** Записи раздела: с причиной внимания первыми, в остальном порядок прежний. */
export const byAttention = (mrs: readonly Mr[], attention: { has(key: string): boolean }): Mr[] =>
  [...mrs].sort((a, b) => Number(attention.has(b.key)) - Number(attention.has(a.key)));

/** «Ждут моего ревью»: открытые MR, где я ревьюер, кроме своих. */
export const reviewQueue = (review: readonly Mr[]): Mr[] => review.filter((mr) => mr.state === 'open' && !mr.own);

// ---------- связь Jira и MR ----------

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Ключ задачи упомянут в тексте отдельным словом: DEX-1 не находится в DEX-12 и в XDEX-1. Регистр не важен: ветки пишут `dex-1-fix`. */
export function mentionsKey(text: string, key: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_])${escape(key)}(?![0-9])`, 'i').test(text);
}

/** MR, в названии или ветке которых упомянут ключ задачи; свежие первыми в порядке входа. */
export function mrsOfIssue(issue: Pick<JiraIssue, 'key'>, mrs: readonly Mr[]): Mr[] {
  return mrs.filter((mr) => mentionsKey(mr.title, issue.key) || mentionsKey(mr.sourceBranch, issue.key));
}

export interface IssueGroup {
  id: 'progress' | 'rest';
  title: string;
  issues: JiraIssue[];
}

/** «В работе» (категория статуса indeterminate) и остальные; пустые группы не возвращаются, порядок задач прежний. */
export function groupIssues(issues: readonly JiraIssue[]): IssueGroup[] {
  const progress = issues.filter((i) => i.category === 'indeterminate');
  const rest = issues.filter((i) => i.category !== 'indeterminate');
  return [
    { id: 'progress' as const, title: 'В работе', issues: progress },
    { id: 'rest' as const, title: 'Остальные открытые', issues: rest },
  ].filter((group) => group.issues.length);
}

export const ATTENTION_TEXT: Record<AttentionKind, string> = {
  'pipeline-failed': 'пайплайн упал',
  'has-comments': 'есть замечания',
  'review-requested': 'ждёт вашего ревью',
};

export const LEVEL_TEXT: Record<Level, string> = {
  bad: 'Есть упавший пайплайн',
  attention: 'Что-то ждёт вас',
  wait: 'Пайплайны идут',
  ok: 'Всё спокойно',
  unknown: 'Статус не получен',
};
