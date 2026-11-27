import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { LOGIN_GATE } from '../src/main/claude-args';

function rig(t: { after: (fn: () => void) => void }, loggedIn: boolean | 'broken') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'calls.log');
  const status = loggedIn === 'broken' ? 'exit 1' : `printf '{\\n  "loggedIn": ${loggedIn},\\n  "apiProvider": "firstParty"\\n}\\n'`;
  fs.writeFileSync(path.join(dir, 'claude'), `#!/bin/sh\necho "$*" >> "${log}"\n[ "$1 $2" = "auth status" ] && { ${status}; }\nexit 0\n`, { mode: 0o755 });
  return (input: string, env: Record<string, string> = {}) => {
    const clean = { ...process.env };
    for (const name of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) delete clean[name];
    const r = spawnSync('/bin/sh', ['-c', `${LOGIN_GATE}\nexec claude --session`], { input, encoding: 'utf8', env: { ...clean, PATH: `${dir}:${process.env.PATH}`, ...env } });
    return { code: r.status, out: r.stdout, calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [] };
  };
}

describe('проверка входа перед запуском локальной сессии', () => {
  it('залогинен - сессия запускается сразу, без вопроса', (t) => {
    const r = rig(t, true)('');
    assert.deepEqual(r.calls, ['auth status --json', '--session']);
    assert.equal(r.out, '');
  });

  it('не залогинен - вопрос, Enter запускает вход, после входа - сессия', (t) => {
    const r = rig(t, false)('\n');
    assert.match(r.out, /не залогинен/);
    assert.deepEqual(r.calls, ['auth status --json', 'auth login', '--session']);
  });

  it('не залогинен и ввод закрыт - сессия не запускается', (t) => {
    const r = rig(t, false)('');
    assert.equal(r.code, 1);
    assert.deepEqual(r.calls, ['auth status --json']);
  });

  it('токен в окружении - проверки нет', (t) => {
    const r = rig(t, false)('', { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-x' });
    assert.deepEqual(r.calls, ['--session']);
  });

  it('проверка сломалась - запуск не держит', (t) => {
    const r = rig(t, 'broken')('');
    assert.deepEqual(r.calls, ['auth status --json', '--session']);
  });
});
