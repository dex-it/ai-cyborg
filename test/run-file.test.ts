import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AllowedPaths } from '../src/main/allowed-paths';
import { RunApprovals } from '../src/main/run-approvals';
import { createRunHandlers, displayCommand, registerRunChannels, runChannel, runConfirm, runnableOf, warningText, writeEnvFile, type RunReply, type Tell, type RunDeps, type RunWarning } from '../src/main/run-file';
import { shellQuote, shQuote } from '../src/shared/shell-quote';
import { shQuote as agentdShQuote } from '../src/agentd/protocol';
import { findTerminal, launcherFor, launchAndWait, RUN_SCRIPT, terminalLaunch, TERMINALS } from '../src/main/run-terminal';
import { addRunButton, RUN_LABEL } from '../src/renderer/run-button';
import { INHERITED_SESSION_VARS } from '../src/main/sessions';

let base: string;
beforeEach(() => void (base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-run-')))));
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

const isRoot = process.getuid?.() === 0;
const write = (name: string, content: string | Buffer, mode = 0o644): string => {
  const file = path.join(base, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  fs.chmodSync(file, mode);
  return file;
};

describe('runnableOf', () => {
  it('бит исполнения: запускается сам файл', { skip: isRoot }, async () => {
    const f = write('a.txt', 'x', 0o755);
    assert.deepEqual(await runnableOf(f), [f]);
  });

  it('бит и shebang: исполняет ядро, argv - сам файл', { skip: isRoot }, async () => {
    const f = write('a', '#!/bin/sh\n', 0o755);
    assert.deepEqual(await runnableOf(f), [f]);
  });

  it('без бита, shebang: интерпретатор из shebang', async () => {
    const f = write('a', '#!/usr/bin/env python3\nprint(1)\n');
    assert.deepEqual(await runnableOf(f), ['/usr/bin/env', 'python3', f]);
  });

  it('shebang с аргументами - один аргумент, как в Linux', async () => {
    const f = write('a', '#!/bin/bash -e -x\n');
    assert.deepEqual(await runnableOf(f), ['/bin/bash', '-e -x', f]);
  });

  it('shebang из одной строки без перевода строки', async () => {
    const f = write('a', '#!/bin/sh');
    assert.deepEqual(await runnableOf(f), ['/bin/sh', f]);
  });

  it('негодный shebang: относительный, пустой, управляющие символы, не UTF-8, длинный', async () => {
    for (const [i, head] of ['#!python3\n', '#!\n', '#!/bin/sh\r\n', '#!/bin/sh\t-e\n', '#!/bin/sh\u202e\n'].entries()) {
      assert.equal(await runnableOf(write(`s${i}.sh`, head)), null, JSON.stringify(head));
    }
    assert.equal(await runnableOf(write('bin.sh', Buffer.from([0x23, 0x21, 0x2f, 0xff, 0xfe, 0x0a]))), null);
    assert.equal(await runnableOf(write('long.sh', `#!/${'a'.repeat(300)}\n`)), null);
  });

  it('вторая строка с #! не читается', async () => {
    const f = write('a', '#!/bin/sh\n#!/bin/evil\n');
    assert.deepEqual(await runnableOf(f), ['/bin/sh', f]);
  });

  it('без бита и shebang - по расширению', async () => {
    for (const [name, cmd] of [['a.sh', 'bash'], ['a.py', 'python3'], ['a.js', 'node'], ['a.mjs', 'node'], ['a.cjs', 'node'], ['A.CJS', 'node']]) {
      const f = write(name, 'x');
      assert.deepEqual(await runnableOf(f), [cmd, f], name);
    }
  });

  it('.ts, .txt, без расширения и каталог - не запускаются', async () => {
    for (const name of ['a.ts', 'a.txt', 'Makefile']) assert.equal(await runnableOf(write(name, 'x')), null, name);
    const dir = path.join(base, 'dir.sh');
    fs.mkdirSync(dir);
    fs.chmodSync(dir, 0o755);
    assert.equal(await runnableOf(dir), null);
  });

  it('имя с переводом строки - не запускаемый', async () => {
    assert.equal(await runnableOf(write('a\nb.sh', 'x')), null);
  });

  it('двоичный файл больше 5 МБ с битом - запускаемый, без бита - нет', { skip: isRoot }, async () => {
    const big = write('big', Buffer.alloc(6 * 1024 * 1024), 0o755);
    assert.deepEqual(await runnableOf(big), [big]);
    assert.equal(await runnableOf(write('big2', Buffer.alloc(6 * 1024 * 1024))), null);
  });
});

describe('RunApprovals', () => {
  const H1 = 'a'.repeat(64);
  const H2 = 'b'.repeat(64);
  const A1 = { sha256: H1, command: ['bash', '/x'] };
  const A2 = { sha256: H2, command: ['/x'] };

  it('нет записи, тот же хэш, другой хэш заменяет прежний', () => {
    const a = new RunApprovals(path.join(base, 'ap.json'));
    assert.equal(a.get('/x'), undefined);
    assert.equal(a.set('/x', A1), true);
    assert.deepEqual(a.get('/x'), A1);
    a.set('/x', A2);
    assert.deepEqual(a.get('/x'), A2);
    assert.equal(fs.readFileSync(a.file, 'utf8').includes(H1), false);
  });

  it('переживает пересоздание', () => {
    new RunApprovals(path.join(base, 'ap.json')).set('/x', A1);
    assert.deepEqual(new RunApprovals(path.join(base, 'ap.json')).get('/x'), A1);
  });

  it('битый файл, не объект, плохие записи - пусто', () => {
    const file = path.join(base, 'ap.json');
    const a = new RunApprovals(file);
    for (const text of ['{oops', '[]', 'null', '"x"']) {
      fs.writeFileSync(file, text);
      assert.equal(a.get('/x'), undefined, text);
    }
    fs.writeFileSync(file, JSON.stringify({ '/x': { sha256: 'zz', command: ['a'] }, rel: A1, '/y': A1, '/old': H1, '/nocmd': { sha256: H1, command: [] }, '/badcmd': { sha256: H1, command: [1] } }));
    for (const key of ['/x', 'rel', '/old', '/nocmd', '/badcmd']) assert.equal(a.get(key), undefined, key);
    assert.deepEqual(a.get('/y'), A1);
    a.set('/z', A2);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))), ['/y', '/z']);
  });

  it('сбой записи: false, не бросает', () => {
    const dir = path.join(base, 'ap.json');
    fs.mkdirSync(dir);
    const a = new RunApprovals(dir);
    const log = console.error;
    console.error = () => undefined;
    try {
      assert.equal(a.set('/x', A1), false);
    } finally {
      console.error = log;
    }
    assert.equal(a.get('/x'), undefined);
  });

  it('предел 1000 записей вытесняет самую давнюю', () => {
    const a = new RunApprovals(path.join(base, 'ap.json'));
    for (let i = 0; i < 1001; i++) a.set(`/f${i}`, A1);
    assert.equal(a.get('/f0'), undefined);
    assert.deepEqual(a.get('/f1000'), A1);
  });
});

describe('findTerminal и terminalLaunch', () => {
  const have = (...files: string[]) => (f: string) => files.includes(f);

  it('первый найденный по порядку перечня', () => {
    assert.equal(findTerminal({ PATH: '/a:/b' }, have('/b/konsole', '/a/xterm', '/b/gnome-terminal')), '/b/gnome-terminal');
  });

  it('$TERMINAL первым, по имени и по абсолютному пути; ненайденный пропускается', () => {
    assert.equal(findTerminal({ PATH: '/a', TERMINAL: 'kitty' }, have('/a/kitty', '/a/x-terminal-emulator')), '/a/kitty');
    assert.equal(findTerminal({ PATH: '/a', TERMINAL: '/opt/t' }, have('/opt/t', '/a/xterm')), '/opt/t');
    assert.equal(findTerminal({ PATH: '/a', TERMINAL: 'foot -e' }, have('/a/xterm')), '/a/xterm');
    assert.equal(findTerminal({ PATH: '/a', TERMINAL: 'rel/t' }, have('rel/t')), null);
  });

  it('относительные и пустые каталоги PATH пропускаются', () => {
    assert.equal(findTerminal({ PATH: ':rel:/a' }, have('rel/xterm', 'xterm', '/a/xterm')), '/a/xterm');
    assert.equal(findTerminal({}, () => true), null);
  });

  it('ни одного: сообщение с перечнем и подсказкой про TERMINAL', () => {
    const r = terminalLaunch('linux', { PATH: '/a', TERMINAL: 'mine' }, '/d', ['/d/f'], () => false);
    assert.ok('error' in r);
    for (const name of TERMINALS) assert.ok(r.error.includes(name), name);
    assert.match(r.error, /TERMINAL/);
    assert.match(r.error, /mine/);
  });

  it('форма передачи команды по эмулятору, argv поэлементно', () => {
    const forms: Record<string, string[]> = {
      'gnome-terminal': ['--'],
      konsole: ['-e'],
      alacritty: ['-e'],
      xterm: ['-e'],
      'xfce4-terminal': ['-x'],
      kitty: [],
      foot: [],
      wezterm: ['start', '--'],
    };
    for (const [name, head] of Object.entries(forms)) {
      const r = terminalLaunch('linux', { PATH: '/a', SHELL: '/bin/zsh' }, '/d', ['/d/f'], have(`/a/${name}`));
      assert.deepEqual(r, { cmd: `/a/${name}`, args: [...head, '/bin/zsh', '-lc', RUN_SCRIPT, 'cyborg-run', '', '/d', '/d/f'] }, name);
    }
  });

  it('логин-оболочка не семейства sh - отказ с её именем на обеих ОС, эмулятор не ищется', () => {
    for (const shell of ['/usr/bin/fish', '/bin/tcsh', '/bin/csh']) {
      for (const platform of ['linux', 'darwin'] as const) {
        const r = terminalLaunch(platform, { PATH: '/a', SHELL: shell }, '/d', ['/d/f'], have('/a/xterm'));
        assert.ok('error' in r && r.error.includes(`Логин-оболочка ${path.basename(shell)} `), JSON.stringify(r));
      }
    }
    assert.ok('args' in terminalLaunch('darwin', { SHELL: '/bin/zsh' }, '/d', ['/d/f']));
    assert.ok('args' in terminalLaunch('linux', { PATH: '/a', SHELL: '/usr/bin/dash' }, '/d', ['/d/f'], have('/a/xterm')));
  });

  it('SHELL не задан - /bin/bash', () => {
    const r = terminalLaunch('linux', { PATH: '/a' }, '/d', ['/d/f'], have('/a/xterm'));
    assert.ok('args' in r);
    assert.equal(r.args[1], '/bin/bash');
  });

  it('darwin: скрипт AppleScript постоянен, каталог и файл - отдельными элементами', () => {
    const file = "/we ir'd $x; d/a b'$(touch PWNED);c.sh";
    const r = terminalLaunch('darwin', {}, path.dirname(file), ['bash', file]);
    assert.ok('args' in r);
    assert.equal(r.cmd, 'osascript');
    assert.deepEqual(r.args.slice(-7), ['-c', RUN_SCRIPT, 'cyborg-run', '', path.dirname(file), 'bash', file]);
    assert.equal(r.args.filter((a) => a.includes('PWNED')).length, 1);
  });

  it('darwin: обратная косая черта в каталоге или команде - отказ, linux её пропускает', () => {
    for (const [dir, command] of [['/d', ['bash', "/d/a\\';touch PWNED;'.sh"]], ['/d\\', ['/d\\/f']], ['/d', ['/bin/sh', 'a\\b', '/d/f']]] as const) {
      const r = terminalLaunch('darwin', {}, dir, [...command]);
      assert.ok('error' in r && /обратной косой чертой/.test(r.error), JSON.stringify(r));
    }
    assert.ok('args' in terminalLaunch('linux', { PATH: '/a' }, '/d', ['/d/a\\b'], have('/a/xterm')));
  });

  it('x-terminal-emulator - ссылка: форма по имени цели, не по имени ссылки', () => {
    const bin = path.join(base, 'bin');
    fs.mkdirSync(bin);
    for (const [target, head] of [['kitty', []], ['wezterm', ['start', '--']], ['gnome-terminal', ['--']]] as const) {
      const real = write(`real/${target}`, '', 0o755);
      const link = path.join(bin, 'x-terminal-emulator');
      fs.rmSync(link, { force: true });
      fs.symlinkSync(real, link);
      const r = terminalLaunch('linux', { PATH: bin, SHELL: '/bin/sh' }, '/d', ['/d/f'], (f) => f === link);
      assert.deepEqual(r, { cmd: link, args: [...head, '/bin/sh', '-lc', RUN_SCRIPT, 'cyborg-run', '', '/d', '/d/f'] }, target);
    }
  });

  it('win32 - не поддерживается', () => {
    assert.ok('error' in terminalLaunch('win32', {}, '/d', ['x']));
  });
});

describe('RUN_SCRIPT', () => {
  const sh = (dir: string, command: string[], env: NodeJS.ProcessEnv = {}, envFile = '') =>
    spawnSync('bash', ['-c', RUN_SCRIPT, 'cyborg-run', envFile, dir, ...command], { input: '', encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });

  it('unset всех переменных сессии', () => {
    for (const name of [...INHERITED_SESSION_VARS, 'CYBORG_EVENTS', 'CYBORG_SETTINGS']) assert.ok(RUN_SCRIPT.includes(name), name);
    assert.equal(RUN_SCRIPT.includes("'"), false);
    assert.equal(RUN_SCRIPT.includes('\\'), false);
  });

  it('код выхода и приглашение; переменные сессии вычищены; каталог - каталог файла', () => {
    const f = write('x/e.sh', 'echo "cwd=$PWD claude=${CLAUDECODE-unset}"\nexit 3\n');
    const r = sh(path.dirname(f), ['bash', f], { CLAUDECODE: '1' });
    assert.match(r.stdout, /\[Код выхода 3\] Нажмите Enter/);
    assert.match(r.stdout, new RegExp(`cwd=${path.dirname(f)} claude=unset`));
  });

  it('имя файла и каталога со спецсимволами: исполняется этот файл, текст из имени - нет', () => {
    const dirName = `we ir'd $x; d`;
    const f = write(path.join(dirName, `a b'$(touch PWNED);c.sh`), 'echo ran-ok\n');
    const dir = path.join(base, dirName);
    const r = sh(dir, ['bash', f]);
    assert.match(r.stdout, /ran-ok/);
    assert.equal(fs.existsSync(path.join(dir, 'PWNED')), false);
  });

  it('Ctrl-C завершает файл, но не оболочку: код 130 и ожидание Enter (под pty)', { skip: spawnSync('python3', ['--version']).status !== 0 }, () => {
    const probe = [
      'import os, pty, select, sys, time',
      'script, cwd = sys.argv[1], sys.argv[2]',
      'pid, fd = pty.fork()',
      'if pid == 0:',
      "    os.execvp('bash', ['bash', '-c', script, 'cyborg-run', '', cwd, 'bash', '-c', 'echo started; sleep 30'])",
      "out = b''",
      'def pump(marker):',
      '    global out',
      '    end = time.time() + 8',
      '    while marker not in out and time.time() < end:',
      '        if select.select([fd], [], [], 0.1)[0]:',
      '            try:',
      '                chunk = os.read(fd, 4096)',
      '            except OSError:',
      '                return',
      '            if not chunk:',
      '                return',
      '            out += chunk',
      "pump(b'started')",
      "os.write(fd, b'\\x03')",
      "pump('Enter'.encode())",
      'alive = os.waitpid(pid, os.WNOHANG)[0] == 0',
      "os.write(fd, b'\\n') if alive else None",
      'closed = False',
      'end = time.time() + 8',
      // На macOS процесс не выйдет, пока его вывод из pty не вычитан.
      'while alive and not closed and time.time() < end:',
      '    if select.select([fd], [], [], 0.1)[0]:',
      '        try:',
      '            os.read(fd, 4096)',
      '        except OSError:',
      '            pass',
      '    closed = os.waitpid(pid, os.WNOHANG)[0] != 0',
      "sys.stdout.write(out.decode('utf8', 'replace') + '\\nALIVE=%s CLOSED=%s' % (alive, closed))",
    ].join('\n');
    const r = spawnSync('python3', ['-I', '-c', probe, RUN_SCRIPT, base], { encoding: 'utf8', timeout: 30_000, env: { PATH: process.env.PATH } });
    assert.match(r.stdout, /\[Код выхода 130\]/, r.stdout + r.stderr);
    assert.match(r.stdout, /ALIVE=True CLOSED=True/);
  });

  it('файл окружения читается до запуска и удаляется вместе с каталогом; снятая переменная у команды отсутствует', () => {
    const overlay = { set: new Map([['MANAGED_A', "va'l $x"]]), unset: new Set(['GONE_B']) };
    const env = writeEnvFile(overlay, base);
    assert.ok(env);
    const r = sh(base, ['bash', '-c', 'echo "a=$MANAGED_A b=${GONE_B-unset}"'], { GONE_B: 'inherited' }, env.file);
    assert.match(r.stdout, /a=va'l \$x b=unset/);
    assert.equal(fs.existsSync(env.file), false);
    assert.equal(fs.existsSync(path.dirname(env.file)), false);
    env.remove();
  });

  it('каталога нет - сообщение, не запуск', () => {
    const r = sh(path.join(base, 'gone'), ['bash', '-c', 'echo ran']);
    assert.match(r.stdout, /Каталог недоступен/);
    assert.doesNotMatch(r.stdout, /ran\n/);
  });
});

describe('warningText', () => {
  const p: RunWarning = { file: "/d/a b'c.sh", dir: '/d', command: ['bash', "/d/a b'c.sh"], changed: false };

  it('путь, точная команда, права пользователя и риск изменения или удаления', () => {
    const { detail } = warningText(p);
    assert.ok(detail.includes("Файл: /d/a b'c.sh"));
    assert.ok(detail.includes(`Команда: bash '/d/a b'\\''c.sh'`));
    assert.match(detail, /правами вашего пользователя/);
    assert.match(detail, /изменить или удалить/);
    assert.doesNotMatch(detail, /изменён с прошлого одобрения/);
  });

  it('изменённый файл помечен', () => {
    assert.match(warningText({ ...p, changed: true }).detail, /Файл изменён с прошлого одобрения/);
  });

  it('displayCommand: простые элементы без кавычек', () => {
    assert.equal(displayCommand(['/usr/bin/env', 'python3', '/d/a.py']), '/usr/bin/env python3 /d/a.py');
  });
});

describe('createRunHandlers', () => {
  let repo: string;
  let confirms: RunWarning[];
  let launches: { cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }[];
  let answer: boolean | (() => boolean | Promise<boolean>);
  let approvals: RunApprovals;
  let allowed: AllowedPaths;

  const handlers = (extra: Partial<RunDeps> = {}) =>
    createRunHandlers({
      allowed,
      approvals,
      confirm: async (w) => {
        confirms.push(w);
        return typeof answer === 'function' ? answer() : answer;
      },
      launch: async (cmd, args, { cwd, env }) => {
        launches.push({ cmd, args, cwd, env });
        return {};
      },
      platform: 'linux',
      env: { PATH: '/t', SHELL: '/bin/bash' },
      isExec: (f) => f === '/t/xterm',
      ...extra,
    });

  beforeEach(() => {
    repo = path.join(base, 'repo');
    fs.mkdirSync(repo);
    confirms = [];
    launches = [];
    answer = true;
    approvals = new RunApprovals(path.join(base, 'userData', 'ap.json'));
    fs.mkdirSync(path.join(base, 'userData'));
    allowed = new AllowedPaths(() => [repo]);
  });

  const script = (content = 'echo hi\n') => write('repo/s.sh', content);

  it('неодобренный: предупреждение, одобрение сохранено, запуск с cwd и чистым env', async () => {
    const f = script();
    process.env.CLAUDECODE = '1';
    try {
      assert.deepEqual(await handlers().run(f), { ok: true });
    } finally {
      delete process.env.CLAUDECODE;
    }
    assert.equal(confirms.length, 1);
    assert.equal(confirms[0].changed, false);
    assert.deepEqual(confirms[0].command, ['bash', f]);
    assert.equal(launches.length, 1);
    assert.equal(launches[0].cwd, repo);
    assert.equal(launches[0].cmd, '/t/xterm');
    assert.equal('CLAUDECODE' in launches[0].env, false);
    assert.match(fs.readFileSync(approvals.file, 'utf8'), /[0-9a-f]{64}/);
  });

  describe('управляемое окружение терминала', () => {
    const overlay = { set: new Map([['ENVT_SECRET', "tok'en $1"]]), unset: new Set(['ENVT_GONE']) };
    let tmp: string;
    beforeEach(() => {
      tmp = path.join(base, 'tmp');
      fs.mkdirSync(tmp);
    });
    const envFileOf = (args: string[]): string => args[args.indexOf('cyborg-run') + 1];

    it('файл окружения 0600 в каталоге 0700 передан скрипту первым аргументом; значение в argv не попадает', async () => {
      const f = script();
      assert.deepEqual(await handlers({ overlay: () => overlay, tmpDir: tmp }).run(f), { ok: true });
      const file = envFileOf(launches[0].args);
      assert.equal(path.dirname(path.dirname(file)), tmp);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
      const text = fs.readFileSync(file, 'utf8');
      assert.match(text, /^unset ENVT_GONE$/m);
      assert.ok(text.includes(`export ENVT_SECRET=${shQuote("tok'en $1")}`));
      assert.equal(launches[0].args.join(' ').includes('tok'), false);
      assert.equal(launches[0].args.includes('ENVT_SECRET'), false);
    });

    it('без управляемых переменных файла нет, скрипту уходит пустой аргумент', async () => {
      const f = script();
      await handlers({ overlay: () => ({ set: new Map(), unset: new Set() }), tmpDir: tmp }).run(f);
      assert.equal(envFileOf(launches[0].args), '');
      assert.deepEqual(fs.readdirSync(tmp), []);
    });

    it('файл пишется после одобрения: отказ человека не оставляет ни файла, ни каталога', async () => {
      const f = script();
      answer = false;
      assert.deepEqual(await handlers({ overlay: () => overlay, tmpDir: tmp }).run(f), { cancelled: true });
      assert.deepEqual(fs.readdirSync(tmp), []);
    });

    it('отказ запуска эмулятора убирает файл окружения', async () => {
      const f = script();
      const r = await handlers({ overlay: () => overlay, tmpDir: tmp, launch: async () => ({ error: 'нет эмулятора' }) }).run(f);
      assert.deepEqual(r, { error: 'нет эмулятора' });
      assert.deepEqual(fs.readdirSync(tmp), []);
    });

    it('настоящий sh: скрипт читает файл, команда видит выбранное и не видит снятого, файл и каталог удалены', () => {
      const env = writeEnvFile(overlay, tmp);
      assert.ok(env);
      const r = spawnSync('sh', ['-c', RUN_SCRIPT, 'cyborg-run', env.file, base, 'sh', '-c', 'echo "s=$ENVT_SECRET g=${ENVT_GONE-unset}"'], { input: '', encoding: 'utf8', env: { PATH: process.env.PATH, ENVT_GONE: 'inherited' } });
      assert.ok(r.stdout.includes("s=tok'en $1 g=unset"), r.stdout + r.stderr);
      assert.deepEqual(fs.readdirSync(tmp), []);
    });
  });

  it('тот же хэш - без предупреждения', async () => {
    const f = script();
    await handlers().run(f);
    confirms = [];
    assert.deepEqual(await handlers().run(f), { ok: true });
    assert.equal(confirms.length, 0);
    assert.equal(launches.length, 2);
  });

  it('другой хэш - предупреждение с пометкой об изменении; возврат к старому спрашивает снова', async () => {
    const f = script('echo 1\n');
    await handlers().run(f);
    confirms = [];
    fs.writeFileSync(f, 'echo 2\n');
    await handlers().run(f);
    assert.equal(confirms[0].changed, true);
    fs.writeFileSync(f, 'echo 1\n');
    await handlers().run(f);
    assert.equal(confirms.length, 2);
    assert.equal(confirms[1].changed, true);
  });

  it('хэш тот же, команда другая (после одобрения выставлен бит): спрашивает снова с новой командой', { skip: isRoot }, async () => {
    const f = script();
    await handlers().run(f);
    confirms = [];
    fs.chmodSync(f, 0o755);
    assert.deepEqual(await handlers().run(f), { ok: true });
    assert.equal(confirms.length, 1);
    assert.equal(confirms[0].changed, true);
    assert.deepEqual(confirms[0].command, [f]);
    assert.deepEqual(approvals.get(f)?.command, [f]);
    confirms = [];
    await handlers().run(f);
    assert.equal(confirms.length, 0);
  });

  it('отмена: ни запуска, ни файла одобрений', async () => {
    answer = false;
    assert.deepEqual(await handlers().run(script()), { cancelled: true });
    assert.equal(launches.length, 0);
    assert.equal(fs.existsSync(approvals.file), false);
  });

  it('файл переписан, пока открыт диалог: отказ, без запуска и одобрения', async () => {
    const f = script('echo 1\n');
    answer = () => {
      fs.writeFileSync(f, 'echo 2\n');
      return true;
    };
    const r = await handlers().run(f);
    assert.deepEqual(r, { error: 'Файл изменился, пока вы решали: запуск отменён' });
    assert.equal(launches.length, 0);
    assert.equal(fs.existsSync(approvals.file), false);
  });

  it('содержимое то же, команда другая (снят бит): отказ, без запуска и одобрения', { skip: isRoot }, async () => {
    const f = write('repo/s.sh', 'echo hi\n', 0o755);
    answer = () => {
      fs.chmodSync(f, 0o644);
      return true;
    };
    const r = await handlers().run(f);
    assert.deepEqual(confirms[0].command, [f]);
    assert.deepEqual(r, { error: 'Файл изменился, пока вы решали: запуск отменён' });
    assert.equal(launches.length, 0);
    assert.equal(fs.existsSync(approvals.file), false);
  });

  it('бит есть, права чтения нет: «Файл не прочитан», без диалога, запуска и одобрения', { skip: isRoot }, async () => {
    const f = write('repo/n', 'x', 0o111);
    const r = await handlers().run(f);
    assert.ok('error' in r && /^Файл не прочитан/.test(r.error), JSON.stringify(r));
    assert.equal(confirms.length + launches.length, 0);
    assert.equal(fs.existsSync(approvals.file), false);
  });

  it('путь вне разрешённых и ссылка наружу - отказ без диалога и запуска', async () => {
    const outside = write('outside.sh', 'echo');
    await assert.rejects(handlers().run(outside), /Путь вне репозиториев/);
    await assert.rejects(handlers().runnable(outside), /Путь вне репозиториев/);
    fs.symlinkSync(outside, path.join(repo, 'link.sh'));
    await assert.rejects(handlers().run(path.join(repo, 'link.sh')), /Путь вне репозиториев/);
    await assert.rejects(handlers().run(42), /Путь вне репозиториев/);
    await assert.rejects(handlers().run('rel.sh'), /Путь вне репозиториев/);
    assert.equal(confirms.length + launches.length, 0);
  });

  it('ссылка внутри репозитория: ключ - цель, одобрение общее', async () => {
    const f = script();
    fs.symlinkSync(f, path.join(repo, 'link.sh'));
    await handlers().run(f);
    confirms = [];
    await handlers().run(path.join(repo, 'link.sh'));
    assert.equal(confirms.length, 0);
    assert.deepEqual(launches[1].args.slice(-2), ['bash', f]);
  });

  it('удалённый, ставший незапускаемым файл: ошибка без запуска', async () => {
    const f = script();
    await assert.rejects(handlers().run(path.join(repo, 'gone.sh')), /Файл не найден/);
    const txt = write('repo/t.txt', 'x');
    assert.match((await handlers().run(txt) as { error: string }).error, /больше не запускается/);
    fs.rmSync(f);
    await assert.rejects(handlers().run(f), /Файл не найден/);
    assert.equal(launches.length, 0);
  });

  it('эмулятора нет: сообщение, без диалога', async () => {
    const r = await handlers({ isExec: () => false }).run(script());
    assert.ok('error' in r && /TERMINAL/.test(r.error));
    assert.equal(confirms.length + launches.length, 0);
  });

  it('сбой записи одобрения: запуск идёт, в следующий раз спросят снова', async () => {
    const f = script();
    fs.rmSync(path.join(base, 'userData'), { recursive: true });
    const log = console.error;
    console.error = () => undefined;
    try {
      await handlers().run(f);
      await handlers().run(f);
    } finally {
      console.error = log;
    }
    assert.equal(launches.length, 2);
    assert.equal(confirms.length, 2);
  });

  it('повторное нажатие, пока идёт запуск того же файла - один диалог', async () => {
    const f = script();
    let release!: () => void;
    answer = () => new Promise<boolean>((r) => (release = () => r(true))) as unknown as boolean;
    const h = handlers();
    const first = h.run(f);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(await h.run(f), { cancelled: true });
    release();
    assert.deepEqual(await first, { ok: true });
    assert.equal(confirms.length, 1);
  });

  it('ошибка запуска эмулятора возвращается', async () => {
    const r = await handlers({ launch: async () => ({ error: 'ENOENT' }) }).run(script());
    assert.deepEqual(r, { error: 'ENOENT' });
  });

  it('win32: runnable false, run - ошибка', async () => {
    const h = handlers({ platform: 'win32' });
    assert.equal(await h.runnable(script()), false);
    assert.ok('error' in (await h.run(script())));
  });

  it('runnable: boolean, бит не нужен для .sh, нет для .ts, каталог - false', async () => {
    const h = handlers();
    assert.equal(await h.runnable(script()), true);
    assert.equal(await h.runnable(write('repo/a.ts', 'x')), false);
    assert.equal(await h.runnable(repo), false);
  });
});

describe('порт confirm и канал file:run', () => {
  const warning: RunWarning = { file: '/d/a.sh', dir: '/d', command: ['bash', '/d/a.sh'], changed: false };
  const tellWith = (response: number, calls: Parameters<Tell>[0][] = []): Tell => async (options) => {
    calls.push(options);
    return { response };
  };

  it('true только при «Запустить»; «Отмена» и Esc - false; по умолчанию и по Esc «Отмена»', async () => {
    const calls: Parameters<Tell>[0][] = [];
    assert.equal(await runConfirm(tellWith(1, calls))(warning), true);
    assert.equal(await runConfirm(tellWith(0))(warning), false);
    assert.equal(calls[0].type, 'warning');
    assert.deepEqual(calls[0].buttons, ['Отмена', 'Запустить']);
    assert.equal(calls[0].defaultId, 0);
    assert.equal(calls[0].cancelId, 0);
    assert.ok(calls[0].detail?.includes('/d/a.sh'));
  });

  it('ошибка ответа и исключение показываются окном, успех и отмена - нет', async () => {
    const calls: Parameters<Tell>[0][] = [];
    const tell = tellWith(0, calls);
    await runChannel(async () => ({ ok: true }), tell)('/f');
    await runChannel(async () => ({ cancelled: true }), tell)('/f');
    assert.equal(calls.length, 0);
    await runChannel(async (): Promise<RunReply> => ({ error: 'плохо' }), tell)('/f');
    await runChannel(async () => {
      throw new Error('вне');
    }, tell)('/f');
    assert.deepEqual(calls.map((c) => [c.type, c.message, c.detail]), [
      ['error', 'Файл не запущен', 'плохо'],
      ['error', 'Файл не запущен', 'вне'],
    ]);
  });
});

describe('launchAndWait', () => {
  it('stderr процесса попадает в ошибку, успех - пустой ответ', async () => {
    assert.deepEqual(await launchAndWait(process.execPath, ['-e', 'console.error("нет разрешения");process.exit(1)']), { error: 'нет разрешения' });
    assert.deepEqual(await launchAndWait(process.execPath, ['-e', '0']), {});
    const silent = await launchAndWait(process.execPath, ['-e', 'process.exit(3)']);
    assert.ok(silent.error);
  });
});

describe('кнопка запуска в шапке', () => {
  const fake = () => {
    const events: string[] = [];
    const button = { title: '', label: '', listener: () => undefined as void, addEventListener(_t: 'click', l: () => void) { this.listener = l; } };
    const reveal = { before: (b: unknown) => void events.push(b === button ? 'before-reveal' : 'other') };
    return { events, button, reveal, make: (label: string) => ((button.label = label), button) };
  };
  const apiOf = (ok: boolean | Error, calls: string[] = []) => ({
    runnable: async (f: string) => {
      calls.push(`runnable:${f}`);
      if (ok instanceof Error) throw ok;
      return ok;
    },
    runFile: async (f: string) => void calls.push(`run:${f}`),
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it('запускаемый файл локальной сессии: кнопка перед «Открыть в системе», клик запускает', async () => {
    const f = fake();
    const calls: string[] = [];
    addRunButton('/a.sh', false, apiOf(true, calls), f.reveal, f.make);
    await settle();
    assert.deepEqual(f.events, ['before-reveal']);
    assert.equal(f.button.label, RUN_LABEL);
    f.button.listener();
    assert.deepEqual(calls, ['runnable:/a.sh', 'run:/a.sh']);
  });

  it('незапускаемый файл и отказ канала: кнопки нет', async () => {
    for (const ok of [false, new Error('вне')]) {
      const f = fake();
      addRunButton('/a.ts', false, apiOf(ok), f.reveal, f.make);
      await settle();
      assert.deepEqual(f.events, []);
    }
  });

  it('удалённая сессия: канал не вызывается, кнопки нет', async () => {
    const f = fake();
    const calls: string[] = [];
    addRunButton('/a.sh', true, apiOf(true, calls), f.reveal, f.make);
    await settle();
    assert.deepEqual(calls, []);
    assert.deepEqual(f.events, []);
  });
});

describe('кавычение слова для sh в одном месте', () => {
  it('displayCommand, shellQuote и shQuote дают одно кавычение', () => {
    assert.equal(shQuote("it's"), "'it'\\''s'");
    assert.equal(agentdShQuote("it's"), shQuote("it's"));
    assert.equal(shellQuote("a b'c"), shQuote("a b'c"));
    assert.equal(displayCommand(['bash', "/d/a b'c.sh"]), `bash ${shQuote("/d/a b'c.sh")}`);
    assert.equal(displayCommand(['bash', '/d/a.sh']), 'bash /d/a.sh');
  });
});

describe('launcherFor и registerRunChannels', () => {
  const options = { cwd: '/d', env: {} };
  it('darwin ждёт osascript и не зовёт отрыв; linux отрывает и не зовёт osascript', async () => {
    const calls: string[] = [];
    const detached = async (cmd: string) => (calls.push(`detached:${cmd}`), {});
    const waited = async (cmd: string) => (calls.push(`waited:${cmd}`), { error: 'нет' });
    assert.deepEqual(await launcherFor('darwin', detached, waited)('osascript', [], options), { error: 'нет' });
    assert.deepEqual(await launcherFor('linux', detached, waited)('kitty', [], options), {});
    assert.deepEqual(calls, ['waited:osascript', 'detached:kitty']);
  });

  it('регистрирует file:runnable и file:run, каждому свой обработчик с одним аргументом-путём', () => {
    const handlers = new Map<string, (event: unknown, file: unknown) => unknown>();
    registerRunChannels((channel, listener) => void handlers.set(channel, listener), { runnable: (f) => `runnable:${f}` }, (f) => `run:${f}`);
    assert.deepEqual([...handlers.keys()].sort(), ['file:run', 'file:runnable']);
    assert.equal(handlers.get('file:runnable')!({}, '/a'), 'runnable:/a');
    assert.equal(handlers.get('file:run')!({}, '/a'), 'run:/a');
  });
});

describe('склейка новой возможности в main и интерфейсе', () => {
  const src = (file: string): string => fs.readFileSync(path.join(process.cwd(), file), 'utf8');
  it('app.ts: кнопка добавляется в общей шапке с признаком remote, openFile передаёт !!s.remote', () => {
    const app = src('src/renderer/app.ts');
    assert.match(app, /addRunButton<HTMLElement>\(path, remote, api, reveal,/);
    assert.match(app, /fileHeader\(path, root, file\.viewer\.actions, !!s\.remote\)/);
  });
  it('main.ts: каналы регистрирует registerRunChannels, платформу выбирает launcherFor', () => {
    const main = src('src/main/main.ts');
    assert.match(main, /registerRunChannels\(\(channel, listener\) => ipcMain\.handle\(channel, listener\), runs, runFileChannel\)/);
    assert.match(main, /launch: launcherFor\(process\.platform,/);
  });
});
