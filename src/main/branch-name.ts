const MAX_BRANCH_BYTES = 255;

/** Причина отказа по правилам `git check-ref-format --branch` плюс запрет ведущего «-»; null - имя допустимо. */
export function branchNameProblem(name: unknown): string | null {
  if (typeof name !== 'string' || !name) return 'ветка - непустая строка';
  if (Buffer.byteLength(name) > MAX_BRANCH_BYTES) return `ветка длиннее ${MAX_BRANCH_BYTES} байт`;
  if (name.startsWith('-')) return 'ветка не может начинаться с «-»: git примет её за ключ';
  if (name === '@') return 'ветка не может называться «@»';
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return 'ветка содержит пробел, управляющий символ или один из ~ ^ : ? * [ \\';
  if (name.includes('..')) return 'ветка не может содержать «..»';
  if (name.includes('@{')) return 'ветка не может содержать «@{»';
  if (name.includes('//')) return 'ветка не может содержать «//»';
  if (name.startsWith('/') || name.endsWith('/')) return 'ветка не может начинаться или кончаться на «/»';
  if (name.endsWith('.')) return 'ветка не может кончаться на «.»';
  for (const part of name.split('/')) {
    if (part.startsWith('.')) return 'компонент ветки не может начинаться с «.»';
    if (part.endsWith('.lock')) return 'компонент ветки не может кончаться на «.lock»';
  }
  return null;
}

export function validBranchName(name: unknown): name is string {
  return branchNameProblem(name) === null;
}
