const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
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
    result.push({ serviceId: id, amount: parseFloat(amt) || 0 });
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
  if (!result.length) result.push({ serviceId: services[0].id, amount: parseFloat(amount) || 0 });
  return result;
}

function getMembers() {
  const members = readJson(FILES.members, []);
  const services = getServices();
  const serviceIds = new Set(services.map((service) => service.id));
  let changed = false;
  for (const member of members) {
    if (!Array.isArray(member.memberships) || member.memberships.length === 0) {
      // Migrare: vechiul format cu un singur serviciu.
      const legacyAmount = parseFloat(member.amount) || 0;
      const legacyIds = Array.isArray(member.serviceIds) ? member.serviceIds : [];
      const rawIds = legacyIds.length
        ? legacyIds
        : member.serviceId && serviceIds.has(member.serviceId) ? [member.serviceId] : [];
      member.memberships = (rawIds.length ? rawIds : [services[0].id]).map((id) => ({
        serviceId: id,
        amount: legacyAmount,
      }));
      changed = true;
    }

    // Normalizare memberships: pastram doar servicii existente, fara duplicate.
    const normalized = [];
    const seen = new Set();
    for (const m of member.memberships) {
      if (!m || !serviceIds.has(m.serviceId) || seen.has(m.serviceId)) continue;
      seen.add(m.serviceId);
      normalized.push({ serviceId: m.serviceId, amount: parseFloat(m.amount) || 0 });
    }
    if (normalized.length !== (member.memberships || []).length) changed = true;
    if (!normalized.length) normalized.push({ serviceId: services[0].id, amount: 0 });
    member.memberships = normalized;

    // Oglinda pentru compatibilitate cu codul vechi.
    const first = normalized[0];
    if (member.serviceId !== first.serviceId) {
      member.serviceId = first.serviceId;
      changed = true;
    }
    if (Number(member.amount) !== Number(first.amount)) {
      member.amount = first.amount;
      changed = true;
    }
  }
  if (changed) writeJson(FILES.members, members);
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
    .map((m) => ({ serviceId: m.serviceId, amount: parseFloat(m.amount) || 0 }));
}

function getMemberMembership(member, serviceId) {
  if (!member || !Array.isArray(member.memberships)) return null;
  const membership = member.memberships.find((m) => m.serviceId === serviceId);
  return membership ? { serviceId: membership.serviceId, amount: parseFloat(membership.amount) || 0 } : null;
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
      memberships: patch.memberships !== undefined ? patch.memberships : existing.memberships,
      serviceIds: patch.serviceIds !== undefined ? patch.serviceIds : existing.serviceIds,
      serviceId: patch.serviceId !== undefined ? patch.serviceId : existing.serviceId,
      amount: patch.amount !== undefined ? patch.amount : existing.amount,
    });
    next.memberships = normalized;
    next.serviceId = normalized[0].serviceId;
    next.amount = normalized[0].amount;
  } else if (patch.amount !== undefined) {
    next.amount = parseFloat(patch.amount) || 0;
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
  let changed = false;
  for (const payment of payments) {
    const member = memberById.get(payment.memberId);
    const service = getService(payment.serviceId) || (member && getServiceForMember(member)) || services[0];
    if (service && payment.serviceId !== service.id) {
      payment.serviceId = service.id;
      changed = true;
    }
    if (!payment.serviceName && service) {
      payment.serviceName = service.name;
      changed = true;
    }
  }
  if (changed) writeJson(FILES.payments, payments);
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

function createPayment({ member, service, month, months = 1, amount }) {
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
    amount,
    status: 'confirmed',
    createdAt: nowIso(),
    confirmedAt: nowIso(),
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
  if (status === 'confirmed') payments[index].confirmedAt = nowIso();
  savePayments(payments);
  return payments[index];
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
      if (status === 'confirmed') payment.confirmedAt = now;
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

module.exports = {
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
  deletePayment,
  markListConfirmed,
  getSettings,
  updateSettings,
  getLastReminderMonth,
  setLastReminderMonth,
  uuid,
  nowIso,
  days,
};
