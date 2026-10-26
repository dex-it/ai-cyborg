---
title: "Установка и запуск"
description: "Что делает ./cyborg, как обновиться и чем отличаются macOS и Linux."
---

## Запуск

```bash
git clone https://github.com/dex-it/ai-cyborg.git
cd ai-cyborg
./cyborg
```

При первом запуске `./cyborg`:

1. проверяет `git`, `npm` и версию Node.js (нужна 24 и новее);
2. ставит зависимости (`npm install` пересобирает нативный модуль терминала под Electron, а Electron докачивает свой бинарь);
3. собирает приложение;
4. открывает окно.

Дальше скрипт ставит зависимости заново только когда меняется `package-lock.json`. Аргументы, которые вы ему передадите, уходят в Electron. Скрипт можно запускать по символьной ссылке из любого каталога, например из `~/bin`.

:::caution[Запускайте из терминала]
Приложение берёт `PATH` процесса, из которого запущено. При запуске из Dock или Finder `gh` и `glab` могут не найтись.
:::

## Обновление

```bash
git pull
./cyborg
```

## macOS

Отдельных шагов нет: `./cyborg` работает как есть. Копирование и вставка в терминале - `Cmd+C` и `Cmd+V`, остальные клавиши на `Cmd` ([все клавиши](/reference/hotkeys/)).

## Linux

Песочнице Chromium нужен либо setuid `chrome-sandbox`, либо непривилегированные user namespaces. Нет ни того, ни другого - `./cyborg` сам добавит `--no-sandbox` и скажет об этом. Чтобы песочница работала, один раз выполните:

```bash
sudo chown root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

## Ручная сборка

Скрипт запуска только оборачивает команды npm. Их можно выполнять и самим:

```bash
npm install
npm run build
npm start
```
