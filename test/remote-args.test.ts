import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { branchNameProblem, validBranchName } from '../src/main/branch-name';
import { ProjectStore, type Project } from '../src/main/projects';
import { parsePreflight } from '../src/main/remote/preflight';
import { readSearchReply, REMOTE_FS_OPS, validateHumanRemoteCreate, validateRemoteCreate, validateRemoteFs } from '../src/main/remote/remote-args';
import { classifySshError, sshArgs, systemSsh } from '../src/main/remote/ssh';
import { MAX_TEXT_BYTES } from '../src/main/session-tools';
import { validateProjectsState } from '../src/main/trackers';

const project: Project = { id: 'p', name: 'n', description: '', repos: ['/r/a', '/r/b'], trackers: { github: false, gitlab: false }, hosts: ['dev1'] };
const ok = { host: 'dev1', repo: '/r/a', branch: 'feat/x' };

describe('validBranchName', () => {
  it('принимает допустимые имена', () => {
    for (const n of ['main', 'feat/x-1', 'release/1.2', 'a@b', 'я/ветка']) assert.equal(validBranchName(n), true, n);
  });
  it('отвергает недопустимые по check-ref-format и ведущий «-»', () => {
    for (const n of ['-x', 'a..b', 'x.lock', 'a/x.lock/b', '@', 'a//b', '/a', 'a/', 'a.', '.a', 'a/.b', 'a b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[', 'a\\b', 'a@{1}', 'a\nb', '', 'x'.repeat(256)])
      assert.notEqual(branchNameProblem(n), null, JSON.stringify(n));
    assert.equal(validBranchName(5), false);
  });
});

describe('validateRemoteCreate', () => {
  it('принимает хост, репозиторий и ветку проекта; пустое задание значит «без задания»', () => {
    assert.deepEqual(validateRemoteCreate(ok, project), ok);
    assert.deepEqual(validateRemoteCreate({ ...ok, prompt: '   ' }, project), ok);
    assert.deepEqual(validateRemoteCreate({ ...ok, prompt: ' сделай\x1b  ' }, project), { ...ok, prompt: 'сделай' });
  });
  it('отвергает подмену хоста и репозитория, плохую ветку, неизвестный проект', () => {
    assert.match(validateRemoteCreate({ ...ok, host: 'evil' }, project) as string, /хост не из списка/);
    assert.match(validateRemoteCreate(ok, { ...project, hosts: undefined }) as string, /хост не из списка/);
    assert.match(validateRemoteCreate({ ...ok, repo: '/etc' }, project) as string, /репозиторий/);
    assert.match(validateRemoteCreate({ ...ok, branch: '-x' }, project) as string, /«-»/);
    assert.match(validateRemoteCreate(ok, undefined) as string, /Некорректные аргументы remote:create/);
  });
  it('задание: «-» и «!» отвергаются, предел ровно 100000 байт принят, 100001 отвергнут', () => {
    assert.match(validateRemoteCreate({ ...ok, prompt: ' -x' }, project) as string, /«-»/);
    assert.match(validateRemoteCreate({ ...ok, prompt: '!ls' }, project) as string, /«!»/);
    assert.match(validateRemoteCreate({ ...ok, prompt: '\x01!ls' }, project) as string, /«!»/);
    assert.match(validateRemoteCreate({ ...ok, prompt: '\x1b -x' }, project) as string, /«-»/);
    assert.equal(typeof validateRemoteCreate({ ...ok, prompt: 'a'.repeat(MAX_TEXT_BYTES) }, project), 'object');
    assert.match(validateRemoteCreate({ ...ok, prompt: 'a'.repeat(MAX_TEXT_BYTES + 1) }, project) as string, /байт/);
  });
});

describe('validateHumanRemoteCreate', () => {
  it('задание из интерфейса не принимается: человек пишет его в терминал сам', () => {
    assert.deepEqual(validateHumanRemoteCreate({ ...ok, prompt: 'сделай' }, project), ok);
  });
  it('проверки хоста, репозитория и ветки те же', () => {
    assert.match(validateHumanRemoteCreate({ ...ok, host: 'evil' }, project) as string, /хост не из списка/);
    assert.match(validateHumanRemoteCreate({ ...ok, branch: '-x' }, project) as string, /«-»/);
    assert.match(validateHumanRemoteCreate(null, project) as string, /Некорректные аргументы remote:create/);
  });
});

describe('sshArgs и classifySshError', () => {
  it('BatchMode и ConnectTimeout заданы, «--» стоит перед алиасом', () => {
    const a = sshArgs('dev1', 'sh -s', ['-R', '/s:127.0.0.1:1']);
    assert.ok(a.includes('BatchMode=yes') && a.includes('ConnectTimeout=15'));
    assert.deepEqual(a.slice(-3), ['--', 'dev1', 'sh -s']);
  });
  it('типовые строки stderr дают свою причину', () => {
    assert.match(classifySshError('user@h: Permission denied (publickey).'), /ssh-agent/);
    assert.match(classifySshError('Host key verification failed.'), /ключ хоста/);
    assert.match(classifySshError('ssh: Could not resolve hostname x'), /алиас/);
    assert.match(classifySshError('Connection timed out'), /15 с/);
    assert.match(classifySshError('Warning: remote port forwarding failed for listen path'), /AllowStreamLocalForwarding/);
    assert.equal(classifySshError('a\n' + 'z'.repeat(400)).length, 300);
  });
});

describe('parsePreflight', () => {
  const good = 'home=/home/u\nnode=v20.1.0\ngit=/usr/bin/git\nclaude=/bin/claude\nscript=/usr/bin/script\nauth={"loggedIn":true}\n';
  const none = { gh: false, glab: false };
  it('установленные версии агента берутся из строки agentd', () => assert.deepEqual(parsePreflight(good + 'agentd=aaa bbb \n'), { home: '/home/u', installed: ['aaa', 'bbb'], tools: none }));
  it('хост в порядке - домашний каталог', () => assert.deepEqual(parsePreflight(good), { home: '/home/u', installed: [], tools: none }));
  it('gh и glab на хосте - признаки, а не условие запуска', () => {
    assert.deepEqual(parsePreflight(good + 'gh=/usr/bin/gh\nglab=\n'), { home: '/home/u', installed: [], tools: { gh: true, glab: false } });
    assert.deepEqual(parsePreflight(good + 'glab=/usr/local/bin/glab\n'), { home: '/home/u', installed: [], tools: { gh: false, glab: true } });
  });
  it('называет все недостающие инструменты разом', () => {
    assert.deepEqual(parsePreflight('home=/h\nnode=v16.0.0\ngit=\nclaude=\nscript=/s\n'), { missing: ['на хосте нет: node ≥ 18, git, claude'] });
  });
  it('хост не Linux - отказ с причиной до проверки инструментов', () => {
    assert.deepEqual(parsePreflight('uname=Darwin\n' + good), { missing: ['хост не Linux (Darwin): нужны script и stty из util-linux'] });
    assert.deepEqual(parsePreflight('uname=Linux\n' + good), { home: '/home/u', installed: [], tools: none });
  });
  it('не залогинен: loggedIn не true, не-JSON, пусто', () => {
    for (const auth of ['{"loggedIn":false}', 'oops', '']) assert.match((parsePreflight(good.replace('{"loggedIn":true}', auth)) as { missing: string[] }).missing[0], /не залогинен[\s\S]*Вход Claude на хостах/);
  });
  it('с токеном Claude вход на хосте не нужен', () => {
    assert.deepEqual(parsePreflight(good.replace('{"loggedIn":true}', '{"loggedIn":false}'), true), { home: '/home/u', installed: [], tools: none });
  });
});

describe('remote:fs из интерфейса', () => {
  it('операции только читающие: правка и смена ветки отвергаются, как и номер не числом', () => {
    for (const op of REMOTE_FS_OPS) assert.deepEqual(validateRemoteFs(3, op), { id: 3, op });
    for (const op of ['write', 'switch', 'delete', 'exec', '', undefined, 5]) assert.equal(validateRemoteFs(3, op), null, String(op));
    assert.equal(validateRemoteFs('3', 'list'), null);
    assert.deepEqual([...REMOTE_FS_OPS], ['list', 'read', 'root', 'branch', 'status', 'head', 'files']);
  });
});

describe('hosts проекта', () => {
  const base = { id: '1', name: 'n', description: 'd', repos: ['/a'], trackers: { github: false, gitlab: false } };
  it('сохранение: ведущий «-», пробел, управляющий символ, не строка - отказ; без поля - как прежде', () => {
    for (const h of ['-oProxyCommand=x', 'a b', 'a\x01', '\x01a', '\x7fa', '\u009bx', 'a\u0085', '\u0085a', 'a\u202e', '\u200ex', '', 'a'.repeat(256), 5]) assert.equal(validateProjectsState({ projects: [{ ...base, hosts: [h] }], lastProjectId: null }), null, String(h));
    assert.equal(validateProjectsState({ projects: [{ ...base, hosts: 'x' }], lastProjectId: null }), null);
    assert.equal(validateProjectsState({ projects: [{ ...base, hosts: Array(33).fill('h') }], lastProjectId: null }), null);
    assert.notEqual(validateProjectsState({ projects: [{ ...base, hosts: Array(32).fill('h') }], lastProjectId: null }), null);
    assert.deepEqual(validateProjectsState({ projects: [base], lastProjectId: null })?.projects[0], base);
    assert.deepEqual(validateProjectsState({ projects: [{ ...base, hosts: ['u@h', 'u@h', 'b'] }], lastProjectId: null })?.projects[0].hosts, ['u@h', 'b']);
  });
  it('загрузка: мусор отброшен, повторы сняты', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-hosts-'));
    const file = path.join(dir, 'projects.json');
    fs.writeFileSync(file, JSON.stringify({ projects: [{ ...base, hosts: ['a', 'a', '-x', 7, 'b c', 'd'] }], lastProjectId: null }));
    assert.deepEqual(new ProjectStore(file).load().projects[0].hosts, ['a', 'd']);
    fs.rmSync(dir, { recursive: true });
  });
});

describe('systemSsh: закрытие канала', () => {
  it('строка, записанная перед close, доходит до хоста: канал закрывается EOF, а не SIGTERM', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-ssh-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const out = path.join(dir, 'got');
    // Как OpenSSH: по SIGTERM выходит сразу, а stdin читает не мгновенно.
    const fake = `#!${process.execPath}\nprocess.on('SIGTERM', () => process.exit(0));\nsetTimeout(() => { let d = ''; process.stdin.on('data', (c) => (d += c)); process.stdin.on('end', () => { require('fs').writeFileSync(${JSON.stringify(out)}, d); process.exit(0); }); }, 300);\n`;
    fs.writeFileSync(path.join(dir, 'ssh'), fake, { mode: 0o755 });
    const saved = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${saved}`;
    t.after(() => void (process.env.PATH = saved));
    const channel = systemSsh.open('dev1', 'sh connect.sh', []);
    const exited = new Promise((resolve) => channel.onExit(resolve));
    channel.write('{"type":"ack","sid":"s1"}');
    channel.close();
    await exited;
    assert.equal(fs.readFileSync(out, 'utf8'), '{"type":"ack","sid":"s1"}\n');
  });
});


describe('ответ поиска с хоста', () => {
  it('абсолютный путь, «..», номер не целым и мусор отброшены; признаки и ошибка переносятся; попаданий не больше предела', () => {
    const reply = readSearchReply({
      hits: [
        { rel: 'a.ts', line: 3, text: 'x'.repeat(5000), range: { start: 1, end: 2 }, sign: '+' },
        { rel: '/etc/passwd', line: 1, text: '' },
        { rel: 'a/../../b', line: 1, text: '' },
        { rel: 'b.ts', line: 1.5, text: '' },
        { rel: 'c.ts', line: 2, text: 't', range: { start: -1, end: 0 }, sign: '*' },
        null,
      ],
      truncated: true,
      cancelled: true,
      error: 'e'.repeat(900),
    });
    assert.deepEqual(reply.hits.map((h) => [h.rel, h.line, h.range, h.sign, h.text.length]), [
      ['a.ts', 3, { start: 1, end: 2 }, '+', 1000],
      ['c.ts', 2, null, undefined, 1],
    ]);
    assert.equal(reply.truncated, true);
    assert.equal(reply.cancelled, true);
    assert.equal(reply.error?.length, 500);
    assert.equal(readSearchReply({ hits: Array(900).fill({ rel: 'a', line: 1, text: '' }) }).hits.length, 500);
    assert.deepEqual(readSearchReply('мусор'), { hits: [], truncated: false });
  });
});
