'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const installer = () => fs.readFileSync(path.join(root, 'install.sh'), 'utf8');

// Only function definitions are loaded; never run the installer on the host.
function runFunctions(body, { cwd = root, env = {} } = {}) {
  const definitions = [...installer().matchAll(/^([a-z_]+)\(\) \{\n[\s\S]*?^\}/gm)]
    .filter(match => match[1] !== 'main').map(match => match[0]).join('\n');
  return spawnSync('bash', ['-c', `set -euo pipefail\nAPP_DIR="$PWD"\n${definitions}\ninfo() { printf '%s\\n' "$*"; }\nwarn() { printf '%s\\n' "$*"; }\nerr() { printf '%s\\n' "$*" >&2; }\nstep() { :; }\n${body}`], {
    cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 10_000,
  });
}

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'payreminder-install-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('project lookup canonicalizes relative paths and symlinks', t => {
  const directory = temporary(t);
  fs.mkdirSync(path.join(directory, 'real'));
  fs.writeFileSync(path.join(directory, 'real/package.json'), '{}');
  fs.symlinkSync('real', path.join(directory, 'linked'));
  const result = runFunctions('SCRIPT_DIR=/nonexistent; find_app ./linked', { cwd: directory });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), path.join(directory, 'real'));
});

test('service paths reject whitespace and systemd expansion or quoting characters', () => {
  for (const value of ['/opt/pay reminder', '/opt/pay%reminder', '/opt/pay$reminder', '/opt/pay\\\\reminder', '/opt/pay\nreminder', '/opt/pay"reminder']) {
    const result = runFunctions('validate_service_path "$CHECK_PATH"', { env: { CHECK_PATH: value } });
    assert.notEqual(result.status, 0, `must reject ${JSON.stringify(value)}`);
    assert.match(result.stderr, /unsupported.*path/i);
  }
  const accepted = runFunctions('validate_service_path /opt/payreminder-v1.2_test');
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(installer(), /validate_service_path "\$APP_DIR"/);
  assert.match(installer(), /validate_service_path "\$NODE_BIN"/);
});

test('new installations generate private unpredictable credentials without printing them', t => {
  const directory = temporary(t);
  fs.copyFileSync(path.join(root, '.env.example'), path.join(directory, '.env.example'));
  const result = runFunctions('initialize_env', { cwd: directory });
  assert.equal(result.status, 0, result.stderr);
  const contents = fs.readFileSync(path.join(directory, '.env'), 'utf8');
  const password = contents.match(/^ADMIN_PASSWORD=(.+)$/m)?.[1];
  const secret = contents.match(/^SESSION_SECRET=(.+)$/m)?.[1];
  assert.match(password, /^[a-f0-9]{48}$/);
  assert.match(secret, /^[a-f0-9]{64}$/);
  assert.equal(fs.statSync(path.join(directory, '.env')).mode & 0o777, 0o600);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(password));
  assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
  assert.notEqual(password, secret);
  const second = temporary(t);
  fs.copyFileSync(path.join(root, '.env.example'), path.join(second, '.env.example'));
  assert.equal(runFunctions('initialize_env', { cwd: second }).status, 0);
  assert.notEqual(fs.readFileSync(path.join(second, '.env'), 'utf8'), contents);
});

test('updates preserve .env and settings byte-for-byte, even when invalid', t => {
  const directory = temporary(t);
  const original = '# keep comments and spacing\r\nAPP_URL=http://localhost:3000\r\nADMIN_PASSWORD=change-me\r\n';
  const settings = ' { "language": "custom", "credentials": "preserve me" } \n';
  fs.writeFileSync(path.join(directory, '.env'), original, { mode: 0o640 });
  fs.mkdirSync(path.join(directory, 'data'));
  fs.writeFileSync(path.join(directory, 'data/settings.json'), settings);
  const result = runFunctions('initialize_env; initialize_language', { cwd: directory });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(directory, '.env'), 'utf8'), original);
  assert.equal(fs.statSync(path.join(directory, '.env')).mode & 0o777, 0o640);
  assert.equal(fs.readFileSync(path.join(directory, 'data/settings.json'), 'utf8'), settings);
  assert.doesNotMatch(installer(), /sed -i|read -r -p/);
});

function configFixture(t, contents) {
  const directory = temporary(t);
  fs.symlinkSync(path.join(root, 'src'), path.join(directory, 'src'), 'dir');
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
  fs.copyFileSync(path.join(root, '.env.example'), path.join(directory, '.env.example'));
  if (contents !== undefined) fs.writeFileSync(path.join(directory, '.env'), contents);
  return directory;
}

test('configuration is validated against the actual .env before any service start', t => {
  const directory = configFixture(t);
  const valid = runFunctions('initialize_env; validate_env', { cwd: directory });
  assert.equal(valid.status, 0, valid.stderr);
  const original = 'ADMIN_PASSWORD=change-me\nSESSION_SECRET=change-this-secret-key\n';
  fs.writeFileSync(path.join(directory, '.env'), original);
  const invalid = runFunctions('validate_env; printf SERVICE_STARTED', {
    cwd: directory,
    env: { ADMIN_PASSWORD: 'externally-secure-but-not-in-env', SESSION_SECRET: 'a'.repeat(64) },
  });
  assert.notEqual(invalid.status, 0);
  assert.doesNotMatch(invalid.stdout, /SERVICE_STARTED/);
  assert.match(invalid.stderr, /ADMIN_PASSWORD/);
  assert.equal(fs.readFileSync(path.join(directory, '.env'), 'utf8'), original);
  const source = installer();
  const validation = source.indexOf('\nvalidate_env\n');
  assert.ok(validation > 0, 'the main installer must actually invoke validation');
  assert.ok(validation < source.indexOf('systemctl enable --now payreminder'));
});

test('package and lock metadata require Node >=20 without dependency divergence', () => {
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assert.deepEqual(metadata.engines, { node: '>=20' });
  assert.deepEqual(lock.packages[''].engines, metadata.engines);
  assert.deepEqual(lock.packages[''].dependencies, metadata.dependencies);
});

test('the example deliberately contains no usable password or session secret', () => {
  const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  assert.match(example, /^ADMIN_PASSWORD=$/m);
  assert.match(example, /^SESSION_SECRET=$/m);
  assert.match(example, /at least 12 characters/);
  assert.match(example, /at least 32 characters/);
});

test('runtime documentation requires credential setup before startup and describes upgrade safety', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /Node\.js 20 or newer/);
  assert.match(readme, /Node\.js 22/);
  const quickStart = readme.match(/## Quick start\n([\s\S]*?)\n## Install/)[1];
  assert.ok(quickStart.indexOf('nano .env') > 0);
  assert.ok(quickStart.indexOf('nano .env') < quickStart.indexOf('npm start'));
  assert.match(readme, /at least 12 characters/);
  assert.match(readme, /at least 32 characters/);
  assert.match(readme, /CSRF/);
  assert.match(readme, /single.writer/i);
  assert.match(readme, /not automatically migrate insecure credentials/);
  assert.match(readme, /catch.up/i);
});

test('supported installed Node versions do not trigger package installation', () => {
  for (const version of ['v20.20.0', 'v22.23.3']) {
    const result = runFunctions(`
node() { printf '%s\\n' "$CHECK_VERSION"; }
apt-get() { printf UNEXPECTED_PACKAGE_INSTALL >&2; return 1; }
curl() { printf UNEXPECTED_DOWNLOAD >&2; return 1; }
install_node
`, { env: { CHECK_VERSION: version } });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /UNEXPECTED/);
    assert.match(result.stdout, /already installed/);
  }
});

test('installer verifies and accepts a supported version installed by distro fallback', () => {
  const result = runFunctions(`
CHECK_VERSION=v18.20.0
node() { printf '%s\\n' "$CHECK_VERSION"; }
apt-get() { if [[ "$*" == 'install -y nodejs' ]]; then CHECK_VERSION=v22.23.3; fi; }
curl() { return 1; }
install_node
`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Node.js installed: v22\.23\.3/);
});

test('existing weak secrets and unsafe APP_URL values fail validation without mutations', t => {
  const valid = 'ADMIN_USER=admin\nADMIN_PASSWORD=a-secure-test-password\nSESSION_SECRET=' + 's'.repeat(64) + '\nAPP_URL=https://reminder.example.com\n';
  for (const contents of [
    valid.replace(/SESSION_SECRET=.+/, 'SESSION_SECRET=change-this-secret-key'),
    valid.replace('APP_URL=https://reminder.example.com', 'APP_URL=https://example.com/unsafe'),
    valid.replace(/ADMIN_PASSWORD=.+/, 'ADMIN_PASSWORD=123456789012'),
  ]) {
    const directory = configFixture(t, contents);
    const result = runFunctions('validate_env; printf SERVICE_STARTED', { cwd: directory });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /SERVICE_STARTED/);
    assert.equal(fs.readFileSync(path.join(directory, '.env'), 'utf8'), contents);
  }
});

test('installer rejects an unsupported Node version even after distro fallback', () => {
  const result = runFunctions(`
node() { if [[ "$1" == '--version' ]]; then printf 'v18.20.0\\n'; else return 1; fi; }
apt-get() { :; }
curl() { return 1; }
install_node
`);
  assert.notEqual(result.status, 0, 'must not proceed with Node 18 from fallback');
  assert.match(result.stderr, /Node\.js.*20/);
});
