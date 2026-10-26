---
status: review
date: 2026-10-26
---

# Матрица верификации требований

Сформирована `npm run corpus:matrix` из полей `verification` SRS фич; руками не правится, CI проверяет, что она не устарела.
Уровень выводится из текста: `автотест` - названы файлы `*.test.ts`; `smoke` - назван `scripts/smoke.mjs`; `ручная` - замер у владельца
(`npm run measure`); `осмотр и демонстрация` - ничего из перечисленного. Уровни складываются: `автотест + smoke`.

Требований: 97; с автотестом - 86, из них со smoke - 5; только smoke - 4; ручная - 2; только осмотр и демонстрация - 5.

| Требование | Название | Фича | Уровень | Файлы |
|---|---|---|---|---|
| FR-1001 | Панель задач в рабочей области | 01-tasks-panel | smoke | `scripts/smoke.mjs` |
| NFR-1001 | Токен трекера не проходит через Cyborg | 01-tasks-panel | автотест | `test/trackers.test.ts` |
| FR-1002 | Источники задач по remote проекта | 01-tasks-panel | автотест | `test/trackers.test.ts`, `test/stores.test.ts` |
| NFR-1002 | Сеть только к трекерам | 01-tasks-panel | автотест | `test/trackers.test.ts` |
| FR-1003 | Выборка открытых задач со всех страниц | 01-tasks-panel | автотест | `test/trackers.test.ts` |
| NFR-1003 | Пределы ожидания CLI трекера | 01-tasks-panel | автотест | `test/cli-limits.test.ts`, `test/mrs.test.ts`, `test/trackers.test.ts` |
| FR-1004 | Фильтр «Назначено мне» на стороне трекера | 01-tasks-panel | автотест | `test/trackers.test.ts` |
| NFR-1004 | Время загрузки панели задач | 01-tasks-panel | ручная | `scripts/measure.mjs` |
| FR-1005 | Сортировка | 01-tasks-panel | автотест | `test/model.test.ts` |
| FR-1006 | Обновление по открытию и кнопке | 01-tasks-panel | автотест | `test/flow.test.ts` |
| FR-1007 | Отказ источника не скрывает остальные | 01-tasks-panel | автотест | `test/trackers.test.ts` |
| FR-1008 | Пустые состояния панели | 01-tasks-panel | автотест | `test/model.test.ts`, `test/tasks-view.test.ts` |
| FR-1009 | Раздел «Источники задач» диалога проекта | 01-tasks-panel | автотест | `test/model.test.ts`, `test/trackers.test.ts` |
| FR-1010 | Включение источников GitHub и GitLab | 01-tasks-panel | автотест | `test/stores.test.ts`, `test/trackers.test.ts` |
| FR-1011 | «Начать» в репозитории задачи | 01-tasks-panel | автотест | `test/flow.test.ts` |
| FR-1012 | Начальный промпт сессии задачи | 01-tasks-panel | автотест | `test/trackers.test.ts` |
| FR-1013 | Повторное «Начать» | 01-tasks-panel | автотест | `test/flow.test.ts` |
| FR-1014 | Заголовок сессии задачи | 01-tasks-panel | автотест | `test/model.test.ts`, `test/trackers.test.ts` |
| FR-1015 | Привязка задачи к сессии только в памяти | 01-tasks-panel | автотест | `test/static-guards.test.ts` |
| FR-1016 | Только чтение трекера и git | 01-tasks-panel | автотест | `test/trackers.test.ts`, `test/task-details.test.ts`, `test/mrs.test.ts` |
| FR-1017 | Проверка аргументов каналов главным процессом | 01-tasks-panel | автотест | `test/trackers.test.ts`, `test/mrs.test.ts`, `test/task-details.test.ts` |
| FR-1018 | Данные задачи - текстом | 01-tasks-panel | автотест | `test/static-guards.test.ts` |
| FR-1019 | Проверка входа в трекеры переиспользуется между выборками | 01-tasks-panel | автотест | `test/trackers.test.ts`, `test/flow.test.ts` |
| FR-1020 | Метки, автор и исполнители в запросе списка | 01-tasks-panel | автотест | `test/trackers.test.ts` |
| FR-1021 | Метки в строке задачи | 01-tasks-panel | автотест | `test/model.test.ts`, `test/tasks-view.test.ts` |
| FR-1022 | Фильтр по комбинации меток | 01-tasks-panel | автотест | `test/model.test.ts`, `test/tasks-view.test.ts` |
| FR-1023 | Детали задачи раскрытием строки | 01-tasks-panel | автотест | `test/model.test.ts`, `test/tasks-view.test.ts` |
| FR-1024 | Описание задачи только по задаче текущей выборки | 01-tasks-panel | автотест | `test/task-details.test.ts` |
| FR-1025 | Открытие задачи в системном браузере | 01-tasks-panel | автотест | `test/task-details.test.ts` |
| FR-1026 | Повреждённый файл проектов не теряется | 01-tasks-panel | автотест | `test/stores.test.ts` |
| FR-1027 | Каналы файлов и git отвечают только по разрешённым каталогам | 01-tasks-panel | автотест | `test/allowed-paths.test.ts` |
| FR-2001 | Источники MR - источники задач | 02-mr-view | автотест | `test/mrs.test.ts` |
| NFR-2001 | Предел деталей MR и процессов CLI | 02-mr-view | автотест | `test/mrs.test.ts` |
| FR-2002 | Выборка открытых MR со всех страниц | 02-mr-view | автотест | `test/mrs.test.ts` |
| NFR-2002 | Время загрузки вида MR/PR | 02-mr-view | ручная | `scripts/measure.mjs` |
| FR-2003 | Пайплайн и апрувы MR | 02-mr-view | автотест | `test/mrs.test.ts` |
| FR-2004 | Отказ источника и не полученные поля | 02-mr-view | автотест | `test/mrs.test.ts` |
| FR-2005 | Фильтр MR | 02-mr-view | автотест | `test/mrs.test.ts` |
| FR-2006 | Строка MR | 02-mr-view | автотест | `test/mrs.test.ts`, `test/model.test.ts`, `test/flow.test.ts` |
| FR-2007 | Сортировка MR | 02-mr-view | автотест | `test/model.test.ts` |
| FR-2008 | Пустые состояния вида MR/PR | 02-mr-view | автотест | `test/model.test.ts` |
| FR-2009 | Обновление вида MR/PR | 02-mr-view | автотест | `test/flow.test.ts`, `test/mrs.test.ts` |
| FR-2010 | Действие по автору MR | 02-mr-view | автотест | `test/model.test.ts`, `test/mrs.test.ts` |
| FR-2011 | Сессия MR и её первое сообщение | 02-mr-view | автотест | `test/mrs.test.ts`, `test/flow.test.ts` |
| FR-2012 | Повторное действие по MR | 02-mr-view | автотест | `test/flow.test.ts` |
| FR-2013 | Заголовок сессии MR | 02-mr-view | автотест | `test/model.test.ts`, `test/mrs.test.ts` |
| FR-2014 | Привязка MR к сессии только в памяти | 02-mr-view | автотест | `test/static-guards.test.ts` |
| FR-2015 | Данные MR - текстом | 02-mr-view | автотест | `test/model.test.ts` |
| FR-2016 | Проверка аргументов каналов MR | 02-mr-view | автотест | `test/mrs.test.ts` |
| FR-3001 | Строка дерева - источник перетаскивания | 03-path-drop | автотест | `test/drop-path.test.ts` |
| FR-3002 | Бросок на терминал и вкладку «Claude» | 03-path-drop | автотест | `test/drop-path.test.ts` |
| FR-3003 | Кавычки и склейка путей | 03-path-drop | автотест | `test/drop-path.test.ts` |
| FR-3004 | Путь файла ОС | 03-path-drop | автотест | `test/drop-path.test.ts` |
| FR-3005 | Бросок вне зон | 03-path-drop | smoke | `scripts/smoke.mjs` |
| FR-4001 | Раскрытие каталога только по клику на него | 04-session-tree | автотест | `test/tree.test.ts` |
| FR-4002 | Сворачивание корня | 04-session-tree | автотест | `test/tree.test.ts` |
| FR-4003 | Раскрытие изолировано по сессии | 04-session-tree | автотест | `test/tree.test.ts` |
| FR-4004 | Корни дерева сессии без повтора пути | 04-session-tree | автотест | `test/roots.test.ts`, `test/tree.test.ts` |
| FR-4005 | Подпись и подсказка корня после ухода рабочего каталога | 04-session-tree | автотест | `test/roots.test.ts` |
| FR-5001 | Запуск одной командой | 05-macos-support | автотест | `test/launcher.test.ts` |
| FR-5002 | Клавиши команд своей системы | 05-macos-support | автотест | `test/platform.test.ts` |
| FR-5003 | Чтение журнала событий независимо от момента взвода наблюдателя | 05-macos-support | автотест | `src/main/sessions.test.ts` |
| FR-5004 | Платформенные умолчания | 05-macos-support | осмотр и демонстрация | - |
| FR-5005 | Автоматическая проверка PR | 05-macos-support | автотест | `test/launcher.test.ts` |
| FR-5006 | Меню приложения и закрытие окна | 05-macos-support | автотест | `test/menu.test.ts`, `src/main/sessions.test.ts` |
| FR-5007 | Пути репозиториев проекта - физические | 05-macos-support | автотест | `test/stores.test.ts` |
| FR-5008 | История сессий видит сессии worktree | 05-macos-support | автотест | `test/history.test.ts` |
| FR-5009 | Проверка согласованности корпуса в CI | 05-macos-support | автотест | `test/check-corpus.test.ts` |
| FR-6001 | README | 06-docs-site | осмотр и демонстрация | - |
| FR-6002 | Сайт документации | 06-docs-site | осмотр и демонстрация | - |
| FR-6003 | Публикация на GitHub Pages | 06-docs-site | осмотр и демонстрация | - |
| FR-7001 | Список веток репозитория | 07-branch-switch | автотест | `test/git-branch.test.ts` |
| FR-7002 | Смена ветки `git switch` по имени из списка | 07-branch-switch | автотест | `test/git-branch.test.ts` |
| FR-7003 | Отказ при работающей сессии | 07-branch-switch | автотест | `src/main/sessions.test.ts` |
| FR-7004 | Отказ в репозитории с конфигом, исполняющим команды | 07-branch-switch | автотест | `test/git-branch.test.ts` |
| FR-8001 | Список прошлых сессий проекта | 08-session-history | автотест | `test/history.test.ts` |
| FR-8002 | Продолжение прошлой сессии | 08-session-history | автотест | `test/history.test.ts` |
| FR-8003 | Удаление прошлой сессии | 08-session-history | автотест | `test/history.test.ts` |
| FR-9001 | Инструкция изоляции в каждой сессии | 09-session-isolation | автотест | `test/history.test.ts`, `test/trackers.test.ts`, `test/mrs.test.ts` |
| FR-9002 | Порядок аргументов запуска | 09-session-isolation | автотест | `test/history.test.ts`, `test/trackers.test.ts`, `test/mrs.test.ts` |
| FR-9003 | Решает модель, Cyborg передаёт и следит | 09-session-isolation | автотест | `src/main/sessions.test.ts` |
| FR-10001 | Размер шрифта окна | 10-ui-preferences | автотест + smoke | `test/font-size.test.ts`, `scripts/smoke.mjs` |
| FR-10002 | Фильтры и сортировка панелей переживают перезапуск | 10-ui-preferences | автотест | `test/prefs.test.ts`, `test/model.test.ts` |
| FR-10003 | `Shift+Enter` - перевод строки в запросе | 10-ui-preferences | осмотр и демонстрация | - |
| FR-10004 | Порядок репозиториев проекта | 10-ui-preferences | автотест | `test/reorder.test.ts`, `test/roots.test.ts` |
| FR-11001 | Jira в свойствах проекта | 11-status-hub | автотест | `test/jira.test.ts` |
| FR-11002 | Кнопка «Статус» и карточка | 11-status-hub | smoke | `scripts/smoke.mjs` |
| FR-11003 | Сбор и обновление данных | 11-status-hub | smoke | `scripts/smoke.mjs` |
| FR-11004 | Индикатор и счётчик | 11-status-hub | автотест | `test/status-model.test.ts` |
| FR-11005 | Задачи Jira на мне: список и связь с MR | 11-status-hub | автотест + smoke | `test/jira.test.ts`, `test/status-model.test.ts`, `scripts/smoke.mjs` |
| FR-11006 | Детали задачи Jira и открытие в браузере | 11-status-hub | автотест + smoke | `test/jira.test.ts`, `scripts/smoke.mjs` |
| FR-11007 | Мои MR/PR и MR на моё ревью | 11-status-hub | автотест | `test/status-model.test.ts` |
| FR-11008 | Сессия по задаче Jira | 11-status-hub | автотест + smoke | `test/jira.test.ts`, `scripts/smoke.mjs` |
| FR-11009 | Сессия по упавшему пайплайну, доработке и ревью из карточки | 11-status-hub | автотест | `test/jira.test.ts` |
| FR-11010 | Только чтение и безопасность аргументов | 11-status-hub | автотест | `test/jira.test.ts`, `test/static-guards.test.ts` |
| FR-11011 | Отказы `jira-cli` и защита учётной записи | 11-status-hub | автотест | `test/jira.test.ts` |
| FR-11012 | Выбор проектов Jira для проекта | 11-status-hub | автотест + smoke | `test/jira.test.ts`, `scripts/smoke.mjs` |
