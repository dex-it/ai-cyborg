// Дымовой тест собранного приложения: node scripts/smoke.mjs [аргументы Electron, например --no-sandbox].
// Запускает dist/ в Electron с временным каталогом данных, подставным `claude` и репозиторием-пробой, ведёт интерфейс
// по DevTools Protocol и проверяет: окно, дерево с git-статусом, клавиши команд своей системы, сессию в pty,
// слежение за рабочим каталогом сессии по событиям хуков, размер шрифта и завершение по SIGTERM при живой сессии.
// Нужен дисплей (на Linux - xvfb-run).
// Ничего не пишет вне временного каталога, свой `claude` и ~/.claude не трогает.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const electronArgs = process.argv.slice(2);
const TIMEOUT_MS = 20_000;
const CDP_TIMEOUT_MS = 15_000;
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

// Подставной claude: SessionStart при старте, по строке `cd <dir>` - событие с новым cwd, остальной ввод эхом.
const fakeClaude = join(fakeBin, 'claude');
writeFileSync(
  fakeClaude,
  `#!/bin/sh
printf '{"hook_event_name":"SessionStart","cwd":"%s"}\\n' "$PWD" >> "$CYBORG_EVENTS"
echo "fake-claude ready"
echo "ARGS: $*"
while IFS= read -r line; do
  case "$line" in
    "cd "*) dir=\${line#cd }; printf '{"hook_event_name":"PostToolUse","cwd":"%s","tool_name":"EnterWorktree"}\\n' "$dir" >> "$CYBORG_EVENTS"; echo "moved";;
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
  // Без ответа на вызов DevTools (окно закрыто модальным диалогом, интерфейс завис) прогон падает с причиной, а не висит до таймаута job.
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++seq;
      const timer = setTimeout(() => rej(new Error(`DevTools ${method}: нет ответа за ${CDP_TIMEOUT_MS / 1000} с`)), CDP_TIMEOUT_MS);
      pending.set(id, (reply) => {
        clearTimeout(timer);
        res(reply);
      });
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

  // Заголовок окна - «Проект - Cyborg v.версия[+хеш коммита]»; проект появляется после загрузки списка проектов.
  const title = () => ev('document.title');
  await waitFor('окно приложения', async () => (await title()).includes(`Cyborg v.${version}`));
  log('окно открыто');

  await waitFor('проект и дерево', async () => /Smoke/.test(await text('#project-select')) && /a\.txt/.test(await text('#tree')));
  assert.match(await text('#tree'), /\bM\b/, 'изменённый файл без отметки M git-статуса');
  log('проект, дерево и git-статус');

  assert.match(await title(), new RegExp(`^Smoke - Cyborg v\\.${version.replaceAll('.', '\\.')}(\\+[0-9a-f]+)?$`), 'заголовок окна: проект, приложение и версия');
  log('заголовок окна с проектом и версией');

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
  await ev('document.querySelector("#project-menu-open").click()');
  await waitFor('меню проекта', async () => !(await ev('document.querySelector("#project-menu").hidden')));
  await ev('[...document.querySelectorAll("#project-menu .menu-item")].find((e) => e.innerText.includes("Свойства")).click()');
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
