// tests/helpers.test.js — getFlag / getNoteId
const { getFlag, getNoteId, formatComment } = require('../lib/commands/helpers');

describe('getFlag', () => {
  it('absent flag returns default', () => {
    expect(getFlag(['a', 'b'], '--foo', 42)).toBe(42);
  });
  it('present flag returns numeric value', () => {
    expect(getFlag(['a', '--depth', '3', 'b'], '--depth', 0)).toBe(3);
  });
  it('present flag converts numeric strings', () => {
    expect(getFlag(['--since', '1700000000'], '--since', null)).toBe(1700000000);
  });
  it('next arg starting with -- returns default', () => {
    expect(getFlag(['note1', '--depth', '--all'], '--depth', 0)).toBe(0);
  });
  it('missing next arg returns default', () => {
    expect(getFlag(['note1', '--depth'], '--depth', 10)).toBe(10);
  });
  it('returns string when not numeric', () => {
    expect(getFlag(['--source', 'pc_search'], '--source', null)).toBe('pc_search');
  });
});

describe('getNoteId', () => {
  it('extracts first non-flag arg', () => {
    expect(getNoteId(['note123', '--all', '--depth', '1'])).toBe('note123');
    expect(getNoteId(['--all', 'note456'])).toBe('note456');
  });
  it('returns null when only flags', () => {
    expect(getNoteId(['--all'])).toBe(null);
  });
});

describe('formatComment', () => {
  it('flattens xhs comment shape', () => {
    const c = {
      id: 'c1', content: '你好世界',
      like_count: 5, sub_comment_count: 0, create_time: 1700000000,
      user: { nickname: 'alice', user_id: 'u1' },
    };
    const out = formatComment(c);
    expect(out.cid).toBe('c1');
    expect(out.text).toBe('你好世界');
    expect(out.likes).toBe(5);
    expect(out.user.nickname).toBe('alice');
  });
});
