# Сырые результаты замеров базы (PL-09)

Числа документа [`cyborg-baseline.md`](https://github.com/dex-it/cyborg-harness/blob/master/docs/05-verification/cyborg-baseline.md) (репозиторий cyborg-harness, PR #108) пересчитываются из этих файлов. Среда: MacBookPro18,1, Apple M1 Pro, macOS 27.2, Electron 45.0.0, нагрузка 6-12 (поля `environment` в JSON). Файлы не перезаписывать: новые замеры класть рядом под другим именем.

| Файл | Что это |
|---|---|
| `bench-e4beb72.json` | `node scripts/bench.mjs --runs 5 --json ...` на `b9b0921` (`src` и `test` равны `e4beb72`): `runs` - 5 сырых прогонов, `summary` - минимум, медиана, максимум, `environment` - среда и load average по прогонам. Из него собраны все таблицы документа, кроме контрольной сборки |
| `bench-e4beb72.log` | вывод той же команды (сводная таблица) |
| `bench-control.json` | контрольная серия: только сценарий `pending` на 800 000 и 1 600 000 строк, на временной сборке, где `pendingData` копируется через `push` (контроль квадратичности; сборка в репозиторий не входит), 5 прогонов сразу после основной серии; поле `commit` пусто, потому что сборка не из коммита |
| `measure-ai-cyborg.log`, `measure-cyborg-harness.log` | `node scripts/measure.mjs --workspace <файл> --userdata <каталог> --project <имя> --runs 5` с настоящим `gh`, два проекта одного воркспейса; путь воркспейса заменён на `<каталог>` |
| `parity-e4beb72-1.log`, `parity-e4beb72-2.log` | два подряд прогона `CYBORG_APP_DIR=<worktree e4beb72> node scripts/parity.mjs` |

Бюджеты в документе пересчитываются по `summary`: «не более» - 1,1 × медиана, «не менее» - 0,9 × медиана, затем округление до трёх значащих цифр: «не более» вверх, «не менее» вниз.
