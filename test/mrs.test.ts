import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { claudeArgs } from '../src/main/claude-args';
import {
  approvalsText,
  filterMrs,
  githubApprovals,
  githubPipeline,
  gitlabPipeline,
  MAX_DETAILED,
  MR_CONCURRENCY,
  mrKey,
  mrPrompt,
  mrUrl,
  parseMr,
  runLimited,
  toMr,
  validateMrListArgs,
  validateSessionStart,
  type ParsedMr,
} from '../src/main/mrs';
import { MrsService } from '../src/main/mrs-service';
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

describe('filterMrs', () => {
  const item = (n: number, assignees: string[], reviewers: string[]): ParsedMr => {
    const p = parseMr(gh, ghRaw(n, { assignees, reviewers }), undefined)!;
    return p;
  };
  const items = [item(1, ['mmx'], []), item(2, [], ['MMX']), item(3, [], [])];
  it('каждое значение даёт свой набор; регистр не важен', () => {
    assert.deepEqual(filterMrs(items, 'all', 'x').map((i) => i.mr.number), [1, 2, 3]);
    assert.deepEqual(filterMrs(items, 'assigned', 'MMX').map((i) => i.mr.number), [1]);
    assert.deepEqual(filterMrs(items, 'review', 'mmx').map((i) => i.mr.number), [2]);
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
    assert.deepEqual(claudeArgs(['/b'], '/dex-auto:auto review URL'), ['/dex-auto:auto review URL', '--add-dir', '/b']);
  });
});

describe('validateMrListArgs', () => {
  const ref = { kind: 'github', host: 'github.com', path: 'o/r', number: 5 };
  it('принимает корректные аргументы', () => {
    assert.ok(validateMrListArgs('p', 'review', [ref]));
    assert.ok(validateMrListArgs('p', 'all', Array(200).fill(ref)));
  });
  it('отвергает фильтр вне трёх значений, не массив, больше 200, плохие ссылки', () => {
    assert.equal(validateMrListArgs('p', 'mine', []), null);
    assert.equal(validateMrListArgs('p', true, []), null);
    assert.equal(validateMrListArgs(1, 'all', []), null);
    assert.equal(validateMrListArgs('p', 'all', 'x'), null);
    assert.equal(validateMrListArgs('p', 'all', Array(201).fill(ref)), null);
    for (const bad of [{ ...ref, number: 0 }, { ...ref, number: 2 ** 31 + 1 }, { ...ref, number: 1.5 }, { ...ref, path: 'o/..' }, { ...ref, host: 'evil.com' }]) {
      assert.equal(validateMrListArgs('p', 'all', [bad]), null);
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
  it('пустой список - пул не стартует', async () => {
    assert.deepEqual(await runLimited([], 6), []);
  });
});

// ---------- MrsService ----------

const ok = (stdout: string, stderr = ''): CliResult => ({ code: 0, stdout, stderr, missing: false });
const fail = (code: number, stderr: string): CliResult => ({ code, stdout: '', stderr, missing: false });
const GLAB_STATUS = 'git.corp\n  ✓ Logged in to git.corp as mmx003 (/x)\n';
const project: Project = { id: 'p1', name: 'P', description: '', repos: ['/w/a', '/w/b'] };
const other: Project = { id: 'p2', name: 'Q', description: '', repos: ['/w/other'] };

interface Call { cmd: string; args: string[] }

function setup(opts: { remotes: Record<string, string[]>; settings?: TrackerSettings; respond: (c: Call) => CliResult | undefined; user?: CliResult; slow?: boolean }) {
  const calls: Call[] = [];
  const load = { now: 0, peak: 0 };
  const run = async (cmd: 'gh' | 'glab', args: string[]): Promise<CliResult> => {
    const call = { cmd, args };
    calls.push(call);
    if (cmd === 'glab' && args[0] === 'auth') return ok('', GLAB_STATUS);
    if (cmd === 'gh' && args.includes('user')) return opts.user ?? ok('MMX\n');
    if (!opts.slow) return opts.respond(call) ?? ok('');
    load.peak = Math.max(load.peak, ++load.now);
    await new Promise((r) => setTimeout(r, 2));
    load.now--;
    return opts.respond(call) ?? ok('');
  };
  const trackers = new TrackersService({
    run,
    remotes: async (repo) => opts.remotes[repo] ?? [],
    projects: () => ({ projects: [project, other], lastProjectId: null }),
    settings: () => opts.settings ?? { github: true, gitlab: true },
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

describe('MrsService.listMrs', () => {
  const remotes = { '/w/a': ['git@github.com:o/a.git'] };

  it('список: --paginate, state=open, черновики входят, строка с пайплайном и апрувами', async () => {
    const { svc, calls } = setup({ remotes, respond: ghResponder([ghRaw(1), ghRaw(2, { draft: true })]) });
    const r = await svc.listMrs('p1', 'all', []);
    const list = calls.find(ghList)!;
    assert.ok(list.args.includes('--paginate'));
    assert.ok(url(list).startsWith('repos/o/a/pulls?state=open&per_page=100'));
    assert.deepEqual(r.mrs.map((m) => [m.number, m.draft, m.pipeline, m.approvals]), [[1, false, 'успешен', 'апрувов: 1'], [2, true, 'успешен', 'апрувов: 1']]);
  });

  it('склеенные страницы glab дают все MR; пайплайн и «N из M»', async () => {
    const page = (from: number, to: number) => JSON.stringify(Array.from({ length: to - from }, (_, i) => ({ iid: from + i, title: 't', author: { username: 'bob' }, source_branch: 's', target_branch: 'main' })));
    const { svc } = setup({
      remotes: { '/w/a': ['git@git.corp:g/p.git'] },
      respond: (c) => {
        const u = url(c);
        if (u.includes('merge_requests?state=opened&per_page=100')) return ok(page(1, 101) + page(101, 151));
        if (u.endsWith('/approvals')) return ok('{"approved_by":[{},{}],"approvals_required":3}');
        if (/merge_requests\/\d+$/.test(u)) return ok('{"head_pipeline":{"status":"manual"}}');
        return undefined;
      },
    });
    const r = await svc.listMrs('p1', 'all', []);
    assert.equal(r.mrs.length, 150);
    assert.deepEqual([r.mrs[0].pipeline, r.mrs[0].approvals], ['manual', 'апрувов: 2 из 3']);
  });

  it('GitLab CE без approvals_required и без пайплайна', async () => {
    const { svc } = setup({
      remotes: { '/w/a': ['git@git.corp:g/p.git'] },
      respond: (c) => {
        const u = url(c);
        if (u.includes('merge_requests?')) return ok('[{"iid":1}]');
        if (u.endsWith('/approvals')) return ok('{"approved_by":[{}]}');
        if (u.endsWith('/merge_requests/1')) return ok('{"iid":1,"head_pipeline":null}');
        return undefined;
      },
    });
    const m = (await svc.listMrs('p1', 'all', [])).mrs[0];
    assert.deepEqual([m.pipeline, m.approvals], ['нет пайплайна', 'апрувов: 1']);
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
      const r = await svc.listMrs('p1', 'all', []);
      assert.deepEqual(r.mrs, []);
      assert.match(r.sources.find((s) => s.path)!.error!, re);
    }
  });

  it('отказ одного источника не прячет MR другого', async () => {
    const { svc } = setup({
      remotes: { '/w/a': ['git@github.com:o/a.git', 'git@git.corp:g/p.git'] },
      respond: (c) => {
        if (c.cmd === 'gh') return ghList(c) ? fail(1, 'gh: boom') : undefined;
        const u = url(c);
        return u.includes('merge_requests?') ? ok('[{"iid":4}]') : u.endsWith('/approvals') ? ok('{"approved_by":[]}') : ok('{"head_pipeline":null}');
      },
    });
    const r = await svc.listMrs('p1', 'all', []);
    assert.deepEqual(r.mrs.map((m) => m.number), [4]);
    assert.equal(r.sources.find((s) => s.kind === 'github')!.error, 'gh: boom');
  });

  it('отказ деталей одного MR даёт «—» только в своём поле, строка остаётся', async () => {
    const { svc } = setup({ remotes, respond: ghResponder([ghRaw(1)], (c) => (url(c).includes('/reviews') ? fail(1, 'gh: HTTP 403') : undefined)) });
    const m = (await svc.listMrs('p1', 'all', [])).mrs[0];
    assert.deepEqual([m.pipeline, m.approvals], ['успешен', null]);
    const b = setup({ remotes, respond: ghResponder([ghRaw(1)], (c) => (url(c).includes('/check-runs') ? fail(1, 'x') : undefined)) });
    const n = (await b.svc.listMrs('p1', 'all', [])).mrs[0];
    assert.deepEqual([n.pipeline, n.approvals], [null, 'апрувов: 1']);
  });

  it('головной коммит не hex - пайплайн «—» без вызова CLI', async () => {
    const { svc, calls } = setup({ remotes, respond: ghResponder([ghRaw(1, { head_sha: '../x' })]) });
    const m = (await svc.listMrs('p1', 'all', [])).mrs[0];
    assert.equal(m.pipeline, null);
    assert.ok(!calls.some((c) => url(c).includes('/commits/')));
  });

  it('фильтры: «Назначено мне» и «Я ревьюер» по логину gh; детали только прошедшим', async () => {
    const prs = [ghRaw(1, { assignees: ['mmx'] }), ghRaw(2, { reviewers: ['MMX'] }), ghRaw(3)];
    const a = setup({ remotes, respond: ghResponder(prs) });
    assert.deepEqual((await a.svc.listMrs('p1', 'assigned', [])).mrs.map((m) => m.number), [1]);
    assert.ok(!a.calls.some((c) => url(c).includes('/pulls/2/') || url(c).includes('/pulls/3/')));
    const r = setup({ remotes, respond: ghResponder(prs) });
    assert.deepEqual((await r.svc.listMrs('p1', 'review', [])).mrs.map((m) => m.number), [2]);
  });

  it('логин не получен: с фильтром - ошибка источника без MR, без фильтра - список с «Ревью»', async () => {
    const user = fail(4, 'gh auth login');
    const f = setup({ remotes, user, respond: ghResponder([ghRaw(1, { assignees: ['mmx'] })]) });
    const r = await f.svc.listMrs('p1', 'assigned', []);
    assert.deepEqual(r.mrs, []);
    assert.equal(r.sources.find((s) => s.path)!.error, 'gh не залогинен');
    assert.ok(!f.calls.some(ghList));
    const all = setup({ remotes, user, respond: ghResponder([ghRaw(1, { user: 'mmx' })]) });
    assert.deepEqual((await all.svc.listMrs('p1', 'all', [])).mrs.map((m) => m.own), [false]);
  });

  it('own: автор - пользователь хоста', async () => {
    const { svc } = setup({ remotes, respond: ghResponder([ghRaw(1, { user: 'mmx' }), ghRaw(2)]) });
    assert.deepEqual((await svc.listMrs('p1', 'all', [])).mrs.map((m) => m.own), [true, false]);
  });

  it('только remote своего проекта; MR через два репозитория - одна строка с двумя repos', async () => {
    const { svc, calls } = setup({
      remotes: { '/w/a': ['git@github.com:o/a.git'], '/w/b': ['https://github.com/O/A.git'], '/w/other': ['git@github.com:x/other.git'] },
      respond: ghResponder([ghRaw(1)]),
    });
    const r = await svc.listMrs('p1', 'all', []);
    assert.equal(r.mrs.length, 1);
    assert.deepEqual(r.mrs[0].repos, ['/w/a', '/w/b']);
    assert.ok(!calls.some((c) => url(c).includes('x/other')));
  });

  it('выключенный источник не опрашивается; оба выключены - ни одного вызова', async () => {
    const one = setup({ remotes, settings: { github: false, gitlab: true }, respond: () => undefined });
    await one.svc.listMrs('p1', 'all', []);
    assert.equal(one.calls.filter((c) => c.cmd === 'gh').length, 0);
    const none = setup({ remotes, settings: { github: false, gitlab: false }, respond: () => undefined });
    const r = await none.svc.listMrs('p1', 'all', []);
    assert.equal(none.calls.length, 0);
    assert.deepEqual(r.enabled, { github: false, gitlab: false });
  });

  it('неизвестный проект - ошибка без вызовов', async () => {
    const { svc, calls } = setup({ remotes, respond: () => undefined });
    assert.equal((await svc.listMrs('nope', 'all', [])).error, 'Проект не найден');
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
    const r = await svc.listMrs('p1', 'all', tracked);
    assert.deepEqual(r.tracked.map((m) => [m.number, m.state, m.pipeline]), [[99, 'merged', 'успешен']]);
    assert.ok(!calls.some((c) => url(c) === 'repos/o/a/pulls/1' || url(c).includes('x/other')));
    const down = setup({ remotes, respond: (c) => (ghList(c) ? fail(1, 'boom') : undefined) });
    const d = await down.svc.listMrs('p1', 'all', [tracked[0]]);
    assert.deepEqual(d.tracked, []);
    assert.ok(!down.calls.some((c) => url(c) === 'repos/o/a/pulls/99'));
  });

  it('процессов gh одновременно не больше пула плюс источники, а не по три на MR', async () => {
    const prs = Array.from({ length: 12 }, (_, i) => ghRaw(i + 1));
    const { svc, load } = setup({ remotes, slow: true, respond: ghResponder(prs) });
    const r = await svc.listMrs('p1', 'all', []);
    assert.equal(r.mrs.length, 12);
    assert.ok(load.peak > 1 && load.peak <= MR_CONCURRENCY + 1, `пик ${load.peak}`);
  });

  it('детали - ровно у 200 самых свежих, у остальных «—»; MR с сессией получает детали и вне двухсотки', async () => {
    const prs = Array.from({ length: 205 }, (_, i) => ghRaw(i + 1, { updated_at: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString() }));
    const asked = (calls: Call[]) => new Set(calls.filter((c) => url(c).includes('/reviews')).map((c) => url(c).match(/pulls\/(\d+)\//)![1]));
    const a = setup({ remotes, respond: ghResponder(prs) });
    const r = await a.svc.listMrs('p1', 'all', []);
    const nums = asked(a.calls);
    assert.equal(nums.size, MAX_DETAILED);
    for (const m of r.mrs) assert.deepEqual([m.pipeline !== null, m.approvals !== null, nums.has(String(m.number))], m.number > 5 ? [true, true, true] : [false, false, false]);
    const b = setup({ remotes, respond: ghResponder(prs) });
    const rb = await b.svc.listMrs('p1', 'all', [{ kind: 'github', host: 'github.com', path: 'o/a', number: 1 }]);
    assert.notEqual(rb.mrs.find((m) => m.number === 1)!.pipeline, null);
    assert.equal(asked(b.calls).size, MAX_DETAILED + 1);
  });

  it('GitLab tracked: один запрос даёт статус и пайплайн; 404 - MR не возвращается', async () => {
    const ref = { kind: 'gitlab' as const, host: 'git.corp', path: 'g/p', number: 8 };
    const { svc } = setup({
      remotes: { '/w/a': ['git@git.corp:g/p.git'] },
      respond: (c) => (url(c) === 'projects/g%2Fp/merge_requests/8' ? ok('{"iid":8,"state":"merged","head_pipeline":{"status":"failed"}}') : ok('[]')),
    });
    assert.deepEqual((await svc.listMrs('p1', 'all', [ref])).tracked.map((m) => [m.state, m.pipeline]), [['merged', 'упал']]);
    const gone = setup({
      remotes: { '/w/a': ['git@git.corp:g/p.git'] },
      respond: (c) => (url(c) === 'projects/g%2Fp/merge_requests/8' ? fail(1, 'glab: 404 Not Found (HTTP 404)') : ok('[]')),
    });
    assert.deepEqual((await gone.svc.listMrs('p1', 'all', [ref])).tracked, []);
  });

  it('только читающие вызовы: ни -X, ни полей, ни graphql, ни токена', async () => {
    const { svc, calls } = setup({
      remotes: { '/w/a': ['git@github.com:o/a.git', 'git@git.corp:g/p.git'] },
      respond: (c) => (c.cmd === 'gh' ? ghResponder([ghRaw(1)])(c) : undefined),
    });
    await svc.listMrs('p1', 'all', [{ kind: 'github', host: 'github.com', path: 'o/a', number: 77 }, { kind: 'gitlab', host: 'git.corp', path: 'g/p', number: 78 }]);
    assert.ok(calls.length > 5);
    for (const { cmd, args } of calls) {
      assert.ok(args[0] === 'api' || (cmd === 'glab' && args[0] === 'auth' && args[1] === 'status'), args.join(' '));
      assert.ok(!args.some((a) => /^(-X|--method|-f|-F|--raw-field|--field|--input|graphql)$/.test(a)), args.join(' '));
      const host = args[args.indexOf('--hostname') + 1];
      if (args.includes('--hostname')) assert.ok(host === 'github.com' || host === 'git.corp', host);
    }
  });
});
