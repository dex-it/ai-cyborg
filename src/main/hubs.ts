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
import { mapLimit } from './extensions-read';
import { writeJsonAtomic } from './jsonfile';

const MAX_HUB_NAME = 60;
const FETCH_TIMEOUT_MS = 10_000;
/** Каталог магазина читается целиком, чтобы назвать его и посчитать плагины; у крупных он в несколько МиБ. */
const MAX_MARKETPLACE_BYTES = 4 * 1024 * 1024;
const TOPIC_TIMEOUT_MS = 8_000;
const TOPIC_VERIFY_PARALLEL = 6;
const TOPIC_CACHE_MS = 5 * 60 * 1000;

/** Хаб по теме GitHub: репозитории с темой `claude-code-marketplace` не меньше чем с 20 звёздами, без форков и архивных, по убыванию звёзд. */
export const TOPIC_QUERY = 'topic:claude-code-marketplace fork:false archived:false stars:>=20';
const TOPIC_LIMIT = 30;

export const ANTHROPIC_HUB = 'anthropic';
export const DEX_HUB = 'dex-it';
export const TOPIC_HUB = 'github-topic';

/** Встроенные хабы; первые два - готовые списки, третий читается с GitHub. Отключить можно любой, удалить - нет. */
const BUILTIN_HUBS: Hub[] = [
  { id: ANTHROPIC_HUB, name: 'Anthropic', description: 'Магазины, которые публикует Anthropic: официальный, сообщества и тематические.', url: null, enabled: true, builtin: true },
  { id: DEX_HUB, name: 'dex-it', description: 'Магазин команды dex-it.', url: null, enabled: true, builtin: true },
  {
    id: TOPIC_HUB,
    name: 'GitHub: claude-code-marketplace',
    description: 'Репозитории с темой claude-code-marketplace (от 20 звёзд, по убыванию), у которых есть .claude-plugin/marketplace.json. Anthropic их не проверяет: прочтите описание и состав, прежде чем ставить плагины.',
    url: null,
    enabled: true,
    builtin: true,
  },
];
const BUILTIN_IDS = new Set(BUILTIN_HUBS.map((h) => h.id));

const BUILTIN_ENTRIES: Record<string, HubEntry[]> = {
  [ANTHROPIC_HUB]: [
    { name: 'claude-plugins-official', description: 'Плагины Anthropic, партнёров и других авторов; Claude Code добавляет его сам при первом запуске.', source: 'anthropics/claude-plugins-official', label: 'github anthropics/claude-plugins-official' },
    { name: 'claude-community', description: 'Сторонние плагины, которые их авторы прислали в Anthropic.', source: 'anthropics/claude-plugins-community', label: 'github anthropics/claude-plugins-community' },
    { name: 'anthropic-agent-skills', description: 'Agent Skills от Anthropic: документы, таблицы, презентации и другие.', source: 'anthropics/skills', label: 'github anthropics/skills' },
    { name: 'knowledge-work-plugins', description: 'Плагины для работы со знаниями, в основном для Claude Cowork.', source: 'anthropics/knowledge-work-plugins', label: 'github anthropics/knowledge-work-plugins' },
  ],
  [DEX_HUB]: [{ name: 'dex-claude-marketplace', description: 'Скиллы, агенты и наборы для разработчиков dex-it.', source: 'dex-it/ai-kit', label: 'github dex-it/ai-kit' }],
};

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
    const hubs: Hub[] = [...BUILTIN_HUBS, ...file.custom.map((c) => ({ id: c.id, name: c.name, url: c.url, enabled: true, builtin: false }))];
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
        if (BUILTIN_IDS.has(id)) throw new Error('Встроенный хаб не удаляется, его можно отключить');
        file.custom = file.custom.filter((c) => c.id !== id);
        file.disabled = file.disabled.filter((d) => d !== id);
      } else {
        if (!BUILTIN_IDS.has(id) && !file.custom.some((c) => c.id === id)) throw new Error('Такого хаба нет');
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

type FetchInit = { signal: AbortSignal; redirect: 'follow'; headers?: Record<string, string> };
export type Fetch = (url: string, init: FetchInit) => Promise<Pick<Response, 'ok' | 'status' | 'url' | 'body'>>;

async function readLimited(body: ReadableStream<Uint8Array> | null, limit: number, tooBig: string): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error(tooBig);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

class HttpProblem extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

/** Текст ответа по https: сеть без токенов и cookie, ответ после перенаправлений обязан остаться на https, размер ограничен. */
async function getText(fetchImpl: Fetch, url: string, options: { limit: number; tooBig: string; timeoutMs: number; headers?: Record<string, string> }): Promise<string> {
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(options.timeoutMs), redirect: 'follow', ...(options.headers ? { headers: options.headers } : {}) });
  } catch (error) {
    const name = (error as Error).name;
    if (name === 'TimeoutError' || name === 'AbortError') throw new HttpProblem(`Не ответил за ${Math.round(options.timeoutMs / 1000)} с`);
    throw new HttpProblem(`Не получен: ${(error as Error).message}`);
  }
  if (!response.url.startsWith('https://')) throw new HttpProblem('Перенаправил не на https');
  if (!response.ok) throw new HttpProblem(`Ответил ${response.status}`, response.status);
  return readLimited(response.body, options.limit, options.tooBig);
}

const hubProblem = (error: unknown): string => `Хаб: ${(error as Error).message}`;

/** Звёзды и число плагинов - числа из ответа GitHub и файла магазина; другое не принимается. */
const count = (value: unknown): number | undefined => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined);

/** Каталог репозитория: настоящий магазин называет себя и перечисляет плагины; иное - null. */
export function parseCatalog(text: string): { name: string; plugins: number } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(raw) || typeof raw.name !== 'string' || !Array.isArray(raw.plugins)) return null;
  const name = raw.name.trim();
  if (!name || name.length > 100 || CONTROL.test(name)) return null;
  return { name, plugins: raw.plugins.length };
}

/**
 * Хаб по теме GitHub: поиск репозиториев и проверка каждого - есть ли у него `.claude-plugin/marketplace.json`, как он в нём назван и сколько
 * плагинов. Тема - заявление автора, а не проверка: репозитории без каталога отбрасываются и считаются.
 */
export async function fetchTopicHub(fetchImpl: Fetch): Promise<HubContent> {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(TOPIC_QUERY)}&sort=stars&order=desc&per_page=${TOPIC_LIMIT}`;
  let found: unknown;
  try {
    found = JSON.parse(
      await getText(fetchImpl, url, {
        limit: MAX_HUB_BYTES,
        tooBig: 'Ответ GitHub больше 1 МиБ',
        timeoutMs: FETCH_TIMEOUT_MS,
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Cyborg' },
      }),
    );
  } catch (error) {
    if (error instanceof HttpProblem && (error.status === 403 || error.status === 429)) return { entries: [], error: 'GitHub ограничил число запросов без входа: повторите через минуту' };
    if (error instanceof SyntaxError) return { entries: [], error: 'Ответ GitHub не разобран' };
    return { entries: [], error: `GitHub: ${(error as Error).message}` };
  }
  const items = isObject(found) && Array.isArray(found.items) ? found.items : [];
  const candidates = items
    .filter((item): item is Record<string, unknown> => isObject(item) && typeof item.full_name === 'string' && /^[\w.-]+\/[\w.-]+$/.test(item.full_name) && marketplaceSourceProblem(item.full_name) === null)
    .slice(0, TOPIC_LIMIT);
  const checked = await mapLimit(candidates, TOPIC_VERIFY_PARALLEL, async (item): Promise<HubEntry | null> => {
    const repo = item.full_name as string;
    try {
      const text = await getText(fetchImpl, `https://raw.githubusercontent.com/${repo}/HEAD/.claude-plugin/marketplace.json`, {
        limit: MAX_MARKETPLACE_BYTES,
        tooBig: 'Каталог больше 4 МиБ',
        timeoutMs: TOPIC_TIMEOUT_MS,
      });
      const catalog = parseCatalog(text);
      if (!catalog) return null;
      const about = typeof item.description === 'string' ? item.description.replace(new RegExp(CONTROL.source, 'g'), ' ').trim().slice(0, MAX_DESCRIPTION_LENGTH) : '';
      return { name: catalog.name, description: about, source: repo, label: `github ${repo}`, plugins: catalog.plugins, ...(count(item.stargazers_count) !== undefined ? { stars: count(item.stargazers_count) } : {}) };
    } catch {
      return null;
    }
  });
  const entries = checked.filter((entry): entry is HubEntry => entry !== null);
  const skipped = Math.min(items.length, TOPIC_LIMIT) - entries.length;
  return { entries, ...(skipped ? { skipped } : {}) };
}

const topicCache = { at: 0, content: null as HubContent | null };

/** Содержимое хаба: встроенный список, поиск на GitHub (на 5 минут в памяти, чтобы не упереться в лимит запросов без входа) либо файл по https. */
export async function fetchHub(hub: Hub, fetchImpl: Fetch = fetch as unknown as Fetch, force = false, now = Date.now()): Promise<HubContent> {
  const fixed = BUILTIN_ENTRIES[hub.id];
  if (fixed && hub.builtin) return { entries: fixed };
  if (hub.builtin && hub.id === TOPIC_HUB) {
    if (!force && topicCache.content && now - topicCache.at < TOPIC_CACHE_MS) return topicCache.content;
    const content = await fetchTopicHub(fetchImpl);
    if (!content.error) {
      topicCache.at = now;
      topicCache.content = content;
    }
    return content;
  }
  if (hub.url === null) return { entries: [] };
  try {
    return parseHub(await getText(fetchImpl, hub.url, { limit: MAX_HUB_BYTES, tooBig: 'Файл хаба больше 1 МиБ', timeoutMs: FETCH_TIMEOUT_MS }));
  } catch (error) {
    return { entries: [], error: hubProblem(error) };
  }
}

/** Для тестов: забыть сохранённый ответ GitHub. */
export function forgetTopicCache(): void {
  topicCache.at = 0;
  topicCache.content = null;
}

export { BUILTIN_ENTRIES };
