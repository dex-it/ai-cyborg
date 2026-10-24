import { cpSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

rmSync('dist', { recursive: true, force: true });

const common = { bundle: true, sourcemap: true, logLevel: 'info' };

await build({
  ...common,
  entryPoints: ['src/main/main.ts'],
  outfile: 'dist/main.js',
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron', 'node-pty'],
});
await build({
  ...common,
  entryPoints: ['src/main/preload.ts'],
  outfile: 'dist/preload.js',
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
});
await build({
  ...common,
  entryPoints: ['src/renderer/app.ts'],
  outfile: 'dist/renderer/app.js',
  platform: 'browser',
  format: 'iife',
  target: 'chrome130',
});

cpSync('assets/icon.png', 'dist/icon.png');
cpSync('src/renderer/index.html', 'dist/renderer/index.html');
cpSync('src/renderer/styles.css', 'dist/renderer/styles.css');
cpSync('node_modules/@xterm/xterm/css/xterm.css', 'dist/renderer/xterm.css');
// Monaco грузится своим AMD-загрузчиком из min-сборки: так не нужно бандлить его воркеры.
cpSync('node_modules/monaco-editor/min/vs', 'dist/renderer/vs', { recursive: true });
