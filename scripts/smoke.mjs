// Дымовой тест собранного приложения: node scripts/smoke.mjs [аргументы Electron, например --no-sandbox].
// Запускает dist/ в Electron с временным каталогом данных, подставным `claude` и репозиторием-пробой, ведёт интерфейс
// по DevTools Protocol и проверяет: окно, дерево с git-статусом, клавиши команд своей системы, сессию в pty,
// слежение за рабочим каталогом сессии по событиям хуков, размер шрифта и завершение по SIGTERM при живой сессии.
// Нужен дисплей (на Linux - xvfb-run).
// Ничего не пишет вне временного каталога, свой `claude` и ~/.claude не трогает (CLAUDE_CONFIG_DIR указывает в него).
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const electronArgs = process.argv.slice(2);
const TIMEOUT_MS = 20_000;
// Вызов DevTools под нагрузкой машины (свопинг, чужие процессы, Monaco при первом показе) отвечает дольше 15 с: на CI и на ноутбуке это давало случайные падения.
const CDP_TIMEOUT_MS = 30_000;
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
// Ветка с ключом проекта Jira: диалог проекта предложит SMK (FR-11012).
git(repo, 'branch', 'smk-5-feature');
// Smoke - проект с включённым GitHub (кнопки панели есть), Bare - тот же репозиторий без источников (кнопок нет, FR-1001).
writeFileSync(
  join(userData, 'projects.json'),
  JSON.stringify({
    projects: [
      { id: 'p1', name: 'Smoke', description: '', repos: [repo], trackers: { github: true, gitlab: false }, jira: { enabled: true, projects: [] } },
      { id: 'p2', name: 'Bare', description: '', repos: [repo], trackers: { github: false, gitlab: false } },
    ],
    lastProjectId: 'p1',
  }),
);

// Хвост ответа с кнопками, как его отдаёт хук Stop: подставной claude дописывает эту строку в файл событий по команде `suggest`.
const fakeArgsLog = join(fakeBin, 'args.log');
const fakeSuggest = join(fakeBin, 'suggest.json');
writeFileSync(
  fakeSuggest,
  JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: 'Готово.\n\n<!-- cyborg-buttons: [{"label":"Оболочка","text":"!echo pwned","submit":true},{"label":"Отправь","text":"отправь это","submit":true},{"label":"Вставь","text":"вставь это"},{"label":"Лишняя","text":"лишняя"}] -->' }) + '\n',
);
// Данные Claude Code для окна «Расширения»: каталог настроек, магазин на диске, личный скилл и сервер MCP с «секретом» в адресе.
const claudeHome = join(base, 'claude-home');
// Хаб по теме GitHub ходит в сеть: в пробе он отключён заранее.
writeFileSync(join(userData, 'hubs.json'), JSON.stringify({ custom: [], disabled: ['github-topic'] }));
const market = join(base, 'market');
const pluginLog = join(fakeBin, 'plugin.log');
for (const dir of [join(claudeHome, 'skills', 'own-skill'), join(market, '.claude-plugin'), join(market, 'plugins', 'smk-plugin', 'skills', 'smk-skill')]) mkdirSync(dir, { recursive: true });
writeFileSync(join(claudeHome, 'skills', 'own-skill', 'SKILL.md'), '---\ndescription: Личный скилл пробы\n---\n');
writeFileSync(join(claudeHome, '.claude.json'), JSON.stringify({ mcpServers: { 'smk-mcp': { type: 'http', url: 'https://mcp.example.com/p?k=SMOKE_SECRET', headers: { Authorization: 'SMOKE_SECRET' } } } }));
writeFileSync(
  join(market, '.claude-plugin', 'marketplace.json'),
  JSON.stringify({ name: 'smoke-market', plugins: [{ name: 'smk-plugin', source: './plugins/smk-plugin', description: 'Плагин пробы' }, { name: 'smk-remote', source: { source: 'url', url: 'https://example.invalid/r.git' }, description: 'Удалённый плагин пробы' }] }),
);
writeFileSync(join(market, 'plugins', 'smk-plugin', 'skills', 'smk-skill', 'SKILL.md'), '---\ndescription: Скилл плагина пробы\n---\n');

// Подставной claude: SessionStart при старте, по строке `cd <dir>` - событие с новым cwd, строка, оканчивающаяся на `suggest`, - ответ с кнопками, на `ask` - запрос человека (вставленный без Enter текст остаётся в строке ввода), остальной ввод эхом.
const fakeClaude = join(fakeBin, 'claude');
writeFileSync(
  fakeClaude,
  `#!/bin/sh
# Подкоманды окна «Расширения» отвечают и выходят, не открывая сессию; вызовы плагинов пишутся в журнал.
case "$1" in
  --version) echo "2.1.314 (Claude Code)"; exit 0;;
  plugin)
    echo "$*" >> "$FAKE_PLUGIN_LOG"
    case "$2 $3" in
      "marketplace list") printf '[{"name":"smoke-market","source":"directory","path":"%s","installLocation":"%s"}]\\n' "$SMOKE_MARKET" "$SMOKE_MARKET";;
      "list --json") printf '[{"id":"smk-plugin@smoke-market","version":"1.0.0","scope":"user","enabled":true,"installPath":"%s/plugins/smk-plugin"}]\\n' "$SMOKE_MARKET";;
      "install "*|"uninstall "*) printf '{"command":"%s","outcome":"ok","message":"Готово: %s"}\\n' "$2" "$3";;
      "marketplace add") printf '{"command":"marketplace-add","outcome":"ok","message":"Магазин подключён"}\\n';;
      "marketplace remove") echo "✔ Successfully removed marketplace: $4";;
    esac
    exit 0;;
  mcp)
    printf 'Checking MCP server health…\\n\\nsmk-mcp: https://mcp.example.com (HTTP) - ✔ Connected\\nclaude.ai Gmail: https://gmailmcp.example.com/mcp/v1 - ✔ Connected\\n'
    exit 0;;
esac
printf '{"hook_event_name":"SessionStart","cwd":"%s"}\\n' "$PWD" >> "$CYBORG_EVENTS"
echo "fake-claude ready"
echo "ARGS: $*"
printf '%s\\n' "$*" >> "$FAKE_ARGS_LOG"
while IFS= read -r line; do
  case "$line" in
    "cd "*) dir=\${line#cd }; printf '{"hook_event_name":"PostToolUse","cwd":"%s","tool_name":"EnterWorktree"}\\n' "$dir" >> "$CYBORG_EVENTS"; echo "moved";;
    *suggest) cat "$FAKE_SUGGEST" >> "$CYBORG_EVENTS"; echo "suggested";;
    *ask) printf '{"hook_event_name":"UserPromptSubmit"}\\n' >> "$CYBORG_EVENTS"; echo "asked";;
    *) echo "got: [$line]";;
  esac
done
`,
);
chmodSync(fakeClaude, 0o755);
// Подставной gh: вход не выполнен. Панель открывается без сети и без настоящего входа разработчика.
const fakeGh = join(fakeBin, 'gh');
writeFileSync(fakeGh, '#!/bin/sh\necho "You are not logged in to any GitHub hosts." >&2\nexit 1\n');
chmodSync(fakeGh, 0o755);
// Сессия стартует через `$SHELL -lc`, а login-профиль (на Ubuntu - ~/.profile) ставит ~/.local/bin с настоящим claude впереди подставного.
const fakeShell = join(fakeBin, 'shell');
writeFileSync(fakeShell, '#!/bin/sh\nshift\nexec /bin/sh -c "$@"\n');
chmodSync(fakeShell, 0o755);

// Подставной jira: вход есть, одна задача SMK-1 в работе; формы ответов - как у jira-cli 1.7.0 (`--raw`, `--plain`).
const fakeJira = join(fakeBin, 'jira');
writeFileSync(
  fakeJira,
  `#!/bin/sh
case "$1" in
  version) echo 'Version="1.7.0", GitCommit="smoke"';;
  me) echo 'smoke@example.com';;
  open) echo "https://jira.example/browse/$2";;
  project) printf 'KEY\\tNAME\\t\\t\\tTYPE\\tLEAD\\nSMK\\tSmoke\\t\\t\\tsoftware\\tIvan\\nOTH\\tOther\\t\\t\\tsoftware\\tOlga\\n';;
  issue)
    if [ "$2" = list ]; then
      case "$*" in
        *--plain*) echo "SMK-1";;
        *) echo '[{"key":"SMK-1","fields":{"summary":"Задача из Jira","status":{"name":"In Progress"},"issueType":{"name":"Bug"},"priority":{"name":"High"},"assignee":{"displayName":"Я"},"updated":"2026-10-26T12:00:00.000+0300","labels":[],"description":"x"}}]';;
      esac
    else
      echo '{"key":"SMK-1","self":"https://jira.example/rest/api/2/issue/1","fields":{"summary":"Задача из Jira","status":{"name":"In Progress","statusCategory":{"key":"indeterminate"}},"issuetype":{"name":"Bug"},"description":"Описание из Jira","comment":{"total":1,"comments":[{"id":"1","author":{"displayName":"Коллега"},"body":"Комментарий из Jira"}]}}}'
    fi;;
esac
`,
);
chmodSync(fakeJira, 0o755);

const mac = process.platform === 'darwin';
const commandModifier = mac ? 4 : 2; // CDP: Alt=1, Ctrl=2, Meta=4, Shift=8
const foreignModifier = mac ? 2 : 4;
const SHIFT = 8;

let app;
let stderrOfMain;
let ws;
const extraApps = [];
const sockets = [];
const log = (text) => console.log(`smoke: ${text}`);

async function cleanup() {
  for (const socket of [ws, ...sockets]) {
    try {
      socket?.close();
    } catch {}
  }
  for (const extra of extraApps) if (extra.exitCode === null) extra.kill('SIGKILL');
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

// Соединение с целью DevTools: страницей окна или главным процессом (--inspect). Без ответа на вызов прогон падает с причиной, а не висит.
async function cdp(url) {
  const socket = new WebSocket(url);
  sockets.push(socket);
  await new Promise((r, j) => {
    socket.onopen = r;
    socket.onerror = () => j(new Error('нет соединения с DevTools'));
  });
  let seq = 0;
  const pending = new Map();
  socket.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) pending.get(d.id)(d);
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++seq;
      const timer = setTimeout(() => rej(new Error(`DevTools ${method}${typeof params.expression === 'string' ? ` «${params.expression.replace(/\s+/g, ' ').slice(0, 90)}»` : ''}: нет ответа за ${CDP_TIMEOUT_MS / 1000} с`)), CDP_TIMEOUT_MS);
      pending.set(id, (reply) => {
        clearTimeout(timer);
        res(reply);
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(`в странице: ${r.result.exceptionDetails.text} ${r.result.exceptionDetails.exception?.description ?? ''}`);
    return r.result?.result?.value;
  };
  return { socket, send, ev };
}

// Запуск Electron с отдельным каталогом данных; возвращает процесс, чтение stderr и адреса DevTools окна и главного процесса.
async function launch(dataDir, args = [], cwd = root) {
  const electron = join(root, 'node_modules', '.bin', 'electron');
  const proc = spawn(electron, [root, `--user-data-dir=${dataDir}`, '--remote-debugging-port=0', '--inspect=0', ...electronArgs, ...args], {
    cwd,
    // Смоук, запущенный из сессии Cyborg, унаследовал бы её CYBORG_CWD, и относительный --workspace считался бы не от cwd.
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CYBORG_'))), PATH: `${fakeBin}:${process.env.PATH}`, SHELL: fakeShell, FAKE_SUGGEST: fakeSuggest, FAKE_ARGS_LOG: fakeArgsLog, FAKE_PLUGIN_LOG: pluginLog, SMOKE_MARKET: market, CLAUDE_CONFIG_DIR: claudeHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (d) => (stderr += d));
  proc.once('exit', (code) => {
    if (code) stderr += `\n[electron завершился с кодом ${code}]`;
  });
  const port = await waitFor('порт DevTools', () => /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(stderr)?.[1]).catch((e) => {
    throw new Error(`${e.message}\n${stderr}`);
  });
  const inspect = await waitFor('отладчик главного процесса', () => /Debugger listening on (ws:\/\/\S+)/.exec(stderr)?.[1]);
  const pages = async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter((t) => t.type === 'page');
  return { proc, port, inspect, pages, stderr: () => stderr };
}

async function terminate(proc, tail) {
  // Node при выходе ждёт, пока отладчик отключится.
  for (const socket of sockets.splice(0)) socket.close();
  proc.kill('SIGTERM');
  const exited = await Promise.race([new Promise((r) => (proc.exitCode !== null ? r(true) : proc.once('exit', () => r(true)))), sleep(8000).then(() => false)]);
  assert.ok(exited, `приложение не завершилось по SIGTERM за 8 с\n${tail?.() ?? ''}`);
}

// Пункт системного меню по подписям меню -> подпись («Воркспейс» по умолчанию); клик в главном процессе.
const clickMenu = (mainEv, label, menu = 'Воркспейс') =>
  mainEv(`(() => {
    const { Menu } = process.mainModule.require('electron');
    const item = Menu.getApplicationMenu().items.find((i) => i.label === ${JSON.stringify(menu)}).submenu.items.find((i) => i.label === ${JSON.stringify(label)});
    if (!item) throw new Error('нет пункта ${label}');
    item.click();
    return item.enabled;
  })()`);

async function main() {
  const started = await launch(userData);
  app = started.proc;
  stderrOfMain = started.stderr;
  const page = await waitFor('страница окна', async () => (await started.pages())[0]);
  const mainEv = (await cdp(started.inspect)).ev;
  const cdpPage = await cdp(page.webSocketDebuggerUrl);
  ws = cdpPage.socket;
  const { send, ev } = cdpPage;
  const combo = async (modifiers, key, code, vk) => {
    const k = { key, code, windowsVirtualKeyCode: vk, modifiers };
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
  };
  const wheelUp = (modifiers) => send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 600, y: 400, deltaX: 0, deltaY: -100, modifiers });
  const text = (selector) => ev(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`);
  const tabs = () => ev('document.querySelectorAll("#session-list > *").length');
  const fontSize = () => ev('localStorage.getItem("cyborg.fontSize")');

  // Заголовок окна - «Проект - Cyborg v.версия[+хеш коммита]»; проект появляется после загрузки списка проектов.
  const title = () => ev('document.title');
  await waitFor('окно приложения', async () => (await title()).includes(`Cyborg v.${version}`));
  log('окно открыто');

  await waitFor('проект и дерево', async () => /Smoke/.test(await text('#project-select')) && /a\.txt/.test(await text('#tree')));
  assert.match(await text('#tree'), /\bM\b/, 'изменённый файл без отметки M git-статуса');
  log('проект, дерево и git-статус');

  // Окно поиска не висит на экране: его открывает пункт меню «Поиск».
  assert.equal(await ev('document.querySelector("#search-dialog").open'), false, 'окно поиска открыто без вызова');
  assert.equal(await ev('!!document.querySelector("#tree-filter")'), false, 'постоянное поле поиска над деревом осталось');
  assert.equal(await clickMenu(mainEv, 'Найти файл…', 'Поиск'), true, '«Найти файл…» недоступен при выбранном проекте');
  await waitFor('окно поиска открыто', async () => ev('document.querySelector("#search-dialog").open'));
  const searchFor = (value) =>
    ev(`(() => { const f = document.querySelector('#search-input'); f.value = ${JSON.stringify(value)}; f.dispatchEvent(new Event('input')); })()`);
  const toggle = (id) => ev(`document.querySelector('#${id}').click()`);
  await searchFor('A.T');
  await waitFor('найден a.txt, часть имени подсвечена', async () => (await ev('document.querySelector("#search-results mark")?.textContent ?? ""')) === 'a.t');
  await searchFor('нет-такого');
  await waitFor('нет совпадений', async () => /Нет совпадений/.test(await text('#search-status')) && !(await ev('!!document.querySelector("#search-results [role=option]")')));
  await toggle('search-regex');
  await searchFor('(');
  await waitFor('негодное выражение названо, а не брошено', async () => /Выражение не разобрано/.test(await text('#search-status')) && (await ev('document.querySelector("#search-input").getAttribute("aria-invalid")')) === 'true');
  await searchFor('^a\\.t.t$');
  await waitFor('регулярное выражение находит a.txt', async () => (await ev('document.querySelector("#search-results [role=option]")?.textContent ?? ""')).startsWith('a.txt'));
  await toggle('search-regex');
  await searchFor('a.t');
  await waitFor('снова подстрока', async () => /Найдено/.test(await text('#search-status')));
  await combo(0, 'Enter', 'Enter', 13);
  await waitFor('Enter открыл файл и закрыл окно', async () => !(await ev('document.querySelector("#search-dialog").open')) && /a\.txt/.test(await text('#file-preview .file-header')));
  log('поиск файла: меню, часть имени без учёта регистра, нет совпадений, регулярное выражение и его ошибка, Enter открывает файл');

  // Поиск по содержимому: меню открывает окно сразу в нужном виде, результат - строка, Enter переходит к ней.
  const modeSelected = (index) => ev(`document.querySelectorAll('#search-modes [role=tab]')[${index}].getAttribute('aria-selected')`);
  const cursorLine = () => ev('window.monaco?.editor.getEditors().map((e) => e.getPosition()?.lineNumber).filter(Boolean).join(",") ?? ""');
  assert.equal(await clickMenu(mainEv, 'Найти в файлах…', 'Поиск'), true, '«Найти в файлах…» недоступен');
  await waitFor('окно открыто на «Текст»', async () => (await ev('document.querySelector("#search-dialog").open')) && (await modeSelected(1)) === 'true');
  await searchFor('CHAN');
  await waitFor('строка найдена, совпадение подсвечено', async () => {
    const status = await text('#search-status');
    const mark = await ev('document.querySelector("#search-results mark")?.textContent ?? ""');
    if (status.includes('Найдено 1') && mark === 'chan') return true;
    throw new Error(`подпись «${status}», подсветка «${mark}», результаты «${await text('#search-results')}»`);
  });
  assert.match(await text('#search-results'), /changed[\s\S]*a\.txt:2/, 'строка результата: текст и «файл:строка»');
  await toggle('search-word');
  await waitFor('целое слово: «chan» не слово', async () => /Нет совпадений/.test(await text('#search-status')));
  await toggle('search-word');
  await toggle('search-regex');
  await searchFor('^ch.*ed$');
  await waitFor('выражение находит строку', async () => (await text('#search-status')).includes('Найдено 1'));
  await searchFor('(');
  await waitFor('негодное выражение git названо', async () => /Выражение не разобрано/.test(await text('#search-status')) && (await ev('document.querySelector("#search-input").getAttribute("aria-invalid")')) === 'true');
  await toggle('search-regex');
  await searchFor('changed');
  await waitFor('снова подстрока', async () => (await text('#search-status')).includes('Найдено 1'));
  await combo(0, 'Enter', 'Enter', 13);
  await waitFor('Enter открыл файл на строке 2', async () => !(await ev('document.querySelector("#search-dialog").open')) && (await cursorLine()).split(',').includes('2'));
  log('поиск в файлах: меню, подсветка, целое слово, выражение и его ошибка, Enter переходит к строке');

  assert.equal(await clickMenu(mainEv, 'Найти в изменениях…', 'Поиск'), true, '«Найти в изменениях…» недоступен');
  await waitFor('окно открыто на «Изменения»', async () => (await ev('document.querySelector("#search-dialog").open')) && (await modeSelected(2)) === 'true');
  await searchFor('changed');
  await waitFor('найдена добавленная строка со знаком +', async () => (await text('#search-status')).includes('Найдено 1') && (await text('#search-results .search-sign')) === '+');
  await searchFor('hello');
  await waitFor('неизменённая строка в изменениях не ищется', async () => /Нет совпадений/.test(await text('#search-status')));
  await ev('document.querySelectorAll("#search-modes [role=tab]")[0].click()');
  await waitFor('вид «Файлы» по клику на вкладку', async () => (await modeSelected(0)) === 'true');
  await ev('document.querySelector("#search-dialog").close()');
  log('поиск в изменениях: знак строки, неизменённое не находится, вкладки видов');

  // Окно «Расширения»: меню открывает вкладку, область и фильтр меняют состав, действия идут вызовами `claude plugin`, секреты MCP на экран не попадают.
  const extOpen = () => ev('document.querySelector("#ext-dialog").open');
  const extRows = () => ev('[...document.querySelectorAll("#ext-tree [role=treeitem] .ext-label")].map((l) => l.textContent).join("|")');
  const extTab = (index) => ev(`document.querySelectorAll('#ext-tabs [role=tab]')[${index}].click()`);
  const extSet = (id, value) => ev(`(() => { const f = document.querySelector('#${id}'); f.value = ${JSON.stringify(value)}; f.dispatchEvent(new Event('input')); })()`);
  const extButton = (row, label) =>
    ev(`(() => {
      const r = [...document.querySelectorAll('#ext-tree [role=treeitem]')].find((x) => x.querySelector('.ext-label')?.textContent === ${JSON.stringify(row)});
      const b = r && [...r.querySelectorAll('button')].find((x) => x.textContent === ${JSON.stringify(label)});
      if (b) b.click();
      return !!b;
    })()`);
  const extPanel = () => ev('!document.querySelector("#ext-action").hidden');
  const extResult = () => text('#ext-action-result');
  const pluginCalls = () => (existsSync(pluginLog) ? readFileSync(pluginLog, 'utf8') : '');
  const rowsHave = (...labels) => async () => {
    const rows = await extRows();
    if (labels.every((l) => rows.split('|').includes(l))) return true;
    throw new Error(`строки: ${rows}; подпись: ${await text('#ext-status')}`);
  };
  assert.equal(await extOpen(), false, 'окно расширений открыто без вызова');
  assert.equal(await clickMenu(mainEv, 'Магазины…', 'Расширения'), true, '«Магазины…» недоступны при выбранном проекте');
  await waitFor('окно расширений на «Магазинах»', async () => (await extOpen()) && (await ev('document.querySelectorAll("#ext-tabs [role=tab]")[0].getAttribute("aria-selected")')) === 'true');
  await waitFor('магазин виден', rowsHave('smoke-market'));
  assert.equal(await ev('document.querySelector(".ext-view[data-view=project]").getAttribute("aria-pressed")'), 'true', 'без сессии область - «Проект»');
  assert.equal(await ev('document.querySelector(".ext-view[data-view=session]").disabled'), true, '«Сессия» без сессии недоступна');
  await extSet('ext-filter', 'smk-skill');
  await waitFor('фильтр раскрыл ветку до скилла', rowsHave('smoke-market', 'smk-plugin', '/smk-plugin:smk-skill'));
  await extSet('ext-filter', 'smk-remote');
  await waitFor('удалённый плагин найден', rowsHave('smoke-market', 'smk-remote'));
  assert.equal(await extButton('smk-remote', 'Установить…'), true, 'у плагина нет кнопки установки');
  await waitFor('форма установки', async () => (await extPanel()) && /smk-remote@smoke-market/.test(await text('#ext-action-title')));
  assert.equal(await ev('document.querySelector("#ext-action-scope").value'), 'local', 'установка в проекте по умолчанию локальная');
  await ev('document.querySelector("#ext-action").requestSubmit()');
  await waitFor('установка выполнена', async () => /Готово: smk-remote@smoke-market/.test(await extResult()));
  assert.match(pluginCalls(), /plugin install smk-remote@smoke-market --scope local --json/, 'claude plugin install вызван не так');
  assert.doesNotMatch(pluginCalls(), /\s(-y|--yes|--accept-command)\b/, 'установка подтвердила чужую команду');
  await ev('document.querySelector("#ext-action-cancel").click()');
  await extSet('ext-filter', '');

  await extTab(1);
  await waitFor('установленные: личный скилл и плагин пользователя', rowsHave('smk-plugin', '/own-skill'));
  assert.match(await extRows(), /Везде · для вас во всех проектах/, 'нет группы «Везде»');
  assert.equal(await extButton('smk-plugin', 'Удалить…'), true, 'у плагина нет кнопки удаления');
  await waitFor('форма удаления', async () => (await extPanel()) && /smk-plugin@smoke-market/.test(await text('#ext-action-title')));
  await ev('document.querySelector("#ext-action").requestSubmit()');
  await waitFor('удаление выполнено', async () => /Готово: smk-plugin@smoke-market/.test(await extResult()));
  assert.match(pluginCalls(), /plugin uninstall smk-plugin@smoke-market --scope user --json/, 'claude plugin uninstall вызван не так');
  await ev('document.querySelector("#ext-action-cancel").click()');

  await extTab(2);
  await waitFor('сервер MCP из настроек', rowsHave('smk-mcp'));
  assert.match(await text('#ext-tree'), /http · https:\/\/mcp\.example\.com/, 'подпись сервера: транспорт и хост');
  assert.equal(await ev('document.querySelector("#ext-dialog").outerHTML.includes("SMOKE_SECRET")'), false, 'секрет сервера MCP попал на экран');
  assert.doesNotMatch(await extRows(), /claude\.ai/, 'коннекторы показаны без проверки связи');
  await ev('document.querySelector("#ext-probe").click()');
  await waitFor('связь проверена', async () => /подключён/.test(await text('#ext-tree')) && /claude\.ai Gmail/.test(await extRows()));

  await extTab(3);
  await waitFor('встроенные хабы и их магазины', rowsHave('Anthropic', 'claude-plugins-official', 'claude-community', 'dex-it', 'dex-claude-marketplace', 'GitHub: claude-code-marketplace'));
  assert.match(await text('#ext-tree'), /отключён/, 'хаб GitHub в пробе отключён, чтобы смоук не ходил в сеть');
  assert.equal(await extButton('Anthropic', 'Отключить'), true);
  await waitFor('хаб Anthropic отключён: магазинов в нём не видно', async () => !(await extRows()).includes('claude-community'));
  await extButton('Anthropic', 'Подключить');
  await waitFor('хаб Anthropic включён снова', rowsHave('claude-community'));
  await ev('document.querySelector("#ext-add-hub").click()');
  await waitFor('форма хаба', extPanel);
  await extSet('ext-action-name', 'Чужой');
  await extSet('ext-action-source', 'http://plain.example/hub.json');
  await ev('document.querySelector("#ext-action").requestSubmit()');
  await waitFor('http-адрес хаба отклонён', async () => /https/.test(await extResult()) && (await ev('document.querySelector("#ext-action-result").className')) === 'failed');
  await ev('document.querySelector("#ext-action-cancel").click()');
  assert.equal(await extButton('dex-claude-marketplace', 'Подключить…'), true, 'у магазина хаба нет кнопки подключения');
  await waitFor('форма подключения с адресом', async () => (await extPanel()) && (await ev('document.querySelector("#ext-action-source").value')) === 'dex-it/ai-kit');
  await ev('document.querySelector("#ext-action").requestSubmit()');
  await waitFor('магазин подключён', async () => /Магазин подключён/.test(await extResult()));
  assert.match(pluginCalls(), /plugin marketplace add dex-it\/ai-kit --scope local --json/, 'claude plugin marketplace add вызван не так');
  await ev('document.querySelector("#ext-action-cancel").click()');
  await ev('document.querySelector("#ext-close").click()');
  await waitFor('окно расширений закрыто', async () => !(await extOpen()));
  log('расширения: меню, вкладки, область, фильтр, установка и удаление плагина, MCP без секретов и проверка связи, хабы и подключение магазина');

  assert.match(await title(), new RegExp(`^Smoke - Cyborg v\\.${version.replaceAll('.', '\\.')}(\\+[0-9a-f]+)?$`), 'заголовок окна: проект, приложение и версия');
  log('заголовок окна с проектом и версией');

  // Прежний projects.json открывается как есть: «Недавние» получают его путь, замок лежит рядом, строка меню видна без Alt.
  const legacyFile = join(userData, 'projects.json');
  assert.deepEqual(JSON.parse(readFileSync(join(userData, 'recent-workspaces.json'), 'utf8')), { recent: [legacyFile] }, 'прежний файл не попал в «Недавние»');
  assert.match(readFileSync(`${legacyFile}.lock`, 'utf8'), /^\d+$/, 'нет замка с pid рядом с projects.json');
  assert.equal(await mainEv('process.mainModule.require("electron").BrowserWindow.getAllWindows()[0].isMenuBarAutoHide()'), false, 'строка меню скрыта');
  log('прежний projects.json: «Недавние», замок, строка меню видна');

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

  // С сессией окно расширений открывается в области «Сессия»; рабочий каталог сессии (worktree) и репозиторий запуска читаются оба.
  assert.equal(await clickMenu(mainEv, 'Установленные плагины и скиллы…', 'Расширения'), true, 'пункт расширений недоступен при сессии');
  await waitFor('область «Сессия»', async () => (await ev('document.querySelector("#ext-dialog").open')) && (await ev('document.querySelector(".ext-view[data-view=session]").getAttribute("aria-pressed")')) === 'true');
  assert.equal(await ev('document.querySelector(".ext-view[data-view=session]").disabled'), false, '«Сессия» недоступна при сессии');
  assert.match(await text('#ext-note'), /^Сессия: repo-wt/, 'подпись области называет рабочий каталог сессии');
  await waitFor('в области «Сессия» виден плагин пользователя', async () => /smk-plugin/.test(await text('#ext-tree')));
  await ev('document.querySelector("#ext-close").click()');
  log('расширения при сессии: область «Сессия» по умолчанию, рабочий каталог сессии');

  // Каналы файлов и git отвечают только по репозиториям проекта и каталогам сессий (ADR-0002, п.5): worktree вне репозитория -
  // каталог сессии, соседний каталог и корень файловой системы - нет.
  const answer = (call) => ev(`${call}.then((v) => 'принят: ' + JSON.stringify(v), (e) => String(e.message))`);
  for (const call of ["listDir('/')", `listDir('${base}')`, "readFile('/etc/hosts')", "gitRoot('/tmp')", "gitStatus('/')", "gitHeadContent('/etc/hosts')"]) {
    assert.match(await answer(`window.cyborg.${call}`), /Путь вне репозиториев/, `${call} не отклонён`);
  }
  assert.match(await answer(`window.cyborg.listDir('${repo}')`), /a\.txt/, 'каталог репозитория проекта не читается');
  assert.match(await answer(`window.cyborg.listDir('${worktree}')`), /a\.txt/, 'каталог сессии вне репозиториев не читается');
  log('пути вне репозиториев и сессий отклонены, свои читаются');

  // FR-1001: кнопка «Задачи» открывает и закрывает панель; переход к сессии закрывает; без источников кнопок нет.
  const panelOpen = async () => !(await ev('document.querySelector("#tasks-panel").hidden'));
  assert.equal(await ev('document.querySelector("#tasks-toggle").hidden'), false, 'у проекта с источником нет кнопки «Задачи»');
  await ev('document.querySelector("#tasks-toggle").click()');
  await waitFor('панель задач открыта кнопкой', panelOpen);
  await ev('document.querySelector("#tasks-toggle").click()');
  await waitFor('панель задач закрыта той же кнопкой', async () => !(await panelOpen()));
  await ev('document.querySelector("#tasks-toggle").click()');
  await waitFor('панель задач открыта снова', panelOpen);
  await ev('document.querySelector("#session-list > *").click()');
  await waitFor('переход к сессии закрыл панель', async () => !(await panelOpen()));
  await ev('document.querySelector("#tasks-toggle").click()');
  await waitFor('панель задач открыта перед сменой проекта', panelOpen);
  await ev('(() => { const s = document.querySelector("#project-select"); s.value = "p2"; s.dispatchEvent(new Event("change")); })()');
  await waitFor('открытая панель закрылась у проекта без источников', async () => !(await panelOpen()));
  await waitFor('у проекта без источников нет кнопок панели', async () => (await ev('document.querySelector("#tasks-toggle").hidden && document.querySelector("#mrs-toggle").hidden')) === true);
  assert.equal(await ev('document.querySelector("#status-toggle").hidden'), true, 'у проекта без источников есть кнопка «Статус»');
  await ev('(() => { const s = document.querySelector("#project-select"); s.value = "p1"; s.dispatchEvent(new Event("change")); })()');
  await waitFor('кнопки вернулись с проектом с источником', async () => (await ev('document.querySelector("#tasks-toggle").hidden')) === false);
  log('панель задач: кнопка открывает и закрывает, сессия закрывает, без источников кнопок нет');

  // FR-11012: выбор проектов Jira в свойствах проекта - список из `jira project list`, подсказка по веткам, ручной ключ, сохранение.
  // Проекты управляются из системного меню «Воркспейс», кнопки ⋯ на панели нет.
  assert.equal(await ev('!document.querySelector("#project-menu-open") && !document.querySelector("#project-menu")'), true, 'на панели осталось меню проекта');
  assert.equal(await clickMenu(mainEv, 'Свойства проекта'), true, '«Свойства проекта» недоступны при выбранном проекте');
  await waitFor('диалог проекта открыт', async () => (await ev('document.querySelector("#project-dialog").open')) === true);
  await waitFor('список проектов Jira в диалоге', async () => (await ev('document.querySelectorAll("#project-jira-list .jira-row").length')) === 2);
  assert.match(await text('#project-jira-list'), /SMK\s+Smoke/, 'в списке нет проекта SMK с названием');
  assert.match(await text('#project-jira-chosen'), /Не выбрано/, 'без выбора диалог не сказал про проект по умолчанию');
  await waitFor('подсказка проекта по веткам репозитория', async () => /SMK · 1/.test(await text('#project-jira-suggest')));
  await ev('document.querySelector("#project-jira-suggest button").click()');
  assert.match(await text('#project-jira-chosen'), /SMK ×/, 'подсказка не выбрала проект');
  await ev(`(() => { const f = document.querySelector("#project-jira-filter"); f.value = "oth"; f.dispatchEvent(new Event("input")); })()`);
  assert.equal(await ev('document.querySelectorAll("#project-jira-list .jira-row").length'), 1, 'поиск не сузил список');
  await ev(`(() => { const f = document.querySelector("#project-jira-filter"); f.value = "OTH"; f.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); })()`);
  assert.match(await text('#project-jira-chosen'), /SMK ×\s*OTH ×/, 'введённый ключ не добавлен');
  assert.ok(await ev('document.querySelector("#project-dialog").open'), 'Enter в поиске отправил форму');
  // Предел проектов: Enter с лишним ключом его не добавляет, а сказанная ошибка не переживает снятие проекта и не блокирует «Сохранить».
  const typeKey = (key) => ev(`(() => { const f = document.querySelector("#project-jira-filter"); f.value = ${JSON.stringify(key)}; f.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); })()`);
  for (let i = 1; i <= 8; i++) await typeKey(`LIM${i}`);
  await typeKey('OVER');
  assert.doesNotMatch(await text('#project-jira-chosen'), /OVER/, 'одиннадцатый проект добавлен сверх предела');
  assert.notEqual(await ev('document.querySelector("#project-jira-filter").validationMessage'), '', 'предел не назван');
  for (let i = 1; i <= 8; i++) await ev(`[...document.querySelectorAll("#project-jira-chosen .chip-button")].find((b) => b.textContent === "LIM${i} ×").click()`);
  assert.equal(await ev('document.querySelector("#project-jira-filter").validationMessage'), '', 'ошибка предела осталась после снятия проекта');
  assert.ok(await ev('document.querySelector("#project-dialog form").checkValidity()'), 'ошибка предела блокирует «Сохранить»');
  await ev('document.querySelector("#project-dialog button[value=save]").click()');
  await waitFor('диалог закрыт сохранением', async () => (await ev('document.querySelector("#project-dialog").open')) === false);
  await waitFor('выбранные проекты Jira сохранены', async () => (await ev('window.cyborg.loadProjects().then((s) => JSON.stringify(s.projects.find((p) => p.id === "p1").jira))')) === '{"enabled":true,"projects":["SMK","OTH"]}');
  log('выбор проектов Jira: список, подсказка по веткам, поиск, ручной ключ, сохранение');

  // FR-11002..FR-11008: кнопка «Статус» - карточка с задачей Jira, детали, закрытие, сессия по задаче с промптом из ключа.
  const popoverOpen = async () => !(await ev('document.querySelector("#status-popover").hidden'));
  const visibleTerminal = () => ev('(() => { const e = [...document.querySelectorAll(".xterm-rows")].find((x) => x.offsetParent); return e ? e.innerText : ""; })()');
  assert.equal(await ev('document.querySelector("#status-toggle").hidden'), false, 'у проекта с источниками нет кнопки «Статус»');
  await ev('document.querySelector("#status-toggle").click()');
  await waitFor('карточка статуса открыта кнопкой', popoverOpen);
  await waitFor('задача Jira в карточке', async () => /SMK-1/.test(await text('#status-popover')));
  assert.equal(await ev('[...document.querySelectorAll("#status-popover .status-link")].filter((e) => e.textContent === "SMK-1").length'), 1, 'задача двух выбранных проектов показана дважды');
  assert.equal(await ev('document.querySelector("#status-toggle .status-dot").dataset.level'), 'unknown', 'без входа в gh уровень не unknown');
  assert.match(await text('#status-popover'), /нет remote GitHub или GitLab/, 'карточка не объяснила, почему нет данных о MR');
  await ev('[...document.querySelectorAll(".status-link")].find((e) => e.textContent === "SMK-1").click()');
  await waitFor('детали задачи Jira', async () => /Описание из Jira/.test(await text('#status-popover')) && /Комментарий из Jira/.test(await text('#status-popover')));
  assert.ok(await popoverOpen(), 'клик внутри карточки с перерисовкой закрыл её');
  await ev('document.body.click()');
  await waitFor('клик снаружи закрыл карточку', async () => !(await popoverOpen()));
  await ev('document.querySelector("#status-toggle").click()');
  await waitFor('карточка открыта снова', popoverOpen);
  await combo(0, 'Escape', 'Escape', 27);
  await waitFor('Escape закрыл карточку', async () => !(await popoverOpen()));
  await ev('document.querySelector("#status-toggle").click()');
  await waitFor('карточка открыта перед стартом', popoverOpen);
  await ev('document.querySelector(".status-item .status-actions button").click()');
  await waitFor('карточка закрылась при старте сессии', async () => !(await popoverOpen()));
  await waitFor('вторая вкладка сессии по задаче Jira', async () => (await tabs()) === 2 && /SMK-1/.test(await text('#session-list > *:nth-child(2)')));
  // Терминал переносит длинную строку аргументов по ширине окна (в CI она уже), поэтому пробелы и переносы при сравнении не учитываются.
  await waitFor('промпт задачи Jira в аргументах claude', async () => (await visibleTerminal()).replace(/\s+/g, '').includes('ЗадачаJiraSMK-1:прочитайеё'));
  await ev('document.querySelector("#status-toggle").click()');
  await waitFor('карточка открыта после старта', popoverOpen);
  await waitFor('у задачи с сессией кнопка «К сессии»', async () => (await text('.status-item .status-actions button')) === 'К сессии');
  await ev('document.querySelector(".status-item .status-actions button").click()');
  await waitFor('повторное действие вернуло к сессии без новой вкладки', async () => !(await popoverOpen()) && (await tabs()) === 2);
  log('кнопка «Статус»: карточка с задачей Jira, детали, закрытие кликом и Escape, сессия по задаче, возврат к ней');

  // FR-12001..FR-12006: кнопки-команды под терминалом активной сессии (сейчас это сессия по задаче Jira SMK-1, ветка main).
  const squeezed = async () => (await visibleTerminal()).replace(/\s+/g, '');
  const barButtons = () => ev('[...document.querySelectorAll(".workspace-pane.active .command-button")].map((b) => b.firstChild.textContent)');
  const barButton = (label) => ev(`[...document.querySelectorAll(".workspace-pane.active .command-button")].find((b) => b.firstChild.textContent === ${JSON.stringify(label)}).click()`);
  const barNotice = () => text('.workspace-pane.active .command-notice');
  assert.deepEqual(await barButtons(), ['Сливай', 'Сделай PR', 'Мердж', 'Приберись'], 'под терминалом нет встроенных кнопок');
  await barButton('Сливай');
  await waitFor('«Сливай» отправил текст с Enter', async () => (await squeezed()).includes('got:[сливай]'));

  await clickMenu(mainEv, 'Кнопки команд…');
  await waitFor('диалог кнопок открыт', async () => (await ev('document.querySelector("#commands-dialog").open')) === true);
  await waitFor('редактор Monaco в диалоге', async () => (await ev('document.querySelectorAll("#commands-editor .monaco-editor").length')) === 1);
  const editorValue = () => ev('window.monaco.editor.getEditors().find((e) => e.getContainerDomNode().closest("#commands-dialog")).getValue()');
  const opened = JSON.parse(await editorValue());
  assert.deepEqual(opened.map((b) => b.label), ['Сливай', 'Сделай PR', 'Мердж', 'Приберись'], 'редактор не показал встроенные кнопки');
  assert.ok(opened.every((b) => b.description), 'у встроенных кнопок в редакторе нет описаний');
  const setEditor = (value) => ev(`window.monaco.editor.getEditors().find((e) => e.getContainerDomNode().closest("#commands-dialog")).setValue(${JSON.stringify(value)})`);
  await setEditor('[{"label":"A","text":""}]');
  await ev('document.querySelector("#commands-save").click()');
  await waitFor('негодная кнопка названа в диалоге', async () => /Кнопка 1 \(«A»\): text/.test(await text('#commands-error')));
  assert.ok(await ev('document.querySelector("#commands-dialog").open'), 'диалог закрылся при ошибке');
  await setEditor(
    JSON.stringify([
      { label: 'Приберись' },
      { label: 'Сливай' },
      { label: 'Ветка', text: 'ветка {branch}', submit: true, hotkey: 'Alt+B' },
      { label: 'Задача', text: 'задача {task}', submit: true },
      { label: 'PR', text: 'смерджи PR {pr}', submit: true },
      { label: 'Предложи', text: 'suggest', submit: true },
      { label: 'Спроси', text: 'ask', submit: true },
      { label: 'Вставка', text: 'без ввода', submit: false },
    ]),
  );
  await ev('document.querySelector("#commands-save").click()');
  await waitFor('диалог закрыт сохранением', async () => (await ev('document.querySelector("#commands-dialog").open')) === false);
  await waitFor('кнопки из воркспейса на полосе без перезапуска, встроенные переставлены', async () => (await barButtons()).join() === 'Приберись,Сливай,Сделай PR,Мердж,Ветка,Задача,PR,Предложи,Спроси,Вставка');
  const stored = JSON.parse(readFileSync(legacyFile, 'utf8'));
  assert.equal(stored.commands.length, 8, 'кнопки не легли в файл воркспейса');
  assert.deepEqual(stored.commands.slice(0, 2), [{ label: 'Приберись' }, { label: 'Сливай' }], 'перестановка встроенных не записана местами');
  assert.equal(stored.projects.length, 2, 'запись кнопок затёрла проекты');

  await barButton('Ветка');
  await waitFor('{branch} подставлена веткой сессии', async () => (await squeezed()).includes('got:[веткаmain]'));
  await barButton('Задача');
  await waitFor('{task} подставлена ключом задачи Jira', async () => (await squeezed()).includes('got:[задачаSMK-1]'));
  await barButton('PR');
  await waitFor('{pr} без PR назвал причину', async () => /PR\/MR/.test(await barNotice()));
  assert.ok(!(await squeezed()).includes('смерджи'), 'текст с неразрешённым {pr} ушёл в сессию');
  const before = ((await squeezed()).match(/got:\[веткаmain\]/g) ?? []).length;
  await combo(1, 'b', 'KeyB', 66);
  await waitFor('сочетание Alt+B нажало «Ветка»', async () => ((await squeezed()).match(/got:\[веткаmain\]/g) ?? []).length === before + 1);
  // FR-12007, FR-12008: кнопка, предложенная моделью (хвост ответа в событии Stop), - другого цвета, вставляет текст без Enter и исчезает после запроса человека.
  assert.ok(!(await barButtons()).some((label) => label.startsWith('✦')), 'до ответа модели есть предложенные кнопки');
  await barButton('Предложи');
  await waitFor('подставной claude получил «suggest»', async () => (await squeezed()).includes('suggested'));
  await waitFor('предложенные моделью кнопки на полосе', async () => (await barButtons()).includes('✦ Вставь'));
  assert.deepEqual((await barButtons()).filter((label) => label.startsWith('✦')), ['✦ Отправь', '✦ Вставь'], 'предложенных кнопок не две: предел не сработал либо реплика с «!» не отброшена');
  const paint = (label) => ev(`getComputedStyle([...document.querySelectorAll(".workspace-pane.active .command-button")].find((b) => b.firstChild.textContent === ${JSON.stringify(label)})).backgroundColor`);
  assert.notEqual(await paint('✦ Вставь'), await paint('Сливай'), 'предложенная кнопка того же цвета, что заданная');
  assert.equal(await paint('Предложи'), await paint('Сливай'), 'заданные заранее кнопки разных цветов');
  const dashed = (label) => ev(`getComputedStyle([...document.querySelectorAll(".workspace-pane.active .command-button")].find((b) => b.firstChild.textContent === ${JSON.stringify(label)})).borderStyle`);
  assert.equal(await dashed('✦ Вставь'), 'dashed', 'кнопка без submit не с пунктирной рамкой');
  assert.equal(await dashed('✦ Отправь'), 'solid', 'кнопка с submit с пунктирной рамкой');
  await barButton('✦ Отправь');
  await waitFor('предложенная кнопка с submit отправила текст с Enter', async () => (await squeezed()).includes('got:[отправьэто]'));
  await barButton('✦ Вставь');
  await waitFor('предложенная кнопка без submit вставила текст', async () => (await squeezed()).includes('вставьэто'));
  await sleep(300);
  assert.ok(!(await squeezed()).includes('got:[вставьэто]'), 'предложенная кнопка без submit нажала Enter');
  await barButton('Спроси');
  await waitFor('запрос человека убрал предложенную кнопку', async () => !(await barButtons()).some((label) => label.startsWith('✦')));

  await barButton('Вставка');
  await waitFor('«Вставка» вставила текст', async () => (await squeezed()).includes('безввода'));
  await sleep(300);
  assert.ok(!(await squeezed()).includes('got:[безввода]'), 'кнопка без submit нажала Enter');

  // Файл правят снаружи (другим редактором): полоса подхватывает его при возврате фокуса окну.
  writeFileSync(legacyFile, JSON.stringify({ ...stored, commands: [...stored.commands, { label: 'Внешняя', text: 'снаружи', submit: true }] }));
  await ev('window.dispatchEvent(new Event("focus"))');
  await waitFor('правка файла снаружи подхвачена', async () => (await barButtons()).includes('Внешняя'));

  // Общий набор: правится в том же диалоге, лежит в userData и ложится под кнопки воркспейса.
  await clickMenu(mainEv, 'Кнопки команд…');
  await waitFor('диалог кнопок открыт для общего набора', async () => (await ev('document.querySelector("#commands-dialog").open')) === true);
  await ev('document.querySelector("#commands-scope-global").click()');
  await waitFor('редактор показал общий набор', async () => (await ev('document.querySelector("#commands-scope-global").getAttribute("aria-pressed")')) === 'true');
  await waitFor('в общем наборе только встроенные', async () => JSON.parse(await editorValue()).length === 4);
  await setEditor(JSON.stringify([{ label: 'Общая', text: 'для всех', submit: true }]));
  await ev('document.querySelector("#commands-save").click()');
  await waitFor('диалог закрыт сохранением общего набора', async () => (await ev('document.querySelector("#commands-dialog").open')) === false);
  await waitFor('общая кнопка между встроенными и кнопками воркспейса', async () => (await barButtons()).join().startsWith('Приберись,Сливай,Сделай PR,Мердж,Общая,Ветка'));
  assert.deepEqual(JSON.parse(readFileSync(join(userData, 'commands.json'), 'utf8')), [{ label: 'Общая', text: 'для всех', submit: true }], 'общий набор не лёг в userData');
  assert.ok(!JSON.parse(readFileSync(legacyFile, 'utf8')).commands.some((b) => b.label === 'Общая'), 'общая кнопка попала в файл воркспейса');
  log('кнопки-команды: встроенные, правка в Monaco, подстановки, сочетание, вставка без Enter, правка файла снаружи, предложенные моделью, общий набор');

  // FR-12009: промпты кнопок запуска сессий - действующий набор в Monaco, правка доходит до первого сообщения следующей сессии.
  const startedWith = async (key) => {
    const id = await ev(`window.cyborg.createSession(${JSON.stringify(repo)}, [], { jira: { key: ${JSON.stringify(key)} } })`);
    await waitFor(`подставной claude получил аргументы сессии ${key}`, async () => existsSync(fakeArgsLog) && readFileSync(fakeArgsLog, 'utf8').includes(key));
    await ev(`window.cyborg.kill(${id}); 1`);
    return readFileSync(fakeArgsLog, 'utf8').split('\n').filter((line) => line.includes(key)).at(-1);
  };
  assert.match(await startedWith('SMK-2'), /Задача Jira SMK-2: прочитай её \(jira issue view SMK-2 --comments 5\)/, 'встроенный промпт Jira изменился без правки файла');
  const beforePrompts = JSON.parse(readFileSync(legacyFile, 'utf8'));
  await clickMenu(mainEv, 'Промпты кнопок…');
  await waitFor('диалог промптов открыт', async () => (await ev('document.querySelector("#prompts-dialog").open')) === true);
  await waitFor('редактор Monaco в диалоге промптов', async () => (await ev('document.querySelectorAll("#prompts-editor .monaco-editor").length')) === 1);
  const promptEditor = (call) => ev(`(() => { const e = window.monaco.editor.getEditors().find((e) => e.getContainerDomNode().closest("#prompts-dialog")); return e.${call}; })()`);
  const shown = JSON.parse(await promptEditor('getValue()'));
  assert.deepEqual(Object.keys(shown), ['mr.review', 'mr.rework', 'mr.ci', 'task.start', 'jira.start'], 'редактор не показал встроенные промпты');
  assert.ok(Object.values(shown).every((p) => p.text && p.description), 'у встроенного промпта нет текста или описания');
  const setPrompts = (value) => promptEditor(`setValue(${JSON.stringify(JSON.stringify(value))})`);
  await setPrompts({ 'jira.start': { text: 'Работай над {jira_kye}' } });
  await ev('document.querySelector("#prompts-save").click()');
  await waitFor('негодный промпт назван в диалоге', async () => /«jira\.start»: неизвестная подстановка \{jira_kye\}/.test(await text('#prompts-error')));
  assert.ok(await ev('document.querySelector("#prompts-dialog").open'), 'диалог закрылся при ошибке');
  await setPrompts({ ...shown, 'jira.start': { text: 'Смоук-промпт {jira_key}', description: 'для проверки' } });
  await ev('document.querySelector("#prompts-save").click()');
  await waitFor('диалог промптов закрыт сохранением', async () => (await ev('document.querySelector("#prompts-dialog").open')) === false);
  const promptsFile = join(userData, 'prompts.json');
  const afterSave = JSON.parse(readFileSync(promptsFile, 'utf8'));
  assert.equal(afterSave['jira.start'].text, 'Смоук-промпт {jira_key}', 'промпт не лёг в общий файл промптов');
  assert.deepEqual(JSON.parse(readFileSync(legacyFile, 'utf8')), beforePrompts, 'запись промптов тронула файл воркспейса');
  assert.match(await startedWith('SMK-3'), /Смоук-промпт SMK-3/, 'правка промпта не дошла до первого сообщения сессии');
  // Негодная запись, правленная руками, не заменяется встроенной молча: сессия не стартует и называет причину.
  writeFileSync(promptsFile, JSON.stringify({ 'jira.start': { text: '-p {jira_key}' } }));
  const refused = await ev(`window.cyborg.createSession(${JSON.stringify(repo)}, [], { jira: { key: "SMK-4" } }).then(() => "стартовала", (error) => String(error))`);
  assert.match(refused, /text не может начинаться с «-»/, 'негодный промпт из файла не назван');
  assert.ok(!readFileSync(fakeArgsLog, 'utf8').includes('SMK-4'), 'сессия с негодным промптом стартовала');
  writeFileSync(promptsFile, JSON.stringify(afterSave));
  log('промпты кнопок: действующий набор в Monaco, проверка, правка доходит до сессии, негодный промпт не стартует молча');

  // FR-3005: бросок файла ОС вне зон ничего не делает - событие отменено, курсор «нельзя».
  const stray = await ev(`(() => {
    const result = {};
    for (const type of ['dragover', 'drop']) {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File(['x'], 'x.txt'));
      const event = new DragEvent(type, { dataTransfer, bubbles: true, cancelable: true });
      document.querySelector('#side-tabs').dispatchEvent(event);
      result[type] = { prevented: event.defaultPrevented, effect: dataTransfer.dropEffect };
    }
    return result;
  })()`);
  assert.deepEqual(stray, { dragover: { prevented: true, effect: 'none' }, drop: { prevented: true, effect: 'none' } }, 'бросок файла вне зон не отменён');
  log('бросок файла вне зон отменён, курсор «нельзя»');

  assert.equal(await fontSize(), null, 'размер шрифта задан до проверки');
  for (let i = 0; i < 3; i++) await wheelUp(foreignModifier);
  await sleep(300);
  assert.equal(await fontSize(), null, 'чужой модификатор с колесом изменил шрифт');
  for (let i = 0; i < 3; i++) await wheelUp(commandModifier);
  await waitFor('размер шрифта 16 после колеса', async () => (await fontSize()) === '16');
  await combo(commandModifier, '0', 'Digit0', 48);
  await waitFor('сброс размера шрифта на 13', async () => (await fontSize()) === '13');
  log('размер шрифта: колесо и сброс клавишей своей системы');

  await terminate(app, () => stderrOfMain());
  assert.ok(!existsSync(`${legacyFile}.lock`), 'замок остался после SIGTERM');
  log('SIGTERM снял замок');
  await firstRun();
}

// Первый запуск с пустым userData: окно создания воркспейса, «Отмена», «Создать…» из меню, файл, «Недавние», замок, настройки в своей сессии.
async function firstRun() {
  const freshData = join(base, 'userdata-first');
  const wsFile = join(base, 'team.cyborg.json');
  mkdirSync(freshData);
  const started = await launch(freshData);
  extraApps.push(started.proc);
  const mainEv = (await cdp(started.inspect)).ev;
  const firstPage = await waitFor('страница окна первого запуска', async () => (await started.pages())[0]);
  let { ev } = await cdp(firstPage.webSocketDebuggerUrl);
  const opened = () => ev('document.querySelector("#workspace-dialog").open');
  await waitFor('окно первого запуска открыто само', opened);
  assert.equal(await ev('document.querySelector("#workspace-create").disabled'), true, '«Создать» доступна без данных');
  await ev('document.querySelector("#workspace-cancel").click()');
  await waitFor('«Отмена» закрыла окно', async () => !(await opened()));
  assert.match(await ev('document.title'), new RegExp(`^Cyborg v\\.${version.replaceAll('.', '\\.')}(\\+[0-9a-f]+)?$`), 'заголовок пустого Cyborg');
  assert.match(await text0(ev, '#empty'), /Воркспейс не открыт/, 'нет подсказки пустого Cyborg');
  assert.equal(await mainEv('process.mainModule.require("electron").Menu.getApplicationMenu().getMenuItemById("project-new").enabled'), false, '«Новый проект» доступен без воркспейса');
  log('первый запуск: окно создания, «Отмена» оставляет пустой Cyborg');

  await clickMenu(mainEv, 'Создать…');
  await waitFor('«Создать…» открыло то же окно', opened);
  const fill = (selector, value) => ev(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await fill('#workspace-name', 'Команда');
  assert.equal(await ev('document.querySelector("#workspace-file").value'), `${homedir()}/Команда.cyborg.json`, 'файл по умолчанию не следует за именем');
  await fill('#workspace-file', wsFile);
  await fill('#workspace-project', 'Основной');
  assert.equal(await ev('document.querySelector("#workspace-create").disabled'), true, '«Создать» доступна без репозитория');
  // Диалог выбора каталога главного процесса подменяется: настоящий окном ОС прогон не провести.
  await mainEv(`process.mainModule.require('electron').dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [${JSON.stringify(repo)}] })`);
  await ev('document.querySelector("#workspace-add-repo").click()');
  await waitFor('репозиторий в списке окна', async () => /repo/.test(await text0(ev, '#workspace-repos')));
  assert.equal(await ev('document.querySelector("#workspace-create").disabled'), false, '«Создать» недоступна при полных данных');
  // «Создать» пересоздаёт окно: старое уничтожается сразу после ответа главного процесса, и ответ на сам вызов DevTools может не дойти.
  // Клик откладывается, чтобы вызов вернулся до него.
  await ev('setTimeout(() => document.querySelector("#workspace-create").click(), 0); 0');
  const pageAfter = await waitFor('окно воркспейса пересоздано', async () => {
    const pages = await started.pages();
    return pages.length === 1 && pages[0].id !== firstPage.id ? pages[0] : null;
  });
  ({ ev } = await cdp(pageAfter.webSocketDebuggerUrl));
  await waitFor('проект в новом окне', async () => /Основной/.test(await text0(ev, '#project-select')));
  const newTitle = await ev('document.title');
  assert.match(newTitle, new RegExp(`^team - Основной - Cyborg v\\.${version.replaceAll('.', '\\.')}`), `заголовок: воркспейс, проект, приложение; получено «${newTitle}»`);
  assert.equal((await started.pages()).length, 1, 'после создания не одно окно');
  const written = JSON.parse(readFileSync(wsFile, 'utf8'));
  assert.equal(written.projects.length, 1);
  assert.deepEqual(written.projects[0].repos, [repo]);
  assert.equal(written.lastProjectId, written.projects[0].id);
  assert.deepEqual(JSON.parse(readFileSync(join(freshData, 'recent-workspaces.json'), 'utf8')), { recent: [wsFile] });
  const lockPid = Number(readFileSync(`${wsFile}.lock`, 'utf8'));
  assert.ok(lockPid > 0 && (process.kill(lockPid, 0), true), 'в замке нет pid живого процесса');
  assert.equal(await ev('document.querySelector("#project-delete") !== null'), true);
  log('первый запуск: «Создать» пишет файл, открывает воркспейс в этом окне, «Недавние», замок');

  await ev('localStorage.setItem("cyborg.fontSize", "15")');
  await terminate(started.proc);
  assert.ok(!existsSync(`${wsFile}.lock`), 'замок остался после SIGTERM');
  assert.ok(readdirSync(join(freshData, 'workspaces')).length === 1, 'нет каталога сессии воркспейса');

  // Перезапуск с --workspace и относительным путём: те же проекты и прежний размер шрифта из сессии воркспейса.
  const again = await launch(freshData, ['--workspace=team.cyborg.json'], base);
  extraApps.push(again.proc);
  ({ ev } = await cdp((await waitFor('страница после перезапуска', async () => (await again.pages())[0])).webSocketDebuggerUrl));
  await waitFor('проект после перезапуска', async () => /Основной/.test(await text0(ev, '#project-select')));
  assert.equal(await ev('localStorage.getItem("cyborg.fontSize")'), '15', 'настройки интерфейса не пережили перезапуск воркспейса');
  await terminate(again.proc);
  assert.ok(!existsSync(`${wsFile}.lock`), 'замок остался после второго выхода');
  log('--workspace: относительный путь, проекты и настройки интерфейса пережили перезапуск');

  // Несуществующий файл: пустой перечень, а файл (и замок) не создаются стартом.
  const missingFile = join(base, 'typo.cyborg.json');
  const missing = await launch(freshData, [`--workspace=${missingFile}`], base);
  extraApps.push(missing.proc);
  ({ ev } = await cdp((await waitFor('страница с несуществующим файлом', async () => (await missing.pages())[0])).webSocketDebuggerUrl));
  await waitFor('пустой перечень проектов', async () => /Нет проектов/.test(await text0(ev, '#project-select')));
  await sleep(1500);
  assert.ok(!existsSync(missingFile), 'старт на несуществующий файл создал его');
  await terminate(missing.proc);
  log('--workspace на несуществующий файл: файл не создаётся');
}

const text0 = (ev, selector) => ev(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`);

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
