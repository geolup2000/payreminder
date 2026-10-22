const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizeAmount, normalizePersistedAmount, multiplyAmount } = require('./money');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILES = {
  services: path.join(DATA_DIR, 'services.json'),
  members: path.join(DATA_DIR, 'members.json'),
  payments: path.join(DATA_DIR, 'payments.json'),
  settings: path.join(DATA_DIR, 'settings.json'),
};

const DEFAULT_SERVICE_NAME = process.env.DEFAULT_SERVICE_NAME || 'Serviciu principal';
const DEFAULT_REMINDER_DAY = () => 10;
const DEFAULT_REMINDER_HOUR = () => 10;

function readJson(file, fallback) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const valid = file === FILES.settings
      ? object(data)
      : Array.isArray(data) && data.every(record => object(record) && typeof record.id === 'string' && record.id.length > 0);
    if (!valid) throw new TypeError(`Malformed data in ${path.basename(file)}`);
    if (file === FILES.settings) {
      for (const field of ['lastReminderMonths', 'reminderDeliveries']) {
        if (data[field] !== undefined && !object(data[field])) throw new TypeError(`Malformed settings.${field}`);
      }
    } else {
      for (const record of data) {
        if (record.active !== undefined && typeof record.active !== 'boolean') throw new TypeError('Malformed active flag');
        if (file === FILES.services) {
          for (const [field, min, max] of [['reminderDay', 1, 31], ['reminderHour', 0, 23]]) {
            if (record[field] !== undefined &&
                !((typeof record[field] === 'number' || typeof record[field] === 'string') &&
                  /^\d+$/.test(String(record[field])) && Number(record[field]) >= min && Number(record[field]) <= max)) {
              throw new TypeError(`Malformed service.${field}`);
            }
          }
        }
        if (file === FILES.payments && record.amount !== undefined) {
          try { record.amount = normalizePersistedAmount(record.amount); }
          catch (error) { throw new TypeError(`Malformed payment amount: ${error.message}`); }
        }
      }
    }
    if (file === FILES.members) {
      for (const member of data) {
        if (member.amount !== undefined) member.amount = normalizePersistedAmount(member.amount);
        if (member.memberships !== undefined) {
          if (!Array.isArray(member.memberships) || !member.memberships.every(m => object(m) && typeof m.serviceId === 'string')) {
            throw new TypeError('Malformed member memberships');
          }
          for (const membership of member.memberships) membership.amount = normalizePersistedAmount(membership.amount);
        }
      }
    }
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let created = false;
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    created = true;
    try {
      fs.writeFileSync(fd, JSON.stringify(data, null, 2));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } finally {
    if (created && fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

let releaseDataLock;

// Hold for the entire server lifetime. Never unlink another owner's lock, even
// when its PID is stale: PID reuse and competing reclaimers make that unsafe.
function acquireDataLock() {
  if (releaseDataLock) return releaseDataLock;
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(DATA_DIR, '.payreminder.lock');
  const owner = { pid: process.pid, token: crypto.randomUUID() };
  let fd;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let state = 'unreadable or malformed';
    try {
      const previous = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Number.isSafeInteger(previous.pid) && previous.pid > 0) {
        try { process.kill(previous.pid, 0); state = `live PID ${previous.pid}`; }
        catch (probe) { state = probe.code === 'ESRCH' ? `stale PID ${previous.pid}` : `unverifiable PID ${previous.pid}`; }
      }
    } catch { /* Fail closed; incomplete lock creation may still be in flight. */ }
    throw new Error(`Data directory lock exists (${state}): ${file}. Manual recovery required: stop all instances and verify the owner is gone before removing the lock.`);
  }
  try {
    fs.writeFileSync(fd, JSON.stringify(owner));
    fs.fsyncSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    fs.unlinkSync(file);
    throw error;
  }
  fs.closeSync(fd);
  const release = () => {
    try {
      const current = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (current.pid === owner.pid && current.token === owner.token) fs.unlinkSync(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    } finally {
      process.removeListener('exit', release);
      releaseDataLock = undefined;
    }
  };
  releaseDataLock = release;
  process.once('exit', release);
  return release;
}

const uuid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();
const days = (n) => new Date(Date.now() + n * 86400000).toISOString();

function normalizeInteger(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

function defaultService() {
  return {
    id: uuid(),
    name: DEFAULT_SERVICE_NAME,
    paymentUrl: '',
    reminderDay: DEFAULT_REMINDER_DAY(),
    reminderHour: DEFAULT_REMINDER_HOUR(),
    active: true,
    createdAt: nowIso(),
  };
}

// ---------------------------------------------------------
// Servicii
// ---------------------------------------------------------
function getServices() {
  const services = readJson(FILES.services, []);
  if (!Array.isArray(services) || services.length === 0) {
    const initial = [defaultService()];
    writeJson(FILES.services, initial);
    return initial;
  }
  let changed = false;
  for (const service of services) {
    const reminderDay = normalizeInteger(service.reminderDay, 1, 31, DEFAULT_REMINDER_DAY());
    const reminderHour = normalizeInteger(service.reminderHour, 0, 23, DEFAULT_REMINDER_HOUR());
    if (service.reminderDay !== reminderDay) {
      service.reminderDay = reminderDay;
      changed = true;
    }
    if (service.reminderHour !== reminderHour) {
      service.reminderHour = reminderHour;
      changed = true;
    }
    if (service.active === undefined) {
      service.active = true;
      changed = true;
    }
  }
  if (changed) writeJson(FILES.services, services);
  return services;
}

function saveServices(list) {
  writeJson(FILES.services, list);
}

function getService(id) {
  return getServices().find((service) => service.id === id) || null;
}

function getServiceForMember(memberOrId) {
  let member = typeof memberOrId === 'string' ? null : memberOrId;
  if (typeof memberOrId === 'string') member = getMember(memberOrId) || { serviceId: memberOrId };
  const firstMembership = Array.isArray(member.memberships) && member.memberships.length
    ? getService(member.memberships[0].serviceId)
    : null;
  return firstMembership || getService(member.serviceId) || getServices()[0] || null;
}

function createService({ name, paymentUrl, reminderDay, reminderHour, active }) {
  const services = getServices();
  const service = {
    id: uuid(),
    name: String(name || '').trim(),
    paymentUrl: String(paymentUrl || '').trim(),
    reminderDay: normalizeInteger(reminderDay, 1, 31, DEFAULT_REMINDER_DAY()),
    reminderHour: normalizeInteger(reminderHour, 0, 23, DEFAULT_REMINDER_HOUR()),
    active: active !== false,
    createdAt: nowIso(),
  };
  services.push(service);
  saveServices(services);
  return service;
}

function updateService(id, patch) {
  const services = getServices();
  const index = services.findIndex((service) => service.id === id);
  if (index === -1) return null;
  services[index] = {
    ...services[index],
    ...patch,
    id,
    name: String(patch.name !== undefined ? patch.name : services[index].name).trim(),
    paymentUrl: String(
      patch.paymentUrl !== undefined ? patch.paymentUrl : services[index].paymentUrl || ''
    ).trim(),
    reminderDay: normalizeInteger(
      patch.reminderDay !== undefined ? patch.reminderDay : services[index].reminderDay,
      1,
      31,
      DEFAULT_REMINDER_DAY()
    ),
    reminderHour: normalizeInteger(
      patch.reminderHour !== undefined ? patch.reminderHour : services[index].reminderHour,
      0,
      23,
      DEFAULT_REMINDER_HOUR()
    ),
    active: patch.active !== undefined ? patch.active !== false : services[index].active !== false,
  };
  saveServices(services);
  return services[index];
}

function deleteService(id) {
  const services = getServices();
  saveServices(services.filter((service) => service.id !== id));
}

function hasMembership(member, serviceId) {
  return !!member && Array.isArray(member.memberships) && member.memberships.some((m) => m.serviceId === serviceId);
}

function getMembersForService(serviceId) {
  return getMembers().filter((member) => hasMembership(member, serviceId));
}

// ---------------------------------------------------------
// Utilizatori / membri
// ---------------------------------------------------------
function normalizeMemberships({ memberships, serviceIds, serviceId, amount } = {}) {
  const services = getServices();
  const validIds = new Set(services.map((service) => service.id));
  const result = [];
  const seen = new Set();
  const push = (id, amt) => {
    if (!validIds.has(id) || seen.has(id)) return;
    seen.add(id);
    result.push({ serviceId: id, amount: normalizeAmount(amt === undefined ? 0 : amt) });
  };
  if (Array.isArray(memberships)) {
    for (const m of memberships) {
      if (m && m.serviceId) push(m.serviceId, m.amount !== undefined ? m.amount : amount);
    }
  } else if (Array.isArray(serviceIds)) {
    for (const id of serviceIds) push(id, amount);
  } else if (serviceId) {
    push(serviceId, amount);
  } else {
    push(services[0].id, amount);
  }
  if (!result.length) result.push({ serviceId: services[0].id, amount: normalizeAmount(amount === undefined ? 0 : amount) });
  return result;
}

function getMembers() {
  const members = readJson(FILES.members, []);
  const services = getServices();
  const serviceIds = new Set(services.map((service) => service.id));
  for (const member of members) {
    if (!Array.isArray(member.memberships) || member.memberships.length === 0) {
      // Migrare: vechiul format cu un singur serviciu.
      const legacyAmount = member.amount === undefined ? 0 : member.amount;
      const legacyIds = Array.isArray(member.serviceIds) ? member.serviceIds : [];
      const rawIds = legacyIds.length
        ? legacyIds
        : member.serviceId && serviceIds.has(member.serviceId) ? [member.serviceId] : [];
      member.memberships = (rawIds.length ? rawIds : [services[0].id]).map((id) => ({
        serviceId: id,
        amount: legacyAmount,
      }));
    }

    // Normalizare memberships: pastram doar servicii existente, fara duplicate.
    const normalized = [];
    const seen = new Set();
    for (const m of member.memberships) {
      if (!m || !serviceIds.has(m.serviceId) || seen.has(m.serviceId)) continue;
      seen.add(m.serviceId);
      normalized.push({ serviceId: m.serviceId, amount: normalizeAmount(m.amount) });
    }
    if (!normalized.length) normalized.push({ serviceId: services[0].id, amount: 0 });
    member.memberships = normalized;

    // Oglinda pentru compatibilitate cu codul vechi.
    const first = normalized[0];
    if (member.serviceId !== first.serviceId) {
      member.serviceId = first.serviceId;
    }
    if (Number(member.amount) !== Number(first.amount)) {
      member.amount = first.amount;
    }
  }
  // Legacy migration is an in-memory view; persist only on an explicit write.
  return members;
}

function saveMembers(list) {
  writeJson(FILES.members, list);
}

function getMember(id) {
  return getMembers().find((member) => member.id === id);
}

function getMemberByToken(token) {
  return getMembers().find((member) => member.token === token);
}

function getMemberships(member) {
  if (!member || !Array.isArray(member.memberships)) return [];
  const services = getServices();
  return member.memberships
    .filter((m) => services.some((service) => service.id === m.serviceId))
    .map((m) => ({ serviceId: m.serviceId, amount: normalizeAmount(m.amount) }));
}

function getMemberMembership(member, serviceId) {
  if (!member || !Array.isArray(member.memberships)) return null;
  const membership = member.memberships.find((m) => m.serviceId === serviceId);
  return membership ? { serviceId: membership.serviceId, amount: normalizeAmount(membership.amount) } : null;
}

function createMember({ name, email, amount, active, serviceId, serviceIds, memberships }) {
  const membersList = getMembers();
  const normalized = normalizeMemberships({ memberships, serviceIds, serviceId, amount });
  const member = {
    id: uuid(),
    memberships: normalized,
    serviceId: normalized[0].serviceId,
    amount: normalized[0].amount,
    name: String(name || '').trim(),
    email: String(email || '').trim().toLowerCase(),
    active: active !== false,
    token: crypto.randomBytes(16).toString('hex'),
    createdAt: nowIso(),
  };
  membersList.push(member);
  saveMembers(membersList);
  return member;
}

function updateMember(id, patch) {
  const membersList = getMembers();
  const index = membersList.findIndex((member) => member.id === id);
  if (index === -1) return null;
  const existing = membersList[index];
  const next = {
    ...existing,
    ...patch,
    id: existing.id,
    token: existing.token,
    createdAt: existing.createdAt,
  };
  const hasMembershipPatch =
    patch.memberships !== undefined ||
    patch.serviceIds !== undefined ||
    patch.serviceId !== undefined;
  if (hasMembershipPatch) {
    const normalized = normalizeMemberships({
      memberships: patch.memberships,
      serviceIds: patch.serviceIds,
      serviceId: patch.serviceId,
      amount: patch.amount !== undefined ? patch.amount : existing.amount,
    });
    next.memberships = normalized;
    next.serviceId = normalized[0].serviceId;
    next.amount = normalized[0].amount;
  } else if (patch.amount !== undefined) {
    next.amount = normalizeAmount(patch.amount);
    next.memberships = existing.memberships.map((membership, index) => index === 0
      ? { ...membership, amount: next.amount } : membership);
  }
  next.email = String(patch.email !== undefined ? patch.email : existing.email).trim().toLowerCase();
  next.name = String(patch.name !== undefined ? patch.name : existing.name).trim();
  next.active = patch.active !== undefined ? patch.active !== false : existing.active !== false;
  membersList[index] = next;
  saveMembers(membersList);
  return membersList[index];
}

function deleteMember(id) {
  saveMembers(getMembers().filter((member) => member.id !== id));
}

// ---------------------------------------------------------
// Plati
// ---------------------------------------------------------
function getPayments() {
  const payments = readJson(FILES.payments, []);
  const services = getServices();
  const members = getMembers();
  const memberById = new Map(members.map((member) => [member.id, member]));
  for (const payment of payments) {
    const member = memberById.get(payment.memberId);
    const service = getService(payment.serviceId) || (member && getServiceForMember(member)) || services[0];
    if (service && payment.serviceId !== service.id) {
      payment.serviceId = service.id;
    }
    if (!payment.serviceName && service) {
      payment.serviceName = service.name;
    }
  }
  // Preserve original legacy JSON until a payment mutation explicitly saves it.
  return payments;
}

function savePayments(list) {
  writeJson(FILES.payments, list);
}

function getPayment(id) {
  return getPayments().find((payment) => payment.id === id);
}

function getPaymentByMemberMonth(memberId, month) {
  return getPayments().find((payment) => payment.memberId === memberId && payment.month === month);
}

function getPaymentByMemberServiceMonth(memberId, serviceId, month) {
  return getPayments().find(
    (payment) => payment.memberId === memberId && payment.serviceId === serviceId &&
      payment.month <= month && month <= (payment.endMonth || payment.month)
  );
}

function createPayment({ member, service, month, months = 1, amount, confirmed = false, reported = false }) {
  const payments = getPayments();
  const actualService = service || getServiceForMember(member);
  const fallbackMembership = (member.memberships && member.memberships[0]) || {};
  const count = Math.max(1, Math.min(120, Number.parseInt(months, 10) || 1));
  const [year, monthNumber] = month.split('-').map(Number);
  const lastDate = new Date(year, monthNumber - 1 + count - 1, 1);
  const endMonth = `${lastDate.getFullYear()}-${String(lastDate.getMonth() + 1).padStart(2, '0')}`;
  const payment = {
    id: uuid(),
    serviceId: actualService ? actualService.id : fallbackMembership.serviceId || null,
    serviceName: actualService ? actualService.name : member.serviceName || 'Serviciu',
    memberId: member.id,
    memberName: member.name,
    memberEmail: member.email,
    month,
    endMonth,
    months: count,
    amount: normalizeAmount(amount),
    status: confirmed ? 'confirmed' : 'pending',
    createdAt: nowIso(),
    confirmedAt: confirmed ? nowIso() : null,
    ...(reported ? { reportNotifications: { telegram: 'pending', discord: 'pending' } } : {}),
  };
  payments.push(payment);
  savePayments(payments);
  return payment;
}

function setPaymentStatus(id, status) {
  const payments = getPayments();
  const index = payments.findIndex((payment) => payment.id === id);
  if (index === -1) return null;
  payments[index].status = status;
  payments[index].confirmedAt = status === 'confirmed' ? payments[index].confirmedAt || nowIso() : null;
  savePayments(payments);
  return payments[index];
}

function markPaymentNotificationSent(id, channel) {
  if (!['telegram', 'discord'].includes(channel)) throw new TypeError('Invalid notification channel');
  const payments = getPayments();
  const payment = payments.find(payment => payment.id === id);
  if (!payment) return;
  payment.reportNotifications = { ...payment.reportNotifications, [channel]: 'sent' };
  savePayments(payments);
}

function deletePayment(id) {
  savePayments(getPayments().filter((payment) => payment.id !== id));
}

function markListConfirmed(ids, status) {
  const payments = getPayments();
  const now = nowIso();
  for (const payment of payments) {
    if (ids.includes(payment.id)) {
      payment.status = status;
      payment.confirmedAt = status === 'confirmed' ? payment.confirmedAt || now : null;
    }
  }
  savePayments(payments);
}

// ---------------------------------------------------------
function getSettings() {
  return readJson(FILES.settings, {});
}

function updateSettings(patch) {
  const settings = { ...getSettings(), ...patch };
  writeJson(FILES.settings, settings);
  return settings;
}

function ensureReminderMonths(settings = getSettings()) {
  if (settings.lastReminderMonths || !settings.lastReminderMonth) return settings.lastReminderMonths || {};
  const months = {};
  for (const service of getServices()) months[service.id] = settings.lastReminderMonth;
  writeJson(FILES.settings, { ...settings, lastReminderMonths: months });
  return months;
}

function getLastReminderMonth(serviceId) {
  const settings = getSettings();
  const months = ensureReminderMonths(settings);
  return Object.prototype.hasOwnProperty.call(months, serviceId) ? months[serviceId] : null;
}

function setLastReminderMonth(serviceId, month) {
  const settings = getSettings();
  const months = { ...ensureReminderMonths(settings) };
  months[serviceId] = month;
  writeJson(FILES.settings, { ...settings, lastReminderMonths: months });
  return months[serviceId];
}

function migrateLegacyReminderDeliveries() {
  const settings = getSettings();
  if (settings.reminderDeliveryVersion === 1) return;
  const deliveries = { ...settings.reminderDeliveries };
  const services = getServices();
  const members = getMembers();
  // Snapshot legacy blanket suppression once, for current subscriptions only.
  // New campaigns never write service/month completion markers. Preserve the
  // old fields for compatibility, but the scheduler no longer gates on them.
  for (const service of services) {
    const month = settings.lastReminderMonths
      ? settings.lastReminderMonths[service.id] : settings.lastReminderMonth;
    if (!month) continue;
    for (const member of members) {
      if (!hasMembership(member, service.id)) continue;
      const key = JSON.stringify([member.id, service.id, month]);
      if (!deliveries[key]) deliveries[key] = `legacy:${month}`;
    }
  }
  updateSettings({
    reminderDeliveryVersion: 1,
    ...(Object.keys(deliveries).length ? { reminderDeliveries: deliveries } : {}),
  });
}

module.exports = {
  acquireDataLock,
  normalizeAmount,
  multiplyAmount,
  getServices,
  saveServices,
  getService,
  getServiceForMember,
  createService,
  updateService,
  deleteService,
  getMembersForService,
  hasMembership,
  getMembers,
  getMember,
  getMemberByToken,
  createMember,
  updateMember,
  deleteMember,
  getMemberships,
  getMemberMembership,
  getPayments,
  getPayment,
  getPaymentByMemberMonth,
  getPaymentByMemberServiceMonth,
  createPayment,
  setPaymentStatus,
  markPaymentNotificationSent,
  deletePayment,
  markListConfirmed,
  getSettings,
  updateSettings,
  getLastReminderMonth,
  setLastReminderMonth,
  migrateLegacyReminderDeliveries,
  uuid,
  nowIso,
  days,
};
