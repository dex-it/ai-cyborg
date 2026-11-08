import fs from 'node:fs/promises';
import path from 'node:path';

export interface DirEntry {
  name: string;
  isDir: boolean;
}

const MAX_VIEW_BYTES = 5 * 1024 * 1024;
// Каталог вне git может оказаться огромным: обход останавливается, а не вешает поиск.
const MAX_WALK_FILES = 50_000;

export async function listDir(dir: string): Promise<DirEntry[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const result: DirEntry[] = [];
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    let isDir = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      isDir = await fs.stat(path.join(dir, entry.name)).then((s) => s.isDirectory(), () => false);
    }
    result.push({ name: entry.name, isDir });
  }
  return result.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
}

/** Файлы под root относительно него - для поиска в каталоге вне git. */
export async function walkFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const queue = [''];
  while (queue.length && files.length < MAX_WALK_FILES) {
    const rel = queue.shift()!;
    const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) queue.push(child);
      else files.push(child);
    }
  }
  return files;
}

export async function readTextFile(file: string): Promise<{ content?: string; error?: string }> {
  try {
    const stat = await fs.stat(file);
    if (stat.size > MAX_VIEW_BYTES) return { error: `Файл больше ${MAX_VIEW_BYTES / 1024 / 1024} МБ` };
    const buffer = await fs.readFile(file);
    if (buffer.subarray(0, 8000).includes(0)) return { error: 'Двоичный файл' };
    return { content: buffer.toString('utf8') };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

export type WriteReply = { saved: true } | { conflict: true } | { error: string };

/** Перезапись существующего файла правкой; файл на диске разошёлся с версией, от которой шла правка, - конфликт, если не force. */
export async function writeTextFile(file: string, content: string, base: string, force: boolean): Promise<WriteReply> {
  if (Buffer.byteLength(content) > MAX_VIEW_BYTES) return { error: `Правка больше ${MAX_VIEW_BYTES / 1024 / 1024} МБ` };
  const current = await readTextFile(file);
  if (current.content === undefined) return { error: current.error ?? 'Файл не прочитан' };
  if (!force && current.content !== base) return { conflict: true };
  try {
    await fs.writeFile(file, content);
    return { saved: true };
  } catch (error) {
    return { error: (error as Error).message };
  }
}
