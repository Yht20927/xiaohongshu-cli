// tests/caseConvert.test.js — camelToSnake
const { camelToSnake, convertKeys } = require('../lib/shared/caseConvert');

describe('camelToSnake', () => {
  it('basic camelCase', () => expect(camelToSnake('noteCard')).toBe('note_card'));
  it('already snake_case', () => expect(camelToSnake('note_card')).toBe('note_card'));
  it('single char', () => expect(camelToSnake('a')).toBe('a'));
  it('all lowercase', () => expect(camelToSnake('abc')).toBe('abc'));
  it('all uppercase', () => expect(camelToSnake('ABC')).toBe('ABC'));
  it('multi-word camelCase', () => expect(camelToSnake('displayTitle')).toBe('display_title'));
});

describe('convertKeys', () => {
  it('recursively converts object keys', () => {
    const r = convertKeys({ noteCard: { displayTitle: 'x', subItems: [{ subItemId: 1 }] } });
    expect(r.note_card.display_title).toBe('x');
    expect(r.note_card.sub_items[0].sub_item_id).toBe(1);
  });
  it('handles cycles safely', () => {
    const o = { aB: 1 }; o.self = o;
    const r = convertKeys(o);
    expect(r.a_b).toBe(1);
  });
});
