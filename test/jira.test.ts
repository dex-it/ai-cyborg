import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  bodyText,
  clean,
  DETAIL_COMMENTS,
  failureText,
  issueOfRaw,
  jiraListArgs,
  jiraOpenArgs,
  jiraProjectsArgs,
  jiraPrompt,
  jiraProgressArgs,
  jiraViewArgs,
  JIRA_LIMIT,
  KEY_RE,
  MINE_JQL,
  parseDetails,
  parseIssues,
  parseKeys,
  parseProjects,
  problemOf,
  problemText,
  suggestKeys,
  timeOf,
  validateJiraStart,
} from '../src/main/jira';
import { JiraService } from '../src/main/jira-service';
import { mrPrompt, validateSessionStart } from '../src/main/mrs';
import { MAX_JIRA_PROJECTS, NO_JIRA, PROJECT_KEY, readJira, validateJira, type Project, type ProjectsState } from '../src/main/projects';
import type { CliResult, JiraRunner } from '../src/main/trackers';
import { saveProjectsState, validateProjectsState } from '../src/main/trackers';

const ok = (stdout: string): CliResult => ({ code: 0, stdout, stderr: '', missing: false });
const fail = (stderr: string, code = 1): CliResult => ({ code, stdout: '', stderr, missing: false });

/** Запись списка в виде jira-cli (`issue list --raw`): issueType, плоские имена, категории статуса нет. */
const listed = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  fields: {
    summary: `Задача ${key}`,
    status: { name: 'In Progress' },
    issueType: { name: 'Bug' },
    priority: { name: 'High' },
    assignee: { displayName: 'Иван' },
    reporter: { displayName: 'Ольга' },
    created: '2026-10-20T10:00:00.000+0300',
    updated: '2026-10-25T12:30:00.000+0300',
    labels: ['backend', 'urgent'],
    description: 'Описание',
    ...extra,
  },
});

/** Тело `issue view --raw`: REST как есть - issuetype, категория статуса, комментарии, описание ADF Cloud. */
const viewed = {
  key: 'DEX-12',
  self: 'https://jira.example/rest/api/2/issue/1001',
  fields: {
    summary: 'Выгрузка падает',
    status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
    issuetype: { name: 'Bug' },
    description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Привет' }, { type: 'hardBreak' }, { type: 'text', text: 'мир' }] }] },
    comment: {
      total: 5,
      comments: [
        { id: '1', author: { displayName: 'Ольга' }, created: '2026-10-24T09:00:00.000+0300', body: 'Первый' },
        { id: '', author: { displayName: 'Без номера' }, body: 'не берётся' },
        { id: '2', author: {}, created: '2026-10-25T09:00:00.000+0300', body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { text: '@Иван' } }] }] } },
      ],
    },
  },
};

describe('Jira: разбор вывода jira-cli', () => {
  it('запись списка: поля, имена людей, метки', () => {
    const issue = issueOfRaw(listed('DEX-12'))!;
    assert.equal(issue.key, 'DEX-12');
    assert.equal(issue.summary, 'Задача DEX-12');
    assert.equal(issue.status, 'In Progress');
    assert.equal(issue.type, 'Bug');
    assert.equal(issue.priority, 'High');
    assert.equal(issue.assignee, 'Иван');
    assert.equal(issue.reporter, 'Ольга');
    assert.deepEqual(issue.labels, ['backend', 'urgent']);
    assert.equal(issue.category, '', 'в списке категории статуса нет');
  });

  it('тело issue view: issuetype и категория статуса', () => {
    const issue = issueOfRaw(viewed)!;
    assert.equal(issue.type, 'Bug');
    assert.equal(issue.category, 'indeterminate');
  });

  it('ключ не по форме - не задача; неизвестная категория - пусто', () => {
    assert.equal(issueOfRaw({ key: 'dex-1', fields: {} }), null);
    assert.equal(issueOfRaw({ key: 'DEX-', fields: {} }), null);
    assert.equal(issueOfRaw('строка'), null);
    assert.equal(issueOfRaw({ key: 'DEX-1', fields: { status: { name: 'X', statusCategory: { key: 'чужая' } } } })!.category, '');
  });

  it('список: массив, пусто и null дают пусто; битые записи пропускаются; не JSON - исключение', () => {
    assert.deepEqual(parseIssues(''), []);
    assert.deepEqual(parseIssues('null'), []);
    assert.deepEqual(parseIssues('[]'), []);
    assert.deepEqual(
      parseIssues(JSON.stringify([listed('DEX-1'), { key: 'мусор' }, 7, listed('DEX-2')])).map((i) => i.key),
      ['DEX-1', 'DEX-2'],
    );
    assert.throws(() => parseIssues('Error: что-то'));
  });

  it('детали: описание ADF, упоминание, комментарии без номера пропущены, всего комментариев', () => {
    const details = parseDetails(JSON.stringify(viewed))!;
    assert.equal(details.issue.description, 'Привет\nмир');
    assert.equal(details.total, 5);
    assert.deepEqual(
      details.comments.map((c) => [c.author, c.text]),
      [['Ольга', 'Первый'], ['?', '@Иван']],
    );
    assert.equal(parseDetails('{"key":"плохой"}'), null);
    assert.throws(() => parseDetails('не json'));
  });

  it('описание Server - строка с вики-разметкой, остаётся как есть; длинное обрезается', () => {
    assert.equal(bodyText('h1. Заголовок\n* пункт'), 'h1. Заголовок\n* пункт');
    const long = bodyText('я'.repeat(25_000));
    assert.equal(long.length, 20_001);
    assert.ok(long.endsWith('…'));
  });

  it('чужой текст: цвет, управляющие коды и CR убраны, перевод строки и табуляция остались', () => {
    assert.equal(clean('\u001b[31mкрасный\u001b[0m\u0007\r\nстрока\tтаб\u009b'), 'красный\nстрока\tтаб');
    assert.equal(issueOfRaw(listed('DEX-1', { summary: 'Название\u001b[2J\u0007' }))!.summary, 'Название');
  });
});

describe('Jira: запросы и проверка ключей', () => {
  it('список: мои открытые, свежие первыми, предел; ключ проекта - через -p', () => {
    assert.deepEqual(jiraListArgs(''), ['issue', 'list', '-q', MINE_JQL, '--raw', '--order-by', 'updated', '--paginate', `0:${JIRA_LIMIT}`]);
    assert.deepEqual(jiraListArgs('DEX').slice(-2), ['-p', 'DEX']);
    assert.match(MINE_JQL, /currentUser\(\)/);
    assert.doesNotMatch(MINE_JQL, /order by/i, 'jira-cli дописывает свой ORDER BY');
  });

  it('детали и адрес: ключ - отдельный аргумент, последние комментарии', () => {
    assert.deepEqual(jiraViewArgs('DEX-12', ''), ['issue', 'view', 'DEX-12', '--raw', '--comments', String(DETAIL_COMMENTS)]);
    assert.deepEqual(jiraOpenArgs('DEX-12', 'DEX'), ['open', 'DEX-12', '--no-browser', '-p', 'DEX']);
  });

  it('форма ключа задачи и ключа проекта', () => {
    for (const good of ['DEX-1', 'A1_B-20', 'AB-999']) assert.ok(KEY_RE.test(good), good);
    for (const bad of ['dex-1', 'DEX-', '-1', 'DEX-1 ', 'DEX-1\n', '--raw', 'DEX-1; ls', '1A-1']) assert.ok(!KEY_RE.test(bad), JSON.stringify(bad));
    for (const good of ['DEX', 'dex', 'A1_b']) assert.ok(PROJECT_KEY.test(good), good);
    for (const bad of ['', '-p', 'D EX', 'DEX-1', '1DEX', 'DEX\n']) assert.ok(!PROJECT_KEY.test(bad), JSON.stringify(bad));
  });

  it('промпт сессии: только ключ', () => {
    const prompt = jiraPrompt('DEX-12');
    assert.match(prompt, /DEX-12/);
    assert.match(prompt, /jira issue view DEX-12/);
    assert.match(prompt, /Код не правь/);
  });
});

describe('Jira: отказы jira-cli', () => {
  it('классификация: вход, настройка, прочее', () => {
    assert.equal(problemOf('The tool needs a Jira API token to function'), 'auth');
    assert.equal(problemOf('Unauthorized (HTTP 401)'), 'auth');
    assert.equal(problemOf('stat /Users/x/.config/.jira/.config.yml: no such file or directory'), 'setup');
    assert.equal(problemOf('connection refused'), 'error');
  });

  it('текст отказа: stderr, без «Error:» и цвета, две строки; пусто - код выхода', () => {
    assert.equal(failureText({ stdout: '', stderr: '\u001b[31mError:\u001b[0m\n  ✗ Unauthorized\nвторая\nтретья', code: 1 }), 'Unauthorized вторая');
    assert.equal(failureText({ stdout: 'только stdout', stderr: '  ', code: 2 }), 'только stdout');
    assert.equal(failureText({ stdout: '', stderr: '', code: 3 }), 'jira завершился с кодом 3');
  });

  it('человеку - факт и команда', () => {
    assert.match(problemText('missing', ''), /brew .*install jira-cli/);
    assert.match(problemText('setup', 'нет файла'), /jira init/);
    assert.match(problemText('auth', '401'), /JIRA_API_TOKEN/);
    assert.match(problemText('error', 'сбой'), /сбой/);
  });
});

// ---------- настройки проекта и старт сессии ----------

describe('Jira: настройки проекта', () => {
  it('из файла: нет объекта - null; enabled только true; неверный ключ - пустой', () => {
    assert.equal(readJira(undefined), null);
    assert.equal(readJira([]), null);
    assert.deepEqual(readJira({ enabled: true, projects: ['DEX', 'sup', 'DEX'] }), { enabled: true, projects: ['DEX', 'SUP'] });
    assert.deepEqual(readJira({ enabled: true, project: 'DEX' }), { enabled: true, projects: ['DEX'] }, 'прежнее поле project - один проект');
    assert.deepEqual(readJira({ enabled: 'true', project: 'DEX-1' }), { enabled: false, projects: [] });
    assert.deepEqual(readJira({ enabled: true, projects: ['OK', 7, '--raw', 'A B'] }), { enabled: true, projects: ['OK'] }, 'неверные ключи отбрасываются');
    assert.equal(readJira({ enabled: true, projects: Array.from({ length: 30 }, (_, i) => `P${i}`) })!.projects.length, MAX_JIRA_PROJECTS);
  });

  it('при сохранении: нет поля - допустимо; неверная форма - отказ', () => {
    assert.equal(validateJira(undefined), undefined);
    assert.deepEqual(validateJira({ enabled: false, projects: [] }), { enabled: false, projects: [] });
    assert.deepEqual(validateJira({ enabled: true, projects: ['dex', 'SUP', 'DEX'], extra: 1 }), { enabled: true, projects: ['DEX', 'SUP'] }, 'верхний регистр, без повторов');
    assert.deepEqual(validateJira({ enabled: true, project: 'dex' }), { enabled: true, projects: ['DEX'] }, 'прежняя форма принимается');
    assert.deepEqual(validateJira({ enabled: true, project: '' }), { enabled: true, projects: [] });
    const many = Array.from({ length: MAX_JIRA_PROJECTS + 1 }, (_, i) => `P${i}`);
    for (const bad of [null, 'x', [], { enabled: 'yes', projects: [] }, { enabled: true }, { enabled: true, project: '-p' }, { enabled: true, project: 'A B' }, { enabled: true, projects: 'DEX' }, { enabled: true, projects: ['DEX', '-p'] }, { enabled: true, projects: [7] }, { enabled: true, projects: many }]) {
      assert.equal(validateJira(bad), null, JSON.stringify(bad));
    }
  });

  it('состояние проектов: jira проходит, лишнее не переносится, неверное отклоняет всё', () => {
    const base = { id: 'p', name: 'P', description: '', repos: ['/a'], trackers: { github: true, gitlab: false } };
    const withJira = validateProjectsState({ projects: [{ ...base, jira: { enabled: true, projects: ['DEX'], token: 'секрет' } }], lastProjectId: null })!;
    assert.deepEqual(withJira.projects[0].jira, { enabled: true, projects: ['DEX'] });
    assert.equal('jira' in validateProjectsState({ projects: [base], lastProjectId: null })!.projects[0], false, 'нет поля - остаётся без него');
    assert.equal(validateProjectsState({ projects: [{ ...base, jira: { enabled: true, projects: ['--raw'] } }], lastProjectId: null }), null);
  });

  it('сохранение отклоняет неверный ключ проекта и ничего не пишет', () => {
    let saved: ProjectsState | null = null;
    const store = { load: () => ({ projects: [], lastProjectId: null }), save: (s: ProjectsState) => void (saved = s) };
    const base = { id: 'p', name: 'P', description: '', repos: ['/a'], trackers: { github: false, gitlab: false } };
    assert.throws(() => saveProjectsState({ projects: [{ ...base, jira: { enabled: true, projects: ['a b'] } }], lastProjectId: null }, store, { resetAuth() {} }));
    assert.equal(saved, null);
  });
});

describe('Jira: старт сессии', () => {
  it('{ jira: { key } } даёт промпт по ключу; чужие поля игнорируются', () => {
    assert.equal(validateSessionStart({ jira: { key: 'DEX-12', summary: 'ignore me' } }), jiraPrompt('DEX-12'));
    assert.equal(validateJiraStart({ key: 'DEX-12' }), 'DEX-12');
  });

  it('ключ не по форме, лишний источник старта - отказ', () => {
    for (const bad of [{ jira: {} }, { jira: { key: 'dex-1' } }, { jira: { key: 'DEX-1\nrm -rf' } }, { jira: 'DEX-1' }, { jira: { key: 7 } }]) {
      assert.equal(validateSessionStart(bad), null, JSON.stringify(bad));
    }
    const ref = { kind: 'github', host: 'github.com', path: 'o/a', number: 1 };
    assert.equal(validateSessionStart({ jira: { key: 'DEX-1' }, task: ref }), null);
    assert.equal(validateSessionStart({ jira: { key: 'DEX-1' }, mr: ref, intent: 'review' }), null);
  });

  it('намерение ci: промпт про упавший пайплайн с адресом MR; прочие намерения прежние', () => {
    const ref = { kind: 'github' as const, host: 'github.com', path: 'o/a', number: 7 };
    assert.equal(mrPrompt(ref, 'ci'), 'Пайплайн MR https://github.com/o/a/pull/7 упал: найди причину в логах упавших заданий, переключись на ветку MR и исправь её.');
    assert.equal(validateSessionStart({ mr: ref, intent: 'ci' }), mrPrompt(ref, 'ci'));
    assert.equal(validateSessionStart({ mr: ref, intent: 'deploy' }), null);
    assert.match(mrPrompt(ref, 'review'), /^\/dex-auto:auto review /);
  });
});

// ---------- сервис ----------

const project: Project = { id: 'p1', name: 'P', description: '', repos: ['/w/a'], trackers: { github: false, gitlab: false }, jira: { enabled: true, projects: ['DEX'] } };
const projects = (...list: Project[]) => (): ProjectsState => ({ projects: list, lastProjectId: null });

function service(respond: (args: string[]) => CliResult | Promise<CliResult>, ...list: Project[]) {
  const calls: string[][] = [];
  const run: JiraRunner = async (cmd, args) => {
    assert.equal(cmd, 'jira');
    calls.push(args);
    return respond(args);
  };
  return { svc: new JiraService(run, projects(...(list.length ? list : [project]))), calls };
}

describe('Jira: сервис', () => {
  it('список: запрос с ключом проекта, ответ разобран, предел отмечен', async () => {
    const { svc, calls } = service(() => ok(JSON.stringify([listed('DEX-1'), listed('DEX-2')])));
    const res = await svc.list('p1', false);
    assert.deepEqual(res.issues.map((i) => i.key), ['DEX-1', 'DEX-2']);
    assert.equal(res.truncated, false);
    assert.equal(res.error, undefined);
    assert.deepEqual(calls, [jiraListArgs('DEX'), jiraProgressArgs('DEX')]);
    const full = service(() => ok(JSON.stringify(Array.from({ length: JIRA_LIMIT }, (_, i) => listed(`DEX-${i + 1}`)))));
    assert.equal((await full.svc.list('p1', false)).truncated, true);
  });

  it('категория: задачи из запроса «в работе» получают indeterminate, остальные - пусто; отказ второго запроса не ломает список', async () => {
    const respond = (progress: CliResult) => (args: string[]) => (args.includes('--raw') ? ok(JSON.stringify([listed('DEX-1'), listed('DEX-2')])) : progress);
    const res = await service(respond(ok('DEX-2\tIn Progress\n'))).svc.list('p1', false);
    assert.deepEqual(res.issues.map((i) => [i.key, i.category]), [['DEX-1', ''], ['DEX-2', 'indeterminate']]);
    const broken = await service(respond(fail('Unauthorized'))).svc.list('p1', false);
    assert.deepEqual(broken.issues.map((i) => i.category), ['', '']);
    assert.equal(broken.error, undefined);
  });

  it('ключи из plain-вывода: первое слово строки, не по форме пропускается', () => {
    assert.deepEqual([...parseKeys('DEX-1\nDEX-2  In Progress\n\nмусор\n--raw\n  DEX-3\t')], ['DEX-1', 'DEX-2', 'DEX-3']);
    assert.deepEqual([...parseKeys('')], []);
    assert.deepEqual(jiraProgressArgs('DEX').slice(0, 6), ['issue', 'list', '-q', 'assignee = currentUser() AND statusCategory = "In Progress"', '--plain', '--no-headers']);
  });

  it('проект без Jira или без включения - отказ без запуска; проекта нет - тоже', async () => {
    const off = { ...project, jira: { enabled: false, projects: [] } };
    const none = { ...project, jira: undefined };
    for (const p of [off, none]) {
      const { svc, calls } = service(() => ok('[]'), p);
      const res = await svc.list('p1', false);
      assert.match(res.error!, /выключена/);
      assert.equal(calls.length, 0);
    }
    const { svc, calls } = service(() => ok('[]'));
    assert.match((await svc.list('нет такого', false)).error!, /выключена/);
    assert.equal(calls.length, 0);
  });

  it('пустая выборка - не ошибка', async () => {
    const { svc } = service(() => fail('No result found for given query in project "DEX"'));
    assert.deepEqual(await svc.list('p1', false), { issues: [], truncated: false });
  });

  it('нет бинаря: причина с командой установки', async () => {
    const { svc } = service(() => ({ code: null, stdout: '', stderr: '', missing: true }));
    const res = await svc.list('p1', false);
    assert.equal(res.problem, 'missing');
    assert.match(res.error!, /brew .*install jira-cli/);
  });

  it('таймаут и переполнение вывода называются', async () => {
    assert.match((await service(() => ({ code: null, stdout: '', stderr: '', missing: false, failure: 'timeout' })).svc.list('p1', false)).error!, /не ответил/);
    assert.match((await service(() => ({ code: null, stdout: '', stderr: '', missing: false, failure: 'overflow' })).svc.list('p1', false)).error!, /слишком велик/);
  });

  it('не JSON - ошибка разбора, а не падение', async () => {
    const res = await service(() => ok('Привет, я не JSON')).svc.list('p1', false);
    assert.equal(res.problem, 'error');
    assert.match(res.error!, /не JSON/);
  });

  it('вход не принят: следующие опросы запроса не делают, пока нет recheck (защита от блокировки учётной записи)', async () => {
    let attempt = 0;
    const { svc, calls } = service(() => (attempt++ === 0 ? fail('Unauthorized') : ok(JSON.stringify([listed('DEX-1')]))));
    const first = await svc.list('p1', false);
    assert.equal(first.problem, 'auth');
    const second = await svc.list('p1', false);
    const third = await svc.list('p1', false);
    assert.equal(second.problem, 'auth');
    assert.equal(third.error, first.error);
    assert.equal(calls.length, 2, 'после отказа входа jira не вызывается: только два запроса первой попытки');
    const again = await svc.list('p1', true);
    assert.deepEqual(again.issues.map((i) => i.key), ['DEX-1']);
    assert.equal(calls.length, 4);
  });

  it('отказ не по входу не блокирует опрос', async () => {
    let attempt = 0;
    const { svc, calls } = service(() => (attempt++ === 0 ? fail('connection refused') : ok('[]')));
    assert.equal((await svc.list('p1', false)).problem, 'error');
    assert.equal((await svc.list('p1', false)).problem, undefined);
    assert.equal(calls.length, 4);
  });

  it('детали и адрес - только по задаче из последнего списка', async () => {
    const { svc, calls } = service((args) => {
      if (args[0] === 'issue' && args[1] === 'list') return ok(JSON.stringify([listed('DEX-12')]));
      if (args[0] === 'issue' && args[1] === 'view') return ok(JSON.stringify(viewed));
      if (args[0] === 'open') return ok('https://jira.example/browse/DEX-12\n');
      return fail('?');
    });
    const before = await svc.details('p1', 'DEX-12');
    assert.ok('problem' in before && /нет в списке/.test(before.error), 'до списка деталей нет');
    await svc.list('p1', false);
    const res = await svc.details('p1', 'DEX-12');
    assert.ok('details' in res);
    assert.equal(res.details.total, 5);
    assert.deepEqual(await svc.url('p1', 'DEX-12'), { url: 'https://jira.example/browse/DEX-12' });
    const foreign = await svc.details('p1', 'OTHER-1');
    assert.ok('problem' in foreign && /нет в списке/.test(foreign.error));
    assert.deepEqual(calls.filter((a) => a[0] === 'issue' && a[1] === 'view').length, 1, 'чужой ключ jira не доходит');
    for (const bad of ['--raw', 'DEX-12; ls', 7, undefined]) {
      const refused = await svc.details('p1', bad);
      assert.ok('problem' in refused && /Некорректный ключ/.test(refused.error), JSON.stringify(bad));
    }
    assert.deepEqual(await svc.url('p1', '--raw'), { error: 'Некорректный ключ задачи' });
  });

  it('адрес принимается только http(s)', async () => {
    const { svc } = service((args) => (args[0] === 'issue' ? ok(JSON.stringify([listed('DEX-1')])) : ok('file:///etc/passwd\njavascript:alert(1)\n')));
    await svc.list('p1', false);
    assert.deepEqual(await svc.url('p1', 'DEX-1'), { error: 'jira не назвал адрес задачи' });
  });

  it('проверка входа: нет бинаря, нет настройки, вход принят и снимает блокировку', async () => {
    assert.equal((await service(() => ({ code: null, stdout: '', stderr: '', missing: true })).svc.status()).state, 'missing');
    const setup = await service((args) => (args[0] === 'version' ? ok('Version="1.7.0"') : fail('stat /x/.config/.jira/.config.yml: no such file or directory'))).svc.status();
    assert.equal(setup.state, 'setup');
    const { svc } = service((args) => {
      if (args[0] === 'version') return ok('(Version="1.7.0", GitCommit="Homebrew")');
      if (args[0] === 'me') return ok('ivan@example.com\n');
      return fail('Unauthorized');
    });
    await svc.list('p1', false);
    assert.equal((await svc.list('p1', false)).problem, 'auth');
    assert.deepEqual(await svc.status(), { state: 'ready', login: 'ivan@example.com', version: '1.7.0' });
    assert.equal((await svc.list('p1', false)).problem, 'auth', 'после успешной проверки список снова запрашивается и снова получает отказ');
  });

  it('вход не принят в jira me: сообщение с токеном', async () => {
    const res = await service((args) => (args[0] === 'version' ? ok('Version="1.7.0"') : fail('The tool needs a Jira API token to function'))).svc.status();
    assert.equal(res.state, 'auth');
    assert.ok('message' in res && /JIRA_API_TOKEN/.test(res.message));
  });
});

// ---------- несколько проектов Jira ----------

const multi: Project = { ...project, jira: { enabled: true, projects: ['DEX', 'SUP'] } };

describe('Jira: проекты проекта', () => {
  it('таблица jira project list: ключ и название, заголовок и пустые колонки пропущены', () => {
    const table = 'KEY\tNAME\t\t\t\tTYPE\tLEAD\nAO\tA&A Oil\t\t\t\t\tMikhail\nACI\tACI\t\t\t\t\tСергей\nSUP\tТехническая поддержка\tsoftware\tИван\n\nмусор с пробелом\n--flag\n';
    assert.deepEqual(parseProjects(table), [
      { key: 'AO', name: 'A&A Oil' },
      { key: 'ACI', name: 'ACI' },
      { key: 'SUP', name: 'Техническая поддержка' },
    ]);
    assert.deepEqual(parseProjects(''), []);
    assert.deepEqual(parseProjects('\u001b[1mKEY\tNAME\u001b[0m\nab\tlower\n'), [{ key: 'AB', name: 'lower' }]);
    assert.deepEqual(jiraProjectsArgs(), ['project', 'list']);
  });

  it('подсказки: ключи из имён веток, только известные проекты, частые первыми', () => {
    const known = new Set(['DEX', 'SUP', 'MDM']);
    const branches = ['main', 'feature/dex-12-csv', 'DEX-13_fix', 'fix/SUP-7', 'chore/utf-8', 'release/v2-1', 'feature/xdex-1', 'dex-12-and-dex-13', 'mdm-1/sup-2'];
    assert.deepEqual(suggestKeys(branches, known), [
      { key: 'DEX', count: 3 },
      { key: 'SUP', count: 2 },
      { key: 'MDM', count: 1 },
    ]);
    assert.deepEqual(suggestKeys(branches, new Set()), []);
    assert.deepEqual(suggestKeys([], known), []);
  });

  it('время jira-cli', () => {
    assert.equal(timeOf('2026-10-25T12:30:00.000+0300'), Date.parse('2026-10-25T12:30:00.000+03:00'));
    assert.equal(timeOf('вчера'), 0);
  });

  it('несколько проектов: запрос и ключи «в работе» на каждый с -p, задачи слиты по давности, повторы убраны', async () => {
    const stamp = (n: number) => `2026-10-${20 + n}T10:00:00.000+0300`;
    const { svc, calls } = service((args) => {
      if (args.includes('--plain')) return ok('');
      const key = args[args.indexOf('-p') + 1];
      if (key === 'DEX') return ok(JSON.stringify([listed('DEX-1', { updated: stamp(1) }), listed('DEX-2', { updated: stamp(5) }), listed('SUP-9', { updated: stamp(3) })]));
      return ok(JSON.stringify([listed('SUP-9', { updated: stamp(3) }), listed('SUP-8', { updated: stamp(4) })]));
    }, multi);
    const res = await svc.list('p1', false);
    assert.deepEqual(res.issues.map((i) => i.key), ['DEX-2', 'SUP-8', 'SUP-9', 'DEX-1'], 'свежие первыми, SUP-9 один раз');
    assert.equal(res.notes, undefined);
    assert.deepEqual(
      calls.filter((a) => a.includes('--raw')).map((a) => a.at(-1)),
      ['DEX', 'SUP'],
      'по запросу на проект',
    );
    assert.equal(calls.filter((a) => a.includes('--plain')).length, 2);
  });

  it('общий предел: сверх пятидесяти задач срезаются, список помечен как неполный', async () => {
    const { svc } = service((args) => {
      if (args.includes('--plain')) return ok('');
      const key = args[args.indexOf('-p') + 1];
      return ok(JSON.stringify(Array.from({ length: 40 }, (_, i) => listed(`${key}-${i + 1}`))));
    }, multi);
    const res = await svc.list('p1', false);
    assert.equal(res.issues.length, JIRA_LIMIT);
    assert.equal(res.truncated, true);
  });

  it('один проект не ответил, другой ответил: список показан, причина названа с ключом', async () => {
    const { svc } = service((args) => {
      if (args.includes('--plain')) return ok('');
      return args.at(-1) === 'DEX' ? fail('project does not exist') : ok(JSON.stringify([listed('SUP-1')]));
    }, multi);
    const res = await svc.list('p1', false);
    assert.deepEqual(res.issues.map((i) => i.key), ['SUP-1']);
    assert.equal(res.error, undefined);
    assert.match(res.notes![0], /^DEX: jira-cli отказал: project does not exist/);
  });

  it('все проекты не ответили: ошибка первого с ключом; отказ входа остановит повторы', async () => {
    const { svc, calls } = service(() => fail('Unauthorized'), multi);
    const res = await svc.list('p1', false);
    assert.equal(res.problem, 'auth');
    assert.match(res.error!, /^(DEX|SUP): /);
    const before = calls.length;
    await svc.list('p1', false);
    assert.equal(calls.length, before, 'вход не принят - jira не вызывается');
  });

  it('детали задачи идут с -p её проекта, если он выбран; чужой префикс - без -p', async () => {
    const { svc, calls } = service((args) => {
      if (args[1] === 'list') return ok(JSON.stringify([listed('SUP-9'), listed('ZZZ-1')]));
      if (args[1] === 'view') return ok(JSON.stringify({ ...viewed, key: args[2] }));
      return ok('');
    }, multi);
    await svc.list('p1', false);
    await svc.details('p1', 'SUP-9');
    await svc.details('p1', 'ZZZ-1');
    const views = calls.filter((a) => a[1] === 'view');
    assert.deepEqual(views[0].slice(-2), ['-p', 'SUP']);
    assert.ok(!views[1].includes('-p'), 'проект ZZZ в настройках не выбран');
  });

  it('список проектов: разбор, кэш до recheck, отказ входа блокирует', async () => {
    let calls = 0;
    const table = 'KEY\tNAME\tTYPE\tLEAD\nDEX\tDex\tsoftware\tИ\nSUP\tSupport\tsoftware\tО\n';
    const { svc } = service((args) => {
      if (args[0] === 'project') {
        calls++;
        return ok(table);
      }
      return ok('[]');
    });
    const first = await svc.projects(false);
    assert.ok('projects' in first);
    assert.deepEqual(first.projects.map((p) => p.key), ['DEX', 'SUP']);
    await svc.projects(false);
    assert.equal(calls, 1, 'второй вызов из кэша');
    await svc.projects(true);
    assert.equal(calls, 2, 'recheck сбрасывает кэш');
    const denied = await service(() => fail('Unauthorized')).svc.projects(false);
    assert.ok('problem' in denied && denied.problem === 'auth');
    assert.ok('problem' in (await service(() => ({ code: null, stdout: '', stderr: '', missing: true })).svc.projects(false)));
  });

  it('подсказки сервиса: известные проекты из списка; без списка - пусто', async () => {
    const table = 'KEY\tNAME\nDEX\tDex\nSUP\tSupport\n';
    const { svc } = service((args) => (args[0] === 'project' ? ok(table) : ok('[]')));
    assert.deepEqual(await svc.suggest(['dex-1-a', 'utf-8', 'feature/SUP-2', 'sup-3']), [{ key: 'SUP', count: 2 }, { key: 'DEX', count: 1 }]);
    assert.deepEqual(await service(() => fail('Unauthorized')).svc.suggest(['dex-1']), []);
  });
});

describe('Jira: пустые настройки', () => {
  it('NO_JIRA - выключено и без ключа', () => {
    assert.deepEqual(NO_JIRA, { enabled: false, projects: [] });
  });
});
