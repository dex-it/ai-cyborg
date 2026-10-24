import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { claudeArgs, ISOLATION_PROMPT } from '../src/main/claude-args';
import {
  approvalsText,
  filterMrs,
  githubApprovals,
  githubCommented,
  gitlabOpenThreads,
  githubPipeline,
  gitlabPipeline,
  MAX_DETAILED,
  MR_CONCURRENCY,
  mrKey,
  mrPrompt,
  mrUrl,
  parseMr,
  createLimiter,
  runLimited,
  toMr,
  validateMrDetailsArgs,
  validateMrListArgs,
  validateSessionStart,
  type MrListResult,
  type ParsedMr,
} from '../src/main/mrs';
import { MrsService } from '../src/main/mrs-service';
import { applyMrDetails } from '../src/renderer/mr-model';
import type { Project } from '../src/main/projects';
import { taskKey, TrackersService, type CliResult, type TrackerSettings } from '../src/main/trackers';

const gh = { kind: 'github' as const, host: 'github.com', path: 'o/r', repos: ['/w/a'] };
const gl = { kind: 'gitlab' as const, host: 'git.corp', path: 'g/s/p', repos: ['/w/a'] };
const ghRaw = (n: number, over = {}) => ({
  number: n, title: `T${n}`, draft: false, created_at: '2026-01-01T00:00:00Z', updated_at: `2026-02-0${n}T00:00:00Z`, user: 'Alice',
  head_ref: 'feat', head_label: 'alice:feat', head_repo: 'o/r', head_sha: 'a'.repeat(40), base_ref: 'main', assignees: [], reviewers: [], ...over,
});

describe('toMr', () => {
  it('PR из своей ветки: ветка без владельца; из форка и из удалённого форка - head.label', () => {
    assert.equal(toMr(gh, ghRaw(1), undefined)!.sourceBranch, 'feat');
    assert.equal(toMr(gh, ghRaw(1, { head_repo: 'Alice/R' }), undefined)!.sourceBranch, 'alice:feat');
    assert.equal(toMr(gh, ghRaw(1, { head_repo: null }), undefined)!.sourceBranch, 'alice:feat');
    assert.equal(toMr(gh, ghRaw(1, { head_repo: 'O/R' }), undefined)!.sourceBranch, 'feat');
  });
  it('черновик, автор, цель, URL, ключ; конвейер и апрувы не получены', () => {
    const mr = toMr(gh, ghRaw(3, { draft: true }), undefined)!;
    assert.equal(mr.draft, true);
    assert.equal(mr.author, 'Alice');
    assert.equal(mr.targetBranch, 'main');
    assert.equal(mr.url, 'https://github.com/o/r/pull/3');
    assert.equal(mr.key, 'github:github.com/o/r!3');
    assert.equal(mr.pipeline, null);
    assert.equal(mr.approvals, null);
  });
  it('GitLab: iid, author.username, source_branch -> target_branch', () => {
    const mr = toMr(gl, { iid: 7, title: 'x', draft: true, author: { username: 'bob' }, source_branch: 's', target_branch: 't', state: 'opened' }, 'BOB')!;
    assert.deepEqual([mr.number, mr.author, mr.sourceBranch, mr.targetBranch, mr.own, mr.state], [7, 'bob', 's', 't', true, 'open']);
  });
  it('номер не целое >= 1 - запись отбрасывается; без названия и автора строка не падает', () => {
    for (const n of [0, 1.5, '3', null]) assert.equal(toMr(gh, ghRaw(1, { number: n }), undefined), null);
    assert.equal(toMr(gl, { iid: -1 }, undefined), null);
    const bare = toMr(gh, { number: 2 }, undefined)!;
    assert.deepEqual([bare.title, bare.author], ['', '']);
  });
  it('own: сравнение без учёта регистра; логин неизвестен - чужой', () => {
    assert.equal(toMr(gh, ghRaw(1), 'alice')!.own, true);
    assert.equal(toMr(gh, ghRaw(1), 'bob')!.own, false);
    assert.equal(toMr(gh, ghRaw(1), undefined)!.own, false);
  });
  it('состояния одиночного запроса: влит, закрыт, locked', () => {
    assert.equal(toMr(gh, ghRaw(1, { state: 'closed', merged: true }), undefined)!.state, 'merged');
    assert.equal(toMr(gh, ghRaw(1, { state: 'closed', merged: false }), undefined)!.state, 'closed');
    assert.equal(toMr(gl, { iid: 1, state: 'merged' }, undefined)!.state, 'merged');
    assert.equal(toMr(gl, { iid: 1, state: 'locked' }, undefined)!.state, 'closed');
  });
});

describe('сводки', () => {
  it('githubPipeline: приоритеты', () => {
    const run = (status: string, conclusion: string | null = null) => ({ status, conclusion });
    assert.equal(githubPipeline([run('completed', 'success'), run('completed', 'failure')], null), 'упал');
    assert.equal(githubPipeline([run('completed', 'success'), run('in_progress')], null), 'идёт');
    assert.equal(githubPipeline([run('completed', 'success'), run('queued')], null), 'ожидает');
    assert.equal(githubPipeline([run('completed', 'cancelled')], null), 'отменён');
    assert.equal(githubPipeline([run('completed', 'success'), run('completed', 'skipped')], null), 'успешен');
    assert.equal(githubPipeline([run('completed', 'success')], { state: 'failure', total_count: 1 }), 'упал');
    assert.equal(githubPipeline([run('completed', 'success')], { state: 'pending', total_count: 1 }), 'ожидает');
    assert.equal(githubPipeline([], { state: 'success', total_count: 2 }), 'успешен');
  });
  it('githubPipeline: без check runs и статусов - «нет пайплайна», pending при total_count=0 не считается', () => {
    assert.equal(githubPipeline([], null), 'нет пайплайна');
    assert.equal(githubPipeline([], { state: 'pending', total_count: 0 }), 'нет пайплайна');
  });
  it('gitlabPipeline', () => {
    assert.deepEqual(['success', 'failed', 'running', 'pending', 'canceled', 'manual'].map(gitlabPipeline), ['успешен', 'упал', 'идёт', 'ожидает', 'отменён', 'manual']);
    assert.equal(gitlabPipeline(null), 'нет пайплайна');
  });
  it('approvalsText: «N из M» только при обязательных', () => {
    assert.equal(approvalsText(1, 2), 'апрувов: 1 из 2');
    assert.equal(approvalsText(1, 0), 'апрувов: 1');
    assert.equal(approvalsText(0), 'апрувов: 0');
  });
  it('githubApprovals: решает последнее значимое ревью логина', () => {
    const r = (login: string, state: string) => ({ login, state });
    assert.equal(githubApprovals([r('alice', 'APPROVED'), r('alice', 'COMMENTED')]), 1);
    assert.equal(githubApprovals([r('alice', 'APPROVED'), r('alice', 'CHANGES_REQUESTED')]), 0);
    assert.equal(githubApprovals([r('alice', 'APPROVED'), r('Alice', 'DISMISSED')]), 0);
    assert.equal(githubApprovals([r('alice', 'APPROVED'), r('bob', 'APPROVED'), r('bob', 'PENDING')]), 2);
  });
});

describe('замечания MR', () => {
  it('githubCommented: замечание или просьба изменений не автора; апрув и свои отзывы - нет', () => {
    const r = (login: string, state: string) => ({ login, state });
    assert.equal(githubCommented([r('bob', 'APPROVED'), r('Me', 'COMMENTED')], 'me'), false);
    assert.equal(githubCommented([r('bob', 'COMMENTED')], 'me'), true);
    assert.equal(githubCommented([r('bob', 'CHANGES_REQUESTED')], 'me'), true);
  });
  it('gitlabOpenThreads: только нерешённый тред с возможностью решения', () => {
    assert.equal(gitlabOpenThreads([{ resolvable: false, resolved: false }, { resolvable: true, resolved: true }]), false);
    assert.equal(gitlabOpenThreads([{ resolvable: true, resolved: true }, { resolvable: true, resolved: false }]), true);
    assert.equal(gitlabOpenThreads(null), false);
  });
  it('parseMr: у GitLab без заметок замечаний нет, с заметками решают треды; у GitHub в списке не известен', () => {
    const raw = (notes: unknown) => ({ iid: 1, title: 't', author: { username: 'me' }, user_notes_count: notes });
    assert.equal(parseMr(gl, raw(0), 'me')!.mr.comments, false);
    assert.equal(parseMr(gl, raw(3), 'me')!.mr.comments, null);
    assert.equal(parseMr(gl, raw(undefined), 'me')!.mr.comments, null);
    assert.equal(parseMr(gh, ghRaw(1), 'me')!.mr.comments, null);
  });
});

describe('filterMrs', () => {
  const item = (n: number, assignees: string[], reviewers: string[], user = 'other'): ParsedMr => {
    const p = parseMr(gh, ghRaw(n, { assignees, reviewers, user }), undefined)!;
    return p;
  };
  const items = [item(1, ['mmx'], []), item(2, [], ['MMX']), item(3, [], [], 'Mmx')];
  it('каждое значение даёт свой набор; регистр не важен', () => {
    assert.deepEqual(filterMrs(items, 'all', 'x').map((i) => i.mr.number), [1, 2, 3]);
    assert.deepEqual(filterMrs(items, 'assigned', 'MMX').map((i) => i.mr.number), [1]);
    assert.deepEqual(filterMrs(items, 'review', 'mmx').map((i) => i.mr.number), [2]);
    assert.deepEqual(filterMrs(items, 'author', 'mmx').map((i) => i.mr.number), [3]);
  });
  it('без логина фильтр не подменяется полной выборкой', () => {
    assert.deepEqual(filterMrs(items, 'assigned', undefined), []);
  });
});

describe('ключи, URL и сообщения', () => {
  const ref = { kind: 'github' as const, host: 'github.com', path: 'O/r', number: 5 };
  const lab = { kind: 'gitlab' as const, host: 'git.corp', path: 'g/sub/p', number: 3 };
  it('mrUrl: канонические адреса, вложенные группы сохраняются', () => {
    assert.equal(mrUrl(ref), 'https://github.com/O/r/pull/5');
    assert.equal(mrUrl(lab), 'https://git.corp/g/sub/p/-/merge_requests/3');
  });
  it('mrKey не совпадает с taskKey того же номера', () => {
    assert.equal(mrKey(ref), 'github:github.com/o/r!5');
    assert.notEqual(mrKey(ref), taskKey(ref));
  });
  it('mrPrompt: ревью - slash-команда со ссылкой после review; доработка - точный текст', () => {
    assert.equal(mrPrompt(lab, 'review'), '/dex-auto:auto review https://git.corp/g/sub/p/-/merge_requests/3');
    assert.equal(
      mrPrompt(ref, 'rework'),
      'Разбери замечания к MR https://github.com/O/r/pull/5: переключись на его ветку и доработай её по замечаниям ревью.',
    );
  });
  it('claudeArgs: промпт на «/» стоит до --add-dir', () => {
    assert.deepEqual(claudeArgs(['/b'], '/dex-auto:auto review URL'), ['--append-system-prompt', ISOLATION_PROMPT, '/dex-auto:auto review URL', '--add-dir', '/b']);
  });
});

describe('validateMrListArgs', () => {
  const ref = { kind: 'github', host: 'github.com', path: 'o/r', number: 5 };
  it('принимает корректные аргументы', () => {
    assert.ok(validateMrListArgs('p', 'review', [ref], false));
    assert.ok(validateMrListArgs('p', 'all', Array(200).fill(ref), true));
  });
  it('recheck - только boolean', () => {
    for (const bad of [undefined, 'x', 1, null]) assert.equal(validateMrListArgs('p', 'all', [], bad), null);
  });
  it('номер выборки деталей: целое больше нуля', () => {
    assert.equal(validateMrDetailsArgs(1), 1);
    for (const bad of [0, -1, 1.5, '1', NaN, 2 ** 53, null, undefined]) assert.equal(validateMrDetailsArgs(bad), null);
  });
  it('отвергает фильтр вне трёх значений, не массив, больше 200, плохие ссылки', () => {
    assert.equal(validateMrListArgs('p', 'mine', [], false), null);
    assert.equal(validateMrListArgs('p', true, [], false), null);
    assert.equal(validateMrListArgs(1, 'all', [], false), null);
    assert.equal(validateMrListArgs('p', 'all', 'x', false), null);
    assert.equal(validateMrListArgs('p', 'all', Array(201).fill(ref), false), null);
    for (const bad of [{ ...ref, number: 0 }, { ...ref, number: 2 ** 31 + 1 }, { ...ref, number: 1.5 }, { ...ref, path: 'o/..' }, { ...ref, host: 'evil.com' }]) {
      assert.equal(validateMrListArgs('p', 'all', [bad], false), null);
    }
  });
});

describe('validateSessionStart', () => {
  const ref = { kind: 'github', host: 'github.com', path: 'o/r', number: 5 };
  it('MR: промпт из ссылки; лишние поля (название) игнорируются и в промпт не попадают', () => {
    const prompt = validateSessionStart({ mr: { ...ref, title: 'ХИТРОЕ НАЗВАНИЕ' }, intent: 'review', title: 'ещё' });
    assert.equal(prompt, '/dex-auto:auto review https://github.com/o/r/pull/5');
  });
  it('задача - прежний путь', () => {
    assert.match(validateSessionStart({ task: ref })!, /issues\/5/);
  });
  it('отвергает намерение вне двух, плохую ссылку, пустой и двойной старт', () => {
    assert.equal(validateSessionStart({ mr: ref, intent: 'merge' }), null);
    assert.equal(validateSessionStart({ mr: ref }), null);
    assert.equal(validateSessionStart({ mr: { ...ref, number: 0 }, intent: 'review' }), null);
    assert.equal(validateSessionStart({ task: ref, mr: ref, intent: 'review' }), null);
    assert.equal(validateSessionStart({}), null);
    assert.equal(validateSessionStart('x'), null);
    assert.equal(validateSessionStart(ref), null);
  });
});

describe('runLimited', () => {
  it('не больше limit одновременно, порядок результатов сохраняется', async () => {
    let running = 0;
    let peak = 0;
    const tasks = Array.from({ length: 20 }, (_, i) => async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, (20 - i) % 4));
      running--;
      return i;
    });
    assert.deepEqual(await runLimited(tasks, 6), Array.from({ length: 20 }, (_, i) => i));
    assert.ok(peak <= 6 && peak > 1);
  });
  it('createLimiter: общий предел на все вызовы, результаты возвращаются, отказ слот освобождает', async () => {
    const limit = createLimiter(2);
    let running = 0;
    let peak = 0;
    const task = (i: number) => async () => {
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, 1));
      running--;
      if (i === 3) throw new Error('x');
      return i;
    };
    const res = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => limit(task(i))));
    assert.equal(peak, 2);
    assert.deepEqual(res.map((r) => (r.status === 'fulfilled' ? r.value : 'err')), [0, 1, 2, 'err', 4, 5, 6, 7]);
  });
  it('пустой список - пул не стартует', async () => {
    assert.deepEqual(await runLimited([], 6), []);
  });
});

// ---------- MrsService ----------

const ok = (stdout: string, stderr = ''): CliResult => ({ code: 0, stdout, stderr, missing: false });
const fail = (code: number, stderr: string): CliResult => ({ code, stdout: '', stderr, missing: false });
const GLAB_STATUS = 'git.corp\n  ✓ Logged in to git.corp as mmx003 (/x)\n';
const BOTH: TrackerSettings = { github: true, gitlab: true };
const project: Project = { id: 'p1', name: 'P', description: '', repos: ['/w/a', '/w/b'], trackers: BOTH };
const other: Project = { id: 'p2', name: 'Q', description: '', repos: ['/w/other'], trackers: BOTH };

interface Call { cmd: string; args: string[] }

function setup(opts: { remotes: Record<string, string[]>; settings?: TrackerSettings; otherSettings?: TrackerSettings; respond: (c: Call) => CliResult | undefined; user?: CliResult | (() => CliResult | Promise<CliResult>); slow?: boolean; hold?: (c: Call) => Promise<void> | undefined }) {
  const calls: Call[] = [];
  const load = { now: 0, peak: 0 };
  const run = async (cmd: 'gh' | 'glab', args: string[]): Promise<CliResult> => {
    const call = { cmd, args };
    calls.push(call);
    if (cmd === 'glab' && args[0] === 'auth') return ok('', GLAB_STATUS);
    if (cmd === 'gh' && args.includes('user')) return (typeof opts.user === 'function' ? opts.user() : opts.user) ?? ok('MMX\n');
    await opts.hold?.(call);
    if (!opts.slow) return opts.respond(call) ?? ok('');
    load.peak = Math.max(load.peak, ++load.now);
    await new Promise((r) => setTimeout(r, 2));
    load.now--;
    return opts.respond(call) ?? ok('');
  };
  const trackers = new TrackersService({
    run,
    remotes: async (repo) => opts.remotes[repo] ?? [],
    projects: () => ({ projects: [{ ...project, trackers: opts.settings ?? BOTH }, { ...other, trackers: opts.otherSettings ?? BOTH }], lastProjectId: null }),
  });
  return { svc: new MrsService(trackers, run), calls, load };
}

const url = (c: Call) => c.args.at(-1)!;
const ghList = (c: Call) => url(c).startsWith('repos/o/a/pulls?');
const reviews = (...pairs: [string, string][]) => pairs.map(([login, state]) => JSON.stringify({ login, state })).join('\n');

/** Ответы по умолчанию: список из переданных PR, детали - успешный конвейер и один апрув. */
const ghResponder = (prs: object[], extra: (c: Call) => CliResult | undefined = () => undefined) => (c: Call): CliResult | undefined => {
  const custom = extra(c);
  if (custom) return custom;
  const u = url(c);
  if (ghList(c)) return ok(prs.map((p) => JSON.stringify(p)).join('\n'));
  if (u.includes('/check-runs')) return ok('{"status":"completed","conclusion":"success"}');
  if (u.endsWith('/status')) return ok('{"state":"success","total_count":0}');
  if (u.includes('/reviews')) return ok(reviews(['alice', 'APPROVED']));
  return undefined;
};

/** Обе фазы выборки, как их складывает интерфейс: список, детали по номеру, слияние. */
async function full(svc: MrsService, ...args: Parameters<MrsService['listMrs']>): Promise<MrListResult> {
  const list = await svc.listMrs(...args);
  if (list.detailsId === null) return list;
  return applyMrDetails(list, await svc.details(list.detailsId));
}

const gqlCalls = (calls: Call[]) => calls.filter((c) => c.args[3] === 'graphql');
const gqlVar = (c: Call, name: string) => c.args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
const node = (iid: number | string, status: string | null | undefined, by: number, required?: number) => ({
  iid: String(iid),
  ...(status === undefined ? {} : { headPipeline: status === null ? null : { status } }),
  ...(required === undefined ? {} : { approvalsRequired: required }),
  approvedBy: { nodes: Array.from({ length: by }, (_, i) => ({ username: `u${i}` })) },
});
const page = (nodes: object[], next: string | null = null) =>
  JSON.stringify({ data: { project: { mergeRequests: { pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes } } } });
const undefinedField = JSON.stringify({ errors: [{ message: "Field 'approvalsRequired' doesn't exist on type 'MergeRequest'", extensions: { code: 'undefinedField', typeName: 'MergeRequest', fieldName: 'approvalsRequired' } }] });
const glRemotes = { '/w/a': ['git@git.corp:g/p.git'] };
const glList = (n: number) => ok(JSON.stringify(Array.from({ length: n }, (_, i) => ({ iid: i + 1, title: 't', author: { username: 'bob' }, source_branch: 's', target_branch: 'main' }))));
const glab = (graphql: (c: Call) => CliResult, list: CliResult = glList(3)) => (c: Call): CliResult | undefined =>
  c.args[3] === 'graphql' ? graphql(c) : c.args.at(-1)!.includes('merge_requests?') ? list : undefined;

describe('MrsService.listMrs', () => {
  const remotes = { '/w/a': ['git@github.com:o/a.git'] };

  it('список: --paginate, state=open, черновики входят, строка с пайплайном и апрувами', async () => {
    const { svc, calls } = setup({ remotes, respond: ghResponder([ghRaw(1), ghRaw(2, { draft: true })]) });
    const r = await full(svc, 'p1', 'all', []);
    const list = calls.find(ghList)!;
    assert.ok(list.args.includes('--paginate'));
    assert.ok(url(list).startsWith('repos/o/a/pulls?state=open&per_page=100'));
    assert.deepEqual(r.mrs.map((m) => [m.number, m.draft, m.pipeline, m.approvals]), [[1, false, 'успешен', 'апрувов: 1'], [2, true, 'успешен', 'апрувов: 1']]);
  });

  it('GitLab: список и один graphql на источник; пайплайн и «N из M» из ответа', async () => {
    const { svc, calls } = setup({ remotes: glRemotes, respond: glab(() => ok(page([node(1, 'MANUAL', 2, 3), node(2, null, 1), node(3, 'SUCCESS', 0)]))) });
    const r = await full(svc, 'p1', 'all', []);
    assert.equal(calls.filter((c) => c.cmd === 'glab' && c.args[0] === 'api').length, 2);
    assert.equal(gqlCalls(calls).length, 1);
    assert.equal(calls.filter((c) => c.args.at(-1)!.includes('/approvals') || /merge_requests\/\d+$/.test(c.args.at(-1)!)).length, 0);
    assert.deepEqual(r.mrs.map((m) => [m.number, m.pipeline, m.approvals]), [[1, 'manual', 'апрувов: 2 из 3'], [2, 'нет пайплайна', 'апрувов: 1'], [3, 'успешен', 'апрувов: 0']]);
  });

  it('GitLab: «Доработать» своему MR - по нерешённым тредам; треды запрашиваются только по своим MR', async () => {
    const list = ok(JSON.stringify([1, 2, 3].map((iid) => ({ iid, title: 't', author: { username: iid === 3 ? 'bob' : 'mmx003' }, user_notes_count: 2 }))));
    const thread = (resolved: boolean) => ({ resolvable: true, resolved });
    const threads = JSON.stringify({ data: { project: { mergeRequests: { nodes: [
      { iid: '1', discussions: { nodes: [{ resolvable: false, resolved: false }, thread(true)] } },
      { iid: '2', discussions: { nodes: [thread(true), thread(false)] } },
    ] } } } });
    const { svc, calls } = setup({ remotes: glRemotes, respond: glab((c) => ok(gqlVar(c, 'author') ? threads : page([node(1, 'SUCCESS', 0), node(2, 'SUCCESS', 0), node(3, 'SUCCESS', 0)])), list) });
    const r = await full(svc, 'p1', 'all', []);
    assert.deepEqual(r.mrs.map((m) => [m.number, m.comments]), [[1, false], [2, true], [3, null]]);
    assert.deepEqual(gqlCalls(calls).map((c) => gqlVar(c, 'author')), [undefined, 'mmx003']);
  });

  it('пайплайн GraphQL теми же словами, что REST: регистр, null, неизвестный статус строкой', async () => {
    const statuses = ['SUCCESS', 'FAILED', 'RUNNING', 'PENDING', 'CANCELED', 'MANUAL', null];
    const { svc } = setup({ remotes: glRemotes, respond: glab(() => ok(page(statuses.map((st, i) => node(i + 1, st, 0)))), glList(7)) });
    const r = await full(svc, 'p1', 'all', []);
    assert.deepEqual(r.mrs.map((m) => m.pipeline), ['успешен', 'упал', 'идёт', 'ожидает', 'отменён', 'manual', 'нет пайплайна']);
  });

  it('без поля правил апрува: «апрувов: N»; статус не строка и отсутствие headPipeline - «—»', async () => {
    const { svc } = setup({ remotes: glRemotes, respond: glab(() => ok(page([node(1, 'SUCCESS', 1), { ...node(2, undefined, 0), headPipeline: { status: 5 } }, node(3, undefined, 0)]))) });
    const r = await full(svc, 'p1', 'all', []);
    assert.deepEqual(r.mrs.map((m) => [m.pipeline, m.approvals]), [['успешен', 'апрувов: 1'], [null, 'апрувов: 0'], [null, 'апрувов: 0']]);
  });

  it('список возвращается до деталей: «—» не подставляется, ожидаемые ключи названы, details отдаёт значения один раз', async () => {
    let release!: (r: CliResult) => void;
    const held = new Promise<CliResult>((r) => (release = r));
    const { svc } = setup({ remotes: glRemotes, respond: glab(() => held as unknown as CliResult, glList(2)) });
    const list = await svc.listMrs('p1', 'all', []);
    assert.deepEqual(list.mrs.map((m) => m.pipeline), [null, null]);
    assert.deepEqual(list.awaiting, list.mrs.map((m) => m.key));
    assert.notEqual(list.detailsId, null);
    release(ok(page([node(1, 'FAILED', 1), node(2, 'RUNNING', 0)])));
    const d = await svc.details(list.detailsId!);
    assert.deepEqual(d!.details.map((x) => [x.key, x.pipeline, x.approvals]), [[list.awaiting[0], 'упал', 'апрувов: 1'], [list.awaiting[1], 'идёт', 'апрувов: 0']]);
    assert.equal(await svc.details(list.detailsId!), null);
  });

  it('вытеснение: восьми выборок хватает, девятая вытесняет первую', async () => {
    const { svc } = setup({ remotes: glRemotes, respond: glab(() => ok(page([node(1, 'SUCCESS', 0)])), glList(1)) });
    const ids: number[] = [];
    for (let i = 0; i < 9; i++) ids.push((await svc.listMrs('p1', 'all', [])).detailsId!);
    assert.equal(await svc.details(ids[0]), null);
    assert.notEqual(await svc.details(ids[1]), null);
    assert.equal(await svc.details(999), null);
  });

  it('нет MR к ожиданию - detailsId пуст, «…» не нужен', async () => {
    const { svc } = setup({ remotes: glRemotes, respond: glab(() => ok(page([])), ok('[]')) });
    const r = await svc.listMrs('p1', 'all', []);
    assert.deepEqual([r.detailsId, r.awaiting], [null, []]);
  });

  it('страницы по курсору: второй вызов несёт курсор первой, детали у обеих; предел 200 не действует', async () => {
    const nodes = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => node(from + i, 'SUCCESS', 1));
    const pages = [page(nodes(1, 101), 'c1'), page(nodes(101, 201), 'c2'), page(nodes(201, 206))];
    const { svc, calls } = setup({ remotes: glRemotes, respond: glab(() => ok(pages[gqlCalls(calls).length - 1]), glList(205)) });
    const r = await full(svc, 'p1', 'all', []);
    const gql = gqlCalls(calls);
    assert.deepEqual(gql.map((c) => gqlVar(c, 'endCursor')), [undefined, 'c1', 'c2']);
    assert.equal(r.mrs.length, 205);
    assert.ok(r.mrs.every((m) => m.pipeline === 'успешен' && m.approvals === 'апрувов: 1'));
  });

  it('повторный или пустой курсор останавливает обход', async () => {
    for (const next of ['c1', '']) {
      const { svc, calls } = setup({ remotes: glRemotes, respond: glab(() => ok(page([node(1, 'SUCCESS', 0)], next)), glList(1)) });
      const r = await full(svc, 'p1', 'all', []);
      assert.equal(gqlCalls(calls).length, next ? 2 : 1);
      assert.equal(r.mrs[0].pipeline, 'успешен');
    }
  });

  it('отказ второй страницы: детали первой остаются, у остальных «—», источник без ошибки', async () => {
    const { svc } = setup({
      remotes: glRemotes,
      respond: glab((c) => (gqlVar(c, 'endCursor') ? fail(1, 'glab: boom') : ok(page([node(1, 'SUCCESS', 1)], 'c1'))), glList(2)),
    });
    const r = await full(svc, 'p1', 'all', []);
    assert.deepEqual(r.mrs.map((m) => m.pipeline), ['успешен', null]);
    assert.equal(r.sources.find((s) => s.path)!.error, undefined);
  });

  it('отказ graphql целиком (код выхода, HTTP 4xx, errors без data, мусор): «—» в деталях, строки остаются, повтора нет', async () => {
    const cases: CliResult[] = [
      fail(1, 'glab: boom'),
      ok('{"message":"401 Unauthorized"}', 'HTTP 401'),
      ok('{"errors":[{"message":"timeout"}]}'),
      ok('<html>'),
      ok(JSON.stringify({ errors: [{ message: 'x', extensions: { code: 'undefinedField', fieldName: 'other' } }] })),
    ];
    for (const res of cases) {
      const { svc, calls } = setup({ remotes: glRemotes, respond: glab(() => res) });
      const r = await full(svc, 'p1', 'all', []);
      assert.equal(r.mrs.length, 3);
      assert.ok(r.mrs.every((m) => m.pipeline === null && m.approvals === null));
      assert.equal(r.sources.find((s) => s.path)!.error, undefined);
      assert.equal(gqlCalls(calls).length, 1);
    }
  });

  it('MR вне ответа и project: null - «—», источник не отказывает', async () => {
    const { svc } = setup({ remotes: glRemotes, respond: glab(() => ok(page([node(1, 'SUCCESS', 0), node('x', 'SUCCESS', 0), node(0, 'SUCCESS', 0)])), glList(2)) });
    const r = await full(svc, 'p1', 'all', []);
    assert.deepEqual(r.mrs.map((m) => m.pipeline), ['успешен', null]);
    const none = setup({ remotes: glRemotes, respond: glab(() => ok('{"data":{"project":null}}'), glList(2)) });
    const n = await full(none.svc, 'p1', 'all', []);
    assert.deepEqual(n.mrs.map((m) => [m.pipeline, m.approvals]), [[null, null], [null, null]]);
    assert.equal(n.sources.find((s) => s.path)!.error, undefined);
  });

  it('хост без полей правил: первый запрос повторяется без них, хост запоминается и на «Обновить», и на сброс входа', async () => {
    const { svc, calls } = setup({
      remotes: glRemotes,
      respond: glab((c) => (gqlVar(c, 'query')!.includes('approvalsRequired') ? ok(undefinedField) : ok(page([node(1, 'SUCCESS', 2), node(2, 'SUCCESS', 0), node(3, 'SUCCESS', 1)])))),
    });
    const first = await full(svc, 'p1', 'all', []);
    assert.equal(gqlCalls(calls).length, 2);
    assert.deepEqual(first.mrs.map((m) => m.approvals), ['апрувов: 2', 'апрувов: 0', 'апрувов: 1']);
    await full(svc, 'p1', 'all', [], true);
    assert.equal(gqlCalls(calls).length, 3);
    assert.ok(!gqlVar(gqlCalls(calls)[2], 'query')!.includes('approvalsRequired'));
  });

  it('хост без полей правил: ошибка валидации с кодом выхода не 0 и телом в stdout тоже запоминает хост', async () => {
    for (const rejected of [{ code: 1, stdout: undefinedField, stderr: '', missing: false }, { code: 1, stdout: undefinedField, stderr: 'HTTP 400', missing: false }] as CliResult[]) {
      const { svc, calls } = setup({
        remotes: glRemotes,
        respond: glab((c) => (gqlVar(c, 'query')!.includes('approvalsRequired') ? rejected : ok(page([node(1, 'SUCCESS', 2), node(2, 'SUCCESS', 0), node(3, 'SUCCESS', 1)])))),
      });
      const first = await full(svc, 'p1', 'all', []);
      assert.deepEqual(first.mrs.map((m) => m.approvals), ['апрувов: 2', 'апрувов: 0', 'апрувов: 1']);
      await full(svc, 'p1', 'all', []);
      assert.equal(gqlCalls(calls).length, 3);
    }
  });

  it('GraphQL только читает: query - одна из двух постоянных строк без mutation, курсор из ответа - значение переменной -f, а не текст запроса', async () => {
    const { svc, calls } = setup({
      remotes: glRemotes,
      respond: glab((c) => (gqlVar(c, 'endCursor') ? ok(page([node(2, 'SUCCESS', 0)])) : ok(page([node(1, 'SUCCESS', 0)], 'c"1}'))), glList(2)),
    });
    await full(svc, 'p1', 'all', []);
    const gql = gqlCalls(calls);
    assert.equal(gql.length, 2);
    const queries = new Set<string>();
    for (const c of gql) {
      assert.deepEqual(c.args.slice(0, 4), ['api', '--hostname', 'git.corp', 'graphql']);
      const rest = c.args.slice(4);
      assert.ok(rest.length % 2 === 0 && rest.filter((_, i) => i % 2 === 0).every((f) => f === '-f'), c.args.join(' '));
      queries.add(gqlVar(c, 'query')!);
      assert.ok(!/\bmutation\b/i.test(gqlVar(c, 'query')!));
      assert.ok(!gqlVar(c, 'query')!.includes('g/p'));
    }
    assert.equal(queries.size, 1);
    assert.equal(gqlVar(gql[0], 'fullPath'), 'g/p');
    assert.equal(gqlVar(gql[1], 'endCursor'), 'c"1}');
  });

  it('отказ списка GitHub не мешает деталям GitLab', async () => {
    const { svc, calls } = setup({
      remotes: { '/w/a': ['git@github.com:o/a.git', 'git@git.corp:g/p.git'] },
      respond: (c) => (c.cmd === 'gh' ? (ghList(c) ? fail(1, 'gh: boom') : undefined) : glab(() => ok(page([node(1, 'SUCCESS', 0)])), glList(1))(c)),
    });
    const r = await full(svc, 'p1', 'all', []);
    assert.deepEqual(r.mrs.map((m) => m.pipeline), ['успешен']);
    assert.equal(gqlCalls(calls).length, 1);
  });

  it('отказ второй страницы, таймаут и переполнение - отказ источника целиком, MR источника нет', async () => {
    const cases: [CliResult, RegExp][] = [
      [ok('{"number":1}\n{"number":2', ''), /не разобран/],
      [{ code: null, stdout: '', stderr: '', missing: false, failure: 'timeout' }, /120 с/],
      [{ code: null, stdout: '', stderr: '', missing: false, failure: 'overflow' }, /64 МБ/],
      [fail(1, 'gh: Gone (HTTP 410)'), /410/],
    ];
    for (const [res, re] of cases) {
      const { svc } = setup({ remotes, respond: (c) => (ghList(c) ? res : undefined) });
      const r = await full(svc, 'p1', 'all', []);
      assert.deepEqual(r.mrs, []);
      assert.match(r.sources.find((s) => s.path)!.error!, re);
    }
  });

  it('отказ одного источника не прячет MR другого', async () => {
    const { svc } = setup({
      remotes: { '/w/a': ['git@github.com:o/a.git', 'git@git.corp:g/p.git'] },
      respond: (c) => {
        if (c.cmd === 'gh') return ghList(c) ? fail(1, 'gh: boom') : undefined;
        return c.args[3] === 'graphql' ? ok(page([node(4, null, 0)])) : ok('[{"iid":4}]');
      },
    });
    const r = await full(svc, 'p1', 'all', []);
    assert.deepEqual(r.mrs.map((m) => m.number), [4]);
    assert.equal(r.sources.find((s) => s.kind === 'github')!.error, 'gh: boom');
  });

  it('отказ деталей одного MR даёт «—» только в своём поле, строка остаётся', async () => {
    const { svc } = setup({ remotes, respond: ghResponder([ghRaw(1)], (c) => (url(c).includes('/reviews') ? fail(1, 'gh: HTTP 403') : undefined)) });
    const m = (await full(svc, 'p1', 'all', [])).mrs[0];
    assert.deepEqual([m.pipeline, m.approvals], ['успешен', null]);
    const b = setup({ remotes, respond: ghResponder([ghRaw(1)], (c) => (url(c).includes('/check-runs') ? fail(1, 'x') : undefined)) });
    const n = (await full(b.svc, 'p1', 'all', [])).mrs[0];
    assert.deepEqual([n.pipeline, n.approvals], [null, 'апрувов: 1']);
  });

  it('головной коммит не hex - пайплайн «—» без вызова CLI', async () => {
    const { svc, calls } = setup({ remotes, respond: ghResponder([ghRaw(1, { head_sha: '../x' })]) });
    const m = (await full(svc, 'p1', 'all', [])).mrs[0];
    assert.equal(m.pipeline, null);
    assert.ok(!calls.some((c) => url(c).includes('/commits/')));
  });

  it('фильтры: «Назначено мне» и «Я ревьюер» по логину gh; детали только прошедшим', async () => {
    const prs = [ghRaw(1, { assignees: ['mmx'] }), ghRaw(2, { reviewers: ['MMX'] }), ghRaw(3)];
    const a = setup({ remotes, respond: ghResponder(prs) });
    assert.deepEqual((await full(a.svc, 'p1', 'assigned', [])).mrs.map((m) => m.number), [1]);
    assert.ok(!a.calls.some((c) => url(c).includes('/pulls/2/') || url(c).includes('/pulls/3/')));
    const r = setup({ remotes, respond: ghResponder(prs) });
    assert.deepEqual((await full(r.svc, 'p1', 'review', [])).mrs.map((m) => m.number), [2]);
  });

  it('логин не получен: с фильтром - ошибка источника без MR, без фильтра - список с «Ревью»', async () => {
    const user = fail(4, 'gh auth login');
    const f = setup({ remotes, user, respond: ghResponder([ghRaw(1, { assignees: ['mmx'] })]) });
    const r = await full(f.svc, 'p1', 'assigned', []);
    assert.deepEqual(r.mrs, []);
    assert.equal(r.sources.find((s) => s.path)!.error, 'gh не залогинен');
    assert.ok(!f.calls.some(ghList));
    const all = setup({ remotes, user, respond: ghResponder([ghRaw(1, { user: 'mmx' })]) });
    assert.deepEqual((await full(all.svc, 'p1', 'all', [])).mrs.map((m) => m.own), [false]);
  });

  it('own: автор - пользователь хоста', async () => {
    const { svc } = setup({ remotes, respond: ghResponder([ghRaw(1, { user: 'mmx' }), ghRaw(2)]) });
    assert.deepEqual((await full(svc, 'p1', 'all', [])).mrs.map((m) => m.own), [true, false]);
  });

  it('только remote своего проекта; MR через два репозитория - одна строка с двумя repos', async () => {
    const { svc, calls } = setup({
      remotes: { '/w/a': ['git@github.com:o/a.git'], '/w/b': ['https://github.com/O/A.git'], '/w/other': ['git@github.com:x/other.git'] },
      respond: ghResponder([ghRaw(1)]),
    });
    const r = await full(svc, 'p1', 'all', []);
    assert.equal(r.mrs.length, 1);
    assert.deepEqual(r.mrs[0].repos, ['/w/a', '/w/b']);
    assert.ok(!calls.some((c) => url(c).includes('x/other')));
  });

  it('выключенный источник не опрашивается; оба выключены - ни одного вызова', async () => {
    const one = setup({ remotes, settings: { github: false, gitlab: true }, respond: () => undefined });
    await full(one.svc, 'p1', 'all', []);
    assert.equal(one.calls.filter((c) => c.cmd === 'gh').length, 0);
    const none = setup({ remotes, settings: { github: false, gitlab: false }, respond: () => undefined });
    const r = await full(none.svc, 'p1', 'all', []);
    assert.equal(none.calls.length, 0);
    assert.deepEqual(r.enabled, { github: false, gitlab: false });
  });

  it('у второго проекта другие источники: MR выбранного проекта идут по его галочкам', async () => {
    const { svc, calls } = setup({ remotes, settings: { github: false, gitlab: true }, otherSettings: { github: true, gitlab: false }, respond: () => undefined });
    const r = await full(svc, 'p1', 'all', []);
    assert.deepEqual(r.enabled, { github: false, gitlab: true });
    assert.equal(calls.filter((c) => c.cmd === 'gh').length, 0);
  });

  it('неизвестный проект - ошибка без вызовов', async () => {
    const { svc, calls } = setup({ remotes, respond: () => undefined });
    assert.equal((await full(svc, 'nope', 'all', [])).error, 'Проект не найден');
    assert.equal(calls.length, 0);
  });

  it('tracked: MR вне списка запрашивается одиночным вызовом, влитый и пайплайн по последнему коммиту; дубль списка, чужой источник и упавший источник - нет', async () => {
    const tracked = [
      { kind: 'github' as const, host: 'github.com', path: 'o/a', number: 99 },
      { kind: 'github' as const, host: 'github.com', path: 'o/a', number: 1 },
      { kind: 'github' as const, host: 'github.com', path: 'x/other', number: 5 },
    ];
    const { svc, calls } = setup({
      remotes,
      respond: ghResponder([ghRaw(1)], (c) => (url(c) === 'repos/o/a/pulls/99' ? ok(JSON.stringify(ghRaw(99, { state: 'closed', merged: true }))) : undefined)),
    });
    const r = await full(svc, 'p1', 'all', tracked);
    assert.deepEqual(r.tracked.map((m) => [m.number, m.state, m.pipeline]), [[99, 'merged', 'успешен']]);
    assert.ok(!calls.some((c) => url(c) === 'repos/o/a/pulls/1' || url(c).includes('x/other')));
    const down = setup({ remotes, respond: (c) => (ghList(c) ? fail(1, 'boom') : undefined) });
    const d = await full(down.svc, 'p1', 'all', [tracked[0]]);
    assert.deepEqual(d.tracked, []);
    assert.ok(!down.calls.some((c) => url(c) === 'repos/o/a/pulls/99'));
  });

  it('процессов gh одновременно не больше пула плюс источники, а не по три на MR', async () => {
    const prs = Array.from({ length: 12 }, (_, i) => ghRaw(i + 1));
    const { svc, load } = setup({ remotes, slow: true, respond: ghResponder(prs) });
    const r = await full(svc, 'p1', 'all', []);
    assert.equal(r.mrs.length, 12);
    assert.ok(load.peak > 1 && load.peak <= MR_CONCURRENCY + 1, `пик ${load.peak}`);
  });

  it('перекрывающиеся выборки во время деталей делят пул: пик процессов не растёт с числом выборок', async () => {
    const prs = Array.from({ length: 12 }, (_, i) => ghRaw(i + 1));
    const { svc, load } = setup({ remotes, slow: true, respond: ghResponder(prs) });
    const lists = [await svc.listMrs('p1', 'all', []), await svc.listMrs('p1', 'all', []), await svc.listMrs('p1', 'all', [])];
    const all = await Promise.all(lists.map((l) => svc.details(l.detailsId!)));
    assert.ok(all.every((d) => d!.details.length === 12));
    assert.ok(load.peak > 1 && load.peak <= MR_CONCURRENCY + 1, `пик ${load.peak}`);
  });

  it('перекрывающиеся выборки GitLab делят один graphql источника в полёте', async () => {
    let release!: (r: CliResult) => void;
    const held = new Promise<CliResult>((r) => (release = r));
    const { svc, calls } = setup({ remotes: glRemotes, respond: glab(() => held as unknown as CliResult, glList(2)) });
    const a = await svc.listMrs('p1', 'all', []);
    const b = await svc.listMrs('p1', 'all', []);
    release(ok(page([node(1, 'SUCCESS', 0), node(2, 'FAILED', 0)])));
    const [da, db] = await Promise.all([svc.details(a.detailsId!), svc.details(b.detailsId!)]);
    assert.equal(gqlCalls(calls).length, 1);
    assert.deepEqual([da!.details.length, db!.details.length], [2, 2]);
  });

  it('«Обновить» во время graphql прежней выборки запускает свой запрос и видит свежий MR', async () => {
    let release!: (r: CliResult) => void;
    const held = new Promise<CliResult>((r) => (release = r));
    let listCalls = 0;
    let gql = 0;
    const { svc, calls } = setup({
      remotes: glRemotes,
      respond: (c) => {
        if (c.args[3] === 'graphql') return ++gql === 1 ? (held as unknown as CliResult) : ok(page([node(1, 'SUCCESS', 0), node(2, 'SUCCESS', 0), node(3, 'FAILED', 1)]));
        return c.args.at(-1)!.includes('merge_requests?') ? glList(++listCalls === 1 ? 2 : 3) : undefined;
      },
    });
    const a = await svc.listMrs('p1', 'all', []);
    const b = await full(svc, 'p1', 'all', [], true);
    assert.equal(gqlCalls(calls).length, 2);
    assert.deepEqual(b.mrs.map((m) => m.pipeline), ['успешен', 'успешен', 'упал']);
    release(ok(page([node(1, 'SUCCESS', 0)])));
    assert.equal((await svc.details(a.detailsId!))!.details.length, 2);
  });

  it('«Обновить» подряд во время graphql: свежий graphql источника один, а не по одному на нажатие', async () => {
    let release!: (r: CliResult) => void;
    const held = new Promise<CliResult>((r) => (release = r));
    const { svc, calls } = setup({ remotes: glRemotes, respond: glab(() => held as unknown as CliResult, glList(2)) });
    const a = await svc.listMrs('p1', 'all', []);
    const b = await svc.listMrs('p1', 'all', [], true);
    const c = await svc.listMrs('p1', 'all', [], true);
    const d = await svc.listMrs('p1', 'all', [], true);
    assert.equal(gqlCalls(calls).length, 2);
    release(ok(page([node(1, 'SUCCESS', 0), node(2, 'FAILED', 0)])));
    const all = await Promise.all([a, b, c, d].map((l) => svc.details(l.detailsId!)));
    assert.ok(all.every((x) => x!.details.length === 2));
  });

  it('«Обновить» во время деталей GitHub: ещё не стартовавшие задачи прежней выборки не выполняются перед новой', async () => {
    const prs = Array.from({ length: 20 }, (_, i) => ghRaw(i + 1));
    const { svc, calls, load } = setup({ remotes, slow: true, respond: ghResponder(prs) });
    const a = await svc.listMrs('p1', 'all', []);
    const b = await svc.listMrs('p1', 'all', [], true);
    const d = await svc.details(b.detailsId!);
    assert.equal(d!.details.length, 20);
    // Прежняя успела лишь то, что стартовало до постановки задач новой; её хвост ждёт за новой (40 - значит хвост шёл впереди).
    const asked = calls.filter((c) => url(c).includes('/reviews')).length;
    assert.ok(asked < 40, `запросов ревью ${asked}: хвост прежней выборки не должен идти перед новой`);
    assert.equal((await svc.details(a.detailsId!))!.details.length, 20);
    assert.ok(load.peak <= MR_CONCURRENCY + 1, `пик ${load.peak}`);
  });

  it('повтор выборки по новой проверке входа не вытесняет выборку, начатую после него: её задача в пуле идёт раньше задач повтора', async () => {
    const prs = Array.from({ length: 20 }, (_, i) => ghRaw(i + 1));
    let users = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let open!: () => void;
    const hold = new Promise<void>((r) => (open = r));
    let reviewsWhenTracked = -1;
    const ref = { kind: 'gitlab' as const, host: 'git.corp', path: 'g/q', number: 8 };
    const { svc, calls } = setup({
      remotes: { '/w/a': ['git@github.com:o/a.git'], '/w/other': ['git@git.corp:g/q.git'] },
      hold: (c) => (url(c).includes('/reviews') ? hold : undefined),
      respond: ghResponder(prs, (c) => {
        if (url(c) === 'projects/g%2Fq/merge_requests/8') {
          reviewsWhenTracked = calls.filter((x) => url(x).includes('/reviews')).length;
          return ok('{"iid":8,"state":"opened","title":"t","author":{"username":"bob"},"source_branch":"s","target_branch":"main"}');
        }
        return url(c).includes('g%2Fq/merge_requests?') ? ok('[]') : undefined;
      }),
      user: async () => {
        if (++users === 2) await gate;
        return ok(users === 1 ? 'A\n' : 'B\n');
      },
    });
    await svc.listMrs('p1', 'all', []);
    const refresh = svc.listMrs('p1', 'all', [], true);
    await new Promise((r) => setTimeout(r, 20));
    const later = await svc.listMrs('p2', 'all', [ref]);
    release();
    await new Promise((r) => setTimeout(r, 20));
    open();
    await svc.details(later.detailsId!);
    await refresh;
    assert.ok(reviewsWhenTracked >= 0 && reviewsWhenTracked < 20, `к запросу MR с сессией начато ревью ${reviewsWhenTracked}: задачи повтора шли перед задачей более поздней выборки`);
  });

  it('повтор уступает более поздней выборке и тогда, когда её список пришёл после постановки задач повтора в пул', async () => {
    const prs = Array.from({ length: 20 }, (_, i) => ghRaw(i + 1));
    let users = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let open!: () => void;
    const hold = new Promise<void>((r) => (open = r));
    let openList!: () => void;
    const holdList = new Promise<void>((r) => (openList = r));
    let reviewsWhenTracked = -1;
    const ref = { kind: 'gitlab' as const, host: 'git.corp', path: 'g/q', number: 8 };
    const { svc, calls } = setup({
      remotes: { '/w/a': ['git@github.com:o/a.git'], '/w/other': ['git@git.corp:g/q.git'] },
      hold: (c) => (url(c).includes('/reviews') ? hold : url(c).includes('g%2Fq/merge_requests?') ? holdList : undefined),
      respond: ghResponder(prs, (c) => {
        if (url(c) === 'projects/g%2Fq/merge_requests/8') {
          reviewsWhenTracked = calls.filter((x) => url(x).includes('/reviews')).length;
          return ok('{"iid":8,"state":"opened","title":"t","author":{"username":"bob"},"source_branch":"s","target_branch":"main"}');
        }
        return url(c).includes('g%2Fq/merge_requests?') ? ok('[]') : undefined;
      }),
      user: async () => {
        if (++users === 2) await gate;
        return ok(users === 1 ? 'A\n' : 'B\n');
      },
    });
    await svc.listMrs('p1', 'all', []);
    const refresh = svc.listMrs('p1', 'all', [], true);
    await new Promise((r) => setTimeout(r, 20));
    const laterP = svc.listMrs('p2', 'all', [ref]);
    release();
    await new Promise((r) => setTimeout(r, 20));
    openList();
    const later = await laterP;
    await new Promise((r) => setTimeout(r, 20));
    open();
    await svc.details(later.detailsId!);
    await refresh;
    assert.ok(reviewsWhenTracked >= 0 && reviewsWhenTracked < 20, `к запросу MR с сессией начато ревью ${reviewsWhenTracked}: задачи повтора шли перед задачей более поздней выборки`);
  });

  it('повтор без более поздней выборки становится текущей: его задачи идут в пуле раньше хвоста отброшенных выборок', async () => {
    const prs = Array.from({ length: 20 }, (_, i) => ghRaw(i + 1));
    let users = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let open!: () => void;
    const hold = new Promise<void>((r) => (open = r));
    const { svc, calls } = setup({
      remotes,
      hold: (c) => (url(c).includes('/reviews') ? hold : undefined),
      respond: ghResponder(prs),
      user: async () => {
        if (++users === 2) await gate;
        return ok(users === 1 ? 'A\n' : 'B\n');
      },
    });
    await svc.listMrs('p1', 'all', []);
    const refresh = svc.listMrs('p1', 'all', [], true);
    await new Promise((r) => setTimeout(r, 20));
    release();
    const list = await refresh;
    open();
    await svc.details(list.detailsId!);
    const started = calls.filter((c) => url(c).includes('/reviews')).length;
    assert.ok(started < 40, `к готовым деталям перестроенной выборки начато ревью ${started}: они ждали хвост отброшенных выборок`);
  });

  it('детали - ровно у 200 самых свежих, у остальных «—»; MR с сессией получает детали и вне двухсотки', async () => {
    const prs = Array.from({ length: 205 }, (_, i) => ghRaw(i + 1, { updated_at: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString() }));
    const asked = (calls: Call[]) => new Set(calls.filter((c) => url(c).includes('/reviews')).map((c) => url(c).match(/pulls\/(\d+)\//)![1]));
    const a = setup({ remotes, respond: ghResponder(prs) });
    const r = await full(a.svc, 'p1', 'all', []);
    const nums = asked(a.calls);
    assert.equal(nums.size, MAX_DETAILED);
    for (const m of r.mrs) assert.deepEqual([m.pipeline !== null, m.approvals !== null, nums.has(String(m.number))], m.number > 5 ? [true, true, true] : [false, false, false]);
    const b = setup({ remotes, respond: ghResponder(prs) });
    const rb = await full(b.svc, 'p1', 'all', [{ kind: 'github', host: 'github.com', path: 'o/a', number: 1 }]);
    assert.notEqual(rb.mrs.find((m) => m.number === 1)!.pipeline, null);
    assert.equal(asked(b.calls).size, MAX_DETAILED + 1);
  });

  it('GitLab tracked: один запрос даёт статус и пайплайн; 404 - MR не возвращается', async () => {
    const ref = { kind: 'gitlab' as const, host: 'git.corp', path: 'g/p', number: 8 };
    const { svc } = setup({
      remotes: { '/w/a': ['git@git.corp:g/p.git'] },
      respond: (c) => (url(c) === 'projects/g%2Fp/merge_requests/8' ? ok('{"iid":8,"state":"merged","head_pipeline":{"status":"failed"}}') : ok('[]')),
    });
    assert.deepEqual((await full(svc, 'p1', 'all', [ref])).tracked.map((m) => [m.state, m.pipeline]), [['merged', 'упал']]);
    const gone = setup({
      remotes: { '/w/a': ['git@git.corp:g/p.git'] },
      respond: (c) => (url(c) === 'projects/g%2Fp/merge_requests/8' ? fail(1, 'glab: 404 Not Found (HTTP 404)') : ok('[]')),
    });
    assert.deepEqual((await full(gone.svc, 'p1', 'all', [ref])).tracked, []);
  });

  it('только читающие вызовы: ни -X, ни --input, ни токена; graphql - только постоянные запросы через -f', async () => {
    const { svc, calls } = setup({
      remotes: { '/w/a': ['git@github.com:o/a.git', 'git@git.corp:g/p.git'] },
      respond: (c) => (c.cmd === 'gh' ? ghResponder([ghRaw(1)])(c) : glab(() => ok(page([node(1, 'SUCCESS', 0)])), glList(1))(c)),
    });
    await full(svc, 'p1', 'all', [{ kind: 'github', host: 'github.com', path: 'o/a', number: 77 }, { kind: 'gitlab', host: 'git.corp', path: 'g/p', number: 78 }]);
    assert.ok(calls.length > 5);
    assert.equal(gqlCalls(calls).length, 1);
    for (const { cmd, args } of calls) {
      assert.ok(args[0] === 'api' || (cmd === 'glab' && args[0] === 'auth' && args[1] === 'status'), args.join(' '));
      assert.ok(!args.some((a) => /^(-X|--method|-F|--raw-field|--field|--input|--show-token|-t)$/.test(a)), args.join(' '));
      assert.ok(args.includes('-f') === (args[3] === 'graphql'), args.join(' '));
      assert.ok(!(args[0] === 'auth' && args[1] === 'token'));
      const host = args[args.indexOf('--hostname') + 1];
      if (args.includes('--hostname')) assert.ok(host === 'github.com' || host === 'git.corp', host);
    }
  });

  it('GitHub: пул деталей и MR с сессией общий, а список приходит раньше деталей', async () => {
    const { svc } = setup({ remotes, respond: ghResponder([ghRaw(1)]) });
    const list = await svc.listMrs('p1', 'all', []);
    assert.deepEqual([list.mrs[0].pipeline, list.mrs[0].approvals, list.awaiting], [null, null, [list.mrs[0].key]]);
    assert.deepEqual((await svc.details(list.detailsId!))!.details, [{ key: list.mrs[0].key, pipeline: 'успешен', approvals: 'апрувов: 1', comments: false }]);
  });
});

describe('TrackersService: кэш проверки входа', () => {
  const statusCalls = (calls: Call[]) => calls.filter((c) => c.cmd === 'glab' && c.args[0] === 'auth').length;
  const userCalls = (calls: Call[]) => calls.filter((c) => c.cmd === 'gh' && c.args.includes('user')).length;
  const remotes = { '/w/a': ['git@github.com:o/a.git', 'git@git.corp:g/p.git'] };
  const respond = (c: Call) => (c.cmd === 'gh' ? ghResponder([ghRaw(1, { user: 'mmx' })])(c) : glab(() => ok(page([node(1, 'SUCCESS', 0)])), glList(1))(c));

  it('второе обновление задач и MR не зовёт auth status и api user; recheck зовёт снова', async () => {
    const { svc, calls } = setup({ remotes, respond });
    await full(svc, 'p1', 'assigned', []);
    await full(svc, 'p1', 'all', []);
    await full(svc, 'p1', 'assigned', []);
    assert.deepEqual([statusCalls(calls), userCalls(calls)], [1, 1]);
    await full(svc, 'p1', 'assigned', [], true);
    assert.deepEqual([statusCalls(calls), userCalls(calls)], [2, 2]);
  });
});
