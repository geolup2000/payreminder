const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createRequire, Module } = require('node:module');

async function fixture(t, overrides = {}, schedulerOverrides = {}) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || '/home/hermes/.hermes/cache/scratch', 'payreminder-http-'));
  const project = path.join(__dirname, '..');
  for (const dir of ['src', 'views', 'public']) fs.cpSync(path.join(project, dir), path.join(root, dir), { recursive: true });
  fs.symlinkSync(path.join(project, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  const localRequire = createRequire(path.join(root, 'src/server.js'));
  const db = localRequire('./db');
  const calls = { reported: 0, confirmed: 0, tests: 0, validated: 0, locked: 0 };
  const config = { port: 0, appUrl: 'http://localhost:3000', adminUser: 'admin', adminPassword: 'fixture-unique-password', sessionSecret: 'fixture-unique-session-secret-at-least-32-characters', trustProxy: false, currency: 'RON', defaultAmount: 10, sendConfirmToMember: true, ...overrides,
    validateRuntimeConfig() { calls.validated++; return localRequire('./config').validateRuntimeConfig(config); } };
  const dependencies = {
    './config': config, './db': { ...db, acquireDataLock() { assert.equal(calls.validated, 1); calls.locked++; return db.acquireDataLock(); } },
    './mailer': { sendConfirmEmail: async () => { calls.confirmed++; } },
    './telegram': { notifyPaymentReported: async () => { calls.reported++; } },
    './discord': { notifyPaymentReported: async () => { calls.reported++; } },
    './scheduler': { startScheduler() {}, stopScheduler: async () => {}, sendRemindersTo: async () => ({ sent: 0, skipped: 0 }), ...schedulerOverrides },
    './notification-check': { testNotification: async () => { calls.tests++; return { status: 200, body: { ok: true } }; } },
    './notification-settings': { getNotificationSettings: () => ({ telegram: {}, discord: {} }), notificationSettingsFromBody: () => ({}) },
  };
  const loaded = new Module(path.join(root, 'src/server.js'));
  loaded.filename = path.join(root, 'src/server.js');
  loaded.require = (name) => Object.hasOwn(dependencies, name) ? dependencies[name] : localRequire(name);
  loaded._compile(fs.readFileSync(loaded.filename, 'utf8'), loaded.filename);
  const { server } = loaded.exports;
  await new Promise((resolve) => server.listening ? resolve() : server.once('listening', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (url, options = {}) => fetch(base + url, { redirect: 'manual', ...options });
  async function login() {
    const page = await request('/admin/login');
    const html = await page.text();
    const csrf = html.match(/name="_csrf" value="([^"]+)"/)?.[1];
    const preCookie = page.headers.get('set-cookie')?.split(';')[0] || '';
    const response = await request('/admin/login', { method: 'POST', headers: { Cookie: preCookie, Origin: new URL(config.appUrl).origin }, body: new URLSearchParams({ username: config.adminUser, password: config.adminPassword, ...(csrf ? { _csrf: csrf } : {}) }) });
    const cookie = response.headers.get('set-cookie')?.split(';')[0] || '';
    const adminPage = await request('/admin', { headers: { Cookie: cookie } });
    const adminHtml = await adminPage.text();
    const token = adminHtml.match(/name="_csrf" value="([^"]+)"/)?.[1];
    return { response, cookie, token, headers: { Cookie: cookie, Origin: new URL(config.appUrl).origin }, post: (url, body = {}, headers = {}) => request(url, { method: 'POST', headers: { Cookie: cookie, Origin: new URL(config.appUrl).origin, ...headers }, body: new URLSearchParams({ ...body, ...(token ? { _csrf: token } : {}) }) }) };
  }
  return { root, db, config, calls, request, login, shutdown: loaded.exports.shutdown };
}

test('server shutdown keeps exclusive data ownership until scheduler drain completes', async (t) => {
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const f = await fixture(t, {}, { stopScheduler: () => gate });
  try {
    assert.equal(typeof f.shutdown, 'function');
    const closing = f.shutdown();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(fs.existsSync(path.join(f.root, 'data/.payreminder.lock')));
    finish();
    await closing;
    assert.equal(fs.existsSync(path.join(f.root, 'data/.payreminder.lock')), false);
  } finally { finish(); }
});

test('advance payments multiply decimal amounts without binary floating-point overprecision', async (t) => {
  const f = await fixture(t);
  const service = f.db.getServices()[0];
  const member = f.db.createMember({ name: 'Fixture', email: 'fixture@example.test', memberships: [{ serviceId: service.id, amount: 0.1 }] });
  const auth = await f.login();
  const response = await auth.post('/admin/payments/advance', { memberId: member.id, serviceId: service.id, month: '2026-10', months: '3' });
  assert.equal(response.status, 302);
  assert.equal(f.db.getPayments().length, 1);
  assert.equal(f.db.getPayments()[0].amount, 0.3);
});

test('HTTP member amounts reject invalid negative and overprecision input without writing', async (t) => {
  const f = await fixture(t);
  const service = f.db.getServices()[0];
  const member = f.db.createMember({ name: 'Fixture', email: 'fixture@example.test', memberships: [{ serviceId: service.id, amount: 10 }] });
  const auth = await f.login();
  for (const amount of ['garbage', '12junk', '-1', '1.234', '', 'Infinity', '1e2']) {
    for (const url of ['/admin/members', `/admin/members/${member.id}`]) {
      const result = await auth.post(url, { name: 'Updated', email: 'fixture@example.test', serviceIds: service.id, [`amounts[${service.id}]`]: amount });
      assert.equal(result.status, 400, `${url}: ${amount}`);
      assert.equal(f.db.getMembers().length, 1);
      assert.equal(f.db.getMember(member.id).name, 'Fixture');
      assert.equal(f.db.getMember(member.id).amount, 10);
    }
  }
  assert.equal((await auth.post(`/admin/members/${member.id}`, { name: 'Updated', email: 'fixture@example.test', serviceIds: service.id, [`amounts[${service.id}]`]: '12.34' })).status, 302);
  assert.equal(f.db.getMember(member.id).amount, 12.34);
});

test('repeated payment confirmations send only one email and preserve confirmedAt', async (t) => {
  const f = await fixture(t);
  const service = f.db.getServices()[0];
  const member = f.db.createMember({ name: 'Fixture', email: 'fixture@example.test', memberships: [{ serviceId: service.id, amount: 10 }] });
  const payment = f.db.createPayment({ member, service, month: '2026-10', amount: 10 });
  const auth = await f.login();
  assert.equal((await auth.post(`/admin/payments/${payment.id}/confirm`)).status, 302);
  const first = f.db.getPayment(payment.id).confirmedAt;
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await auth.post(`/admin/payments/${payment.id}/confirm`)).status, 302);
  assert.equal(f.calls.confirmed, 1);
  assert.equal(f.db.getPayment(payment.id).confirmedAt, first);
});

test('repeated pending payment reports create one payment and notify each channel once', async (t) => {
  const f = await fixture(t);
  const service = f.db.getServices()[0];
  const member = f.db.createMember({ name: 'Fixture', email: 'fixture@example.test', memberships: [{ serviceId: service.id, amount: 10 }] });
  const responses = await Promise.all(Array.from({ length: 3 }, () => f.request(`/p/${member.token}/pay`, { method: 'POST', body: new URLSearchParams({ serviceId: service.id }) })));
  assert.ok(responses.every((response) => response.status === 302));
  assert.equal(f.db.getPayments().length, 1);
  assert.equal(f.calls.reported, 2);
});

test('failed logins are throttled by remote address, not spoofable forwarding headers', async (t) => {
  for (const trustProxy of [false, ['198.51.100.0/24']]) {
    await t.test(JSON.stringify(trustProxy), async (t) => {
      const f = await fixture(t, { trustProxy });
      const page = await f.request('/admin/login');
      const csrf = (await page.text()).match(/name="_csrf" value="([^"]+)"/)[1];
      const cookie = page.headers.get('set-cookie').split(';')[0];
      for (let attempt = 0; attempt < 6; attempt++) {
        const response = await f.request('/admin/login', { method: 'POST', headers: { Cookie: cookie, 'X-Forwarded-For': `192.0.2.${attempt}` }, body: new URLSearchParams({ _csrf: csrf, username: 'admin', password: 'incorrect' }) });
        assert.equal(response.status, attempt < 5 ? 302 : 429);
        if (attempt === 5) {
          assert.ok(Number(response.headers.get('retry-after')) > 0);
          assert.match(response.headers.get('retry-after'), /^\d+$/);
        }
      }
    });
  }
});

test('trusted loopback proxy keeps separate client login failure buckets', async (t) => {
  const f = await fixture(t, { trustProxy: ['127.0.0.1/32', '::1/128'] });
  const page = await f.request('/admin/login');
  const csrf = (await page.text()).match(/name="_csrf" value="([^"]+)"/)[1];
  const cookie = page.headers.get('set-cookie').split(';')[0];
  const attempt = (client, password = 'incorrect') => f.request('/admin/login', {
    method: 'POST', headers: { Cookie: cookie, 'X-Forwarded-For': client },
    body: new URLSearchParams({ _csrf: csrf, username: f.config.adminUser, password }),
  });
  for (let i = 0; i < 5; i++) assert.equal((await attempt('192.0.2.10')).status, 302);
  assert.equal((await attempt('192.0.2.10')).status, 429);
  const otherClient = await attempt('192.0.2.11', f.config.adminPassword);
  assert.equal(otherClient.status, 302);
  assert.equal(otherClient.headers.get('location'), '/admin');
  assert.equal((await attempt('192.0.2.10')).status, 429, 'another client logging in cannot reset the exhausted bucket');
});

test('trusted proxy stops at the first untrusted hop instead of trusting a spoofed chain prefix', async (t) => {
  const f = await fixture(t, { trustProxy: ['127.0.0.1/32', '::1/128'] });
  const page = await f.request('/admin/login');
  const csrf = (await page.text()).match(/name="_csrf" value="([^"]+)"/)[1];
  const cookie = page.headers.get('set-cookie').split(';')[0];
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await f.request('/admin/login', { method: 'POST',
      headers: { Cookie: cookie, 'X-Forwarded-For': `198.51.100.${attempt}, 192.0.2.10` },
      body: new URLSearchParams({ _csrf: csrf, username: f.config.adminUser, password: 'incorrect' }),
    });
    assert.equal(response.status, attempt < 5 ? 302 : 429);
  }
});

test('invalid proxy trust fails startup before loading the database', () => {
  const filename = path.join(__dirname, '../src/server.js');
  const localRequire = createRequire(filename);
  const realConfig = localRequire('./config');
  let databaseLoads = 0;
  for (const trustProxy of [true, 1, ['loopback'], ['0.0.0.0/0']]) {
    const config = { ...realConfig, adminUser: 'admin', adminPassword: 'fixture-unique-password', sessionSecret: 'fixture-unique-session-secret-at-least-32-characters', appUrl: 'HTTPS://payments.example.test', trustProxy,
      validateRuntimeConfig() { return realConfig.validateRuntimeConfig(config); } };
    const loaded = new Module(filename);
    loaded.filename = filename;
    loaded.require = (name) => {
      if (name === './config') return config;
      if (name === './db') { databaseLoads++; throw new Error('Database must not load'); }
      return localRequire(name);
    };
    assert.throws(() => loaded._compile(fs.readFileSync(filename, 'utf8'), filename), /TRUST_PROXY/);
  }
  assert.equal(databaseLoads, 0);
});

test('startup validates runtime credentials before acquiring the data lock', async (t) => {
  const f = await fixture(t);
  assert.equal(f.calls.validated, 1);
  assert.equal(f.calls.locked, 1);
});

test('logout is a CSRF-protected POST and GET cannot destroy a session', async (t) => {
  const f = await fixture(t);
  const auth = await f.login();
  await f.request('/admin/logout', { headers: auth.headers });
  assert.equal((await f.request('/admin', { headers: auth.headers })).status, 200);
  assert.equal((await f.request('/admin/logout', { method: 'POST', headers: auth.headers })).status, 403);
  const result = await auth.post('/admin/logout');
  assert.equal(result.status, 302);
  assert.match(result.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await f.request('/admin', { headers: auth.headers })).headers.get('location'), '/admin/login');
});

test('authentication cookies explicitly set HttpOnly SameSite and HTTPS Secure', async (t) => {
  for (const appUrl of ['http://localhost:3000', 'https://payments.example.test', 'HTTPS://payments.example.test']) {
    await t.test(appUrl, async (t) => {
      const f = await fixture(t, { appUrl });
      const loginPage = await f.request('/admin/login');
      const auth = await f.login();
      assert.equal(auth.response.status, 302);
      const logout = await auth.post('/admin/logout');
      assert.equal(logout.status, 302);
      assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
      for (const response of [loginPage, auth.response, logout]) {
        const cookie = response.headers.get('set-cookie');
        assert.match(cookie, /; HttpOnly/);
        assert.match(cookie, /; SameSite=Lax/);
        assert.equal(/; Secure/.test(cookie), new URL(appUrl).protocol === 'https:');
      }
    });
  }
});

test('notification test fetch sends CSRF in its header and rejects invalid tokens', async (t) => {
  const f = await fixture(t);
  const auth = await f.login();
  const html = await (await f.request('/admin/settings', { headers: auth.headers })).text();
  assert.match(html, /'X-CSRF-Token':\s*body\.get\('_csrf'\)/);
  for (const token of ['', 'wrong-token']) {
    const result = await f.request('/admin/settings/test-notification', { method: 'POST', headers: { ...auth.headers, 'X-CSRF-Token': token }, body: new URLSearchParams({ agent: 'telegram' }) });
    assert.equal(result.status, 403);
  }
  assert.equal(f.calls.tests, 0);
  const result = await f.request('/admin/settings/test-notification', { method: 'POST', headers: { ...auth.headers, 'X-CSRF-Token': auth.token }, body: new URLSearchParams({ agent: 'telegram' }) });
  assert.equal(result.status, 200);
  assert.equal(f.calls.tests, 1);
});

test('cross-origin requests are rejected even with a valid session CSRF token', async (t) => {
  const f = await fixture(t);
  const auth = await f.login();
  for (const Origin of ['https://attacker.example', 'null', 'http://localhost:3000.attacker.example']) {
    assert.equal((await auth.post('/admin/settings', { language: 'en' }, { Origin })).status, 403);
  }
  assert.equal(f.db.getSettings().language, undefined);
});

test('all rendered admin mutation forms include session CSRF tokens', async (t) => {
  const f = await fixture(t);
  const service = f.db.getServices()[0];
  const member = f.db.createMember({ name: 'Fixture', email: 'fixture@example.test', memberships: [{ serviceId: service.id, amount: 10 }] });
  f.db.createPayment({ member, service, month: require('../src/format').currentMonth(), amount: 10 });
  const auth = await f.login();
  assert.ok(auth.token, 'dashboard must render its session CSRF token');
  for (const url of ['/admin', '/admin/members', '/admin/services', '/admin/settings', '/admin/payments', '/admin/members/new', '/admin/services/new', `/admin/members/${member.id}`, `/admin/services/${service.id}`]) {
    const response = await f.request(url, { headers: auth.headers });
    assert.equal(response.status, 200, url);
    const html = await response.text();
    for (const form of html.matchAll(/<form\b[^>]*method="post"[\s\S]*?<\/form>/gi)) {
      assert.ok(form[0].includes(`name="_csrf" value="${auth.token}"`), url);
    }
  }
  assert.equal((await f.request('/admin/settings', { method: 'POST', headers: auth.headers, body: new URLSearchParams({ language: 'en' }) })).status, 403);
  assert.equal((await auth.post('/admin/settings', { language: 'en' })).status, 302);
  assert.equal(f.db.getSettings().language, 'en');
});

test('admin login requires a CSRF token bound to its browser cookie', async (t) => {
  const f = await fixture(t);
  const result = await f.request('/admin/login', { method: 'POST', body: new URLSearchParams({ username: f.config.adminUser, password: f.config.adminPassword }) });
  assert.equal(result.status, 403);
  const auth = await f.login();
  assert.equal(auth.response.status, 302);
  assert.equal(auth.response.headers.get('location'), '/admin');
});

test('member and service deletion names remain inert data, never inline script', async (t) => {
  const f = await fixture(t);
  const name = "');globalThis.pwned=true;//\"<&";
  const service = f.db.createService({ name, active: true });
  f.db.createMember({ name, email: 'fixture@example.test', memberships: [{ serviceId: service.id, amount: 10 }] });
  const auth = await f.login();
  for (const url of ['/admin/members', '/admin/services']) {
    const html = await (await f.request(url, { headers: auth.headers })).text();
    assert.doesNotMatch(html, /onsubmit=/i);
    assert.match(html, /data-confirm-name="&#39;\);globalThis\.pwned=true;\/\/&#34;&lt;&amp;"/);
    assert.match(html, /src="\/admin-security.js"/);
  }
});

test('malformed percent-encoded cookies are ignored instead of returning 500', async (t) => {
  const f = await fixture(t);
  const response = await f.request('/admin/login', { headers: { Cookie: 'payreminder_session=%E0%A4%A' } });
  assert.equal(response.status, 200);
});
