import type { DirEntry } from '../main/files';

/** Чтение файлов и git-состояния дерева: у локальной сессии - главный процесс, у удалённой - демон на хосте (ADR-0020). */
export interface FsPort {
  list(dir: string): Promise<DirEntry[]>;
  read(file: string): Promise<{ content?: string; error?: string }>;
  head(file: string): Promise<string | null>;
  branch(root: string): Promise<string | null>;
  status(root: string): Promise<Record<string, string>>;
}

export const localFs: FsPort = {
  list: (dir) => window.cyborg.listDir(dir),
  read: (file) => window.cyborg.readFile(file),
  head: (file) => window.cyborg.gitHeadContent(file),
  branch: (root) => window.cyborg.gitBranch(root),
  status: (root) => window.cyborg.gitStatus(root),
};

export function remoteFs(id: number): FsPort {
  const call = <T>(op: 'list' | 'read' | 'branch' | 'status' | 'head', path: string): Promise<T> => window.cyborg.remoteFs(id, op, path) as Promise<T>;
  return {
    list: (dir) => call('list', dir),
    read: (file) => call<{ content?: string; error?: string }>('read', file).catch((error: Error) => ({ error: error.message })),
    head: (file) => call<string | null>('head', file).catch(() => null),
    branch: (root) => call<string | null>('branch', root).catch(() => null),
    status: (root) => call<Record<string, string>>('status', root).catch(() => ({})),
  };
}
