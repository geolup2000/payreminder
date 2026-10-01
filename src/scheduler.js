const cron = require('node-cron');
const db = require('./db');
const { sendReminderEmail } = require('./mailer');
const { currentMonth, humanMonth, formatMoney } = require('./format');

async function sendRemindersTo(members, opts = {}) {
  const pairs = [];
  for (const member of members) {
    if (!member.active) continue;
    for (const membership of db.getMemberships(member)) {
      if (opts.serviceId && membership.serviceId !== opts.serviceId) continue;
      const service = db.getService(membership.serviceId);
      if (!service || service.active === false) continue;
      if (db.getPaymentByMemberServiceMonth(member.id, service.id, currentMonth())) continue;
      pairs.push({ member, service, amount: membership.amount });
    }
  }

  if (!pairs.length) {
    console.log('[reminder] niciun email de trimis');
    return { sent: 0, skipped: 0 };
  }

  let sent = 0;
  let skipped = 0;
  for (const { member, service, amount } of pairs) {
    try {
      const month = opts.month || currentMonth();
      const result = await sendReminderEmail(member, { month, service, amount });
      if (result && result.skipped) skipped++;
      else sent++;
    } catch (err) {
      skipped++;
      console.error('[reminder] esec pentru', member.email, err.message);
    }
  }
  return { sent, skipped };
}

function isServiceReminderDue(service, date = new Date()) {
  if (!service || service.active === false) return false;
  const day = Number.parseInt(service.reminderDay, 10);
  const hour = Number.parseInt(service.reminderHour, 10);
  return date.getDate() === day && date.getHours() === hour;
}

async function runServiceReminder(service, date = new Date()) {
  if (!isServiceReminderDue(service, date)) {
    return { serviceId: service.id, serviceName: service.name, skipped: true, reason: 'nu este ora acestui serviciu' };
  }

  const month = currentMonth();
  if (db.getLastReminderMonth(service.id) === month) {
    return { serviceId: service.id, serviceName: service.name, skipped: true, reason: 'deja trimis luna aceasta' };
  }

  const members = db.getMembers().filter((member) => member.active && db.hasMembership(member, service.id));
  const { sent, skipped } = await sendRemindersTo(members, { month, serviceId: service.id, dontRecord: true });
  if (sent > 0) db.setLastReminderMonth(service.id, month);
  console.log(`[reminder] ${service.name}: ${sent} emailuri pentru ${humanMonth(month)}`);
  return { serviceId: service.id, serviceName: service.name, month, sent, skipped };
}

async function runMonthlyReminder(date = new Date()) {
  const month = currentMonth();
  const dueServices = db.getServices().filter((service) => isServiceReminderDue(service, date));
  const results = [];
  for (const service of dueServices) {
    results.push(await runServiceReminder(service, date));
  }
  return { month, services: results };
}

function isReminderDueNow(date = new Date()) {
  return db.getServices().some((service) => isServiceReminderDue(service, date));
}

function startScheduler() {
  let running = false;
  // Verifica in fiecare minut programarea fiecarui serviciu.
  cron.schedule('* * * * *', () => {
    if (!running && isReminderDueNow()) {
      running = true;
      runMonthlyReminder()
        .catch((err) => console.error('[scheduler] eroare:', err))
        .finally(() => { running = false; });
    }
  });
  const schedules = db.getServices()
    .filter((service) => service.active !== false)
    .map((service) => `${service.name}: ziua ${service.reminderDay}, ora ${String(service.reminderHour).padStart(2, '0')}:00`)
    .join(' | ');
  console.log(`[scheduler] activ - ${schedules || 'niciun serviciu activ'}`);
}

module.exports = {
  startScheduler,
  runMonthlyReminder,
  runServiceReminder,
  sendRemindersTo,
  isServiceReminderDue,
  isReminderDueNow,
  formatMoney,
};
