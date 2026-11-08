const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { notificationSettingsFromBody } = require('../src/notification-settings');

function load(send) {
  const context = { module: { exports: {} }, require: (name) => {
    if (name === './notification-settings') return { notificationSettingsFromBody };
    return { sendTelegram: send, sendDiscord: send, sendPushover: send, sendGotify: send };
  } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/notification-check'), 'utf8'), context);
  return context.module.exports.testNotification;
}

for (const agent of ['telegram', 'discord', 'pushover', 'gotify']) {
  for (const language of ['ro', 'en']) {
    test(`${agent} test sends unsaved credentials and localized confirmation (${language})`, async () => {
      let sent;
      const check = load(async (message, settings) => { sent = { message, settings }; return { sent: true }; });
      const result = await check({ agent, language, gotifyServerUrl: 'https://push.example.test', gotifyAppToken: 'unsaved-gotify', telegramBotToken: 'unsaved-token', telegramChatId: '123', discordWebhookUrl: 'https://discord.com/api/webhooks/123/token', discordAppName: 'My App', pushoverApiToken: 'a'.repeat(30), pushoverUserKey: 'b'.repeat(30) });
      assert.equal(result.status, 200);
      assert.equal(result.body.ok, true);
      assert.ok(sent.message.includes(language === 'en' ? 'notification settings work correctly' : 'setările notificărilor funcționează corect'));
      assert.ok(result.body.message.includes(language === 'en' ? 'successfully' : 'trimis'));
      assert.equal(sent.settings.active, true);
      if (agent === 'telegram') assert.equal(sent.settings.botToken, 'unsaved-token');
      else if (agent === 'discord') assert.equal(sent.settings.appName, 'My App');
      else if (agent === 'gotify') { assert.equal(sent.settings.appToken, 'unsaved-gotify'); assert.equal(sent.settings.serverUrl, 'https://push.example.test'); }
      else { assert.equal(sent.settings.apiToken, 'a'.repeat(30)); assert.equal(sent.settings.userKey, 'b'.repeat(30)); }
    });
  }
}

test('Validation errors are localized and do not send messages', async () => {
  const check = load(() => assert.fail('Must not send invalid settings'));
  for (const language of ['ro', 'en']) {
    const result = await check({ agent: 'telegram', language });
    assert.equal(result.status, 400);
    assert.equal(result.body.ok, false);
    assert.ok(result.body.message.includes(language === 'en' ? 'Enter the bot token' : 'Completează tokenul'));
    assert.equal((await check({ agent: 'discord', language, discordWebhookUrl: 'https://example.com' })).status, 400);
    assert.equal((await check({ agent: 'other', language })).status, 400);
    const pushover = await check({ agent: 'pushover', language });
    assert.equal(pushover.status, 400);
    assert.ok(pushover.body.message.includes(language === 'en' ? 'Enter the Pushover' : 'Completează API Token'));
    const gotify = await check({ agent: 'gotify', language });
    assert.equal(gotify.status, 400);
    assert.ok(gotify.body.message.includes(language === 'en' ? 'Gotify HTTP(S)' : 'serverul Gotify'));
  }
});

test('Delivery errors return localized errors without exposing credentials', async () => {
  for (const language of ['ro', 'en']) {
    for (const status of [undefined, 401, 403, 429]) {
      const check = load(async () => { const err = new Error('secret-token'); err.status = status; throw err; });
      const result = await check({ agent: 'discord', language, discordWebhookUrl: 'https://discord.com/api/webhooks/123/secret-token' });
      assert.equal(result.status, 502);
      assert.equal(result.body.ok, false);
      assert.ok(!result.body.message.includes('secret-token'));
      if (status) assert.ok(result.body.message.includes(`HTTP ${status}`));
      else assert.ok(result.body.message.includes(language === 'en' ? 'Could not connect' : 'Conexiunea'));
    }
  }
});
