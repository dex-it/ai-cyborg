/** Паспорт проекта (ADR-0023): проверка файлов, состояние в репозитории, проба вкладкой сессии; содержимое паспорта Cyborg не пишет (D-23, D-46). */
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { childEnv, loginShell } from './child-env';
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
  type ClosedEntry,
  type FileReason,
  type PassportState,
  type PassportView,
  type ProbeEntry,
  type ProbeOutcome,
  type RepoView,
} from '../shared/passport';
import { writeJsonAtomic } from './jsonfile';
import type { Project } from './projects';
import { CLOSE_PASSPORT_ITEM_TOOL, LIST_PASSPORT_ITEMS_TOOL } from './session-tools';

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
  if (isRecord(raw.closed)) {
    for (const [id, entry] of Object.entries(raw.closed)) {
      if (!capabilityById(id) || !isRecord(entry) || typeof entry.hash !== 'string') continue;
      state.closed[id] = {
        hash: entry.hash,
        answer: typeof entry.answer === 'string' ? entry.answer.slice(0, MAX_ANSWER) : '',
        source: typeof entry.source === 'string' ? entry.source.slice(0, MAX_SOURCE) : '',
        at: typeof entry.at === 'string' ? entry.at : '',
      };
    }
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
  if (fs.realpathSync(passportDir(repo)) !== path.join(fs.realpathSync(repo), PASSPORT_DIR)) throw new Error(`${PASSPORT_DIR} ведёт за пределы репозитория: запись не выполнена`);
  // wx не идёт по ссылке: подложенный в репозиторий временный файл не принимается.
  const tmp = `${stateFile(repo)}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(sortKeys(state), null, 2), { flag: 'wx' });
    fs.renameSync(tmp, stateFile(repo));
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
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

/** Паспорт - указатель на документы (D-52): нужна Markdown-ссылка (путь от каталога паспорта или от корня репозитория) на существующий файл или каталог внутри репозитория, но не в самом каталоге паспорта. */
export async function docLinkOk(repo: string, content: string): Promise<boolean> {
  let realRepo: string;
  try {
    realRepo = await fs.promises.realpath(repo);
  } catch {
    return false;
  }
  const own = path.join(realRepo, PASSPORT_DIR);
  for (const match of content.matchAll(/\]\(([^)\s]+)\)/g)) {
    const href = match[1].split('#')[0];
    if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
    const decoded = decodeURI(href);
    for (const target of [path.resolve(passportDir(repo), decoded), path.resolve(repo, decoded.replace(/^\/+/, ''))]) {
      try {
        const real = await fs.promises.realpath(target);
        const inRepo = path.relative(realRepo, real);
        if (!inRepo || inRepo.startsWith('..') || path.isAbsolute(inRepo)) continue;
        if (real === own || real.startsWith(own + path.sep)) continue;
        return true;
      } catch {
        // нет такого пути или адрес негоден: этот вариант не считается
      }
    }
  }
  return false;
}

/** Файл способности в дереве `dir`: содержимое, хеш и все причины пробела по файлам (FR-20002); одна проверка для окна, списка и закрытия пункта. */
async function capFile(dir: string, cap: Capability, state: PassportState): Promise<{ content: string | null; hash: string | null; problem?: string; all: FileReason[] }> {
  const file = await readCapabilityFile(dir, cap);
  const hash = file.content === null ? null : sha(file.content);
  const confirmed = hash !== null && state.approxConfirmed[cap.id] === hash;
  const all = fileReasons(file.content, confirmed, file.content === null || (await docLinkOk(dir, file.content)));
  return { content: file.content, hash, problem: file.problem, all };
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

export interface CloseItem {
  id: string;
  repo: string;
  answer: string;
  source: string;
}

/** Аргументы close_passport_item: лишнее и неизвестное - отказ с причиной, которую видит модель (по образцу validateProbeReport). */
export function validateCloseItem(value: unknown, repos: string[]): CloseItem | string {
  if (!isRecord(value)) return 'аргументы - объект {id, repo, answer, source}';
  if (typeof value.id !== 'string' || !capabilityById(value.id)) return `способности ${String(value.id)} нет: id берётся из ${LIST_PASSPORT_ITEMS_TOOL}`;
  if (typeof value.repo !== 'string' || !repos.includes(value.repo)) return `репозиторий ${String(value.repo)} не входит в проект`;
  const answer = typeof value.answer === 'string' ? value.answer.trim().slice(0, MAX_ANSWER) : '';
  const source = typeof value.source === 'string' ? value.source.trim().slice(0, MAX_SOURCE) : '';
  if (!answer) return 'answer пуст: одной-двумя фразами, что зафиксировано в документах';
  if (!source) return 'source пуст: путь документа от корня репозитория, при желании со строкой: docs/a.md:12';
  return { id: value.id, repo: value.repo, answer, source };
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
    `Файл паспорта (${PASSPORT_DIR}) - указатель на документы проекта: иди по его ссылкам и источником указывай сам документ, а не файл паспорта.`,
    'Если без человека не обойтись, спроси его здесь же в диалоге.',
    'Итог сдай ОДНИМ вызовом инструмента report_passport: capabilities - по записи на каждую способность {id, outcome: found|unknown, answer, source}. Пока не вызвал, проба не окончена.',
    'После вызова скажи человеку, что проба закончена и вкладку можно закрыть.',
    '',
    'Способности:',
    capList(caps),
  ].join('\n');
}

/** Начальный промпт сессии настройки паспорта: поручение на всю сессию, начиная с нажатого пункта (FR-20011, D-54). */
export function fixPrompt(cap: Capability, repo: string): string {
  return [
    'Настройка паспорта проекта. Цель сессии: настроить репозиторий так, чтобы следующий агент легко, чётко и консистентно получал из него информацию о проекте. Мерило пункта: агент, который читает только документы по ссылкам паспорта, отвечает на вопрос способности без домысла. Ты ведёшь человека по открытым пунктам паспорта по одному, пока пункты не кончатся или человек не скажет «стоп».',
    `Начни с нажатого пункта: способность «${cap.name}» (id ${cap.id}). Вопрос к проекту: ${cap.question} Файл паспорта: ${PASSPORT_DIR}/${cap.file} в репозитории ${repo}.`,
    `Открытые пункты отдаёт инструмент ${LIST_PASSPORT_ITEMS_TOOL}: вызови его сразу. Нажатого пункта в списке нет (его закрыли, сняли «Не нужно» или пробел уже исправлен) - начни с первого пункта списка. Причины пункта говорят, что не так: пробел по файлу (${Object.values(REASON_TEXT).join('; ')}) либо исход пробы - агент без паспорта выдумал ответ, не нашёл его, или ответ ждёт подтверждения человека.`,
    'Паспорт - не описание проекта, а указатель: в файле способности только Markdown-ссылки на существующие файлы или каталоги проекта (путь от корня репозитория или от каталога паспорта, например [Требования](docs/brd.md)) с короткой подписью, что это за документ. Описания, требований, решений, результатов проверок и регламентов в паспорте быть не должно - они в документах проекта. Метки в файле: «⚠» - документа нет, нужен человек; «≈» - ссылка на черновик, нужно подтвердить.',
    'Каждый пункт веди так:',
    '1. Разведка. Найди ответ в проекте сам: docs/, README, ADR, CLAUDE.md, код, конфиги, история git. Не спрашивай человека о том, что видно в проекте.',
    '2. ПЛАН. Покажи человеку, что нашёл, и черновик ответа; чего не хватает; какие документы создать или править; какая ссылка встанет в паспорт; какие скиллы выбраны и почему. До подтверждения плана человеком файлы не правь.',
    '3. Интервью. Недостающее выясняй вопросами по одному; к каждому предлагай свой вариант ответа из найденного, чтобы человек подтверждал или поправлял, а не писал с нуля. Выясняй не только что есть, но и что решено и почему.',
    '4. Фиксация. Ответы и решения человека записывай в документы проекта, а не в паспорт: найденный документ дополни, а нового документа нет - документ положи в проект по раскладке корпуса (.docs_layout; нет - в docs/ обычным Markdown). Скиллы по документации, если они есть в сессии, используй. Форма для агента: коротко, однозначно, утверждениями и правилами, без воды и пересказа кода; одно знание в одном месте, на соседний документ - ссылкой, не копией. Потом поставь ссылку в файл паспорта.',
    '5. Самопроверка. Прочти только документы по ссылкам паспорта и ответь по ним на вопрос способности: без домысла не выходит - вернись к интервью. Перечитай документы пунктов, закрытых в этой сессии, и соседних способностей: новое не должно им противоречить. Противоречие покажи человеку обеими сторонами и поправь тот документ, который он назовёт неверным.',
    `6. Закрытие. Дай сводку: ответ на вопрос способности одной-двумя фразами и где он записан, - и спроси, закрываем ли пункт. Закрывай, только когда информации достаточно для задачи пункта, она не противоречит другим пунктам и документам проекта и согласована с назначением пункта, и когда человек согласился словами: вызови ${CLOSE_PASSPORT_ITEM_TOOL} {id, repo, answer, source}, answer - та же сводка, source - документ с ответом. Claude Code спросит разрешение в терминале. Отказ инструмента приходит с причиной: поправь и вызови снова. Если у пункта был только пробел по файлу, после правки он уходит из списка сам и закрывать нечего - сводку всё равно дай.`,
    `Затем сам вызови ${LIST_PASSPORT_ITEMS_TOOL} и предложи человеку следующий открытый пункт.`,
    `Пункты указателя неглавных репозиториев (closable: false) закрываются правкой index.md этого репозитория, ${CLOSE_PASSPORT_ITEM_TOOL} для них не вызывай. Заметки списка передай человеку: он решает их в окне «Паспорт проекта».`,
    `Если человек отказался от пункта, пропусти его до конца сессии и больше не предлагай: ${CLOSE_PASSPORT_ITEM_TOOL} для него не вызывай и «Не нужно» не ставь. Если пункт проекту не нужен совсем, подскажи человеку снять его кнопкой «Не нужно» в окне «Паспорт проекта». Когда непропущенных пунктов не осталось, скажи об этом и остановись. На «стоп» закончи обход и кратко назови, что закрыто и что осталось.`,
    'Не коммить и не сливай: как правка дойдёт до PR, решает человек. Если сессия работает в worktree, окно засчитает закрытие после слияния.',
  ].join('\n');
}

interface ProbeRun {
  projectId: string;
  repos: string[];
  // Способность -> репозиторий, в состоянии которого пишется её исход.
  where: Map<string, string>;
  reported: boolean;
}

interface FixRun {
  projectId: string;
  /** Репозиторий строки, у которой нажали «Исправить»: в его дереве сессия пишет и закрывает пункты. */
  repo: string;
}

export interface PassportDeps {
  projects: () => Project[];
  localFile: string;
  emit: (channel: string, payload: unknown) => void;
  claudeAvailable: () => Promise<boolean>;
  /** Дерево сессии в репозитории: её worktree, если она ушла в него, иначе сам репозиторий (D-55); по умолчанию - репозиторий. */
  sessionTree?: (sessionId: number, repo: string) => Promise<string>;
}

/** claude из логин-шелла, как его запускает сессия: наличие ищется тем же способом. */
export async function systemClaudeAvailable(): Promise<boolean> {
  const env = await childEnv();
  return new Promise((resolve) => {
    execFile(loginShell('/bin/sh'), ['-lc', 'command -v claude'], { timeout: 5000, env }, (error) => resolve(!error));
  });
}

export class PassportService {
  private readonly probes = new Map<number, ProbeRun>();
  private readonly notes = new Map<string, string>();
  // Живые вкладки настройки паспорта: в памяти этого запуска, после перезапуска Cyborg пуст (D-58).
  private readonly fixes = new Map<number, FixRun>();

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
    return this.compute(project, (repo) => repo);
  }

  /** Счёт точки и окна: файлы - в деревьях `dirOf` (D-55), состояние - всегда в рабочей копии (D-59). */
  private async compute(project: Project, dirOf: (repo: string) => string): Promise<PassportView> {
    const main = this.mainOf(project);
    const problems: string[] = [];
    const states = new Map<string, PassportState>();
    for (const repo of project.repos) {
      // В worktree незакоммиченного state.json нет (D-59).
      const loaded = loadState(repo);
      states.set(repo, loaded.state);
      if (loaded.problem) problems.push(loaded.problem);
    }
    const notNeeded = new Set((main ? states.get(main) : undefined)?.notNeeded ?? []);
    const capabilities: CapabilityView[] = [];
    for (const group of GROUPS) {
      for (const cap of CAPABILITIES.filter((c) => c.group === group.id)) {
        // Техника проверяется в каждом репозитории, остальное - только в главном (FR-20009).
        const repos = cap.group === 'tech' ? project.repos : main ? [main] : [];
        for (const repo of repos) {
          const state = states.get(repo) ?? emptyState();
          const file = await capFile(dirOf(repo), cap, state);
          if (file.problem) problems.push(file.problem);
          const probe = state.probe?.outcomes[cap.id] ?? null;
          // Закрытие действует, пока файл тот же (D-56): заменяет исход пробы и «Подтвердить», не пробел по файлам; из worktree окно видит его после слияния (D-59).
          const closed = file.hash !== null && state.closed[cap.id]?.hash === file.hash;
          // Найденный проверенный ответ заменяет паспортный файл, принятый человеком - и его метки (D-53).
          const fileWhy = closed || probe?.outcome !== 'found' ? file.all : probe.confirmed ? [] : file.all.filter((r) => r === 'warn' || r === 'approx');
          const reasons: string[] = fileWhy.map((r) => REASON_TEXT[r]);
          if (probe && !closed) {
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
            closed,
          });
        }
      }
    }
    const repos: RepoView[] = [];
    let pointerGaps = 0;
    for (const repo of project.repos) {
      const isMain = repo === main;
      const ok = project.repos.length > 1 && main && !isMain ? await pointerOk(dirOf(repo), dirOf(main)) : null;
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
      fixSession: this.fixSessionOf(project.id),
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
    // Новая проба проверила все способности задания и переоткрывает их закрытия в сессиях во всех репозиториях проекта (D-56).
    const asked = [...run.where.keys()];
    const reopen = (s: PassportState): void => {
      for (const id of asked) delete s.closed[id];
    };
    for (const [repo, outcomes] of byRepo) {
      saveState(repo, (s) => {
        s.probe = { at, outcomes };
        reopen(s);
      });
    }
    for (const repo of run.repos) {
      if (!byRepo.has(repo) && asked.some((id) => id in loadState(repo).state.closed)) saveState(repo, reopen);
    }
    run.reported = true;
    this.deps.emit('passport:changed', { projectId: run.projectId });
    const counts = { found: 0, invented: 0, unknown: 0 };
    for (const outcomes of byRepo.values()) for (const e of Object.values(outcomes)) counts[e.outcome]++;
    return `Исходы записаны: нашёл с источником ${counts.found}, выдумывает ${counts.invented}, не знает ${counts.unknown}. Скажи человеку, что проба закончена, и вкладку можно закрыть.`;
  }

  /** Вкладка закрыта: проба прервана, если итога не было (FR-20006); вкладка настройки больше не держит проект (D-57). */
  sessionEnded(sessionId: number): void {
    const run = this.probes.get(sessionId);
    const fix = this.fixes.get(sessionId);
    if (fix) {
      this.fixes.delete(sessionId);
      this.deps.emit('passport:changed', { projectId: fix.projectId });
    }
    if (!run) return;
    this.probes.delete(sessionId);
    if (!run.reported) this.notes.set(run.projectId, 'Проба прервана: вкладку закрыли до итога. Прежние исходы на месте.');
    this.deps.emit('passport:changed', { projectId: run.projectId });
  }

  /** Номер живой вкладки настройки паспорта проекта: она одна на проект (D-57). */
  private fixSessionOf(projectId: string): number | null {
    for (const [id, run] of this.fixes) if (run.projectId === projectId) return id;
    return null;
  }

  /** Синхронный запрет второй вкладки настройки: вызывается без await перед созданием сессии, чтобы два быстрых нажатия не открыли две. */
  ensureNoFix(projectId: string): void {
    if (this.fixSessionOf(projectId) !== null) throw new Error('Сессия настройки паспорта проекта уже открыта');
  }

  registerFix(sessionId: number, run: FixRun): void {
    this.fixes.set(sessionId, run);
    this.deps.emit('passport:changed', { projectId: run.projectId });
  }

  isFix(sessionId: number): boolean {
    return this.fixes.has(sessionId);
  }

  /** Каталог, добавочные каталоги и начальный промпт вкладки настройки; способность и репозиторий проверяются по проекту. */
  async prepareFix(projectId: unknown, capability: unknown, repo: unknown): Promise<{ cwd: string; addDirs: string[]; prompt: string; run: FixRun }> {
    const project = this.project(projectId);
    if (!project) throw new Error('Проект не найден');
    if (typeof capability !== 'string' || typeof repo !== 'string') throw new Error('Некорректные аргументы исправления');
    const cap = capabilityById(capability);
    if (!cap || !project.repos.includes(repo)) throw new Error('Некорректные аргументы исправления');
    if (!(await this.deps.claudeAvailable())) throw new Error(NO_CLAUDE_TEXT);
    this.ensureNoFix(project.id);
    return { cwd: repo, addDirs: project.repos.filter((r) => r !== repo), prompt: fixPrompt(cap, repo), run: { projectId: project.id, repo } };
  }

  // Без await между запретом, созданием сессии и регистрацией: два быстрых нажатия не открывают две вкладки настройки (D-57).
  async startFix(projectId: unknown, capability: unknown, repo: unknown, create: (fix: { cwd: string; addDirs: string[]; prompt: string }) => number): Promise<number> {
    const fix = await this.prepareFix(projectId, capability, repo);
    this.ensureNoFix(fix.run.projectId);
    const id = create(fix);
    this.registerFix(id, fix.run);
    return id;
  }

  private async fixContext(sessionId: number): Promise<{ project: Project; fix: FixRun }> {
    const fix = this.fixes.get(sessionId);
    if (!fix) throw new Error('Эта сессия не ведёт настройку паспорта');
    const project = this.project(fix.projectId);
    if (!project) throw new Error('Проект не найден');
    return { project, fix };
  }

  private async treeOf(sessionId: number, fix: FixRun): Promise<{ tree: string; dirOf: (repo: string) => string }> {
    const tree = await (this.deps.sessionTree?.(sessionId, fix.repo) ?? Promise.resolve(fix.repo));
    // Дерево сессии - только у репозитория строки: worktree уходит из одного репозитория.
    return { tree, dirOf: (repo) => (repo === fix.repo ? tree : repo) };
  }

  /** list_passport_items: всё, что считает точка, по дереву сессии (D-54, D-55); пропуски человека Cyborg не хранит (D-54). */
  async items(sessionId: number): Promise<string> {
    const { project, fix } = await this.fixContext(sessionId);
    const { tree, dirOf } = await this.treeOf(sessionId, fix);
    const view = await this.compute(project, dirOf);
    const main = view.mainRepo;
    const notes: string[] = [];
    if (project.repos.length > 1 && !main) notes.push('Главный репозиторий не отмечен: проектные способности не проверяются. Скажи человеку отметить главный в окне «Паспорт проекта».');
    for (const problem of view.problems) notes.push(`${problem}. Скажи человеку исправить файл: пока он повреждён, состояние не читается и не пишется.`);
    if (view.probing) notes.push('Идёт проба проекта: закрытие пунктов отказывает до её итога.');
    const items = view.capabilities
      .filter((c) => c.gap)
      .map((c) => ({ id: c.id, name: c.name, question: c.question, repo: c.repo, reasons: c.reasons, semantic: c.semantic, closable: true }));
    const pointers = view.repos
      .filter((r) => r.pointerOk === false)
      .map((r) => ({ repo: r.repo, closable: false, text: `в ${PASSPORT_DIR}/${INDEX_FILE} нет ссылки на ${INDEX_FILE} главного репозитория ${main}: поправь файл, пункт закроется проверкой файлов` }));
    if (!items.length && !pointers.length) return ['Открытых пунктов нет.', ...notes].join('\n');
    return JSON.stringify({ tree, items, pointers, notes }, null, 2);
  }

  /** close_passport_item: закрытие после согласия человека словами; любая неудача - отказ с причиной и ничего не записано (D-55, D-56). */
  async close(sessionId: number, value: unknown): Promise<string> {
    const { project, fix } = await this.fixContext(sessionId);
    const valid = validateCloseItem(value, project.repos);
    if (typeof valid === 'string') throw new Error(valid);
    const cap = capabilityById(valid.id)!;
    const main = this.mainOf(project);
    if (main && loadState(main).state.notNeeded.includes(cap.id)) throw new Error('Способность снята «Не нужно»: вернуть её может только человек кнопкой «Нужно» в окне');
    if (cap.group !== 'tech') {
      if (!main) throw new Error(NEED_MAIN_TEXT);
      if (valid.repo !== main) throw new Error(`${cap.id} проверяется в главном репозитории ${main}`);
    }
    if (this.isProbing(project.id)) throw new Error('Идёт проба проекта: закрой пункт после её итога');
    const { tree, dirOf } = await this.treeOf(sessionId, fix);
    const row = (await this.compute(project, dirOf)).capabilities.find((c) => c.id === cap.id && c.repo === valid.repo);
    if (!row) throw new Error(`${cap.id} в репозитории ${valid.repo} не проверяется`);
    if (row.closed) throw new Error('Пункт уже закрыт');
    if (!row.gap) throw new Error('У пункта нет пробела: закрывать нечего');
    // Файл - дерева сессии, состояние - рабочей копии (D-59); полный перечень причин, без послабления D-53.
    const file = await capFile(dirOf(valid.repo), cap, loadState(valid.repo).state);
    if (file.all.length) throw new Error(`У файла ${PASSPORT_DIR}/${cap.file} пробел: ${file.all.map((r) => REASON_TEXT[r]).join(', ')}. Поправь файл и вызови снова`);
    if (!sourceResolves(valid.source, project.repos.map(dirOf))) {
      throw new Error(`Источник ${valid.source} не найден в дереве ${tree}: путь от корня репозитория, строка не за концом файла`);
    }
    const entry: ClosedEntry = { hash: file.hash!, answer: valid.answer, source: valid.source, at: new Date().toISOString() };
    saveState(valid.repo, (s) => {
      s.closed[cap.id] = entry;
    });
    this.deps.emit('passport:changed', { projectId: project.id });
    const left = (await this.compute(project, dirOf)).count;
    return `Пункт «${cap.name}» закрыт: отметка с хешем файла записана в ${path.join(valid.repo, PASSPORT_DIR, STATE_FILE)} рабочей копии (в PR она не едет). Окно и точка засчитают закрытие, когда файл ${PASSPORT_DIR}/${cap.file} в рабочей копии совпадёт с файлом этого дерева (после слияния). Открытых пунктов: ${left}. Вызови ${LIST_PASSPORT_ITEMS_TOOL} и предложи человеку следующий.`;
  }
}
