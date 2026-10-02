const express = require('express');
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');
const { sendReminderEmail, sendConfirmEmail } = require('./mailer');
const telegram = require('./telegram');
const { startScheduler, sendRemindersTo } = require('./scheduler');
const { currentMonth, localizedMonth, formatMoney } = require('./format');

const app = express();
app.set('view engine', 'ejs');
app.set('views', require('path').join(__dirname, '..', 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use((req, res, next) => {
  if (!req.body) req.body = {};
  next();
});
app.use(express.static(require('path').join(__dirname, '..', 'public')));

function appLanguage() {
  const settings = db.getSettings();
  return settings.language === 'en' || (settings.language !== 'ro' && settings.emailLanguage === 'en') ? 'en' : 'ro';
}

// -------------------------------------------------------------
// Sesiumi simple (in memorie)
// -------------------------------------------------------------
const sessions = new Map();
const COOKIE = 'payreminder_session';

function createSession() {
  const sid = crypto.randomBytes(24).toString('hex');
  sessions.set(sid, Date.now() + 30 * 86400000);
  return sid;
}

function isAuthed(req) {
  const sid = req.cookies_sid;
  if (!sid) return false;
  const exp = sessions.get(sid);
  return !!exp && exp > Date.now();
}

app.use((req, res, next) => {
  const raw = (req.headers.cookie || '').split(';').map((value) => value.trim());
  const row = raw.find((value) => value.startsWith(COOKIE + '='));
  req.cookies_sid = null;
  if (row) {
    const value = decodeURIComponent(row.split('=')[1]);
    const idx = value.lastIndexOf('.');
    if (idx !== -1) {
      const sid = value.slice(0, idx);
      const sig = Buffer.from(value.slice(idx + 1));
      const expected = Buffer.from(hmac(sid));
      if (sig.length === expected.length && crypto.timingSafeEqual(sig, expected)) {
        req.cookies_sid = sid;
      }
    }
  }
  res.locals.authed = isAuthed(req);
  res.locals.currentPath = req.path;
  res.locals.language = appLanguage();
  res.locals.localizedMonth = (month) => localizedMonth(month, res.locals.language);
  next();
});

function requireAdmin(req, res, next) {
  if (!isAuthed(req)) return res.redirect('/admin/login');
  next();
}

const hmac = (data) => crypto.createHmac('sha256', config.sessionSecret).update(data).digest('hex');

// -------------------------------------------------------------
// Helpers
// -------------------------------------------------------------
function paymentForMemberService(member, serviceId, month = currentMonth()) {
  return db.getPaymentByMemberServiceMonth(member.id, serviceId, month) || null;
}

function membershipsForMember(member, month = currentMonth()) {
  return db.getMemberships(member)
    .map((membership) => ({
      service: db.getService(membership.serviceId),
      amount: membership.amount,
      payment: paymentForMemberService(member, membership.serviceId, month),
    }))
    .filter((entry) => entry.service);
}

function membershipsFromBody(body) {
  const ids = [].concat(body.serviceIds || []).map(String).filter(Boolean);
  const amounts = body.amounts || {};
  const result = [];
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const amount = parseFloat(amounts[id]);
    result.push({ serviceId: id, amount: Number.isFinite(amount) ? amount : 0 });
  }
  return result;
}

function selectedServiceId(value) {
  const id = String(value || '');
  return id && db.getService(id) ? id : '';
}

function serviceQuery(serviceId) {
  return serviceId ? `&serviceId=${encodeURIComponent(serviceId)}` : '';
}

function serviceScheduleFromBody(body) {
  const reminderDay = Number.parseInt(body.reminderDay, 10);
  const reminderHour = Number.parseInt(body.reminderHour, 10);
  if (!Number.isInteger(reminderDay) || reminderDay < 1 || reminderDay > 31) return null;
  if (!Number.isInteger(reminderHour) || reminderHour < 0 || reminderHour > 23) return null;
  return { reminderDay, reminderHour };
}

function dashboardStats(serviceId = '') {
  const month = currentMonth();
  const all = [];
  const active = [];
  for (const member of db.getMembers()) {
    for (const membership of db.getMemberships(member)) {
      if (serviceId && membership.serviceId !== serviceId) continue;
      all.push({ member, membership });
      if (member.active) active.push({ member, membership });
    }
  }
  const memberIds = new Set(all.map((entry) => entry.member.id));
  const payments = db.getPayments().filter((payment) =>
    payment.month <= month && month <= (payment.endMonth || payment.month) &&
    memberIds.has(payment.memberId) &&
    (!serviceId || payment.serviceId === serviceId)
  );
  const confirmed = payments.filter((payment) => payment.status === 'confirmed');
  const pending = payments.filter((payment) => payment.status === 'pending');
  const totalDue = active.reduce((sum, entry) => sum + (entry.membership.amount || 0), 0);
  const totalPaid = confirmed.reduce((sum, payment) => sum + payment.amount / (payment.months || 1), 0);
  return {
    month,
    activeMembers: active.length,
    totalMembers: all.length,
    confirmed: confirmed.length,
    pending: pending.length,
    totalDue,
    totalPaid,
  };
}

function serviceForPayment(payment) {
  return db.getService(payment.serviceId) || {
    id: payment.serviceId || '',
    name: payment.serviceName || 'Serviciu',
    paymentUrl: '',
    active: true,
  };
}

// -------------------------------------------------------------
// Pagina publica a utilizatorului
// -------------------------------------------------------------
app.get('/', (req, res) => {
  res.render('landing', { config, currentMonth: currentMonth() });
});

app.get('/p/:token', (req, res) => {
  const member = db.getMemberByToken(req.params.token);
  const errorLocals = { error: null, member: null, memberships: [], done: false, monthLabel: localizedMonth(currentMonth(), res.locals.language) };
  if (!member) return res.status(404).render('member', { ...errorLocals, error: 'Link invalid sau expirat.' });
  if (!member.active) return res.status(403).render('member', { ...errorLocals, error: 'Acces dezactivat. Contacteaza administratorul.' });
  const month = currentMonth();
  const memberships = membershipsForMember(member, month).filter((entry) => entry.service.active !== false);
  if (!memberships.length) {
    return res.status(403).render('member', { ...errorLocals, error: 'Nu esti abonat la niciun serviciu activ. Contacteaza administratorul.' });
  }
  res.render('member', {
    member,
    memberships,
    month,
    monthLabel: localizedMonth(month, res.locals.language),
    humanMonth: (value) => localizedMonth(value, res.locals.language),
    formatMoney: (amount, currency) => formatMoney(amount, currency, res.locals.language),
    currency: config.currency,
    done: req.query.done === '1',
    error: null,
  });
});

app.post('/p/:token/pay', async (req, res) => {
  const member = db.getMemberByToken(req.params.token);
  const errorLocals = { error: null, member: null, memberships: [], done: false, monthLabel: localizedMonth(currentMonth(), res.locals.language) };
  if (!member || !member.active) {
    return res.status(404).render('member', { ...errorLocals, error: 'Link invalid sau expirat.' });
  }
  const serviceId = String(req.body.serviceId || '');
  const service = db.getService(serviceId);
  const membership = db.getMemberMembership(member, serviceId);
  if (!service || service.active === false || !membership) {
    return res.status(403).render('member', { ...errorLocals, error: 'Serviciul nu este activ sau nu esti abonat la el. Contacteaza administratorul.' });
  }

  const month = currentMonth();
  const existing = paymentForMemberService(member, service.id, month);
  if (existing && existing.status === 'pending') {
    await notifyReported(member, service, month, existing);
    return res.redirect(`/p/${member.token}?done=1`);
  }
  if (existing && existing.status === 'confirmed') {
    return res.redirect(`/p/${member.token}?done=1`);
  }
  const payment = db.createPayment({ member, service, month, amount: membership.amount });
  console.log('[pay] notificare plata:', member.name, service.name, month, payment.id);
  await notifyReported(member, service, month, payment);
  res.redirect(`/p/${member.token}?done=1`);
});

async function notifyReported(member, service, month, payment) {
  try {
    await telegram.notifyPaymentReported(
      member,
      localizedMonth(month, appLanguage()),
      formatMoney(payment.amount, config.currency),
      `${config.appUrl}/admin/payments?month=${encodeURIComponent(month)}&serviceId=${encodeURIComponent(service.id || '')}&highlight=${payment.id}`,
      service && service.name
    );
  } catch (err) {
    console.error('[pay] telegram esuat:', err.message);
  }
}

// -------------------------------------------------------------
// Admin - login
// -------------------------------------------------------------
app.get('/admin/login', (req, res) => {
  if (isAuthed(req)) return res.redirect('/admin');
  res.render('admin/login', { error: req.query.err });
});

function safeEqual(given, stored) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(stored));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.post('/admin/login', (req, res) => {
  const givenUser = String(req.body.username || '').trim();
  const givenPassword = String(req.body.password || '');
  const userOk = safeEqual(givenUser, config.adminUser);
  const passwordOk = safeEqual(givenPassword, config.adminPassword);
  if (!userOk || !passwordOk) return res.redirect('/admin/login?err=1');
  const sid = createSession();
  const val = encodeURIComponent(sid) + '.' + hmac(sid);
  res.setHeader('Set-Cookie', `${COOKIE}=${val}; Path=/; HttpOnly; Max-Age=${30 * 86400}`);
  res.redirect('/admin');
});

app.get('/admin/logout', (req, res) => {
  if (req.cookies_sid) sessions.delete(req.cookies_sid);
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
  res.redirect('/admin/login');
});

// -------------------------------------------------------------
// Admin - settings
// -------------------------------------------------------------
app.get('/admin/settings', requireAdmin, (req, res) => {
  res.render('admin/settings', {
    language: appLanguage(),
    saved: req.query.saved === '1',
  });
});

app.post('/admin/settings', requireAdmin, (req, res) => {
  const language = req.body.language === 'en' ? 'en' : 'ro';
  db.updateSettings({ language });
  res.redirect('/admin/settings?saved=1');
});

// -------------------------------------------------------------
// Admin - dashboard
// -------------------------------------------------------------
app.get('/admin', requireAdmin, (req, res) => {
  const month = currentMonth();
  const serviceId = selectedServiceId(req.query.serviceId);
  const services = db.getServices();
  const rows = [];
  for (const member of db.getMembers()) {
    for (const membership of db.getMemberships(member)) {
      if (serviceId && membership.serviceId !== serviceId) continue;
      const service = db.getService(membership.serviceId);
      if (!service) continue;
      const payment = db.getPaymentByMemberServiceMonth(member.id, service.id, month);
      rows.push({
        member,
        service,
        serviceId: service.id,
        amount: membership.amount,
        payment: payment || null,
        paidInAdvance: !!payment && payment.month < month,
      });
    }
  }
  rows.sort((a, b) => (a.member.name || '').localeCompare(b.member.name || '', 'ro'));
  res.render('admin/dashboard', {
    config,
    stats: dashboardStats(serviceId),
    rows,
    services,
    selectedServiceId: serviceId,
    monthLabel: localizedMonth(month, res.locals.language),
    currency: config.currency,
    msg: req.query.msg,
    err: req.query.err,
  });
});

// -------------------------------------------------------------
// Admin - trimitere reamintiri
// -------------------------------------------------------------
app.post('/admin/remind', requireAdmin, async (req, res) => {
  const memberId = req.body.memberId;
  const serviceId = selectedServiceId(req.body.serviceId);
  let members = memberId
    ? db.getMembers().filter((member) => member.id === memberId)
    : db.getMembers().filter((member) => member.active);
  members = members.filter((member) => !serviceId || db.hasMembership(member, serviceId));
  if (!members.length) {
    const message = appLanguage() === 'en'
      ? 'There are no active members to remind.'
      : 'Niciun utilizator activ pentru reamintire.';
    return res.redirect(`/admin?msg=${encodeURIComponent(message)}`);
  }
  const { sent, skipped } = await sendRemindersTo(members, { serviceId: serviceId || undefined });
  const english = appLanguage() === 'en';
  const sentLabel = english ? (sent === 1 ? 'member' : 'members') : (sent === 1 ? 'utilizator' : 'utilizatori');
  const skippedLabel = english
    ? (skipped === 1 ? 'reminder could not be sent' : 'reminders could not be sent')
    : (skipped === 1 ? 'reamintire nu a putut fi trimisă' : 'reamintiri nu au putut fi trimise');
  const message = sent > 0
    ? `${english ? 'Reminder sent to' : 'Reamintire trimisă către'} ${sent} ${sentLabel}.${skipped ? ` ${skipped} ${skippedLabel}.` : ''}`
    : `${english ? 'No reminders could be sent.' : 'Nu s-a putut trimite nicio reamintire.'}${skipped ? ` ${skipped} ${skippedLabel}.` : ''}`;
  res.redirect(`/admin?msg=${encodeURIComponent(message)}${serviceQuery(serviceId)}`);
});

// -------------------------------------------------------------
// Admin - servicii
// -------------------------------------------------------------
app.get('/admin/services', requireAdmin, (req, res) => {
  const services = db.getServices().map((service) => ({
    ...service,
    memberCount: db.getMembersForService(service.id).length,
  }));
  res.render('admin/services', { config, services, msg: req.query.msg, err: req.query.err });
});

app.get('/admin/services/new', requireAdmin, (req, res) => {
  res.render('admin/service-form', {
    config,
    service: null,
    error: req.query.err,
  });
});

app.post('/admin/services', requireAdmin, (req, res) => {
  const name = String(req.body.name || '').trim();
  const paymentUrl = String(req.body.paymentUrl || '').trim();
  const schedule = serviceScheduleFromBody(req.body);
  if (!name || !schedule) return res.redirect('/admin/services/new?err=camplips');
  db.createService({ name, paymentUrl, ...schedule, active: req.body.active === 'on' });
  res.redirect('/admin/services?msg=adaugat');
});

app.get('/admin/services/:id', requireAdmin, (req, res) => {
  const service = db.getService(req.params.id);
  if (!service) return res.redirect('/admin/services?err=nuExista');
  res.render('admin/service-form', { config, service, error: null });
});

app.post('/admin/services/:id', requireAdmin, (req, res) => {
  const name = String(req.body.name || '').trim();
  const paymentUrl = String(req.body.paymentUrl || '').trim();
  const schedule = serviceScheduleFromBody(req.body);
  if (!name || !schedule) return res.redirect(`/admin/services/${req.params.id}?err=camplips`);
  const updated = db.updateService(req.params.id, {
    name,
    paymentUrl,
    ...schedule,
    active: req.body.active === 'on',
  });
  if (!updated) return res.redirect('/admin/services?err=nuExista');
  res.redirect('/admin/services?msg=salvat');
});

app.post('/admin/services/:id/delete', requireAdmin, (req, res) => {
  const service = db.getService(req.params.id);
  if (!service) return res.redirect('/admin/services?err=nuExista');
  if (db.getServices().length <= 1) {
    return res.redirect('/admin/services?err=ultimulServiciu');
  }
  if (db.getMembersForService(service.id).length) {
    return res.redirect('/admin/services?err=areUtilizatori');
  }
  if (db.getPayments().some((payment) => payment.serviceId === service.id)) {
    return res.redirect('/admin/services?err=arePlati');
  }
  db.deleteService(service.id);
  res.redirect('/admin/services?msg=sters');
});

// -------------------------------------------------------------
// Admin - utilizatori
// -------------------------------------------------------------
app.get('/admin/members', requireAdmin, (req, res) => {
  const serviceId = selectedServiceId(req.query.serviceId);
  const services = db.getServices();
  const members = db.getMembers()
    .filter((member) => !serviceId || db.hasMembership(member, serviceId))
    .map((member) => ({
      ...member,
      memberships: db.getMemberships(member),
      membershipServices: db.getMemberships(member)
        .map((membership) => ({ service: db.getService(membership.serviceId), amount: membership.amount }))
        .filter((entry) => entry.service),
      totalAmount: db.getMemberships(member).reduce((sum, membership) => sum + (membership.amount || 0), 0),
    }));
  res.render('admin/members', {
    config,
    members,
    services,
    selectedServiceId: serviceId,
    msg: req.query.msg,
    err: req.query.err,
  });
});

app.get('/admin/members/new', requireAdmin, (req, res) => {
  const services = db.getServices();
  res.render('admin/member-form', {
    config,
    member: null,
    services,
    preselectedServiceId: selectedServiceId(req.query.serviceId) || (services[0] && services[0].id) || '',
    error: req.query.err,
    defaultAmount: config.defaultAmount,
  });
});

app.post('/admin/members', requireAdmin, (req, res) => {
  if (!req.body.name || !req.body.email) {
    return res.redirect('/admin/members/new?err=camplips');
  }
  const memberships = membershipsFromBody(req.body);
  if (!memberships.length || !db.getService(memberships[0].serviceId)) {
    return res.redirect('/admin/members/new?err=serviciuLipsa');
  }
  const created = db.createMember({
    name: req.body.name,
    email: req.body.email,
    active: req.body.active === 'on',
    memberships,
  });
  res.redirect(`/admin/members?msg=adaugat${serviceQuery(created.memberships[0].serviceId)}`);
});

app.get('/admin/members/:id', requireAdmin, (req, res) => {
  const member = db.getMember(req.params.id);
  if (!member) return res.redirect('/admin/members?err=nuExista');
  res.render('admin/member-form', {
    config,
    member: { ...member, memberships: db.getMemberships(member) },
    services: db.getServices(),
    preselectedServiceId: (member.memberships[0] && member.memberships[0].serviceId) || '',
    error: null,
    defaultAmount: config.defaultAmount,
  });
});

app.post('/admin/members/:id', requireAdmin, (req, res) => {
  const member = db.getMember(req.params.id);
  if (!member) return res.redirect('/admin/members?err=nuExista');
  const memberships = membershipsFromBody(req.body);
  if (!memberships.length || !db.getService(memberships[0].serviceId)) {
    return res.redirect(`/admin/members/${req.params.id}?err=serviciuLipsa`);
  }
  const updated = db.updateMember(req.params.id, {
    name: req.body.name,
    email: req.body.email,
    active: req.body.active === 'on',
    memberships,
  });
  res.redirect(`/admin/members?msg=salvat${serviceQuery(updated.memberships[0].serviceId)}`);
});

app.post('/admin/members/:id/delete', requireAdmin, (req, res) => {
  const member = db.getMember(req.params.id);
  db.deleteMember(req.params.id);
  const serviceId = member && member.memberships && member.memberships[0] ? member.memberships[0].serviceId : '';
  res.redirect(`/admin/members?msg=sters${serviceQuery(serviceId)}`);
});

// -------------------------------------------------------------
// Admin - plati
// -------------------------------------------------------------
app.get('/admin/payments', requireAdmin, (req, res) => {
  const month = req.query.month || currentMonth();
  const serviceId = selectedServiceId(req.query.serviceId);
  const services = db.getServices();
  const payments = db.getPayments()
    .filter((payment) =>
      payment.month <= month && month <= (payment.endMonth || payment.month) &&
      (!serviceId || payment.serviceId === serviceId) &&
      (!req.query.status || payment.status === req.query.status)
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.render('admin/payments', {
    config,
    payments,
    services,
    members: db.getMembers(),
    selectedServiceId: serviceId,
    month,
    monthLabel: localizedMonth(month, res.locals.language),
    highlight: req.query.highlight,
    stepBack: monthIndexDiff(month, -1),
    stepForward: monthIndexDiff(month, 1),
    msg: req.query.msg,
    err: req.query.err,
    humanMonth: (value) => localizedMonth(value, res.locals.language),
  });
});

app.post('/admin/payments/advance', requireAdmin, (req, res) => {
  const member = db.getMember(String(req.body.memberId || ''));
  const service = db.getService(String(req.body.serviceId || ''));
  const month = String(req.body.month || '');
  const months = Number.parseInt(req.body.months, 10);
  if (!member || !service || !db.hasMembership(member, service.id) ||
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !Number.isInteger(months) || months < 1 || months > 120) {
    return res.redirect('/admin/payments?err=plataInvalida');
  }
  const membership = db.getMemberMembership(member, service.id);
  const [year, monthNumber] = month.split('-').map(Number);
  const endDate = new Date(year, monthNumber - 1 + months - 1, 1);
  const endMonth = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}`;
  const overlap = db.getPayments().some((payment) =>
    payment.memberId === member.id && payment.serviceId === service.id &&
    payment.month <= endMonth && (payment.endMonth || payment.month) >= month
  );
  if (overlap) return res.redirect(`/admin/payments?month=${encodeURIComponent(month)}&serviceId=${encodeURIComponent(service.id)}&err=perioadaOcupata`);
  const payment = db.createPayment({ member, service, month, months, amount: membership.amount * months });
  db.setPaymentStatus(payment.id, 'confirmed');
  const successMessage = appLanguage() === 'en'
    ? 'Advance payment recorded and confirmed.'
    : 'Plata în avans a fost înregistrată și confirmată.';
  const redirectUrl = `/admin/payments?month=${encodeURIComponent(month)}&serviceId=${encodeURIComponent(service.id)}&msg=${encodeURIComponent(successMessage)}`;
  if (config.sendConfirmToMember && member.active) {
    sendConfirmEmail(member, month, { service, amount: payment.amount, endMonth: payment.endMonth }).catch((err) =>
      console.error('[confirm] email utilizator esuat:', err.message)
    );
  }
  res.redirect(redirectUrl);
});

function monthIndexDiff(month, diff) {
  const [year, monthNumber] = month.split('-').map(Number);
  const date = new Date(year, monthNumber - 1 + diff, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

app.post('/admin/payments/:id/confirm', requireAdmin, async (req, res) => {
  const payment = db.getPayment(req.params.id);
  if (!payment) return res.redirect('/admin/payments?msg=nuExista');
  db.setPaymentStatus(payment.id, 'confirmed');
  const service = serviceForPayment(payment);
  const member = db.getMember(payment.memberId);
  if (config.sendConfirmToMember && member && member.active) {
    sendConfirmEmail(member, payment.month, { service, amount: payment.amount, endMonth: payment.endMonth || payment.month }).catch((err) =>
      console.error('[confirm] email utilizator esuat:', err.message)
    );
  }
  const message = appLanguage() === 'en'
    ? 'Payment confirmed successfully.'
    : 'Plata a fost confirmată cu succes.';
  const redirectUrl = req.body && req.body.returnTo === '/admin'
    ? `/admin?msg=${encodeURIComponent(message)}`
    : `/admin/payments?month=${encodeURIComponent(payment.month)}&msg=${encodeURIComponent(message)}${serviceQuery(payment.serviceId)}`;
  res.redirect(redirectUrl);
});

app.post('/admin/payments/:id/delete', requireAdmin, (req, res) => {
  const payment = db.getPayment(req.params.id);
  if (!payment) return res.redirect('/admin/payments?err=nuExista');
  db.deletePayment(req.params.id);
  const message = appLanguage() === 'en' ? 'Payment was deleted.' : 'Plata a fost ștearsă.';
  res.redirect(`/admin/payments?month=${encodeURIComponent(payment.month)}&msg=${encodeURIComponent(message)}${serviceQuery(payment.serviceId)}`);
});

// -------------------------------------------------------------
app.use((req, res) =>
  res.status(404).render('member', { error: 'Pagina nu exista.', member: null, memberships: [], done: false, monthLabel: localizedMonth(currentMonth(), res.locals.language) })
);

const server = app.listen(config.port, () => {
  console.log(`[server] PayReminder ruleaza pe http://localhost:${config.port}`);
  console.log(`[server] panou admin: http://localhost:${config.port}/admin`);
});

startScheduler();

module.exports = { app, server };
