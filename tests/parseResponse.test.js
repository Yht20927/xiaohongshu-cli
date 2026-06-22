// tests/parseResponse.test.js — parseResponseText 的解析路径
const { parseResponseText } = require('../lib/shared/parseResponse');

describe('parseResponseText', () => {
  it('valid JSON returns ok', () => {
    const r = parseResponseText('test', 200, 'application/json', '{"data": 1}');
    expect(r.ok).toBe(true);
    expect(r.value.data).toBe(1);
  });
  it('non-2xx returns error not retryable', () => {
    const r = parseResponseText('test', 500, 'text/html', 'Internal Server Error');
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(false);
  });
  it('empty response is retryable', () => {
    const r = parseResponseText('test', 200, 'application/json', '');
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(true);
  });
  it('HTML response is retryable', () => {
    const r = parseResponseText('test', 200, 'text/html', '<html><body>Login required</body></html>');
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(true);
  });
  it('invalid JSON is retryable', () => {
    const r = parseResponseText('test', 200, 'application/json', 'not json at all');
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(true);
  });
  it('error message includes label', () => {
    const r = parseResponseText('search', 200, 'text/html', '<html><body>' + 'x'.repeat(250) + '</body></html>');
    expect(r.ok).toBe(false);
    expect(r.error.includes('[search]')).toBe(true);
  });
});
