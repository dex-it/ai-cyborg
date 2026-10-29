import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { lineHit, MAX_HITS, patternOf, type LineHit, type MatchRange, type SearchReply, type SearchRequest } from '../shared/search-pattern';
import { filterOverrides, gitRoot, SAFE_CONFIG } from './git';

/** Поиск по содержимому и по изменениям: только читающие команды git (ADR-0005), пределы по времени, объёму и числу результатов. */

const GIT_TIMEOUT_MS = 15_000;
// Вывод больше этого обрывается, а совпадения из прочитанного отдаются: слабый запрос в большом репозитории не должен раздувать память.
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
/** Время на сравнение всех строк диффа с выражением: у RegExp JavaScript своего таймаута нет. */
const MATCH_TIMEOUT_MS = 2_000;
const MAX_DIFF_LINE = 1_000;
const MAX_UNTRACKED_FILES = 300;
const MAX_UNTRACKED_BYTES = 1024 * 1024;

interface GitRun {
  stdout: Buffer;
  stderr: string;
  /** Код выхода git; null - процесс убит (таймаут). */
  code: number | null;
  overflow: boolean;
}

/** Запуск git без исключения на ненулевой код: у `git grep` код 1 - «нет совпадений». Отмена - исключение AbortError. */
function run(cwd: string, args: string[], env: NodeJS.ProcessEnv | undefined, signal: AbortSignal): Promise<GitRun> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...SAFE_CONFIG, '-c', 'core.quotePath=false', '-C', cwd, ...args],
      { maxBuffer: MAX_OUTPUT_BYTES, encoding: 'buffer', env: env ? { ...process.env, ...env } : process.env, signal, timeout: GIT_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (!error) return resolve({ stdout, stderr: '', code: 0, overflow: false });
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
        if (failure.name === 'AbortError' || failure.code === 'ABORT_ERR') return reject(failure);
        if (failure.code === 'ENOENT') return reject(failure);
        resolve({
          stdout: stdout ?? Buffer.alloc(0),
          stderr: (stderr ?? Buffer.alloc(0)).toString('utf8'),
          code: typeof failure.code === 'number' ? failure.code : null,
          overflow: failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        });
      },
    );
  });
}

const empty = (extra: Partial<SearchReply> = {}): SearchReply => ({ hits: [], truncated: false, ...extra });

/** Причина отказа git одной строкой для окна поиска. */
function gitProblem(run: GitRun, regex: boolean): string {
  if (run.code === null) return `Поиск не уложился в ${GIT_TIMEOUT_MS / 1000} с`;
  const text = run.stderr;
  if (/Perl-compatible|USE_LIBPCRE|PCRE/i.test(text) && /not compiled|cannot use|does not support|support/i.test(text)) {
    return 'Регулярные выражения недоступны: этот git собран без PCRE';
  }
  const line = text.split('\n').find((l) => l.trim()) ?? '';
  const reason = line.replace(/^(fatal|error): /, '').replace(/^command line, '[^']*': /, '').trim();
  return regex ? `Выражение не разобрано: ${reason || 'ошибка git'}` : reason || 'git не выполнил поиск';
}

/** `путь\0номер\0текст\n`, как отдаёт `git grep -n --null`; недочитанная последняя строка при обрыве вывода отбрасывается. */
function parseGrep(out: Buffer, overflow: boolean): { rel: string; line: number; text: string }[] {
  const lines = out.toString('utf8').split('\n');
  if (overflow) lines.pop();
  const hits: { rel: string; line: number; text: string }[] = [];
  for (const entry of lines) {
    const first = entry.indexOf('\0');
    const second = first < 0 ? -1 : entry.indexOf('\0', first + 1);
    if (second < 0) continue;
    const line = Number(entry.slice(first + 1, second));
    if (Number.isInteger(line) && line > 0) hits.push({ rel: entry.slice(0, first), line, text: entry.slice(second + 1) });
  }
  return hits;
}

/** Поиск по содержимому файлов корня: отслеживаемые и новые без игнорируемых, вне git - каталог целиком. */
export async function gitGrep(request: SearchRequest, signal: AbortSignal): Promise<SearchReply> {
  const { root, query, options } = request;
  const inGit = (await gitRoot(root)) !== null;
  const args = [
    'grep',
    '-n',
    '-I',
    '--null',
    '--no-color',
    ...(inGit ? ['--untracked'] : ['--no-index', '--exclude-standard']),
    ...(options.caseSensitive ? [] : ['-i']),
    ...(options.wholeWord ? ['-w'] : []),
    options.regex ? '-P' : '-F',
    '-e',
    query,
    '--',
    '.',
  ];
  const result = await run(root, args, undefined, signal);
  if (result.code !== 0 && result.code !== 1 && !result.overflow) return empty({ error: gitProblem(result, options.regex) });
  const found = parseGrep(result.stdout, result.overflow);
  const hits: LineHit[] = [];
  for (const hit of found.slice(0, MAX_HITS)) {
    const raw = hit.text.length > MAX_DIFF_LINE ? hit.text.slice(0, MAX_DIFF_LINE) : hit.text;
    hits.push(lineHit(hit.rel, hit.line, raw, locate(raw, request)));
  }
  return { hits, truncated: found.length > MAX_HITS || result.overflow };
}

/** Граница совпадения для подсветки: git её не отдаёт, находим тем же запросом в самой строке. Не нашлось - подсветки нет. */
function locate(text: string, { query, options }: SearchRequest): MatchRange | null {
  try {
    const pattern = patternOf(query, options);
    if (!pattern) {
      const at = (options.caseSensitive ? text : text.toLocaleLowerCase()).indexOf(options.caseSensitive ? query : query.toLocaleLowerCase());
      return at < 0 ? null : { start: at, end: at + query.length };
    }
    const found = new RegExp(pattern.source, pattern.flags).exec(text);
    return found ? { start: found.index, end: found.index + found[0].length } : null;
  } catch {
    return null;
  }
}

interface DiffLine {
  rel: string;
  line: number;
  sign: '+' | '-';
  text: string;
}

const HUNK = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Строки `+` и `-` диффа без контекста (`-U0`). Номер у `+` - строка рабочего файла, у `-` - место удаления в нём.
 * Заголовок файла отличается от строки удаления тем, что идёт вне ханка: границы ханка заданы счётчиками строк в его заголовке.
 */
export function parseDiff(out: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let rel: string | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  let newLine = 0;
  for (const row of out.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      if (row.startsWith('-') && oldLeft > 0) {
        oldLeft--;
        if (rel) lines.push({ rel, line: Math.max(1, newLine), sign: '-', text: row.slice(1) });
        continue;
      }
      if (row.startsWith('+') && newLeft > 0) {
        newLeft--;
        if (rel) lines.push({ rel, line: newLine, sign: '+', text: row.slice(1) });
        newLine++;
        continue;
      }
      if (row.startsWith('\\')) continue;
    }
    if (row.startsWith('diff --git ')) {
      rel = null;
    } else if (row.startsWith('--- ')) {
      const old = row.slice(4).split('\t')[0];
      if (old !== '/dev/null') rel = old;
    } else if (row.startsWith('+++ ')) {
      const next = row.slice(4).split('\t')[0];
      if (next !== '/dev/null') rel = next;
    } else {
      const hunk = HUNK.exec(row);
      if (hunk) {
        oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
        newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
        newLine = Number(hunk[2]);
      }
    }
  }
  return lines;
}

/** Новый файл без индекса: все его строки считаются добавленными. Двоичные, большие и не обычные файлы пропускаются. */
async function untrackedLines(root: string, signal: AbortSignal): Promise<DiffLine[]> {
  const listing = await run(root, ['ls-files', '-z', '--others', '--exclude-standard'], undefined, signal);
  if (listing.code !== 0) return [];
  const files = listing.stdout.toString('utf8').split('\0').filter(Boolean).slice(0, MAX_UNTRACKED_FILES);
  const lines: DiffLine[] = [];
  for (const rel of files) {
    if (signal.aborted) break;
    const file = path.join(root, rel);
    try {
      const stat = await fs.promises.lstat(file);
      if (!stat.isFile() || stat.size > MAX_UNTRACKED_BYTES) continue;
      const content = await fs.promises.readFile(file);
      if (content.subarray(0, 8000).includes(0)) continue;
      content
        .toString('utf8')
        .split('\n')
        .forEach((text, index, all) => {
          if (index === all.length - 1 && !text) return;
          lines.push({ rel, line: index + 1, sign: '+', text });
        });
    } catch {
      // файл исчез между списком и чтением
    }
  }
  return lines;
}

/** Сравнение строк с запросом. Подстрока ищется `indexOf`; выражение и «целое слово» идут в `vm` с таймаутом: RegExp не прерывается иначе. */
export function matchLines(texts: string[], request: SearchRequest, limit: number): { ranges: (MatchRange | null)[]; error?: string } {
  const { query, options } = request;
  const pattern = patternOf(query, options);
  const ranges: (MatchRange | null)[] = new Array(texts.length).fill(null);
  if (!pattern) {
    const needle = options.caseSensitive ? query : query.toLocaleLowerCase();
    let found = 0;
    for (let i = 0; i < texts.length && found <= limit; i++) {
      const at = (options.caseSensitive ? texts[i] : texts[i].toLocaleLowerCase()).indexOf(needle);
      if (at >= 0) {
        ranges[i] = { start: at, end: at + needle.length };
        found++;
      }
    }
    return { ranges };
  }
  try {
    new RegExp(pattern.source, pattern.flags);
  } catch (error) {
    return { ranges, error: `Выражение не разобрано: ${(error as Error).message.replace(/^Invalid regular expression: /, '')}` };
  }
  const context = vm.createContext({ texts, source: pattern.source, flags: pattern.flags, limit, starts: [] as number[], ends: [] as number[] });
  try {
    vm.runInContext(
      `const re = new RegExp(source, flags);
       let found = 0;
       for (let i = 0; i < texts.length && found <= limit; i++) {
         const m = re.exec(texts[i]);
         starts.push(m ? m.index : -1);
         ends.push(m ? m.index + m[0].length : -1);
         if (m) found++;
       }`,
      context,
      { timeout: MATCH_TIMEOUT_MS },
    );
  } catch {
    return { ranges, error: `Выражение слишком тяжёлое: не уложилось в ${MATCH_TIMEOUT_MS / 1000} с` };
  }
  const { starts, ends } = context as { starts: number[]; ends: number[] };
  starts.forEach((start, i) => {
    if (start >= 0) ranges[i] = { start, end: ends[i] };
  });
  return { ranges };
}

/** Поиск по строкам `+` и `-` изменений рабочего дерева против HEAD (то, что показывает просмотр файла) и новым файлам. */
export async function gitDiffSearch(request: SearchRequest, signal: AbortSignal): Promise<SearchReply> {
  const { root } = request;
  if ((await gitRoot(root)) === null) return empty({ error: 'Не git-репозиторий' });
  // git diff, как и status, гоняет clean-фильтры из конфига репозитория: ключи перекрываются (ADR-0005), внешний diff и textconv выключены.
  const overrides = await filterOverrides(root);
  const diff = await run(
    root,
    ['diff', 'HEAD', '-U0', '--no-ext-diff', '--no-textconv', '--no-color', '--no-prefix', '--no-renames', '--ignore-submodules=all'],
    overrides,
    signal,
  );
  if (diff.code !== 0 && !diff.overflow) {
    return empty({ error: /ambiguous argument|bad revision|unknown revision/.test(diff.stderr) ? 'Нет коммита HEAD для сравнения' : gitProblem(diff, false) });
  }
  const changed = parseDiff(diff.overflow ? diff.stdout.toString('utf8').split('\n').slice(0, -1).join('\n') : diff.stdout.toString('utf8'));
  const lines = [...changed, ...(await untrackedLines(root, signal))];
  const texts = lines.map((l) => (l.text.length > MAX_DIFF_LINE ? l.text.slice(0, MAX_DIFF_LINE) : l.text));
  const { ranges, error } = matchLines(texts, request, MAX_HITS);
  if (error) return empty({ error });
  const hits: LineHit[] = [];
  let total = 0;
  lines.forEach((entry, i) => {
    const range = ranges[i];
    if (!range) return;
    total++;
    if (hits.length < MAX_HITS) hits.push(lineHit(entry.rel, entry.line, texts[i], range, entry.sign));
  });
  return { hits, truncated: total > MAX_HITS || diff.overflow };
}
