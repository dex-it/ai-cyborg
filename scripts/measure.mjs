// Замер времени загрузки панели на реальном проекте: node scripts/measure.mjs [имя проекта, по умолчанию Upcore].
// Читает projects.json и trackers.json из CYBORG_USERDATA (по умолчанию каталог данных Electron: ~/Library/Application Support/cyborg
// на macOS, $XDG_CONFIG_HOME/cyborg или ~/.config/cyborg на Linux), ничего не пишет:
// бандл собирается во временный каталог вне репозитория и удаляется.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const repo = resolve(import.meta.dirname, '..');
const entry = `
import fs from 'node:fs';
import path from 'node:path';
import { gitRemotes } from './src/main/git';
import { MrsService } from './src/main/mrs-service';
import { createCliRunner, TrackerSettingsStore, TrackersService } from './src/main/trackers';

const home = process.env.HOME || '';
const configHome = process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : process.env.XDG_CONFIG_HOME || path.join(home, '.config');
const userData = process.env.CYBORG_USERDATA || path.join(configHome, 'cyborg');
const name = process.argv[2] || 'Upcore';
const fail = (message) => { console.error(message); process.exit(1); };

let state = { projects: [] };
try { state = JSON.parse(fs.readFileSync(path.join(userData, 'projects.json'), 'utf8')); } catch {}
const project = (state.projects || []).find((p) => p.name === name);
if (!project) fail('Проект «' + name + '» не найден в ' + path.join(userData, 'projects.json'));
const settings = new TrackerSettingsStore(path.join(userData, 'trackers.json')).load();
if (!settings.github && !settings.gitlab) fail('Источники не включены: ' + path.join(userData, 'trackers.json'));

const counts = {};
const base = createCliRunner(userData);
const run = (cmd, args) => {
  const kind = cmd + ' ' + (args[0] === 'auth' ? 'auth status' : args.includes('graphql') ? 'api graphql' : args.includes('user') ? 'api user' : 'api');
  counts[kind] = (counts[kind] || 0) + 1;
  return base(cmd, args);
};
// Новый сервис на каждый прогон: кэш входа пуст, как после запуска приложения.
const fresh = () => {
  const trackers = new TrackersService({ run, remotes: gitRemotes, projects: () => state, settings: () => settings });
  return { trackers, mrs: new MrsService(trackers, run) };
};

const RUNS = Math.max(1, Number(process.env.MEASURE_RUNS) || 5);
const reasons = (r) => (r.error ? [r.error] : []).concat(r.sources.filter((s) => s.error).map((s) => s.error));
const check = (what, r, hasItems) => {
  const problems = reasons(r);
  if (problems.length && !hasItems) fail(what + ': ' + problems[0]);
  if (!r.sources.some((s) => s.path)) fail(what + ': у репозиториев проекта нет подходящих remote или вход не выполнен');
};
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

async function tasksOnce(svc, recheck) {
  const t0 = performance.now();
  const r = await svc.trackers.list(project.id, false, [], recheck);
  check('задачи', r, r.tasks.length > 0);
  return { list: (performance.now() - t0) / 1000 };
}

async function mrsOnce(svc, recheck) {
  const t0 = performance.now();
  const list = await svc.mrs.listMrs(project.id, 'all', [], recheck);
  const listT = (performance.now() - t0) / 1000;
  check('MR', list, list.mrs.length > 0);
  let details = NaN;
  if (list.detailsId !== null) {
    await svc.mrs.details(list.detailsId);
    details = (performance.now() - t0) / 1000;
  }
  return { list: listT, details };
}

// Сценарии: п.20 - выборка после завершённой проверки входа при старте; п.21 - «Обновить» при прежнем результате;
// «без прежнего результата» - справочно; «прогрето» - повтор без сброса кэша.
const scenarios = [
  ['п.20 после проверки при старте', async (once) => { const s = fresh(); await s.trackers.warmAuth(); return once(s, false); }],
  ['п.21 «Обновить» при прежнем результате', async (once) => { const s = fresh(); await s.trackers.warmAuth(); return once(s, true); }],
  ['справочно: без прежнего результата', async (once) => once(fresh(), true)],
  ['прогрето (кэш входа не сбрасывается)', async (once) => { const s = fresh(); await s.trackers.warmAuth(); await once(s, false); return once(s, false); }],
];
const f = (x) => (Number.isNaN(x) ? 'нет' : x.toFixed(2) + ' с');

(async () => {
  for (const [kind, once] of [['задачи', tasksOnce], ['MR', mrsOnce]]) {
    for (const [name, scenario] of scenarios) {
      const got = [];
      for (let i = 0; i < RUNS; i++) got.push(await scenario(once));
      const parts = ['список ' + f(median(got.map((g) => g.list))) + ' (медиана из ' + RUNS + ')'];
      if (kind === 'MR') parts.push('детали ' + f(median(got.map((g) => g.details))) + ' от начала выборки');
      console.log(kind + ' [' + name + ']: ' + parts.join(', '));
    }
  }
  console.log('вызовов CLI: ' + JSON.stringify(counts));
})().catch((e) => fail(String((e && e.message) || e)));
`;

const out = mkdtempSync(join(tmpdir(), 'cyborg-measure-'));
try {
  const file = join(out, 'measure.cjs');
  await build({
    stdin: { contents: entry, resolveDir: repo, sourcefile: 'measure-entry.ts', loader: 'ts' },
    outfile: file,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron', 'node-pty'],
    logLevel: 'warning',
  });
  const run = spawnSync(process.execPath, [file, ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exitCode = run.status ?? 1;
} finally {
  rmSync(out, { recursive: true, force: true });
}
