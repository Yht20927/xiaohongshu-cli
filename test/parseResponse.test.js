// test/parseResponse.test.js

const { parseResponseText } = require('../lib/shared/parseResponse');

function eq(actual, expected, label) {
  if (actual !== expected) {
    console.error(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    process.exit(1);
  }
}

function ok(cond, label) {
  if (!cond) {
    console.error(`FAIL ${label || 'truthy check'}: expected truthy`);
    process.exit(1);
  }
}

function test(name, fn) {
  try { fn(); console.log(`  PASS ${name}`); }
  catch (e) { console.error(`FAIL ${name}: ${e.message}`); process.exit(1); }
}

console.log('parseResponseText:');

test('valid JSON returns ok', () => {
  const r = parseResponseText('test', 200, 'application/json', '{"data": 1}');
  eq(r.ok, true);
  eq(r.value.data, 1);
});

test('non-2xx returns error', () => {
  const r = parseResponseText('test', 500, 'text/html', 'Internal Server Error');
  eq(r.ok, false);
  eq(r.retryable, false);
});

test('empty response is retryable', () => {
  const r = parseResponseText('test', 200, 'application/json', '');
  eq(r.ok, false);
  eq(r.retryable, true);
});

test('HTML response is retryable', () => {
  const r = parseResponseText('test', 200, 'text/html', '<html><body>Login required</body></html>');
  eq(r.ok, false);
  eq(r.retryable, true);
});

test('invalid JSON is retryable', () => {
  const r = parseResponseText('test', 200, 'application/json', 'not json at all');
  eq(r.ok, false);
  eq(r.retryable, true);
});

test('error message includes label', () => {
  const r = parseResponseText('search', 200, 'text/html', '<html><body>' + 'x'.repeat(250) + '</body></html>');
  ok(r.ok === false);
  ok(r.error.includes('[search]'), 'error includes label');
});

test('snip truncates long text', () => {
  const longText = 'a'.repeat(500);
  const r = parseResponseText('test', 200, 'text/html', longText);
  ok(r.error.length < 400, 'error is truncated');
});

console.log('\nAll tests passed.');
