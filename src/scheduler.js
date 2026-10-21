const cron = require('node-cron');
const db = require('./db');
const { sendReminderEmail } = require('./mailer');
const { currentMonth, humanMonth, formatMoney } = require('./format');

let deliveryQueue = Promise.resolve();
const unrecordedDeliveries = new Map();
let schedulerTask;
let scheduledRun;
let stopping;
let acceptingDeliveries = true;

function recordDelivery(key, timestamp) {
  const settings = db.getSettings();
  db.updateSettings({ reminderDeliveries: { ...settings.reminderDeliveries, [key]: timestamp } });
  unrecordedDeliveries.delete(key);
}

function sendRemindersTo(members, opts = {}) {
  if (!acceptingDeliveries) return Promise.reject(new Error('Scheduler is stopped'));
  // Resolve the month at invocation, not after waiting behind another campaign.
  const options = { ...opts, month: opts.month || currentMonth() };
  const result = deliveryQueue.then(() => deliverReminders(members, options));
  deliveryQueue = result.catch(() => {});
  return result;
}

async function deliverReminders(members, opts) {
  db.migrateLegacyReminderDeliveries();
  const month = opts.month;
  const pairs = [];
  for (const candidate of members) {
    const member = db.getMember(candidate.id);
    if (!member || !member.active) continue;
    for (const membership of db.getMemberships(member)) {
      if (opts.serviceId && membership.serviceId !== opts.serviceId) continue;
      const service = db.getService(membership.serviceId);
      if (!service || service.active === false) continue;
      if (db.getPaymentByMemberServiceMonth(member.id, service.id, month)) continue;
      pairs.push({ member, service, amount: membership.amount });
    }
  }

  if (!pairs.length) {
    console.log('[reminder] niciun email de trimis');
    return { sent: 0, skipped: 0 };
  }

  let sent = 0;
  let skipped = 0;
  for (const pair of pairs) {
    const member = db.getMember(pair.member.id);
    const service = db.getService(pair.service.id);
    const membership = db.getMemberMembership(member, pair.service.id);
    if (!member || !member.active || !service || service.active === false || !membership) continue;
    if (db.getPaymentByMemberServiceMonth(member.id, service.id, month)) continue;
    const amount = membership.amount;
    const key = JSON.stringify([member.id, service.id, month]);
    if (db.getSettings().reminderDeliveries?.[key]) continue;
    if (unrecordedDeliveries.has(key)) {
      recordDelivery(key, unrecordedDeliveries.get(key));
      continue;
    }
    let result;
    try {
      result = await sendReminderEmail(member, { month, service, amount });
    } catch (err) {
      skipped++;
      console.error('[reminder] esec pentru', member.email, err.message);
      continue;
    }
    if (result && result.skipped) {
      skipped++;
      continue;
    }
    const timestamp = new Date().toISOString();
    unrecordedDeliveries.set(key, timestamp);
    // Persistence errors must propagate, not masquerade as transport failures.
    recordDelivery(key, timestamp);
    sent++;
  }
  return { sent, skipped };
}

function isServiceReminderDue(service, date = new Date()) {
  if (!service || service.active === false) return false;
  const day = Number.parseInt(service.reminderDay, 10);
  const hour = Number.parseInt(service.reminderHour, 10);
  if (!Number.isInteger(day) || day < 1 || day > 31 || !Number.isInteger(hour) || hour < 0 || hour > 23) return false;
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  const dueDay = Math.min(day, lastDay);
  return date.getDate() > dueDay || (date.getDate() === dueDay && date.getHours() >= hour);
}

async function runServiceReminder(service, date = new Date()) {
  if (!acceptingDeliveries) throw new Error('Scheduler is stopped');
  if (!isServiceReminderDue(service, date)) {
    return { serviceId: service.id, serviceName: service.name, skipped: true, reason: 'nu este ora acestui serviciu' };
  }

  const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  db.migrateLegacyReminderDeliveries();
  const members = db.getMembers().filter((member) => member.active && db.hasMembership(member, service.id));
  const deliveries = db.getSettings().reminderDeliveries || {};
  if (members.length && members.every(member => deliveries[JSON.stringify([member.id, service.id, month])])) {
    return { serviceId: service.id, serviceName: service.name, skipped: true, reason: 'deja trimis luna aceasta' };
  }

  const { sent, skipped } = await sendRemindersTo(members, { month, serviceId: service.id });
  console.log(`[reminder] ${service.name}: ${sent} emailuri pentru ${humanMonth(month)}`);
  return { serviceId: service.id, serviceName: service.name, month, sent, skipped };
}

async function runMonthlyReminder(date = new Date()) {
  if (!acceptingDeliveries) throw new Error('Scheduler is stopped');
  const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  const dueServices = db.getServices().filter((service) => isServiceReminderDue(service, date));
  const results = [];
  for (const service of dueServices) {
    if (!acceptingDeliveries) break;
    results.push(await runServiceReminder(service, date));
  }
  return { month, services: results };
}

function isReminderDueNow(date = new Date()) {
  return db.getServices().some((service) => isServiceReminderDue(service, date));
}

function startScheduler() {
  if (stopping) throw new Error('Scheduler is stopping');
  if (schedulerTask) return schedulerTask;
  db.migrateLegacyReminderDeliveries();
  acceptingDeliveries = true;
  // Verifica in fiecare minut programarea fiecarui serviciu.
  schedulerTask = cron.schedule('* * * * *', () => {
    if (acceptingDeliveries && !scheduledRun && isReminderDueNow()) {
      scheduledRun = runMonthlyReminder()
        .catch((err) => console.error('[scheduler] eroare:', err))
        .finally(() => { scheduledRun = undefined; });
      return scheduledRun;
    }
  });
  const schedules = db.getServices()
    .filter((service) => service.active !== false)
    .map((service) => `${service.name}: ziua ${service.reminderDay}, ora ${String(service.reminderHour).padStart(2, '0')}:00`)
    .join(' | ');
  console.log(`[scheduler] activ - ${schedules || 'niciun serviciu activ'}`);
  return schedulerTask;
}

// The owner must await this BEFORE releasing the data-directory lock. Accepted
// campaigns finish; later cron ticks/manual requests cannot enqueue more work.
function stopScheduler() {
  if (stopping) return stopping;
  acceptingDeliveries = false;
  if (schedulerTask) {
    schedulerTask.stop();
    schedulerTask.destroy();
    schedulerTask = undefined;
  }
  stopping = (async () => {
    await scheduledRun;
    await deliveryQueue;
    // A transport success followed by a disk failure must become durable before
    // the owner hands the lock to another process. Reject so shutdown can retry.
    for (const [key, timestamp] of unrecordedDeliveries) recordDelivery(key, timestamp);
  })().finally(() => { stopping = undefined; });
  return stopping;
}

module.exports = {
  startScheduler,
  stopScheduler,
  runMonthlyReminder,
  runServiceReminder,
  sendRemindersTo,
  isServiceReminderDue,
  isReminderDueNow,
  formatMoney,
};
