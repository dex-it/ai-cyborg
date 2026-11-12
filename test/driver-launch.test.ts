import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

const driver = resolve(process.cwd(), 'scripts', 'lib', 'driver.mjs');

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('scripts/lib/driver.mjs: запуск Electron', () => {
  it('запуск, не дошедший до порта DevTools, не оставляет процесс Electron', async () => {
    // driver.mjs читает import.meta.dirname, поэтому в сборку теста не входит: проверка идёт в дочернем node с настоящим модулем.
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'cyborg-driver-test-')));
    const pidFile = join(base, 'pid');
    let pid = 0;
    try {
      // Подставной electron: записывает свой pid и молчит (DevTools не слушает), как зависший запуск.
      mkdirSync(join(base, 'node_modules', '.bin'), { recursive: true });
      const electron = join(base, 'node_modules', '.bin', 'electron');
      writeFileSync(electron, '#!/bin/sh\necho $$ > "$PIDFILE"\nexec sleep 60\n');
      chmodSync(electron, 0o755);
      // Каталог данных идёт через окружение, не через текст скрипта: launch() добивает остатки `pkill -f <каталог>`, и на Linux pkill нашёл бы сам дочерний node по аргументу -e.
      const script = `import { launch } from ${JSON.stringify(driver)};
        try { await launch({ dataDir: process.env.DATA_DIR, env: {}, timeout: 1000 }); console.log('запуск удался'); }
        catch (e) { console.log('ошибка: ' + e.message.split('\\n')[0]); }`;
      const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15_000, env: { ...process.env, CYBORG_APP_DIR: base, PIDFILE: pidFile, DATA_DIR: join(base, 'data') } });
      // Живой процесс Electron держит каналы stdout/stderr, и скрипт, получивший ошибку запуска, не завершается сам.
      assert.equal(run.error, undefined, `скрипт после ошибки запуска не завершился за 15 с: ${run.error?.message}`);
      assert.match(run.stdout, /ошибка: не дождались: порт DevTools/, run.stdout + run.stderr);
      assert.ok(existsSync(pidFile), 'подставной electron не запускался');
      pid = Number(readFileSync(pidFile, 'utf8').trim());
      for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
      assert.equal(alive(pid), false, `процесс ${pid} пережил неудавшийся запуск`);
    } finally {
      if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
      rmSync(base, { recursive: true, force: true });
    }
  });
});
