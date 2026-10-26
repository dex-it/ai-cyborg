---
feature: 09-session-isolation
status: review
date: 2026-10-26
origin: derived
quality-checks: входных записей нет
---

# SRS фичи 09 - изоляция параллельных сессий

## 1. SRS overview

Требования к добавкам запуска `claude`: инструкция изоляции и порядок аргументов. Вход - BRD фичи (`brd-feat.md`, BR-9001), код
`src/main/claude-args.ts`, `src/main/sessions.ts`. Основания решений - `decision-log.md`.

## 2. Purpose

Задать наблюдаемое поведение запуска сессии так, чтобы правка проверялась по требованию, а не по коду.

## 3. Scope

Аргументы запуска `claude` (`claudeArgs`) и граница ответственности Cyborg и модели. Вне фичи: создание worktree, принуждение,
слежение дерева (фича `04-session-tree`), история (фича `08-session-history`).

## 4. Product perspective

Часть запуска сессии (ADR-0003, п.1, п.9): к хукам, каталогам и начальному промпту добавлены `--append-system-prompt` и, при
продолжении, `--resume` (ADR-0012).

## 5. Product functions

Инструкция изоляции в системном промпте; порядок аргументов запуска.

## 6. User characteristics

`inherited`: BRD продукта, раздел 5.

## 7. Limitations

- Новых зависимостей нет; Cyborg не создаёт ветки и worktree (FR-1016).
- Инструкция - добавка к системному промпту, не замена.

## 8. Assumptions and dependencies

`claude` 2.1.310: флаг `--append-system-prompt`, инструмент `EnterWorktree`. Допущения D-01..D-05 открыты до подтверждения
владельцем.

## 9. Apportioning of requirements

Главный процесс: FR-9001, FR-9002, FR-9003.

## 10. Specified requirements

Общие атрибуты, если у требования не сказано иное: `feature: 09-session-isolation`; приоритет - обязательно; основание -
несценарное требование (сценарий 9 BRD продукта); уровень верификации - модуль (`npm test`) для испытания и собранное приложение
для демонстрации.

## 11. External interfaces

### FR-9002 Порядок аргументов запуска

- **Требование:** аргументы `claude` после `--settings`: `--resume <id>` (при продолжении), `--append-system-prompt <инструкция>`,
  начальный промпт (при старте из задачи либо MR), `--add-dir <каталоги...>` (при нескольких репозиториях проекта). Промпт стоит до
  `--add-dir`: флаг вариадический и забрал бы промпт, стоящий после каталогов.
- **traced from:** BR-9001.
- **источник:** код `claudeArgs`; ADR-0003, п.9 (порядок промпта и каталогов); D-03.
- **rationale:** reason - детерминированный запуск; assumptions - `--add-dir` вариадический; relationships - FR-1012, FR-8002;
  design constraints - ADR-0012, п.2.
- **verification:** испытание - `test/history.test.ts` («claudeArgs: --resume с id стоит до --add-dir»), `test/trackers.test.ts`
  («claudeArgs: промпт стоит до вариадического --add-dir, без задачи аргументы прежние»), `test/mrs.test.ts` («claudeArgs: промпт на «/»
  стоит до --add-dir»).
- **класс:** External interfaces. **origin:** derived.

## 12. Functions

### FR-9001 Инструкция изоляции в каждой сессии

- **Требование:** к каждой сессии при запуске (новой, из задачи либо MR, продолженной) добавляется `--append-system-prompt` с текстом:
  «В этих репозиториях параллельно работают другие сессии. Перед первой правкой, сменой ветки или коммитом - EnterWorktree, дальше
  работа только в нём. Основной каталог - только чтение.» Добавка к системному промпту, а не замена; текст не зависит от проекта,
  задачи и MR.
- **traced from:** BR-9001.
- **источник:** код `ISOLATION_PROMPT`; прогон на настоящем Claude Code 26.10.2026 (две параллельные сессии ушли в worktree); D-01..D-04.
- **rationale:** reason - параллельные сессии конфликтуют в общем каталоге; assumptions - D-02, D-05; relationships - FR-9002, FR-9003,
  фича `04-session-tree` (дерево следует за cwd); design constraints - ADR-0012, п.1.
- **verification:** испытание - те же тесты `claudeArgs`, что у FR-9002 (во всех вариантах запуска есть `--append-system-prompt` с
  `ISOLATION_PROMPT`); демонстрация - две настоящие сессии ушли в worktree.
- **класс:** Functions. **origin:** derived.

### FR-9003 Решает модель, Cyborg передаёт и следит

- **Требование:** Cyborg не создаёт worktree и ветки, не принуждает и не блокирует сессию, не ушедшую в worktree; он передаёт
  инструкцию (FR-9001) и показывает дерево каталога, где сессия работает сейчас (смена cwd по событию хука `EnterWorktree` -
  фича `04-session-tree`).
- **traced from:** BR-9001.
- **источник:** код (нет вызова `git worktree` в `src/`); ADR-0003, п.3-4; D-04, D-05.
- **rationale:** reason - граница нативности и FR-1016; assumptions - D-05; relationships - FR-1016, FR-4005; design constraints -
  ADR-0012, п.1.
- **verification:** осмотр - в `src/` нет создания worktree; испытание - `src/main/sessions.test.ts` («читает события: смена cwd»);
  демонстрация - дерево перешло в worktree вслед за настоящей сессией.
- **класс:** Functions. **origin:** derived.

## 13. Usability requirements

`n/a`.

## 14. Performance requirements

`n/a`.

## 15. Logical database requirements

`n/a`: фича данных не хранит.

## 16. Design constraints

Изоляция и история - ADR-0012; запуск сессии - ADR-0003.

## 17. Standards compliance

`n/a`.

## 18. Software system attributes

Нативность сессии (anti-metrics BRD продукта) сужена добавкой FR-9001 (D-02).

## 19. Verification

Испытание - `npm test` (`node:test`, ADR-0006); демонстрация - настоящий Claude Code. Покрытие бизнес-уровня: BR-9001 -
FR-9001..FR-9003.

## 20. Supporting information

`n/a`.

## Добавки

### Незакрытые пункты

- Допущения D-01..D-05 - владелец продукта, до приёмки фичи; D-02 (отступление от нативности) - прежде прочих.
- Историй с AC (`stories/`) у фичи нет - пробел корпуса до нарезки историй.
