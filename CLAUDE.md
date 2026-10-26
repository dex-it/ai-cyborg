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
- Дымовой тест окна - `npm run smoke` (нужен дисплей; на Linux `xvfb-run`)
- CI - GitHub Actions, `.github/workflows/ci.yml`: сборка, типы, тесты и дымовой тест на macOS и Linux для каждого PR и пуша в master

## Карта

- `dist/` - выход сборки esbuild (main.js, preload.js, renderer/), в git не входит
- `docs/` - корпус документации: BRD продукта, ADR, счётчики; адреса в .docs_layout
- `node_modules/` - установленные npm-зависимости, в git не входят
- `package.json` - манифест: скрипты build/start/test/typecheck/smoke, main = dist/main.js
- `scripts/` - build.mjs - сборка трёх бандлов esbuild и копирование статики и Monaco
- `src/main/` - главный процесс Electron: сессии в pty, файлы, git, проекты; точки входа main.ts и preload.ts
- `src/renderer/` - интерфейс: проекты, полоса сессий, xterm, дерево, Monaco; точка входа app.ts и index.html

## Правила

Свода правил нет: ревью судит по практике стека; свод из истории ревью MR собирает `/dex-rulebook-miner:rulebook`.

## Запреты

- `dist/` - scripts/build.mjs:4 пересоздаёт каталог при каждой сборке; .gitignore:2
- `node_modules/` - node_modules/
- `package-lock.json` - package-lock.json
<!-- <<< dex-auto: flow -->
