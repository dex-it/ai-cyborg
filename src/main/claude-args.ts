import { SUGGEST_PROMPT } from './suggestions.ts';

// EnterWorktree, а не git worktree add: он меняет cwd сессии, и дерево Cyborg переходит в worktree.
export const ISOLATION_PROMPT =
  'В этих репозиториях параллельно работают другие сессии. Перед первой правкой в репозитории, сменой ветки или коммитом - EnterWorktree, дальше работа только в нём; основной каталог - только чтение. Файлы вне репозиториев (скрэтчпад, временные) worktree не требуют. EnterWorktree изолирует только репозиторий рабочего каталога: перед правкой в репозитории из --add-dir - git worktree add <репозиторий>/.claude/worktrees/<то же имя> -b <та же ветка>, и правки только по этому пути.';

/** Всё, что Cyborg дописывает к системному промту сессии: изоляция и кнопки от модели. */
export const SESSION_PROMPT = `${ISOLATION_PROMPT}\n\n${SUGGEST_PROMPT}`;

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
