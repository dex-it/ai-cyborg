import { SUGGEST_PROMPT } from './suggestions.ts';

// EnterWorktree, а не git worktree add: он меняет cwd сессии, и дерево Cyborg переходит в worktree.
export const ISOLATION_PROMPT =
  'В этих репозиториях параллельно работают другие сессии. Перед первой правкой, сменой ветки или коммитом - EnterWorktree, дальше работа только в нём. Основной каталог - только чтение.';

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
