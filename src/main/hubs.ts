/**
 * Хабы: списки магазинов плагинов, в которых ищут магазин и откуда его подключают (FR-14012..FR-14015). Хаб - JSON по
 * https-адресу: `{ "name", "marketplaces": [{ "name", "description", "source": { "source": "github" | "git" | "url", ... } }] }`.
 * Встроенный хаб лежит в коде. Хабы общие для всех воркспейсов (магазины Claude Code принадлежат пользователю), файл в userData.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import {
  MAX_HUBS,
  MAX_HUB_BYTES,
  MAX_HUB_ENTRIES,
  MAX_DESCRIPTION_LENGTH,
  marketplaceSourceProblem,
  type Hub,
  type HubContent,
  type HubEntry,
  type HubOp,
} from '../shared/extensions';
import { CONTROL } from './commands';
import { writeJsonAtomic } from './jsonfile';

const BUILTIN_ID = 'builtin';
const MAX_HUB_NAME = 60;
const FETCH_TIMEOUT_MS = 10_000;

const BUILTIN_HUB: Hub = { id: BUILTIN_ID, name: 'Рекомендуемые', url: null, enabled: true, builtin: true };

const BUILTIN_ENTRIES: HubEntry[] = [
  {
    name: 'claude-plugins-official',
    description: 'Каталог Anthropic: плагины для разработки, интеграции и серверы MCP.',
    source: 'anthropics/claude-plugins-official',
    label: 'github anthropics/claude-plugins-official',
  },
  {
    name: 'dex-claude-marketplace',
    description: 'Маркетплейс dex-it: скиллы, агенты и наборы для разработчиков.',
    source: 'dex-it/ai-kit',
    label: 'github dex-it/ai-kit',
  },
];

interface HubFile {
  custom: { id: string; name: string; url: string }[];
  disabled: string[];
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Адрес файла хаба: https, без логина и пароля; иное - причина отказа. */
export function hubUrlProblem(value: string): string | null {
  if (!value.trim()) return 'Укажите адрес хаба';
  if (value.length > 500 || CONTROL.test(value)) return 'Адрес хаба не принят';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return 'Хаб берётся только по https';
    if (url.username || url.password) return 'В адресе не должно быть логина и пароля';
    return null;
  } catch {
    return 'Адрес хаба не разобран';
  }
}

const idOf = (url: string): string => `h${createHash('sha256').update(url).digest('hex').slice(0, 10)}`;

export class HubStore {
  constructor(private readonly file: string) {}

  private read(): HubFile {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return { custom: [], disabled: [] };
    }
    if (!isObject(raw)) return { custom: [], disabled: [] };
    const custom: HubFile['custom'] = [];
    for (const item of Array.isArray(raw.custom) ? raw.custom : []) {
      if (!isObject(item) || typeof item.name !== 'string' || typeof item.url !== 'string' || hubUrlProblem(item.url)) continue;
      custom.push({ id: idOf(item.url), name: item.name.slice(0, MAX_HUB_NAME), url: item.url });
    }
    const disabled = Array.isArray(raw.disabled) ? raw.disabled.filter((v): v is string => typeof v === 'string') : [];
    return { custom: custom.slice(0, MAX_HUBS), disabled };
  }

  list(): Hub[] {
    const file = this.read();
    const hubs: Hub[] = [BUILTIN_HUB, ...file.custom.map((c) => ({ id: c.id, name: c.name, url: c.url, enabled: true, builtin: false }))];
    return hubs.map((hub) => ({ ...hub, enabled: !file.disabled.includes(hub.id) }));
  }

  /** Изменение списка; негодная операция - исключение с причиной для человека. Возвращает список после изменения. */
  apply(op: unknown): Hub[] {
    if (!isObject(op) || typeof op.op !== 'string') throw new Error('Некорректная операция с хабом');
    const file = this.read();
    if (op.op === 'add') {
      const { name, url } = op as unknown as Extract<HubOp, { op: 'add' }>;
      if (typeof name !== 'string' || typeof url !== 'string') throw new Error('Некорректная операция с хабом');
      const title = name.trim();
      if (!title || title.length > MAX_HUB_NAME || CONTROL.test(title)) throw new Error(`Название хаба: 1-${MAX_HUB_NAME} знаков без управляющих`);
      const problem = hubUrlProblem(url.trim());
      if (problem) throw new Error(problem);
      if (file.custom.length >= MAX_HUBS) throw new Error(`Хабов не больше ${MAX_HUBS}`);
      const clean = url.trim();
      if (file.custom.some((c) => c.url === clean)) throw new Error('Хаб с таким адресом уже есть');
      file.custom.push({ id: idOf(clean), name: title, url: clean });
    } else if (op.op === 'remove' || op.op === 'enable' || op.op === 'disable') {
      const id = op.id;
      if (typeof id !== 'string') throw new Error('Некорректная операция с хабом');
      if (op.op === 'remove') {
        if (id === BUILTIN_ID) throw new Error('Встроенный хаб не удаляется, его можно отключить');
        file.custom = file.custom.filter((c) => c.id !== id);
        file.disabled = file.disabled.filter((d) => d !== id);
      } else {
        if (id !== BUILTIN_ID && !file.custom.some((c) => c.id === id)) throw new Error('Такого хаба нет');
        file.disabled = file.disabled.filter((d) => d !== id);
        if (op.op === 'disable') file.disabled.push(id);
      }
    } else {
      throw new Error('Некорректная операция с хабом');
    }
    writeJsonAtomic(this.file, file);
    return this.list();
  }

  find(id: unknown): Hub | undefined {
    return typeof id === 'string' ? this.list().find((hub) => hub.id === id) : undefined;
  }
}

/** Запись хаба в запись магазина; чужой тип источника и неверный адрес - null. */
function entryOf(value: unknown): HubEntry | null {
  if (!isObject(value) || typeof value.name !== 'string' || !isObject(value.source)) return null;
  const name = value.name.trim();
  if (!name || name.length > 100 || CONTROL.test(name)) return null;
  const source = value.source;
  let target: string | null = null;
  let label = '';
  if (source.source === 'github' && typeof source.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(source.repo)) {
    target = source.repo;
    label = `github ${source.repo}`;
  } else if ((source.source === 'git' || source.source === 'url') && typeof source.url === 'string') {
    const url = source.url.trim();
    if (marketplaceSourceProblem(url) === null && !url.startsWith('/')) {
      target = url;
      label = `${source.source} ${hostOnly(url)}`;
    }
  }
  if (!target) return null;
  const description = typeof value.description === 'string' ? value.description.replace(new RegExp(CONTROL.source, 'g'), ' ').slice(0, MAX_DESCRIPTION_LENGTH) : '';
  return { name, description, source: target, label };
}

/** Адрес для подписи без пути и запроса: в подписи важен хост, а путь бывает длинным. */
function hostOnly(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^[^@]*@/, '').split(':')[0];
  }
}

export function parseHub(text: string): HubContent {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { entries: [], error: 'Файл хаба не разобран: это не JSON' };
  }
  if (!isObject(raw) || !Array.isArray(raw.marketplaces)) return { entries: [], error: 'В файле хаба нет списка marketplaces' };
  const entries: HubEntry[] = [];
  let skipped = 0;
  for (const item of raw.marketplaces.slice(0, MAX_HUB_ENTRIES)) {
    const entry = entryOf(item);
    if (entry) entries.push(entry);
    else skipped++;
  }
  skipped += Math.max(0, raw.marketplaces.length - MAX_HUB_ENTRIES);
  return { entries, ...(skipped ? { skipped } : {}) };
}

type Fetch = (url: string, init: { signal: AbortSignal; redirect: 'follow' }) => Promise<Pick<Response, 'ok' | 'status' | 'url' | 'body'>>;

async function readLimited(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_HUB_BYTES) {
      await reader.cancel();
      throw new Error('Файл хаба больше 1 МиБ');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Содержимое хаба. Сеть без токенов и cookie: запрос анонимный, ответ после перенаправлений обязан остаться на https. */
export async function fetchHub(hub: Hub, fetchImpl: Fetch = fetch as unknown as Fetch): Promise<HubContent> {
  if (hub.builtin || hub.url === null) return { entries: BUILTIN_ENTRIES };
  try {
    const response = await fetchImpl(hub.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
    if (!response.url.startsWith('https://')) return { entries: [], error: 'Хаб перенаправил не на https' };
    if (!response.ok) return { entries: [], error: `Хаб ответил ${response.status}` };
    return parseHub(await readLimited(response.body));
  } catch (error) {
    const name = (error as Error).name;
    return { entries: [], error: name === 'TimeoutError' || name === 'AbortError' ? 'Хаб не ответил за 10 с' : `Хаб не получен: ${(error as Error).message}` };
  }
}

export { BUILTIN_ENTRIES };
