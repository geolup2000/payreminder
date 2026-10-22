const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const sourcePath = require.resolve('../src/db');
function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'payreminder-money-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctx = { require: createRequire(sourcePath), __dirname: path.join(root, 'src'), module: { exports: {} }, process, ...overrides };
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), ctx);
  return { db: ctx.module.exports, dir: path.join(root, 'data') };
}

test('advance creation commits confirmed state once and failed writes leave the previous payments intact', t => {
  const realRequire = createRequire(sourcePath);
  const wrappedFs = { ...fs };
  const { db, dir } = fixture(t, { require: name => name === 'fs' ? wrappedFs : realRequire(name) });
  const service = db.getServices()[0];
  const member = db.createMember({ name: 'Atomic', email: 'atomic@example.test', memberships: [{ serviceId: service.id, amount: 10 }] });
  const file = path.join(dir, 'payments.json');
  let writes = 0, fail = false;
  wrappedFs.renameSync = (a, b) => {
    if (b === file) { writes++; if (fail) throw new Error('disk failure'); }
    return fs.renameSync(a, b);
  };
  const create = month => db.createPayment({ member, service, month, months: 3, amount: 30, confirmed: true });
  const payment = create('2026-10');
  assert.equal(writes, 1);
  const original = fs.readFileSync(file, 'utf8');
  assert.equal(JSON.parse(original)[0].status, 'confirmed');
  assert.ok(payment.confirmedAt);
  fail = true;
  assert.throws(() => create('2027-01'), /disk failure/);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  fail = false;
  create('2027-01');
  assert.equal(db.getPayments().length, 2);
  assert.ok(db.getPayments().every(payment => payment.status === 'confirmed' && payment.confirmedAt));
});

test('previously generated numeric prepaid residue is readable without rewriting legacy JSON', t => {
  const { db, dir } = fixture(t);
  const service = db.getServices()[0];
  const memberFile = path.join(dir, 'members.json');
  const paymentFile = path.join(dir, 'payments.json');
  // These shapes and floating multiplication match the previous application's writer.
  const oldMembers = JSON.stringify([{ id: 'm', name: 'Ana', amount: 12.34, serviceId: service.id }]);
  const oldPayments = JSON.stringify([{ id: 'p', memberId: 'm', month: '2026-10', endMonth: '2026-12', months: 3, amount: 12.34 * 3 }]);
  fs.writeFileSync(memberFile, oldMembers);
  fs.writeFileSync(paymentFile, oldPayments);
  assert.equal(db.getPayment('p').amount, 37.02);
  assert.equal(db.getMember('m').memberships[0].amount, 12.34);
  assert.equal(fs.readFileSync(memberFile, 'utf8'), oldMembers);
  assert.equal(fs.readFileSync(paymentFile, 'utf8'), oldPayments);
  db.setPaymentStatus('p', 'confirmed');
  assert.equal(JSON.parse(fs.readFileSync(paymentFile, 'utf8'))[0].amount, 37.02);
  assert.equal(fs.readFileSync(memberFile, 'utf8'), oldMembers);
});

test('membership amount accessors reject invalid detached input instead of partially parsing it', t => {
  const { db } = fixture(t);
  const service = db.getServices()[0];
  const detached = { memberships: [{ serviceId: service.id, amount: '12oops' }] };
  assert.throws(() => db.getMemberships(detached), /amount/i);
  assert.throws(() => db.getMemberMembership(detached, service.id), /amount/i);
});

test('persisted numeric membership residue is normalized in memory only', t => {
  const { db, dir } = fixture(t);
  const service = db.getServices()[0];
  const file = path.join(dir, 'members.json');
  const original = JSON.stringify([{ id: 'm', amount: 12.34 * 3, serviceId: service.id,
    memberships: [{ serviceId: service.id, amount: 12.34 * 3 }] }]);
  fs.writeFileSync(file, original);
  const member = db.getMember('m');
  assert.equal(member.amount, 37.02);
  assert.equal(db.getMemberships(member)[0].amount, 37.02);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  db.updateMember('m', { name: 'Updated' });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[0].amount, 37.02);
});

test('persisted money rejects genuine excess precision and residue outside the epsilon bound without writes', t => {
  const { db, dir } = fixture(t);
  const service = db.getServices()[0];
  for (const amount of [1.005, 1.001, 37.02 + 16 * Number.EPSILON * 37.02,
    1000000.01000001, '37.019999999999996', -0.001, null, true, {}, 1e-20,
    90071992547409.92]) {
    for (const [name, getter, record] of [
      ['payments', 'getPayments', { id: 'p', amount }],
      ['members', 'getMembers', { id: 'm', amount, serviceId: service.id }],
      ['members', 'getMembers', { id: 'm', memberships: [{ serviceId: service.id, amount }] }],
    ]) {
      const file = path.join(dir, `${name}.json`);
      const original = JSON.stringify([record]);
      fs.writeFileSync(file, original);
      assert.throws(() => db[getter](), /amount|cents/i, `${name}: ${JSON.stringify(amount)}`);
      assert.equal(fs.readFileSync(file, 'utf8'), original);
      fs.unlinkSync(file);
    }
  }
});

test('normalization never silently loses cents when converting safe cent totals to JSON numbers', t => {
  const { db } = fixture(t);
  assert.throws(() => db.normalizeAmount('90071992547409.91'), /represent|cents/i);
  assert.equal(db.normalizeAmount('90071992547409.90'), 90071992547409.9);
});

test('confirmation is idempotent and reverting to pending clears confirmedAt for single and bulk changes', t => {
  const { db, dir } = fixture(t);
  const member = db.createMember({ name: 'Ana', amount: 10 });
  const payment = db.createPayment({ member, month: '2026-10', amount: 10 });
  db.setPaymentStatus(payment.id, 'confirmed');
  const file = path.join(dir, 'payments.json');
  const records = JSON.parse(fs.readFileSync(file, 'utf8'));
  records[0].confirmedAt = '2000-01-01T00:00:00.000Z';
  fs.writeFileSync(file, JSON.stringify(records));
  assert.equal(db.setPaymentStatus(payment.id, 'confirmed').confirmedAt, records[0].confirmedAt);
  db.markListConfirmed([payment.id], 'confirmed');
  assert.equal(db.getPayment(payment.id).confirmedAt, records[0].confirmedAt);
  assert.equal(db.setPaymentStatus(payment.id, 'pending').confirmedAt, null);
  db.setPaymentStatus(payment.id, 'confirmed');
  db.markListConfirmed([payment.id], 'pending');
  assert.equal(db.getPayment(payment.id).confirmedAt, null);
});

test('malformed persisted money and membership shapes fail without repair writes', t => {
  const { db, dir } = fixture(t);
  const service = db.getServices()[0];
  for (const member of [
    { id: 'm', amount: -1, serviceId: service.id },
    { id: 'm', memberships: [{ serviceId: service.id, amount: '1oops' }] },
    { id: 'm', memberships: 'bad' },
    { id: 'm', memberships: [null] },
  ]) {
    const original = JSON.stringify([member]);
    fs.writeFileSync(path.join(dir, 'members.json'), original);
    assert.throws(() => db.getMembers(), /amount|malformed/i);
    assert.equal(fs.readFileSync(path.join(dir, 'members.json'), 'utf8'), original);
  }
});

test('legacy amount and service updates synchronize memberships without losing other subscriptions', t => {
  const { db } = fixture(t);
  const first = db.getServices()[0];
  const second = db.createService({ name: 'Second' });
  const member = db.createMember({ name: 'Ana', memberships: [{ serviceId: first.id, amount: 10 }, { serviceId: second.id, amount: 20 }] });
  db.updateMember(member.id, { amount: '12.34' });
  const updated = db.getMember(member.id);
  assert.equal(updated.amount, 12.34);
  assert.equal(updated.memberships[0].amount, 12.34);
  assert.equal(updated.memberships[1].amount, 20);
  db.updateMember(member.id, { serviceIds: [second.id], amount: '25.50' });
  const moved = db.getMember(member.id);
  assert.equal(moved.memberships.length, 1);
  assert.equal(moved.serviceId, second.id);
  assert.equal(moved.memberships[0].amount, 25.5);
  db.updateMember(member.id, { serviceId: first.id });
  assert.equal(db.getMember(member.id).serviceId, first.id);
});

test('DB member and payment writes reject invalid amounts without changing existing data', t => {
  const { db, dir } = fixture(t);
  const member = db.createMember({ name: 'Ana', amount: 10 });
  const service = db.getServices()[0];
  const original = fs.readFileSync(path.join(dir, 'members.json'), 'utf8');
  for (const amount of [-2, 1.005, 12.34 * 3, '1.001', '10oops', '90071992547409.92']) {
    assert.throws(() => db.createMember({ name: 'Bad', amount }), /amount|cents/i);
    assert.throws(() => db.updateMember(member.id, { amount }), /amount|cents/i);
    assert.throws(() => db.updateMember(member.id, { memberships: [{ serviceId: service.id, amount }] }), /amount|cents/i);
    assert.throws(() => db.createPayment({ member, service, month: '2026-10', amount }), /amount|cents/i);
    assert.equal(fs.readFileSync(path.join(dir, 'members.json'), 'utf8'), original);
    assert.equal(db.getPayments().length, 0);
  }
});

test('prepaid multiplication uses safe integer cents', t => {
  const { db } = fixture(t);
  assert.equal(typeof db.multiplyAmount, 'function');
  assert.equal(db.multiplyAmount(0.1, 3), 0.3);
  assert.equal(db.multiplyAmount('19.99', 12), 239.88);
  for (const count of [0, -1, 1.5, Infinity, '3']) assert.throws(() => db.multiplyAmount(1, count), /month|count|integer/i);
  assert.throws(() => db.multiplyAmount('90071992547409.90', 2), /safe|cents/i);
});

test('normalizeAmount validates whole decimal money and safe integer cents', t => {
  const { db } = fixture(t);
  assert.equal(typeof db.normalizeAmount, 'function');
  for (const [value, expected] of [[0, 0], ['0.01', 0.01], [' 12.30 ', 12.3], [12.34, 12.34]]) {
    assert.equal(db.normalizeAmount(value), expected);
  }
  for (const value of [-1, '-0.01', 1.001, '1.230', '12abc', '', ' ', null, undefined, true, {}, [], Infinity, NaN, '1e2', '90071992547409.92']) {
    assert.throws(() => db.normalizeAmount(value), /amount|money|cents/i, String(value));
  }
});
