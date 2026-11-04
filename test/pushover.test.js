const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const settings = { active: true, apiToken: 'a'.repeat(30), userKey: 'b'.repeat(30) };
function load(fetch, pushover = settings) {
  const context = { module: { exports: {} }, require: () => ({ getNotificationSettings: () => ({ pushover }) }),
    fetch, AbortSignal, console: { log() {} } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/pushover'), 'utf8'), context);
  return context.module.exports;
}

test('Pushover skips disabled or incomplete credentials', async () => {
  for (const value of [{ ...settings, active: false }, { active: true }, { active: true, apiToken: 'a' }]) {
    assert.equal((await load(() => assert.fail('Unexpected request'), value).sendPushover('test')).skipped, true);
  }
});

test('Pushover sends credentials in JSON to a fixed HTTPS endpoint with a timeout and bounded message', async () => {
  const sender = load(async (url, options) => {
    assert.equal(url, 'https://api.pushover.net/1/messages.json');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.ok(options.signal);
    const body = JSON.parse(options.body);
    assert.equal(body.token, settings.apiToken);
    assert.equal(body.user, settings.userKey);
    assert.equal(body.message.length, 1024);
    return { ok: true, json: async () => ({ status: 1 }) };
  });
  assert.equal((await sender.sendPushover('x'.repeat(2000))).sent, true);
});

test('Pushover rejects HTTP errors, provider failures, malformed responses and network failures without secrets', async () => {
  for (const response of [
    { ok: false, status: 429, json: async () => ({ status: 0, errors: [settings.apiToken] }) },
    { ok: true, status: 200, json: async () => ({ status: 0 }) },
    { ok: true, status: 200, json: async () => { throw new Error(settings.userKey); } },
  ]) {
    await assert.rejects(load(async () => response).sendPushover('test'), error => {
      assert.equal(error.status, response.status);
      return !error.message.includes(settings.apiToken) && !error.message.includes(settings.userKey);
    });
  }
  await assert.rejects(load(async () => { throw new Error(settings.apiToken); }).sendPushover('test'), /Pushover connection failed/);
});
