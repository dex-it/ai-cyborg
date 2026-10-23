import fs from 'node:fs';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// События хуков содержат cwd и имена инструментов: каталог и файлы закрыты от других пользователей машины.
export function prepareEventsDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  // mode у mkdir не действует на существующий каталог и урезается umask.
  fs.chmodSync(dir, DIR_MODE);
}

export function createEventsFile(file: string): void {
  const fd = fs.openSync(file, 'w', FILE_MODE);
  try {
    // mode у open не действует на существующий файл и урезается umask.
    fs.fchmodSync(fd, FILE_MODE);
  } finally {
    fs.closeSync(fd);
  }
}
