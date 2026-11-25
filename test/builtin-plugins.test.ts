import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BuiltinPlugins, CORE_PLUGIN, hooksOf } from '../src/main/builtin-plugins';
import { EXECUTION_SKILL, PARALLEL_SKILL } from '../src/main/claude-args';

function fixture(t: { after: (fn: () => void) => void }, names: string[]): { root: string; file: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-builtin-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'plugins');
  for (const name of names) {
    fs.mkdirSync(path.join(root, name, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(root, name, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, description: `про ${name}`, version: '0.1.0' }));
  }
  fs.mkdirSync(path.join(root, 'no-manifest'), { recursive: true });
  return { root, file: path.join(base, 'builtin-plugins.json') };
}

describe('встроенные плагины Cyborg', () => {
  it('ядро первым, остальные по алфавиту; каталог без манифеста не плагин', (t) => {
    const { root, file } = fixture(t, ['zeta', 'cyborg', 'alpha']);
    const store = new BuiltinPlugins(root, file);
    assert.deepEqual(store.names(), ['cyborg', 'alpha', 'zeta']);
    assert.deepEqual(store.forSession(), { dirs: ['cyborg', 'alpha', 'zeta'].map((n) => path.join(root, n)), core: true });
  });

  it('выключенный плагин не идёт в сессию и помечен в списке; выбор переживает новый экземпляр', async (t) => {
    const { root, file } = fixture(t, ['cyborg', 'cyborg-limits']);
    const store = new BuiltinPlugins(root, file);
    const list = await store.set('cyborg', false);
    assert.deepEqual(list.map((p) => [p.name, p.enabled, p.core]), [['cyborg', false, true], ['cyborg-limits', true, false]]);
    const again = new BuiltinPlugins(root, file);
    assert.deepEqual(again.forSession(), { dirs: [path.join(root, 'cyborg-limits')], core: false });
    await again.set('cyborg', true);
    assert.deepEqual(again.forSession().core, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { disabled: [] });
  });

  it('неизвестное имя и негодные аргументы отклоняются, файл не пишется', async (t) => {
    const { root, file } = fixture(t, ['cyborg']);
    const store = new BuiltinPlugins(root, file);
    for (const [name, enabled] of [['nope', false], ['no-manifest', false], ['../cyborg', false], ['cyborg', 'false'], [1, true]] as const) {
      await assert.rejects(store.set(name, enabled), /Такого встроенного плагина нет/);
    }
    assert.equal(fs.existsSync(file), false);
  });

  it('повреждённый файл выбора - все плагины включены; нет каталога плагинов - сессия без них', (t) => {
    const { root, file } = fixture(t, ['cyborg']);
    fs.writeFileSync(file, '{oops');
    assert.equal(new BuiltinPlugins(root, file).forSession().dirs.length, 1);
    assert.deepEqual(new BuiltinPlugins(path.join(root, 'missing'), file).forSession(), { dirs: [], core: false });
  });

  it('хуки: событие со скриптами классического хука и файл модуля мода', () => {
    const hooks = hooksOf({
      hooks: { PostToolUse: [{ matcher: 'EnterWorktree', hooks: [{ type: 'command', command: 'bash "${CLAUDE_PLUGIN_ROOT}/hooks/lsp-reap.sh"' }] }], Stop: [] },
      modules: ['./limits-footer.tsx'],
    });
    assert.deepEqual(hooks, [
      { kind: 'hook', name: 'PostToolUse · lsp-reap.sh' },
      { kind: 'hook', name: 'Stop' },
      { kind: 'mod', name: 'limits-footer.tsx' },
    ]);
    assert.deepEqual(hooksOf(null), []);
  });

  it('плагины поставки: имя манифеста совпадает с каталогом, ядро несёт скилл инструкции параллельных сессий', async () => {
    const store = new BuiltinPlugins(path.join(process.cwd(), 'plugins'), path.join(os.tmpdir(), `cyborg-builtin-${process.pid}-none.json`));
    const list = await store.list();
    assert.equal(list[0].name, CORE_PLUGIN);
    assert.equal(PARALLEL_SKILL.split(':')[0], CORE_PLUGIN);
    for (const p of list) assert.equal(JSON.parse(fs.readFileSync(path.join('plugins', p.name, '.claude-plugin', 'plugin.json'), 'utf8')).name, p.name);
    for (const skill of [PARALLEL_SKILL, EXECUTION_SKILL]) assert.ok(list[0].components.some((c) => c.kind === 'skill' && `${CORE_PLUGIN}:${c.name}` === skill), skill);
    assert.ok(list.find((p) => p.name === 'cyborg-limits')?.hooks.some((h) => h.kind === 'mod'));
  });
});
