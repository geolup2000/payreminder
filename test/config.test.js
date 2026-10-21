const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');

const safe = () => ({ ...config, adminUser: 'admin', adminPassword: 'unique-review-password', sessionSecret: 'a-unique-session-secret-at-least-32-characters', appUrl: 'http://localhost:3000' });

test('runtime rejects missing, short and known example admin credentials without leaking values', () => {
  for (const adminPassword of ['', 'admin', 'change-me', 'changeme', 'password', '123456789012', 'short']) {
    assert.throws(() => config.validateRuntimeConfig({ ...safe(), adminPassword }), /ADMIN_PASSWORD/);
  }
  assert.throws(() => config.validateRuntimeConfig({ ...safe(), adminUser: '' }), /ADMIN_USER/);
});

test('runtime rejects default or short session secrets', () => {
  for (const sessionSecret of ['', 'default-secret-change-me', 'change-this-secret-key', 'short']) {
    assert.throws(() => config.validateRuntimeConfig({ ...safe(), sessionSecret }), /SESSION_SECRET/);
  }
});

test('runtime accepts explicitly configured credentials and HTTP or HTTPS URL', () => {
  assert.doesNotThrow(() => config.validateRuntimeConfig(safe()));
  assert.doesNotThrow(() => config.validateRuntimeConfig({ ...safe(), appUrl: 'https://pay.example.com' }));
  assert.doesNotThrow(() => config.validateRuntimeConfig({ ...safe(), appUrl: 'HTTPS://payments.example.test' }));
});

test('runtime validates explicit proxy IP and CIDR lists and rejects broad or ambiguous trust', () => {
  for (const trustProxy of [false, ['127.0.0.1'], ['::1/128', '10.20.0.0/16', '192.0.2.10']]) {
    assert.doesNotThrow(() => config.validateRuntimeConfig({ ...safe(), trustProxy }));
  }
  for (const trustProxy of [true, 1, 'true', '1', 'loopback', '127.0.0.1', [], [''], ['loopback'], ['proxy.example.test'], ['127.0.0.1', 'true'], ['192.0.2.1/33'], ['::1/129'], ['127.0.0.1/-1'], ['::/0'], ['0.0.0.0/0'], ['127.0.0.1/8junk'], ['127.0.0.1/8/1']]) {
    assert.throws(() => config.validateRuntimeConfig({ ...safe(), trustProxy }), /TRUST_PROXY/, JSON.stringify(trustProxy));
  }
});

test('TRUST_PROXY environment supports only disabled or comma-separated IP/CIDR entries', () => {
  const { spawnSync } = require('node:child_process');
  function load(trustProxy) {
    const env = { ...process.env, ADMIN_USER: 'admin', ADMIN_PASSWORD: safe().adminPassword, SESSION_SECRET: safe().sessionSecret, APP_URL: safe().appUrl };
    delete env.TRUST_PROXY;
    if (trustProxy !== undefined) env.TRUST_PROXY = trustProxy;
    return spawnSync(process.execPath, ['-e', "const c = require('./src/config'); c.validateRuntimeConfig(); process.stdout.write('CONFIG_JSON:' + JSON.stringify(c.trustProxy));"], { cwd: require('node:path').join(__dirname, '..'), env, encoding: 'utf8' });
  }
  for (const value of [undefined, '', 'false']) {
    const result = load(value);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.split('CONFIG_JSON:')[1], 'false');
  }
  const result = load('127.0.0.1, ::1/128, 10.20.0.0/16');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.split('CONFIG_JSON:')[1]), ['127.0.0.1', '::1/128', '10.20.0.0/16']);
  for (const value of ['true', '1', 'loopback', 'proxy.example.test', '127.0.0.1,', '127.0.0.1, true', '0.0.0.0/0', '192.0.2.1/33']) {
    const invalid = load(value);
    assert.notEqual(invalid.status, 0, value);
    assert.match(invalid.stderr, /TRUST_PROXY/);
  }
});

test('runtime rejects malformed or unsafe application URLs', () => {
  for (const appUrl of ['invalid', 'javascript:alert(1)', 'ftp://example.com', 'https://user:password@example.com', 'https://example.com/path', 'https://example.com?token=secret']) {
    assert.throws(() => config.validateRuntimeConfig({ ...safe(), appUrl }), /APP_URL/);
  }
});
