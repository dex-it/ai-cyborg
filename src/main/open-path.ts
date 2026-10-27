import fs from 'node:fs';
import path from 'node:path';

/** Открытие этих файлов системой - запуск программы, а не просмотр. */
const LAUNCHERS = new Set([
  ...['.app', '.command', '.tool', '.terminal', '.workflow', '.scpt', '.pkg', '.mpkg', '.dmg', '.webloc', '.inetloc', '.fileloc'],
  ...['.desktop', '.appimage', '.run', '.sh', '.jar'],
  ...['.exe', '.bat', '.cmd', '.com', '.msi', '.scr', '.ps1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.hta', '.lnk', '.url', '.reg', '.msc', '.cpl'],
]);

/** Интерфейсу не доверяют: путь из вывода сессии проверяется здесь - абсолютный или от `~`, существует и не запускается. */
export function openablePath(value: unknown, home: string): { path: string } | { error: string } {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f]/.test(value)) return { error: 'Некорректный путь' };
  const expanded = value === '~' || value.startsWith('~/') ? path.join(home, value.slice(1)) : value;
  if (!path.isAbsolute(expanded)) return { error: `Путь не абсолютный: ${value}` };
  let target: string;
  let stat: fs.Stats;
  try {
    // Ссылка shot.png может вести на .desktop или .app: проверяется настоящий файл.
    target = fs.realpathSync(path.resolve(expanded));
    stat = fs.statSync(target);
  } catch {
    return { error: `Нет такого файла: ${path.resolve(expanded)}` };
  }
  if (LAUNCHERS.has(path.extname(target).toLowerCase()) || (stat.isFile() && (stat.mode & 0o111) !== 0)) {
    return { error: `Исполняемый файл не открывается по клику: ${target}` };
  }
  return { path: target };
}

/** Только http(s): иные схемы (javascript:, file:, ссылки на приложения) браузеру системы не отдаются. */
export function webUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 8192) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}
