// Замеры собранного приложения: время до готового окна, память главного процесса и рендерера, задержка и пропускная
// способность терминала, время открытия поиска, «Расширений», панелей задач и MR, размер бандлов.
//
//   npm run build && node scripts/bench.mjs [--runs 5] [--only app,terminal,ui,pending,live,bundles] [--sizes 400000,800000,1600000] [--git-delay 12] [--wait-s 280]
//                                           [--json файл] [--electron-arg --no-sandbox]
//   --only: app (старт, память, первая сессия), terminal (задержка и пропускная способность), ui (поиск, «Расширения», панели, «Статус»),
//   pending (вывод до создания вкладки, поток мелких кусков, N строк), live (то же в открытой сессии - линейный контроль), bundles (размер бандлов);
//   --wait-s: сколько секунд ждать конец вывода на экране, прежде чем считать замер неудавшимся.
//
// Каждый прогон - свежие запуски Electron с новым каталогом данных (холодный профиль Chromium), подставными claude, gh, jira
// и репозиторием-пробой из fixtures/. Живая сеть и настоящие программы не нужны. Итог: минимум, медиана и максимум по прогонам
// и описание среды (машина, ОС, нагрузка); сырые прогоны - в --json. Нужен дисплей (на Linux - xvfb-run).
// CYBORG_APP_DIR=<каталог> меряет сборку другого экземпляра репозитория (например, worktree на нужном коммите после `npm run build`).
// Память: macOS - `footprint` (phys_footprint), Linux - Pss из /proc/<pid>/smaps_rollup; меры разные и не сравниваются между ОС.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, release, tmpdir, totalmem, type as osType } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { appRoot, cdp, clickMenu, fixtures, killLeftovers, launch, prepareFixtures, root, sleep, stop, waitFor } from './lib/driver.mjs';

// ---------- параметры ----------

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const electronArgs = argv.flatMap((a, i) => (argv[i - 1] === '--electron-arg' ? [a] : []));
const RUNS = Math.max(1, Number(option('runs', 5)));
const ALL = ['app', 'terminal', 'ui', 'pending', 'live', 'bundles'];
const only = option('only', ALL.join(',')).split(',');
const SIZES = option('sizes', '400000,800000,1600000').split(',').map(Number);
const GIT_DELAY = option('git-delay', '12');
const jsonFile = option('json', '');
const mac = process.platform === 'darwin';
const POLL_MS = 10;

// ---------- среда и статистика ----------

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const stats = (xs) => ({ n: xs.length, min: Math.min(...xs), median: median(xs), max: Math.max(...xs) });

function environment() {
  const text = (cmd, args) => {
    try {
      return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return '';
    }
  };
  const electronVersion = JSON.parse(readFileSync(join([appRoot, root].find((dir) => existsSync(join(dir, 'node_modules', 'electron', 'package.json'))), 'node_modules', 'electron', 'package.json'), 'utf8')).version;
  return {
    machine: mac ? text('sysctl', ['-n', 'hw.model']) || osType() : osType(),
    cpu: `${cpus()[0]?.model ?? '?'} x${cpus().length}`,
    memoryGiB: Math.round(totalmem() / 2 ** 30),
    os: mac ? `macOS ${text('sw_vers', ['-productVersion'])} (Darwin ${release()})` : `${osType()} ${release()}`,
    power: mac ? (text('pmset', ['-g', 'ps']).split('\n')[0] ?? '') : '',
    node: process.version,
    electron: electronVersion,
    commit: text('git', ['-C', appRoot, 'rev-parse', '--short', 'HEAD']),
    loadavgAtStart: loadavg().map((x) => Number(x.toFixed(2))),
    uptime: mac ? text('uptime', []) : '',
  };
}

// ---------- память ----------

const processTable = () =>
  execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }));

/** Байты по мере ОС: macOS - footprint процесса, Linux - Pss. */
function memoryBytes(pid) {
  if (mac) {
    const out = execFileSync('footprint', ['-p', String(pid), '--format', 'bytes'], { encoding: 'utf8' });
    const m = /Footprint:\s*(\d+)\s*B/.exec(out);
    if (!m) throw new Error(`footprint не дал число для ${pid}: ${out.slice(0, 200)}`);
    return Number(m[1]);
  }
  if (process.platform === 'linux') {
    const m = /^Pss:\s+(\d+) kB/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'));
    if (!m) throw new Error(`нет Pss для ${pid}`);
    return Number(m[1]) * 1024;
  }
  throw new Error(`память не измеряется на ${process.platform}`);
}

/** Память главного процесса, рендерера и всех процессов приложения (главный + дочерние Electron). */
function appMemory(launcherPid) {
  // Запускает приложение скрипт-обёртка electron: настоящий главный процесс - её потомок без --type=.
  const table = processTable();
  const main = table.find((p) => (p.pid === launcherPid || p.ppid === launcherPid) && !p.command.includes('--type=') && p.command.includes('/electron/dist/'));
  if (!main) throw new Error('не нашли главный процесс Electron');
  const mainPid = main.pid;
  const children = table.filter((p) => p.ppid === mainPid);
  const renderers = children.filter((p) => p.command.includes('--type=renderer'));
  if (renderers.length !== 1) throw new Error(`рендереров ${renderers.length}, ожидался один`);
  const mainBytes = memoryBytes(mainPid);
  const renderer = memoryBytes(renderers[0].pid);
  const others = children.filter((p) => p !== renderers[0]).reduce((sum, p) => sum + memoryBytes(p.pid), 0);
  return { main: mainBytes, renderer, total: mainBytes + renderer + others };
}

// ---------- стенд ----------

/** Каталоги прогона: данные, репозиторий-проба с remote GitHub, воркспейс с проектом. */
function setup(prefix) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), `cyborg-bench-${prefix}-`)));
  const userData = join(base, 'userdata');
  const repo = join(base, 'repo');
  for (const dir of [userData, repo]) mkdirSync(dir);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@example.com', '-C', repo, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'hello\n');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'init');
  git('remote', 'add', 'origin', 'https://github.com/acme/demo.git');
  writeFileSync(join(repo, 'a.txt'), 'hello\nchanged\n');
  writeFileSync(join(userData, 'projects.json'), JSON.stringify({ projects: [{ id: 'p1', name: 'Bench', description: '', repos: [repo], trackers: { github: true, gitlab: false }, jira: { enabled: true, projects: [] } }], lastProjectId: 'p1' }));
  writeFileSync(join(userData, 'hubs.json'), JSON.stringify({ custom: [], disabled: ['github-topic'] }));
  return { base, userData, repo };
}

/** Запуск приложения до готового окна: возвращает замеры старта, процесс и обработчики DevTools. */
async function start(prefix, env = {}) {
  const dirs = setup(prefix);
  const fx = prepareFixtures(dirs.base, env);
  const t0 = performance.now();
  const started = await launch({ dataDir: dirs.userData, env: fx.env, electronArgs });
  const devtoolsMs = performance.now() - t0;
  const page = await waitFor('страница окна', async () => (await started.pages())[0]);
  const mainEv = (await cdp(started.inspect)).ev;
  // Вызов, ждущий большой вывод, длится минуты: предел ответа DevTools шире, чем у дымового теста.
  const { ev, send } = await cdp(page.webSocketDebuggerUrl, 300_000);
  const poll = async (probe) => {
    for (;;) {
      if (await probe().catch(() => false)) return performance.now() - t0;
      if (performance.now() - t0 > 60_000) throw new Error('окно не стало готовым за 60 с');
      await sleep(POLL_MS);
    }
  };
  const titleMs = await poll(async () => (await ev('document.title')).includes('Cyborg v.'));
  const readyMs = await poll(async () => ev('/Bench/.test(document.querySelector("#project-select")?.innerText ?? "") && /a\\.txt/.test(document.querySelector("#tree")?.innerText ?? "")'));
  await send('Performance.enable');
  /** Секунды, которые главный поток окна проработал с начала страницы (метрика TaskDuration, DevTools). */
  const busy = async () => (await send('Performance.getMetrics')).result.metrics.find((m) => m.name === 'TaskDuration').value;
  const finish = async () => {
    const exited = await stop(started.proc);
    killLeftovers(dirs.base);
    rmSync(dirs.base, { recursive: true, force: true });
    if (!exited) throw new Error('приложение не завершилось по SIGTERM');
  };
  return { ...dirs, fx, proc: started.proc, ev, send, mainEv, busy, finish, startup: { devtoolsMs, titleMs, readyMs } };
}

/** Выражение страницы: ждёт, пока в видимом терминале появится текст; возвращает performance.now() в этот момент. */
const WAIT_MS = Number(option('wait-s', 280)) * 1000;
const untilTerminal = (needle, timeout = WAIT_MS) => `new Promise((resolve, reject) => {
  const end = performance.now() + ${timeout};
  const tick = () => {
    const now = performance.now();
    if ([...document.querySelectorAll('.xterm-rows')].some((e) => e.offsetParent && e.textContent.includes(${JSON.stringify(needle)}))) return resolve(now);
    if (now > end) {
      const rows = [...document.querySelectorAll('.xterm-rows')].find((e) => e.offsetParent);
      return reject(new Error('не дождались ' + ${JSON.stringify(needle)} + '; окно: ' + document.visibilityState + ', фокус ' + document.hasFocus() + '; кусков ' + (window.__b && window.__b.chunks) + '; на экране: ' + (rows ? rows.textContent.replace(/\\s+/g, ' ').slice(-120) : 'терминала нет')));
    }
    setTimeout(tick, 4);
  };
  tick();
})`;

/** Выражение страницы: ждёт истинности условия (код JS); возвращает performance.now() в этот момент. */
const untilCondition = (condition, label, timeout = 60_000) => `new Promise((resolve, reject) => {
  const end = performance.now() + ${timeout};
  const tick = () => {
    const now = performance.now();
    if (${condition}) return resolve(now);
    if (now > end) return reject(new Error('не дождались: ' + ${JSON.stringify(label)}));
    setTimeout(tick, 2);
  };
  tick();
})`;

/** Счётчик вывода сессий в странице: байты, куски, время последнего куска. */
const COUNTER = `(() => {
  window.__b = { bytes: 0, chunks: 0, last: 0, first: 0 };
  window.cyborg.on('session:data', ({ data }) => {
    const b = window.__b;
    if (!b.chunks) b.first = performance.now();
    b.bytes += new TextEncoder().encode(data).length;
    b.chunks += 1;
    b.last = performance.now();
  });
  // Блокировка цикла окна: PerformanceObserver по longtask в Electron записей не даёт, поэтому - дрейф таймера в 5 мс; зазор свыше 40 мс считается блокировкой.
  window.__long = [];
  let prev = performance.now();
  setInterval(() => {
    const now = performance.now();
    if (now - prev - 5 > 40) window.__long.push(now - prev - 5);
    prev = now;
  }, 5);
  return true;
})()`;

const escape = async (app) => {
  const k = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, modifiers: 0 };
  await app.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k });
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
};

const click = (selector) => `document.querySelector(${JSON.stringify(selector)}).click()`;

/** Новая сессия кнопкой; возвращает время от клика до появления вкладки и до приветствия подставного claude. */
async function newSession(app) {
  const t0 = await app.ev('performance.now()');
  await app.ev(click('#new-session'));
  const tab = await app.ev(untilCondition('document.querySelectorAll("#session-list > *").length >= 1', 'вкладка сессии'));
  const ready = await app.ev(untilTerminal('fake-claude ready'));
  return { tabMs: tab - t0, helloMs: ready - t0 };
}

// ---------- замеры ----------

/** Старт и память: время до готового окна и память в трёх состояниях. */
async function benchApp() {
  const app = await start('app');
  try {
    const out = { 'старт: DevTools слушает, мс': app.startup.devtoolsMs, 'старт: заголовок окна, мс': app.startup.titleMs, 'старт: проект и дерево, мс': app.startup.readyMs };
    await sleep(3000);
    const idle = appMemory(app.proc.pid);
    await app.ev(COUNTER);
    const session = await newSession(app);
    out['сессия: вкладка, мс'] = session.tabMs;
    out['сессия: приветствие claude, мс'] = session.helloMs;
    await sleep(3000);
    const withSession = appMemory(app.proc.pid);
    await app.ev(`window.cyborg.input(1, 'flood 20000 100\\r')`);
    await app.ev(untilTerminal('FLOOD-DONE 20000'));
    await sleep(3000);
    const afterFlood = appMemory(app.proc.pid);
    const unit = mac ? 'footprint' : 'Pss';
    const mib = (x) => x / 2 ** 20;
    for (const [label, m] of [['окно без сессий', idle], ['одна сессия', withSession], ['после 20 000 строк вывода', afterFlood]]) {
      out[`память ${unit}: ${label}: главный, МиБ`] = mib(m.main);
      out[`память ${unit}: ${label}: рендерер, МиБ`] = mib(m.renderer);
      out[`память ${unit}: ${label}: все процессы, МиБ`] = mib(m.total);
    }
    return out;
  } finally {
    await app.finish();
  }
}

/** Терминал: задержка эха и пропускная способность большого вывода. */
async function benchTerminal() {
  const app = await start('terminal');
  try {
    await app.ev(COUNTER);
    await newSession(app);
    const latencies = [];
    for (let i = 0; i < 30; i++) {
      const t0 = await app.ev('performance.now()');
      await app.ev(`window.cyborg.input(1, 'p${i}\\r')`);
      latencies.push((await app.ev(untilTerminal(`got: [p${i}]`))) - t0);
      await sleep(30);
    }
    const out = { 'терминал: задержка эха, медиана 30 проб, мс': median(latencies), 'терминал: задержка эха, p95 30 проб, мс': [...latencies].sort((a, b) => a - b)[Math.ceil(0.95 * latencies.length) - 1], 'терминал: задержка эха, макс. 30 проб, мс': Math.max(...latencies) };
    for (const lines of [50_000]) {
      await app.ev('window.__b.bytes = 0; window.__b.chunks = 0; window.__long.length = 0; true');
      const t0 = await app.ev('performance.now()');
      await app.ev(`window.cyborg.input(1, 'flood ${lines} 100\\r')`);
      const done = await app.ev(untilTerminal(`FLOOD-DONE ${lines}`));
      const { bytes, chunks, last, longs } = await app.ev('({ ...window.__b, longs: window.__long })');
      const seconds = (done - t0) / 1000;
      out[`терминал: вывод ${lines} строк, до последней строки на экране, мс`] = done - t0;
      out[`терминал: вывод ${lines} строк, пропускная способность, МБ/с`] = bytes / 1e6 / seconds;
      out[`терминал: вывод ${lines} строк, отставание экрана от последнего куска, мс`] = done - last;
      out[`терминал: вывод ${lines} строк, число кусков pty`] = chunks;
      out[`терминал: вывод ${lines} строк, байт`] = bytes;
      out[`терминал: вывод ${lines} строк, самая длинная блокировка окна, мс`] = longs.length ? Math.max(...longs) : 0;
    }
    return out;
  } finally {
    await app.finish();
  }
}

/** Время открытия поиска, «Расширений», панелей задач и MR и карточки «Статус» (первое открытие в запуске). */
async function benchUi() {
  const app = await start('ui', { FAKE_GH: 'data', FAKE_GH_ITEMS: '30' });
  try {
    const out = {};
    // Ожидание начинается в странице до клика, который идёт через DevTools главного процесса: в замер входят 1-3 мс доставки клика.
    const measure = async (label, trigger, condition) => {
      await app.ev(`window.__t0 = performance.now(); window.__p = ${untilCondition(condition, label)}; true`);
      await trigger();
      out[label] = (await app.ev('window.__p')) - (await app.ev('window.__t0'));
    };
    const dialogOpen = (id) => `document.querySelector('#${id}').open`;
    await measure('поиск файла: окно открыто, мс', () => clickMenu(app.mainEv, 'Найти файл…', 'Поиск'), dialogOpen('search-dialog'));
    await measure('поиск файла: результат по запросу «a.t», мс', () => app.ev(`(() => { const f = document.querySelector('#search-input'); f.value = 'a.t'; f.dispatchEvent(new Event('input')); })()`), `document.querySelector('#search-results mark')?.textContent === 'a.t'`);
    await escape(app);
    await measure('поиск в файлах: окно открыто, мс', () => clickMenu(app.mainEv, 'Найти в файлах…', 'Поиск'), dialogOpen('search-dialog'));
    await measure('поиск в файлах: результат по запросу «changed», мс', () => app.ev(`(() => { const f = document.querySelector('#search-input'); f.value = 'changed'; f.dispatchEvent(new Event('input')); })()`), '/Найдено 1/.test(document.querySelector("#search-status")?.innerText ?? "")');
    await escape(app);
    await measure('«Расширения»: магазины, строки видны, мс', () => clickMenu(app.mainEv, 'Магазины…', 'Расширения'), `[...document.querySelectorAll('#ext-tree [role=treeitem] .ext-label')].some((l) => l.textContent === 'smoke-market')`);
    await app.ev(click('#ext-close'));
    await measure('«Расширения»: установленные, строки видны, мс', () => clickMenu(app.mainEv, 'Установленные плагины и скиллы…', 'Расширения'), `document.querySelector('#ext-dialog').open && /own-skill/.test(document.querySelector('#ext-tree').innerText)`);
    await app.ev(click('#ext-close'));
    await measure('панель задач: 30 задач на экране, мс', () => app.ev(click('#tasks-toggle')), `!document.querySelector('#tasks-panel').hidden && document.querySelectorAll('#tasks-panel .task-row').length >= 30`);
    await app.ev(click('#tasks-toggle'));
    await measure('панель MR: 30 MR на экране, мс', () => app.ev(click('#mrs-toggle')), `!document.querySelector('#tasks-panel').hidden && document.querySelectorAll('#tasks-panel .task-row').length >= 30`);
    // Детали MR (пайплайн, апрувы) приходят вторым запросом: ждём, пока ни у одной строки не останется отметки загрузки.
    out['панель MR: детали догружены, мс'] = (await app.ev(untilCondition(`!/пайплайн: …/.test(document.querySelector('#tasks-panel').innerText)`, 'детали MR'))) - (await app.ev('window.__t0'));
    await app.ev(click('#mrs-toggle'));
    await measure('карточка «Статус»: открыта с задачей Jira, мс', () => app.ev(click('#status-toggle')), `!document.querySelector('#status-popover').hidden && /SMK-1/.test(document.querySelector('#status-popover').innerText)`);
    return out;
  } finally {
    await app.finish();
  }
}

/**
 * Вывод пришёл раньше, чем окно создало вкладку: окно между ответом на создание сессии и вкладкой ждёт `git rev-parse
 * --show-toplevel`, всё это время куски вывода копятся в pendingData. Подставной git растягивает ожидание до --git-delay секунд (по умолчанию 12: дольше, чем подставной claude выводит самый большой объём),
 * подставной claude при старте выводит N коротких строк по одной записи в pty (поток мелких кусков, как токены ответа). Растёт ли время нелинейно с N - смотрит сводка.
 */
async function benchPending(lines) {
  const app = await start(`pending-${lines}`, { FAKE_FLOOD_ON_START: String(lines), FAKE_FLOOD_STYLE: 'trickle', FAKE_GIT_DELAY: GIT_DELAY, PATH: `${join(fixtures, 'slow-git')}:${join(fixtures, 'fake-bin')}:${process.env.PATH}` });
  try {
    await app.ev(COUNTER);
    const busy0 = await app.busy();
    const t0 = await app.ev('performance.now()');
    await app.ev(`window.__tab = ${untilCondition('document.querySelectorAll("#session-list > *").length >= 1', 'вкладка')}.then((t) => ({ t, chunks: window.__b.chunks, bytes: window.__b.bytes })); true`);
    await app.ev(click('#new-session'));
    const done = await app.ev(untilTerminal(`FLOOD-DONE ${lines}`));
    const busyEnd = await app.busy();
    const tab = await app.ev('window.__tab');
    const { bytes, chunks, last, longs } = await app.ev('({ ...window.__b, longs: window.__long })');
    return {
      [`вывод при старте ${lines} строк: вкладка появилась, мс`]: tab.t - t0,
      [`вывод при старте ${lines} строк: кусков вывода накопилось до вкладки`]: tab.chunks,
      [`вывод при старте ${lines} строк: всего кусков`]: chunks,
      [`вывод при старте ${lines} строк: байт`]: bytes,
      [`вывод при старте ${lines} строк: до последней строки на экране, мс`]: done - t0,
      [`вывод при старте ${lines} строк: после вкладки до последней строки, мс`]: done - tab.t,
      [`вывод при старте ${lines} строк: отставание экрана от последнего куска, мс`]: done - last,
      [`вывод при старте ${lines} строк: главный поток окна занят всего, с`]: busyEnd - busy0,
      [`вывод при старте ${lines} строк: сумма блокировок окна, мс`]: longs.reduce((a, b) => a + b, 0),
      [`вывод при старте ${lines} строк: самая длинная блокировка окна, мс`]: longs.length ? Math.max(...longs) : 0,
    };
  } finally {
    await app.finish();
  }
}

/** Контроль к benchPending: тот же вывод N строк, но в уже открытой сессии (куски сразу идут в терминал, pendingData не участвует). */
async function benchLive(lines) {
  const app = await start(`live-${lines}`);
  try {
    await app.ev(COUNTER);
    await newSession(app);
    const busy0 = await app.busy();
    const t0 = await app.ev('performance.now()');
    await app.ev(`window.cyborg.input(1, 'trickle ${lines}\\r')`);
    const done = await app.ev(untilTerminal(`FLOOD-DONE ${lines}`));
    const busyEnd = await app.busy();
    const { bytes, chunks, last } = await app.ev('window.__b');
    return {
      [`вывод в сессии ${lines} строк: до последней строки на экране, мс`]: done - t0,
      [`вывод в сессии ${lines} строк: главный поток окна занят всего, с`]: busyEnd - busy0,
      [`вывод в сессии ${lines} строк: всего кусков`]: chunks,
      [`вывод в сессии ${lines} строк: байт`]: bytes,
      [`вывод в сессии ${lines} строк: отставание экрана от последнего куска, мс`]: done - last,
    };
  } finally {
    await app.finish();
  }
}

/** Размер собранных бандлов: байты на диске и в gzip. */
function benchBundles() {
  const out = {};
  const files = [['main.js', 'dist/main.js'], ['preload.js', 'dist/preload.js'], ['renderer/app.js', 'dist/renderer/app.js'], ['renderer/styles.css', 'dist/renderer/styles.css']];
  for (const [name, file] of files) {
    const path = join(appRoot, file);
    if (!existsSync(path)) throw new Error(`нет ${file}: сначала npm run build`);
    const bytes = readFileSync(path);
    out[`бандл ${name}, КиБ`] = bytes.length / 1024;
    out[`бандл ${name}, gzip, КиБ`] = gzipSync(bytes).length / 1024;
  }
  const size = (dir) =>
    readdirSync(dir, { withFileTypes: true }).reduce((sum, e) => sum + (e.isDirectory() ? size(join(dir, e.name)) : e.name.endsWith('.map') ? 0 : statSync(join(dir, e.name)).size), 0);
  out['dist целиком без sourcemap, МиБ'] = size(join(appRoot, 'dist')) / 2 ** 20;
  out['dist/renderer/vs (Monaco), МиБ'] = size(join(appRoot, 'dist', 'renderer', 'vs')) / 2 ** 20;
  return out;
}

// ---------- прогон ----------

if (!existsSync(join(appRoot, 'dist', 'main.js'))) {
  console.error('bench: нет dist/, сначала npm run build');
  process.exit(1);
}
const env = environment();
console.log(`bench: ${env.machine}, ${env.cpu}, ${env.memoryGiB} ГиБ, ${env.os}; commit ${env.commit}; нагрузка на старте ${env.loadavgAtStart.join(' ')}; прогонов ${RUNS}`);

const groups = [
  ['app', () => benchApp()],
  ['terminal', () => benchTerminal()],
  ['ui', () => benchUi()],
  ...SIZES.map((n) => ['pending', () => benchPending(n)]),
  ...SIZES.map((n) => ['live', () => benchLive(n)]),
  ['bundles', async () => benchBundles()],
].filter(([name]) => only.includes(name));

const runs = [];
const loads = [];
for (let i = 0; i < RUNS; i++) {
  const run = {};
  loads.push(loadavg().map((x) => Number(x.toFixed(2))));
  for (const [name, fn] of groups) {
    if (name === 'bundles' && i > 0) continue;
    try {
      Object.assign(run, await fn());
    } catch (e) {
      console.error(`bench: прогон ${i + 1}, ${name}: ОШИБКА: ${e.message}`);
      run[`ОШИБКА ${name}`] = String(e.message);
    }
  }
  runs.push(run);
  console.log(`bench: прогон ${i + 1} из ${RUNS} готов, нагрузка ${loadavg().map((x) => x.toFixed(2)).join(' ')}`);
}

const keys = [...new Set(runs.flatMap((r) => Object.keys(r)))].filter((k) => !k.startsWith('ОШИБКА'));
const summary = {};
for (const key of keys) {
  const values = runs.map((r) => r[key]).filter((v) => typeof v === 'number');
  if (values.length) summary[key] = stats(values);
}
const fmt = (x) => (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(2));
console.log('\nметрика | прогонов | минимум | медиана | максимум');
for (const [key, s] of Object.entries(summary)) console.log(`${key} | ${s.n} | ${fmt(s.min)} | ${fmt(s.median)} | ${fmt(s.max)}`);
const failures = runs.flatMap((r, i) => Object.entries(r).filter(([k]) => k.startsWith('ОШИБКА')).map(([k, v]) => `прогон ${i + 1}, ${k}: ${v}`));
if (failures.length) console.log(`\nнеудавшиеся замеры:\n${failures.join('\n')}`);

const result = { environment: { ...env, loadavgPerRun: loads, loadavgAtEnd: loadavg().map((x) => Number(x.toFixed(2))) }, runs, summary, failures };
if (jsonFile) writeFileSync(jsonFile, JSON.stringify(result, null, 2));
process.exitCode = failures.length ? 1 : 0;
