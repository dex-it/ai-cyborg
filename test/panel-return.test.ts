import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { returnTarget } from '../src/renderer/panel-return';
import { RowMarks } from '../src/renderer/row-marks';

class FakeRow {
  classes = new Set<string>();
  scrolled = 0;
  classList = {
    toggle: (c: string, on?: boolean) => {
      if (on ?? !this.classes.has(c)) this.classes.add(c);
      else this.classes.delete(c);
    },
  };
  scrollIntoView() {
    this.scrolled++;
  }
}
const row = () => new FakeRow() as unknown as HTMLElement & FakeRow;

describe('returnTarget', () => {
  it('сессия по PR GitHub ведёт на вкладку MR/PR, по MR GitLab - с «!»', () => {
    assert.deepEqual(returnTarget({ mr: { key: 'k1', kind: 'github', number: 12 } }), {
      tab: 'mrs',
      key: 'k1',
      label: 'К #12 в списке',
      title: 'Открыть список MR/PR на #12',
    });
    assert.equal(returnTarget({ mr: { key: 'k2', kind: 'gitlab', number: 7 } })?.label, 'К !7 в списке');
  });

  it('сессия по задаче ведёт на вкладку задач; обычная сессия и сессия Jira - никуда', () => {
    assert.deepEqual(returnTarget({ task: { key: 't1', number: 5 } }), { tab: 'tasks', key: 't1', label: 'К #5 в списке', title: 'Открыть список задач на #5' });
    assert.equal(returnTarget({}), null);
  });
});

describe('RowMarks', () => {
  it('метка подсвечивает строку, переходит на другую и снимается', () => {
    const marks = new RowMarks();
    const a = row();
    const b = row();
    marks.register('a', a);
    marks.register('b', b);
    marks.set('a');
    assert.ok(a.classes.has('returned') && !b.classes.has('returned'));
    marks.set('b');
    assert.ok(!a.classes.has('returned') && b.classes.has('returned'));
    marks.set(null);
    assert.ok(!a.classes.has('returned') && !b.classes.has('returned'));
  });

  it('метка переживает перерисовку: новая строка с тем же ключом подсвечена сразу', () => {
    const marks = new RowMarks();
    marks.register('a', row());
    marks.set('a');
    marks.clear();
    const fresh = row();
    marks.register('a', fresh);
    assert.ok(fresh.classes.has('returned'));
  });

  it('reveal показывает строку; если строки нет в списке - false, а метка остаётся до её появления', () => {
    const marks = new RowMarks();
    const a = row();
    marks.register('a', a);
    assert.equal(marks.reveal('a'), true);
    assert.equal(a.scrolled, 1);
    assert.equal(marks.reveal('gone'), false);
    const later = row();
    marks.clear();
    marks.register('gone', later);
    assert.ok(later.classes.has('returned'));
  });
});
