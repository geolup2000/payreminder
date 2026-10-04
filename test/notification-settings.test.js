const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function load(settings = {}) {
  const context = { URL, module: { exports: {} }, require: (name) => name === './db'
    ? { getSettings: () => settings }
    : { appName: 'PayReminder', telegramConfigured: true, telegram: { botToken: 'legacy', chatId: '123' }, discordConfigured: false, discord: { webhookUrl: '' } } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/notification-settings'), 'utf8'), context);
  return context.module.exports;
}

test('Legacy configuration is used only until settings are saved', () => {
  assert.equal(load().getNotificationSettings().telegram.botToken, 'legacy');
  const settings = { notifications: { telegram: { active: false, botToken: 'saved', chatId: '456' }, discord: { active: false } } };
  const helper = load(settings);
  assert.equal(helper.getNotificationSettings().telegram.active, false);
  assert.equal(helper.getNotificationSettings().telegram.botToken, 'saved');
  settings.notifications.telegram.active = true;
  assert.equal(helper.getNotificationSettings().telegram.active, true);
});

test('Inactive agents retain credentials, and both agents can be enabled', () => {
  const helper = load();
  const body = { telegramBotToken: ' token ', telegramChatId: '-123', discordWebhookUrl: 'https://discord.com/api/webhooks/123/token', discordAppName: ' My Payments ' };
  const inactive = helper.notificationSettingsFromBody(body);
  assert.equal(inactive.telegram.active, false);
  assert.equal(inactive.telegram.botToken, 'token');
  assert.equal(inactive.discord.webhookUrl, body.discordWebhookUrl);
  assert.equal(inactive.discord.appName, 'My Payments');
  assert.equal(helper.notificationSettingsFromBody({}).discord.appName, 'PayReminder');
  assert.equal(helper.getNotificationSettings().discord.appName, 'PayReminder');
  const active = helper.notificationSettingsFromBody({ ...body, telegramActive: 'on', discordActive: 'on' });
  assert.equal(active.telegram.active, true);
  assert.equal(active.discord.active, true);
});

test('Enabled agents require valid credentials and URLs', () => {
  const helper = load();
  assert.throws(() => helper.notificationSettingsFromBody({ telegramActive: 'on' }), /Chat ID/);
  for (const discordWebhookUrl of ['', 'https://example.com/api/webhooks/123/token', 'http://discord.com/api/webhooks/123/token']) {
    assert.throws(() => helper.notificationSettingsFromBody({ discordActive: 'on', discordWebhookUrl }), /webhook/);
  }
  assert.throws(() => helper.notificationSettingsFromBody({ discordAppName: 'a'.repeat(81) }), /80/);
});
