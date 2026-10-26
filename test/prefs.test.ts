import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { readChoice, readPref, writePref } from '../src/renderer/prefs';

const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const useStorage = (storage: unknown) => Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'localStorage', original);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
};
const blocked = {
  getItem: () => {
    throw new Error('хранилище недоступно');
  },
  setItem: () => {
    throw new Error('хранилище недоступно');
  },
};

describe('настройки окна (prefs)', () => {
  it('записанное значение читается обратно, нет ключа - null', () => {
    useStorage(memory());
    assert.equal(readPref('cyborg.x'), null);
    writePref('cyborg.x', '5');
    assert.equal(readPref('cyborg.x'), '5');
  });

  it('хранилище недоступно: чтение даёт null, запись не бросает - настройка действует до закрытия окна', () => {
    useStorage(blocked);
    assert.equal(readPref('cyborg.x'), null);
    assert.doesNotThrow(() => writePref('cyborg.x', '5'));
  });

  it('readChoice: допустимое сохранённое значение берётся, снятый вариант, мусор и пусто - значение по умолчанию', () => {
    useStorage(memory());
    const allowed = ['updated', 'created', 'number'] as const;
    assert.equal(readChoice('cyborg.tasks.sort', allowed, 'updated'), 'updated');
    writePref('cyborg.tasks.sort', 'number');
    assert.equal(readChoice('cyborg.tasks.sort', allowed, 'updated'), 'number');
    writePref('cyborg.tasks.sort', 'removed-in-this-version');
    assert.equal(readChoice('cyborg.tasks.sort', allowed, 'updated'), 'updated');
    writePref('cyborg.tasks.sort', '');
    assert.equal(readChoice('cyborg.tasks.sort', allowed, 'created'), 'created');
  });

  it('readChoice при недоступном хранилище - значение по умолчанию', () => {
    useStorage(blocked);
    assert.equal(readChoice('cyborg.mrs.filter', ['all', 'mine'] as const, 'all'), 'all');
  });
});
