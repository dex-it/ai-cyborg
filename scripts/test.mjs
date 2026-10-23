// Тесты на встроенном node:test, без новых зависимостей: esbuild собирает каждый test/*.test.ts во временный каталог.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

const only = process.argv.slice(2);
const entries = readdirSync('test')
  .filter((name) => name.endsWith('.test.ts') && (!only.length || only.some((o) => name.includes(o))))
  .map((name) => join('test', name));
const out = mkdtempSync(join(tmpdir(), 'cyborg-test-'));
try {
  await build({ entryPoints: entries, outdir: out, bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron', 'node-pty'], logLevel: 'warning' });
  const files = entries.map((e) => join(out, e.replace(/^test\//, '').replace(/\.ts$/, '.js')));
  const run = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
  process.exitCode = run.status ?? 1;
} finally {
  rmSync(out, { recursive: true, force: true });
}
