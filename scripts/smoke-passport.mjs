// Смоук паспорта проекта на фейковом проекте: точка, окно, «Не нужно», подтверждение, проба вкладкой, граница записи (xvfb-run на Linux).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdp, launch, prepareFixtures, root, stop, waitFor } from './lib/driver.mjs';

const CAPABILITIES = ['why', 'behavior', 'done', 'domain', 'architecture', 'code-principles', 'decisions', 'autonomy', 'delivery', 'environment', 'escalation', 'upkeep'];

const base = realpathSync(mkdtempSync(join(tmpdir(), 'cyborg-smoke-passport-')));
const userData = join(base, 'userdata');
const repo = join(base, 'repo');
const passportDir = join(repo, '.cyborg', 'passport');
mkdirSync(userData);
mkdirSync(passportDir, { recursive: true });
mkdirSync(join(repo, 'docs'));
writeFileSync(join(repo, 'docs', 'a.md'), 'строка 1\nстрока 2\n');
const doc = '[Документ проекта](../../docs/a.md)';
for (const id of CAPABILITIES) writeFileSync(join(passportDir, `${id}.md`), `${doc}\n`);
rmSync(join(passportDir, 'why.md'));
writeFileSync(join(passportDir, 'behavior.md'), `${doc} не нашёл ⚠\n`);
writeFileSync(join(passportDir, 'done.md'), `${doc} ≈\n`);
const git = (...args) => execFileSync('git', ['-c', 'user.name=smoke', '-c', 'user.email=smoke@example.com', '-C', repo, ...args], { stdio: 'pipe' }).toString();
git('init', '-q', '-b', 'main');
git('add', '.');
git('commit', '-q', '-m', 'init');
writeFileSync(join(userData, 'projects.json'), JSON.stringify({ projects: [{ id: 'pp', name: 'Passport', description: '', repos: [repo], trackers: { github: false, gitlab: false } }], lastProjectId: 'pp' }));
writeFileSync(join(userData, 'hubs.json'), JSON.stringify({ custom: [], disabled: ['github-topic'] }));

const reportBody = join(base, 'report.json');
const reportOut = join(base, 'report.out');
const items = CAPABILITIES.filter((id) => id !== 'why').map((id) => ({ id, outcome: id === 'domain' ? 'unknown' : 'found', answer: 'ответ агента', source: id === 'behavior' ? 'docs/нет.md' : 'docs/a.md:2' }));
writeFileSync(reportBody, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'report_passport', arguments: { capabilities: items } } }));
const fixListBody = join(base, 'fix-list.json');
const fixCloseBody = join(base, 'fix-close.json');
const fixOut = join(base, 'fix.out');
writeFileSync(fixListBody, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_passport_items', arguments: {} } }));
writeFileSync(fixCloseBody, JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'close_passport_item', arguments: { id: 'autonomy', repo, answer: 'границы автономии в docs/a.md', source: 'docs/a.md:1' } } }));
const fixture = prepareFixtures(base, { FAKE_PASSPORT_BODY: reportBody, FAKE_PASSPORT_OUT: reportOut, FAKE_PASSPORT_FIX_LIST: fixListBody, FAKE_PASSPORT_FIX_BODY: fixCloseBody, FAKE_PASSPORT_FIX_OUT: fixOut });

const log = (text) => console.log(`smoke-passport: ${text}`);
let app;
try {
  const started = await launch({ dataDir: userData, cwd: root, electronArgs: process.argv.slice(2), env: fixture.env });
  app = started.proc;
  const page = await waitFor('страница окна', async () => (await started.pages())[0]);
  const { ev, socket } = await cdp(page.webSocketDebuggerUrl);
  const dot = () => ev('document.querySelector("#passport-dot").textContent');
  const click = (selector, label) =>
    ev(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(selector)})].find((x) => x.textContent === ${JSON.stringify(label)}); if (!b) throw new Error('нет кнопки ' + ${JSON.stringify(label)}); b.click(); })()`);
  const state = () => JSON.parse(readFileSync(join(passportDir, 'state.json'), 'utf8'));

  await waitFor('точка паспорта с тремя пробелами', async () => (await dot()) === '3');
  log('точка: 3 пробела (файла нет, ⚠, неподтверждённое ≈)');

  await ev('document.querySelector("#passport-dot").click()');
  await waitFor('окно паспорта', async () => (await ev('document.querySelector("#passport-dialog").open')) && (await ev('document.querySelectorAll("#passport-body .passport-row").length')) === 12);
  await click('[data-capability=why] button', 'Не нужно');
  await waitFor('«Не нужно» снимает способность', async () => (await dot()) === '2');
  await click('[data-capability=done] button', 'Подтвердить черновик');
  await waitFor('подтверждение черновика', async () => (await dot()) === '1');
  assert.deepEqual(state().notNeeded, ['why']);
  assert.ok(state().approxConfirmed.done, 'подтверждение ≈ не записано в состояние');
  log('окно: «Не нужно» и подтверждение черновика записаны в .cyborg/passport/state.json');

  await click('#passport-body .passport-head button', 'Проверить агентом');
  await waitFor('вкладка пробы', async () => (await ev('document.querySelectorAll("#session-list > *").length')) === 1);
  await waitFor('итог пробы принят', async () => (await dot()) === '7', 30000);
  assert.match(readFileSync(reportOut, 'utf8'), /нашёл с источником 9, выдумывает 1, не знает 1/);
  assert.match(readFileSync(fixture.argsLog, 'utf8'), /report_passport/);
  log('проба: вкладка сессии, итог через report_passport, исходы в точке (7)');

  const tabs = () => ev('document.querySelectorAll("#session-list > *").length');
  const openWindow = async () => {
    await ev('document.querySelector("#passport-dot").click()');
    await waitFor('окно паспорта', async () => (await ev('document.querySelector("#passport-dialog").open')) && (await ev('document.querySelectorAll("#passport-body .passport-row").length')) === 12);
  };
  const hasButton = (id, label) => ev(`[...document.querySelectorAll("[data-capability=${id}] button")].some((b) => b.textContent === ${JSON.stringify(label)})`);
  await openWindow();
  await waitFor('«Исправить» у autonomy после пробы', async () => hasButton('autonomy', 'Исправить'));
  await click('[data-capability=autonomy] button', 'Исправить');
  await waitFor('вкладка настройки и закрытие пункта', async () => (await tabs()) === 2 && (await dot()) === '6', 30000);
  const fixList = readFileSync(`${fixOut}.list`, 'utf8');
  assert.ok(/autonomy/.test(fixList) && /domain/.test(fixList), 'список пунктов без autonomy и domain');
  assert.match(readFileSync(`${fixOut}.close`, 'utf8'), /закрыт/);
  assert.match(readFileSync(fixture.argsLog, 'utf8'), /Настройка паспорта проекта/);
  assert.ok(state().closed.autonomy.hash, 'закрытие не записано в состояние');
  log('настройка: вкладка с начальным промптом, список пунктов и закрытие по HTTP, точка 6');
  await openWindow();
  const rowState = (id) => ev(`document.querySelector("[data-capability=${id}] .passport-state").textContent`);
  await waitFor('строка autonomy закрыта в сессии', async () => (await rowState('autonomy')) === 'закрыт в сессии');
  await ev('document.querySelector("#passport-close").click()');
  await ev('document.querySelector("#session-list > *:nth-child(1)").click()');
  await openWindow();
  await waitFor('«Исправить» у domain', async () => hasButton('domain', 'Исправить'));
  await click('[data-capability=domain] button', 'Исправить');
  await waitFor('переход к живой вкладке настройки', async () => (await ev('document.querySelector("#session-list > *:nth-child(2)").classList.contains("active")')) === true);
  assert.equal(await tabs(), 2, 'вторая вкладка настройки открыта');
  log('одна сессия на проект: «Исправить» у другого пункта переводит к живой вкладке');

  assert.deepEqual(git('status', '--porcelain', '-uall').trim().split('\n'), ['?? .cyborg/passport/state.json'], 'Cyborg записал в репозиторий не только состояние паспорта');
  assert.equal(git('diff', '--stat'), '', 'файлы паспорта изменены');
  log('граница записи: в репозитории изменилось только состояние паспорта');
  socket.close();
} finally {
  if (app) await stop(app);
  spawnSync('pkill', ['-f', base]);
  rmSync(base, { recursive: true, force: true });
}
log('OK');
