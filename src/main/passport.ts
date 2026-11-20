/** Паспорт проекта (ADR-0023): проверка файлов, состояние в репозитории, проба вкладкой сессии; содержимое паспорта Cyborg не пишет (D-23, D-46). */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  CAPABILITIES,
  GROUPS,
  INDEX_FILE,
  OUTCOME_TEXT,
  PASSPORT_DIR,
  REASON_TEXT,
  STATE_FILE,
  capabilityById,
  emptyState,
  fileReasons,
  type Capability,
  type CapabilityView,
  type PassportState,
  type PassportView,
  type ProbeEntry,
  type ProbeOutcome,
  type RepoView,
} from '../shared/passport';
import { writeJsonAtomic } from './jsonfile';
import type { Project } from './projects';

export const NO_CLAUDE_TEXT = 'Нет CLI claude: проба и исправление недоступны';
export const NEED_MAIN_TEXT = 'Отметьте главный репозиторий';
// Ответ и источник агента - недоверенный текст: режутся по длине, пределов на файлы паспорта нет (D-20).
const MAX_ANSWER = 2000;
const MAX_SOURCE = 500;

const passportDir = (repo: string): string => path.join(repo, PASSPORT_DIR);
const stateFile = (repo: string): string => path.join(passportDir(repo), STATE_FILE);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Состояние из текста файла; не по форме - причина строкой, лишние поля отбрасываются. */
export function parseState(text: string): PassportState | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return `не разобрано: ${(error as Error).message}`;
  }
  if (!isRecord(raw)) return 'корень не объект';
  const state = emptyState();
  if (isRecord(raw.probe) && isRecord(raw.probe.outcomes)) {
    const outcomes: Record<string, ProbeEntry> = {};
    for (const [id, entry] of Object.entries(raw.probe.outcomes)) {
      if (!capabilityById(id) || !isRecord(entry)) continue;
      const outcome = entry.outcome;
      if (outcome !== 'found' && outcome !== 'invented' && outcome !== 'unknown') continue;
      outcomes[id] = {
        outcome,
        answer: typeof entry.answer === 'string' ? entry.answer.slice(0, MAX_ANSWER) : '',
        source: typeof entry.source === 'string' ? entry.source.slice(0, MAX_SOURCE) : '',
        ...(entry.confirmed === true ? { confirmed: true } : {}),
      };
    }
    state.probe = { at: typeof raw.probe.at === 'string' ? raw.probe.at : '', outcomes };
  }
  if (isRecord(raw.approxConfirmed)) {
    for (const [id, hash] of Object.entries(raw.approxConfirmed)) if (capabilityById(id) && typeof hash === 'string') state.approxConfirmed[id] = hash;
  }
  if (Array.isArray(raw.notNeeded)) state.notNeeded = [...new Set(raw.notNeeded.filter((id): id is string => typeof id === 'string' && !!capabilityById(id)))];
  return state;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
}

// Ссылка в .cyborg, .cyborg/passport или state.json увела бы запись и чтение за пределы репозитория.
function symlinkIn(repo: string): string | null {
  for (const p of [path.join(repo, '.cyborg'), passportDir(repo), stateFile(repo)]) {
    try {
      if (fs.lstatSync(p).isSymbolicLink()) return p;
    } catch {
      // звена нет: ссылкой оно быть не может
    }
  }
  return null;
}

/** Состояние репозитория: файла нет - пустое; повреждён - пустое и problem, перезаписывать его молча нельзя. */
export function loadState(repo: string): { state: PassportState; problem: string | null } {
  const link = symlinkIn(repo);
  if (link) return { state: emptyState(), problem: `${link} - символьная ссылка, состояние паспорта не читается` };
  let text: string;
  try {
    text = fs.readFileSync(stateFile(repo), 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { state: emptyState(), problem: null };
    return { state: emptyState(), problem: `состояние паспорта не прочитано (${code ?? (error as Error).message})` };
  }
  const parsed = parseState(text);
  return typeof parsed === 'string' ? { state: emptyState(), problem: `состояние паспорта в ${repo} ${parsed}` } : { state: parsed, problem: null };
}

/** Запись состояния только в каталог паспорта и атомарно; повреждённое состояние не затирается (ADR-0014 п.4). */
export function saveState(repo: string, change: (state: PassportState) => void): void {
  const { state, problem } = loadState(repo);
  if (problem) throw new Error(`${problem}: исправьте файл ${STATE_FILE}, запись не выполнена`);
  change(state);
  state.notNeeded = [...new Set(state.notNeeded)].sort();
  fs.mkdirSync(passportDir(repo), { recursive: true });
  writeJsonAtomic(stateFile(repo), sortKeys(state));
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Содержимое файла способности: null - файла нет; ссылка за каталог паспорта не читается (NFR-20002). */
async function readCapabilityFile(repo: string, cap: Capability): Promise<{ content: string | null; problem?: string }> {
  const dir = passportDir(repo);
  const file = path.join(dir, cap.file);
  try {
    const real = await fs.promises.realpath(file);
    const realDir = await fs.promises.realpath(dir);
    if (path.relative(realDir, real).startsWith('..')) return { content: null, problem: `${cap.file}: символьная ссылка за пределы каталога паспорта не читается` };
    const stat = await fs.promises.stat(real);
    if (!stat.isFile()) return { content: null, problem: `${cap.file}: не файл` };
    return { content: await fs.promises.readFile(real, 'utf8') };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { content: null };
    return { content: null, problem: `${cap.file}: не прочитан (${code ?? (error as Error).message})` };
  }
}

/** Указатель неглавного репозитория: Markdown-ссылка, чей путь от каталога index.md ведёт в index.md главного (FR-20009). */
export async function pointerOk(repo: string, main: string): Promise<boolean> {
  let text: string;
  try {
    text = await fs.promises.readFile(path.join(passportDir(repo), INDEX_FILE), 'utf8');
  } catch {
    return false;
  }
  const target = path.join(passportDir(main), INDEX_FILE);
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const href = match[1].split('#')[0];
    if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
    if (path.resolve(passportDir(repo), decodeURI(href)) === target) return true;
  }
  return false;
}

interface LocalData {
  mains: Record<string, string>;
}

// Отметка главного репозитория хранится у Cyborg, не в репозитории (D-47).
function readLocal(file: string): LocalData {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (isRecord(raw) && isRecord(raw.mains)) {
      return { mains: Object.fromEntries(Object.entries(raw.mains).filter((e): e is [string, string] => typeof e[1] === 'string')) };
    }
  } catch {
    // файла нет или он негоден: отметок нет
  }
  return { mains: {} };
}

export type PassportAction =
  | { op: 'notNeeded'; capability: string }
  | { op: 'needed'; capability: string }
  | { op: 'confirmApprox'; capability: string; repo: string }
  | { op: 'confirmAnswer'; capability: string; repo: string }
  | { op: 'rejectAnswer'; capability: string; repo: string }
  | { op: 'setMain'; repo: string };

/** Действие из окна: интерфейс недоверен (ADR-0002), способность - из перечня, репозиторий - из проекта. */
export function validateAction(value: unknown, repos: string[]): PassportAction | null {
  if (!isRecord(value) || typeof value.op !== 'string') return null;
  const { op } = value;
  if (op === 'setMain') return typeof value.repo === 'string' && repos.includes(value.repo) ? { op, repo: value.repo } : null;
  if (typeof value.capability !== 'string' || !capabilityById(value.capability)) return null;
  if (op === 'notNeeded' || op === 'needed') return { op, capability: value.capability };
  if (op === 'confirmApprox' || op === 'confirmAnswer' || op === 'rejectAnswer') {
    return typeof value.repo === 'string' && repos.includes(value.repo) ? { op, capability: value.capability, repo: value.repo } : null;
  }
  return null;
}

export interface ProbeItem {
  id: string;
  outcome: 'found' | 'unknown';
  answer: string;
  source: string;
}

/** Аргументы report_passport: лишнее и неизвестное - отказ с причиной, которую видит модель. */
export function validateProbeReport(value: unknown, expected: string[]): ProbeItem[] | string {
  if (!isRecord(value) || !Array.isArray(value.capabilities)) return 'capabilities - массив';
  const items: ProbeItem[] = [];
  const seen = new Set<string>();
  for (const raw of value.capabilities) {
    if (!isRecord(raw) || typeof raw.id !== 'string') return 'каждая запись - объект с id';
    if (!expected.includes(raw.id)) return `способность ${raw.id} в пробе не участвует`;
    if (seen.has(raw.id)) return `способность ${raw.id} названа дважды`;
    seen.add(raw.id);
    if (raw.outcome !== 'found' && raw.outcome !== 'unknown') return `${raw.id}: outcome - found или unknown`;
    const answer = typeof raw.answer === 'string' ? raw.answer.trim().slice(0, MAX_ANSWER) : '';
    const source = typeof raw.source === 'string' ? raw.source.trim().slice(0, MAX_SOURCE) : '';
    items.push({ id: raw.id, outcome: raw.outcome, answer, source });
  }
  const missing = expected.filter((id) => !seen.has(id));
  if (missing.length) return `нет ответа по способностям: ${missing.join(', ')}`;
  return items;
}

/** Механическая проверка источника (FR-20007): файл внутри рабочей копии, не каталог, строка не за концом. */
export function sourceResolves(source: string, repos: string[]): boolean {
  const m = /^(.+?)(?::(\d+))?$/.exec(source.trim());
  if (!m || !m[1] || m[1].includes('\0')) return false;
  const line = m[2] === undefined ? null : Number(m[2]);
  for (const repo of repos) {
    try {
      const real = fs.realpathSync(path.resolve(repo, m[1]));
      const rel = path.relative(fs.realpathSync(repo), real);
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
      if (!fs.statSync(real).isFile()) continue;
      if (line !== null) {
        if (line < 1) continue;
        const text = fs.readFileSync(real, 'utf8');
        const count = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
        if (line > count) continue;
      }
      return true;
    } catch {
      // нет файла: пробуем следующий репозиторий
    }
  }
  return false;
}

export function probeOutcome(item: ProbeItem, repos: string[]): ProbeOutcome {
  if (item.outcome === 'unknown') return 'unknown';
  return item.source && sourceResolves(item.source, repos) ? 'found' : 'invented';
}

const capList = (caps: Capability[]): string => caps.map((c) => `- ${c.id}: ${c.question} (файл паспорта ${c.file})`).join('\n');

export function probePrompt(caps: Capability[], repo: string): string {
  return [
    'Проба паспорта проекта. Для каждой способности ниже найди в рабочей копии проекта ответ на вопрос и источник ответа.',
    'Файлы проекта не меняй, ничего не коммить: проба только читает.',
    `Рабочая копия: ${repo}. Источник - путь к файлу от корня рабочей копии, при желании со строкой: docs/a.md:12.`,
    'Если ответа в проекте нет - честно ответь «не знаю» (outcome unknown), не выдумывай: источник проверит Cyborg, несуществующий источник - это «выдумывает».',
    'Если без человека не обойтись, спроси его здесь же в диалоге.',
    'Итог сдай ОДНИМ вызовом инструмента report_passport: capabilities - по записи на каждую способность {id, outcome: found|unknown, answer, source}. Пока не вызвал, проба не окончена.',
    'После вызова скажи человеку, что проба закончена и вкладку можно закрыть.',
    '',
    'Способности:',
    capList(caps),
  ].join('\n');
}

export function fixPrompt(cap: Capability, repo: string): string {
  return [
    `Исправление пробела паспорта проекта: способность «${cap.name}».`,
    `Вопрос к проекту: ${cap.question}`,
    `Файл паспорта: ${PASSPORT_DIR}/${cap.file} в репозитории ${repo}.`,
    'Метки в файле: «⚠» - не найдено, нужен человек; «≈» - черновик по коду, нужно подтвердить. Заполни файл ответом с источниками из проекта; чего не нашёл - помечай «⚠», домыслы - «≈».',
    'Сначала выдай ПЛАН: что выяснить, какие файлы править, какие скиллы выбраны и почему. До подтверждения плана человеком файлы не правь.',
    'Кандидатов в скиллы нет: исполняй это поручение сам. Не коммить и не сливай: как правка дойдёт до PR, решает человек.',
  ].join('\n');
}

interface ProbeRun {
  projectId: string;
  repos: string[];
  // Способность -> репозиторий, в состоянии которого пишется её исход.
  where: Map<string, string>;
  reported: boolean;
}

export interface PassportDeps {
  projects: () => Project[];
  localFile: string;
  emit: (channel: string, payload: unknown) => void;
  claudeAvailable: () => Promise<boolean>;
}

/** claude из логин-шелла, как его запускает сессия: наличие ищется тем же способом. */
export function systemClaudeAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(process.env.SHELL || '/bin/sh', ['-lc', 'command -v claude'], { timeout: 5000 }, (error) => resolve(!error));
  });
}

export class PassportService {
  private readonly probes = new Map<number, ProbeRun>();
  private readonly notes = new Map<string, string>();

  constructor(private readonly deps: PassportDeps) {}

  private project(id: unknown): Project | null {
    return this.deps.projects().find((p) => p.id === id) ?? null;
  }

  // Главный репозиторий: у проекта из одного репозитория он сам, у нескольких - отметка Cyborg (D-24, D-47).
  private mainOf(project: Project): string | null {
    if (project.repos.length === 1) return project.repos[0];
    const mark = readLocal(this.deps.localFile).mains[project.id];
    return mark && project.repos.includes(mark) ? mark : null;
  }

  private isProbing(projectId: string): boolean {
    for (const run of this.probes.values()) if (run.projectId === projectId && !run.reported) return true;
    return false;
  }

  async view(projectId: unknown): Promise<PassportView> {
    const project = this.project(projectId);
    if (!project) throw new Error('Проект не найден');
    const main = this.mainOf(project);
    const problems: string[] = [];
    const states = new Map<string, PassportState>();
    for (const repo of project.repos) {
      const loaded = loadState(repo);
      states.set(repo, loaded.state);
      if (loaded.problem) problems.push(loaded.problem);
    }
    const notNeeded = new Set(main ? (states.get(main)?.notNeeded ?? []) : []);
    const capabilities: CapabilityView[] = [];
    for (const group of GROUPS) {
      for (const cap of CAPABILITIES.filter((c) => c.group === group.id)) {
        // Техника проверяется в каждом репозитории, остальное - только в главном (FR-20009).
        const repos = cap.group === 'tech' ? project.repos : main ? [main] : [];
        for (const repo of repos) {
          const state = states.get(repo) ?? emptyState();
          const file = await readCapabilityFile(repo, cap);
          if (file.problem) problems.push(file.problem);
          const confirmed = file.content !== null && state.approxConfirmed[cap.id] === sha(file.content);
          const fileWhy = fileReasons(file.content, confirmed);
          const reasons: string[] = fileWhy.map((r) => REASON_TEXT[r]);
          const probe = state.probe?.outcomes[cap.id] ?? null;
          if (probe) {
            if (probe.outcome !== 'found') reasons.push(OUTCOME_TEXT[probe.outcome]);
            else if (cap.semantic && !probe.confirmed) reasons.push('ждёт подтверждения');
          }
          const off = notNeeded.has(cap.id);
          capabilities.push({
            id: cap.id,
            group: cap.group,
            name: cap.name,
            question: cap.question,
            file: cap.file,
            repo,
            notNeeded: off,
            fileReasons: fileWhy,
            hasApprox: !!file.content?.includes('≈'),
            probe,
            reasons,
            gap: !off && reasons.length > 0,
            semantic: cap.semantic,
          });
        }
      }
    }
    const repos: RepoView[] = [];
    let pointerGaps = 0;
    for (const repo of project.repos) {
      const isMain = repo === main;
      const ok = project.repos.length > 1 && main && !isMain ? await pointerOk(repo, main) : null;
      if (ok === false) pointerGaps++;
      repos.push({ repo, main: isMain, pointerOk: ok });
    }
    const count = capabilities.filter((c) => c.gap).length + pointerGaps;
    const level = count > 0 ? 'gaps' : project.repos.length > 1 && !main ? 'unchecked' : 'clear';
    const available = await this.deps.claudeAvailable();
    return {
      projectId: project.id,
      level,
      count,
      repos,
      mainRepo: main,
      capabilities,
      probing: this.isProbing(project.id),
      agentUnavailable: available ? null : NO_CLAUDE_TEXT,
      problems: [...new Set(problems)],
      probeNote: this.notes.get(project.id) ?? null,
    };
  }

  /** Действие разработчика: запись состояния выполняет главный процесс, окно только передаёт нажатие (NFR-20002, D-46). */
  async act(projectId: unknown, value: unknown): Promise<PassportView> {
    const project = this.project(projectId);
    if (!project) throw new Error('Проект не найден');
    const action = validateAction(value, project.repos);
    if (!action) throw new Error('Некорректное действие паспорта');
    const main = this.mainOf(project);
    if (action.op === 'setMain') {
      const local = readLocal(this.deps.localFile);
      local.mains[project.id] = action.repo;
      fs.mkdirSync(path.dirname(this.deps.localFile), { recursive: true });
      writeJsonAtomic(this.deps.localFile, local);
      return this.view(project.id);
    }
    const cap = capabilityById(action.capability)!;
    if (action.op === 'notNeeded' || action.op === 'needed') {
      if (!main) throw new Error(NEED_MAIN_TEXT);
      saveState(main, (s) => {
        s.notNeeded = action.op === 'notNeeded' ? [...s.notNeeded, cap.id] : s.notNeeded.filter((id) => id !== cap.id);
      });
    } else if (action.op === 'confirmApprox') {
      const file = await readCapabilityFile(action.repo, cap);
      if (file.content === null || !file.content.includes('≈')) throw new Error('В файле нет метки «≈»: подтверждать нечего');
      const hash = sha(file.content);
      saveState(action.repo, (s) => {
        s.approxConfirmed[cap.id] = hash;
      });
    } else {
      saveState(action.repo, (s) => {
        const entry = s.probe?.outcomes[cap.id];
        if (!entry || entry.outcome !== 'found') throw new Error('У способности нет найденного пробой ответа');
        if (action.op === 'confirmAnswer') entry.confirmed = true;
        else {
          entry.outcome = 'invented';
          delete entry.confirmed;
        }
      });
    }
    return this.view(project.id);
  }

  /** Каталог, добавочные каталоги и начальный промпт вкладки пробы; отказ - исключение с причиной. */
  async prepareProbe(projectId: unknown): Promise<{ cwd: string; addDirs: string[]; prompt: string; run: ProbeRun }> {
    const project = this.project(projectId);
    if (!project) throw new Error('Проект не найден');
    if (!(await this.deps.claudeAvailable())) throw new Error(NO_CLAUDE_TEXT);
    if (this.isProbing(project.id)) throw new Error('Проба идёт');
    const main = this.mainOf(project);
    if (!main) throw new Error(NEED_MAIN_TEXT);
    const off = new Set(loadState(main).state.notNeeded);
    const caps = CAPABILITIES.filter((c) => !off.has(c.id));
    if (!caps.length) throw new Error('Все способности сняты «Не нужно»: проверять нечего');
    return {
      cwd: main,
      addDirs: project.repos.filter((r) => r !== main),
      prompt: probePrompt(caps, main),
      run: { projectId: project.id, repos: project.repos, where: new Map(caps.map((c) => [c.id, main])), reported: false },
    };
  }

  registerProbe(sessionId: number, run: ProbeRun): void {
    this.probes.set(sessionId, run);
    this.notes.delete(run.projectId);
    this.deps.emit('passport:changed', { projectId: run.projectId });
  }

  isProbe(sessionId: number): boolean {
    const run = this.probes.get(sessionId);
    return !!run && !run.reported;
  }

  /** report_passport: исходы применяются целиком одним вызовом либо не применяются (FR-20006). */
  report(sessionId: number, value: unknown): string {
    const run = this.probes.get(sessionId);
    if (!run) throw new Error('Эта сессия не ведёт пробу паспорта');
    if (run.reported) throw new Error('Итог пробы уже сдан');
    const items = validateProbeReport(value, [...run.where.keys()]);
    if (typeof items === 'string') throw new Error(items);
    const byRepo = new Map<string, Record<string, ProbeEntry>>();
    for (const item of items) {
      const repo = run.where.get(item.id)!;
      const outcomes = byRepo.get(repo) ?? {};
      outcomes[item.id] = { outcome: probeOutcome(item, run.repos), answer: item.answer, source: item.source };
      byRepo.set(repo, outcomes);
    }
    const at = new Date().toISOString();
    for (const [repo, outcomes] of byRepo) {
      saveState(repo, (s) => {
        s.probe = { at, outcomes };
      });
    }
    run.reported = true;
    this.deps.emit('passport:changed', { projectId: run.projectId });
    const counts = { found: 0, invented: 0, unknown: 0 };
    for (const outcomes of byRepo.values()) for (const e of Object.values(outcomes)) counts[e.outcome]++;
    return `Исходы записаны: нашёл с источником ${counts.found}, выдумывает ${counts.invented}, не знает ${counts.unknown}. Скажи человеку, что проба закончена, и вкладку можно закрыть.`;
  }

  /** Вкладка пробы закрыта до итога: прежние исходы на месте, причина названа (FR-20006). */
  sessionEnded(sessionId: number): void {
    const run = this.probes.get(sessionId);
    if (!run) return;
    this.probes.delete(sessionId);
    if (!run.reported) this.notes.set(run.projectId, 'Проба прервана: вкладку закрыли до итога. Прежние исходы на месте.');
    this.deps.emit('passport:changed', { projectId: run.projectId });
  }

  /** Каталог и промпт вкладки исправления; способность и репозиторий проверяются по проекту. */
  async prepareFix(projectId: unknown, capability: unknown, repo: unknown): Promise<{ cwd: string; addDirs: string[]; prompt: string }> {
    const project = this.project(projectId);
    if (!project) throw new Error('Проект не найден');
    if (typeof capability !== 'string' || typeof repo !== 'string') throw new Error('Некорректные аргументы исправления');
    const cap = capabilityById(capability);
    if (!cap || !project.repos.includes(repo)) throw new Error('Некорректные аргументы исправления');
    if (!(await this.deps.claudeAvailable())) throw new Error(NO_CLAUDE_TEXT);
    return { cwd: repo, addDirs: project.repos.filter((r) => r !== repo), prompt: fixPrompt(cap, repo) };
  }
}
