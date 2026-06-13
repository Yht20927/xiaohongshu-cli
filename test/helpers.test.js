// test/helpers.test.js — getFlag 纯函数测试

const { getFlag } = require('../lib/commands/helpers');

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

console.log('getFlag:');

test('absent flag returns default', () => {
  assert(getFlag(['a', 'b'], '--foo', 42), 42);
});

test('present flag returns value', () => {
  assert(getFlag(['a', '--depth', '3', 'b'], '--depth', 0), 3);
});

test('present flag returns string value', () => {
  assert(getFlag(['a', '--since', '1700000000'], '--since', null), 1700000000);
});

test('next arg starts with -- returns default', () => {
  assert(getFlag(['note1', '--depth', '--all'], '--depth', 0), 0);
});

test('missing next arg returns default', () => {
  assert(getFlag(['note1', '--depth'], '--depth', 10), 10);
});

test('getNoteId extracts first non-flag arg', () => {
  const { getNoteId } = require('../lib/commands/helpers');
  assert(getNoteId(['note123', '--all', '--depth', '1']), 'note123');
  assert(getNoteId(['--all', 'note456']), 'note456');
  assert(getNoteId(['--all']), null);
});

console.log('\nAll tests passed.');
