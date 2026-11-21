import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

// `npm test` запускается из корня репозитория (scripts/test.mjs читает test/ относительно него).
const root = process.cwd();

function sources(dir: string): string[] {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(rel);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [rel] : [];
  });
}

/** Код без строк-комментариев: упоминание запрещённого в пояснении не считается использованием. */
const code = (file: string): string =>
  fs
    .readFileSync(path.join(root, file), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
    .join('\n');

describe('данные задачи и MR - текстом (FR-1018)', () => {
  it('в интерфейсе нет разметки из строки: innerHTML, outerHTML, insertAdjacentHTML, document.write, createContextualFragment', () => {
    const files = sources('src/renderer');
    assert.ok(files.length > 10, 'исходники интерфейса не найдены');
    const found = files.flatMap((file) =>
      [...code(file).matchAll(/\b(innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment)\b|document\.write\b/g)].map((m) => `${file}: ${m[0]}`),
    );
    assert.deepEqual(found, []);
  });
});

describe('привязка задачи и MR к сессии только в памяти (FR-1015, FR-2014)', () => {
  it('интерфейс пишет в хранилище окна только известные настройки, ни одной - про задачи, MR и сессии', () => {
    const allowed = [/^'cyborg\.fontSize'$/, /^NOTIFICATIONS_KEY$/, /^'cyborg\.tasks\.(assigned|sort)'$/, /^'cyborg\.mrs\.(filter|sort)'$/, /^'cyborg\.search\.mode'$/, /^`cyborg\.search\.\$\{key\}`$/, /^'cyborg\.extensions\.(tab|view|size)'$/, /^`cyborg\.extensions\.\$\{key\}`$/, /^this\.labelsKey\(/, /^KEY$/];
    const keys: string[] = [];
    for (const file of sources('src/renderer')) {
      const text = code(file);
      if (file.endsWith('prefs.ts')) continue;
      assert.ok(!/\blocalStorage\b|\bsessionStorage\b|indexedDB/.test(text), `${file}: прямое обращение к хранилищу минуя prefs.ts`);
      for (const m of text.matchAll(/writePref\(\s*([^,]+),/g)) keys.push(m[1].trim());
    }
    assert.ok(keys.length >= 6, 'вызовы writePref не найдены');
    assert.deepEqual(keys.filter((key) => !allowed.some((re) => re.test(key))), []);
  });

  it('главный процесс пишет на диск только проекты, их копию, общие промпты и общие кнопки команд, список хабов магазинов, выбор встроенных плагинов, кэш статистики вызовов расширений, настройки хуков, файлы событий сессий и их конфиги MCP Cyborg, список недавних воркспейсов, замок открытого воркспейса, правку Markdown из просмотрщика, глобальный CLAUDE.md Claude Code из его редактора, зашифрованный токен входа Claude удалённых агентов, номера дочерних разговоров, одобрения запуска файлов, состояние паспорта проекта в каталоге .cyborg/passport/ репозитория , отметку главного репозитория и выбор переменных окружения (env-vars.json) с файлом окружения терминала запуска', () => {
    const writers = sources('src/main')
      .filter((file) => /\b(writeFileSync|appendFileSync|writeJsonAtomic|createWriteStream|writeFile)\(/.test(code(file)))
      .map((file) => file.split(path.sep).join('/'))
      .sort();
    assert.deepEqual(writers, ['src/main/builtin-plugins.ts', 'src/main/child-sessions.ts', 'src/main/claude-md.ts', 'src/main/command-store.ts', 'src/main/events-store.ts', 'src/main/extensions-usage.ts', 'src/main/files.ts', 'src/main/hubs.ts', 'src/main/jsonfile.ts', 'src/main/managed-env.ts', 'src/main/passport.ts', 'src/main/projects.ts', 'src/main/prompt-store.ts', 'src/main/remote/claude-token.ts', 'src/main/run-approvals.ts', 'src/main/run-file.ts', 'src/main/sessions.ts', 'src/main/workspaces.ts']);
  });
});

describe('диалоги названы для программ чтения с экрана (FR-10010)', () => {
  it('у каждого <dialog> в index.html есть aria-labelledby на существующий заголовок', () => {
    const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
    const dialogs = [...html.matchAll(/<dialog\b[^>]*>/g)].map((m) => m[0]);
    assert.ok(dialogs.length >= 4, 'диалоги в index.html не найдены');
    for (const tag of dialogs) {
      const labelled = /aria-labelledby="([^"]+)"/.exec(tag)?.[1];
      assert.ok(labelled, `без aria-labelledby: ${tag}`);
      assert.ok(new RegExp(`<h2 id="${labelled}"`).test(html), `заголовка ${labelled} нет`);
    }
  });
});

describe('поиск у удалённой вкладки идёт на хосте (FR-17006)', () => {
  it('окно поиска ищет через порт вкладки, а не напрямую каналами главного процесса', () => {
    const dialog = code('src/renderer/search-dialog.ts');
    assert.doesNotMatch(dialog, /window\.cyborg|\bapi\.(listFiles|searchText|searchChanges)/);
    const app = code('src/renderer/app.ts');
    const setup = /new SearchDialog\(\{[\s\S]*?\n\}\);/.exec(app)?.[0] ?? '';
    assert.match(setup, /fs: \(\) => active\?\.remote\?\.fs \?\? localFs/);
  });
});

describe('уведомления итогов без вкладки', () => {
  it('session:notify хранит и закрывает уведомление по notificationKey, а не по голому id', () => {
    const text = code('src/main/main.ts');
    const handler = /ipcMain\.on\('session:notify',[\s\S]*?\n\}\);/.exec(text)?.[0] ?? '';
    assert.ok(handler, 'обработчик session:notify не найден');
    assert.match(handler, /const key = notificationKey\(id\)/);
    assert.doesNotMatch(handler, /shownNotifications\.(get|set|delete)\(id\b/);
  });
});

describe('окружение дочерних процессов собирается в одном месте', () => {
  it('главный процесс не передаёт process.env запуску и не раскрывает его: окружение даёт child-env.ts, иначе выбор переменных теряется', () => {
    const offenders = sources('src/main').filter((file) => file !== path.join('src/main', 'child-env.ts') && /\.\.\.process\.env|\benv:\s*process\.env\b/.test(code(file)));
    assert.deepEqual(offenders, []);
  });

  it('оболочку -lc выбирает унаследованный SHELL через loginShell: чтений SHELL из собранного окружения в запусках нет', () => {
    // run-terminal.ts принимает env, уже прошедший withLoginShell в run-file.ts.
    const allowed = [path.join('src/main', 'child-env.ts'), path.join('src/main', 'run-terminal.ts')];
    const offenders = sources('src/main').filter((file) => !allowed.includes(file) && /\benv\.SHELL\b/.test(code(file)));
    assert.deepEqual(offenders, []);
  });

  it('каталог настроек Claude для собственных чтений берётся из одного места main.ts: управляемый CLAUDE_CONFIG_DIR им не читается', () => {
    const text = code('src/main/main.ts');
    assert.equal([...text.matchAll(/\bclaudePaths\(/g)].length, 1, 'claudePaths вызывается мимо inheritedClaudePaths');
    for (const reader of ['mirror:', 'memory:', 'new ClaudeMdStore(', 'const extensionsEnv =']) {
      const at = text.indexOf(reader);
      assert.ok(at >= 0, `не найдено: ${reader}`);
      assert.match(text.slice(at, text.indexOf('\n', at)), /inheritedClaudePaths\(\)/, reader);
    }
  });

  it('перезапуск дочерней вкладки несёт открывшую по всему пути: окно -> session:resume -> create', () => {
    assert.match(code('src/renderer/app.ts'), /api\.resumeSession\(owner\.id, repo, addDirs, resume, opener\?\.id\)/);
    assert.match(code('src/renderer/app.ts'), /restartPlan\(reply, findSession\)/);
    assert.match(code('src/renderer/app.ts'), /plan\.resume, undefined, plan\.opener/);
    const handler = /ipcMain\.handle\('session:resume',[\s\S]*?\n\);/.exec(code('src/main/main.ts'))?.[0] ?? '';
    assert.match(handler, /resumeSession\(/);
    assert.match(handler, /\bparent,\s*\)/);
  });

  it('правило имени переменной одно: регулярку имени держит src/shared/env-vars.ts, демон и главный процесс её импортируют', () => {
    const own = path.join('src/shared', 'env-vars.ts');
    const offenders = sources('src').filter((file) => file !== own && /\[A-Za-z_\]\[A-Za-z0-9_\]\{0,127\}/.test(code(file)));
    assert.deepEqual(offenders, []);
  });
});
