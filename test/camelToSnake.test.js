// test/camelToSnake.test.js

const { camelToSnake } = require('../lib/shared/caseConvert');

function assert(actual, expected, label) {
  if (actual !== expected) {
    console.error(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    process.exit(1);
  }
}

function test(name, fn) {
  try { fn(); console.log(`  PASS ${name}`); }
  catch (e) { console.error(`FAIL ${name}: ${e.message}`); process.exit(1); }
}

console.log('camelToSnake:');

test('basic camelCase', () => {
  assert(camelToSnake('noteCard'), 'note_card', 'noteCard -> note_card');
});

test('already snake_case', () => {
  assert(camelToSnake('note_card'), 'note_card', 'note_card unchanged');
});

test('single char', () => {
  assert(camelToSnake('a'), 'a', 'single char unchanged');
});

test('all lowercase', () => {
  assert(camelToSnake('abc'), 'abc', 'all lowercase unchanged');
});

test('all uppercase', () => {
  assert(camelToSnake('ABC'), 'ABC', 'all uppercase unchanged');
});

test('multi-word camelCase', () => {
  assert(camelToSnake('displayTitle'), 'display_title', 'displayTitle -> display_title');
});

test('single letter key', () => {
  assert(camelToSnake('k'), 'k', 'single letter unchanged');
});

console.log('\nAll tests passed.');
