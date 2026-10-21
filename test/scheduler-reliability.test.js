const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const dbPath = require.resolve('../src/db');
const schedulerPath = require.resolve('../src/scheduler');
function fixture(t, transport = async () => ({})) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'payreminder-scheduler-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function loadDb() {
    const ctx = { require: createRequire(dbPath), __dirname: path.join(root, 'src'), module: { exports: {} }, process };
    vm.runInNewContext(fs.readFileSync(dbPath, 'utf8'), ctx);
    return ctx.module.exports;
  }
  const db = loadDb();
  const sends = [];
  const jobs = [];
  function loadScheduler(database = db) {
    const realRequire = createRequire(schedulerPath);
    const ctx = { require: name => {
      if (name === './db') return database;
      if (name === './mailer') return { sendReminderEmail: async (member, opts) => { sends.push({ member, ...opts }); return transport(member, opts); } };
      if (name === 'node-cron') return { schedule(expression, callback) {
        const job = { expression, callback, stopped: false, destroyed: false,
          stop() { this.stopped = true; }, destroy() { this.destroyed = true; } };
        jobs.push(job);
        return job;
      } };
      return realRequire(name);
    }, module: { exports: {} }, console: { log() {}, error() {} } };
    vm.runInNewContext(fs.readFileSync(schedulerPath, 'utf8'), ctx);
    return ctx.module.exports;
  }
  return { db, scheduler: loadScheduler(), loadScheduler, loadDb, sends, jobs, dir: path.join(root, 'data') };
}

test('stopScheduler stops cron, rejects new work and drains accepted sends before lock release', async t => {
  let release;
  let started;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  t.after(() => release());
  const { db, scheduler, sends, jobs, loadDb } = fixture(t, async () => { started(); await gate; return {}; });
  assert.equal(typeof scheduler.stopScheduler, 'function');
  const unlock = db.acquireDataLock();
  t.after(unlock);
  const service = db.getServices()[0];
  db.updateService(service.id, { reminderDay: 1, reminderHour: 0 });
  const a = db.createMember({ name: 'A', amount: 10 });
  scheduler.startScheduler();
  scheduler.startScheduler();
  assert.equal(jobs.length, 1);
  const tick = jobs[0].callback();
  await entered;
  const b = db.createMember({ name: 'B', amount: 20 });
  const queued = scheduler.sendRemindersTo([a, b]);
  let drained = false;
  const stopping = scheduler.stopScheduler().then(() => { drained = true; });
  assert.throws(() => scheduler.startScheduler(), /stopp/i);
  await Promise.resolve();
  assert.equal(drained, false);
  assert.equal(jobs[0].stopped, true);
  assert.equal(jobs[0].destroyed, true);
  assert.throws(() => loadDb().acquireDataLock(), /lock/i);
  await assert.rejects(scheduler.sendRemindersTo([b]), /stopp/i);
  await assert.rejects(scheduler.runMonthlyReminder(), /stopp/i);
  release();
  await Promise.all([tick, queued, stopping]);
  assert.deepEqual(sends.map(entry => entry.member.name), ['A', 'B']);
  assert.equal(Object.keys(db.getSettings().reminderDeliveries).length, 2);
  await jobs[0].callback();
  assert.equal(sends.length, 2);
  await scheduler.stopScheduler();
  unlock();
  const nextUnlock = loadDb().acquireDataLock();
  nextUnlock();
});

test('stopScheduler cannot report a safe drain while a delivered recipient marker remains unpersisted', async t => {
  const { db, scheduler, sends, loadScheduler, loadDb } = fixture(t);
  const member = db.createMember({ name: 'A', amount: 10 });
  const update = db.updateSettings;
  let fail = true;
  db.updateSettings = patch => {
    if (patch.reminderDeliveries && fail) throw new Error('disk full');
    return update(patch);
  };
  await assert.rejects(scheduler.sendRemindersTo([member], { month: '2042-05' }), /disk full/);
  await assert.rejects(scheduler.stopScheduler(), /disk full/);
  assert.equal(sends.length, 1);
  fail = false;
  await scheduler.stopScheduler();
  assert.equal(Object.keys(db.getSettings().reminderDeliveries).length, 1);
  const restarted = loadScheduler(loadDb());
  assert.equal((await restarted.sendRemindersTo([member], { month: '2042-05' })).sent, 0);
  assert.equal(sends.length, 1);
});

test('completed tracked campaigns allow new members and subscriptions without repeating prior recipients', async t => {
  const { db, scheduler, sends, loadScheduler, loadDb } = fixture(t);
  const service = db.getServices()[0];
  const other = db.createService({ name: 'Other' });
  const a = db.createMember({ name: 'A', amount: 10 });
  const c = db.createMember({ name: 'C', serviceId: other.id, amount: 10 });
  assert.equal((await scheduler.runServiceReminder(service, new Date(2041, 4, 20, 12))).sent, 1);
  const b = db.createMember({ name: 'B', amount: 20 });
  db.updateMember(c.id, { memberships: [{ serviceId: other.id, amount: 10 }, { serviceId: service.id, amount: 30 }] });
  const restarted = loadScheduler(loadDb());
  assert.equal((await restarted.sendRemindersTo([a, b, c], { month: '2041-05', serviceId: service.id })).sent, 2);
  assert.equal((await restarted.sendRemindersTo([a, b, c], { month: '2041-05', serviceId: service.id })).sent, 0);
  assert.deepEqual(sends.map(entry => entry.member.name), ['A', 'B', 'C']);
  assert.notEqual(db.getLastReminderMonth(service.id), '2041-05');
});

test('delivery markers are specific to member, service and month; skipped transports remain retryable', async t => {
  let disabled = true;
  const { db, scheduler, sends, loadScheduler, loadDb } = fixture(t, async () => disabled ? { skipped: true } : {});
  const first = db.getServices()[0];
  const second = db.createService({ name: 'Second' });
  const member = db.createMember({ name: 'Ana', memberships: [{ serviceId: first.id, amount: 10 }, { serviceId: second.id, amount: 20 }] });
  const skipped = await scheduler.sendRemindersTo([member], { month: '2040-05', serviceId: first.id });
  assert.equal(skipped.sent, 0);
  assert.equal(skipped.skipped, 1);
  assert.equal(db.getSettings().reminderDeliveries, undefined);
  disabled = false;
  assert.equal((await scheduler.sendRemindersTo([member], { month: '2040-05', serviceId: first.id })).sent, 1);
  const restarted = loadScheduler(loadDb());
  assert.equal((await restarted.sendRemindersTo([member], { month: '2040-05' })).sent, 1);
  assert.equal((await restarted.sendRemindersTo([member], { month: '2040-06' })).sent, 2);
  assert.equal(Object.keys(db.getSettings().reminderDeliveries).length, 4);
  assert.equal(sends.length, 5);
});

test('marker persistence failures abort the campaign and same-process retries do not resend delivered mail', async t => {
  const { db, scheduler, sends } = fixture(t);
  const member = db.createMember({ name: 'Ana', amount: 10 });
  const update = db.updateSettings;
  let fail = true;
  db.updateSettings = patch => {
    if (patch.reminderDeliveries && fail) throw new Error('disk full');
    return update(patch);
  };
  await assert.rejects(scheduler.sendRemindersTo([member], { month: '2039-05' }), /disk full/);
  assert.equal(sends.length, 1);
  fail = false;
  await scheduler.sendRemindersTo([member], { month: '2039-05' });
  assert.equal(sends.length, 1);
  assert.equal(Object.keys(db.getSettings().reminderDeliveries).length, 1);
});

test('legacy completed service/month campaigns suppress only the migration snapshot across restart', async t => {
  for (const legacy of ['lastReminderMonth', 'lastReminderMonths']) {
    const { db, scheduler, sends, loadScheduler, loadDb } = fixture(t);
    const service = db.getServices()[0];
    const member = db.createMember({ name: 'Ana', amount: 10 });
    db.updateSettings(legacy === 'lastReminderMonth' ? { lastReminderMonth: '2038-05', keep: true } : { lastReminderMonths: { [service.id]: '2038-05' }, keep: true });
    assert.equal((await scheduler.runServiceReminder(service, new Date(2038, 4, 20, 12))).skipped, true);
    assert.equal((await scheduler.sendRemindersTo([member], { month: '2038-05' })).sent, 0);
    assert.equal(sends.length, 0);
    assert.equal(db.getSettings().keep, true);
    const added = db.createMember({ name: 'New', amount: 15 });
    const restarted = loadScheduler(loadDb());
    assert.equal((await restarted.sendRemindersTo([member, added], { month: '2038-05' })).sent, 1);
    assert.equal((await restarted.sendRemindersTo([member, added], { month: '2038-05' })).sent, 0);
    assert.deepEqual(sends.map(entry => entry.member.name), ['New']);
  }
});

test('each delivery refreshes member, subscription, service and payment after earlier async sends', async t => {
  let mutate;
  const { db, scheduler, sends } = fixture(t, async member => { if (member.name === 'A') mutate(); return {}; });
  const service = db.getServices()[0];
  const secondService = db.createService({ name: 'Other' });
  const members = ['A', 'Paid', 'Inactive', 'Changed', 'Deleted', 'Removed'].map(name => db.createMember({ name, email: `${name}@example.test`, amount: 10 }));
  const other = db.createMember({ name: 'Service inactive', serviceId: secondService.id, amount: 5 });
  members.push(other);
  mutate = () => {
    db.createPayment({ member: members[1], service, month: '2037-05', amount: 10 });
    db.updateMember(members[2].id, { active: false });
    db.updateMember(members[3].id, { email: 'fresh@example.test', amount: 12.34 });
    db.deleteMember(members[4].id);
    db.updateMember(members[5].id, { serviceId: secondService.id });
    db.updateService(secondService.id, { active: false });
  };
  const result = await scheduler.sendRemindersTo(members, { month: '2037-05' });
  assert.deepEqual(sends.map(entry => entry.member.name), ['A', 'Changed']);
  assert.equal(sends[1].member.email, 'fresh@example.test');
  assert.equal(sends[1].amount, 12.34);
  assert.equal(result.sent, 2);
});

test('manual and scheduled overlap serializes delivery and suppresses duplicate recipients', async t => {
  let release;
  let started;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const { db, scheduler, sends } = fixture(t, async () => { started(); await gate; return {}; });
  const service = db.getServices()[0];
  const member = db.createMember({ name: 'Ana', amount: 10 });
  const manual = scheduler.sendRemindersTo([member, member], { month: '2036-05' });
  await entered;
  const scheduled = scheduler.runServiceReminder(service, new Date(2036, 4, 20, 12));
  await Promise.resolve();
  release();
  const results = await Promise.all([manual, scheduled]);
  assert.equal(sends.length, 1);
  assert.equal(results[0].sent + (results[1].sent || 0), 1);
});

test('partial campaigns persist recipient successes and retry failures after restart without resending successes', async t => {
  let fail = true;
  const f = fixture(t, async member => {
    if (member.name === 'B' && fail) throw new Error('temporary SMTP failure');
    return {};
  });
  const { db, scheduler, sends } = f;
  db.updateSettings({ unrelated: { preserve: true } });
  const service = db.getServices()[0];
  db.createMember({ name: 'A', amount: 10 });
  db.createMember({ name: 'B', amount: 20 });
  const date = new Date(2035, 4, 20, 12);
  const first = await scheduler.runServiceReminder(service, date);
  assert.equal(first.sent, 1);
  assert.equal(first.skipped, 1);
  assert.notEqual(db.getLastReminderMonth(service.id), '2035-05');
  fail = false;
  const second = await f.loadScheduler(f.loadDb()).runServiceReminder(service, date);
  assert.equal(second.sent, 1);
  assert.deepEqual(sends.map(entry => entry.member.name), ['A', 'B', 'B']);
  await f.loadScheduler(f.loadDb()).runServiceReminder(service, date);
  assert.equal(sends.length, 3);
  assert.equal(db.getSettings().unrelated.preserve, true);
});

test('explicit delivery month controls eligibility and scheduled date controls the entire campaign month', async t => {
  const { db, scheduler, sends } = fixture(t);
  const service = db.getServices()[0];
  const member = db.createMember({ name: 'Ana', amount: 10 });
  const { currentMonth } = require('../src/format');
  const month = currentMonth() === '2031-02' ? '2032-02' : '2031-02';
  db.createPayment({ member, service, month: currentMonth(), amount: 10 });
  assert.equal((await scheduler.sendRemindersTo([member], { month })).sent, 1);
  assert.equal(sends[0].month, month);
  const other = db.createMember({ name: 'Other', amount: 5 });
  const result = await scheduler.runMonthlyReminder(new Date(2033, 1, 20, 12));
  assert.equal(result.month, '2033-02');
  assert.equal(result.services[0].month, '2033-02');
  assert.equal(sends.at(-1).month, '2033-02');
  db.createPayment({ member: other, service, month: '2034-01', months: 3, amount: 15 });
  const before = sends.length;
  assert.equal((await scheduler.sendRemindersTo([other], { month: '2034-02' })).sent, 0);
  assert.equal(sends.length, before);
});

test('due time clamps to the last day and catches up after the configured hour', t => {
  const { scheduler } = fixture(t);
  const service = { active: true, reminderDay: 31, reminderHour: 10 };
  assert.equal(scheduler.isServiceReminderDue(service, new Date(2027, 1, 28, 10)), true);
  assert.equal(scheduler.isServiceReminderDue(service, new Date(2028, 1, 29, 10)), true);
  assert.equal(scheduler.isServiceReminderDue(service, new Date(2027, 1, 28, 9, 59)), false);
  assert.equal(scheduler.isServiceReminderDue({ ...service, reminderDay: 10 }, new Date(2027, 1, 20, 5)), true);
  assert.equal(scheduler.isServiceReminderDue(service, new Date(2027, 2, 1, 12)), false);
  assert.equal(scheduler.isServiceReminderDue({ ...service, active: false }, new Date(2027, 1, 28, 12)), false);
});
