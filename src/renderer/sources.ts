import type { JiraSettings } from '../main/projects';
import type { JiraStatus } from '../main/jira';
import type { TrackerSettings, TrackersStatus } from '../main/trackers';
import { byId, el } from './dom';
import { authLines } from './task-model';

const api = window.cyborg;

/** Раздел «Источники задач» диалога проекта: галочки живут в черновике диалога, вход проверяется при каждом открытии. */
export function initSourcesSection(): {
  open(flags: TrackerSettings, jira?: JiraSettings): void;
  read(): { trackers: TrackerSettings; jira: JiraSettings };
  close(): void;
} {
  const boxes = { github: byId<HTMLInputElement>('project-github'), gitlab: byId<HTMLInputElement>('project-gitlab') };
  const statusEls = { github: byId('project-github-status'), gitlab: byId('project-gitlab-status') };
  const jiraBox = byId<HTMLInputElement>('project-jira');
  const jiraKey = byId<HTMLInputElement>('project-jira-key');
  const jiraKeyRow = byId('project-jira-key-row');
  const jiraStatusEl = byId('project-jira-status');
  let jiraStatus: JiraStatus | null = null;
  let status: TrackersStatus | null = null;
  let failure = '';
  let openToken = 0;

  function renderStatus(): void {
    for (const kind of ['github', 'gitlab'] as const) {
      const lines = failure ? [`Проверка не удалась: ${failure}`] : status ? authLines(kind, boxes[kind].checked, status) : ['проверка…'];
      statusEls[kind].replaceChildren(...lines.map((line) => el('div', '', line)));
    }
  }

  const jiraLine = (): string => {
    if (!jiraStatus) return 'проверка…';
    return jiraStatus.state === 'ready' ? `вход выполнен: ${jiraStatus.login || 'jira-cli'}${jiraStatus.version ? ` (jira-cli ${jiraStatus.version})` : ''}` : jiraStatus.message;
  };

  function renderJira(): void {
    jiraKeyRow.hidden = !jiraBox.checked;
    jiraStatusEl.replaceChildren(el('div', '', jiraLine()));
  }

  for (const box of Object.values(boxes)) box.addEventListener('change', renderStatus);
  jiraBox.addEventListener('change', renderJira);

  return {
    open(flags: TrackerSettings, jira?: JiraSettings): void {
      const token = ++openToken;
      boxes.github.checked = flags.github;
      boxes.gitlab.checked = flags.gitlab;
      jiraBox.checked = jira?.enabled ?? false;
      jiraKey.value = jira?.project ?? '';
      status = null;
      failure = '';
      jiraStatus = null;
      renderStatus();
      renderJira();
      void api.jiraStatus().then(
        (result) => {
          if (token !== openToken) return;
          jiraStatus = result;
          renderJira();
        },
        (error: Error) => {
          if (token !== openToken) return;
          jiraStatus = { state: 'error', message: `Проверка не удалась: ${error.message}` };
          renderJira();
        },
      );
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
    read: () => ({
      trackers: { github: boxes.github.checked, gitlab: boxes.gitlab.checked },
      jira: { enabled: jiraBox.checked, project: jiraKey.value.trim() },
    }),
    close(): void {
      openToken++;
    },
  };
}
