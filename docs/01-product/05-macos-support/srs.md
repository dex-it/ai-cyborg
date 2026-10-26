---
feature: 05-macos-support
status: review
date: 2026-10-26
origin: source
quality-checks: входных записей нет
---

# SRS фичи 05 - работа Cyborg на macOS

## 1. SRS overview

Требования к запуску, клавишам команд, чтению журнала событий и платформенным умолчаниям, нужные для работы на
macOS наравне с Linux. Вход - BRD фичи (`brd-feat.md`, BR-5001) и Issue dex-it/ai-cyborg#2. Основания решений -
`decision-log.md` (D-NN).

## 2. Purpose

Задать наблюдаемое поведение на macOS так, чтобы правка проверялась по требованию, а не по коду.

## 3. Scope

Скрипт запуска, клавиши команд и подсказки интерфейса, чтение журнала событий сессии, шрифт терминала, каталог
данных замера, автоматическая проверка PR. Вне фичи: упаковка, запуск из Dock и Finder, Option как Meta, Windows (D-07).

## 4. Product perspective

Скрипт `cyborg` - в корне репозитория. Клавиши - интерфейс (`src/renderer/platform.ts`, `app.ts`), платформа
приходит из моста preload (D-03). Чтение журнала - `SessionManager` главного процесса.

## 5. Product functions

Запуск одной командой; команды приложения на клавише своей системы; надёжное чтение событий хуков; шрифты и
каталог данных по платформе.

## 6. User characteristics

`inherited`: BRD продукта, раздел 5.

## 7. Limitations

- Новых npm-зависимостей нет.
- Запуск из Dock и Finder не поддерживается (BRD фичи, раздел 12).

## 8. Assumptions and dependencies

- Electron 45: меню приложения по умолчанию содержит Edit > Copy и Paste с Cmd+C и Cmd+V (D-02).
- Допущения D-06, D-08 открыты до подтверждения владельцем.

## 9. Apportioning of requirements

Скрипт запуска: FR-5001. Интерфейс и preload: FR-5002, FR-5004. Главный процесс: FR-5003. Автоматическая проверка: FR-5005.

## 10. Specified requirements

Общие атрибуты, если у требования не сказано иное: `feature: 05-macos-support`; приоритет - обязательно;
основание - несценарное требование; уровень верификации - модуль (`npm test`) для испытания и собранное приложение
для демонстрации.

## 11. External interfaces

### FR-5001 Запуск одной командой

- **Требование:** `./cyborg` в корне репозитория на macOS и Linux проверяет наличие git, Node.js 24 и новее и npm
  (иначе завершается с сообщением и кодом 1), ставит зависимости, если нет `node_modules` или `package-lock.json`
  новее `node_modules/.package-lock.json`, собирает приложение и запускает Electron, передавая ему свои аргументы.
  Работает при вызове по символьной ссылке из любого каталога. На Linux без setuid `chrome-sandbox` и без
  user namespaces добавляет `--no-sandbox` и предупреждает в stderr (D-06).
- **traced from:** BR-5001.
- **источник:** Issue #2, критерий 2; README; D-06.
- **rationale:** reason - README ссылается на скрипт, которого нет; assumptions - `sh` и утилиты POSIX есть на
  обеих системах; relationships - ADR-0006 п.6; design constraints - без GNU-расширений.
- **verification:** демонстрация - чистый клон на macOS: установка, сборка, окно (`cyborg` открыл страницу
  `Cyborg`); без Node и со старым Node - сообщение и код 1; через символьную ссылку из другого каталога. Ветка
  Linux не прогонялась (D-06).
- **класс:** External interfaces. **origin:** source.

## 12. Functions

### FR-5002 Клавиши команд своей системы

- **Требование:** на macOS: Cmd+Shift+N - новая сессия, Cmd+0 - размер шрифта по умолчанию, Cmd+колесо - шаг размера
  шрифта; на остальных системах те же команды на Ctrl. Чужой модификатор команду не вызывает, в том числе Ctrl на
  macOS (D-01). Подсказка кнопки «+ CC» и текст пустого экрана называют сочетание своей системы. Копирование и
  вставка терминала на macOS - Cmd+C и Cmd+V через меню Electron; вне macOS - Ctrl+Shift+C и Ctrl+Shift+V (D-02).
- **traced from:** BR-5001.
- **источник:** Issue #2, критерии 3 и 4; D-01, D-02, D-03, D-08.
- **rationale:** reason - клавиши были только на Ctrl; assumptions - Cmd+Shift+N не занят меню Electron;
  relationships - FR-3002 фичи 03 (вставка); design constraints - платформа из моста preload без IPC (ADR-0002 п.3).
- **verification:** испытание - `test/platform.test.ts` (`hasCommandKey`, `shortcut`, `isClipboardKey`);
  демонстрация - в собранном приложении события CDP: Ctrl+Shift+N и Ctrl+колесо молчат, Cmd+Shift+N открывает
  сессию, Cmd+колесо x3 даёт размер 16, Cmd+0 - 13; `webContents.copy()` и `paste()` с выделением в терминале.
  Cmd+0 физической клавиатурой не проверено (D-08).
- **класс:** Functions. **origin:** source.

### FR-5003 Чтение журнала событий независимо от момента взвода наблюдателя

- **Требование:** события хуков, записанные в файл сессии между запуском процесса и взводом наблюдателя файла,
  читаются: после взвода журнал читается ещё раз. Смена рабочего каталога и активность сессии доходят до интерфейса
  на macOS так же, как на Linux (D-04).
- **traced from:** BR-5001.
- **источник:** Issue #2, критерий 5; D-04.
- **rationale:** reason - на macOS наблюдатель взводится на следующем витке цикла, ранняя запись теряется;
  assumptions - чтение идёт по смещению и повторное безопасно; relationships - ADR-0003 п.3, п.4; design constraints
  - без опроса таймером.
- **verification:** испытание - `src/main/sessions.test.ts` («читает события: смена cwd, активность, удаление файла
  на выходе»: запись сразу после `create()`); демонстрация - собранное приложение с подставным `claude`, шлющим
  события: `cd` в worktree переводит дерево на worktree.
- **класс:** Functions. **origin:** source.

### FR-5004 Платформенные умолчания

- **Требование:** шрифты терминала - `'JetBrains Mono', 'SF Mono', Menlo, 'DejaVu Sans Mono', 'Ubuntu Mono',
  monospace`. Каталог данных замера `scripts/measure.mjs` по умолчанию - каталог данных Electron:
  `~/Library/Application Support/cyborg` на macOS, `$XDG_CONFIG_HOME/cyborg` либо `~/.config/cyborg` на остальных;
  `CYBORG_USERDATA` главнее.
- **traced from:** BR-5001.
- **источник:** Issue #2, раздел «Что сделать» (шрифты, `scripts/measure.mjs`).
- **rationale:** reason - в списке не было шрифтов macOS, замер искал данные там, где их нет;
  assumptions - имя приложения `cyborg` (проверено `app.getName()`); relationships - нет; design constraints - нет.
- **verification:** демонстрация - `app.getName()` и `app.getPath('appData')` в собранном приложении;
  `node scripts/measure.mjs` называет путь macOS.
- **класс:** Functions. **origin:** source.

### FR-5005 Автоматическая проверка PR

- **Требование:** для каждого PR и пуша в `master` GitHub Actions на macOS и Linux выполняет `npm ci`, сборку,
  проверку типов, `npm test` и дымовой тест `scripts/smoke.mjs`; падение любого шага делает проверку красной.
  Дымовой тест запускает собранное приложение с временным каталогом данных, подставным `claude` и репозиторием-
  пробой и проверяет: окно открыто; дерево показывает git-статус; подсказки называют сочетание своей системы;
  сочетание своей системы открывает сессию, чужое нет; вывод pty доходит до терминала; событие хука с новым
  рабочим каталогом переводит дерево на worktree; колесо и сброс клавишей своей системы меняют размер шрифта.
  Версии экшенов закреплены по SHA коммита (D-09).
- **traced from:** BR-5001.
- **источник:** запрос оператора «тестировать автоматически при создании PR»; D-09.
- **rationale:** reason - у проекта не было CI, а регресс на macOS (красные тесты, клавиши) ловился только руками;
  assumptions - на macOS-раннере GitHub есть сессия WindowServer для окна Electron, на Linux хватает `xvfb`;
  relationships - FR-5001..5004; design constraints - без новых npm-зависимостей: DevTools Protocol поверх
  встроенных `fetch` и `WebSocket` Node 24.
- **verification:** испытание - `test/launcher.test.ts` (скрипт запуска: бит исполнения, `sh -n`, отказ при Node
  старше 24, переход к npm при Node 24); демонстрация - `node scripts/smoke.mjs` на macOS проходит за 6 с и падает
  кодом 1 при сломанной клавише в бандле; запуск workflow в GitHub - не выполнялся, нет прав на репозиторий.
- **класс:** Functions. **origin:** source; закрепление по SHA и дымовой тест через CDP - derived.

## 13. Usability requirements

Подсказки FR-5002 - единственное требование.

## 14. Performance requirements

`n/a`: мер оператор не задал.

## 15. Logical database requirements

`n/a`: новых данных нет.

## 16. Design constraints

Мост интерфейса - ADR-0002 п.3; запуск из исходников - ADR-0006 п.6.

## 17. Standards compliance

`n/a`.

## 18. Software system attributes

Платформа отдаётся интерфейсу строкой `process.platform`; новых аргументов главный процесс не принимает.

## 19. Verification

Испытание - `npm test` на macOS: все тесты проходят, один пропускается с причиной (D-05: APFS не допускает имена не
в UTF-8); демонстрация - собранное приложение и `scripts/smoke.mjs`. Покрытие бизнес-уровня: BR-5001 - FR-5001..5005.

## 20. Supporting information

`n/a`.

## Добавки

### Незакрытые пункты

- D-06 (ветка Linux скрипта запуска), D-08 (Cmd+0 физической клавиатурой) и D-09 (первый запуск workflow, Linux-job)
  - до приёмки фичи.
- Историй с AC (`stories/`) у фичи нет - пробел корпуса до нарезки историй.
