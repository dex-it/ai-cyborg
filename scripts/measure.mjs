// Замер времени загрузки панели на реальном проекте: node scripts/measure.mjs [имя проекта, по умолчанию Upcore].
// Читает projects.json и trackers.json из CYBORG_USERDATA (по умолчанию ~/.config/cyborg), ничего не пишет:
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

const userData = process.env.CYBORG_USERDATA || path.join(process.env.HOME || '', '.config', 'cyborg');
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
const trackers = new TrackersService({ run, remotes: gitRemotes, projects: () => state, settings: () => settings });
const mrs = new MrsService(trackers, run);

const secs = (t0) => ((performance.now() - t0) / 1000).toFixed(2) + ' с';
const reasons = (r) => (r.error ? [r.error] : []).concat(r.sources.filter((s) => s.error).map((s) => s.error));
const check = (what, r, hasItems) => {
  const problems = reasons(r);
  if (problems.length && !hasItems) fail(what + ': ' + problems[0]);
  if (!r.sources.some((s) => s.path)) fail(what + ': у репозиториев проекта нет подходящих remote или вход не выполнен');
};

async function tasks(label, recheck) {
  const t0 = performance.now();
  const r = await trackers.list(project.id, false, [], recheck);
  console.log('задачи (' + label + '): ' + secs(t0) + ', задач ' + r.tasks.length);
  check('задачи', r, r.tasks.length > 0);
}

async function mrList(label, recheck) {
  const t0 = performance.now();
  const list = await mrs.listMrs(project.id, 'all', [], recheck);
  console.log('MR список (' + label + '): ' + secs(t0) + ', MR ' + list.mrs.length);
  check('MR', list, list.mrs.length > 0);
  if (list.detailsId !== null) {
    const d = await mrs.details(list.detailsId);
    const got = d ? d.details.filter((x) => x.pipeline !== null).length : 0;
    console.log('MR детали (' + label + '): ' + secs(t0) + ' от начала выборки, с пайплайном ' + got + ' из ' + list.awaiting.length);
  }
}

(async () => {
  await tasks('холодно', true);
  await tasks('прогрето', false);
  await mrList('холодно', true);
  await mrList('прогрето', false);
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
