import type { TrackerSettings, TrackersStatus } from '../main/trackers';
import { byId, el } from './dom';
import { authLines } from './task-model';

const api = window.cyborg;

/** Раздел «Источники задач» диалога проекта: галочки живут в черновике диалога, вход проверяется при каждом открытии. */
export function initSourcesSection(): { open(flags: TrackerSettings): void; read(): TrackerSettings; close(): void } {
  const boxes = { github: byId<HTMLInputElement>('project-github'), gitlab: byId<HTMLInputElement>('project-gitlab') };
  const statusEls = { github: byId('project-github-status'), gitlab: byId('project-gitlab-status') };
  let status: TrackersStatus | null = null;
  let failure = '';
  let openToken = 0;

  function renderStatus(): void {
    for (const kind of ['github', 'gitlab'] as const) {
      const lines = failure ? [`Проверка не удалась: ${failure}`] : status ? authLines(kind, boxes[kind].checked, status) : ['проверка…'];
      statusEls[kind].replaceChildren(...lines.map((line) => el('div', '', line)));
    }
  }

  for (const box of Object.values(boxes)) box.addEventListener('change', renderStatus);

  return {
    open(flags: TrackerSettings): void {
      const token = ++openToken;
      boxes.github.checked = flags.github;
      boxes.gitlab.checked = flags.gitlab;
      status = null;
      failure = '';
      renderStatus();
      // Диалог открыт сразу, проверка входа (два процесса) дописывается, когда придёт.
      void api.trackersStatus().then(
        (result) => {
          if (token !== openToken) return;
          status = result;
          renderStatus();
        },
        (error: Error) => {
          if (token !== openToken) return;
          failure = error.message;
          renderStatus();
        },
      );
    },
    read: () => ({ github: boxes.github.checked, gitlab: boxes.gitlab.checked }),
    close(): void {
      openToken++;
    },
  };
}
