import { shQuote } from '../agentd/protocol.ts';
import { SUGGEST_PROMPT } from './suggestions.ts';

// EnterWorktree, а не git worktree add: он меняет cwd сессии, и дерево Cyborg переходит в worktree.
export const ISOLATION_PROMPT =
  'В этих репозиториях параллельно работают другие сессии. Перед первой правкой в репозитории, сменой ветки или коммитом - EnterWorktree, дальше работа только в нём; основной каталог - только чтение. Файлы вне репозиториев (скрэтчпад, временные) worktree не требуют. EnterWorktree изолирует только репозиторий рабочего каталога: перед правкой в репозитории из --add-dir - git worktree add <репозиторий>/.claude/worktrees/<то же имя> -b <та же ветка>, и правки только по этому пути.';

/** Всё, что Cyborg дописывает к системному промту сессии: изоляция и кнопки от модели. */
export const SESSION_PROMPT = `${ISOLATION_PROMPT}\n\n${SUGGEST_PROMPT}`;

/** Имя скилла, каким его видит сессия: плагин `plugin/` и каталог скилла в нём. */
export const PARALLEL_SKILL = 'cyborg:parallel-sessions';

/** Только повод: порядок работы лежит в скилле, а его описание в длинном списке скиллов сессии обрезается. */
export const PARALLEL_PROMPT = `Cyborg ведёт работу в параллельных сессиях - локальных и удалённых, на серверах по SSH. Задачу, которая распадается на независимые части, можно делегировать другим сессиям Cyborg: в первый раз спроси человека и запомни его решение; как делегировать, вести задачу совместно, распределять нагрузку и закрывать отработавших - скилл ${PARALLEL_SKILL}.`;

/** Системный промт сессии с MCP и плагином Cyborg: без них ни инструментов сессий, ни скилла у неё нет. Кнопки от модели остаются последними. */
export const MCP_SESSION_PROMPT = `${ISOLATION_PROMPT}\n\n${PARALLEL_PROMPT}\n\n${SUGGEST_PROMPT}`;

/** Удалённая сессия работает в своих клонах: изоляции нет, зато итог сдаётся веткой, PR и вызовом report_done. */
export const REMOTE_SYSTEM_PROMPT = `${SUGGEST_PROMPT}\n\nТы работаешь на сервере разработчика в собственных клонах репозиториев. Закончив, запушь ветку и открой PR, затем вызови инструмент report_done: status (ok, failed или blocked), summary - итог одним сообщением, branch и pr, если есть. После итога сессия остаётся открытой: новое сообщение - новый круг работы со своим report_done. Незапушенная работа при уборке клона не удаляется.`;

/** Промпт удалённой сессии с остальными репозиториями проекта: на старте склонирован только рабочий, остальные агент клонирует по надобности. */
export function remoteSystemPrompt(others: { name: string; path: string; url?: string }[]): string {
  const known = others.filter((o): o is { name: string; path: string; url: string } => !!o.url);
  if (!known.length) return REMOTE_SYSTEM_PROMPT;
  const list = known.map((o) => `${o.name}: git clone -- ${shQuote(o.url)} ${shQuote(o.path)}`).join('\n');
  return `${REMOTE_SYSTEM_PROMPT}\n\nСклонирован только рабочий репозиторий. Остальные репозитории проекта клонируй, только когда они понадобятся, командой из списка; каталог уже есть - клон готов. Скиллы и настройки .claude/ склонированного репозитория подключатся со следующего запуска сессии:\n${list}`;
}

/**
 * Позиционные аргументы claude после --settings. Промпт стоит до --add-dir: тот вариадический
 * (`--add-dir <directories...>`) и забрал бы промпт, стоящий после каталогов.
 */
export function claudeArgs(addDirs: string[], prompt?: string, resume?: string, systemPrompt: string = SESSION_PROMPT): string[] {
  return [
    ...(resume ? ['--resume', resume] : []),
    '--append-system-prompt',
    systemPrompt,
    ...(prompt ? [prompt] : []),
    ...(addDirs.length ? ['--add-dir', ...addDirs] : []),
  ];
}
