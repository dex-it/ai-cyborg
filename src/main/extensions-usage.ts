import fs from 'node:fs';
import path from 'node:path';
import type { UsageCount, UsageReply } from '../shared/extensions';
import { mapLimit } from './extensions-read';
import { writeJsonAtomic } from './jsonfile';

/** Ключ вызова и его время, мс. */
export interface Call {
  key: string;
  at: number;
}

const TOOL_USE = Buffer.from('"tool_use"');
const COMMAND = Buffer.from('<command-name>');
// Снимок запроса к API - мегабайты переписки: префикс отсекает его до JSON.parse.
const REQUEST_SNAPSHOT = Buffer.from('{"type":"api-request');
const COMMAND_NAME = /<command-name>\/([^<\s]+)<\/command-name>/g;
const CACHE_VERSION = 1;
const READ_PARALLEL = 8;
const CHUNK = 1024 * 1024;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function toolCall(block: Record<string, unknown>): string | null {
  const name = block.name;
  const input = isObject(block.input) ? block.input : {};
  if (name === 'Skill' && typeof input.skill === 'string') return `/${input.skill.replace(/^\//, '')}`;
  if ((name === 'Agent' || name === 'Task') && typeof input.subagent_type === 'string') return `agent:${input.subagent_type}`;
  if (typeof name === 'string' && name.startsWith('mcp__')) {
    const end = name.lastIndexOf('__');
    return end > 5 ? `mcp:${name.slice(5, end)}` : null;
  }
  return null;
}

/** Вызовы в строке журнала: инструменты Skill, Agent и MCP в ответе модели, набранная человеком команда. */
export function callsOfLine(line: string): Call[] {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isObject(entry) || !isObject(entry.message)) return [];
  const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) || 0 : 0;
  const content = entry.message.content;
  const out: Call[] = [];
  if (entry.type === 'assistant' && Array.isArray(content)) {
    for (const block of content) {
      if (!isObject(block) || block.type !== 'tool_use') continue;
      const key = toolCall(block);
      if (key) out.push({ key, at });
    }
  } else if (entry.type === 'user') {
    const texts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter(isObject).map((b) => (typeof b.text === 'string' ? b.text : '')) : [];
    for (const text of texts) for (const m of text.matchAll(COMMAND_NAME)) out.push({ key: `/${m[1]}`, at });
  }
  return out;
}

type Counts = Record<string, [count: number, last: number]>;

function add(counts: Counts, calls: Call[]): void {
  for (const { key, at } of calls) {
    const prev = counts[key];
    if (prev) {
      prev[0]++;
      if (at > prev[1]) prev[1] = at;
    } else counts[key] = [1, at];
  }
}

/** Читает строки с байта from до последнего перевода строки до to и возвращает, докуда дочитано. */
async function readLines(file: string, from: number, to: number, counts: Counts): Promise<number> {
  const handle = await fs.promises.open(file, 'r');
  try {
    let position = from;
    let consumed = from;
    let rest = Buffer.alloc(0);
    while (position < to) {
      const size = Math.min(CHUNK, to - position);
      const chunk = Buffer.alloc(size);
      const { bytesRead } = await handle.read(chunk, 0, size, position);
      if (!bytesRead) break;
      position += bytesRead;
      const data = rest.length ? Buffer.concat([rest, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      let start = 0;
      for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, start)) {
        const line = data.subarray(start, end);
        if ((line.includes(TOOL_USE) || line.includes(COMMAND)) && !line.subarray(0, REQUEST_SNAPSHOT.length).equals(REQUEST_SNAPSHOT)) {
          add(counts, callsOfLine(line.toString('utf8')));
        }
        consumed += end + 1 - start;
        start = end + 1;
      }
      rest = Buffer.from(data.subarray(start));
    }
    return consumed;
  } finally {
    await handle.close();
  }
}

async function journals(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string): Promise<void> => {
    const entries = await fs.promises.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
    }
  };
  await walk(dir);
  return out;
}

interface FileState {
  size: number;
  mtimeMs: number;
  offset: number;
  counts: Counts;
}

interface CacheFile {
  version: number;
  files: Record<string, FileState>;
}

/** Счётчики по журналам сессий (и субагентов) Claude Code; кэш в userData, потому что первый проход по гигабайтам журналов идёт десятки секунд. */
export class UsageStore {
  private cache: CacheFile | null = null;
  private running: Promise<UsageReply> | null = null;

  constructor(
    private readonly projectsDir: string,
    private readonly cacheFile: string,
  ) {}

  read(): Promise<UsageReply> {
    this.running ??= this.scan().finally(() => (this.running = null));
    return this.running;
  }

  private load(): CacheFile {
    if (this.cache) return this.cache;
    try {
      const raw = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8')) as CacheFile;
      if (raw.version === CACHE_VERSION && isObject(raw.files)) return (this.cache = raw);
    } catch {
      // Нет кэша или он повреждён: журналы читаются заново.
    }
    return (this.cache = { version: CACHE_VERSION, files: {} });
  }

  private async scan(): Promise<UsageReply> {
    const cache = this.load();
    const files = await journals(this.projectsDir);
    const next: Record<string, FileState> = {};
    let changed = files.length !== Object.keys(cache.files).length;
    let error: string | undefined;
    await mapLimit(files, READ_PARALLEL, async (file) => {
      try {
        const stat = await fs.promises.stat(file);
        const prev = cache.files[file];
        if (prev && prev.size === stat.size && prev.mtimeMs === stat.mtimeMs) {
          next[file] = prev;
          return;
        }
        // Журнал дописывается в конец; короче прочитанного - переписан и читается заново.
        const resume = prev && stat.size >= prev.offset;
        const counts: Counts = resume ? structuredClone(prev.counts) : {};
        const offset = await readLines(file, resume ? prev.offset : 0, stat.size, counts);
        next[file] = { size: stat.size, mtimeMs: stat.mtimeMs, offset, counts };
        changed = true;
      } catch (e) {
        error ??= `Журнал ${path.basename(file)} не прочитан: ${e instanceof Error ? e.message : String(e)}`;
      }
    });
    cache.files = next;
    if (changed) {
      try {
        writeJsonAtomic(this.cacheFile, cache);
      } catch {
        // Без кэша счёт верен, следующий запуск лишь прочитает журналы заново.
      }
    }
    return { calls: total(Object.values(next)), files: files.length, ...(error ? { error } : {}) };
  }
}

function total(states: FileState[]): Record<string, UsageCount> {
  const out: Record<string, UsageCount> = {};
  for (const state of states) {
    for (const [key, [count, last]] of Object.entries(state.counts)) {
      const prev = out[key];
      if (prev) {
        prev.count += count;
        if (last > prev.last) prev.last = last;
      } else out[key] = { count, last };
    }
  }
  return out;
}
