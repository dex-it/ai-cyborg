import type { ProjectsProblem } from '../main/projects';

/** Замечание о файле воркспейса (ADR-0014, п.4): что случилось, где исходные байты, что делать; называет фактический путь файла. */
export function projectsProblemText(problem: ProjectsProblem, file: string | null): string {
  const where = file ?? 'файл воркспейса';
  if (problem.kind === 'unreadable') {
    return `Файл проектов не прочитан (${problem.detail}). Проекты не загружены, и пока файл недоступен, запись в него отключена: он не будет затёрт. Исправьте доступ к файлу ${where} и перезапустите Cyborg.`;
  }
  return `Файл проектов повреждён (${problem.detail}), проекты не загружены. Исходное содержимое сохранено:\n${problem.copy}\nЧтобы вернуть проекты: закройте Cyborg, исправьте копию и положите её на место ${where}.`;
}

const FORBIDDEN_IN_NAME = /[/\\:*?"<>|\u0000-\u001f]/g;

/** Имя файла по умолчанию для воркспейса: `<имя>.cyborg.json`; имя из одних запрещённых символов дают пустую строку. */
export function defaultWorkspaceFile(name: string, home: string, sep: string): string {
  const slug = name.replace(FORBIDDEN_IN_NAME, '').trim();
  return slug ? `${home}${sep}${slug}.cyborg.json` : '';
}

/** Каталог выбран кнопкой «Папка…»: имя файла остаётся, меняется только папка. */
export function withDirectory(file: string, dir: string, sep: string): string {
  const name = file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1);
  return `${dir.replace(/[/\\]+$/, '')}${sep}${name}`;
}

/** Поле файла окна создания: каталог хранится отдельно, чтобы выбор «Папка…» не считался правкой файла. */
export interface FileField {
  value: string;
  edited: boolean;
  dir: string;
}

const FALLBACK_FILE = 'workspace.cyborg.json';

export const initialFileField = (home: string): FileField => ({ value: '', edited: false, dir: home });

/** Путь следует за именем, пока поле файла не правили руками. */
export function fileAfterName(field: FileField, name: string, sep: string): FileField {
  return field.edited ? field : { ...field, value: defaultWorkspaceFile(name, field.dir, sep) };
}

export const fileAfterEdit = (field: FileField, value: string): FileField => ({ ...field, value, edited: true });

/** «Папка…» меняет только каталог: имя файла следует за именем воркспейса, пока его не правили. */
export function fileAfterDir(field: FileField, name: string, dir: string, sep: string): FileField {
  const fromName = defaultWorkspaceFile(name, dir, sep);
  const value = field.edited && field.value ? withDirectory(field.value, dir, sep) : fromName || withDirectory(FALLBACK_FILE, dir, sep);
  return { value, edited: field.edited, dir };
}

export interface WorkspaceDraft {
  name: string;
  file: string;
  projectName: string;
  repos: string[];
}

/** «Создать» доступна, когда есть имя, файл, название проекта и хотя бы один репозиторий. */
export function canCreateWorkspace(draft: WorkspaceDraft): boolean {
  return !!(draft.name.trim() && draft.file.trim() && draft.projectName.trim() && draft.repos.length);
}
