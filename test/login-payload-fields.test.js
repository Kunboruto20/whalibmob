'use strict';

// The ClientPayload and userAgent fields a real Android client always writes on
// the Noise login, beyond the handful the library sent before. These are pure
// fidelity: a login payload missing fields every genuine client carries is itself
// a fingerprint. Checked here by decoding the protobuf field numbers on the wire.

const test   = require('node:test');
const assert = require('node:assert/strict');

const { encodeClientPayload } = require('../lib/proto');

const UA = {
  platform: 0, version: '2.26.35.75', mcc: '234', mnc: '15', osVersion: '14',
  manufacturer: 'Samsung', device: 'SM-S928B', osBuildNumber: 'UP1A.231005.007',
  phoneId: 'DA1E6667', releaseChannel: 0, localeLanguage: 'en', localeCountry: 'GB',
  deviceBoard: 'exynos2400', deviceExpId: 'abcmayjhrowemjwinj2dha',
  deviceType: 0, deviceModelType: 'SM-S928B'
};

// Minimal protobuf field walker: returns [fieldNumber, lenContentOrNull] pairs.
function walk(buf) {
  let o = 0; const out = [];
  const rv = () => { let r = 0, s = 0; for (;;) { const x = buf[o++]; r |= (x & 0x7f) << s; if (!(x & 0x80)) break; s += 7; } return r >>> 0; };
  while (o < buf.length) {
    const t = rv(); const f = t >> 3, w = t & 7;
    let d = null;
    if (w === 2) { const l = rv(); d = buf.subarray(o, o + l); o += l; }
    else if (w === 0) { rv(); } else if (w === 5) { o += 4; } else if (w === 1) { o += 8; }
    out.push([f, d]);
  }
  return out;
}

function topFields(buf) {
  const entries = walk(buf);
  const ua = entries.find(e => e[0] === 5);
  return { fields: entries.map(e => e[0]), uaBuf: ua ? ua[1] : null };
}

function innerFields(buf) {
  return walk(buf).map(e => e[0]);
}

test('ClientPayload carries dnsSource (15), trafficAnonymization (40), connectionSequenceInfo (43)', () => {
  const buf = encodeClientPayload({
    username: 40712345678n, passive: false, userAgent: UA, oc: false,
    sessionId: 1, shortConnect: false, connectType: 1, connectReason: 6,
    dnsSource: { dnsMethod: 0, appCached: false }, connectAttemptCount: 0,
    device: 0, lc: 0, yearClass: 2016, memClass: 256,
    trafficAnonymization: 0, connectionSequenceInfo: 5
  });
  const { fields } = topFields(buf);
  for (const f of [15, 40, 43]) assert.ok(fields.includes(f), 'has field ' + f);
  assert.deepEqual(fields, [...fields].sort((a, b) => a - b), 'ascending field order');
});

test('userAgent carries deviceBoard (13) and deviceExpId (14)', () => {
  const buf = encodeClientPayload({ username: 1n, passive: false, userAgent: UA, oc: false });
  const { uaBuf } = topFields(buf);
  const ua = innerFields(uaBuf);
  assert.ok(ua.includes(13), 'deviceBoard present');
  assert.ok(ua.includes(14), 'deviceExpId present');
  assert.deepEqual(ua, [...ua].sort((a, b) => a - b), 'ascending field order');
});

test('deviceBoard is omitted when the profile has no board', () => {
  const ua = Object.assign({}, UA, { deviceBoard: undefined });
  const buf = encodeClientPayload({ username: 1n, passive: false, userAgent: ua, oc: false });
  const { uaBuf } = topFields(buf);
  assert.ok(!innerFields(uaBuf).includes(13), 'no field 13 without a board');
});

test('dnsSource nests dnsMethod (15) and appCached (16)', () => {
  const buf = encodeClientPayload({
    username: 1n, passive: false, userAgent: UA, oc: false,
    dnsSource: { dnsMethod: 7, appCached: true }
  });
  const f15 = walk(buf).find(e => e[0] === 15);
  assert.ok(f15 && f15[1], 'ClientPayload field 15 present');
  assert.deepEqual(innerFields(f15[1]), [15, 16], 'inner dnsMethod + appCached');
});
