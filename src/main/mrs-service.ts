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
  type MrDetail,
  type MrDetailsResult,
  type MrFilter,
  type MrListResult,
  type MrRef,
  type ParsedMr,
} from './mrs';
import { enc, firstLine, interpret, MAX_TRACKED, sourceKey, type CliRunner, type Fetched, type Source, type TrackersService } from './trackers';

// Только чтение: ни -X, ни --input. Единственный graphql - постоянные запросы ниже без mutation; путь проекта и курсор идут переменными через -f.
const GL_MR_PAGE = 'mergeRequests(state: opened, first: 100, after: $endCursor){ pageInfo{ hasNextPage endCursor } nodes{ iid headPipeline{ status } ';
const GL_MR_QUERY = `query($fullPath: ID!, $endCursor: String){ project(fullPath: $fullPath){ ${GL_MR_PAGE}approvalsRequired approvedBy{ nodes{ username } } } } } }`;
/** Без правил апрува: у редакции GitLab без них поля approvalsRequired нет. */
const GL_MR_QUERY_LITE = `query($fullPath: ID!, $endCursor: String){ project(fullPath: $fullPath){ ${GL_MR_PAGE}approvedBy{ nodes{ username } } } } } }`;
const DETAILS_KEPT = 8;
const GH_MR_JQ =
  '.[] | {number,title,draft,created_at,updated_at,user:.user.login,head_ref:.head.ref,head_label:.head.label,head_repo:.head.repo.full_name,head_sha:.head.sha,base_ref:.base.ref,assignees:[.assignees[].login],reviewers:[.requested_reviewers[].login]}';
const GH_MR_ONE_JQ =
  '{number,title,state,draft,merged,created_at,updated_at,user:.user.login,head_ref:.head.ref,head_label:.head.label,head_repo:.head.repo.full_name,head_sha:.head.sha,base_ref:.base.ref}';
const GH_RUNS_JQ = '.check_runs[] | {status,conclusion}';
const GH_STATUS_JQ = '{state,total_count}';
const GH_REVIEWS_JQ = '.[] | {login:.user.login,state}';

type Values = unknown[] | null;
type Detail = Pick<MrDetail, 'pipeline' | 'approvals'>;
type GitlabPage = { details: Map<number, Detail>; next: string | null };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Все ошибки ответа - «у MR нет поля approvalsRequired»: хост без правил апрува. */
function lacksApprovalRules(body: unknown): boolean {
  const errors = isRecord(body) ? body.errors : undefined;
  if (!Array.isArray(errors) || !errors.length) return false;
  return errors.every((e) => {
    if (!isRecord(e)) return false;
    const ext = isRecord(e.extensions) ? e.extensions : {};
    return (ext.code === 'undefinedField' && ext.fieldName === 'approvalsRequired') || (typeof e.message === 'string' && /Field 'approvalsRequired' doesn't exist/.test(e.message));
  });
}

function gitlabNode(node: unknown): [number, Detail] | null {
  if (!isRecord(node)) return null;
  const iid = Number(node.iid);
  if (!Number.isSafeInteger(iid) || iid < 1) return null;
  const head = node.headPipeline;
  const pipeline = head === null ? NO_PIPELINE : isRecord(head) && typeof head.status === 'string' ? gitlabPipeline(head.status.toLowerCase()) : null;
  const approvedBy = isRecord(node.approvedBy) ? node.approvedBy.nodes : undefined;
  const approvals = Array.isArray(approvedBy) ? approvalsText(approvedBy.length, typeof node.approvalsRequired === 'number' ? node.approvalsRequired : undefined) : null;
  return [iid, { pipeline, approvals }];
}

/** Выборка открытых MR/PR по remote репозиториев проекта через gh и glab; источники разбирает TrackersService. */
export class MrsService {
  /** Хосты GitLab без правил апрува: запоминаются на время работы приложения, чтобы не платить лишним вызовом. */
  private readonly noApprovalRules = new Set<string>();
  private readonly pending = new Map<number, Promise<MrDetailsResult>>();
  private seq = 0;

  constructor(
    private readonly trackers: TrackersService,
    private readonly run: CliRunner,
  ) {}

  /** Вторая фаза выборки по номеру из listMrs; номер одноразовый, неизвестный и вытесненный дают null. */
  details(id: number): Promise<MrDetailsResult | null> {
    const p = this.pending.get(id);
    this.pending.delete(id);
    return Promise.resolve(p ?? null);
  }

  /** Список сразу после REST-запросов; детали досчитываются в фоне и забираются через details(detailsId). */
  async listMrs(projectId: string, filter: MrFilter, tracked: MrRef[], recheck = false): Promise<MrListResult> {
    const { project, enabled, sources, blocked, preErrors, gitlabUsers, loginOf } = await this.trackers.resolveSources(projectId, recheck);
    const result: MrListResult = { mrs: [], sources: [...preErrors], tracked: [], enabled, detailsId: null, awaiting: [] };
    if (!project) return { ...result, error: 'Проект не найден' };
    if (!enabled.github && !enabled.gitlab) return result;

    const meOf = async (source: Source): Promise<{ me?: string; error?: string }> => {
      if (source.kind === 'gitlab') return { me: gitlabUsers.get(source.host) };
      const login = await loginOf();
      return typeof login === 'string' ? { me: login } : { error: login.error };
    };

    // GraphQL GitLab стартует вместе со списком: он от списка не зависит.
    const glDetails = new Map<string, Promise<Map<number, Detail>>>();
    for (const source of sources.values()) if (source.kind === 'gitlab') glDetails.set(sourceKey(source), this.gitlabDetails(source));

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

    result.mrs = items.map((x) => x.item.mr);

    // Детали GitHub - по свежим MR из отфильтрованных; остальные остаются с «—». MR с открытой сессией
    // получают детали сверх предела (их не больше MAX_TRACKED): иначе заголовок сессии затёрся бы «—».
    // Предел задан ценой REST-вызовов на MR; GraphQL GitLab отдаёт все открытые MR источника.
    const trackedKeys = new Set(tracked.slice(0, MAX_TRACKED).map(mrKey));
    const github = items.filter((x) => x.source.kind === 'github');
    const detailed = new Set(
      [...github]
        .sort((a, b) => (Date.parse(b.item.mr.updatedAt) || 0) - (Date.parse(a.item.mr.updatedAt) || 0))
        .slice(0, MAX_DETAILED)
        .map((x) => x.item),
    );
    for (const x of github) if (trackedKeys.has(x.item.mr.key)) detailed.add(x.item);
    const githubItems = github.filter((x) => detailed.has(x.item));
    const gitlabItems = items.filter((x) => x.source.kind === 'gitlab');

    const have = new Set(result.mrs.map((m) => m.key));
    const wanted = new Map<string, { source: Source; ref: MrRef }>();
    for (const ref of tracked.slice(0, MAX_TRACKED)) {
      const key = mrKey(ref);
      const sk = sourceKey(ref);
      const source = sources.get(sk);
      if (have.has(key) || wanted.has(key) || !source || failed.has(sk)) continue;
      wanted.set(key, { source, ref });
    }

    result.awaiting = [...gitlabItems, ...githubItems].map((x) => x.item.mr.key);
    if (!result.awaiting.length && !wanted.size) return result;

    // Пул общий для деталей GitHub и MR с сессией вне списка: процессов CLI не больше MR_CONCURRENCY плюс GraphQL источников.
    const pooled = runLimited<{ detail: MrDetail } | { mr: Mr | null }>(
      [
        ...githubItems.map((x) => async () => ({ detail: { key: x.item.mr.key, ...(await this.fill(x.source, x.item)) } })),
        ...[...wanted.values()].map(({ source, ref }) => async () => {
          try {
            return { mr: await this.fetchOne(source, ref.number) };
          } catch {
            return { mr: null };
          }
        }),
      ],
      MR_CONCURRENCY,
    );
    const collect = async (): Promise<MrDetailsResult> => {
      const [maps, rest] = await Promise.all([Promise.all(gitlabItems.map((x) => glDetails.get(sourceKey(x.source)))), pooled]);
      const details: MrDetail[] = [];
      const singles: Mr[] = [];
      for (const r of rest) {
        if ('detail' in r) details.push(r.detail);
        else if (r.mr) singles.push(r.mr);
      }
      gitlabItems.forEach((x, i) => {
        const d = maps[i]?.get(x.item.mr.number);
        details.push({ key: x.item.mr.key, pipeline: d?.pipeline ?? null, approvals: d?.approvals ?? null });
      });
      return { details, tracked: singles };
    };
    result.detailsId = this.keep(collect().catch(() => ({ details: [], tracked: [] })));
    return result;
  }

  private keep(details: Promise<MrDetailsResult>): number {
    const id = ++this.seq;
    this.pending.set(id, details);
    // Вытесненная выборка дорабатывает свои процессы CLI, результат теряется.
    while (this.pending.size > DETAILS_KEPT) this.pending.delete(this.pending.keys().next().value!);
    return id;
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
    // Вызовы одного MR идут подряд: пул MR_CONCURRENCY ограничивает число процессов CLI, а не только MR.
    const runs = await this.values('gh', 'github', [...base, '--paginate', '--jq', GH_RUNS_JQ, `repos/${source.path}/commits/${sha}/check-runs?per_page=100`]);
    const status = await this.values('gh', 'github', [...base, '--jq', GH_STATUS_JQ, `repos/${source.path}/commits/${sha}/status`]);
    if (!runs || !status) return null;
    return githubPipeline(runs as CheckRun[], (status[0] ?? null) as CombinedStatus | null);
  }

  /** Пайплайн и апрувы одного PR GitHub; каждое поле независимо. */
  private async fill(source: Source, item: ParsedMr): Promise<Detail> {
    const pipeline = await this.githubPipelineOf(source, item.headSha);
    const reviews = await this.values('gh', 'github', ['api', '--hostname', 'github.com', '--paginate', '--jq', GH_REVIEWS_JQ, `repos/${source.path}/pulls/${item.mr.number}/reviews?per_page=100`]);
    return { pipeline, approvals: reviews ? approvalsText(githubApprovals(reviews as { login?: unknown; state?: unknown }[])) : null };
  }

  /** Детали всех открытых MR источника GitLab страницами GraphQL; не отклоняется: при отказе отдаёт собранное. */
  private async gitlabDetails(source: Source): Promise<Map<number, Detail>> {
    const out = new Map<number, Detail>();
    try {
      const seen = new Set<string>();
      let cursor: string | null = null;
      for (;;) {
        const page = await this.gitlabPage(source, cursor);
        if (!page) break;
        for (const [iid, d] of page.details) out.set(iid, d);
        if (!page.next || seen.has(page.next)) break;
        seen.add(page.next);
        cursor = page.next;
      }
    } catch {
      // отказ задевает только детали: у MR без записи будет «—»
    }
    return out;
  }

  /** Одна страница; null - отказ. Хост без поля approvalsRequired запоминается, страница повторяется без него. */
  private async gitlabPage(source: Source, cursor: string | null): Promise<GitlabPage | null> {
    for (;;) {
      const full = !this.noApprovalRules.has(source.host);
      const res = await this.run('glab', [
        'api', '--hostname', source.host, 'graphql',
        '-f', `query=${full ? GL_MR_QUERY : GL_MR_QUERY_LITE}`,
        '-f', `fullPath=${source.path}`,
        ...(cursor ? ['-f', `endCursor=${cursor}`] : []),
      ]);
      const out = interpret('gitlab', res, null);
      let body: unknown;
      if ('values' in out) body = out.values[0];
      else
        try {
          body = JSON.parse(res.stdout);
        } catch {
          return null;
        }
      if (full && lacksApprovalRules(body)) {
        this.noApprovalRules.add(source.host);
        continue;
      }
      if (!('values' in out) || !isRecord(body) || !isRecord(body.data)) return null;
      const project = body.data.project;
      const connection = isRecord(project) && isRecord(project.mergeRequests) ? project.mergeRequests : null;
      const details = new Map<number, Detail>();
      for (const node of Array.isArray(connection?.nodes) ? connection.nodes : []) {
        const entry = gitlabNode(node);
        if (entry) details.set(entry[0], entry[1]);
      }
      const info = connection && isRecord(connection.pageInfo) ? connection.pageInfo : {};
      const next = info.hasNextPage === true && typeof info.endCursor === 'string' && info.endCursor ? info.endCursor : null;
      return { details, next };
    }
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
