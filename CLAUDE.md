<!-- >>> dex-auto: flow -->
## Порядок работы

Разработка идёт циклом **Требования -> Разработка -> Фиксация истины**: каждый шаг - трек dex-auto, шаг не начат, пока
не сдан предыдущий. Истина проекта - корпус по `.docs_layout`: единица `approved` обязывает, `review` - черновик до
приёмки человеком; принятое становится требованием следующих задач.

## Сборка и гейты

- Сборка - `npm run build`
- Проверка типов - `npm run typecheck`
- Линтер - нет
- Тесты - `npm test` (node --test, без зависимостей)
- Согласованность корпуса - `npm run check:corpus`; после правки SRS матрицу верификации пересобирает `npm run corpus:matrix`
- Дымовой тест окна - `npm run smoke` (нужен дисплей; на Linux `xvfb-run`)
- CI - GitHub Actions, `.github/workflows/ci.yml`: сборка, типы, тесты и дымовой тест на macOS и Linux и проверка корпуса для каждого PR и пуша в master

## Карта

- `dist/` - выход сборки esbuild (main.js, preload.js, renderer/), в git не входит
- `docs/` - корпус документации: BRD продукта, ADR, счётчики; адреса в .docs_layout
- `node_modules/` - установленные npm-зависимости, в git не входят
- `package.json` - манифест: скрипты build/start/test/typecheck/smoke/measure/bench/parity/check:corpus/corpus:matrix, postinstall (electron-rebuild для node-pty), main = dist/main.js
- `cyborg` - скрипт запуска из исходников: проверка git, npm и Node 24, `npm install` при смене `package-lock.json`, сборка, Electron; `assets/` - значок приложения
- `scripts/` - build.mjs - сборка трёх бандлов esbuild и копирование статики и Monaco; check-corpus.ts и corpus-lib.ts - проверка корпуса и матрица верификации; test.mjs - запуск `test/*.test.ts` (esbuild во временный каталог, `node --test`); smoke.mjs - дымовой тест окна по DevTools Protocol; measure.mjs - замер загрузки панелей задач и MR на любом проекте воркспейса (`--workspace`, `--project`, `--fake`); bench.mjs - замеры собранного приложения (время до окна, память, терминал, поиск, «Расширения», панели, бандлы); parity.mjs - проигрыватель записанных сессий `test/parity/`; lib/driver.mjs - общий драйвер Electron
- `docs/guide/` - страницы сайта документации для пользователя (не корпус требований); собирает `site/`
- `site/` - сайт документации (Astro и Starlight): `cd site && npm ci && npm run build && npm run verify`; публикует `.github/workflows/docs-site.yml` в GitHub Pages
- `src/main/` - главный процесс Electron; точки входа main.ts и preload.ts, меню - menu.ts. Сессии в pty и хуки: sessions, claude-args, events-store, session-args, history. Файлы и git: files, allowed-paths, open-path, git, git-search, search-run, search-args. Проекты и воркспейсы: projects, workspaces. Трекеры: trackers, mrs, mrs-service, task-details, jira, jira-service. Кнопки: commands, command-store, prompts, prompt-store, suggestions. Окно «Расширения»: extensions*, hubs. Рядом лежат модульные тесты `*.test.ts`
- `src/shared/` - код, общий для главного процесса и интерфейса: extensions.ts (окно «Расширения»), search-pattern.ts (запрос поиска)
- `src/renderer/` - интерфейс: проекты, полоса сессий, xterm, дерево, Monaco; точка входа app.ts и index.html. Панели задач, MR и «Статус»: tasks, mrs, panel, status; кнопки-команды: command-bar и редакторы command-editor, prompt-editor, config-editor; окно поиска search-dialog; окно «Расширения» extensions-dialog
- `plugin/` - плагин Claude Code для сессий Cyborg: скилл `skills/parallel-sessions`, хук `hooks/lsp-reap.sh` (гасит LSP сессии в удалённом каталоге и после EnterWorktree/ExitWorktree, Claude Code поднимает его в текущем); сборка кладёт его в `dist/plugin`, сессия получает ключом `--plugin-dir`
- `fixtures/` - подставные программы и данные для smoke, замеров и записанных сессий: fake-bin (claude, gh, jira, shell), slow-git (медленный `rev-parse --show-toplevel`), claude-home (каталог настроек Claude), market (магазин плагинов)
- `test/` - тесты на node:test, по файлу на область (хранилища, меню, поиск, расширения, кнопки, клавиатура интерфейса, статические проверки, запуск Electron драйвером стенда и выбор записей `scripts/parity.mjs`); запускает scripts/test.mjs; `test/parity/` - записанные сессии S1-S18 (JSON, играет scripts/parity.mjs); `test/baseline/` - сырые результаты замеров базы PL-09 (JSON и логи bench, measure, parity), см. README в каталоге
- `.github/` - workflows ci.yml (сборка, типы, тесты, smoke, корпус) и docs-site.yml (сайт), dependabot.yml

## Правила

Свода правил нет: ревью судит по практике стека; свод из истории ревью MR собирает `/dex-rulebook-miner:rulebook`.

## Запреты

- `dist/` - scripts/build.mjs:5 пересоздаёт каталог при каждой сборке; .gitignore:2
- `node_modules/` - node_modules/
- `package-lock.json` - package-lock.json
<!-- <<< dex-auto: flow -->
