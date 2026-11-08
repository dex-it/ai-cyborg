// Общий драйвер Electron для дымового теста, замеров и проигрывателя записей: запуск dist/ с подставными программами из
// fixtures/, управление окном по DevTools Protocol, ожидание условий. Ничего не пишет вне переданных временных каталогов.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const root = resolve(import.meta.dirname, '..', '..');
export const fixtures = join(root, 'fixtures');
/** Проверяемая сборка: по умолчанию этот репозиторий; CYBORG_APP_DIR указывает на другой его экземпляр (например, `git worktree` на нужном коммите после `npm run build`). */
export const appRoot = resolve(process.env.CYBORG_APP_DIR || root);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const TIMEOUT_MS = 20_000;
// Вызов DevTools под нагрузкой машины (свопинг, чужие процессы, Monaco при первом показе) отвечает дольше 15 с: на CI и на ноутбуке это давало случайные падения.
export const CDP_TIMEOUT_MS = 30_000;

/**
 * Подставные программы и данные Claude Code из fixtures/ для одного прогона: `base` - временный каталог прогона.
 * fixtures/fake-bin лежит на месте (программы только читаются), каталог настроек Claude копируется (его можно менять),
 * журналы вызовов идут в `base`. `env` добавляется к окружению Electron.
 */
export function prepareFixtures(base, extraEnv = {}) {
  const fakeBin = join(fixtures, 'fake-bin');
  const claudeHome = join(base, 'claude-home');
  const logs = join(base, 'logs');
  mkdirSync(logs, { recursive: true });
  cpSync(join(fixtures, 'claude-home'), claudeHome, { recursive: true });
  const argsLog = join(logs, 'args.log');
  const pluginLog = join(logs, 'plugin.log');
  const ghLog = join(logs, 'gh.log');
  const jiraLog = join(logs, 'jira.log');
  const market = join(fixtures, 'market');
  const suggest = join(fakeBin, 'suggest.json');
  const env = {
    PATH: `${fakeBin}:${process.env.PATH}`,
    SHELL: join(fakeBin, 'shell'),
    FAKE_SUGGEST: suggest,
    FAKE_ARGS_LOG: argsLog,
    FAKE_PLUGIN_LOG: pluginLog,
    FAKE_GH_LOG: ghLog,
    FAKE_JIRA_LOG: jiraLog,
    FAKE_MARKET: market,
    CLAUDE_CONFIG_DIR: claudeHome,
    ...extraEnv,
  };
  return { fakeBin, claudeHome, argsLog, pluginLog, ghLog, jiraLog, market, suggest, env };
}

export async function waitFor(what, probe, timeout = TIMEOUT_MS) {
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

/** Реестр открытых соединений DevTools: закрывается перед остановкой приложения (Node при выходе ждёт, пока отладчик отключится). */
export const sockets = [];

/** Соединение с целью DevTools: страницей окна или главным процессом (--inspect). Без ответа на вызов прогон падает с причиной, а не висит. */
export async function cdp(url, timeoutMs = CDP_TIMEOUT_MS) {
  const socket = new WebSocket(url);
  sockets.push(socket);
  await new Promise((r, j) => {
    socket.onopen = r;
    socket.onerror = () => j(new Error('нет соединения с DevTools'));
  });
  let seq = 0;
  const pending = new Map();
  const listeners = [];
  socket.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) pending.get(d.id)(d);
    else if (d.method) for (const l of listeners) l(d);
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++seq;
      const timer = setTimeout(() => rej(new Error(`DevTools ${method}${typeof params.expression === 'string' ? ` «${params.expression.replace(/\s+/g, ' ').slice(0, 90)}»` : ''}: нет ответа за ${timeoutMs / 1000} с`)), timeoutMs);
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
  return { socket, send, ev, onEvent: (l) => listeners.push(l) };
}

/**
 * Запуск Electron с отдельным каталогом данных; возвращает процесс, чтение stderr и адреса DevTools окна и главного процесса.
 * `env` - окружение сверх унаследованного (переменные CYBORG_* родителя отбрасываются: смоук, запущенный из сессии Cyborg,
 * унаследовал бы её CYBORG_CWD, и относительный --workspace считался бы не от cwd).
 */
export async function launch({ dataDir, env, args = [], electronArgs = [], cwd = appRoot }) {
  const electron = [appRoot, root].map((dir) => join(dir, 'node_modules', '.bin', 'electron')).find((file) => existsSync(file));
  const proc = spawn(electron, [appRoot, `--user-data-dir=${dataDir}`, '--remote-debugging-port=0', '--inspect=0', ...electronArgs, ...args], {
    cwd,
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CYBORG_'))), ...env },
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

/** SIGTERM и ожидание выхода; false - не завершилось за timeout мс. */
export async function stop(proc, timeout = 8000) {
  for (const socket of sockets.splice(0)) {
    try {
      socket.close();
    } catch {}
  }
  if (proc.exitCode !== null) return true;
  proc.kill('SIGTERM');
  const exited = await Promise.race([new Promise((r) => (proc.exitCode !== null ? r(true) : proc.once('exit', () => r(true)))), sleep(timeout).then(() => false)]);
  if (!exited) proc.kill('SIGKILL');
  return exited;
}

/** Сессия, пережившая убитый Electron, держит каналы вывода: чистим по пути прогона. Код pkill не смотрится: 1 - процессов не осталось. */
export const killLeftovers = (base) => spawnSync('pkill', ['-f', base]);

/** Пункт системного меню по подписям меню -> подпись («Воркспейс» по умолчанию); клик в главном процессе. */
export const clickMenu = (mainEv, label, menu = 'Воркспейс') =>
  mainEv(`(() => {
    const { Menu } = process.mainModule.require('electron');
    const item = Menu.getApplicationMenu().items.find((i) => i.label === ${JSON.stringify(menu)}).submenu.items.find((i) => i.label === ${JSON.stringify(label)});
    if (!item) throw new Error('нет пункта ${label}');
    item.click();
    return item.enabled;
  })()`);
