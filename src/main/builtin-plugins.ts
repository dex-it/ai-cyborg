import fs from 'node:fs';
import path from 'node:path';
import type { BuiltinPlugin, BuiltinHook } from '../shared/extensions.ts';
import { readComponents } from './extensions-read.ts';
import { writeJsonAtomic } from './jsonfile.ts';

/** Ядро: скилл параллельных сессий; инструкция MCP_SESSION_PROMPT ссылается на него и без него сессии не даётся. */
export const CORE_PLUGIN = 'cyborg';

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SCRIPT = /[\w.-]+\.(?:sh|js|mjs|cjs|ts|py)\b/g;

function readJsonSync(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Хуки и моды из hooks/hooks.json: событие со скриптами классического хука, файл модуля мода. */
export function hooksOf(config: unknown): BuiltinHook[] {
  if (!isObject(config)) return [];
  const out: BuiltinHook[] = [];
  for (const [event, groups] of Object.entries(isObject(config.hooks) ? config.hooks : {})) {
    const scripts = new Set<string>();
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const hook of isObject(group) && Array.isArray(group.hooks) ? group.hooks : []) {
        if (isObject(hook) && typeof hook.command === 'string') for (const m of hook.command.match(SCRIPT) ?? []) scripts.add(path.basename(m));
      }
    }
    out.push({ kind: 'hook', name: scripts.size ? `${event} · ${[...scripts].join(', ')}` : event });
  }
  for (const mod of Array.isArray(config.modules) ? config.modules : []) if (typeof mod === 'string') out.push({ kind: 'mod', name: path.basename(mod) });
  return out;
}

/** Выключенные человеком плагины записаны в userData; включённые сессия получает ключами --plugin-dir, настройки Claude Code не трогаются. */
export class BuiltinPlugins {
  private readonly root: string;
  private readonly file: string;

  constructor(root: string, file: string) {
    this.root = root;
    this.file = file;
  }

  /** Имена плагинов: ядро первым, остальные по алфавиту. */
  names(): string[] {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.root);
    } catch {
      return [];
    }
    const found = entries.filter((n) => NAME.test(n) && fs.existsSync(path.join(this.root, n, '.claude-plugin', 'plugin.json'))).sort();
    return [...found.filter((n) => n === CORE_PLUGIN), ...found.filter((n) => n !== CORE_PLUGIN)];
  }

  private disabled(): string[] {
    const raw = readJsonSync(this.file);
    return isObject(raw) && Array.isArray(raw.disabled) ? raw.disabled.filter((v): v is string => typeof v === 'string') : [];
  }

  /** Каталоги включённых плагинов для --plugin-dir; core - ядро включено. */
  forSession(): { dirs: string[]; core: boolean } {
    const off = this.disabled();
    const on = this.names().filter((n) => !off.includes(n));
    return { dirs: on.map((n) => path.join(this.root, n)), core: on.includes(CORE_PLUGIN) };
  }

  async list(): Promise<BuiltinPlugin[]> {
    const off = this.disabled();
    return Promise.all(
      this.names().map(async (name) => {
        const dir = path.join(this.root, name);
        const manifest = readJsonSync(path.join(dir, '.claude-plugin', 'plugin.json'));
        const m = isObject(manifest) ? manifest : {};
        return {
          name,
          description: typeof m.description === 'string' ? m.description : '',
          ...(typeof m.version === 'string' ? { version: m.version } : {}),
          enabled: !off.includes(name),
          core: name === CORE_PLUGIN,
          components: await readComponents(dir),
          hooks: hooksOf(readJsonSync(path.join(dir, 'hooks', 'hooks.json'))),
        };
      }),
    );
  }

  /** Включение или выключение для новых сессий; неизвестное имя - исключение с причиной для человека. */
  async set(name: unknown, enabled: unknown): Promise<BuiltinPlugin[]> {
    if (typeof name !== 'string' || typeof enabled !== 'boolean' || !this.names().includes(name)) throw new Error('Такого встроенного плагина нет');
    const off = this.disabled().filter((n) => n !== name);
    if (!enabled) off.push(name);
    writeJsonAtomic(this.file, { disabled: off });
    return this.list();
  }
}
