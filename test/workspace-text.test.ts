import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canCreateWorkspace, defaultWorkspaceFile, projectsProblemText, withDirectory } from '../src/renderer/workspace-text';

describe('projectsProblemText', () => {
  const file = '/work/team.cyborg.json';
  it('недоступный файл: называет путь воркспейса, не каталог данных', () => {
    const text = projectsProblemText({ kind: 'unreadable', detail: 'EACCES' }, file);
    assert.ok(text.includes(file));
    assert.ok(!text.includes('каталоге данных'));
  });
  it('повреждённый файл: называет копию и место, куда её положить', () => {
    const text = projectsProblemText({ kind: 'corrupt', detail: 'x', copy: `${file}.corrupt-20261026T080000` }, file);
    assert.ok(text.includes(`${file}.corrupt-20261026T080000`));
    assert.ok(text.includes(`на место ${file}`));
    assert.ok(!text.includes('каталоге данных'));
  });
  it('прежний projects.json называется фактическим путём', () => {
    assert.ok(projectsProblemText({ kind: 'unreadable', detail: 'EIO' }, '/ud/projects.json').includes('/ud/projects.json'));
  });
});

describe('окно создания воркспейса', () => {
  it('файл по умолчанию - в домашнем каталоге; запрещённые символы имени отбрасываются', () => {
    assert.equal(defaultWorkspaceFile('Команда', '/home/u', '/'), '/home/u/Команда.cyborg.json');
    assert.equal(defaultWorkspaceFile('a/b:c', '/home/u', '/'), '/home/u/abc.cyborg.json');
    assert.equal(defaultWorkspaceFile('/\\:*?', '/home/u', '/'), '');
  });
  it('«Папка…» меняет только каталог', () => {
    assert.equal(withDirectory('/home/u/team.cyborg.json', '/srv/ws/', '/'), '/srv/ws/team.cyborg.json');
    assert.equal(withDirectory('C:\\u\\team.cyborg.json', 'D:\\ws', '\\'), 'D:\\ws\\team.cyborg.json');
  });
  it('«Создать» доступна при имени, файле, названии и хотя бы одном репозитории', () => {
    const full = { name: 'w', file: '/f', projectName: 'p', repos: ['/r'] };
    assert.equal(canCreateWorkspace(full), true);
    assert.equal(canCreateWorkspace({ ...full, repos: [] }), false);
    assert.equal(canCreateWorkspace({ ...full, name: '   ' }), false);
    assert.equal(canCreateWorkspace({ ...full, file: '' }), false);
    assert.equal(canCreateWorkspace({ ...full, projectName: ' ' }), false);
  });
});
