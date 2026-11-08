import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { imageSource, isMarkdown, joinPath, resolveLink, slugger } from '../src/renderer/md-links';

const file = '/repo/docs/guide/intro.md';
const root = '/repo';

describe('resolveLink', () => {
  it('http(s) - в браузер, якорь - внутри документа', () => {
    assert.deepEqual(resolveLink('https://example.com/a?b#c', file, root), { kind: 'web', url: 'https://example.com/a?b#c' });
    assert.deepEqual(resolveLink('HTTP://x.org', file, root), { kind: 'web', url: 'HTTP://x.org' });
    assert.deepEqual(resolveLink('#Установка%20и%20запуск', file, root), { kind: 'anchor', id: 'Установка и запуск' });
    assert.deepEqual(resolveLink('#', file, root), { kind: 'none' });
  });

  it('относительный путь - от каталога документа, /путь - от корня дерева; запрос и якорь отброшены, #L12 - строка', () => {
    assert.deepEqual(resolveLink('setup.md', file, root), { kind: 'file', path: '/repo/docs/guide/setup.md' });
    assert.deepEqual(resolveLink('./img/../setup.md?raw=1#section', file, root), { kind: 'file', path: '/repo/docs/guide/setup.md' });
    assert.deepEqual(resolveLink('../../src/main.ts#L12', file, root), { kind: 'file', path: '/repo/src/main.ts', line: 12 });
    assert.deepEqual(resolveLink('/README.md', file, root), { kind: 'file', path: '/repo/README.md' });
    assert.deepEqual(resolveLink('my%20notes.md', file, root), { kind: 'file', path: '/repo/docs/guide/my notes.md' });
  });

  it('прочие схемы, протокол-относительные и пустые ссылки никуда не ведут', () => {
    for (const href of ['javascript:alert(1)', 'file:///etc/passwd', 'mailto:a@b', 'vscode://x', '//evil.com/a', '?x', '']) {
      assert.deepEqual(resolveLink(href, file, root), { kind: 'none' }, href);
    }
  });
});

describe('imageSource', () => {
  it('локальная картинка - file:// от каталога документа с экранированием имени, data:image - как есть', () => {
    assert.equal(imageSource('img/a b.png', file, root), 'file:///repo/docs/guide/img/a%20b.png');
    assert.equal(imageSource('img/a%23b.png#frag', file, root), 'file:///repo/docs/guide/img/a%23b.png');
    assert.equal(imageSource('../shot.png?v=2', file, root), 'file:///repo/docs/shot.png');
    assert.equal(imageSource('/assets/logo.svg', file, root), 'file:///repo/assets/logo.svg');
    assert.equal(imageSource('data:image/png;base64,AAAA', file, root), 'data:image/png;base64,AAAA');
  });

  it('из сети и чужие схемы не грузятся', () => {
    for (const src of ['https://tracker.example/pixel.gif', 'http://x/a.png', '//cdn.example/a.png', 'file:///etc/a.png', 'data:text/html,x', '']) {
      assert.equal(imageSource(src, file, root), null, src);
    }
  });
});

describe('joinPath, slugger, isMarkdown', () => {
  it('.. выше корня останавливается на корне', () => {
    assert.equal(joinPath('/repo', '../../../etc/hosts'), '/etc/hosts');
    assert.equal(joinPath('/', '..'), '/');
  });

  it('якоря как на GitHub: строчные, без знаков, повтор с суффиксом', () => {
    const slug = slugger();
    assert.equal(slug('Установка и запуск!'), 'установка-и-запуск');
    assert.equal(slug('API: v2.0'), 'api-v20');
    assert.equal(slug('API: v2.0'), 'api-v20-1');
    assert.equal(slug('snake_case-name'), 'snake_case-name');
  });

  it('Markdown по расширению без учёта регистра', () => {
    assert.equal(isMarkdown('/a/README.md'), true);
    assert.equal(isMarkdown('/a/x.MARKDOWN'), true);
    assert.equal(isMarkdown('/a/md'), false);
    assert.equal(isMarkdown('/a/x.mdx'), false);
  });
});
