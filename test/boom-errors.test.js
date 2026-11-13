'use strict';

// The library's own errors are Booms.
//
// A Boom is still an Error — same message, same stack, same string `code` where
// one was set — with an HTTP-style status on `output.statusCode`, so a caller
// can tell a timeout from a refusal from a bad argument without reading the
// message. These tests pin the three things that would be easy to lose: that
// nothing in lib/ went back to a bare Error, that the statuses mean what
// lib/errors.js says they mean, and that nothing a caller already relied on
// (message, code, cause, instanceof Error) changed.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const hapi = require('@hapi/boom');
const wa   = require('../index.js');
const { Boom, statusFrom } = require('../lib/errors');
const { WhalibmobClient }  = require('../lib/Client');
const { BinaryNode }       = require('../lib/BinaryNode');

const ROOT = path.join(__dirname, '..');

// What a call threw or rejected with.
async function failure(fn) {
  try { await fn(); } catch (err) { return err; }
  assert.fail('expected the call to fail');
}

function assertBoom(err, statusCode, message) {
  assert.ok(err instanceof Error, 'a Boom is still an Error');
  assert.ok(err instanceof Boom, 'and an instance of Boom');
  assert.equal(err.isBoom, true);
  assert.equal(err.output.statusCode, statusCode);
  assert.equal(err.isServer, statusCode >= 500);
  if (message) assert.match(err.message, message);
  assert.equal(typeof err.stack, 'string');
}

function client(reply) {
  return Object.assign(Object.create(WhalibmobClient.prototype), {
    _connected:   true,
    _socket:      { sendNode() {} },
    _tosAccepted: new Map(),
    _genMsgId:    () => 'IQ1',
    _sendIq:      async () => reply,
    emit:         () => true
  });
}

const errorReply = (code) => new BinaryNode('iq', { type: 'error', id: 'IQ1' }, [
  new BinaryNode('error', code == null ? {} : { code }, null)
]);

// ─── the export ──────────────────────────────────────────────────────────────

test('Boom is exported, and it is @hapi/boom\'s own class', () => {
  assert.equal(wa.Boom, hapi.Boom);
  assert.equal(wa.Errors.Boom, hapi.Boom);
  assert.equal(wa.Errors, require('../lib/errors'));
  assert.equal(typeof wa.Errors.statusFrom, 'function');
});

test('@hapi/boom is a runtime dependency, not a dev one', () => {
  const pkg = require('../package.json');
  assert.ok(pkg.dependencies['@hapi/boom'], 'it is required from lib/, so it must install with the package');
});

// ─── nothing went back to a bare Error ───────────────────────────────────────

test('no file in lib/ raises a bare Error', () => {
  // lib/signal/libsignal is the Signal protocol port and keeps its own error
  // classes (SessionError, PreKeyError, …), which callers already tell apart.
  const skip = path.join(ROOT, 'lib', 'signal', 'libsignal') + path.sep;
  const files = [path.join(ROOT, 'cli.js'), path.join(ROOT, 'index.js')];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.js') && !p.startsWith(skip)) files.push(p);
    }
  })(path.join(ROOT, 'lib'));

  const bare = [];
  for (const file of files) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (/\bnew Error\(/.test(line)) bare.push(path.relative(ROOT, file) + ':' + (i + 1));
    });
  }
  assert.deepEqual(bare, [], 'raise a Boom instead (see lib/errors.js):\n  ' + bare.join('\n  '));
});

// ─── statusFrom ──────────────────────────────────────────────────────────────

test('statusFrom passes a server status through, as a string or a number', () => {
  assert.equal(statusFrom('403'), 403);
  assert.equal(statusFrom(406), 406);
  assert.equal(statusFrom('400'), 400);
  assert.equal(statusFrom(599), 599);
});

test('statusFrom falls back on anything Boom would refuse', () => {
  // Boom throws on a status under 400, which would replace the real error
  // with one about the status.
  for (const bad of [null, undefined, '', ' ', 'abc', 0, 200, 302, 399, 600, 403.5, NaN, {}, [], Buffer.from([4])]) {
    assert.equal(statusFrom(bad), 502);
    assert.equal(statusFrom(bad, 500), 500);
  }
});

// ─── the statuses ────────────────────────────────────────────────────────────

test('a bad argument is a 400', () => {
  assertBoom(failureSync(() => wa.storeToJson(undefined)), 400, /undefined or null/);
  assertBoom(failureSync(() => require('../lib/curve').generateKeyPair(Buffer.alloc(3))), 400, /32 bytes/);
});

test('data that will not parse is a 400', () => {
  const plist = require('../lib/plist');
  assertBoom(failureSync(() => plist.parse(Buffer.from('bplist00'))), 400, /plist/);
});

test('a call made while disconnected is a 428', async () => {
  const c = client();
  c._connected = false;
  assertBoom(await failure(() => c.queryTosNotices(['a'])), 428, /Not connected/);
});

test('an IQ nobody answered is a 408', async () => {
  const c = client(null);
  assertBoom(await failure(() => c.queryTosNotices(['a'])), 408, /timed out/);
});

test('a server refusal carries the server\'s own status', async () => {
  assertBoom(await failure(() => client(errorReply('403')).acceptTosNotices(['a'])), 403, /403/);
  assertBoom(await failure(() => client(errorReply('429')).queryTosNotices(['a'])), 429, /429/);
});

test('a server refusal that names no status is a 502', async () => {
  assertBoom(await failure(() => client(errorReply()).queryTosNotices(['a'])), 502, /server rejected/);
});

// ─── what did not change ─────────────────────────────────────────────────────

test('an error keeps its string code beside the status', () => {
  const err = require('../lib/PrimaryLinkCrypto').failure('PRIMARY_LINK_INVALID');
  assertBoom(err, 400);
  assert.equal(err.code, 'PRIMARY_LINK_INVALID');
  assert.equal(err.message, 'PRIMARY_LINK_INVALID');
});

test('the name and constructor are still Error\'s', () => {
  // Code that logs err.name, or matches on it, sees what it always saw.
  const err = failureSync(() => wa.storeToJson(null));
  assert.equal(err.name, 'Error');
  assert.equal(Object.prototype.toString.call(err), '[object Error]');
  assert.equal(String(err), 'Error: ' + err.message);
});

test('a store failure keeps the cause it wrapped', (t) => {
  const os = require('os');
  const { PrimaryMessageStore } = require('../lib/primary/MessageStore');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-boom-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // A snapshot the store wrote itself, then damaged where only loading it
  // finds out: the failure wraps the TypeError that stopped the load.
  const open = () => PrimaryMessageStore.open({ dir, phone: '40711111111', now: () => 1790000000000 });
  const store = open();
  store.compact();
  store.close();
  const snap = path.join(dir, '40711111111.primary-messages.json');
  const json = JSON.parse(fs.readFileSync(snap, 'utf8'));
  json.chats = [{ id: '40799999999@s.whatsapp.net', records: 5 }];
  fs.writeFileSync(snap, JSON.stringify(json));
  const err = failureSync(open);

  assertBoom(err, 500);
  assert.equal(err.code, 'PRIMARY_MESSAGE_STORE_SNAPSHOT_CORRUPT');
  assert.ok(err.cause instanceof Error, 'the parse error it wrapped');
  assert.equal(Object.keys(err).includes('cause'), false, 'cause stays non-enumerable, as Error sets it');
});

function failureSync(fn) {
  try { fn(); } catch (err) { return err; }
  assert.fail('expected the call to throw');
}
