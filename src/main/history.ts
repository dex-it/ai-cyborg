import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Прошлая сессия Claude Code в репозитории проекта: по `id` её продолжает `claude --resume`. */
export interface HistoryEntry {
  id: string;
  repo: string;
  title: string;
  /** Время последней записи журнала, мс. */
  updated: number;
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Журнал длинной сессии - мегабайты: заголовок и первый запрос ищутся только у краёв файла.
const EDGE_BYTES = 64 * 1024;
const LIMIT = 50;
const TITLE_MAX = 120;

export const claudeProjectsDir = (): string => path.join(os.homedir(), '.claude', 'projects');

export const projectDirName = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-');

// Сессия, ушедшая в worktree (`EnterWorktree`: <repo>/.claude/worktrees/<имя>), пишет журнал в каталог проекта worktree: его имя -
// projectDirName пути worktree, то есть каталог репозитория плюс `--claude-worktrees-<имя>`. Так Cyborg изолирует каждую
// параллельную сессию, и без этих каталогов история не видела бы именно такие сессии. Возобновляет их `claude --resume <id>`
// из каталога репозитория: Claude Code сам находит журнал worktree и возвращает сессию в него.
const WORKTREE_INFIX = '--claude-worktrees-';

/** Каталоги журналов репозитория в `root`: собственный и его worktree. */
function journalDirs(repo: string, root: string): string[] {
  const own = projectDirName(repo);
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  return names.filter((name) => name === own || name.startsWith(own + WORKTREE_INFIX)).map((name) => path.join(root, name));
}

export const isSessionId = (value: unknown): value is string => typeof value === 'string' && SESSION_ID.test(value);

const oneLine = (text: string): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
};

function promptText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const text = content.find((c) => (c as { type?: unknown })?.type === 'text') as { text?: unknown } | undefined;
  return typeof text?.text === 'string' ? text.text : '';
}

export interface JournalFacts {
  /** Сессия запущена человеком в терминале, а не `claude -p` / SDK. */
  interactive: boolean;
  /** Последний custom-title, иначе последний ai-title, иначе первый набранный запрос. */
  title: string;
}

export function journalFacts(head: string, tail: string): JournalFacts {
  let entrypoint: string | undefined;
  let custom = '';
  let ai = '';
  let firstPrompt = '';
  for (const [chunk, isHead] of [
    [head, true],
    [tail, false],
  ] as const) {
    for (const line of chunk.split('\n')) {
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (isHead && entrypoint === undefined && typeof record.entrypoint === 'string') entrypoint = record.entrypoint;
      if (record.type === 'custom-title' && typeof record.customTitle === 'string') custom = record.customTitle;
      if (record.type === 'ai-title' && typeof record.aiTitle === 'string') ai = record.aiTitle;
      if (isHead && !firstPrompt && record.type === 'user' && !record.isMeta) {
        const text = promptText((record.message as { content?: unknown } | undefined)?.content).trim();
        // `<local-command-caveat>` и прочая служебная разметка - не набранный человеком текст.
        if (text && !text.startsWith('<')) firstPrompt = text;
      }
    }
  }
  return { interactive: entrypoint === 'cli', title: oneLine(custom || ai || firstPrompt) };
}

function readEdges(file: string, size: number): [string, string] {
  const fd = fs.openSync(file, 'r');
  try {
    const read = (start: number, length: number): string => {
      const buf = Buffer.alloc(length);
      const n = fs.readSync(fd, buf, 0, length, start);
      return buf.subarray(0, n).toString('utf8');
    };
    return [read(0, Math.min(size, EDGE_BYTES)), size > EDGE_BYTES ? read(size - EDGE_BYTES, EDGE_BYTES) : ''];
  } finally {
    fs.closeSync(fd);
  }
}

/** Интерактивные сессии репозиториев, свежие первыми; журнал без заголовка не показывается. */
export function listHistory(repos: string[], root = claudeProjectsDir(), limit = LIMIT): HistoryEntry[] {
  const candidates: { id: string; repo: string; file: string; size: number; updated: number }[] = [];
  for (const repo of new Set(repos)) {
    for (const dir of journalDirs(repo, root)) {
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const id = name.replace(/\.jsonl$/, '');
        if (id === name || !isSessionId(id)) continue;
        const file = path.join(dir, name);
        try {
          const stat = fs.statSync(file);
          if (stat.isFile() && stat.size > 0) candidates.push({ id, repo, file, size: stat.size, updated: stat.mtimeMs });
        } catch {
          continue;
        }
      }
    }
  }
  candidates.sort((a, b) => b.updated - a.updated);
  const entries: HistoryEntry[] = [];
  for (const c of candidates) {
    if (entries.length >= limit) break;
    let facts: JournalFacts;
    try {
      facts = journalFacts(...readEdges(c.file, c.size));
    } catch {
      continue;
    }
    if (facts.interactive && facts.title) entries.push({ id: c.id, repo: c.repo, title: facts.title, updated: c.updated });
  }
  return entries;
}

/** Каталог, где лежит журнал сессии: репозиторий либо его worktree. */
function journalDirOf(repo: string, id: string, root: string): string | undefined {
  return isSessionId(id) ? journalDirs(repo, root).find((dir) => fs.existsSync(path.join(dir, `${id}.jsonl`))) : undefined;
}

export function historyExists(repo: string, id: string, root = claudeProjectsDir()): boolean {
  return journalDirOf(repo, id, root) !== undefined;
}

/** Журнал сессии и её каталог (вывод инструментов, субагенты) удаляются; продолжить её после этого нельзя. */
export function deleteHistory(repo: string, id: string, root = claudeProjectsDir()): void {
  const dir = journalDirOf(repo, id, root);
  if (!dir) throw new Error('Журнал сессии не найден');
  fs.rmSync(path.join(dir, id), { recursive: true, force: true });
  fs.rmSync(path.join(dir, `${id}.jsonl`));
}
