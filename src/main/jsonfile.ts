import fs from 'node:fs';

/** Запись через временный файл и rename: оборванная запись не оставляет полупустой файл; mode (0o600 для секретов) применяется chmod до rename, потому что временный файл мог остаться от прошлой записи. */
export function writeJsonAtomic(file: string, data: unknown, mode?: number): void {
  // pid в имени: два инстанса пишут общие файлы userData и не делят временный.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), mode === undefined ? undefined : { mode });
  if (mode !== undefined) fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

/** Метка UTC для имени копии: 20261026T081530. */
export function utcStamp(date: Date): string {
  return date.toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '');
}

/** Копия байт повреждённого файла рядом с ним; существующие копии не перезаписываются. */
export function keepCorruptCopy(file: string, raw: Buffer, now: Date, mode?: number): string {
  const base = `${file}.corrupt-${utcStamp(now)}`;
  for (let n = 0; ; n++) {
    const target = n === 0 ? base : `${base}-${n}`;
    try {
      fs.writeFileSync(target, raw, { flag: 'wx', ...(mode === undefined ? {} : { mode }) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    return target;
  }
}
