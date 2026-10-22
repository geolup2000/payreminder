const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const sourcePath = require.resolve('../src/db');
function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'payreminder-db-'));
  const dir = path.join(root, 'data');
  fs.mkdirSync(dir);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const context = { require: createRequire(sourcePath), __dirname: path.join(root, 'src'), module: { exports: {} }, process, ...overrides };
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  return { db: context.module.exports, dir };
}

for (const [file, method, invalid] of [
  ['services.json', 'getServices', {}],
  ['members.json', 'getMembers', {}],
  ['payments.json', 'getPayments', {}],
  ['settings.json', 'getSettings', []],
  ['services.json', 'getServices', [null]],
  ['members.json', 'getMembers', [null]],
  ['payments.json', 'getPayments', [null]],
  ['services.json', 'getServices', [{ id: 's', reminderDay: {}, active: true }]],
  ['services.json', 'getServices', [{ id: 's', active: 'false' }]],
  ['members.json', 'getMembers', [{ id: 'm', active: [] }]],
  ['payments.json', 'getPayments', [{ id: 'p', amount: -2 }]],
  ['settings.json', 'getSettings', { lastReminderMonths: [] }],
  ['settings.json', 'getSettings', { reminderDeliveries: 'bad' }],
]) {
  test(`malformed ${file} (${JSON.stringify(invalid)}) fails without modifying data`, t => {
    const { db, dir } = fixture(t);
    const filePath = path.join(dir, file);
    const original = JSON.stringify(invalid);
    fs.writeFileSync(filePath, original);
    assert.throws(() => db[method](), /invalid|malformed/i);
    assert.equal(fs.readFileSync(filePath, 'utf8'), original);
  });
}

test('non-ENOENT read errors are never treated as empty data', t => {
  for (const code of ['EACCES', 'EISDIR']) {
    const realRequire = createRequire(sourcePath);
    const deniedFs = { ...fs, readFileSync: () => { throw Object.assign(new Error(code), { code }); } };
    const { db } = fixture(t, { require: name => name === 'fs' ? deniedFs : realRequire(name) });
    assert.throws(() => db.getSettings(), new RegExp(code));
  }
});

test('atomic writes use unique exclusive restrictive temporary files and clean up failures', t => {
  const writes = [];
  const realRequire = createRequire(sourcePath);
  const wrappedFs = { ...fs, openSync: (file, flag, mode) => {
    writes.push({ file, flag, mode });
    return fs.openSync(file, flag, mode);
  } };
  const { db, dir } = fixture(t, { require: name => name === 'fs' ? wrappedFs : realRequire(name) });
  db.updateSettings({ a: 1 });
  db.updateSettings({ a: 2 });
  assert.notEqual(writes[0].file, writes[1].file);
  for (const { file, flag, mode } of writes) {
    assert.equal(path.dirname(file), dir);
    assert.equal(mode, 0o600);
    assert.equal(flag, 'wx');
  }
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'settings.json')).mode & 0o777, 0o600);
  wrappedFs.renameSync = () => { throw new Error('rename failed'); };
  assert.throws(() => db.updateSettings({ a: 3 }), /rename failed/);
  assert.equal(db.getSettings().a, 2);
  assert.deepEqual(fs.readdirSync(dir), ['settings.json']);
});

test('a partial temporary write is cleaned up and the old settings remain intact', t => {
  const realRequire = createRequire(sourcePath);
  const wrappedFs = { ...fs };
  const { db, dir } = fixture(t, { require: name => name === 'fs' ? wrappedFs : realRequire(name) });
  db.updateSettings({ keep: true });
  wrappedFs.writeFileSync = (target, data, options) => {
    fs.writeFileSync(target, String(data).slice(0, 2), options);
    throw new Error('disk full');
  };
  assert.throws(() => db.updateSettings({ keep: false }), /disk full/);
  assert.equal(db.getSettings().keep, true);
  assert.deepEqual(fs.readdirSync(dir), ['settings.json']);
});

test('lifetime directory lock excludes another process and releases on exit', t => {
  const { spawnSync } = require('node:child_process');
  const { db, dir } = fixture(t);
  assert.equal(typeof db.acquireDataLock, 'function');
  const release = db.acquireDataLock();
  t.after(release);
  const script = `const fs=require('fs'),vm=require('vm'),path=require('path');
    const file=${JSON.stringify(sourcePath)};
    const ctx={require:require('module').createRequire(file),__dirname:${JSON.stringify(path.join(path.dirname(dir), 'src'))},module:{exports:{}},process};
    vm.runInNewContext(fs.readFileSync(file,'utf8'),ctx);const release=ctx.module.exports.acquireDataLock();`;
  const blocked = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /lock|already running/i);
  release();
  const acquired = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(acquired.status, 0, acquired.stderr);
  assert.equal(fs.existsSync(path.join(dir, '.payreminder.lock')), false);
  const terminated = spawnSync(process.execPath, ['-e', script + `
    const {installShutdownSignals}=require(path.join(path.dirname(file),'shutdown'));
    installShutdownSignals(async()=>{await new Promise(resolve=>setTimeout(resolve,20));release();});
    setImmediate(() => ${process.platform === 'win32' ? "process.emit('SIGTERM')" : "process.kill(process.pid, 'SIGTERM')"});
    `], { encoding: 'utf8', timeout: 3000 });
  assert.equal(terminated.status, 0, terminated.stderr);
  assert.equal(fs.existsSync(path.join(dir, '.payreminder.lock')), false);
});

test('stale, malformed and inaccessible lock owners fail safe without removing the lock', t => {
  for (const [data, code] of [
    ['not JSON', 'ESRCH'],
    [JSON.stringify({ pid: 1234, token: 'old' }), 'ESRCH'],
    [JSON.stringify({ pid: 1234, token: 'old' }), 'EPERM'],
    [JSON.stringify({ pid: process.pid, token: 'live' }), null],
  ]) {
    const fakeProcess = Object.create(process);
    fakeProcess.kill = () => { if (code) throw Object.assign(new Error(code), { code }); };
    const { db, dir } = fixture(t, { process: fakeProcess });
    const lock = path.join(dir, '.payreminder.lock');
    fs.writeFileSync(lock, data);
    assert.throws(() => db.acquireDataLock(), /lock.*manual|manual.*lock/i);
    assert.equal(fs.readFileSync(lock, 'utf8'), data);
  }
});

test('corrupt JSON must throw and never replace the original file', t => {
  const { db, dir } = fixture(t);
  const file = path.join(dir, 'services.json');
  fs.writeFileSync(file, '{broken');
  assert.throws(() => db.getServices(), /JSON|position|property/i);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});
