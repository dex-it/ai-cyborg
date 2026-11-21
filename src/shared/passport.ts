/** Паспорт проекта (фича 20): перечень способностей, виды данных окна и чистые правила пробелов - общие для главного процесса и интерфейса. */

export type GroupId = 'product' | 'tech' | 'work' | 'upkeep';

/** Порядок групп - порядок показа (FR-20005, D-03). */
export const GROUPS: { id: GroupId; title: string }[] = [
  { id: 'product', title: 'Продукт' },
  { id: 'tech', title: 'Техника' },
  { id: 'work', title: 'Работа' },
  { id: 'upkeep', title: 'Актуализация' },
];

export interface Capability {
  id: string;
  group: GroupId;
  name: string;
  question: string;
  file: string;
  /** Ответ знает только человек: найденное пробой ждёт подтверждения (FR-20007). */
  semantic: boolean;
}

/** Двенадцать способностей и их файлы в `.cyborg/passport/` (FR-20001). */
export const CAPABILITIES: Capability[] = [
  { id: 'why', group: 'product', name: 'Зачем и для кого', question: 'Зачем продукт и для кого он?', file: 'why.md', semantic: true },
  { id: 'behavior', group: 'product', name: 'Ожидаемое поведение', question: 'Как продукт должен вести себя для пользователя?', file: 'behavior.md', semantic: false },
  { id: 'done', group: 'product', name: 'Что значит «готово»', question: 'По чему судят, что работа готова?', file: 'done.md', semantic: true },
  { id: 'domain', group: 'product', name: 'Домен и термины', question: 'Какие понятия и термины предметной области использует проект?', file: 'domain.md', semantic: false },
  { id: 'architecture', group: 'tech', name: 'Архитектура', question: 'Как проект устроен и почему так?', file: 'architecture.md', semantic: false },
  { id: 'code-principles', group: 'tech', name: 'Принципы кода', question: 'По каким принципам в проекте пишут и ревьюят код?', file: 'code-principles.md', semantic: false },
  { id: 'decisions', group: 'tech', name: 'Технические решения', question: 'Где записаны технические решения и их причины?', file: 'decisions.md', semantic: false },
  { id: 'autonomy', group: 'work', name: 'Границы автономии', question: 'Что агент делает сам, а что только по слову человека?', file: 'autonomy.md', semantic: true },
  { id: 'delivery', group: 'work', name: 'Как сдаётся работа', question: 'Как работа доходит до слияния: ветки, проверки, PR?', file: 'delivery.md', semantic: false },
  { id: 'environment', group: 'work', name: 'Грабли среды', question: 'Какие грабли среды известны: сборка, окружение, доступы?', file: 'environment.md', semantic: true },
  { id: 'escalation', group: 'work', name: 'Кому и когда эскалировать', question: 'Кому и когда агент задаёт вопрос или сообщает о проблеме?', file: 'escalation.md', semantic: true },
  { id: 'upkeep', group: 'upkeep', name: 'Актуализация', question: 'Кто и как поддерживает паспорт и документы актуальными?', file: 'upkeep.md', semantic: true },
];

export const capabilityById = (id: string): Capability | undefined => CAPABILITIES.find((c) => c.id === id);

export const PASSPORT_DIR = '.cyborg/passport';
export const STATE_FILE = 'state.json';
export const INDEX_FILE = 'index.md';

export type ProbeOutcome = 'found' | 'invented' | 'unknown';

export const OUTCOME_TEXT: Record<ProbeOutcome, string> = { found: 'нашёл с источником', invented: 'выдумывает', unknown: 'не знает' };

/** Причины пробела по файлу словами (FR-20002). */
export const REASON_TEXT = {
  missing: 'файла нет',
  empty: 'файл пуст',
  warn: 'есть ⚠',
  approx: '≈ не подтверждено',
  nolink: 'нет ссылки на документ проекта',
} as const;
export type FileReason = keyof typeof REASON_TEXT;

/** Метки «⚠» и «≈» в тексте файла; «≈» в цитате кода тоже метка (D-32). */
export function fileReasons(content: string | null, approxConfirmed: boolean, hasDocLink: boolean): FileReason[] {
  if (content === null) return ['missing'];
  if (!content.trim()) return ['empty'];
  const out: FileReason[] = [];
  if (content.includes('⚠')) out.push('warn');
  if (content.includes('≈') && !approxConfirmed) out.push('approx');
  if (!hasDocLink) out.push('nolink');
  return out;
}

/** Исход одной способности по пробе, как он записан в состоянии паспорта. */
export interface ProbeEntry {
  outcome: ProbeOutcome;
  /** Ответ агента: недоверенный текст, в окно идёт текстом (NFR-20002). */
  answer: string;
  source: string;
  /** Смысловая способность подтверждена человеком (FR-20007); новая проба снимает. */
  confirmed?: boolean;
}

/** Состояние паспорта в репозитории (D-46): ключи записываются отсортированными, чтобы слияние веток не конфликтовало зря. */
export interface PassportState {
  version: 1;
  probe: { at: string; outcomes: Record<string, ProbeEntry> } | null;
  /** Способность -> хеш файла на момент подтверждения «≈»; изменился файл - подтверждение снято (FR-20002). */
  approxConfirmed: Record<string, string>;
  notNeeded: string[];
}

export const emptyState = (): PassportState => ({ version: 1, probe: null, approxConfirmed: {}, notNeeded: [] });

export interface CapabilityView {
  id: string;
  group: GroupId;
  name: string;
  question: string;
  file: string;
  /** Репозиторий, в котором способность проверена. */
  repo: string;
  notNeeded: boolean;
  fileReasons: FileReason[];
  hasApprox: boolean;
  probe: ProbeEntry | null;
  /** Причины пробела словами; пусто - пробела нет. */
  reasons: string[];
  gap: boolean;
  semantic: boolean;
}

export interface RepoView {
  repo: string;
  main: boolean;
  /** Только у неглавного репозитория проекта из нескольких: указатель на главный по FR-20009. */
  pointerOk: boolean | null;
}

export type DotLevel = 'unchecked' | 'gaps' | 'clear';

export interface PassportView {
  projectId: string;
  level: DotLevel;
  count: number;
  repos: RepoView[];
  /** Главный репозиторий; null - проект из нескольких репозиториев без отметки. */
  mainRepo: string | null;
  capabilities: CapabilityView[];
  /** Проба идёт: кнопки пробы отключены (FR-20006). */
  probing: boolean;
  /** Почему проба и исправление недоступны; null - доступны (FR-20013). */
  agentUnavailable: string | null;
  /** Замечания чтения: повреждённое состояние и тому подобное, словами. */
  problems: string[];
  /** Чем кончилась последняя проба, если без исходов (прервана, ответ не разобран). */
  probeNote: string | null;
}

/** Текст точки: число (от 100 - «99+»), «✓», «–» или «…» (FR-20004). */
export function dotText(level: DotLevel | 'checking', count: number): string {
  if (level === 'checking') return '…';
  if (level === 'unchecked') return '–';
  if (level === 'clear') return '✓';
  return count >= 100 ? '99+' : String(count);
}

export function dotTitle(level: DotLevel | 'checking', count: number): string {
  if (level === 'checking') return 'Проверка паспорта…';
  if (level === 'unchecked') return 'Паспорт не проверен';
  if (level === 'clear') return 'Паспорт проекта: пробелов нет';
  return `Паспорт проекта: ${count} ${plural(count)}`;
}

const plural = (n: number): string => {
  const m = n % 100;
  if (m >= 11 && m <= 14) return 'пробелов';
  const d = n % 10;
  return d === 1 ? 'пробел' : d >= 2 && d <= 4 ? 'пробела' : 'пробелов';
};
