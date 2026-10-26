// Дымовой тест собранного приложения: node scripts/smoke.mjs [аргументы Electron, например --no-sandbox].
// Запускает dist/ в Electron с временным каталогом данных, подставным `claude` и репозиторием-пробой, ведёт интерфейс
// по DevTools Protocol и проверяет: окно, дерево с git-статусом, клавиши команд своей системы, сессию в pty,
// слежение за рабочим каталогом сессии по событиям хуков, размер шрифта и завершение по SIGTERM при живой сессии.
// Нужен дисплей (на Linux - xvfb-run).
// Ничего не пишет вне временного каталога, свой `claude` и ~/.claude не трогает.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const electronArgs = process.argv.slice(2);
const TIMEOUT_MS = 20_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const base = realpathSync(mkdtempSync(join(tmpdir(), 'cyborg-smoke-')));
const userData = join(base, 'userdata');
const repo = join(base, 'repo');
const worktree = join(base, 'repo-wt');
const fakeBin = join(base, 'bin');
for (const dir of [userData, repo, fakeBin]) mkdirSync(dir);

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=smoke', '-c', 'user.email=smoke@example.com', '-C', cwd, ...args], { stdio: 'pipe' });
git(repo, 'init', '-q', '-b', 'main');
writeFileSync(join(repo, 'a.txt'), 'hello\n');
git(repo, 'add', 'a.txt');
git(repo, 'commit', '-q', '-m', 'init');
writeFileSync(join(repo, 'a.txt'), 'hello\nchanged\n');
git(repo, 'worktree', 'add', '-q', '-b', 'smoke-wt', worktree);
writeFileSync(
  join(userData, 'projects.json'),
  JSON.stringify({ projects: [{ id: 'p1', name: 'Smoke', description: '', repos: [repo], trackers: { github: false, gitlab: false } }], lastProjectId: 'p1' }),
);

// Подставной claude: SessionStart при старте, по строке `cd <dir>` - событие с новым cwd, остальной ввод эхом.
const fakeClaude = join(fakeBin, 'claude');
writeFileSync(
  fakeClaude,
  `#!/bin/sh
printf '{"hook_event_name":"SessionStart","cwd":"%s"}\\n' "$PWD" >> "$CYBORG_EVENTS"
echo "fake-claude ready"
while IFS= read -r line; do
  case "$line" in
    "cd "*) dir=\${line#cd }; printf '{"hook_event_name":"PostToolUse","cwd":"%s","tool_name":"EnterWorktree"}\\n' "$dir" >> "$CYBORG_EVENTS"; echo "moved";;
    *) echo "got: [$line]";;
  esac
done
`,
);
chmodSync(fakeClaude, 0o755);

const mac = process.platform === 'darwin';
const commandModifier = mac ? 4 : 2; // CDP: Alt=1, Ctrl=2, Meta=4, Shift=8
const foreignModifier = mac ? 2 : 4;
const SHIFT = 8;

let app;
let ws;
const log = (text) => console.log(`smoke: ${text}`);

async function cleanup() {
  try {
    ws?.close();
  } catch {}
  if (app && app.exitCode === null) {
    // SIGTERM при живой сессии: Ctrl+C в терминале, kill и остановка в CI не должны упираться в подтверждение выхода.
    app.kill('SIGTERM');
    const exited = await Promise.race([new Promise((r) => app.once('exit', () => r(true))), sleep(5000).then(() => false)]);
    if (!exited) {
      console.error('smoke: ОШИБКА: приложение с работающей сессией не завершилось по SIGTERM за 5 с');
      process.exitCode = 1;
      app.kill('SIGKILL');
    }
  }
  // Сессия, пережившая убитый Electron, держит каналы вывода и не даёт скрипту завершиться: чистим по пути этого прогона.
  // Код pkill не смотрится: 1 - процессов не осталось, это обычный исход.
  spawnSync('pkill', ['-f', base]);
  app?.stdout.destroy();
  app?.stderr.destroy();
  rmSync(base, { recursive: true, force: true });
}

async function waitFor(what, probe, timeout = TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await probe();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(150);
  }
  throw new Error(`не дождались: ${what}${last instanceof Error ? ` (${last.message})` : ''}`);
}

async function main() {
  const electron = join(root, 'node_modules', '.bin', 'electron');
  app = spawn(electron, [root, `--user-data-dir=${userData}`, '--remote-debugging-port=0', ...electronArgs], {
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  app.stdout.on('data', () => {});
  app.stderr.on('data', (d) => (stderr += d));
  app.once('exit', (code) => {
    if (code) stderr += `\n[electron завершился с кодом ${code}]`;
  });

  const port = await waitFor('порт DevTools', () => /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(stderr)?.[1]).catch((e) => {
    throw new Error(`${e.message}\n${stderr}`);
  });
  const page = await waitFor('страница окна', async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'));
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = () => j(new Error('нет соединения с DevTools'));
  });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) pending.get(d.id)(d);
  };
  const send = (method, params = {}) =>
    new Promise((res) => {
      const id = ++seq;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(`в странице: ${r.result.exceptionDetails.text} ${r.result.exceptionDetails.exception?.description ?? ''}`);
    return r.result?.result?.value;
  };
  const combo = async (modifiers, key, code, vk) => {
    const k = { key, code, windowsVirtualKeyCode: vk, modifiers };
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
  };
  const wheelUp = (modifiers) => send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 600, y: 400, deltaX: 0, deltaY: -100, modifiers });
  const text = (selector) => ev(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`);
  const tabs = () => ev('document.querySelectorAll("#session-list > *").length');
  const fontSize = () => ev('localStorage.getItem("cyborg.fontSize")');

  await waitFor('окно приложения', async () => (await ev('document.title')) === 'Cyborg');
  log('окно открыто');

  await waitFor('проект и дерево', async () => /Smoke/.test(await text('#project-select')) && /a\.txt/.test(await text('#tree')));
  assert.match(await text('#tree'), /\bM\b/, 'изменённый файл без отметки M git-статуса');
  log('проект, дерево и git-статус');

  const shortcut = `${mac ? 'Cmd' : 'Ctrl'}+Shift+N`;
  assert.equal(await ev('window.cyborg.platform'), process.platform);
  assert.ok((await text('#empty')).includes(shortcut), 'подсказка пустого экрана без клавиши своей системы');
  assert.ok((await ev('document.querySelector("#new-session").title')).includes(shortcut), 'подсказка кнопки без клавиши своей системы');
  log(`подсказки называют ${shortcut}`);

  await combo(foreignModifier | SHIFT, 'N', 'KeyN', 78);
  await sleep(700);
  assert.equal(await tabs(), 0, 'чужой модификатор открыл сессию');
  await combo(commandModifier | SHIFT, 'N', 'KeyN', 78);
  await waitFor('вкладка сессии', async () => (await tabs()) === 1);
  await waitFor('вывод подставного claude в терминале', async () => /fake-claude ready/.test(await text('.xterm-rows')));
  log('новая сессия по клавише своей системы, pty и терминал');

  await ev(`window.cyborg.input(1, 'cd ${worktree}\\r')`);
  await waitFor('переход дерева в worktree по событию хука', async () => (await text('#tree-meta')).includes(worktree));
  log('рабочий каталог сессии отслежен по событиям хуков');

  assert.equal(await fontSize(), null, 'размер шрифта задан до проверки');
  for (let i = 0; i < 3; i++) await wheelUp(foreignModifier);
  await sleep(300);
  assert.equal(await fontSize(), null, 'чужой модификатор с колесом изменил шрифт');
  for (let i = 0; i < 3; i++) await wheelUp(commandModifier);
  await waitFor('размер шрифта 16 после колеса', async () => (await fontSize()) === '16');
  await combo(commandModifier, '0', 'Digit0', 48);
  await waitFor('сброс размера шрифта на 13', async () => (await fontSize()) === '13');
  log('размер шрифта: колесо и сброс клавишей своей системы');
}

try {
  await main();
  log('все проверки пройдены');
} catch (error) {
  console.error(`smoke: ОШИБКА: ${error.message}`);
  process.exitCode = 1;
} finally {
  await cleanup();
  process.exit(process.exitCode ?? 0);
}
