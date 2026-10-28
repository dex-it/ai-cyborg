/**
 * Проверка аргументов каналов `session:input`, `session:resize` и `session:kill`. Граница процессов типов не знает:
 * интерфейс (и скрипт, попавший в страницу) шлёт что угодно, а `pty.write` и `pty.resize` на нетипичном значении бросают
 * исключение в главном процессе (окно «A JavaScript error occurred in the main process»).
 */

/** Номера сессий выдаёт счётчик главного процесса с 1; верхний предел - безопасные целые, чтобы ключ Map был точным. */
export const MAX_SESSION_ID = Number.MAX_SAFE_INTEGER;

/**
 * Предел одного сообщения ввода, в UTF-16 единицах строки JS. Вставка из буфера приходит от xterm одним сообщением
 * (в режиме bracketed paste - целиком), типичные большие вставки - логи и дифы до сотен килобайт. 1 МиБ даёт пятикратный запас
 * над вставкой 200 КБ и ограничивает худший случай: строка в 5 МБ без ограничения целиком копируется в буфер записи pty
 * и забивает главный процесс. Больше предела - сообщение отбрасывается целиком, а не обрезается: обрезанная вставка
 * (кусок команды без хвоста) опаснее, чем отсутствующая.
 */
export const MAX_INPUT_LENGTH = 1024 * 1024;

/**
 * Размер терминала в ячейках. Нижняя граница - 1 (нулевой размер pty не принимает). Верхняя - 1000: реальные окна дают
 * 80..400 столбцов и 24..120 строк, 1000 - с большим запасом; ioctl TIOCSWINSZ хранит размер в 16 битах, и значения
 * порядка 1e9 его переполнили бы.
 */
export const MIN_TERMINAL_SIZE = 1;
export const MAX_TERMINAL_SIZE = 1000;

export interface ResizeArgs {
  id: number;
  cols: number;
  rows: number;
}

/** Номер сессии: целое от 0 до безопасного предела. Иное - null. */
export function validateSessionId(id: unknown): number | null {
  return typeof id === 'number' && Number.isInteger(id) && id >= 0 && id <= MAX_SESSION_ID ? id : null;
}

const validSize = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= MIN_TERMINAL_SIZE && value <= MAX_TERMINAL_SIZE;

/** Ввод в сессию: номер и строка не длиннее предела. Пустая строка допустима (ничего не пишет). Иное - null. */
export function validateInputArgs(id: unknown, data: unknown): { id: number; data: string } | null {
  const valid = validateSessionId(id);
  if (valid === null || typeof data !== 'string' || data.length > MAX_INPUT_LENGTH) return null;
  return { id: valid, data };
}

/** Размер терминала сессии: номер и два целых 1..1000. Иное - null. */
export function validateResizeArgs(id: unknown, cols: unknown, rows: unknown): ResizeArgs | null {
  const valid = validateSessionId(id);
  if (valid === null || !validSize(cols) || !validSize(rows)) return null;
  return { id: valid, cols, rows };
}
