// Выбор PR/MR для подстановки `{pr}` (фича 12, FR-12003): по ветке сессии среди открытых PR/MR проекта, не только своих.

import type { Mr } from '../main/mrs';
import { mrNumber } from './mr-model';

export type PrPick = { url: string } | { reason: string };

/**
 * Открытый PR/MR с веткой источника `branch` в репозитории `repo`. Свой приоритетнее чужого: чужой берётся, только если своего нет.
 * PR/MR с одинаковой веткой источника и назначения не берётся: в одном репозитории так не бывает, это PR из форка (его `main` не ветка сессии).
 * Несколько подходящих на одном уровне - отказ с перечнем номеров: «тот самый» PR выбирает человек.
 */
export function pickPr(mrs: readonly Mr[], branch: string, repo: string): PrPick {
  const fits = mrs.filter((mr) => mr.state === 'open' && mr.sourceBranch === branch && mr.sourceBranch !== mr.targetBranch && mr.repos.includes(repo));
  const own = fits.filter((mr) => mr.own);
  const tier = own.length ? own : fits;
  if (tier.length === 1) return { url: tier[0].url };
  if (!tier.length) return { reason: `у ветки ${branch} нет открытого PR/MR` };
  return { reason: `у ветки ${branch} несколько открытых PR/MR (${tier.map((mr) => mrNumber(mr.kind, mr.number)).join(', ')}): выберите нужный` };
}
