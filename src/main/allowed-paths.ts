import fs from 'node:fs';
import path from 'node:path';
import type { DirEntry } from './files';

const OUTSIDE = 'Путь вне репозиториев проектов и каталогов сессий';

/** Путь лежит в каталоге или совпадает с ним: границей служит сегмент пути, поэтому `/repo-evil` не внутри `/repo`. */
export function isInside(child: string, root: string): boolean {
  const rel = path.relative(root, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Путь из интерфейса принимается, только если он абсолютный и без сегментов `..`: ядро раскрывает `..` после символьной
 * ссылки иначе, чем нормализация строки, и `/repo/link/..` по строке лежал бы в `/repo`, а на деле - где угодно.
 */
function isPlainPath(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && !value.includes('\0') && path.isAbsolute(value) && !value.split(/[\\/]/).includes('..');
}

function realpath(dir: string): string | null {
  try {
    return fs.realpathSync(dir);
  } catch {
    return null;
  }
}

/**
 * Каталоги, к которым главный процесс отвечает интерфейсу (ADR-0002, п.5): репозитории проектов, каталоги и cwd живых
 * сессий и каталоги, выданные явно (`grant`). Проверка строковая, символьные ссылки внутри каталога не раскрываются: дерево
 * и git ходят по ним так же, как сам репозиторий. Иначе написанный путь (`/tmp` и `/private/tmp`, регистр на macOS)
 * сравнивается по физическим путям.
 */
export class AllowedPaths {
  private readonly granted = new Set<string>();

  constructor(private readonly roots: () => string[]) {}

  /** Выдать каталог до конца работы приложения. Не абсолютный путь не выдаётся. */
  grant(dir: unknown): void {
    if (isPlainPath(dir)) this.granted.add(path.resolve(dir));
  }

  allows(value: unknown): value is string {
    if (!isPlainPath(value)) return false;
    const roots = [...this.roots().filter(isPlainPath), ...this.granted];
    if (roots.some((root) => isInside(value, root))) return true;
    const real = realpath(value);
    if (real === null) return false;
    return roots.some((root) => {
      const realRoot = realpath(root);
      return realRoot !== null && isInside(real, realRoot);
    });
  }

  /** Отказ для канала: путь вне разрешённых каталогов (в том же стиле ошибок, что у соседних каналов). */
  assert(value: unknown): asserts value is string {
    if (!this.allows(value)) throw new Error(OUTSIDE);
  }
}

export interface PathHandlerDeps {
  allowed: AllowedPaths;
  /** Каталоги и cwd живых сессий. */
  liveDirs: () => string[];
  listDir: (dir: string) => Promise<DirEntry[]>;
  readTextFile: (file: string) => Promise<{ content?: string; error?: string }>;
  gitRoot: (dir: string) => Promise<string | null>;
  gitBranch: (root: string) => Promise<string | null>;
  gitStatus: (root: string) => Promise<Record<string, string>>;
  gitHeadContent: (file: string) => Promise<string | null>;
}

/** Обработчики каналов fs:* и git:* над путём из интерфейса: каждый сперва проверяет путь. */
export function createPathHandlers(deps: PathHandlerDeps) {
  const allowed: AllowedPaths = deps.allowed;
  return {
    list(dir: unknown) {
      allowed.assert(dir);
      return deps.listDir(dir);
    },
    read(file: unknown) {
      allowed.assert(file);
      return deps.readTextFile(file);
    },
    /** Корень каталога сессии (в том числе ушедшей из репозиториев проекта) разрешается тут же: дерево покажет его. */
    async root(dir: unknown) {
      allowed.assert(dir);
      const root = await deps.gitRoot(dir);
      if (root !== null && deps.liveDirs().includes(dir)) allowed.grant(root);
      return root;
    },
    branch(root: unknown) {
      allowed.assert(root);
      return deps.gitBranch(root);
    },
    status(root: unknown) {
      allowed.assert(root);
      return deps.gitStatus(root);
    },
    headContent(file: unknown) {
      allowed.assert(file);
      return deps.gitHeadContent(file);
    },
    /** Каталог, выбранный пользователем в диалоге: до сохранения проекта интерфейс спрашивает про него git. */
    picked(dir: string | null): string | null {
      allowed.grant(dir);
      return dir;
    },
  };
}
