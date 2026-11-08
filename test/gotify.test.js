const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const settings = { active: true, serverUrl: 'http://localhost:8080/push/', appToken: 'private-token' };
function load(fetch, gotify = settings) {
  const context = { module: { exports: {} }, require: () => ({ getNotificationSettings: () => ({ gotify }) }),
    fetch, AbortSignal, console: { log() {} } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/gotify'), 'utf8'), context);
  return context.module.exports;
}

test('Gotify skips disabled or incomplete settings', async () => {
  for (const value of [{}, { ...settings, active: false }, { ...settings, serverUrl: '' }, { ...settings, appToken: '' }]) {
    assert.equal((await load(() => assert.fail('Unexpected request'), value).sendGotify('test')).skipped, true);
  }
});

test('Gotify supports proxy paths, authenticates in a header and prevents redirects with credentials', async () => {
  const sender = load(async (url, options) => {
    assert.equal(url, 'http://localhost:8080/push/message');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['X-Gotify-Key'], settings.appToken);
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(options.body), { title: 'PayReminder', message: 'test', priority: 5 });
    return { ok: true, status: 200 };
  });
  assert.equal((await sender.sendGotify('test')).sent, true);
});

test('Gotify sanitizes provider and network errors and exposes HTTP status for localized feedback', async () => {
  for (const status of [400, 401, 429, 500]) {
    await assert.rejects(load(async () => ({ ok: false, status })).sendGotify('test'), error => {
      assert.equal(error.status, status);
      assert.equal(error.message, `Gotify request failed (HTTP ${status})`);
      return true;
    });
  }
  await assert.rejects(load(async () => { throw new Error(settings.appToken); }).sendGotify('test'), /^Error: Gotify connection failed$/);
});
