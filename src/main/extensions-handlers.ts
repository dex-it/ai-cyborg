import { MAX_DIRS, type ActionReply, type ExtensionsAction, type ExtensionsReply, type Hub, type HubContent, type ProbeReply } from '../shared/extensions';
import type { AllowedPaths } from './allowed-paths';
import { validateAction } from './extensions-act';

export interface ExtensionsHandlerDeps {
  allowed: AllowedPaths;
  load: (dirs: string[]) => Promise<ExtensionsReply>;
  probe: (dir: string | null) => Promise<ProbeReply>;
  act: (action: ExtensionsAction) => Promise<ActionReply>;
  hubs: { list: () => Hub[]; apply: (op: unknown) => Hub[]; find: (id: unknown) => Hub | undefined };
  fetchHub: (hub: Hub) => Promise<HubContent>;
}

/** Обработчики каналов extensions:* и hubs:*: форма аргумента и каждый путь проверяются до чтения и до запуска claude. */
export function createExtensionsHandlers(deps: ExtensionsHandlerDeps) {
  return {
    load(request: unknown) {
      const dirs = typeof request === 'object' && request !== null ? (request as { dirs?: unknown }).dirs : undefined;
      if (!Array.isArray(dirs) || dirs.length > MAX_DIRS) throw new Error('Некорректные аргументы');
      const unique = [...new Set(dirs)];
      for (const dir of unique) deps.allowed.assert(dir);
      return deps.load(unique as string[]);
    },
    /** null - из каталога вне проектов: видны настройки пользователя. */
    probe(dir: unknown) {
      if (dir !== null) deps.allowed.assert(dir);
      return deps.probe(dir as string | null);
    },
    act(value: unknown) {
      const action = validateAction(value);
      if (!action) throw new Error('Некорректное действие');
      if ('dir' in action && action.dir) deps.allowed.assert(action.dir);
      return deps.act(action);
    },
    hubList: () => deps.hubs.list(),
    hubApply: (op: unknown) => deps.hubs.apply(op),
    hubFetch(id: unknown) {
      const hub = deps.hubs.find(id);
      if (!hub) throw new Error('Такого хаба нет');
      return deps.fetchHub(hub);
    },
  };
}
