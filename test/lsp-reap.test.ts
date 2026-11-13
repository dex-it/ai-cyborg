import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const script = path.join(process.cwd(), 'plugin', 'hooks', 'lsp-reap.sh');
const hooks = path.join(process.cwd(), 'plugin', 'hooks', 'hooks.json');

function alive(pid: number): boolean {
  try {
    return !/^\d+ \(.*\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return false;
  }
}

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`не дождались: ${what}`);
}

function children(pid: number): number[] {
  const out = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout;
  return out.split('\n').filter(Boolean).map(Number);
}

function reap(root: number, payload: object): string {
  const run = spawnSync('bash', [script], {
    encoding: 'utf8',
    input: JSON.stringify(payload),
    env: { ...process.env, LSP_REAP_ROOT: String(root) },
  });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}

describe('хук плагина lsp-reap', () => {
  it('подключён к PostToolUse смены каталога и Bash', () => {
    const cfg = JSON.parse(fs.readFileSync(hooks, 'utf8'));
    const [entry] = cfg.hooks.PostToolUse;
    assert.equal(entry.matcher, 'EnterWorktree|ExitWorktree|Bash');
    assert.match(entry.hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/lsp-reap\.sh/);
  });

  it('гасит сервер удалённого каталога, а после смены worktree и сервер чужого', { skip: process.platform !== 'linux' }, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-lsp-reap-'));
    const [a, b, c] = ['a', 'b', 'c'].map((n) => path.join(dir, n));
    for (const d of [a, b, c]) fs.mkdirSync(d);
    const pids = path.join(dir, 'pids');
    const body = [
      `(cd '${a}' && exec -a typescript-language-server bash -c 'sleep 600 & wait') & echo "tls $!" >> '${pids}'`,
      `(cd '${a}' && exec bash -c 'sleep 600; : language-server') & echo "decoy $!" >> '${pids}'`,
      `(cd '${b}' && exec -a /usr/bin/gopls sleep 600) & echo "gopls $!" >> '${pids}'`,
      `(cd '${c}' && exec -a csharp-ls sleep 600) & echo "csls $!" >> '${pids}'`,
      'wait',
    ].join('\n');
    const root = spawn('bash', ['-c', body], { detached: true, stdio: 'ignore' });
    t.after(() => {
      try { process.kill(-root.pid!, 'SIGKILL'); } catch { /* уже нет */ }
      fs.rmSync(dir, { recursive: true, force: true });
    });

    await until(() => fs.existsSync(pids) && fs.readFileSync(pids, 'utf8').trim().split('\n').length === 4, 'запуск серверов');
    const pid = Object.fromEntries(fs.readFileSync(pids, 'utf8').trim().split('\n').map((l) => {
      const [name, p] = l.split(' ');
      return [name, Number(p)];
    }));
    await until(() => children(pid.tls).length === 1, 'потомок сервера');
    const tlsChild = children(pid.tls)[0];

    fs.rmSync(a, { recursive: true, force: true });
    const out = reap(root.pid!, { tool_name: 'Bash', cwd: b });
    const msg = JSON.parse(out).systemMessage as string;
    assert.ok(msg.includes(`${pid.tls} ${a}`), msg);
    await until(() => !alive(pid.tls) && !alive(tlsChild), 'остановка сервера удалённого каталога и его потомка');
    assert.ok(alive(pid.decoy), 'процесс со словом language-server только в тексте команды не сервер');
    assert.ok(alive(pid.gopls) && alive(pid.csls), 'при Bash живые каталоги не трогаются');

    assert.equal(reap(root.pid!, { tool_name: 'Bash', cwd: b }), '', 'убирать нечего - вывода нет');

    reap(root.pid!, { tool_name: 'EnterWorktree', cwd: c });
    await until(() => !alive(pid.gopls), 'остановка сервера прежнего каталога после EnterWorktree');
    assert.ok(alive(pid.csls), 'сервер в текущем каталоге остаётся');
  });
});
