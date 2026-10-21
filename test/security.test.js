const { test } = require('node:test');
const assert = require('node:assert/strict');
const security = require('../src/security');
const fs = require('node:fs');
const vm = require('node:vm');

test('external confirmation listener treats malicious names as text in both languages', () => {
  const source = fs.readFileSync(require.resolve('../public/admin-security.js'), 'utf8');
  const name = "');globalThis.pwned=true;//";
  for (const lang of ['ro', 'en']) {
    for (const kind of ['member', 'service']) {
      let handler;
      let message;
      let prevented = false;
      const context = { document: { documentElement: { lang }, addEventListener(event, listener) { assert.equal(event, 'submit'); handler = listener; } }, window: { confirm(text) { message = text; return false; } } };
      vm.runInNewContext(source, context);
      handler({ target: { closest: () => ({ dataset: { confirm: kind, confirmName: name } }) }, preventDefault() { prevented = true; } });
      assert.equal(context.pwned, undefined);
      assert.ok(message.includes(name));
      assert.ok(message.startsWith(lang === 'en' ? 'Delete' : 'Ștergi'));
      assert.equal(prevented, true);
    }
  }
});

test('expired sessions are removed while live sessions are retained', () => {
  const sessions = new Map([['expired', 100], ['live', 201], ['boundary', 200]]);
  assert.equal(typeof security.pruneExpiredSessions, 'function');
  security.pruneExpiredSessions(sessions, 200);
  assert.deepEqual([...sessions.keys()], ['live']);
});
