---
title: "macOS и Linux"
description: "Чем отличаются платформы и какие у каждой особенности."
---

| | macOS | Linux |
|---|---|---|
| Проверено | Apple Silicon, Node 24, Electron 45 | CI на `ubuntu-latest` (под `xvfb`) |
| Запуск | `./cyborg` | `./cyborg` |
| Каталог данных | `~/Library/Application Support/cyborg` | `~/.config/cyborg` |
| Клавиши | `Cmd` | `Ctrl` |
| Песочница Chromium | не требует настройки | setuid `chrome-sandbox` или user namespaces, иначе `--no-sandbox` |
| Значок | значок приложения в Dock | значок окна |

## macOS

- Запускайте `./cyborg` из терминала: так приложение наследует `PATH` с `gh`, `glab` и `claude`. При запуске не из терминала `PATH` скуден.
- Сессия стартует как `$SHELL -lc 'exec claude ...'`. Логин-шелл zsh читает `.zprofile`, но не `.zshrc`: если `claude` добавлен в `PATH` только в `.zshrc`, приложению, запущенному не из терминала, он не виден.
- Пути вроде `/tmp` и `/var` на macOS - символьные ссылки; Cyborg приводит пути репозиториев к физическим.
- Файловая система APFS не допускает имена файлов не в UTF-8; на проверки Cyborg это не влияет.

## Linux

См. [Установка и запуск](/start/install/): песочница Chromium и флаг `--no-sandbox`.

## Windows

Не поддерживается и не проверялась.
