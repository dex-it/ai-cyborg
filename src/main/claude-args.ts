/**
 * Позиционные аргументы claude после --settings. Промпт стоит до --add-dir: тот вариадический
 * (`--add-dir <directories...>`) и забрал бы промпт, стоящий после каталогов.
 */
export function claudeArgs(addDirs: string[], prompt?: string): string[] {
  return [...(prompt ? [prompt] : []), ...(addDirs.length ? ['--add-dir', ...addDirs] : [])];
}
