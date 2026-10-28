import { SUGGEST_PROMPT } from './suggestions.ts';

// EnterWorktree, а не git worktree add: он меняет cwd сессии, и дерево Cyborg переходит в worktree.
export const ISOLATION_PROMPT =
  'В этих репозиториях параллельно работают другие сессии. Перед первой правкой в репозитории, сменой ветки или коммитом - EnterWorktree, дальше работа только в нём; основной каталог - только чтение. Файлы вне репозиториев (скрэтчпад, временные) worktree не требуют. EnterWorktree изолирует только репозиторий рабочего каталога: перед правкой в репозитории из --add-dir - git worktree add <репозиторий>/.claude/worktrees/<то же имя> -b <та же ветка>, и правки только по этому пути.';

/** Всё, что Cyborg дописывает к системному промту сессии: изоляция и кнопки от модели. */
export const SESSION_PROMPT = `${ISOLATION_PROMPT}\n\n${SUGGEST_PROMPT}`;

/**
 * Позиционные аргументы claude после --settings. Промпт стоит до --add-dir: тот вариадический
 * (`--add-dir <directories...>`) и забрал бы промпт, стоящий после каталогов.
 */
export function claudeArgs(addDirs: string[], prompt?: string, resume?: string): string[] {
  return [
    ...(resume ? ['--resume', resume] : []),
    '--append-system-prompt',
    SESSION_PROMPT,
    ...(prompt ? [prompt] : []),
    ...(addDirs.length ? ['--add-dir', ...addDirs] : []),
  ];
}
