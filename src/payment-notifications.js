// The payment and its pending notifications are written together. Successful
// channels are persisted separately so retries only send unfinished deliveries.
function createPaymentNotifications({ db, channels, send, onError = console.error }) {
  let queue = Promise.resolve();
  let accepting = true;
  let timer;
  const delivered = new Map();

  function record(key, { id, channel }) {
    db.markPaymentNotificationSent(id, channel);
    delivered.delete(key);
  }

  async function deliver(id) {
    for (const [channel, transport] of Object.entries(channels)) {
      const key = JSON.stringify([id, channel]);
      if (delivered.has(key)) {
        record(key, delivered.get(key));
        continue;
      }
      const payment = db.getPayment(id);
      if (!payment || payment.reportNotifications?.[channel] !== 'pending') continue;
      let result;
      try { result = await send(transport, payment); }
      catch (error) { onError(`[pay] ${channel} failed:`, error.message); continue; }
      if (result?.skipped) continue;
      const delivery = { id, channel };
      delivered.set(key, delivery);
      // Disk failures propagate; a successful send is never retried in-process.
      record(key, delivery);
    }
  }

  function retry(id) {
    if (!accepting) return Promise.reject(new Error('Payment notifications are stopped'));
    const result = queue.then(async () => {
      const ids = id ? [id] : db.getPayments()
        .filter(payment => Object.values(payment.reportNotifications || {}).includes('pending'))
        .map(payment => payment.id);
      for (const paymentId of ids) await deliver(paymentId);
    });
    queue = result.catch(() => {});
    return result;
  }

  function start() {
    if (timer || !accepting) return;
    const tick = () => retry().catch(error => onError('[pay] retry failed:', error.message));
    timer = setInterval(tick, 60000);
    tick();
  }

  async function stop() {
    accepting = false;
    clearInterval(timer);
    timer = undefined;
    await queue;
    for (const [key, delivery] of delivered) record(key, delivery);
  }

  return { retry, start, stop };
}

module.exports = { createPaymentNotifications };
