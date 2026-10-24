import type { Task } from '../main/trackers';
import { el } from './dom';

const api = window.cyborg;

/** Шапка сессии задачи: номер и заголовок всегда на виду, описание раскрывается кликом и грузится один раз. */
export function taskHeader(task: Task, onResize: () => void): HTMLElement {
  const ref = { kind: task.kind, host: task.host, path: task.path, number: task.number };
  const root = el('div', 'session-task');
  const line = el('div', 'session-task-line');
  const twisty = el('span', 'twisty', '▸');
  const number = el('button', 'session-task-number', `#${task.number}`);
  number.title = 'Открыть задачу в браузере';
  number.addEventListener('click', (event) => {
    event.stopPropagation();
    void api.openTask(ref);
  });
  const title = el('span', 'session-task-title', task.title);
  line.title = task.title;
  line.append(twisty, number, title);
  const body = el('div', 'task-description');
  body.hidden = true;
  root.append(line, body);

  let loaded = false;
  line.addEventListener('click', () => {
    body.hidden = !body.hidden;
    twisty.textContent = body.hidden ? '▸' : '▾';
    if (!body.hidden && !loaded) {
      loaded = true;
      body.textContent = 'Загрузка…';
      api
        .sessionTaskDetails(ref)
        .catch((error: Error) => ({ error: error.message }))
        .then((res) => {
          if ('error' in res) {
            loaded = false;
            body.textContent = `Описание не загружено: ${res.error}`;
          } else body.textContent = res.description.trim() || 'Описания нет';
          onResize();
        });
    }
    onResize();
  });
  return root;
}
