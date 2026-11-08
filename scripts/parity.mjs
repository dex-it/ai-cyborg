// Записанные сессии S1-S18 и их проигрыватель: сравнение поведения сборки с записью на уровне контрактов (каналы IPC между окном и
// главным процессом, вызовы внешних программ), а не по селекторам DOM.
//
//   npm run build && node scripts/parity.mjs [--record] [--full] [--dir test/parity] [--electron-arg --no-sandbox] [S01 S04 ...]
//   --full не обрезает строки в сообщении о расхождении.
//
// CYBORG_APP_DIR=<каталог> проигрывает записи против сборки другого экземпляра репозитория: записи сняты с коммита e4beb72,
// и проверяет их `git worktree add <каталог> e4beb72`, `npm run build` в нём и `CYBORG_APP_DIR=<каталог> node scripts/parity.mjs`.
// Без --record каждая запись проигрывается в свежем Electron (новый каталог данных, домашний каталог, репозиторий-проба,
// подставные программы из fixtures/) и сверяется с записанным `expect`; расхождение - код возврата 1 и первая различающаяся строка.
// С --record `expect` переписывается тем, что показал прогон; прогонов два, а каналы, различавшиеся между ними (гонки, опрос по
// таймеру), попадают в поле volatile записи и больше не сверяются: список виден в файле.
// Запись kind=expected - ожидаемое поведение ядра для сценария, у которого в Cyborg нет базы (S16-S18): проигрыватель её не играет.
//
// Что значит «совпало»:
//   contracts - для каждого канала IPC (invoke, send окна в главный процесс, event главного процесса в окно) та же последовательность
//               вызовов с теми же аргументами и ответами; порядок между каналами не сверяется (гонки каналов не дают ложных падений);
//   programs  - строки журналов подставных claude (аргументы запуска), claude plugin, gh и jira в порядке вызова;
//   probes    - значения, снятые шагом probe (число вкладок, видимый текст терминала и т.п.).
// Шаги сценария управляют окном: меню - в главном процессе, клавиши - через DevTools, остальное - вызовы window.cyborg и
// действия в странице (селекторы по id нужны только для управления: у окна нет другой точки входа).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { appRoot, cdp, clickMenu, killLeftovers, launch, prepareFixtures, root, sleep, stop, waitFor } from './lib/driver.mjs';

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const record = argv.includes('--record');
const CUT = argv.includes('--full') ? Infinity : 300;
const dir = join(root, option('dir', 'test/parity'));
const electronArgs = argv.flatMap((a, i) => (argv[i - 1] === '--electron-arg' ? [a] : []));
const wanted = argv.filter((a, i) => /^S\d+/.test(a) && argv[i - 1] !== '--dir');
const mac = process.platform === 'darwin';
const MODS = { alt: 1, ctrl: 2, meta: 4, shift: 8, cmd: mac ? 4 : 2 };

// ---------- мир сценария ----------

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=parity', '-c', 'user.email=parity@example.com', '-C', cwd, ...args], { stdio: 'pipe' });

/** Каталоги и файлы одного прогона: репозиторий с remote GitHub, worktree, ветка с ключом Jira, воркспейс из двух проектов. */
function makeWorld(session) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cyborg-parity-')));
  const world = { base, userdata: join(base, 'userdata'), repo: join(base, 'repo'), worktree: join(base, 'repo-wt'), home: join(base, 'home') };
  for (const d of [world.userdata, world.repo, world.home]) mkdirSync(d);
  git(world.repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(world.repo, 'a.txt'), 'hello\n');
  git(world.repo, 'add', 'a.txt');
  git(world.repo, 'commit', '-q', '-m', 'init');
  git(world.repo, 'remote', 'add', 'origin', 'https://github.com/acme/demo.git');
  writeFileSync(join(world.repo, 'a.txt'), 'hello\nchanged\n');
  git(world.repo, 'worktree', 'add', '-q', '-b', 'parity-wt', world.worktree);
  git(world.repo, 'branch', 'smk-5-feature');
  const projects = {
    projects: [
      { id: 'p1', name: 'Smoke', description: '', repos: [world.repo], trackers: { github: true, gitlab: false }, jira: { enabled: true, projects: [] } },
      { id: 'p2', name: 'Bare', description: '', repos: [world.repo], trackers: { github: false, gitlab: false } },
    ],
    lastProjectId: 'p1',
  };
  writeFileSync(join(world.userdata, 'projects.json'), JSON.stringify(projects));
  writeFileSync(join(world.userdata, 'hubs.json'), JSON.stringify({ custom: [], disabled: ['github-topic'] }));
  const extraEnv = { HOME: world.home, ...(session.world?.gh === 'data' ? { FAKE_GH: 'data', FAKE_GH_ITEMS: '3' } : {}), ...(session.world?.env ?? {}) };
  return { ...world, fx: prepareFixtures(base, extraEnv) };
}

const fill = (world, value) => {
  if (typeof value === 'string') return value.replaceAll('{repo}', world.repo).replaceAll('{worktree}', world.worktree).replaceAll('{base}', world.base).replaceAll('{userdata}', world.userdata).replaceAll('{repoDir}', world.repo.replace(/[^a-zA-Z0-9]/g, '-')).replaceAll('{home}', world.home).replaceAll('{claudeHome}', world.fx.claudeHome);
  if (Array.isArray(value)) return value.map((v) => fill(world, v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(world, v)]));
  return value;
};

// ---------- нормализация записи ----------

const digest = (text) => createHash('sha1').update(text).digest('hex').slice(0, 8);
const LONG = 400;

/** Пути прогона заменяются именами, длинные строки - началом и контрольной суммой, переносы строк терминала и ANSI-хвосты убираются. */
function normalizer(world) {
  const names = [[join(root, 'fixtures'), '<fixtures>'], [world.worktree, '<worktree>'], [world.repo, '<repo>'], [world.userdata, '<userdata>'], [world.home, '<home>'], [world.base, '<base>']];
  const text = (s) => {
    let out = s;
    for (const [path, name] of names) out = out.replaceAll(path, name);
    return out.length > LONG ? `${out.slice(0, 200)}…[${out.length} знаков, sha1 ${digest(out)}]` : out;
  };
  const walk = (v) => {
    if (typeof v === 'string') return text(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [text(k), walk(x)]));
    return v;
  };
  return { text, walk };
}

// ---------- трасса контрактов в главном процессе ----------

/** Каналы с побочным действием на машине разработчика (браузер, файловый менеджер): вызов пишется в трассу, но не исполняется. */
const STUBBED = ['url:open', 'path:open', 'config:reveal', 'tasks:open', 'mrs:open'];

/**
 * Оборачивает обработчики invoke, события окну и слушает send-каналы окна; всё пишется в globalThis.__parity главного процесса.
 * Системные уведомления не показываются, а пишутся в трассу (настоящие всплыли бы у разработчика), каналы из STUBBED не исполняются.
 */
const INSTALL_TRACE = `(() => {
  const electron = process.mainModule.require('electron');
  const { ipcMain, BrowserWindow } = electron;
  const log = (globalThis.__parity = []);
  const brief = (v) => { try { return JSON.parse(JSON.stringify(v ?? null)); } catch { return String(v); } };
  const stubbed = new Set(${JSON.stringify(STUBBED)});
  const handlers = ipcMain._invokeHandlers;
  for (const [channel, fn] of [...handlers]) {
    handlers.set(channel, async (event, ...args) => {
      const entry = { kind: 'invoke', channel, args: brief(args) };
      log.push(entry);
      if (stubbed.has(channel)) { entry.result = 'не исполнено проигрывателем'; return undefined; }
      try { const result = await fn(event, ...args); entry.result = brief(result); return result; }
      catch (error) { entry.error = String(error && error.message || error); throw error; }
    });
  }
  const sends = ${JSON.stringify(['session:input', 'session:resize', 'session:kill', 'session:notify', 'session:unnotify', 'notifications:state', 'project:selected'])};
  for (const channel of sends) ipcMain.on(channel, (_event, ...args) => log.push({ kind: 'send', channel, args: brief(args) }));
  globalThis.__parityWindow = () => {
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    const send = wc.send.bind(wc);
    wc.send = (channel, ...args) => { log.push({ kind: 'event', channel, args: brief(args) }); return send(channel, ...args); };
  };
  globalThis.__parityWindow();
  // Свойство Notification у electron не переопределяется, поэтому подменяются методы прототипа: show пишет заголовок и текст в трассу и ничего не показывает.
  const proto = electron.Notification.prototype;
  proto.show = function () { log.push({ kind: 'os', channel: 'Notification.show', args: [{ title: this.title, body: this.body }] }); };
  proto.close = function () { log.push({ kind: 'os', channel: 'Notification.close', args: [] }); };
  return handlers.size;
})()`;

/** Трасса -> по каналам: вызовы одного канала в порядке прихода. Вывод сессий склеивается (границы кусков pty случайны). */
function byChannel(trace, norm) {
  const out = {};
  const data = new Map();
  for (const entry of trace) {
    if (entry.kind === 'event' && entry.channel === 'session:data') {
      const { id, data: chunk } = entry.args[0];
      data.set(id, (data.get(id) ?? '') + chunk);
      continue;
    }
    if (entry.kind === 'send' && entry.channel === 'session:input') {
      // Ввод склеивается по сессии так же, как вывод: приложение может дробить его на любые куски.
      const [id, chunk] = entry.args;
      const list = (out['send session:input'] ??= []);
      const last = list.at(-1);
      if (last && last.id === id) last.data += chunk;
      else list.push({ id, data: chunk });
      continue;
    }
    const key = `${entry.kind} ${entry.channel}`;
    const { kind, channel, ...rest } = entry;
    (out[key] ??= []).push(norm.walk(rest));
  }
  for (const [id, text] of data) (out['event session:data'] ??= []).push({ id, text: norm.text(text.replace(/\r/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')) });
  for (const list of Object.values(out)) for (let i = 0; i < list.length; i++) list[i] = norm.walk(list[i]);
  return out;
}

const readLines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
/** Журнал запусков claude: запись начинается с `--settings` (промпт внутри многострочный). */
const readLaunches = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split(/\n(?=--settings )/).map((x) => x.trim()).filter(Boolean) : []);

// ---------- шаги ----------

async function play(session, world) {
  const norm = normalizer(world);
  const started = await launch({ dataDir: world.userdata, env: world.fx.env, electronArgs });
  const page = await waitFor('страница окна', async () => (await started.pages())[0]);
  const mainEv = (await cdp(started.inspect)).ev;
  let { ev, send } = await cdp(page.webSocketDebuggerUrl);
  let pageId = page.id;
  const probes = {};
  try {
    await waitFor('окно и проект', async () => /Smoke/.test(await ev('document.querySelector("#project-select")?.innerText ?? ""')));
    // Запуск окна заканчивается вызовами загрузки (кнопки, проекты, ветки): трасса начинается после них, иначе их число зависит от гонки.
    await sleep(1500);
    await mainEv(INSTALL_TRACE);
    // Окно не должно останавливаться на встроенных вопросах: confirm принимает, alert молчит (сам вызов виден в трассе по последствиям).
    await ev('window.confirm = () => true; window.alert = () => {}; true');
    for (const [index, raw] of (session.steps ?? []).entries()) {
      const step = fill(world, raw);
      try {
        switch (step.do) {
          case 'menu':
            await clickMenu(mainEv, step.item, step.menu ?? 'Воркспейс');
            break;
          case 'key': {
            const modifiers = (step.mods ?? []).reduce((sum, m) => sum | MODS[m], 0);
            const k = { key: step.key, code: step.code, windowsVirtualKeyCode: step.vk, modifiers };
            await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k });
            await send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
            break;
          }
          case 'js':
            await ev(step.js);
            break;
          case 'call': {
            const answer = await ev(`window.cyborg.${step.method}(...${JSON.stringify(step.args ?? [])}).then((value) => ({ value }), (error) => ({ error: String(error && error.message || error) }))`);
            if (step.as) probes[step.as] = norm.walk(answer);
            break;
          }
          case 'main':
            await mainEv(step.js);
            break;
          case 'reattach': {
            // Смена воркспейса открывает новое окно вместо старого: соединение переносится на него, подмена send ставится заново.
            const next = await waitFor('новое окно', async () => (await started.pages()).find((p) => p.id !== pageId));
            ({ ev, send } = await cdp(next.webSocketDebuggerUrl));
            pageId = next.id;
            await mainEv('globalThis.__parityWindow()');
            await ev('window.confirm = () => true; window.alert = () => {}; true');
            break;
          }
          case 'input':
            await ev(`window.cyborg.input(${step.session ?? 1}, ${JSON.stringify(step.text)})`);
            break;
          case 'write':
            mkdirSync(dirname(step.file), { recursive: true });
            writeFileSync(step.file, typeof step.json === 'undefined' ? step.text : JSON.stringify(step.json));
            if (step.mtime) utimesSync(step.file, step.mtime, step.mtime);
            break;
          case 'clickText': {
            // Клик по тексту в видимом терминале: середина найденного отрезка строки, мышь двигается, затем нажимается.
            const rect = await ev(`(() => {
              const rows = [...document.querySelectorAll('.xterm-rows')].find((e) => e.offsetParent);
              const needle = ${JSON.stringify(step.text)};
              for (const row of rows.children) {
                const at = row.textContent.indexOf(needle);
                if (at < 0) continue;
                const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
                let offset = 0;
                for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                  const end = offset + node.length;
                  if (at < end) {
                    const range = document.createRange();
                    range.setStart(node, at - offset);
                    range.setEnd(node, Math.min(at - offset + 3, node.length));
                    const r = range.getBoundingClientRect();
                    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
                  }
                  offset = end;
                }
              }
              return null;
            })()`);
            if (!rect) throw new Error(`в терминале нет текста «${step.text}»`);
            await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x - 1, y: rect.y });
            await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
            await sleep(250);
            await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
            await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
            break;
          }
          case 'wait':
            await waitFor(step.what ?? step.js, () => ev(step.js), step.timeout ?? 20_000);
            break;
          case 'waitTrace':
            await waitFor(step.what ?? step.channel, () => mainEv(`globalThis.__parity.some((e) => e.channel === ${JSON.stringify(step.channel)})`), step.timeout ?? 20_000);
            break;
          case 'sleep':
            await sleep(step.ms);
            break;
          case 'probe':
            probes[step.name] = norm.walk(await ev(step.js));
            break;
          default:
            throw new Error(`неизвестный шаг ${step.do}`);
        }
      } catch (error) {
        throw new Error(`шаг ${index + 1} (${raw.do}${raw.what ? ` «${raw.what}»` : ''}): ${error.message}${Object.keys(probes).length ? `\n  снято до сбоя: ${JSON.stringify(probes)}` : ''}`);
      }
    }
    await sleep(session.settleMs ?? 600);
    const trace = await mainEv('globalThis.__parity');
    const contracts = byChannel(trace, norm);
    const programs = {
      claude: readLaunches(world.fx.argsLog).map(norm.text),
      // Хвост запуска: стартовое сообщение сессии (промпт кнопки) и --add-dir, читаемо; середина - системный промпт - сверяется суммой в claude.
      claudeTail: readLaunches(world.fx.argsLog).map((l) => norm.text(l.slice(-300))),
      plugin: readLines(world.fx.pluginLog).map(norm.text),
      gh: readLines(world.fx.ghLog).map(norm.text),
      jira: readLines(world.fx.jiraLog).map(norm.text),
    };
    // Вызовы gh, jira и claude plugin идут пулом: порядок между вызовами не значим, сверяется набор.
    for (const key of ['gh', 'jira', 'plugin']) programs[key].sort();
    for (const key of Object.keys(programs)) if (!programs[key].length) delete programs[key];
    return { contracts, programs, probes };
  } finally {
    await stop(started.proc);
    killLeftovers(world.base);
  }
}

/** Каналы, объявленные летучими при записи (различались между двумя проходами: гонки, опрос по таймеру): не сверяются, список - в поле volatile записи. */
const volatile = (session) => new Set(session.volatile ?? []);

function diff(session, want, got) {
  const lines = [];
  const skip = volatile(session);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const part of ['contracts', 'programs', 'probes']) {
    const keys = new Set([...Object.keys(want[part] ?? {}), ...Object.keys(got[part] ?? {})]);
    for (const key of keys) {
      const a = want[part]?.[key];
      const b = got[part]?.[key];
      if (skip.has(key)) continue;
      if (same(a, b)) continue;
      if (Array.isArray(a) && Array.isArray(b)) {
        const i = a.findIndex((x, n) => !same(x, b[n]));
        const at = i === -1 ? Math.min(a.length, b.length) : i;
        lines.push({ key, text: `${part}.${key}: на вызове ${at + 1} записано ${JSON.stringify(a[at])?.slice(0, CUT)}, получено ${JSON.stringify(b[at])?.slice(0, CUT)} (всего ${a.length} / ${b.length})` });
      } else lines.push({ key, text: `${part}.${key}: записано ${JSON.stringify(a)?.slice(0, CUT)}, получено ${JSON.stringify(b)?.slice(0, CUT)}` });
    }
  }
  return lines;
}

// ---------- запуск ----------

if (!existsSync(join(appRoot, 'dist', 'main.js'))) {
  console.error('parity: нет dist/, сначала npm run build');
  process.exit(1);
}
const files = readdirSync(dir)
  .filter((f) => /^S\d+.*\.json$/.test(f))
  .sort()
  .filter((f) => !wanted.length || wanted.some((w) => f.startsWith(w)));
let failed = 0;
for (const file of files) {
  const path = join(dir, file);
  const session = JSON.parse(readFileSync(path, 'utf8'));
  if (session.kind === 'expected') {
    console.log(`parity: ${session.id} ${session.title}: ожидаемое поведение, не играется`);
    continue;
  }
  const passes = record ? 2 : 1;
  const results = [];
  let error;
  for (let i = 0; i < passes && !error; i++) {
    const world = makeWorld(session);
    try {
      results.push(await play(session, world));
    } catch (e) {
      error = e;
    } finally {
      rmSync(world.base, { recursive: true, force: true });
    }
  }
  if (error) {
    failed++;
    console.log(`parity: ${session.id} ${session.title}: ОШИБКА: ${error.message}`);
    continue;
  }
  if (record) {
    // Записывается пересечение двух проходов: то, что различается между ними (часы, гонки), в запись не попадает и называется.
    const [a, b] = results;
    const unstable = diff({}, a, b);
    if (unstable.length) console.log(`parity: ${session.id}: нестабильно между двумя проходами:\n  ${unstable.map((u) => u.text).join('\n  ')}`);
    session.expect = a;
    session.volatile = [...new Set([...(session.volatile ?? []), ...unstable.map((u) => u.key)])];
    writeFileSync(path, `${JSON.stringify(session, null, 2)}\n`);
    console.log(`parity: ${session.id} ${session.title}: записано${unstable.length ? ` (нестабильных каналов: ${unstable.length})` : ''}`);
    continue;
  }
  const lines = diff(session, session.expect ?? {}, results[0]);
  if (lines.length) {
    failed++;
    console.log(`parity: ${session.id} ${session.title}: РАСХОЖДЕНИЕ\n  ${lines.map((l) => l.text).join('\n  ')}`);
  } else console.log(`parity: ${session.id} ${session.title}: совпало`);
}
console.log(failed ? `parity: не прошло ${failed} из ${files.length}` : `parity: все ${files.length} прошли`);
process.exitCode = failed ? 1 : 0;
