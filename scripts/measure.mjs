// Замер времени загрузки панелей задач и MR на любом проекте любого воркспейса:
//   node scripts/measure.mjs [--workspace файл] [--project имя или id] [--userdata каталог] [--runs 5] [--fake] [имя проекта]
// --workspace  файл воркспейса (любой путь, ADR-0014); по умолчанию projects.json в каталоге данных.
// --project    проект воркспейса по имени или id; по умолчанию последний выбранный (lastProjectId), иначе первый.
// --userdata   каталог данных приложения (там trackers.json); по умолчанию CYBORG_USERDATA, иначе каталог данных Electron:
//              ~/Library/Application Support/cyborg на macOS, $XDG_CONFIG_HOME/cyborg или ~/.config/cyborg на Linux.
// --runs       число прогонов каждого сценария (по умолчанию 5, или MEASURE_RUNS).
// --fake       подставные gh и glab-ответы из fixtures/fake-bin (FAKE_GH=data): без сети, без входа разработчика; trackers.json
//              не нужен, источники включены по проекту. Без флага ходит настоящий gh: нужен вход и remote GitHub у репозиториев проекта.
// Старый вызов `node scripts/measure.mjs Имя` работает: первое слово без флага - имя проекта.
// Ничего не пишет: бандл собирается во временный каталог вне репозитория и удаляется. Итог - медиана, минимум и максимум.
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

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : undefined; };
const FLAGS = new Set(['workspace', 'project', 'userdata', 'runs']);
const positional = args.filter((a, i) => !a.startsWith('--') && !FLAGS.has((args[i - 1] || '').slice(2)));
const home = process.env.HOME || '';
const configHome = process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : process.env.XDG_CONFIG_HOME || path.join(home, '.config');
const userData = flag('userdata') || process.env.CYBORG_USERDATA || path.join(configHome, 'cyborg');
const workspaceFile = path.resolve(flag('workspace') || path.join(userData, 'projects.json'));
const wanted = flag('project') || positional[0];
const fake = args.includes('--fake');
const fail = (message) => { console.error(message); process.exit(1); };

let state = { projects: [] };
try { state = JSON.parse(fs.readFileSync(workspaceFile, 'utf8')); } catch (e) { fail('Воркспейс не прочитан: ' + workspaceFile + ' (' + e.message + ')'); }
const projects = state.projects || [];
const project = wanted ? projects.find((p) => p.name === wanted || p.id === wanted) : projects.find((p) => p.id === state.lastProjectId) || projects[0];
if (!project) fail(wanted ? 'Проект «' + wanted + '» не найден в ' + workspaceFile + '; есть: ' + (projects.map((p) => p.name).join(', ') || 'ни одного') : 'В воркспейсе ' + workspaceFile + ' нет проектов');
const settings = fake && !fs.existsSync(path.join(userData, 'trackers.json'))
  ? { github: !!(project.trackers && project.trackers.github), gitlab: false }
  : new TrackerSettingsStore(path.join(userData, 'trackers.json')).load();
if (!settings.github && !settings.gitlab) fail('Источники не включены: ' + path.join(userData, 'trackers.json') + ' (или запустите с --fake)');
console.log('воркспейс ' + workspaceFile + ', проект «' + project.name + '», репозиториев ' + (project.repos || []).length + (fake ? ', подставной gh' : ', настоящий gh'));

const counts = {};
const base = createCliRunner(fs.existsSync(userData) ? userData : require('node:os').tmpdir());
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

const RUNS = Math.max(1, Number(flag('runs') || process.env.MEASURE_RUNS) || 5);
const reasons = (r) => (r.error ? [r.error] : []).concat(r.sources.filter((s) => s.error).map((s) => s.error));
const check = (what, r, hasItems) => {
  const problems = reasons(r);
  if (problems.length && !hasItems) fail(what + ': ' + problems[0]);
  if (!r.sources.some((s) => s.path)) fail(what + ': у репозиториев проекта нет подходящих remote или вход не выполнен');
};
const spread = (xs) => {
  const s = xs.filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  return { min: s[0], median: s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2, max: s[s.length - 1] };
};

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
const f = (r) => (r ? 'мин ' + r.min.toFixed(2) + ' / медиана ' + r.median.toFixed(2) + ' / макс ' + r.max.toFixed(2) + ' с' : 'нет');

(async () => {
  for (const [kind, once] of [['задачи', tasksOnce], ['MR', mrsOnce]]) {
    for (const [name, scenario] of scenarios) {
      const got = [];
      for (let i = 0; i < RUNS; i++) got.push(await scenario(once));
      const parts = ['список ' + f(spread(got.map((g) => g.list))) + ' (прогонов ' + RUNS + ')'];
      if (kind === 'MR') parts.push('детали ' + f(spread(got.map((g) => g.details))) + ' от начала выборки');
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
  const fake = process.argv.includes('--fake');
  const env = fake ? { ...process.env, PATH: `${join(repo, 'fixtures', 'fake-bin')}:${process.env.PATH}`, FAKE_GH: 'data' } : process.env;
  const run = spawnSync(process.execPath, [file, ...process.argv.slice(2)], { stdio: 'inherit', env });
  process.exitCode = run.status ?? 1;
} finally {
  rmSync(out, { recursive: true, force: true });
}
