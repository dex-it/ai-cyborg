import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Project } from '../src/main/projects';
import {
  classifyRemote,
  parseGlabStatus,
  parseRemote,
  saveTrackerSettings,
  sessionDirsAllowed,
  splitJsonValues,
  taskPrompt,
  TrackersService,
  validateListArgs,
  validateRef,
  validateSettings,
  type CliResult,
  type TaskRef,
  type TrackerSettings,
} from '../src/main/trackers';
import { emptyView } from '../src/renderer/task-model';
import { claudeArgs } from '../src/main/claude-args';

const ok = (stdout: string, stderr = ''): CliResult => ({ code: 0, stdout, stderr, missing: false });
const fail = (code: number, stderr: string): CliResult => ({ code, stdout: '', stderr, missing: false });
const GLAB_STATUS = `gitlab.com
  x gitlab.com: api call failed: GET https://gitlab.com/api/v4/user: 401 {message: 401 Unauthorized}
  ✓ Git operations for gitlab.com configured to use ssh protocol.
  x No token provided
git.corp
  ✓ Logged in to git.corp as mmx003 (/home/mmx/.config/glab-cli/config.yml)
  ✓ Token: **************************
`;

describe('parseRemote', () => {
  it('разбирает https, ssh и scp-формы', () => {
    assert.deepEqual(parseRemote('https://github.com/o/r.git'), { host: 'github.com', path: 'o/r' });
    assert.deepEqual(parseRemote('https://user@GitHub.com:8443/o/r/'), { host: 'github.com', path: 'o/r' });
    assert.deepEqual(parseRemote('git@github.com:o/r.git'), { host: 'github.com', path: 'o/r' });
    assert.deepEqual(parseRemote('ssh://git@git.corp:2222/g/sub/p.git'), { host: 'git.corp', path: 'g/sub/p' });
  });
  it('отбрасывает локальные пути, file:// и небезопасные сегменты', () => {
    assert.equal(parseRemote('/srv/git/repo.git'), null);
    assert.equal(parseRemote('file:///srv/git/repo.git'), null);
    assert.equal(parseRemote('https://github.com/../etc'), null);
    assert.equal(parseRemote('https://github.com/o/r?x=1'), null);
  });
});

describe('classifyRemote', () => {
  const hosts = new Set(['git.corp']);
  it('GitHub - ровно owner/repo, любая форма хоста приводится к github.com', () => {
    assert.deepEqual(classifyRemote('ssh://git@ssh.github.com:443/o/r.git', hosts), { kind: 'github', host: 'github.com', path: 'o/r' });
    assert.equal(classifyRemote('https://github.com/o', hosts), null);
    assert.equal(classifyRemote('https://github.com/o/r/x', hosts), null);
  });
  it('GitLab - только хост, на который залогинен glab; вложенные группы допустимы', () => {
    assert.deepEqual(classifyRemote('git@git.corp:g/sub/p.git', hosts), { kind: 'gitlab', host: 'git.corp', path: 'g/sub/p' });
    assert.equal(classifyRemote('git@gitlab.com:g/p.git', hosts), null);
    assert.equal(classifyRemote('git@bitbucket.org:o/r.git', hosts), null);
    assert.equal(classifyRemote('git@gh-work:o/r.git', hosts), null);
  });
});

describe('splitJsonValues', () => {
  it('объекты по строке (gh --jq)', () => {
    assert.deepEqual(splitJsonValues('{"a":1}\n{"a":2}\n'), [{ a: 1 }, { a: 2 }]);
  });
  it('склеенные страницы glab: все страницы, а не первая', () => {
    assert.deepEqual(splitJsonValues('[{"a":1}][{"a":2},{"a":3}]'), [[{ a: 1 }], [{ a: 2 }, { a: 3 }]]);
  });
  it('скобки и кавычки внутри строк не режут значение', () => {
    assert.deepEqual(splitJsonValues('[{"t":"x][y \\" }{"}]'), [[{ t: 'x][y " }{' }]]);
    assert.deepEqual(splitJsonValues('[{"t":"a]"}][{"t":"b"}]'), [[{ t: 'a]' }], [{ t: 'b' }]]);
  });
  it('пусто - пустой массив, обрезанный вывод - ошибка', () => {
    assert.deepEqual(splitJsonValues(''), []);
    assert.throws(() => splitJsonValues('[{"a":1}'));
  });
});

describe('parseGlabStatus', () => {
  it('блок на хост: вошёл с именем, без токена - не вошёл', () => {
    assert.deepEqual(parseGlabStatus(GLAB_STATUS), [
      { host: 'gitlab.com', auth: { state: 'logged-out' } },
      { host: 'git.corp', auth: { state: 'logged-in', user: 'mmx003' } },
    ]);
  });
  it('нераспознанный блок - ошибка, а не «не залогинен»', () => {
    const [host] = parseGlabStatus('git.corp\n  ? странно\n');
    assert.equal(host.auth.state, 'error');
  });
  it('api call failed без 401 - ошибка с текстом', () => {
    const [host] = parseGlabStatus('git.corp\n  x git.corp: api call failed: dial tcp: no such host\n');
    assert.equal(host.auth.state, 'error');
  });
});

describe('валидация аргументов каналов', () => {
  const ref = { kind: 'github', host: 'github.com', path: 'o/r', number: 5 };
  it('validateRef принимает корректную ссылку', () => {
    assert.deepEqual(validateRef(ref), ref);
    assert.deepEqual(validateRef({ kind: 'gitlab', host: 'git.corp', path: 'g/s/p', number: 1 }), { kind: 'gitlab', host: 'git.corp', path: 'g/s/p', number: 1 });
  });
  it('validateRef отклоняет число строкой, обход пути, чужой хост GitHub, вид не из списка', () => {
    assert.equal(validateRef({ ...ref, number: '5' }), null);
    assert.equal(validateRef({ ...ref, number: 0 }), null);
    assert.equal(validateRef({ ...ref, number: 1.5 }), null);
    assert.equal(validateRef({ ...ref, path: '../../user' }), null);
    assert.equal(validateRef({ ...ref, host: 'evil.com' }), null);
    assert.equal(validateRef({ ...ref, kind: 'jira' }), null);
    assert.equal(validateRef({ ...ref, host: '-x' }), null);
    assert.equal(validateRef(null), null);
  });
  it('validateSettings принимает только два boolean', () => {
    assert.deepEqual(validateSettings({ github: true, gitlab: false, token: 'x' }), { github: true, gitlab: false });
    assert.equal(validateSettings({ github: 'yes', gitlab: false }), null);
    assert.equal(validateSettings({ github: true }), null);
  });
  it('validateListArgs: типы, лимит 200, плохой ref отклоняет вызов', () => {
    assert.ok(validateListArgs('p', true, [ref], false));
    assert.equal(validateListArgs('p', 'true', [], false), null);
    for (const bad of [undefined, 'x', 1, null]) assert.equal(validateListArgs('p', true, [], bad), null);
    assert.equal(validateListArgs(1, true, [], false), null);
    assert.equal(validateListArgs('p', true, Array(201).fill(ref), false), null);
    assert.ok(validateListArgs('p', true, Array(200).fill(ref), false));
    assert.equal(validateListArgs('p', true, [{ ...ref, path: '../x' }], false), null);
  });
  it('sessionDirsAllowed: каталоги только из репозиториев проектов', () => {
    const state = { projects: [{ id: 'p', name: 'p', description: '', repos: ['/a', '/b'] }], lastProjectId: null };
    assert.equal(sessionDirsAllowed(state, '/a', ['/b']), true);
    assert.equal(sessionDirsAllowed(state, '/etc', []), false);
    assert.equal(sessionDirsAllowed(state, '/a', ['/etc']), false);
    assert.equal(sessionDirsAllowed(state, '/a', 'x'), false);
  });
});

describe('начальный промпт', () => {
  it('содержит ссылку, просьбу ознакомиться и подсказку сменить статус', () => {
    const gh = taskPrompt({ kind: 'github', host: 'github.com', path: 'o/r', number: 7 });
    assert.match(gh, /https:\/\/github\.com\/o\/r\/issues\/7/);
    assert.match(gh, /Ознакомься/);
    assert.match(gh, /смени её статус/);
    assert.match(taskPrompt({ kind: 'gitlab', host: 'git.corp', path: 'g/s/p', number: 3 }), /https:\/\/git\.corp\/g\/s\/p\/-\/issues\/3/);
    assert.ok(!gh.startsWith('-'));
  });
  it('claudeArgs: промпт стоит до вариадического --add-dir, без задачи аргументы прежние', () => {
    assert.deepEqual(claudeArgs(['/b', '/c'], 'P'), ['P', '--add-dir', '/b', '/c']);
    assert.deepEqual(claudeArgs(['/b']), ['--add-dir', '/b']);
    assert.deepEqual(claudeArgs([]), []);
    assert.deepEqual(claudeArgs([], 'P'), ['P']);
  });
});

// ---------- TrackersService ----------

const repoA = '/w/a';
const repoB = '/w/b';
const project: Project = { id: 'p1', name: 'P', description: '', repos: [repoA, repoB] };
const other: Project = { id: 'p2', name: 'Q', description: '', repos: ['/w/other'] };

interface Call {
  cmd: string;
  args: string[];
}

function service(opts: {
  remotes: Record<string, string[]>;
  settings?: TrackerSettings;
  respond: (call: Call) => CliResult | undefined;
}) {
  const calls: Call[] = [];
  const svc = new TrackersService({
    run: async (cmd, args) => {
      const call = { cmd, args };
      calls.push(call);
      if (cmd === 'glab' && args[0] === 'auth') return ok('', GLAB_STATUS);
      if (cmd === 'gh' && args[1] === '--hostname' && args.includes('user')) return ok('me\n');
      return opts.respond(call) ?? ok('');
    },
    remotes: async (repo) => opts.remotes[repo] ?? [],
    projects: () => ({ projects: [project, other], lastProjectId: null }),
    settings: () => opts.settings ?? { github: true, gitlab: true },
  });
  return { svc, calls };
}

const ghIssue = (n: number, extra = {}) => JSON.stringify({ number: n, title: `T${n}`, state: 'open', html_url: 'x', created_at: '2026-01-0' + n, updated_at: '2026-02-0' + n, ...extra });
const listCalls = (calls: Call[]) => calls.filter((c) => c.args.some((a) => a.includes('/issues?')));

describe('TrackersService.list', () => {
  it('показывает только задачи remote репозиториев проекта и не лезет в чужие', async () => {
    const { svc, calls } = service({
      remotes: { [repoA]: ['git@github.com:o/a.git'], '/w/other': ['git@github.com:x/other.git'] },
      respond: (c) => (c.args.some((a) => a.startsWith('repos/o/a/issues?')) ? ok(ghIssue(1) + '\n' + ghIssue(2)) : undefined),
    });
    const r = await svc.list('p1', false, []);
    assert.deepEqual(r.tasks.map((t) => t.key), ['github:github.com/o/a#1', 'github:github.com/o/a#2']);
    assert.ok(listCalls(calls).every((c) => c.args.some((a) => a.startsWith('repos/o/a/'))));
  });

  it('запрашивает issues без PR: фильтр pull_request в jq и эндпоинт issues', async () => {
    const { svc, calls } = service({ remotes: { [repoA]: ['git@github.com:o/a.git'] }, respond: () => ok('') });
    await svc.list('p1', false, []);
    const call = listCalls(calls)[0];
    assert.ok(call.args.includes('--paginate'));
    assert.ok(call.args.some((a) => a.includes('select(.pull_request == null)')));
    assert.ok(call.args.some((a) => a.startsWith('repos/o/a/issues?state=open&per_page=100')));
  });

  it('берёт все remote, не только origin; одна задача через два remote - один раз', async () => {
    const { svc, calls } = service({
      remotes: {
        [repoA]: ['git@github.com:o/a.git', 'https://github.com/o/a', 'https://github.com/fork/a.git'],
        [repoB]: ['https://github.com/O/A.git'],
      },
      respond: (c) => (c.args.some((a) => a.startsWith('repos/o/a/issues?')) ? ok(ghIssue(1)) : c.args.some((a) => a.startsWith('repos/fork/a/issues?')) ? ok(ghIssue(1)) : undefined),
    });
    const r = await svc.list('p1', false, []);
    assert.equal(listCalls(calls).length, 2);
    assert.equal(r.tasks.length, 2);
    const main = r.tasks.find((t) => t.path === 'o/a')!;
    assert.deepEqual(main.repos.sort(), [repoA, repoB]);
  });

  it('пропускает чужие хосты, алиасы ssh и репозитории без remote', async () => {
    const { svc, calls } = service({
      remotes: { [repoA]: ['git@bitbucket.org:o/r.git', 'git@gh-work:o/r.git'], [repoB]: [] },
      respond: () => ok(''),
    });
    const r = await svc.list('p1', false, []);
    assert.equal(listCalls(calls).length, 0);
    assert.deepEqual(r.sources.filter((s) => s.path), []);
  });

  it('хост glab без подтверждённого входа даёт отказ источника с причиной, а не «нет remote»', async () => {
    const { svc, calls } = service({ remotes: { [repoA]: ['git@gitlab.com:g/p.git'] }, respond: () => ok('') });
    const r = await svc.list('p1', false, []);
    assert.equal(listCalls(calls).length, 0);
    const src = r.sources.filter((s) => s.path);
    assert.equal(src.length, 1);
    assert.deepEqual([src[0].host, src[0].path], ['gitlab.com', 'g/p']);
    assert.match(src[0].error ?? '', /glab auth login --hostname gitlab\.com/);
  });

  it('хост glab, проверка которого сорвалась (api call failed), называет сбой проверки', async () => {
    const down = `git.corp\n  x git.corp: api call failed: dial tcp: i/o timeout\n`;
    const svc2 = new TrackersService({
      run: async (cmd) => (cmd === 'glab' ? ok('', down) : ok('me\n')),
      remotes: async () => ['git@git.corp:g/p.git'],
      projects: () => ({ projects: [project], lastProjectId: null }),
      settings: () => ({ github: true, gitlab: true }),
    });
    const r = await svc2.list('p1', false, []);
    const src = r.sources.filter((s) => s.path);
    assert.match(src[0].error ?? '', /проверка входа в git\.corp не удалась: .*api call failed/);
    assert.equal(emptyView(r), null);
  });

  it('GitLab: самохостный, все страницы, workflow-метки, состояние opened -> open', async () => {
    const page = (iid: number) => ({ iid, title: `G${iid}`, state: 'opened', labels: ['bug', 'workflow::in review'], created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' });
    const { svc, calls } = service({
      remotes: { [repoA]: ['ssh://git@git.corp:2222/g/sub/p.git'] },
      respond: (c) => (c.cmd === 'glab' && c.args.includes('--paginate') ? ok(JSON.stringify([page(1)]) + JSON.stringify([page(2)])) : undefined),
    });
    const r = await svc.list('p1', false, []);
    assert.deepEqual(r.tasks.map((t) => t.number), [1, 2]);
    assert.equal(r.tasks[0].state, 'open');
    assert.deepEqual(r.tasks[0].workflow, ['workflow::in review']);
    assert.equal(r.tasks[0].url, 'https://git.corp/g/sub/p/-/issues/1');
    const call = listCalls(calls)[0];
    assert.ok(call.args.includes('git.corp'));
    assert.ok(call.args.some((a) => a.startsWith('projects/g%2Fsub%2Fp/issues?state=opened')));
  });

  it('источник с задачами сверх одной страницы отдаёт все (вывод нескольких страниц gh)', async () => {
    const lines = Array.from({ length: 250 }, (_, i) => ghIssue(i + 1)).join('\n');
    const { svc } = service({ remotes: { [repoA]: ['git@github.com:o/a.git'] }, respond: (c) => (c.args.includes('--paginate') ? ok(lines) : undefined) });
    assert.equal((await svc.list('p1', false, [])).tasks.length, 250);
  });

  it('фильтр «назначено мне»: assignee добавляется только при включённом', async () => {
    const remotes = { [repoA]: ['git@github.com:o/a.git', 'git@git.corp:g/p.git'] };
    const on = service({ remotes, respond: () => ok('') });
    await on.svc.list('p1', true, []);
    const urls = listCalls(on.calls).map((c) => c.args.at(-1)!);
    assert.ok(urls.some((u) => u.includes('assignee=me')));
    assert.ok(urls.some((u) => u.includes('assignee_username=mmx003')));
    const off = service({ remotes, respond: () => ok('') });
    await off.svc.list('p1', false, []);
    assert.ok(listCalls(off.calls).every((c) => !c.args.at(-1)!.includes('assignee')));
  });

  it('без залогиненного gh фильтр не применяется вслепую: ошибка источника', async () => {
    const calls: Call[] = [];
    const svc = new TrackersService({
      run: async (cmd, args) => {
        calls.push({ cmd, args });
        return fail(4, 'To get started with GitHub CLI, please run: gh auth login');
      },
      remotes: async () => ['git@github.com:o/a.git'],
      projects: () => ({ projects: [project], lastProjectId: null }),
      settings: () => ({ github: true, gitlab: false }),
    });
    const r = await svc.list('p1', true, []);
    assert.equal(r.sources[0].error, 'gh не залогинен');
    assert.equal(listCalls(calls).length, 0);
  });

  it('выключенные источники: запросов к трекерам нет, флаги возвращаются', async () => {
    const { svc, calls } = service({ remotes: { [repoA]: ['git@github.com:o/a.git'] }, settings: { github: false, gitlab: false }, respond: () => ok('') });
    const r = await svc.list('p1', false, []);
    assert.equal(calls.length, 0);
    assert.deepEqual(r.enabled, { github: false, gitlab: false });
  });

  it('включён только GitLab - remote GitHub не опрашиваются', async () => {
    const { svc, calls } = service({ remotes: { [repoA]: ['git@github.com:o/a.git'] }, settings: { github: false, gitlab: true }, respond: () => ok('') });
    await svc.list('p1', false, []);
    assert.equal(calls.filter((c) => c.cmd === 'gh').length, 0);
  });

  it('отказ одного источника показан его сообщением, задачи других остаются', async () => {
    const { svc } = service({
      remotes: { [repoA]: ['git@github.com:o/a.git', 'git@git.corp:g/p.git'] },
      respond: (c) =>
        c.cmd === 'gh' ? fail(1, 'gh: API rate limit exceeded (HTTP 403)\nподробности') : ok(JSON.stringify([{ iid: 4, title: 'ok', state: 'opened', labels: [] }])),
    });
    const r = await svc.list('p1', false, []);
    assert.deepEqual(r.tasks.map((t) => t.number), [4]);
    assert.equal(r.sources.find((s) => s.kind === 'github')!.error, 'gh: API rate limit exceeded (HTTP 403)');
  });

  it('glab: HTTP-ошибка при коде 0 и объект с message - ошибка источника', async () => {
    const a = service({ remotes: { [repoA]: ['git@git.corp:g/p.git'] }, respond: () => ok('{"message":"404 Project Not Found"}', 'glab: 404 Project Not Found (HTTP 404)') });
    assert.equal((await a.svc.list('p1', false, [])).sources[0].error, 'glab: 404 Project Not Found (HTTP 404)');
    const b = service({ remotes: { [repoA]: ['git@git.corp:g/p.git'] }, respond: () => ok('{"message":"403 Forbidden"}') });
    assert.equal((await b.svc.list('p1', false, [])).sources[0].error, '403 Forbidden');
  });

  it('HTTP 410 у GitHub - пометка, не ошибка; таймаут и переполнение - ошибки', async () => {
    const gone = service({ remotes: { [repoA]: ['git@github.com:o/a.git'] }, respond: () => fail(1, 'gh: Issues are disabled (HTTP 410)') });
    const s = (await gone.svc.list('p1', false, [])).sources[0];
    assert.equal(s.error, undefined);
    assert.match(s.note!, /отключены/);
    const slow = service({ remotes: { [repoA]: ['git@github.com:o/a.git'] }, respond: () => ({ code: null, stdout: '', stderr: '', missing: false, failure: 'timeout' }) });
    assert.match((await slow.svc.list('p1', false, [])).sources[0].error!, /120 с/);
    const big = service({ remotes: { [repoA]: ['git@github.com:o/a.git'] }, respond: () => ({ code: null, stdout: '', stderr: '', missing: false, failure: 'overflow' }) });
    assert.match((await big.svc.list('p1', false, [])).sources[0].error!, /64 МБ/);
  });

  it('неизвестный проект - ошибка без запросов', async () => {
    const { svc, calls } = service({ remotes: {}, respond: () => ok('') });
    const r = await svc.list('nope', false, []);
    assert.equal(r.error, 'Проект не найден');
    assert.equal(calls.length, 0);
  });

  it('tracked: одиночный запрос для задач вне списка; чужой источник и дубль списка не запрашиваются', async () => {
    const mine: TaskRef = { kind: 'github', host: 'github.com', path: 'o/a', number: 99 };
    const inList: TaskRef = { kind: 'github', host: 'github.com', path: 'o/a', number: 1 };
    const foreign: TaskRef = { kind: 'github', host: 'github.com', path: 'x/other', number: 5 };
    const { svc, calls } = service({
      remotes: { [repoA]: ['git@github.com:o/a.git'] },
      respond: (c) => {
        const url = c.args.at(-1)!;
        if (url.startsWith('repos/o/a/issues?')) return ok(ghIssue(1));
        if (url === 'repos/o/a/issues/99') return ok(ghIssue(99, { state: 'closed' }));
        return undefined;
      },
    });
    const r = await svc.list('p1', false, [mine, inList, foreign]);
    assert.deepEqual(r.tracked.map((t) => [t.number, t.state]), [[99, 'closed']]);
    assert.ok(!calls.some((c) => c.args.at(-1)!.includes('x/other')));
    assert.ok(!calls.some((c) => c.args.at(-1) === 'repos/o/a/issues/1'));
  });

  it('tracked: у источника, который не ответил, одиночных запросов нет', async () => {
    const ref: TaskRef = { kind: 'github', host: 'github.com', path: 'o/a', number: 9 };
    const { svc, calls } = service({ remotes: { [repoA]: ['git@github.com:o/a.git'] }, respond: () => fail(1, 'gh: boom') });
    const r = await svc.list('p1', false, [ref]);
    assert.deepEqual(r.tracked, []);
    assert.ok(!calls.some((c) => c.args.at(-1) === 'repos/o/a/issues/9'));
  });

  it('GitLab tracked: эндпоинт одной задачи, закрытая задача нормализуется в closed', async () => {
    const ref: TaskRef = { kind: 'gitlab', host: 'git.corp', path: 'g/p', number: 8 };
    const { svc } = service({
      remotes: { [repoA]: ['git@git.corp:g/p.git'] },
      respond: (c) => (c.args.at(-1) === 'projects/g%2Fp/issues/8' ? ok(JSON.stringify({ iid: 8, title: 'x', state: 'closed', labels: [] })) : ok('[]')),
    });
    const r = await svc.list('p1', false, [ref]);
    assert.equal(r.tracked[0].state, 'closed');
  });

  it('ни одного изменяющего запроса и ни одного обращения к токену', async () => {
    const { svc, calls } = service({
      remotes: { [repoA]: ['git@github.com:o/a.git', 'git@git.corp:g/p.git'] },
      respond: () => ok(''),
    });
    await svc.list('p1', true, [{ kind: 'github', host: 'github.com', path: 'o/a', number: 3 }]);
    await svc.status();
    for (const { args } of calls) {
      assert.ok(!args.some((a) => /^(-X|--method|-f|-F|--raw-field|--field|--input|--show-token|-t)$/.test(a)), args.join(' '));
      assert.ok(!(args[0] === 'auth' && args[1] === 'token'));
    }
  });
});

describe('TrackersService.status', () => {
  const make = (gh: CliResult, glab: CliResult) =>
    new TrackersService({
      run: async (cmd) => (cmd === 'gh' ? gh : glab),
      remotes: async () => [],
      projects: () => ({ projects: [], lastProjectId: null }),
      settings: () => ({ github: false, gitlab: false }),
    });
  const missing: CliResult = { code: null, stdout: '', stderr: '', missing: true };

  it('gh: вошёл с именем, не вошёл (код 4), не установлен и сбой сети - четыре разных состояния', async () => {
    assert.deepEqual((await make(ok('mmx003\n'), ok('')).status()).github, { state: 'logged-in', user: 'mmx003' });
    assert.deepEqual((await make(fail(4, 'x'), ok('')).status()).github, { state: 'logged-out' });
    assert.deepEqual((await make(missing, ok('')).status()).github, { state: 'missing' });
    const net = (await make(fail(1, 'error connecting to api.github.com'), ok('')).status()).github;
    assert.deepEqual(net, { state: 'error', message: 'error connecting to api.github.com' });
  });

  it('glab: состояние по каждому хосту, отсутствие CLI, пустой список хостов', async () => {
    const s = await make(ok('u'), ok('', GLAB_STATUS)).status();
    assert.deepEqual(s.gitlab, {
      state: 'hosts',
      hosts: [
        { host: 'gitlab.com', auth: { state: 'logged-out' } },
        { host: 'git.corp', auth: { state: 'logged-in', user: 'mmx003' } },
      ],
    });
    assert.deepEqual((await make(ok('u'), missing).status()).gitlab, { state: 'missing' });
    assert.deepEqual((await make(ok('u'), ok('', '')).status()).gitlab, { state: 'logged-out' });
  });
});

describe('TrackersService: кэш проверки входа', () => {
  const make = (glab: () => Promise<CliResult> | CliResult, gh: () => CliResult = () => ok('me\n')) => {
    const calls: Call[] = [];
    const svc = new TrackersService({
      run: async (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === 'glab' && args[0] === 'auth') return glab();
        if (cmd === 'gh' && args.includes('user')) return gh();
        return ok('');
      },
      remotes: async () => ['git@github.com:o/a.git', 'git@git.corp:g/p.git'],
      projects: () => ({ projects: [project], lastProjectId: null }),
      settings: () => ({ github: true, gitlab: true }),
    });
    const auth = (cmd: string) => calls.filter((c) => c.cmd === cmd && (c.args[0] === 'auth' || c.args.includes('user'))).length;
    return { svc, auth };
  };

  it('второе обновление не зовёт auth status и api user; «Обновить» (recheck) зовёт снова', async () => {
    const { svc, auth } = make(() => ok('', GLAB_STATUS));
    await svc.list('p1', true, []);
    await svc.list('p1', true, []);
    assert.deepEqual([auth('glab'), auth('gh')], [1, 1]);
    await svc.list('p1', true, [], true);
    assert.deepEqual([auth('glab'), auth('gh')], [2, 2]);
  });

  it('одновременные выборки при пустом кэше ждут одну проверку в полёте', async () => {
    const { svc, auth } = make(() => ok('', GLAB_STATUS));
    await Promise.all([svc.list('p1', true, []), svc.list('p1', true, []), svc.resolveSources('p1')]);
    assert.deepEqual([auth('glab'), auth('gh')], [1, 1]);
  });

  it('проверка, начатая до сброса, в кэш не попадает', async () => {
    let release!: (r: CliResult) => void;
    let first = true;
    const { svc, auth } = make(() => {
      if (!first) return ok('', GLAB_STATUS);
      first = false;
      return new Promise<CliResult>((r) => (release = r));
    });
    const inFlight = svc.resolveSources('p1');
    await new Promise((r) => setImmediate(r));
    svc.resetAuth();
    const fresh = await svc.resolveSources('p1');
    assert.equal(fresh.gitlabUsers.get('git.corp'), 'mmx003');
    release(ok('', 'git.corp\n  x git.corp: api call failed\n'));
    assert.equal((await inFlight).gitlabUsers.size, 0);
    await svc.resolveSources('p1');
    assert.equal(auth('glab'), 2);
  });

  it('исход «не залогинен» переиспользуется до сброса', async () => {
    let out = fail(4, 'x');
    const { svc, auth } = make(() => ok('', ''), () => out);
    const a = await svc.list('p1', true, []);
    out = ok('me\n');
    const b = await svc.list('p1', true, []);
    assert.deepEqual(b.sources, a.sources);
    assert.deepEqual([auth('glab'), auth('gh')], [1, 1]);
    assert.match(a.sources.map((s) => s.error).join(), /gh не залогинен/);
    svc.resetAuth();
    await svc.list('p1', true, []);
    assert.equal(auth('gh'), 2);
  });

  it('status() окна настроек проверяет заново при каждом открытии и кэш списков не трогает', async () => {
    const { svc, auth } = make(() => ok('', GLAB_STATUS));
    await svc.status();
    await svc.status();
    assert.deepEqual([auth('glab'), auth('gh')], [2, 2]);
    await svc.list('p1', true, []);
    assert.deepEqual([auth('glab'), auth('gh')], [3, 3]);
    await svc.status();
    await svc.list('p1', true, []);
    assert.deepEqual([auth('glab'), auth('gh')], [4, 4]);
  });
});

describe('TrackersService: проверка входа при старте и после сброса', () => {
  const statusOf = (user: string) => `git.corp\n  ✓ Logged in to git.corp as ${user} (/x)\n`;
  const tick = () => new Promise((r) => setImmediate(r));
  const make = (glabAuth: () => Promise<CliResult> | CliResult, ghUser: () => Promise<CliResult> | CliResult = () => ok('me\n')) => {
    const calls: { cmd: string; args: string[] }[] = [];
    const svc = new TrackersService({
      run: async (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === 'glab' && args[0] === 'auth') return glabAuth();
        if (cmd === 'gh' && args.includes('user')) return ghUser();
        return ok('[]');
      },
      remotes: async () => ['git@github.com:o/a.git', 'git@git.corp:g/p.git'],
      projects: () => ({ projects: [project], lastProjectId: null }),
      settings: () => ({ github: true, gitlab: true }),
    });
    const isAuth = (c: { cmd: string; args: string[] }) => (c.cmd === 'glab' && c.args[0] === 'auth') || (c.cmd === 'gh' && c.args.includes('user'));
    const listCalls = () => calls.filter((c) => !isAuth(c));
    return { svc, calls, listCalls, authCalls: () => calls.filter(isAuth).length };
  };

  it('warmAuth: проверка запущена до первого списка, открытие после неё не зовёт auth status и api user', async () => {
    const { svc, calls, listCalls, authCalls } = make(() => ok('', statusOf('mmx')));
    svc.warmAuth();
    await tick();
    assert.equal(authCalls(), 2);
    assert.equal(listCalls().length, 0);
    await svc.list('p1', true, []);
    assert.equal(authCalls(), 2);
    assert.ok(calls.findIndex((c) => !(c.cmd === 'glab' && c.args[0] === 'auth') && !c.args.includes('user')) >= 2);
    await svc.list('p1', true, []);
    assert.equal(authCalls(), 2);
  });

  it('warmAuth: выключенный трекер не проверяется; повтора по таймеру нет', async () => {
    const calls: string[] = [];
    const svc = new TrackersService({
      run: async (cmd) => (calls.push(cmd), ok('')),
      remotes: async () => [],
      projects: () => ({ projects: [project], lastProjectId: null }),
      settings: () => ({ github: false, gitlab: true }),
    });
    svc.warmAuth();
    await tick();
    assert.deepEqual(calls, ['glab']);
  });

  it('без прежнего результата выборка ждёт проверку', async () => {
    let release!: (r: CliResult) => void;
    const { svc, listCalls } = make(() => new Promise<CliResult>((r) => (release = r)));
    const p = svc.list('p1', false, []);
    await tick();
    assert.equal(listCalls().length, 0);
    release(ok('', statusOf('mmx')));
    await p;
    assert.ok(listCalls().length > 0);
  });

  it('«Обновить» с прежним результатом: список стартует до завершения новой auth status; результат не изменился - выборка одна', async () => {
    let n = 0;
    let release!: (r: CliResult) => void;
    const { svc, listCalls } = make(() => (++n === 1 ? ok('', statusOf('mmx')) : new Promise<CliResult>((r) => (release = r))));
    await svc.list('p1', true, []);
    const before = listCalls().length;
    const p = svc.list('p1', true, [], true);
    await tick();
    assert.ok(listCalls().length > before, 'список не стартовал до новой проверки');
    release(ok('', statusOf('mmx')));
    await p;
    assert.equal(listCalls().length - before, before);
  });

  it('новая проверка изменила пользователя GitLab: выборка перестроена по ней', async () => {
    let n = 0;
    const { svc, listCalls } = make(() => ok('', statusOf(++n === 1 ? 'old' : 'new')));
    await svc.list('p1', true, []);
    await svc.list('p1', true, [], true);
    const assignees = listCalls().map((c) => c.args.at(-1)!).filter((u) => u.includes('assignee_username'));
    assert.deepEqual(assignees.map((u) => u.match(/assignee_username=(\w+)/)![1]), ['old', 'old', 'new']);
  });

  it('новая проверка изменила логин gh: выборка перестроена по нему', async () => {
    let n = 0;
    const { svc, listCalls } = make(() => ok('', statusOf('mmx')), () => ok(++n === 1 ? 'a\n' : 'b\n'));
    await svc.list('p1', true, []);
    await svc.list('p1', true, [], true);
    const assignees = listCalls().map((c) => c.args.at(-1)!).filter((u) => u.includes('repos/o/a/issues')).map((u) => u.match(/assignee=(\w+)/)![1]);
    assert.deepEqual(assignees, ['a', 'a', 'b']);
  });

  it('«Обновить»: у хоста без входа меняется только текст ошибки - выборка не перестраивается', async () => {
    const down = (what: string) => `gitlab.com\n  x gitlab.com: api call failed: ${what}\n`;
    let n = 0;
    const { svc, listCalls } = make(() => ok('', statusOf('mmx') + down(++n === 1 ? 'dial tcp: i/o timeout' : 'dial tcp: no route')));
    await svc.list('p1', true, []);
    const once = listCalls().length;
    await svc.list('p1', true, [], true);
    assert.equal(listCalls().length, once * 2);
  });

  it('«Обновить»: хост без входа сменил состояние с ошибки на «не вошёл» - выборка перестроена', async () => {
    let n = 0;
    const { svc, listCalls } = make(() => ok('', statusOf('mmx') + (++n === 1 ? 'gitlab.com\n  x gitlab.com: api call failed: dial tcp: i/o timeout\n' : 'gitlab.com\n  x No token provided\n')));
    await svc.list('p1', true, []);
    const once = listCalls().length;
    await svc.list('p1', true, [], true);
    assert.equal(listCalls().length, once * 3);
  });

  it('вход пропал после «Обновить»: тексты отказа прежние, источник заблокирован', async () => {
    let n = 0;
    const { svc } = make(() => (++n === 1 ? ok('', statusOf('mmx')) : ok('', '')));
    await svc.list('p1', false, []);
    const r = await svc.list('p1', false, [], true);
    assert.ok(r.sources.some((s) => s.error === 'вход glab не выполнен'));
  });

  it('сохранение настроек: следующая выборка идёт по прежнему результату параллельно с новой проверкой', async () => {
    let n = 0;
    let release!: (r: CliResult) => void;
    const { svc, listCalls } = make(() => (++n === 1 ? ok('', statusOf('mmx')) : new Promise<CliResult>((r) => (release = r))));
    await svc.list('p1', false, []);
    const before = listCalls().length;
    svc.resetAuth();
    const p = svc.list('p1', false, []);
    await tick();
    assert.ok(listCalls().length > before);
    release(ok('', statusOf('mmx')));
    await p;
  });
});

describe('saveTrackerSettings', () => {
  it('сохранение настроек сбрасывает кэш входа; некорректные настройки не сохраняются и кэш не трогают', () => {
    const events: string[] = [];
    const store = { save: () => void events.push('save') };
    const trackers = { resetAuth: () => void events.push('reset') };
    saveTrackerSettings({ github: true, gitlab: false }, store, trackers);
    assert.deepEqual(events, ['save', 'reset']);
    events.length = 0;
    assert.throws(() => saveTrackerSettings({ github: 'x' }, store, trackers), /Некорректные настройки/);
    assert.deepEqual(events, []);
  });
});
