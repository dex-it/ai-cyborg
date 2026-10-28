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
    const allowed = [/^'cyborg\.fontSize'$/, /^NOTIFICATIONS_KEY$/, /^'cyborg\.tasks\.(assigned|sort)'$/, /^'cyborg\.mrs\.(filter|sort)'$/, /^this\.labelsKey\(/, /^KEY$/];
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

  it('главный процесс пишет на диск только проекты, их копию, общие промпты кнопок, настройки хуков, файлы событий сессий, список недавних воркспейсов и замок открытого воркспейса', () => {
    const writers = sources('src/main')
      .filter((file) => /\b(writeFileSync|appendFileSync|writeJsonAtomic|createWriteStream|writeFile)\(/.test(code(file)))
      .map((file) => file.split(path.sep).join('/'))
      .sort();
    assert.deepEqual(writers, ['src/main/jsonfile.ts', 'src/main/projects.ts', 'src/main/prompt-store.ts', 'src/main/sessions.ts', 'src/main/workspaces.ts']);
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
