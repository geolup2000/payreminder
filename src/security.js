const crypto = require('crypto');

function safeEqual(given, stored) {
  if (typeof given !== 'string' || typeof stored !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(stored);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cookieValue(header, name) {
  for (const part of String(header || '').split(';')) {
    const row = part.trim();
    if (!row.startsWith(name + '=')) continue;
    try { return decodeURIComponent(row.slice(name.length + 1)); }
    catch { /* Ignore malformed cookies. */ }
  }
  return '';
}

function pruneExpiredSessions(sessions, now = Date.now()) {
  for (const [sid, expires] of sessions) {
    if (expires <= now) sessions.delete(sid);
  }
}

module.exports = { safeEqual, cookieValue, pruneExpiredSessions };
