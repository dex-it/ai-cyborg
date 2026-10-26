import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { windowTitle } from '../src/renderer/title';

describe('windowTitle', () => {
  it('с проектом: проект первым, затем приложение с версией', () => {
    assert.equal(windowTitle('0.1.0+5c98807', 'Маркетплейс'), 'Маркетплейс - Cyborg v.0.1.0+5c98807');
  });

  it('без проекта: только приложение с версией', () => {
    assert.equal(windowTitle('0.1.0', null), 'Cyborg v.0.1.0');
    assert.equal(windowTitle('0.1.0', ''), 'Cyborg v.0.1.0');
  });
});
