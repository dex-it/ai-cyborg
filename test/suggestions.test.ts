import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SESSION_PROMPT, claudeArgs } from '../src/main/claude-args';
import { LABEL_MAX, TEXT_MAX } from '../src/main/commands';
import { parseSuggestions, SUGGEST_MAX, SUGGEST_PROMPT } from '../src/main/suggestions';

const tail = (json: string, before = 'Готово.\n\n'): string => `${before}<!-- cyborg-buttons: ${json} -->`;
const button = { label: 'Тест', text: 'напиши тест' };

describe('Кнопки от модели: разбор хвоста ответа', () => {
  it('комментарий в конце ответа даёт кнопки без Enter; конечные пробелы и переводы строки не мешают', () => {
    assert.deepEqual(parseSuggestions(tail(JSON.stringify([button])) + '\n \n'), [{ ...button, submit: false }]);
    assert.deepEqual(parseSuggestions(`<!-- cyborg-buttons:[{"label":"A","text":"a","description":"д"}]-->`), [{ label: 'A', text: 'a', submit: false, description: 'д' }]);
  });

  it('Enter, сочетание и отключение от модели не принимаются: поля отбрасываются', () => {
    const [one] = parseSuggestions(tail(JSON.stringify([{ ...button, submit: true, hotkey: 'Alt+S', disabled: true, extra: 1 }])));
    assert.deepEqual(one, { ...button, submit: false });
  });

  it('комментарий не в конце ответа (процитированный из файла) не в счёт; нужен самый последний', () => {
    assert.deepEqual(parseSuggestions(tail(JSON.stringify([button])) + '\nещё текст'), []);
    const two = tail(JSON.stringify([{ label: 'Старая', text: 'с' }])) + '\n' + tail(JSON.stringify([button]), '');
    assert.deepEqual(parseSuggestions(two).map((b) => b.label), ['Тест']);
  });

  it('не JSON, не массив, пустое тело, нет маркера и не строка - пусто, без исключения', () => {
    for (const message of [tail('[{'), tail('{"label":"A","text":"a"}'), tail(''), 'просто ответ', '<!-- cyborg-buttons: [] -->', undefined, null, 5]) {
      assert.deepEqual(parseSuggestions(message), [], String(message));
    }
  });

  it('негодные записи отбрасываются по правилам кнопок файла, годные остаются', () => {
    const json = JSON.stringify([
      { label: '', text: 'a' },
      { label: 'я'.repeat(LABEL_MAX + 1), text: 'a' },
      { label: 'B', text: 'a\nb' },
      { label: 'C', text: 'я'.repeat(TEXT_MAX + 1) },
      'строка',
      null,
      { label: 'D', text: 'годная' },
    ]);
    assert.deepEqual(parseSuggestions(tail(json)), [{ label: 'D', text: 'годная', submit: false }]);
  });

  it(`не больше ${SUGGEST_MAX} кнопок, повтор подписи (без учёта регистра) отбрасывается`, () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ label: `К${i}`, text: `т${i}` }));
    assert.deepEqual(parseSuggestions(tail(JSON.stringify(many))).map((b) => b.label), ['К0', 'К1', 'К2', 'К3']);
    assert.deepEqual(parseSuggestions(tail(JSON.stringify([{ label: 'A', text: '1' }, { label: 'a', text: '2' }]))).map((b) => b.text), ['1']);
  });

  it('негодное описание не отбрасывает кнопку', () => {
    assert.deepEqual(parseSuggestions(tail(JSON.stringify([{ ...button, description: 'a\nb' }]))), [{ ...button, submit: false }]);
  });

  it('слишком длинный хвост не разбирается', () => {
    assert.deepEqual(parseSuggestions(tail(JSON.stringify([{ label: 'A', text: 'a', description: 'x'.repeat(30_000) }]))), []);
  });
});

describe('Кнопки от модели: инструкция сессии', () => {
  it('инструкция называет формат и условие «не очевидно - не пиши», она в системном промте сессии', () => {
    assert.match(SUGGEST_PROMPT, /<!-- cyborg-buttons: \[\{"label"/);
    assert.match(SUGGEST_PROMPT, /не пиши ничего/);
    assert.ok(SESSION_PROMPT.endsWith(SUGGEST_PROMPT));
    assert.deepEqual(claudeArgs([]).slice(0, 2), ['--append-system-prompt', SESSION_PROMPT]);
  });

  it('пример из инструкции сам разбирается', () => {
    const example = /<!-- cyborg-buttons: .* -->/.exec(SUGGEST_PROMPT)?.[0] ?? '';
    assert.equal(parseSuggestions(example).length, 1);
  });
});
