import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { WaitNotifier } from '../src/renderer/notify';

const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
let data: Map<string, string>;
beforeEach(() => {
  data = new Map();
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
});
afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'localStorage', original);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

const port = () => {
  const calls: string[] = [];
  return {
    calls,
    notify: (id: number, title: string, body: string) => void calls.push(`notify ${id} ${title} ${body}`),
    unnotify: (id: number) => void calls.push(`unnotify ${id}`),
    notificationsState: (enabled: boolean) => void calls.push(`state ${enabled}`),
  };
};

describe('WaitNotifier', () => {
  it('по умолчанию включён и сообщает состояние меню при старте', () => {
    const p = port();
    new WaitNotifier(p);
    assert.deepEqual(p.calls, ['state true']);
  });

  it('уведомляет о сессии, на которую человек не смотрит, и молчит о той, что перед глазами', () => {
    const p = port();
    const n = new WaitNotifier(p);
    n.waiting(1, 'CC1', 'ждёт', true);
    n.waiting(2, 'CC2', 'ждёт', false);
    assert.deepEqual(p.calls.slice(1), ['notify 2 CC2 ждёт']);
  });

  it('гасит только показанное и только раз', () => {
    const p = port();
    const n = new WaitNotifier(p);
    n.dismiss(1);
    n.waiting(1, 'CC1', 'ждёт', false);
    n.dismiss(1);
    n.dismiss(1);
    assert.deepEqual(p.calls.slice(1), ['notify 1 CC1 ждёт', 'unnotify 1']);
  });

  it('выключенный не уведомляет; выключатель переживает перезапуск', () => {
    const p = port();
    const n = new WaitNotifier(p);
    n.waiting(1, 'CC1', 'ждёт', false);
    n.setEnabled(false);
    n.waiting(2, 'CC2', 'ждёт', false);
    n.dismiss(1);
    assert.deepEqual(p.calls.slice(1), ['notify 1 CC1 ждёт', 'state false']);
    const restarted = port();
    new WaitNotifier(restarted).waiting(3, 'CC3', 'ждёт', false);
    assert.deepEqual(restarted.calls, ['state false']);
  });

  it('недоступное хранилище - включён, переключение действует до закрытия окна', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: { getItem: () => { throw new Error('нет'); }, setItem: () => { throw new Error('нет'); } },
      configurable: true,
      writable: true,
    });
    const p = port();
    const n = new WaitNotifier(p);
    n.setEnabled(false);
    n.waiting(1, 'CC1', 'ждёт', false);
    assert.deepEqual(p.calls, ['state true', 'state false']);
  });
});
