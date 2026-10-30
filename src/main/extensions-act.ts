/**
 * Действия окна «Расширения»: установка и удаление плагина, подключение и отключение магазина (FR-14009..FR-14011).
 * Ничего не пишется в файлы Claude Code напрямую: действие - вызов `claude plugin ...`, он сам решает, куда писать.
 * Подтверждение чужой команды установки (`--accept-command`, `-y`) не передаётся: такая установка отказывает и просит терминал.
 */

import {
  ACTION_SCOPES,
  MARKETPLACE_NAME,
  PLUGIN_ID,
  marketplaceSourceProblem,
  type ActionReply,
  type ActionScope,
  type ExtensionsAction,
} from '../shared/extensions';
import type { ClaudeRunner } from './extensions';

const ACTION_TIMEOUT_MS = 180_000;
const MAX_MESSAGE = 600;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Форма действия из интерфейса; путь `dir` проверяет вызывающий. Иное - null. */
export function validateAction(value: unknown): ExtensionsAction | null {
  if (!isObject(value) || typeof value.kind !== 'string') return null;
  if (value.kind === 'marketplace-remove') {
    return typeof value.name === 'string' && MARKETPLACE_NAME.test(value.name) ? { kind: 'marketplace-remove', name: value.name } : null;
  }
  const scope = value.scope;
  if (typeof scope !== 'string' || !(ACTION_SCOPES as readonly string[]).includes(scope)) return null;
  const typedScope = scope as ActionScope;
  let dir: string | undefined;
  if (typedScope !== 'user') {
    if (typeof value.dir !== 'string') return null;
    dir = value.dir;
  } else if (value.dir !== undefined) {
    return null;
  }
  if (value.kind === 'install' || value.kind === 'uninstall') {
    if (typeof value.plugin !== 'string' || !PLUGIN_ID.test(value.plugin)) return null;
    return { kind: value.kind, plugin: value.plugin, scope: typedScope, ...(dir ? { dir } : {}) };
  }
  if (value.kind === 'marketplace-add') {
    if (typeof value.source !== 'string' || marketplaceSourceProblem(value.source) !== null) return null;
    return { kind: 'marketplace-add', source: value.source.trim(), scope: typedScope, ...(dir ? { dir } : {}) };
  }
  return null;
}

/** Аргументы `claude` для действия. Значения пришли из validateAction и идут отдельными аргументами, не строкой шелла. */
export function actionArgs(action: ExtensionsAction): string[] {
  switch (action.kind) {
    case 'install':
      return ['plugin', 'install', action.plugin, '--scope', action.scope, '--json'];
    case 'uninstall':
      return ['plugin', 'uninstall', action.plugin, '--scope', action.scope, '--json'];
    case 'marketplace-add':
      return ['plugin', 'marketplace', 'add', action.source, '--scope', action.scope, '--json'];
    case 'marketplace-remove':
      return ['plugin', 'marketplace', 'remove', action.name];
  }
}

/** Ответ claude одной строкой-тремя: из итогового JSON (`message`), иначе из текста вывода без значков. */
export function actionMessage(stdout: string, stderr: string): { ok: boolean | null; message: string } {
  const lines = stdout.trim().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(lines[i]);
      if (isObject(parsed) && typeof parsed.message === 'string') {
        return { ok: parsed.outcome === 'ok' ? true : parsed.outcome === 'failed' ? false : null, message: parsed.message.slice(0, MAX_MESSAGE) };
      }
    } catch {
      // не итоговая строка
    }
  }
  const text = (stdout.trim() || stderr.trim())
    .split(/\r?\n/)
    .map((l) => l.replace(/^[✔✘!⏸]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 3)
    .join('. ');
  return { ok: null, message: text.slice(0, MAX_MESSAGE) };
}

/** Исполнитель действий: одно за раз, чтобы две установки не писали настройки Claude Code одновременно. */
export function createActionRunner(run: ClaudeRunner, neutralDir: string): (action: ExtensionsAction) => Promise<ActionReply> {
  let busy = false;
  return async (action) => {
    if (busy) return { ok: false, message: 'Другое действие ещё выполняется' };
    busy = true;
    try {
      const cwd = 'dir' in action && action.dir ? action.dir : neutralDir;
      const result = await run(actionArgs(action), cwd, ACTION_TIMEOUT_MS);
      if (result.missing) return { ok: false, message: 'claude не найден в PATH' };
      if (result.timedOut) return { ok: false, message: 'Claude Code не закончил за 3 минуты' };
      const parsed = actionMessage(result.stdout, result.stderr);
      const ok = parsed.ok ?? result.code === 0;
      return { ok: ok && result.code === 0, message: parsed.message || (ok ? 'Готово' : `claude завершился с кодом ${result.code}`) };
    } finally {
      busy = false;
    }
  };
}
