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

for (const iconUrl of ['', 'https://example.com/icon.png']) {
  test(`Discord sends payment details ${iconUrl ? 'with' : 'without'} custom avatar`, async () => {
    let request;
    const discord = loadDiscord({ discordConfigured: true, appName: 'PayReminder', discord: {
      webhookUrl: 'https://discord.com/api/webhooks/123/secret?thread_id=456', iconUrl,
    } }, async (url, options) => {
      request = { url, options, payload: JSON.parse(options.body) };
      return { ok: true, status: 204 };
    });
    await discord.notifyPaymentReported({ name: '@everyone *Ana*' }, 'octombrie 2026', '15 RON', 'https://example.com/admin/payments', 'Netflix');
    assert.equal(request.url.searchParams.get('wait'), 'true');
    assert.equal(request.url.searchParams.get('thread_id'), '456');
    assert.equal(request.options.method, 'POST');
    assert.deepEqual(request.payload.allowed_mentions, { parse: [] });
    assert.equal(request.payload.avatar_url, iconUrl || undefined);
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
    const calls = [];
    const channel = (name) => ({ notifyPaymentReported: async (...args) => {
      calls.push({ name, args });
      if (name === failed) throw new Error('test failure');
    } });
    const context = { telegram: channel('telegram'), discord: channel('discord'), config: { appUrl: 'https://example.com', currency: 'RON' }, localizedMonth: (month) => month, appLanguage: () => 'ro', formatMoney: (amount) => `${amount} RON`, console: { error() {} } };
    vm.runInNewContext(fn, context);
    await context.notifyReported({ name: 'Ana' }, { id: 's1', name: 'Netflix' }, '2026-10', { id: 'p1', amount: 15 });
    assert.deepEqual(calls.map((call) => call.name).sort(), ['discord', 'telegram']);
    assert.deepEqual(calls[0].args, calls[1].args);
    assert.ok(calls[0].args[3].includes('highlight=p1'));
  }
});
