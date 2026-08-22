'use strict';

// What the package hands back when you require it.
//
// The point of the namespaces is that every module in lib/ can be reached
// without a deep require. That is a claim about ninety-five modules and nearly
// five hundred names, which is too many to check by reading, so it is checked
// here: the tree is walked, every export is looked for in what index.js
// returns, and anything unreachable is named.
//
// The other half is that adding them broke nothing. Every name the library
// exported before is still exported, still holding the same value.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');

const wa = require('../index.js');

const LIB = path.join(__dirname, '..', 'lib');

function modules(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) modules(p, out);
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// Every value reachable from the export object, by identity. Namespaces nest
// three deep at the most (Signal.libsignal.crypto), so four is enough and stops
// this walking into the object graph of a live class.
function reachable(root, maxDepth = 4) {
  const values = new Set();
  const seen   = new Set();
  (function walk(node, depth) {
    if (depth > maxDepth || node === null || seen.has(node)) return;
    const t = typeof node;
    if (t !== 'object' && t !== 'function') return;
    seen.add(node);
    for (const key of Object.keys(node)) {
      let v;
      try { v = node[key]; } catch (_) { continue; }   // a getter that throws
      values.add(v);
      walk(v, depth + 1);
    }
  })(root, 0);
  return values;
}

test('every module in lib/ is reachable from the package export', () => {
  const values  = reachable(wa);
  const missing = [];

  for (const file of modules(LIB)) {
    const rel = path.relative(path.join(__dirname, '..'), file);
    const mod = require(file);

    // A module counts as reached when the exports object itself is in the
    // surface, or — for the ones gathered into a namespace with Object.assign —
    // when every name it exports is, holding the same value.
    if (values.has(mod)) continue;

    if (mod && (typeof mod === 'object' || typeof mod === 'function')) {
      const keys   = Object.keys(mod);
      const unseen = keys.filter(k => !values.has(mod[k]));
      if (keys.length && !unseen.length) continue;
      missing.push(rel + (unseen.length ? '  (' + unseen.join(', ') + ')' : ''));
    } else {
      missing.push(rel);
    }
  }

  assert.deepEqual(missing, [], 'unreachable:\n  ' + missing.join('\n  '));
});

test('a namespace is the module, not a copy of it', () => {
  // The ones that are a plain require have to be that exact object, or a
  // caller holding both would be holding two different things.
  assert.equal(wa.MediaService,   require('../lib/MediaService'));
  assert.equal(wa.MessageProto,   require('../lib/proto/MessageProto'));
  assert.equal(wa.BinaryNode,     require('../lib/BinaryNode'));
  assert.equal(wa.Registration,   require('../lib/Registration'));
  assert.equal(wa.Devices,        require('../lib/DeviceManager'));
  assert.equal(wa.Proto,          require('../lib/proto.js'));
  assert.equal(wa.Messages.MediaRetry, require('../lib/messages/MediaRetry'));

  // The gathered ones are new objects, but every function in them is the
  // module's own.
  assert.notEqual(wa.Signal, require('../lib/signal/SignalProtocol'));
  assert.equal(wa.Signal.SignalProtocol,
    require('../lib/signal/SignalProtocol').SignalProtocol);
  assert.equal(wa.Signal.libsignal.crypto,
    require('../lib/signal/libsignal').crypto);
  assert.equal(wa.AppState.SyncdProto, require('../lib/appstate/SyncdProto'));
  assert.equal(wa.Image.Jpeg, require('../lib/image/Jpeg'));
});

test('gathering a directory into one namespace shadowed nothing', () => {
  // Object.assign is silent about a name it overwrites. These are the three
  // namespaces built that way; if two of their modules ever grow the same
  // name, one implementation would vanish without a word.
  const overlaps = (...objs) => {
    const seen = new Set(), dupes = [];
    for (const o of objs) for (const k of Object.keys(o)) {
      if (seen.has(k)) dupes.push(k); else seen.add(k);
    }
    return dupes;
  };

  assert.deepEqual(overlaps(
    require('../lib/signal/SignalProtocol'),
    require('../lib/signal/SignalStore'),
    require('../lib/signal/SenderKey')), [], 'Signal');

  assert.deepEqual(overlaps(
    require('../lib/appstate/AppStateStore'),
    { AppStateSync: 1, LTHash: 1, Mutations: 1, SyncdProto: 1 }), [], 'AppState');

  assert.deepEqual(overlaps(
    require('../lib/image'),
    { Jpeg: 1, JpegEncoder: 1, Png: 1, Gif: 1, Bmp: 1 }), [], 'Image');

  assert.deepEqual(overlaps(
    require('../lib/signal/libsignal'),
    { BaseKeyType: 1, ChainType: 1, protobufs: 1, queueJob: 1,
      FingerprintGenerator: 1, textsecure: 1 }), [], 'Signal.libsignal');
});

test('no namespace took a name the library already exported', () => {
  // The eighty-two names that were exported before the namespaces existed.
  const BEFORE = [
    'WhalibmobClient', 'checkNumberStatus', 'checkIfRegistered', 'requestSmsCode',
    'verifyCode', 'receivePushCode', 'supportsPush', 'assertRegistrationKeys',
    'fetchWaVersion', 'fetchIosVersion', 'fetchAndroidVersion', 'currentVersionFor',
    'refreshSessionVersion', 'SessionPaths', 'defaultBaseDir', 'sessionDirFor',
    'storeFileFor', 'webStoreFileFor', 'listSessions', 'migrateSession',
    'getDeviceConfig', 'createNewStore', 'saveStore', 'loadStore', 'storeToJson',
    'storeFromJson', 'toSixParts', 'fromSixParts', 'createNewWebStore',
    'saveWebStore', 'loadWebStore', 'webSessionPath', 'generatePairingCode',
    'derivePairingCodeKey', 'buildWrappedEphemeralPub', 'decipherLinkPublicKey',
    'buildCompanionFinishBundle', 'configureSuccessfulPairing',
    'encodeCompanionRegisterPayload', 'encodeCompanionLoginPayload',
    'fetchWaWebVersion', 'WAM', 'encodeWAM', 'BinaryInfo', 'WEB_EVENTS',
    'WEB_GLOBALS', 'SignalProtocol', 'SignalStore', 'SenderKeyStore',
    'SenderKeyCrypto', 'DeviceManager', 'encryptMedia', 'decryptMedia',
    'uploadMedia', 'downloadMedia', 'MessageSender', 'makeJid',
    'generateMessageId', 'GroupParticipantResult', 'GroupJoinRequest',
    'AppStateStore', 'AppStateSync', 'APP_STATE_COLLECTIONS', 'LT_HASH',
    'ReachoutTimelock', 'decodeArgo', 'tryDecodeArgo',
    'makeCacheableSignalKeyStore', 'addTransactionCapability', 'assertMeId',
    'initAuthCreds', 'processHistorySyncNotification',
    'decodeHistorySyncNotification', 'decodeHistorySync',
    'decodeAppStateSyncKeyShare', 'saveAppStateSyncKeys', 'loadAppStateSyncKeys',
    'mergeHistoryToStore', 'decryptHistoryBlob', 'deriveHistoryKeys',
    'HistorySyncType', 'HistorySyncTypeName'
  ];

  for (const name of BEFORE) {
    assert.ok(name in wa, name + ' is gone from the package export');
  }

  // The two that a namespace would have taken, had it been named after its
  // module. They still hold what they always held.
  assert.equal(typeof wa.DeviceManager, 'function', 'DeviceManager is still the class');
  assert.equal(wa.DeviceManager, require('../lib/DeviceManager').DeviceManager);
  assert.equal(typeof wa.SignalProtocol, 'function', 'SignalProtocol is still the class');
  assert.equal(wa.AppStateSync, require('../lib/appstate/AppStateSync'));
});

test('every namespace index.d.ts declares actually exists, and the reverse', () => {
  // tsc checks that the declarations are well formed, not that they are true.
  // A declared namespace that is not there, or one that is there and undeclared,
  // both leave a TypeScript caller worse off than no declaration at all.
  const dts = fs.readFileSync(path.join(__dirname, '..', 'index.d.ts'), 'utf8');
  const namespaceBlock = dts.slice(dts.indexOf('// Namespaces'));
  assert.ok(namespaceBlock, 'the namespace block is still in index.d.ts');

  const declared = new Set();
  for (const m of namespaceBlock.matchAll(/^export declare const (\w+)\s*[:=]/gm)) {
    declared.add(m[1]);
  }
  assert.ok(declared.size > 30, 'found ' + declared.size + ' declarations, expected the lot');

  for (const name of declared) {
    assert.ok(wa[name], 'index.d.ts declares ' + name + ', which the package does not export');
  }

  // The namespaces are the exports whose value is a plain object of the
  // library's own making. Classes and functions are the flat API and are
  // declared further up the file.
  const FLAT_OBJECTS = new Set([
    'SessionPaths', 'ReachoutTimelock', 'WAM', 'AppStateSync', 'WEB_EVENTS',
    'WEB_GLOBALS', 'BinaryInfo', 'HistorySyncType', 'HistorySyncTypeName',
    'APP_STATE_COLLECTIONS', 'LT_HASH', 'SignalStore'
  ]);
  for (const [name, value] of Object.entries(wa)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    if (FLAT_OBJECTS.has(name)) continue;
    assert.ok(declared.has(name),
      'the package exports the namespace ' + name + ', which index.d.ts does not declare');
  }
});

test('every export can be imported by name from an ES module', async () => {
  // Node reads a CommonJS module's names statically when something imports it
  // as ESM, and the reader gives up at the first property of module.exports
  // whose value is not a plain identifier. An arrow function five entries in
  // once cost the package a hundred and sixteen of its hundred and twenty-one
  // names — `import { createNewStore } from 'whalibmob'` was a SyntaxError,
  // while `require` and the default import were fine, so nothing here noticed.
  //
  // A dynamic import puts the same reader over the file, so this is the real
  // check and not an approximation of one.
  const esm = await import('../index.js');

  const named   = Object.keys(esm).filter(k => k !== 'default');
  const runtime = Object.keys(wa);
  const missing = runtime.filter(k => !named.includes(k));

  assert.deepEqual(missing, [],
    missing.length + ' of ' + runtime.length + ' exports cannot be reached by ' +
    '`import { … }`. Something in module.exports is not a plain identifier — ' +
    'bind it to a const above and export the name.\n  ' + missing.join('\n  '));

  // And they are the same values, not just the same names.
  for (const name of runtime) assert.equal(esm[name], wa[name], name);
});

test('requiring the package does not cost meaningfully more than it did', () => {
  // Client.js already pulls in almost all of lib/, so naming the rest is close
  // to free. This guards against a namespace being added that drags in
  // something heavy and nobody noticing.
  const before = Object.keys(require.cache).length;
  assert.ok(before > 0);
  for (const file of modules(LIB)) require(file);
  const after = Object.keys(require.cache).length;

  assert.ok(after - before < 15,
    'requiring the package leaves ' + (after - before) + ' lib modules unloaded; ' +
    'if that grows, the namespaces should become lazy');
});
