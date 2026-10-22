const test = require('node:test');
const assert = require('node:assert/strict');
const { createPaymentNotifications } = require('../src/payment-notifications');

function fixture(send) {
  const payment = { id: 'p', reportNotifications: { telegram: 'pending', discord: 'pending' } };
  const db = {
    getPayment: id => id === payment.id ? structuredClone(payment) : undefined,
    getPayments: () => [structuredClone(payment)],
    markPaymentNotificationSent(id, channel) { payment.reportNotifications[channel] = 'sent'; },
  };
  const calls = [];
  const create = () => createPaymentNotifications({ db, channels: { telegram: 'telegram', discord: 'discord' },
    send: async (channel, value) => { calls.push(channel); return send?.(channel, value); }, onError() {} });
  return { payment, db, calls, create };
}

for (const failed of ['telegram', 'discord']) {
  test(`a failed ${failed} retries after restart without repeating the other channel`, async () => {
    let offline = true;
    const f = fixture(channel => { if (offline && channel === failed) throw new Error('offline'); });
    const first = f.create();
    await first.retry('p');
    assert.equal(f.payment.reportNotifications[failed], 'pending');
    assert.equal(f.payment.reportNotifications[failed === 'telegram' ? 'discord' : 'telegram'], 'sent');
    await first.stop();
    offline = false;
    const restarted = f.create();
    await restarted.retry();
    assert.deepEqual(f.calls, ['telegram', 'discord', failed]);
    assert.deepEqual(f.payment.reportNotifications, { telegram: 'sent', discord: 'sent' });
    await restarted.stop();
  });
}

test('overlapping retries serialize deliveries and send each channel once', async () => {
  const f = fixture(async () => { await new Promise(resolve => setImmediate(resolve)); });
  const service = f.create();
  await Promise.all([service.retry('p'), service.retry('p'), service.retry()]);
  assert.deepEqual(f.calls, ['telegram', 'discord']);
  await service.stop();
});

test('disabled transports stay pending, and legacy payments are not replayed', async () => {
  const f = fixture(() => ({ skipped: true }));
  const service = f.create();
  await service.retry();
  assert.deepEqual(f.payment.reportNotifications, { telegram: 'pending', discord: 'pending' });
  delete f.payment.reportNotifications;
  f.calls.length = 0;
  await service.retry();
  await service.retry('p');
  assert.deepEqual(f.calls, []);
  await service.stop();
});

test('disk failures retain successful delivery in memory and prevent resending on retry', async () => {
  const f = fixture();
  const save = f.db.markPaymentNotificationSent;
  let unavailable = true;
  f.db.markPaymentNotificationSent = (...args) => { if (unavailable) throw new Error('disk full'); return save(...args); };
  const service = f.create();
  await assert.rejects(service.retry('p'), /disk full/);
  await assert.rejects(service.stop(), /disk full/);
  assert.deepEqual(f.calls, ['telegram']);
  unavailable = false;
  await service.stop();
  assert.equal(f.payment.reportNotifications.telegram, 'sent');
  const restarted = f.create();
  await restarted.retry();
  assert.deepEqual(f.calls, ['telegram', 'discord']);
  await restarted.stop();
});

test('startup retries persisted pending notifications without a member request', async t => {
  let completed;
  const sent = new Promise(resolve => { completed = resolve; });
  const f = fixture(channel => { if (channel === 'discord') completed(); });
  const service = f.create();
  t.after(() => service.stop());
  service.start();
  await sent;
  await service.stop();
  assert.deepEqual(f.calls, ['telegram', 'discord']);
});

test('the minute timer automatically retries a failed channel', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let offline = true;
  const f = fixture(channel => { if (offline && channel === 'telegram') throw new Error('offline'); });
  const service = f.create();
  t.after(() => service.stop());
  service.start();
  await service.retry();
  f.calls.length = 0;
  offline = false;
  t.mock.timers.tick(60000);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls, ['telegram']);
  assert.deepEqual(f.payment.reportNotifications, { telegram: 'sent', discord: 'sent' });
});

test('shutdown waits for accepted sends and rejects further deliveries', async () => {
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const f = fixture(() => gate);
  const service = f.create();
  const sending = service.retry('p');
  let stopped = false;
  const stopping = service.stop().then(() => { stopped = true; });
  await assert.rejects(service.retry('p'), /stopped/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false);
  finish();
  await Promise.all([sending, stopping]);
  assert.deepEqual(f.payment.reportNotifications, { telegram: 'sent', discord: 'sent' });
});
