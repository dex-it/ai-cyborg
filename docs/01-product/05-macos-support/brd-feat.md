---
level: feature
feature: 05-macos-support
status: review
date: 2026-10-26
origin: source
quality-checks: входных записей нет
---

# BRD фичи 05 - работа Cyborg на macOS

Источник: Issue dex-it/ai-cyborg#2 и проверка на macOS (Apple Silicon, Node 24.20, Electron 45.0.0). Фича опирается на
терминал сессии Claude Code (BR-001) и дерево сессии (BR-002).

## 1. BRS overview

README заявляет только Linux, а на macOS запуск из README невозможен (скрипта `./cyborg` в репозитории нет), тесты
красные, управление рассчитано на Ctrl. Фича доводит приложение до работы на macOS наравне с Linux. Адресован
владельцу продукта и составителям SRS и архитектуры.

## 2. Business purpose

Разработчик на macOS ставит и запускает Cyborg одной командой и управляет им привычными для macOS клавишами, а
разработчик Linux не замечает изменений.

## 3. Business scope

Внутри границы: скрипт запуска для macOS и Linux; клавиши команд приложения (новая сессия, размер шрифта) и их
подсказки; чтение журнала событий сессии независимо от платформы; шрифт терминала; каталог данных замера;
тесты на macOS; автоматическая проверка PR на macOS и Linux; README.

`non-goals`:

- упаковка в `.app` и `.dmg`, подпись, нотаризация, запуск из Dock и Finder (процесс не получает `PATH` терминала);
- Option как Meta в терминале: меняет ввод символов на нелатинских раскладках;
- Windows;
- обновление зависимостей (`npm audit`: `dompurify` через `monaco-editor`).

## 4. Business overview

`inherited`: BRD продукта, раздел 4.

## 5. Major stakeholders

| Сторона | Интерес | RACI |
|---|---|---|
| Разработчик на macOS | запустить и вести сессии Claude Code в Cyborg | R/A на использование |
| Разработчик на Linux | поведение не меняется | I |
| Владелец продукта | граница фичи: платформа, не новая функциональность | A на этот документ |

## 6. Business environment

`inherited`: BRD продукта, раздел 6.

## 7. Mission, goals and objectives

### BR-5001 Работа на macOS

- **Требование:** разработчик на macOS запускает Cyborg одной командой из клона репозитория и работает с сессиями,
  деревом, просмотром файлов, задачами и MR так же, как на Linux; клавиши команд приложения - Cmd.
- **traced from:** BR-001, BR-002.
- **rationale:**
  - reason: Issue #2; проверка показала работающие сессии, дерево и git-статус, но нерабочий запуск по README,
    красные тесты и клавиши только на Ctrl;
  - assumptions: Claude Code, git, `gh` и `glab` на macOS ведут себя как на Linux;
  - relationships: сценарии 1 и 6 раздела 17 BRD продукта;
  - design constraints: нативность сессии (BR-001) сохраняется, новых npm-зависимостей нет.
- **MOE:** на чистом клоне macOS `./cyborg` открывает окно, `npm test` зелёный (качественная).

## 8. Business model

`inherited`: BRD продукта, раздел 8.

## 9. Information environment

`inherited`: BRD продукта, раздел 9.

## 10. Business processes

`inherited`: BRD продукта, раздел 10.

## 11. Business operational policies and rules

- На macOS клавиша команд - Cmd, на остальных системах - Ctrl; чужая клавиша команду не вызывает (D-01).

## 12. Business operational constraints

- Запуск из Dock и Finder не поддерживается: приложение берёт `PATH` процесса, из которого запущено.

## 13. Business operational modes

`inherited`: BRD продукта, раздел 13.

## 14. Business operational quality

`n/a`: мер оператор не задал.

## 15. Business structure

`inherited`: BRD продукта, раздел 15.

## 16. High-level operational concept

`inherited`: BRD продукта, раздел 16.

## 17. High-level operational scenarios

`inherited`: BRD продукта, раздел 17, сценарии 1 и 6.

## 18. Other high-level life-cycle concepts

`inherited`: BRD продукта, раздел 18.

## 19. Project constraints

- Новых npm-зависимостей нет.

## Добавки

### Допущения

Допущения прогона, принятые без оператора, - `decision-log.md`, записи с исходом «открыто».

### Открытые вопросы

Нет.
