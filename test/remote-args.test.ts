import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { branchNameProblem, validBranchName } from '../src/main/branch-name';
import { ProjectStore, type Project } from '../src/main/projects';
import { parsePreflight } from '../src/main/remote/preflight';
import { validateRemoteCreate } from '../src/main/remote/remote-args';
import { classifySshError, sshArgs } from '../src/main/remote/ssh';
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
    assert.equal(typeof validateRemoteCreate({ ...ok, prompt: 'a'.repeat(MAX_TEXT_BYTES) }, project), 'object');
    assert.match(validateRemoteCreate({ ...ok, prompt: 'a'.repeat(MAX_TEXT_BYTES + 1) }, project) as string, /байт/);
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
  it('установленные версии агента берутся из строки agentd', () => assert.deepEqual(parsePreflight(good + 'agentd=aaa bbb \n'), { home: '/home/u', installed: ['aaa', 'bbb'] }));
  it('хост в порядке - домашний каталог', () => assert.deepEqual(parsePreflight(good), { home: '/home/u', installed: [] }));
  it('называет все недостающие инструменты разом', () => {
    assert.deepEqual(parsePreflight('home=/h\nnode=v16.0.0\ngit=\nclaude=\nscript=/s\n'), { missing: ['на хосте нет: node ≥ 18, git, claude'] });
  });
  it('не залогинен: loggedIn не true, не-JSON, пусто', () => {
    for (const auth of ['{"loggedIn":false}', 'oops', '']) assert.match((parsePreflight(good.replace('{"loggedIn":true}', auth)) as { missing: string[] }).missing[0], /не залогинен/);
  });
});

describe('hosts проекта', () => {
  const base = { id: '1', name: 'n', description: 'd', repos: ['/a'], trackers: { github: false, gitlab: false } };
  it('сохранение: ведущий «-», пробел, управляющий символ, не строка - отказ; без поля - как прежде', () => {
    for (const h of ['-oProxyCommand=x', 'a b', 'a\x01', 5]) assert.equal(validateProjectsState({ projects: [{ ...base, hosts: [h] }], lastProjectId: null }), null, String(h));
    assert.equal(validateProjectsState({ projects: [{ ...base, hosts: 'x' }], lastProjectId: null }), null);
    assert.equal(validateProjectsState({ projects: [{ ...base, hosts: Array(33).fill('h') }], lastProjectId: null }), null);
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
