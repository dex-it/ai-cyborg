import { SUGGEST_PROMPT } from './suggestions.ts';

// EnterWorktree, а не git worktree add: он меняет cwd сессии, и дерево Cyborg переходит в worktree.
export const ISOLATION_PROMPT =
  'В этих репозиториях параллельно работают другие сессии. Перед первой правкой в репозитории, сменой ветки или коммитом - EnterWorktree, дальше работа только в нём; основной каталог - только чтение. Файлы вне репозиториев (скрэтчпад, временные) worktree не требуют. EnterWorktree изолирует только репозиторий рабочего каталога: перед правкой в репозитории из --add-dir - git worktree add <репозиторий>/.claude/worktrees/<то же имя> -b <та же ветка>, и правки только по этому пути.';

/** Всё, что Cyborg дописывает к системному промту сессии: изоляция и кнопки от модели. */
export const SESSION_PROMPT = `${ISOLATION_PROMPT}\n\n${SUGGEST_PROMPT}`;

/** Имя скилла, каким его видит сессия: плагин `plugin/` и каталог скилла в нём. */
export const PARALLEL_SKILL = 'cyborg:parallel-sessions';

/** Только повод: порядок работы лежит в скилле, а его описание в длинном списке скиллов сессии обрезается. */
export const PARALLEL_PROMPT = `Cyborg ведёт работу в параллельных сессиях - локальных и удалённых, на серверах по SSH. Если человек дал несколько независимых заданий, предложи разнести их по сессиям Cyborg и запомни его решение; как вести такую работу и распределять нагрузку между сессиями - скилл ${PARALLEL_SKILL}.`;

/** Системный промт сессии с MCP и плагином Cyborg: без них ни инструментов сессий, ни скилла у неё нет. Кнопки от модели остаются последними. */
export const MCP_SESSION_PROMPT = `${ISOLATION_PROMPT}\n\n${PARALLEL_PROMPT}\n\n${SUGGEST_PROMPT}`;

/** Удалённая сессия работает в своих клонах: изоляции нет, зато итог сдаётся веткой, PR и вызовом report_done. */
export const REMOTE_SYSTEM_PROMPT = `${SUGGEST_PROMPT}\n\nТы работаешь на сервере разработчика в собственных клонах репозиториев. Закончив, запушь ветку и открой PR, затем вызови инструмент report_done: status (ok, failed или blocked), summary - итог одним сообщением, branch и pr, если есть. После итога сессия остаётся открытой: новое сообщение - новый круг работы со своим report_done. Незапушенная работа при уборке клона не удаляется.`;

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
