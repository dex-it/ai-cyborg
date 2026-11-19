import { setDefaultCommandsForTest } from '../src/main/commands';

/** Прежний заводской набор полосы: тесты слоёв берут его нижним слоем, пока в коде встроенных кнопок нет. */
setDefaultCommandsForTest([
  { label: 'Сливай', text: 'сливай', submit: true, hotkey: 'F1', description: 'Фраза «сливай»: слить PR текущей ветки.' },
  { label: 'Сделай PR', text: 'сделай PR', submit: true, hotkey: 'F2', description: 'Фраза «сделай PR»: открыть PR из текущей ветки.' },
  {
    label: 'Мердж',
    text: 'открой PR текущей ветки, если его ещё нет, и смерджи его в целевую ветку',
    submit: false,
    hotkey: 'F3',
    description: 'Вставляет без Enter просьбу открыть PR ветки, если его нет, и слить его в целевую ветку: проверьте и нажмите Enter сами.',
  },
  { label: 'Приберись', text: 'приберись', submit: true, hotkey: 'F4', description: 'Фраза «приберись»: убрать за собой, например слитые ветки.' },
]);
