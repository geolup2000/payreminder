const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { coordinateShutdown } = require('../src/shutdown');

function fakeServer() {
  const server = new EventEmitter();
  server.close = (callback) => { server.emit('close'); callback?.(); };
  return server;
}

test('external HTTP close retains lock until background deliveries drain', async () => {
  const server = fakeServer();
  let finish, released = false;
  const stop = new Promise(resolve => { finish = resolve; });
  const shutdown = coordinateShutdown(server, () => stop, () => { released = true; }, () => {});
  server.close();
  await Promise.resolve();
  assert.equal(released, false);
  finish();
  await shutdown();
  assert.equal(released, true);
});

test('failed background persistence retains lock and explicit shutdown can retry', async () => {
  const server = fakeServer();
  let attempts = 0, releases = 0;
  const errors = [];
  const shutdown = coordinateShutdown(server, async () => {
    if (++attempts === 1) throw new Error('disk unavailable');
  }, () => { releases++; }, error => errors.push(error.message));
  server.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(releases, 0);
  assert.deepEqual(errors, ['disk unavailable']);
  await shutdown();
  await shutdown();
  assert.equal(attempts, 2);
  assert.equal(releases, 1);
});

test('explicit shutdown closes HTTP before stopping writers and releasing lock', async () => {
  const server = fakeServer();
  const steps = [];
  server.prependOnceListener('close', () => steps.push('http closed'));
  const shutdown = coordinateShutdown(server, async () => { steps.push('writers stopped'); }, () => { steps.push('released'); }, () => {});
  await shutdown();
  assert.deepEqual(steps, ['http closed', 'writers stopped', 'released']);
});
