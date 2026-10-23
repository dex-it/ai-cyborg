import type { TrackerSettings, TrackersStatus } from '../main/trackers';
import { byId, el } from './dom';
import { authLines } from './task-model';

const api = window.cyborg;

/** Окно настроек трекеров. onSaved вызывается после сохранения галочек. */
export function initSettings(onSaved: () => void): { open(): void } {
  const dialog = byId<HTMLDialogElement>('settings-dialog');
  const boxes = { github: byId<HTMLInputElement>('settings-github'), gitlab: byId<HTMLInputElement>('settings-gitlab') };
  const statusEls = { github: byId('settings-github-status'), gitlab: byId('settings-gitlab-status') };
  let status: TrackersStatus | null = null;
  let failure = '';
  let openToken = 0;

  function renderStatus(): void {
    for (const kind of ['github', 'gitlab'] as const) {
      const lines = failure
        ? [`Проверка не удалась: ${failure}`]
        : status
          ? authLines(kind, boxes[kind].checked, status)
          : ['проверка…'];
      statusEls[kind].replaceChildren(...lines.map((line) => el('div', '', line)));
    }
  }

  for (const box of Object.values(boxes)) box.addEventListener('change', renderStatus);

  dialog.addEventListener('close', () => {
    openToken++;
    if (dialog.returnValue !== 'save') return;
    const next: TrackerSettings = { github: boxes.github.checked, gitlab: boxes.gitlab.checked };
    void api.saveTrackerSettings(next).then(onSaved, (error: Error) => {
      alert(`Не удалось сохранить настройки трекеров: ${error.message}`);
    });
  });

  return {
    open(): void {
      const token = ++openToken;
      void api.loadTrackerSettings().then((settings) => {
        if (token !== openToken) return;
        boxes.github.checked = settings.github;
        boxes.gitlab.checked = settings.gitlab;
        status = null;
        failure = '';
        renderStatus();
        dialog.returnValue = '';
        dialog.showModal();
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
      });
    },
  };
}
