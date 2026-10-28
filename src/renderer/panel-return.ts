import type { Mr } from '../main/mrs';
import type { Task } from '../main/trackers';
import { mrNumber } from './mr-model';

export interface ReturnTarget {
  tab: 'tasks' | 'mrs';
  key: string;
  label: string;
  title: string;
}

/** Куда ведёт кнопка возврата из сессии, начатой по MR либо задаче; у обычной сессии и сессии Jira её нет. */
export function returnTarget(s: { mr?: Pick<Mr, 'key' | 'kind' | 'number'>; task?: Pick<Task, 'key' | 'number'> }): ReturnTarget | null {
  if (s.mr) {
    const number = mrNumber(s.mr.kind, s.mr.number);
    return { tab: 'mrs', key: s.mr.key, label: `К ${number} в списке`, title: `Открыть список MR/PR на ${number}` };
  }
  if (s.task) return { tab: 'tasks', key: s.task.key, label: `К #${s.task.number} в списке`, title: `Открыть список задач на #${s.task.number}` };
  return null;
}
