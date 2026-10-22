const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { coordinateShutdown, installShutdownSignals } = require('../src/shutdown');

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

test('SIGTERM and SIGINT wait for the same drain before exiting', async t => {
  const fakeProcess = new EventEmitter();
  const exits = [];
  fakeProcess.exit = code => exits.push(code);
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  t.after(() => finish());
  let drains = 0, released = false;
  const shutdown = coordinateShutdown(fakeServer(), async () => { drains++; await gate; }, () => { released = true; });
  t.after(installShutdownSignals(shutdown, fakeProcess));
  fakeProcess.emit('SIGTERM');
  fakeProcess.emit('SIGINT');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(drains, 1);
  assert.equal(released, false);
  assert.deepEqual(exits, []);
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(released, true);
  assert.deepEqual(exits, [0]);
  assert.equal(fakeProcess.listenerCount('SIGTERM'), 0);
});

test('signal drain failure retains ownership and allows another signal to retry', async t => {
  const fakeProcess = new EventEmitter();
  const exits = [];
  const errors = [];
  fakeProcess.exit = code => exits.push(code);
  let attempts = 0, released = false;
  const shutdown = coordinateShutdown(fakeServer(), async () => {
    if (++attempts === 1) throw new Error('disk failure');
  }, () => { released = true; }, () => {});
  t.after(installShutdownSignals(shutdown, fakeProcess, error => errors.push(error.message)));
  fakeProcess.emit('SIGTERM');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(released, false);
  assert.deepEqual(exits, []);
  assert.deepEqual(errors, ['disk failure']);
  fakeProcess.emit('SIGTERM');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(released, true);
  assert.deepEqual(exits, [0]);
});
