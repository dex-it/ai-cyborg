// Модель управляемого окружения: общая для главного процесса и интерфейса, без обращений к node.

export type Candidate = { id: string; kind: 'literal'; value: string } | { id: string; kind: 'expr'; command: string };

export type Choice = { kind: 'untouched' } | { kind: 'selected'; candidate: string } | { kind: 'unset' };

export interface EnvVarDef {
  name: string;
  candidates: Candidate[];
  choice: Choice;
}

export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const MAX_VARS = 128;
export const MAX_CANDIDATES = 32;
/** Предел текста литерала и команды, он же предел stdout выражения. */
export const MAX_TEXT_BYTES = 64 * 1024;
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const ID_RE = /^[0-9a-f]{8}$/;

export type VarStatus = { kind: 'idle' } | { kind: 'evaluating' } | { kind: 'failed'; reason: string; stderr: string };

export interface EnvVarView {
  name: string;
  candidates: Candidate[];
  choice: Choice;
  status: VarStatus;
  /** Выбрана, но значения нет: вычисление не удалось, процессы получают унаследованное. */
  unapplied: boolean;
  /** Места, где значение не действует: Cyborg ставит или снимает переменную сам. */
  notes: string[];
}

export interface EnvView {
  vars: EnvVarView[];
  /** Пропущенные при чтении файла записи и копия повреждённого файла. */
  problems: string[];
  /** Идёт вычисление выражений при старте. */
  starting: boolean;
}

const encoder = new TextEncoder();
export const byteLength = (text: string): number => encoder.encode(text).length;

export function isValidName(name: unknown): name is string {
  return typeof name === 'string' && ENV_NAME.test(name);
}

export type NameCheck = (name: string) => string | null;

function readCandidate(raw: unknown): Candidate | string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'кандидат не объект';
  const c = raw as Record<string, unknown>;
  if (typeof c.id !== 'string' || !ID_RE.test(c.id)) return 'у кандидата нет номера';
  if (c.kind === 'literal') {
    if (typeof c.value !== 'string') return 'значение литерала не строка';
    if (c.value.includes('\0')) return 'литерал содержит NUL';
    if (byteLength(c.value) > MAX_TEXT_BYTES) return 'литерал длиннее 64 КиБ';
    return { id: c.id, kind: 'literal', value: c.value };
  }
  if (c.kind === 'expr') {
    if (typeof c.command !== 'string' || !c.command.trim()) return 'команда пуста';
    if (c.command.includes('\0')) return 'команда содержит NUL';
    if (byteLength(c.command) > MAX_TEXT_BYTES) return 'команда длиннее 64 КиБ';
    return { id: c.id, kind: 'expr', command: c.command };
  }
  return 'неизвестный вид кандидата';
}

function readChoice(raw: unknown, candidates: Candidate[]): Choice {
  const c = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  if (c.kind === 'unset') return { kind: 'unset' };
  if (c.kind === 'selected' && typeof c.candidate === 'string' && candidates.some((x) => x.id === c.candidate)) return { kind: 'selected', candidate: c.candidate };
  return { kind: 'untouched' };
}

/** Определение переменной из недоверенного ввода: строка с причиной - отказ. */
export function readDef(raw: unknown, reserved: NameCheck): EnvVarDef | string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'запись не объект';
  const r = raw as Record<string, unknown>;
  if (!isValidName(r.name)) return `имя ${JSON.stringify(String(r.name).slice(0, 40))} не годится: буквы, цифры и _, не с цифры, до 128 знаков`;
  const refusal = reserved(r.name);
  if (refusal) return `${r.name}: ${refusal}`;
  const list = Array.isArray(r.candidates) ? r.candidates : [];
  if (list.length > MAX_CANDIDATES) return `${r.name}: кандидатов больше ${MAX_CANDIDATES}`;
  const candidates: Candidate[] = [];
  for (const item of list) {
    const c = readCandidate(item);
    if (typeof c === 'string') return `${r.name}: ${c}`;
    if (candidates.some((x) => x.id === c.id)) return `${r.name}: номер кандидата повторён`;
    candidates.push(c);
  }
  return { name: r.name, candidates, choice: readChoice(r.choice, candidates) };
}

/** Файл определений: годные записи и причины пропуска остальных; повтор имени - вторая запись пропущена. */
export function readDefs(raw: unknown, reserved: NameCheck): { vars: EnvVarDef[]; problems: string[] } {
  const list = typeof raw === 'object' && raw !== null && Array.isArray((raw as { vars?: unknown }).vars) ? ((raw as { vars: unknown[] }).vars) : null;
  if (!list) return { vars: [], problems: ['в файле нет списка vars'] };
  const vars: EnvVarDef[] = [];
  const problems: string[] = [];
  for (const item of list) {
    if (vars.length >= MAX_VARS) {
      problems.push(`переменных больше ${MAX_VARS}: остальные пропущены`);
      break;
    }
    const def = readDef(item, reserved);
    if (typeof def === 'string') problems.push(def);
    else if (vars.some((v) => v.name === def.name)) problems.push(`${def.name}: имя повторено`);
    else vars.push(def);
  }
  return { vars, problems };
}

/** Определения без выбора: так список уходит на сохранение, выбор меняют только действия. */
export function defsOf(view: EnvView): { name: string; candidates: Candidate[] }[] {
  return view.vars.map((v) => ({ name: v.name, candidates: v.candidates }));
}

/** Подпись кандидата в выпадающем списке: литерал - значением, выражение - командой с пометкой; длинное обрезается. */
export function candidateLabel(c: Candidate, max = 60): string {
  const text = (c.kind === 'literal' ? c.value : `команда: ${c.command}`).replace(/\s+/g, ' ').trim() || '(пустое значение)';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Отметка, при которой раскрытое «Показать» значение ещё верно: состояние, выбранный кандидат и его текст (правка выбранного литерала меняет значение сразу). */
export function revealStamp(v: EnvVarView): string {
  const chosen = v.choice.kind === 'selected' ? v.candidates.find((c) => c.id === (v.choice as { candidate: string }).candidate) : undefined;
  return JSON.stringify([v.choice, v.status.kind, v.unapplied, chosen ?? null]);
}

/** Состояние переменной словами для строки окна. */
export function stateLabel(v: EnvVarView): string {
  if (v.status.kind === 'evaluating') return 'вычисляется…';
  if (v.status.kind === 'failed') return `ошибка: ${v.status.reason}`;
  if (v.choice.kind === 'unset') return 'снята: у процессов её нет';
  if (v.choice.kind === 'selected') return v.unapplied ? 'выбрана, значения нет: процессы получают унаследованное' : 'выбрана';
  return 'не тронута: процессы получают унаследованное';
}

/** Подсказка вкладки сессии, запущенной с прежним окружением. */
export function staleTitle(names: readonly string[], noRestart = false): string {
  const tail = noRestart ? 'Перезапуск недоступен: сессию ведёт вызвавшая.' : 'Перезапуск продолжит разговор с новым окружением.';
  return `Окружение сессии устарело: ${names.join(', ')}. ${tail}`;
}

/** Текст индикатора в нижней строке: число выбранных и снятых, ошибки вычисления. */
export function indicatorText(view: EnvView): string {
  if (view.starting) return 'Окружение: вычисляется…';
  const selected = view.vars.filter((v) => v.choice.kind === 'selected').length;
  const unset = view.vars.filter((v) => v.choice.kind === 'unset').length;
  const failed = view.vars.filter((v) => v.unapplied || v.status.kind === 'failed').length;
  const parts = [...(selected ? [`+${selected}`] : []), ...(unset ? [`−${unset}`] : []), ...(failed ? [`ошибка ${failed}`] : [])];
  return parts.length ? `Окружение: ${parts.join(' ')}` : 'Окружение';
}
