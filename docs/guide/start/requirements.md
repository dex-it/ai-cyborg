---
title: "Что нужно"
description: "Системные требования и зависимости Cyborg."
---

## Обязательное

| Что | Зачем |
|---|---|
| macOS или Linux | Проверено на macOS (Apple Silicon) и Linux. На Windows приложение не проверялось. |
| Node.js 24 и npm | Сборка и запуск из исходников. |
| git | Дерево, ветки и статусы читаются вызовом `git`. |
| [Claude Code](https://docs.claude.com/en/docs/claude-code) | Команда `claude` в `PATH`, вход уже выполнен. Cyborg запускает обычный CLI. |

## Для задач и MR

| Что | Зачем |
|---|---|
| [`gh`](https://cli.github.com/) | Задачи и PR из GitHub. Нужен вход (`gh auth login`). |
| [`glab`](https://gitlab.com/gitlab-org/cli) | Задачи и MR из GitLab, в том числе самохостного. Нужен вход (`glab auth login`). |

Свои токены Cyborg не хранит и не читает: `gh` и `glab` работают под своим входом, Cyborg вызывает их как программы.

## Для Jira

| Что | Зачем |
|---|---|
| [`jira-cli`](https://github.com/ankitpokhrel/jira-cli) | Задачи Jira в карточке «Статус». Бинарь `jira` в `PATH` и работающий вход: `jira me` должен назвать вас. |

Подготовка: `brew tap ankitpokhrel/jira-cli && brew install jira-cli`, затем токен в `JIRA_API_TOKEN` (Jira Cloud - email и API-токен, Server и Data Center - `JIRA_AUTH_TYPE=bearer` и персональный токен) и `jira init`. Cyborg читает Jira только через этот CLI, токен и конфиг не читает и не хранит. Включается галочка «Jira» в свойствах проекта ([Статус проекта](/features/status/)).

## Для ревью MR

Действие «Ревью» у MR отдаёт сессии команду `/dex-auto:auto review <ссылка>`. Она принадлежит плагину `dex-auto` из каталога [ai-kit](https://dex-it.github.io/ai-kit/): без него Claude Code не узнает команду. «Доработать» и старт по задаче плагина не требуют.

## Что не поддерживается

- Windows.
- Установщики и подписанные сборки: приложение запускается только из исходников.
