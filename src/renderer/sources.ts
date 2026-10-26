import type { JiraSettings } from '../main/projects';
import type { JiraProjectsResult, JiraStatus, JiraSuggestion } from '../main/jira';
import { MAX_JIRA_PROJECTS, PROJECT_KEY } from '../main/jira-keys';
import type { TrackerSettings, TrackersStatus } from '../main/trackers';
import { byId, el } from './dom';
import { authLines } from './task-model';

const api = window.cyborg;

/** Раздел «Источники задач» диалога проекта: галочки живут в черновике диалога, вход проверяется при каждом открытии. */
export function initSourcesSection(): {
  open(flags: TrackerSettings, jira?: JiraSettings, repos?: string[]): void;
  read(): { trackers: TrackerSettings; jira: JiraSettings };
  close(): void;
} {
  const boxes = { github: byId<HTMLInputElement>('project-github'), gitlab: byId<HTMLInputElement>('project-gitlab') };
  const statusEls = { github: byId('project-github-status'), gitlab: byId('project-gitlab-status') };
  const jiraBox = byId<HTMLInputElement>('project-jira');
  const jiraStatusEl = byId('project-jira-status');
  const picker = byId('project-jira-picker');
  const chosenEl = byId('project-jira-chosen');
  const suggestEl = byId('project-jira-suggest');
  const filterEl = byId<HTMLInputElement>('project-jira-filter');
  const listEl = byId('project-jira-list');
  let jiraStatus: JiraStatus | null = null;
  let status: TrackersStatus | null = null;
  let failure = '';
  let openToken = 0;
  let selected: string[] = [];
  let projectList: JiraProjectsResult | 'loading' | null = null;
  let suggestions: JiraSuggestion[] = [];
  let draftRepos: string[] = [];

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

  const toggleKey = (key: string): void => {
    const upper = key.toUpperCase();
    if (selected.includes(upper)) selected = selected.filter((k) => k !== upper);
    else if (selected.length < MAX_JIRA_PROJECTS) selected = [...selected, upper];
    renderPicker();
  };

  function chip(text: string, title: string, onClick: () => void, remove = false): HTMLElement {
    const node = el('button', `chip-button${remove ? ' removable' : ''}`, remove ? `${text} ×` : text) as HTMLButtonElement;
    node.type = 'button';
    node.title = title;
    node.addEventListener('click', onClick);
    return node;
  }

  function renderPicker(): void {
    picker.hidden = !jiraBox.checked;
    chosenEl.replaceChildren(
      ...(selected.length
        ? selected.map((key) => chip(key, 'Убрать проект', () => toggleKey(key), true))
        : [el('span', 'hint', 'Не выбрано: проект по умолчанию из настроек jira-cli (jira init)')]),
    );
    const fresh = suggestions.filter((s) => !selected.includes(s.key));
    suggestEl.hidden = !fresh.length;
    suggestEl.replaceChildren(
      ...(fresh.length ? [el('span', 'hint', 'В ветках репозиториев:')] : []),
      ...fresh.map((s) => chip(`${s.key} · ${s.count}`, `Ключ ${s.key} стоит в ${s.count} ветках репозиториев проекта`, () => toggleKey(s.key))),
    );
    const query = filterEl.value.trim().toLowerCase();
    if (projectList === 'loading' || projectList === null) {
      listEl.replaceChildren(el('div', 'hint', jiraStatus && jiraStatus.state !== 'ready' ? '' : 'Загрузка проектов…'));
      return;
    }
    if ('problem' in projectList) {
      listEl.replaceChildren(el('div', 'hint', `${projectList.error}. Ключ можно ввести вручную.`));
      return;
    }
    const rows = projectList.projects.filter((p) => !query || p.key.toLowerCase().includes(query) || p.name.toLowerCase().includes(query));
    listEl.replaceChildren(
      ...rows.slice(0, 200).map((p) => {
        const row = el('label', 'jira-row');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = selected.includes(p.key);
        box.disabled = !box.checked && selected.length >= MAX_JIRA_PROJECTS;
        box.addEventListener('change', () => toggleKey(p.key));
        row.append(box, el('span', 'jira-key', p.key), el('span', 'jira-name', p.name));
        return row;
      }),
      ...(rows.length ? [] : [el('div', 'hint', 'Проектов не найдено.')]),
    );
  }

  function renderJira(): void {
    jiraStatusEl.replaceChildren(el('div', '', jiraLine()));
    renderPicker();
  }

  /** Список проектов и подсказки по веткам: запрашиваются, когда Jira включена и вход принят; не чаще раза за открытие диалога. */
  function loadProjects(token: number): void {
    if (projectList !== null || !jiraBox.checked || jiraStatus?.state !== 'ready') return;
    projectList = 'loading';
    renderPicker();
    void api.jiraProjects(false).then(
      (result) => {
        if (token !== openToken) return;
        projectList = result;
        renderPicker();
      },
      (error: Error) => {
        if (token !== openToken) return;
        projectList = { problem: 'error', error: error.message };
        renderPicker();
      },
    );
    void api.jiraSuggest(draftRepos).then(
      (result) => {
        if (token !== openToken) return;
        suggestions = result;
        renderPicker();
      },
      () => undefined,
    );
  }

  for (const box of Object.values(boxes)) box.addEventListener('change', renderStatus);
  jiraBox.addEventListener('change', () => {
    renderJira();
    loadProjects(openToken);
  });
  filterEl.addEventListener('input', () => {
    filterEl.setCustomValidity('');
    renderPicker();
  });
  // Enter в поле поиска не должен отправлять форму диалога: он добавляет введённый ключ, если он по форме.
  filterEl.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const typed = filterEl.value.trim();
    if (!PROJECT_KEY.test(typed)) return;
    if (!selected.includes(typed.toUpperCase()) && selected.length >= MAX_JIRA_PROJECTS) {
      filterEl.setCustomValidity(`Выбрано ${MAX_JIRA_PROJECTS} проектов - больше нельзя: уберите один`);
      filterEl.reportValidity();
      return;
    }
    if (!selected.includes(typed.toUpperCase())) toggleKey(typed);
    filterEl.value = '';
    renderPicker();
  });

  return {
    open(flags: TrackerSettings, jira?: JiraSettings, repos: string[] = []): void {
      const token = ++openToken;
      boxes.github.checked = flags.github;
      boxes.gitlab.checked = flags.gitlab;
      jiraBox.checked = jira?.enabled ?? false;
      selected = [...(jira?.projects ?? [])];
      draftRepos = [...repos];
      projectList = null;
      suggestions = [];
      filterEl.value = '';
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
          loadProjects(token);
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
      jira: { enabled: jiraBox.checked, projects: [...selected] },
    }),
    close(): void {
      openToken++;
    },
  };
}
