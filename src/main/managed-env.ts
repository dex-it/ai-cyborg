import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { isAuthEnvName } from '../agentd/git-auth';
import { isValidName, MAX_FILE_BYTES, MAX_VARS, readDef, readDefs, type Candidate, type EnvVarDef, type EnvView, type NameCheck, type VarStatus } from '../shared/env-vars';
import { composeEnv, type EnvStamp, type Overlay } from './child-env';
import { cleanMessage } from './clean-text';
import { evaluate, type EvalResult } from './env-eval';
import { keepCorruptCopy, writeJsonAtomic } from './jsonfile';
import { HOST_AGNOSTIC_TOKEN_ENV } from './remote/auth';
import { SearchRunner } from './search-run';
import { INHERITED_SESSION_VARS } from './sessions';

const SESSION_OWN = ['TERM', 'COLORTERM'];

/** Имя, которое не дойдёт ни до одного процесса: служебные переменные сессий и CYBORG_*; null - имя принимается. */
export const reservedName: NameCheck = (name) => (INHERITED_SESSION_VARS.includes(name) || name.startsWith('CYBORG_') ? 'служебное имя Cyborg: его снимают у всех процессов' : null);

/** Где значение управляемой переменной не действует, потому что Cyborg ставит или снимает её сам; пусто - действует везде. */
export function ownNotes(name: string): string[] {
  const notes: string[] = [];
  if (SESSION_OWN.includes(name)) notes.push('не действует в сессиях Claude (локальных и на хостах): Cyborg ставит её сам');
  if (name === 'GH_PROMPT_DISABLED') notes.push('не действует в gh, glab и jira: Cyborg ставит её сам');
  if (name === 'NO_COLOR') notes.push('не действует в gh, glab, jira и claude plugin: Cyborg ставит её сам');
  if ((HOST_AGNOSTIC_TOKEN_ENV as readonly string[]).includes(name)) notes.push('не действует при сборе доступов gh и glab для хостов: Cyborg её снимает, чтобы токен не ушёл чужому хосту');
  if (name === 'SSH_ASKPASS_REQUIRE') notes.push('не действует в ssh: Cyborg ставит её сам');
  if (isAuthEnvName(name)) notes.push('не действует в сессиях на хостах, когда Cyborg передал хосту доступ хостинга');
  if (name === 'GIT_TERMINAL_PROMPT' || name === 'GIT_SSH_COMMAND') notes.push('не действует в сессиях на хостах: демон ставит её сам');
  if (name === 'CLAUDE_CONFIG_DIR') notes.push('собственные чтения Cyborg - окно «Расширения», зеркало настройки и память проекта для хостов, редактор глобального CLAUDE.md - берут каталог из окружения, унаследованного при запуске Cyborg');
  if (name === 'PATH') notes.push('при вычислении выражений берётся PATH логин-оболочки');
  if (name === 'CLAUDE_CODE_OAUTH_TOKEN') notes.push('на хостах заменяет токен из окна «Хосты», вкладка «Вход Claude»; снятая - агент токена не получает');
  return notes;
}

export const OWN_NAMES_LOCAL = (name: string): boolean => SESSION_OWN.includes(name) || name.startsWith('CYBORG_') || INHERITED_SESSION_VARS.includes(name);
export const OWN_NAMES_REMOTE = (name: string): boolean => OWN_NAMES_LOCAL(name) || isAuthEnvName(name);

export type SelectOutcome = { ok: true } | { ok: false; reason: string };

export interface ManagedEnvDeps {
  file: string;
  home: string;
  loginPath: () => Promise<string>;
  reserved?: NameCheck;
  evaluate?: typeof evaluate;
  evalOptions?: { timeoutMs?: number; killGraceMs?: number; maxBytes?: number };
  inherited?: () => NodeJS.ProcessEnv;
  onChange?: () => void;
  now?: () => Date;
}

const sha = (value: string | undefined): string => (value === undefined ? 'none' : createHash('sha256').update(value).digest('hex'));
const CANCELLED: EvalResult & { cancelled: true } = { ok: false, reason: 'cancelled', stderr: '', cancelled: true };
const keyOf = (name: string): string => `env:${name}`;
const REASON_TEXT: Record<string, string> = {
  exit: 'команда завершилась с ошибкой',
  empty: 'команда ничего не напечатала',
  nul: 'вывод содержит NUL',
  overflow: 'вывод длиннее 64 КиБ',
  timeout: 'команда не уложилась в 60 с',
  cancelled: 'отменено',
  spawn: 'команда не запустилась',
};

/** Переменные окружения дочерних процессов Cyborg: определения, выбор, значения в памяти (раздел «Окружение»). */
export class ManagedEnv {
  private defs: EnvVarDef[] = [];
  private readonly values = new Map<string, string>();
  private readonly status = new Map<string, VarStatus>();
  /** Вывод ошибки неудачного вычисления: в нём бывает само значение, поэтому окно получает его только по запросу. */
  private readonly failures = new Map<string, string>();
  private problems: string[] = [];
  private starting = false;
  private disposed = false;
  /** Имена, которым стартовое вычисление ещё должно значение: любое действие человека над именем снимает его отсюда (побеждает последнее действие). */
  private readonly queue = new Set<string>();
  private cached: Overlay = { set: new Map(), unset: new Set() };
  private readyPromise: Promise<void> = Promise.resolve();
  private pathPromise: Promise<string> | null = null;
  private readonly runner = new SearchRunner();
  private readonly reserved: NameCheck;

  constructor(private readonly deps: ManagedEnvDeps) {
    this.reserved = deps.reserved ?? reservedName;
    this.load();
    for (const def of this.defs) {
      const cand = this.chosen(def);
      if (cand?.kind === 'literal') this.values.set(def.name, cand.value);
    }
    this.rebuild();
  }

  private inherited(): NodeJS.ProcessEnv {
    return this.deps.inherited?.() ?? process.env;
  }

  private load(): void {
    let raw: Buffer;
    try {
      raw = fs.readFileSync(this.deps.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.problems.push(`файл окружения не прочитан: ${(error as Error).message}`);
      return;
    }
    let parsed: unknown;
    try {
      if (raw.length > MAX_FILE_BYTES) throw new SyntaxError('файл больше 8 МиБ');
      parsed = JSON.parse(raw.toString('utf8'));
    } catch (error) {
      let copy = '';
      try {
        copy = keepCorruptCopy(this.deps.file, raw, this.deps.now?.() ?? new Date(), 0o600);
      } catch {
        // Копию не сделать: файл остаётся на месте и не перезаписывается до сохранения человеком.
      }
      this.problems.push(`файл окружения повреждён (${(error as Error).message})${copy ? `, копия: ${copy}` : ''}`);
      return;
    }
    const read = readDefs(parsed, this.reserved);
    this.defs = read.vars;
    this.problems.push(...read.problems);
  }

  private chosen(def: EnvVarDef): Candidate | undefined {
    return def.choice.kind === 'selected' ? def.candidates.find((c) => c.id === (def.choice as { candidate: string }).candidate) : undefined;
  }

  private rebuild(): void {
    const set = new Map<string, string>();
    const unset = new Set<string>();
    for (const def of this.defs) {
      if (def.choice.kind === 'unset') unset.add(def.name);
      else if (def.choice.kind === 'selected' && this.values.has(def.name)) set.set(def.name, this.values.get(def.name) as string);
    }
    this.cached = { set, unset };
  }

  private changed(): void {
    this.rebuild();
    this.deps.onChange?.();
  }

  private commit(next: EnvVarDef[]): void {
    writeJsonAtomic(this.deps.file, { version: 1, vars: next }, 0o600);
    this.defs = next;
    this.problems = this.problems.filter((p) => !p.startsWith('файл окружения повреждён'));
  }

  private def(name: unknown): EnvVarDef {
    const def = typeof name === 'string' ? this.defs.find((d) => d.name === name) : undefined;
    if (!def) throw new Error('Переменной нет в списке');
    return def;
  }

  private replace(name: string, change: (def: EnvVarDef) => EnvVarDef | null): void {
    const next = this.defs.flatMap((d) => (d.name === name ? (() => { const r = change(d); return r ? [r] : []; })() : [d]));
    this.commit(next);
  }

  private clearStatus(name: string): void {
    this.status.delete(name);
    this.failures.delete(name);
  }

  /** Идущее вычисление имени отменяется, его результат состояния не трогает. */
  private abort(name: string): void {
    this.queue.delete(name);
    this.runner.cancel(keyOf(name));
    this.clearStatus(name);
  }

  overlay(): Overlay {
    return this.cached;
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  view(): EnvView {
    return {
      vars: this.defs.map((d) => ({
        name: d.name,
        candidates: d.candidates,
        choice: d.choice,
        status: this.status.get(d.name) ?? { kind: 'idle' },
        unapplied: d.choice.kind === 'selected' && !this.values.has(d.name),
        notes: ownNotes(d.name),
      })),
      problems: this.problems,
      starting: this.starting,
    };
  }

  /** Имена унаследованного окружения для подсказки в окне: без значений, служебных и уже заведённых. */
  inheritedNames(): string[] {
    const defined = new Set(this.defs.map((d) => d.name));
    return Object.keys(this.inherited())
      .filter((name) => isValidName(name) && !defined.has(name) && !this.reserved(name))
      .sort();
  }

  /** Значение, которое получают процессы, - из памяти, без нового вычисления; null - переменная не задана. */
  reveal(name: unknown): string | null {
    const def = this.def(name);
    const effective = this.effective(def.name);
    return effective ?? null;
  }

  /** Вывод ошибки последнего неудачного вычисления; null - его нет. */
  failureOutput(name: unknown): string | null {
    return this.failures.get(this.def(name).name) ?? null;
  }

  private effective(name: string): string | undefined {
    if (this.cached.unset.has(name)) return undefined;
    return this.cached.set.get(name) ?? this.inherited()[name];
  }

  digest(name: string): string {
    return sha(this.effective(name));
  }

  stamp(remote: boolean): EnvStamp {
    const own = remote ? OWN_NAMES_REMOTE : OWN_NAMES_LOCAL;
    return { remote, digests: new Map(this.defs.filter((d) => !own(d.name)).map((d) => [d.name, this.digest(d.name)])) };
  }

  /** Имена, значение которых для процесса стало другим, чем при запуске сессии с этой отметкой. */
  stale(stamp: EnvStamp): string[] {
    const own = stamp.remote ? OWN_NAMES_REMOTE : OWN_NAMES_LOCAL;
    const names = new Set([...stamp.digests.keys(), ...this.defs.map((d) => d.name)]);
    return [...names].filter((name) => !own(name) && this.digest(name) !== (stamp.digests.get(name) ?? sha(this.inherited()[name])));
  }

  private path(): Promise<string> {
    this.pathPromise ??= this.deps.loginPath();
    return this.pathPromise;
  }

  private run(name: string, command: string): Promise<EvalResult & { cancelled?: true }> {
    return this.runner.run<EvalResult & { cancelled?: true }>(
      keyOf(name),
      async (signal) => {
        const path = await this.path();
        const env = composeEnv(this.inherited(), this.cached);
        return (this.deps.evaluate ?? evaluate)(command, { env, home: this.deps.home, path, signal, ...this.deps.evalOptions });
      },
      CANCELLED,
    );
  }

  private fail(name: string, result: Extract<EvalResult, { ok: false }>): void {
    const output = cleanMessage(result.stderr);
    if (output) this.failures.set(name, output);
    else this.failures.delete(name);
    this.status.set(name, { kind: 'failed', reason: REASON_TEXT[result.reason] ?? result.reason, output: !!output });
    this.changed();
  }

  /** Выбор кандидата: выражение вычисляется сейчас и при каждом повторном выборе; неудача оставляет прежнее состояние. */
  async select(name: unknown, id: unknown): Promise<SelectOutcome> {
    const def = this.def(name);
    const cand = def.candidates.find((c) => c.id === id);
    if (!cand) throw new Error('Кандидата нет в списке');
    this.abort(def.name);
    if (cand.kind === 'literal') {
      this.replace(def.name, (d) => ({ ...d, choice: { kind: 'selected', candidate: cand.id } }));
      this.values.set(def.name, cand.value);
      this.changed();
      return { ok: true };
    }
    this.status.set(def.name, { kind: 'evaluating', candidate: cand.id });
    this.deps.onChange?.();
    const result = await this.run(def.name, cand.command);
    if ('cancelled' in result && result.cancelled) return { ok: false, reason: 'cancelled' };
    if (!result.ok) {
      this.fail(def.name, result);
      return { ok: false, reason: result.reason };
    }
    try {
      this.replace(def.name, (d) => ({ ...d, choice: { kind: 'selected', candidate: cand.id } }));
    } catch (error) {
      this.clearStatus(def.name);
      this.deps.onChange?.();
      throw error;
    }
    this.values.set(def.name, result.value);
    this.clearStatus(def.name);
    this.changed();
    return { ok: true };
  }

  /** Снять переменную: у процессов её нет, даже если Cyborg унаследовал её; имя без кандидатов тоже годится. */
  unset(name: unknown): void {
    if (!isValidName(name)) throw new Error('Некорректное имя переменной');
    const refusal = this.reserved(name);
    if (refusal) throw new Error(`${name}: ${refusal}`);
    this.abort(name);
    if (this.defs.some((d) => d.name === name)) this.replace(name, (d) => ({ ...d, choice: { kind: 'unset' } }));
    else {
      if (this.defs.length >= MAX_VARS) throw new Error(`Переменных больше ${MAX_VARS}`);
      this.commit([...this.defs, { name, candidates: [], choice: { kind: 'unset' } }]);
    }
    this.values.delete(name);
    this.changed();
  }

  /** «Не трогать»: процессы получают унаследованное значение; кандидаты остаются. */
  untouch(name: unknown): void {
    const def = this.def(name);
    this.abort(def.name);
    this.replace(def.name, (d) => ({ ...d, choice: { kind: 'untouched' } }));
    this.values.delete(def.name);
    this.changed();
  }

  remove(name: unknown): void {
    const def = this.def(name);
    this.abort(def.name);
    this.replace(def.name, () => null);
    this.values.delete(def.name);
    this.changed();
  }

  /** Кнопка «Отменить»: идущее вычисление снимается, состояние остаётся прежним. */
  cancel(name: unknown): void {
    const def = this.def(name);
    if (this.status.get(def.name)?.kind !== 'evaluating') return;
    this.queue.delete(def.name);
    this.runner.cancel(keyOf(def.name));
    this.failures.delete(def.name);
    this.status.set(def.name, { kind: 'failed', reason: REASON_TEXT.cancelled, output: false });
    this.deps.onChange?.();
  }

  /** Определения из окна: выбор меняют только действия; правка выбранного выражения возвращает «не трогать», правка выбранного литерала действует сразу. */
  save(raw: unknown): void {
    if (!Array.isArray(raw)) throw new Error('Некорректный список переменных');
    const fresh = (taken: Set<string>): string => {
      for (;;) {
        const id = randomBytes(4).toString('hex');
        if (!taken.has(id)) return id;
      }
    };
    const next: EnvVarDef[] = [];
    for (const item of raw) {
      const entry = (typeof item === 'object' && item !== null ? item : {}) as { name?: unknown; candidates?: unknown };
      const taken = new Set<string>();
      const candidates = (Array.isArray(entry.candidates) ? entry.candidates : []).map((c: unknown) => {
        const cand = (typeof c === 'object' && c !== null ? { ...(c as Record<string, unknown>) } : {}) as Record<string, unknown>;
        if (typeof cand.id !== 'string' || taken.has(cand.id)) cand.id = fresh(taken);
        taken.add(cand.id as string);
        return cand;
      });
      const def = readDef({ name: entry.name, candidates }, this.reserved);
      if (typeof def === 'string') throw new Error(def);
      if (next.some((d) => d.name === def.name)) throw new Error(`${def.name}: имя повторено`);
      const prev = this.defs.find((d) => d.name === def.name);
      next.push({ ...def, choice: prev?.choice ?? { kind: 'untouched' } });
    }
    if (next.length > MAX_VARS) throw new Error(`Переменных больше ${MAX_VARS}`);
    const touched: string[] = [];
    for (const def of next) {
      const prev = this.defs.find((d) => d.name === def.name);
      if (prev && JSON.stringify(prev.candidates) !== JSON.stringify(def.candidates)) touched.push(def.name);
    }
    for (const prev of this.defs) if (!next.some((d) => d.name === prev.name)) touched.push(prev.name);
    const values = new Map<string, string>();
    // Выбранное выражение с прежним текстом остаётся выбранным и без значения: его вычисляет старт либо вычисление не удалось, и до следующего старта выбор не теряется.
    const keeps = new Set<string>();
    const final = next.map((def) => {
      if (def.choice.kind !== 'selected') return def;
      const candidate = (def.choice as { candidate: string }).candidate;
      const cand = def.candidates.find((c) => c.id === candidate);
      if (!cand) return { ...def, choice: { kind: 'untouched' } as const };
      if (cand.kind === 'literal') {
        values.set(def.name, cand.value);
        return def;
      }
      const prev = this.defs.find((d) => d.name === def.name);
      const same = prev?.candidates.find((c) => c.id === candidate);
      if (same?.kind !== 'expr' || same.command !== cand.command) return { ...def, choice: { kind: 'untouched' } as const };
      if (this.values.has(def.name)) values.set(def.name, this.values.get(def.name) as string);
      keeps.add(def.name);
      return def;
    });
    for (const name of touched) {
      // Идущее вычисление выбранного выражения с прежним текстом - стартовое: его правка другого кандидата не касается. Чужое (выбор человека другого кандидата) отменяется.
      const foreign = this.status.get(name)?.kind === 'evaluating' && !this.queue.has(name);
      if (!keeps.has(name) || foreign) this.abort(name);
    }
    this.commit(final);
    this.values.clear();
    for (const [name, value] of values) this.values.set(name, value);
    this.changed();
  }

  /** Старт Cyborg: выражения выбранных переменных вычисляются заново, по очереди (по одному pinentry); запуски процессов ждут конца. */
  start(): Promise<void> {
    const pending = this.defs.filter((d) => this.chosen(d)?.kind === 'expr').map((d) => d.name);
    if (!pending.length) return this.readyPromise;
    this.starting = true;
    for (const name of pending) {
      this.queue.add(name);
      const def = this.defs.find((d) => d.name === name);
      this.status.set(name, { kind: 'evaluating', candidate: def && this.chosen(def)?.id });
    }
    this.deps.onChange?.();
    this.readyPromise = (async () => {
      try {
        for (const name of pending) {
          // Очередь снимает действие человека над именем: его выбор уже вычисляется или состоялся, старый кандидат ему не помеха.
          if (this.disposed) break;
          if (!this.queue.has(name)) continue;
          const def = this.defs.find((d) => d.name === name);
          const cand = def && this.chosen(def);
          if (cand?.kind !== 'expr') {
            this.queue.delete(name);
            continue;
          }
          const result = await this.run(name, cand.command);
          if ('cancelled' in result && result.cancelled) continue;
          this.queue.delete(name);
          if (!result.ok) this.fail(name, result);
          else {
            this.values.set(name, result.value);
            this.clearStatus(name);
            this.changed();
          }
        }
      } finally {
        this.queue.clear();
        this.starting = false;
        this.deps.onChange?.();
      }
    })();
    return this.readyPromise;
  }

  /** Cyborg закрывается: идущие вычисления снимаются вместе с группами процессов. */
  dispose(): void {
    this.disposed = true;
    for (const def of this.defs) this.runner.cancel(keyOf(def.name));
  }
}
