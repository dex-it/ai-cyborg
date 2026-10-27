import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canCreateWorkspace, defaultWorkspaceFile, fileAfterDir, fileAfterEdit, fileAfterName, initialFileField, projectsProblemText, withDirectory } from '../src/renderer/workspace-text';

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

describe('поле файла окна создания', () => {
  it('«Папка…», затем имя: файл в выбранной папке по имени', () => {
    let field = fileAfterDir(initialFileField('/home/u'), '', '/srv/ws', '/');
    assert.equal(field.value, '/srv/ws/workspace.cyborg.json');
    field = fileAfterName(field, 'Team', '/');
    assert.equal(field.value, '/srv/ws/Team.cyborg.json');
  });
  it('имя, «Папка…», правка имени: папка сохраняется, имя файла меняется', () => {
    let field = fileAfterName(initialFileField('/home/u'), 'Team', '/');
    field = fileAfterDir(field, 'Team', '/srv/ws', '/');
    assert.equal(field.value, '/srv/ws/Team.cyborg.json');
    field = fileAfterName(field, 'Crew', '/');
    assert.equal(field.value, '/srv/ws/Crew.cyborg.json');
  });
  it('правка поля руками отвязывает путь от имени, «Папка…» меняет только каталог', () => {
    let field = fileAfterEdit(initialFileField('/home/u'), '/a/mine.json');
    field = fileAfterName(field, 'Team', '/');
    assert.equal(field.value, '/a/mine.json');
    field = fileAfterDir(field, 'Team', '/srv/ws', '/');
    assert.equal(field.value, '/srv/ws/mine.json');
  });
});
