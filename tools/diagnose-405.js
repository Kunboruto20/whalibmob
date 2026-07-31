#!/usr/bin/env node
'use strict';
//
// Asks the server which part of the login it objects to.
//
//   node tools/diagnose-405.js <phone> [--session <dir>]
//
// A 405 says "client outdated" and names nothing else, so the only way to find
// out what it actually dislikes is to vary one thing at a time and read the
// answer. Each row below is one login attempt with the session already on disk:
// nothing is registered, no code is requested, and the session is never
// written to. The verdict per row is what the server replied.
//
//   405  the client was refused — that row's combination is not accepted
//   401  the client was accepted and only the credentials were rejected
//   ok   the login succeeded
//
// Read it by comparing rows: the first row that stops saying 405 names the
// field that was the problem.

const path = require('path');
const os   = require('os');

const LIB = path.join(__dirname, '..', 'lib');
const { loadStore }              = require(path.join(LIB, 'Store.js'));
const { encodeClientPayload }    = require(path.join(LIB, 'proto.js'));
const { NoiseSocket }            = require(path.join(LIB, 'noise.js'));
const { parsePhone, getCountryMeta } = require(path.join(LIB, 'Registration.js'));
const { platformForOs, PLATFORM }    = require(path.join(LIB, 'constants.js'));

// Keep the whole <failure> node, not just the reason the library keeps.
const BinaryNode = require(path.join(LIB, 'BinaryNode.js'));
const decodeNode = BinaryNode.decodeNode;
let lastNode = null;
BinaryNode.decodeNode = function () {
  lastNode = decodeNode.apply(this, arguments);
  return lastNode;
};

const args    = process.argv.slice(2);
const phone   = String(args[0] || '').replace(/\D/g, '');
const sessArg = args.indexOf('--session');
const sessDir = sessArg !== -1 ? args[sessArg + 1] : path.join(os.homedir(), '.waSession');

if (!phone) {
  console.error('usage: node tools/diagnose-405.js <phone> [--session <dir>]');
  process.exit(2);
}

const store = loadStore(path.join(sessDir, phone + '.json'));
if (!store) {
  console.error('no session for ' + phone + ' in ' + sessDir);
  process.exit(2);
}

const meta   = getCountryMeta(parsePhone(store.phoneNumber).cc);
const device = store.device || {};
const isAndroid = String(device.os).toLowerCase() === 'android';

// What the reference client announces on Android, and the knobs that differ
// between it and what this library used to send.
function payloadFor(over) {
  over = over || {};
  const ua = {
    platform:        over.platform !== undefined ? over.platform : platformForOs(device.os),
    version:         over.version  || store.version,
    mcc:             over.realCarrier ? meta.mcc : '000',
    mnc:             over.realCarrier ? meta.mnc : '000',
    osVersion:       device.osVersion,
    manufacturer:    device.manufacturer,
    device:          over.useModelId ? device.modelId : device.model,
    osBuildNumber:   over.withBuild ? device.osBuildNumber : null,
    phoneId:         over.lowerPhoneId ? store.fdid.toLowerCase() : store.fdid.toUpperCase(),
    releaseChannel:  0,
    localeLanguage:  over.realLocale ? meta.lg : 'en',
    localeCountry:   over.realLocale ? meta.lc : 'US',
    deviceType:      0,
    deviceModelType: device.modelId
  };
  return encodeClientPayload({
    username:            BigInt(store.phoneNumber),
    passive:             false,
    pushName:            store.registered ? (store.name || null) : null,
    shortConnect:        true,
    connectType:         1,
    connectReason:       1,
    connectAttemptCount: 0,
    device:              0,
    oc:                  false,
    userAgent:           ua
  });
}

function attempt(over) {
  return new Promise(resolve => {
    lastNode = null;
    const sock = new NoiseSocket(store, { buildPayload: () => payloadFor(over) });
    let settled = false;
    const finish = (verdict) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.close(); } catch (_) {}
      const attrs = lastNode && lastNode.description === 'failure' && lastNode.attrs;
      resolve(verdict + (attrs ? '   ' + JSON.stringify(attrs) : ''));
    };
    const timer = setTimeout(() => finish('timeout'), 30000);
    sock.on('open',  () => finish('ok — LOGIN ACCEPTED'));
    sock.on('error', e  => finish(e.code ? String(e.code) : e.message));
    sock.connect().catch(() => {});
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// One variable at a time, starting from the reference client's exact shape.
const ROWS = [
  ['reference client, as-is',        {}],
  ['  + the real carrier (mcc/mnc)', { realCarrier: true }],
  ['  + the real locale',            { realLocale: true }],
  ['  + osBuildNumber',              { withBuild: true }],
  ['  + model id as the device',     { useModelId: true }],
  ['  + lowercase phoneId',          { lowerPhoneId: true }],
  ['everything the old code sent',   { realCarrier: true, realLocale: true, withBuild: true }],
  ['announced as iOS',               { platform: PLATFORM.IOS }]
];

// --dry-run builds every row's payload and prints its size without opening a
// socket, so the tool itself can be checked without talking to the server.
if (args.includes('--dry-run')) {
  console.log('session   +' + store.phoneNumber + '   (dry run — nothing is sent)\n');
  for (const [label, over] of ROWS) {
    console.log(label.padEnd(34) + payloadFor(over).length + ' bytes');
  }
  process.exit(0);
}

(async () => {
  console.log('session   +' + store.phoneNumber);
  console.log('platform  ' + (isAndroid ? 'android' : 'ios') + '  (' + platformForOs(device.os) + ')');
  console.log('version   ' + store.version);
  console.log('device    ' + device.manufacturer + ' / ' + device.model + ' / ' + device.modelId);
  console.log('build     ' + (device.osBuildNumber || '—'));
  console.log('');
  for (const [label, over] of ROWS) {
    process.stdout.write(label.padEnd(34));
    const verdict = await attempt(over);
    console.log(verdict);
    await sleep(4000);
  }
  console.log('\nthe first row that is not 405 names what the server objected to.');
  process.exit(0);
})();
