import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RenderTickets } from '../src/renderer/render-ticket';

/** Дерево как в app.ts: render(onlyIfChanged) возвращает null, если ключ статуса тот же, и пишет ключ при ответе. */
function scenario(poll: boolean) {
  const tickets = new RenderTickets();
  let statusKey = '';
  const applied: string[] = [];
  const render = (onlyIfChanged: boolean, name: string) => {
    const ticket = poll || !onlyIfChanged ? tickets.take(onlyIfChanged) : tickets.take(false);
    let finish!: () => void;
    const done = new Promise<void>((r) => (finish = r)).then(() => {
      const fragment = onlyIfChanged && statusKey === 'git-1' ? null : name;
      statusKey = 'git-1';
      if (!fragment || !tickets.valid(ticket)) return;
      applied.push(fragment);
    });
    return { finish, done };
  };
  return { render, applied };
}

describe('RenderTickets', () => {
  it('отрисовка клика берёт новый номер и вытесняет начатую раньше', () => {
    const t = new RenderTickets();
    const first = t.take(false);
    const second = t.take(false);
    assert.equal(t.valid(first), false);
    assert.equal(t.valid(second), true);
  });

  it('опрос номера не занимает: отрисовку клика, начатую раньше, его пустой ответ не отменяет', () => {
    const t = new RenderTickets();
    const click = t.take(false);
    const poll = t.take(true);
    assert.equal(poll, click);
    assert.equal(t.valid(click), true);
  });

  it('клик, начатый после опроса, вытесняет ответ опроса', () => {
    const t = new RenderTickets();
    const poll = t.take(true);
    const click = t.take(false);
    assert.equal(t.valid(poll), false);
    assert.equal(t.valid(click), true);
  });

  it('гонка клика и опроса: опрос стартовал после клика и увидел тот же статус - клик всё равно рисуется', async () => {
    const { render, applied } = scenario(true);
    const click = render(false, 'клик');
    const poll = render(true, 'опрос');
    click.finish();
    await click.done;
    poll.finish();
    await poll.done;
    assert.deepEqual(applied, ['клик']);
  });

  it('прежняя схема (опрос тоже берёт номер) теряет обе отрисовки: тест воспроизводит дефект', async () => {
    const { render, applied } = scenario(false);
    const click = render(false, 'клик');
    const poll = render(true, 'опрос');
    click.finish();
    await click.done;
    poll.finish();
    await poll.done;
    assert.deepEqual(applied, [], 'и клик отброшен номером опроса, и сам опрос пуст');
  });
});
