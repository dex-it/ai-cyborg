import {
  approvalsText,
  githubApprovals,
  githubPipeline,
  gitlabPipeline,
  isSha,
  filterMrs,
  MAX_DETAILED,
  MR_CONCURRENCY,
  mrKey,
  NO_PIPELINE,
  parseMr,
  runLimited,
  type CheckRun,
  type CombinedStatus,
  type Mr,
  type MrFilter,
  type MrListResult,
  type MrRef,
  type ParsedMr,
} from './mrs';
import { enc, firstLine, interpret, MAX_TRACKED, sourceKey, type CliRunner, type Fetched, type Source, type TrackersService } from './trackers';

// Только чтение: ни -X, ни полей запроса, ни graphql.
const GH_MR_JQ =
  '.[] | {number,title,draft,created_at,updated_at,user:.user.login,head_ref:.head.ref,head_label:.head.label,head_repo:.head.repo.full_name,head_sha:.head.sha,base_ref:.base.ref,assignees:[.assignees[].login],reviewers:[.requested_reviewers[].login]}';
const GH_MR_ONE_JQ =
  '{number,title,state,draft,merged,created_at,updated_at,user:.user.login,head_ref:.head.ref,head_label:.head.label,head_repo:.head.repo.full_name,head_sha:.head.sha,base_ref:.base.ref}';
const GH_RUNS_JQ = '.check_runs[] | {status,conclusion}';
const GH_STATUS_JQ = '{state,total_count}';
const GH_REVIEWS_JQ = '.[] | {login:.user.login,state}';

type Values = unknown[] | null;

/** Выборка открытых MR/PR по remote репозиториев проекта через gh и glab; источники разбирает TrackersService. */
export class MrsService {
  constructor(
    private readonly trackers: TrackersService,
    private readonly run: CliRunner,
  ) {}

  async listMrs(projectId: string, filter: MrFilter, tracked: MrRef[]): Promise<MrListResult> {
    const { project, enabled, sources, blocked, preErrors, gitlabUsers, loginOf } = await this.trackers.resolveSources(projectId);
    const result: MrListResult = { mrs: [], sources: [...preErrors], tracked: [], enabled };
    if (!project) return { ...result, error: 'Проект не найден' };
    if (!enabled.github && !enabled.gitlab) return result;

    const meOf = async (source: Source): Promise<{ me?: string; error?: string }> => {
      if (source.kind === 'gitlab') return { me: gitlabUsers.get(source.host) };
      const login = await loginOf();
      return typeof login === 'string' ? { me: login } : { error: login.error };
    };

    const fetched = await Promise.all(
      [...sources.values()].map(async (source) => {
        try {
          const { me, error } = await meOf(source);
          if (filter !== 'all' && !me) return { source, me, error: error || `не определён пользователь ${source.host}` };
          const out = await this.fetchList(source);
          if (!('values' in out)) return { source, me, error: out.error ?? 'ответ трекера не получен' };
          const parsed = out.values.flatMap((raw) => parseMr(source, raw, me) ?? []);
          return { source, me, items: filterMrs(parsed, filter, me) };
        } catch (e) {
          return { source, me: undefined, error: firstLine((e as Error).message) };
        }
      }),
    );

    const failed = new Set<string>();
    const items: { source: Source; item: ParsedMr }[] = [];
    for (const f of fetched) {
      const info = { kind: f.source.kind, host: f.source.host, path: f.source.path } as MrListResult['sources'][number];
      if ('error' in f && f.error) {
        info.error = f.error;
        failed.add(sourceKey(f.source));
      } else if (f.items) for (const item of f.items) items.push({ source: f.source, item });
      result.sources.push(info);
    }
    result.sources.push(...blocked.values());

    // Детали - по свежим MR из отфильтрованных; остальные остаются с «—».
    const detailed = new Set(
      [...items]
        .sort((a, b) => (Date.parse(b.item.mr.updatedAt) || 0) - (Date.parse(a.item.mr.updatedAt) || 0))
        .slice(0, MAX_DETAILED)
        .map((x) => x.item),
    );
    await runLimited(
      items.filter((x) => detailed.has(x.item)).map((x) => () => this.fill(x.source, x.item)),
      MR_CONCURRENCY,
    );
    result.mrs = items.map((x) => x.item.mr);

    const have = new Set(result.mrs.map((m) => m.key));
    const wanted = new Map<string, { source: Source; ref: MrRef }>();
    for (const ref of tracked.slice(0, MAX_TRACKED)) {
      const key = mrKey(ref);
      const sk = sourceKey(ref);
      const source = sources.get(sk);
      if (have.has(key) || wanted.has(key) || !source || failed.has(sk)) continue;
      wanted.set(key, { source, ref });
    }
    const singles = await runLimited(
      [...wanted.values()].map(({ source, ref }) => async () => {
        try {
          return await this.fetchOne(source, ref.number);
        } catch {
          return null;
        }
      }),
      MR_CONCURRENCY,
    );
    result.tracked = singles.filter((m): m is Mr => m !== null);
    return result;
  }

  private async fetchList(source: Source): Promise<Fetched> {
    if (source.kind === 'github') {
      return interpret('github', await this.run('gh', ['api', '--hostname', 'github.com', '--paginate', '--jq', GH_MR_JQ, `repos/${source.path}/pulls?state=open&per_page=100`]), null);
    }
    return interpret('gitlab', await this.run('glab', ['api', '--hostname', source.host, '--paginate', `projects/${enc(source.path)}/merge_requests?state=opened&per_page=100`]), null);
  }

  /** Значения успешного вызова либо null: отказ деталей затрагивает только своё поле. */
  private async values(cmd: 'gh' | 'glab', kind: Source['kind'], args: string[]): Promise<Values> {
    try {
      const out = interpret(kind, await this.run(cmd, args), null);
      return 'values' in out ? out.values : null;
    } catch {
      return null;
    }
  }

  private async githubPipelineOf(source: Source, sha: string): Promise<string | null> {
    if (!isSha(sha)) return null;
    const base = ['api', '--hostname', 'github.com'];
    const [runs, status] = await Promise.all([
      this.values('gh', 'github', [...base, '--paginate', '--jq', GH_RUNS_JQ, `repos/${source.path}/commits/${sha}/check-runs?per_page=100`]),
      this.values('gh', 'github', [...base, '--jq', GH_STATUS_JQ, `repos/${source.path}/commits/${sha}/status`]),
    ]);
    if (!runs || !status) return null;
    return githubPipeline(runs as CheckRun[], (status[0] ?? null) as CombinedStatus | null);
  }

  /** Пайплайн и апрувы одного MR; каждое поле независимо. */
  private async fill(source: Source, item: ParsedMr): Promise<void> {
    const { mr } = item;
    if (source.kind === 'github') {
      const [pipeline, reviews] = await Promise.all([
        this.githubPipelineOf(source, item.headSha),
        this.values('gh', 'github', ['api', '--hostname', 'github.com', '--paginate', '--jq', GH_REVIEWS_JQ, `repos/${source.path}/pulls/${mr.number}/reviews?per_page=100`]),
      ]);
      mr.pipeline = pipeline;
      mr.approvals = reviews ? approvalsText(githubApprovals(reviews as { login?: unknown; state?: unknown }[])) : null;
      return;
    }
    const project = `projects/${enc(source.path)}/merge_requests/${mr.number}`;
    const [one, approvals] = await Promise.all([
      this.values('glab', 'gitlab', ['api', '--hostname', source.host, project]),
      this.values('glab', 'gitlab', ['api', '--hostname', source.host, `${project}/approvals`]),
    ]);
    mr.pipeline = one ? gitlabPipelineOf(one[0]) : null;
    const body = approvals?.[0] as { approved_by?: unknown; approvals_required?: unknown } | undefined;
    mr.approvals = body && Array.isArray(body.approved_by) ? approvalsText(body.approved_by.length, typeof body.approvals_required === 'number' ? body.approvals_required : undefined) : null;
  }

  /** Один MR вне списка: статус и пайплайн для заголовка сессии. */
  private async fetchOne(source: Source, number: number): Promise<Mr | null> {
    if (source.kind === 'github') {
      const one = await this.values('gh', 'github', ['api', '--hostname', 'github.com', '--jq', GH_MR_ONE_JQ, `repos/${source.path}/pulls/${number}`]);
      const parsed = one && parseMr(source, one[0], undefined);
      if (!parsed) return null;
      parsed.mr.pipeline = await this.githubPipelineOf(source, parsed.headSha);
      return parsed.mr;
    }
    const one = await this.values('glab', 'gitlab', ['api', '--hostname', source.host, `projects/${enc(source.path)}/merge_requests/${number}`]);
    const parsed = one && parseMr(source, one[0], undefined);
    if (!parsed) return null;
    parsed.mr.pipeline = gitlabPipelineOf(one[0]);
    return parsed.mr;
  }
}

function gitlabPipelineOf(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const pipeline = (raw as { head_pipeline?: { status?: unknown } | null }).head_pipeline;
  if (pipeline === null) return NO_PIPELINE;
  if (pipeline === undefined) return null;
  return typeof pipeline.status === 'string' ? gitlabPipeline(pipeline.status) : null;
}
