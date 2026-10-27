import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { claudeArgs, SESSION_PROMPT } from '../src/main/claude-args';
import { deleteHistory, historyExists, journalFacts, listHistory, projectDirName } from '../src/main/history';
import { ago } from '../src/renderer/ago';

const line = (record: object): string => JSON.stringify(record);
const ID_A = '11111111-1111-1111-1111-111111111111';
const ID_B = '22222222-2222-2222-2222-222222222222';
const ID_C = '33333333-3333-3333-3333-333333333333';

describe('история сессий', () => {
  it('projectDirName: всё, кроме букв и цифр, - «-», как каталоги ~/.claude/projects', () => {
    assert.equal(projectDirName('/home/mmx/Work/Cyborg'), '-home-mmx-Work-Cyborg');
    assert.equal(projectDirName('/a/b.c_d'), '-a-b-c-d');
  });

  it('journalFacts: custom-title старше ai-title, тот старше первого запроса; служебная разметка - не запрос', () => {
    const head = [
      line({ type: 'user', entrypoint: 'cli', message: { content: '<local-command-caveat>x</local-command-caveat>' } }),
      line({ type: 'user', isMeta: true, message: { content: 'meta' } }),
      line({ type: 'user', message: { content: [{ type: 'text', text: '  почини\n дерево  ' }] } }),
    ].join('\n');
    assert.deepEqual(journalFacts(head, ''), { interactive: true, title: 'почини дерево' });
    const tail = ['{"обрезано', line({ type: 'ai-title', aiTitle: 'AI' }), line({ type: 'custom-title', customTitle: 'Моё' })].join('\n');
    assert.equal(journalFacts(head, tail).title, 'Моё');
    assert.equal(journalFacts(head, line({ type: 'ai-title', aiTitle: 'AI' })).title, 'AI');
  });

  it('journalFacts: сессия SDK не интерактивна', () => {
    assert.equal(journalFacts(line({ type: 'user', entrypoint: 'sdk-py', message: { content: 'ревью' } }), '').interactive, false);
  });

  it('listHistory: только интерактивные с заголовком, свежие первыми; лимит; чужие файлы мимо', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-history-'));
    try {
      const repo = '/w/repo';
      const dir = path.join(root, projectDirName(repo));
      fs.mkdirSync(dir);
      const write = (name: string, content: string, mtime: number) => {
        const file = path.join(dir, name);
        fs.writeFileSync(file, content);
        fs.utimesSync(file, mtime, mtime);
      };
      const prompt = (text: string, entrypoint = 'cli') => line({ type: 'user', entrypoint, message: { content: text } });
      write(`${ID_A}.jsonl`, prompt('старая'), 1000);
      write(`${ID_B}.jsonl`, prompt('новая'), 2000);
      write(`${ID_C}.jsonl`, prompt('фоновая', 'sdk-py'), 3000);
      write('not-a-session.jsonl', prompt('x'), 4000);
      const list = listHistory([repo, '/w/none'], root);
      assert.deepEqual(
        list.map((e) => [e.id, e.title, e.repo]),
        [
          [ID_B, 'новая', repo],
          [ID_A, 'старая', repo],
        ],
      );
      assert.equal(listHistory([repo], root, 1).length, 1);
      assert.equal(historyExists(repo, ID_A, root), true);
      assert.equal(historyExists(repo, '../x', root), false);
      assert.equal(historyExists('/w/none', ID_A, root), false);
      fs.mkdirSync(path.join(dir, ID_A, 'subagents'), { recursive: true });
      deleteHistory(repo, ID_A, root);
      assert.equal(fs.existsSync(path.join(dir, ID_A)), false);
      assert.deepEqual(listHistory([repo], root).map((e) => e.id), [ID_B]);
      assert.throws(() => deleteHistory(repo, ID_A, root));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('сессии worktree: журнал в каталоге <репозиторий>--claude-worktrees-<имя> виден, возобновляется и удаляется', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-history-'));
    try {
      const repo = '/w/repo';
      const prompt = (text: string) => line({ type: 'user', entrypoint: 'cli', message: { content: text } });
      const journal = (dirName: string, id: string, text: string) => {
        const dir = path.join(root, dirName);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${id}.jsonl`), prompt(text));
        return dir;
      };
      // раскладка настоящего Claude Code: worktree - <repo>/.claude/worktrees/<имя>
      const wtDir = projectDirName(`${repo}/.claude/worktrees/create-a-txt`);
      assert.equal(wtDir, `${projectDirName(repo)}--claude-worktrees-create-a-txt`);
      journal(projectDirName(repo), ID_A, 'в репозитории');
      const wt = journal(wtDir, ID_B, 'в worktree');
      journal(projectDirName('/w/repo2'), ID_C, 'чужой репозиторий с похожим именем');
      journal(`${projectDirName('/w/repo2')}--claude-worktrees-x`, ID_C, 'worktree чужого репозитория');

      assert.deepEqual(listHistory([repo], root).map((e) => [e.id, e.repo]).sort(), [[ID_A, repo], [ID_B, repo]]);
      assert.equal(historyExists(repo, ID_B, root), true);
      assert.equal(historyExists('/w/other', ID_B, root), false);

      fs.mkdirSync(path.join(wt, ID_B, 'subagents'), { recursive: true });
      deleteHistory(repo, ID_B, root);
      assert.equal(fs.existsSync(path.join(wt, `${ID_B}.jsonl`)), false);
      assert.equal(fs.existsSync(path.join(wt, ID_B)), false);
      assert.deepEqual(listHistory([repo], root).map((e) => e.id), [ID_A]);
      assert.throws(() => deleteHistory(repo, ID_B, root));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('claudeArgs: --resume с id стоит до --add-dir', () => {
    assert.deepEqual(claudeArgs(['/b'], undefined, ID_A), ['--resume', ID_A, '--append-system-prompt', SESSION_PROMPT, '--add-dir', '/b']);
  });

  it('ago: минуты, часы, дни', () => {
    const now = 10 * 24 * 3600_000;
    assert.equal(ago(now - 10_000, now), 'только что');
    assert.equal(ago(now - 5 * 60_000, now), '5 мин');
    assert.equal(ago(now - 3 * 3600_000, now), '3 ч');
    assert.equal(ago(now - 2 * 24 * 3600_000, now), '2 дн');
  });
});
