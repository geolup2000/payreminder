const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadDiscord(config, fetch) {
  const context = { require: (name) => name === './config' ? config : {
    getNotificationSettings: () => ({ discord: { active: config.discordConfigured, ...config.discord } }),
  }, module: { exports: {} }, URL, AbortSignal, fetch, console: { log() {} } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/discord'), 'utf8'), context);
  return context.module.exports;
}

test('Discord skips sending when disabled', async () => {
  const discord = loadDiscord({ discordConfigured: false }, () => assert.fail('Unexpected request'));
  assert.equal((await discord.sendDiscord('test')).skipped, true);
});

for (const appName of ['', 'My Payments']) {
  test(`Discord sends payment details with ${appName ? 'custom' : 'default'} application name and favicon avatar`, async () => {
    let request;
    const discord = loadDiscord({ discordConfigured: true, appName: 'PayReminder', appUrl: 'https://example.com', discord: {
      webhookUrl: 'https://discord.com/api/webhooks/123/secret?thread_id=456', appName, iconUrl: 'https://old.example.com/icon.png',
    } }, async (url, options) => {
      request = { url, options, payload: JSON.parse(options.body) };
      return { ok: true, status: 204 };
    });
    await discord.notifyPaymentReported({ name: '@everyone *Ana*' }, 'octombrie 2026', '15 RON', 'https://example.com/admin/payments', 'Netflix');
    assert.equal(request.url.searchParams.get('wait'), 'true');
    assert.equal(request.url.searchParams.get('thread_id'), '456');
    assert.equal(request.options.method, 'POST');
    assert.deepEqual(request.payload.allowed_mentions, { parse: [] });
    assert.equal(request.payload.avatar_url, 'https://example.com/favicon.png');
    assert.equal(request.payload.username, appName || 'PayReminder');
    for (const detail of ['\\*Ana\\*', 'Netflix', 'octombrie 2026', '15 RON', 'https://example.com/admin/payments']) {
      assert.ok(request.payload.content.includes(detail));
    }
  });
}

test('Discord reports HTTP and network failures without exposing webhook token', async () => {
  const config = { discordConfigured: true, discord: { webhookUrl: 'https://discord.com/api/webhooks/123/secret' } };
  await assert.rejects(loadDiscord(config, async () => ({ ok: false, status: 429 })).sendDiscord('test'), /HTTP 429/);
  await assert.rejects(loadDiscord(config, async () => { throw new Error('network failure'); }).sendDiscord('test'), /network failure/);
});

test('Payment notification still reaches the other channel when either one fails', async () => {
  const source = fs.readFileSync(require.resolve('../src/server'), 'utf8');
  const fn = source.slice(source.indexOf('async function notifyReported('), source.indexOf('// -------------------------------------------------------------', source.indexOf('async function notifyReported(')));
  for (const failed of ['telegram', 'discord']) {
    const language = failed === 'telegram' ? 'en' : 'ro';
    const calls = [];
    const channel = (name) => ({ notifyPaymentReported: async (...args) => {
      calls.push({ name, args });
      if (name === failed) throw new Error('test failure');
    } });
    const context = { telegram: channel('telegram'), discord: channel('discord'), config: { appUrl: 'https://example.com', currency: 'RON' }, ...require('../src/format'), appLanguage: () => language, console: { error() {} } };
    vm.runInNewContext(fn, context);
    await context.notifyReported({ name: 'Ana' }, { id: 's1', name: 'Netflix' }, '2026-10', { id: 'p1', amount: 15 });
    assert.deepEqual(calls.map((call) => call.name).sort(), ['discord', 'telegram']);
    assert.deepEqual(calls[0].args, calls[1].args);
    assert.ok(calls[0].args[3].includes('highlight=p1'));
    assert.equal(calls[0].args[5], language);
    assert.equal(calls[0].args[1], language === 'en' ? 'October 2026' : 'octombrie 2026');
    assert.equal(calls[0].args[2], language === 'en' ? '15.00 RON' : '15,00 RON');
  }
});

for (const agent of ['telegram', 'discord']) {
  for (const language of ['ro', 'en']) {
    test(`${agent} payment notification uses ${language} for all message text`, async () => {
      let payload;
      const context = {
        require: (name) => name === './config' ? { appName: 'PayReminder' } : {
          getNotificationSettings: () => ({
            telegram: { active: true, botToken: 'test', chatId: '123' },
            discord: { active: true, webhookUrl: 'https://discord.com/api/webhooks/123/test' },
          }),
        },
        module: { exports: {} }, URL, AbortSignal,
        console: { log() {} },
        fetch: async (url, options) => {
          payload = JSON.parse(options.body);
          return { ok: true, json: async () => ({ ok: true }) };
        },
      };
      vm.runInNewContext(fs.readFileSync(require.resolve(`../src/${agent}`), 'utf8'), context);
      const { localizedMonth, formatMoney } = require('../src/format');
      await context.module.exports.notifyPaymentReported({ name: 'Ana' }, localizedMonth('2026-10', language), formatMoney(15, 'RON', language), 'https://example.com/admin/payments', 'Netflix', language);
      const text = payload.text || payload.content.replace(/\\([\\`*_{}\[\]()<>#+\-.!|~])/g, '$1');
      const expected = language === 'en'
        ? ['Payment reported', 'reported a payment for', 'Confirm after verification', 'October 2026', '15.00 RON']
        : ['Plată raportată', 'a notificat plata pentru', 'Confirmă după verificare', 'octombrie 2026', '15,00 RON'];
      for (const value of expected) assert.ok(text.includes(value), `Missing ${value}`);
      assert.ok(text.includes('Ana'));
      assert.ok(text.includes('Netflix'));
      assert.ok(text.includes('https://example.com/admin/payments'));
      assert.ok(!text.includes(language === 'en' ? 'Plată raportată' : 'Payment reported'));
    });
  }
}
