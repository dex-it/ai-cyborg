export interface RunApi {
  runnable(file: string): Promise<boolean>;
  runFile(file: string): Promise<void>;
}

export interface RunButton {
  title: string;
  addEventListener(type: 'click', listener: () => void): void;
}

export const RUN_LABEL = '▶ Запустить в терминале';

/** Кнопка только в локальной сессии и только по ответу главного процесса; отказ канала кнопку не показывает. */
export function addRunButton<B extends RunButton>(
  file: string,
  remote: boolean,
  api: RunApi,
  reveal: { before(button: B): void },
  make: (label: string) => B,
): void {
  if (remote) return;
  const run = make(RUN_LABEL);
  run.title = 'Запустить файл в системном терминале';
  run.addEventListener('click', () => void api.runFile(file));
  api.runnable(file).then(
    (ok) => {
      if (ok) reveal.before(run);
    },
    () => undefined,
  );
}
