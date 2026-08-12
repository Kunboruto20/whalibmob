'use strict';

// Firebase Cloud Messaging registration — the push_token a real WhatsApp
// install carries.
//
// Every WhatsApp on a real phone holds a push token, because that is how the
// server wakes it when a message arrives. A registration that ships no
// push_token describes a WhatsApp that cannot be notified, which is a device
// that does not exist. The field was already wired through
// Attestation.attestationFields; nothing ever filled it, so buildForm dropped
// it and every registration went out without one.
//
// Three steps, all plain HTTPS with Google — no root, no Frida, no phone:
//
//   1. checkin      android.clients.google.com/checkin
//                   protobuf in, protobuf out; yields an android id and a
//                   security token, which together are the device's identity
//                   with Google.
//   2. FIS install  firebaseinstallations.googleapis.com/v1/projects/…
//                   registers a Firebase installation for WhatsApp's project
//                   and returns a short-lived auth token.
//   3. register3    android.clients.google.com/c2dm/register3
//                   trades the two for the actual FCM token.
//
// Everything here fails soft. A blocked network, a refusal from Google, a
// malformed answer — all of them return null, the field is omitted, and
// registration proceeds exactly as it did before this file existed. A push
// token is a signal that helps; it is not a prerequisite, and it must never be
// the reason a registration cannot be attempted.
//
// The session is persisted with the account. Google hands out an android id
// once and expects it to keep coming back; re-running checkin on every
// registration step would mint a new device each time, which is itself a
// pattern no real phone produces.

const https = require('https');
const zlib  = require('zlib');
const crypto = require('crypto');

const { dbg: _whaDbg } = require('./logger');
const { proxyAgent }   = require('./socks');

// WhatsApp's own Firebase project. These are public client-side identifiers,
// the same ones the APK ships in google-services.json.
const FCM_CONFIG = {
  personal: {
    projectId:   'whatsapp-messenger',
    appId:       '1:293955441834:android:7373a2d0bdfa3228',
    apiKey:      'AIzaSyCGOJbGQ95SWrXxl8wk-_cRQZcJl42bvDU',
    senderId:    '293955441834',
    packageName: 'com.whatsapp',
    certSha1:    '38a0f7d505fe18fec64fbf343ecaaaf310dbd799'
  },
  business: {
    projectId:   'whatsapp-messenger',
    appId:       '1:293955441834:android:7373a2d0bdfa3228',
    apiKey:      'AIzaSyCGOJbGQ95SWrXxl8wk-_cRQZcJl42bvDU',
    senderId:    '293955441834',
    packageName: 'com.whatsapp.w4b',
    certSha1:    '38a0f7d505fe18fec64fbf343ecaaaf310dbd799'
  }
};

const CHECKIN_URL  = 'https://android.clients.google.com/checkin';
const REGISTER_URL = 'https://android.clients.google.com/c2dm/register3';
const FIS_URL      = 'https://firebaseinstallations.googleapis.com/v1/projects/%s/installations';

const HTTP_TIMEOUT_MS = 15000;

// A Firebase installation id: 17 random bytes with the top nibble pinned to
// 0b0111 per the FIS spec, url-safe base64, truncated to 22 characters.
const FID_BYTES = 17;
const FID_LENGTH = 22;

// ─── minimal protobuf writer ─────────────────────────────────────────────────
//
// The checkin message is the only protobuf this file has to produce, and it is
// a handful of scalar fields. A writer for exactly those is smaller than a
// schema plus a runtime, and it keeps the wire format visible next to the code
// that depends on it.

function varint(value) {
  let v = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
  if (v < 0n) v += 1n << 64n;                       // two's complement, as protobuf does
  const out = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return Buffer.from(out);
}

const pbTag   = (field, wire) => varint((field << 3) | wire);
const pbInt   = (field, n)    => Buffer.concat([pbTag(field, 0), varint(n)]);
const pbBool  = (field, b)    => Buffer.concat([pbTag(field, 0), varint(b ? 1 : 0)]);

function pbBytes(field, buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8');
  return Buffer.concat([pbTag(field, 2), varint(b.length), b]);
}
const pbStr = pbBytes;
const pbMsg = pbBytes;

// ─── checkin request / response ──────────────────────────────────────────────

function encodeCheckinRequest() {
  const now = Date.now();

  // The device this claims to be. A fixed, unremarkable build: Google's own
  // reference hardware, which is what every FCM client library has announced
  // for a decade. Randomising it would make each registration a different
  // phantom device, which reads worse than one ordinary repeated one.
  const build = Buffer.concat([
    pbStr(1,  'google/razor/flo:5.0.1/LRX22C/1602158:user/release-keys'),
    pbStr(2,  'flo'),
    pbStr(3,  'google'),
    pbStr(6,  'android-google'),
    pbInt(7,  Math.floor(now / 1000)),
    pbInt(10, 30),
    pbStr(11, 'Nexus 7'),
    pbStr(12, 'asus'),
    pbStr(13, 'razor'),
    pbBool(14, false)
  ]);

  const event = Buffer.concat([
    pbStr(1, 'event_log_start'),
    pbInt(3, now)
  ]);

  const checkin = Buffer.concat([
    pbMsg(1, build),
    pbInt(2, 0),
    pbMsg(3, event),
    pbInt(9, 0)
  ]);

  // 53 bits of randomness rather than a full 63: it stays an exact JS integer,
  // and Google only needs the value to be unlikely to collide.
  const loggingId = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);

  return Buffer.concat([
    pbInt(2,  0),
    pbMsg(4,  checkin),
    pbStr(6,  'en_US'),
    pbInt(7,  loggingId),
    pbStr(12, 'UTC'),
    pbInt(14, 3),
    pbInt(20, 0),
    pbInt(22, 0)
  ]);
}

// Only two fields matter in the answer, both fixed64: 7 = android id,
// 8 = security token. They are 64-bit and are echoed back to Google verbatim,
// so they are kept as BigInt and only ever stringified — a Number would round
// them and the Authorization header would be silently wrong.
function decodeCheckinResponse(buf) {
  let i = 0;
  const out = { androidId: null, securityToken: null };

  const readVarint = () => {
    let result = 0n, shift = 0n;
    while (i < buf.length) {
      const b = buf[i++];
      result |= BigInt(b & 0x7f) << shift;
      shift += 7n;
      if (!(b & 0x80)) break;
    }
    return result;
  };

  while (i < buf.length) {
    const key   = Number(readVarint());
    const field = key >> 3;
    const wire  = key & 7;

    if (wire === 0) { readVarint(); }
    else if (wire === 1) {
      if (i + 8 > buf.length) break;
      const v = buf.readBigUInt64LE(i);
      i += 8;
      if (field === 7) out.androidId = v;
      if (field === 8) out.securityToken = v;
    }
    else if (wire === 2) {
      const len = Number(readVarint());
      i += len;
    }
    else if (wire === 5) { i += 4; }
    else break;
  }
  return out;
}

// ─── HTTP ────────────────────────────────────────────────────────────────────
//
// Routed through the SOCKS agent when one is configured, like every other
// outbound call in the library — a machine that needs a proxy to reach WhatsApp
// generally needs one to reach Google too.

function httpPost(url, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const agent = proxyAgent();
    const req = https.request({
      hostname: u.hostname,
      port:     u.port || 443,
      path:     u.pathname + u.search,
      method:   'POST',
      headers:  Object.assign({ 'Content-Length': body.length }, headers),
      agent:    agent || undefined
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let raw = Buffer.concat(chunks);
        if (String(res.headers['content-encoding'] || '').includes('gzip')) {
          try { raw = zlib.gunzipSync(raw); } catch (_) {}
        }
        resolve({ status: res.statusCode || 0, body: raw });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(HTTP_TIMEOUT_MS, () => req.destroy(new Error('timed out')));
    req.write(body);
    req.end();
  });
}

// ─── the three steps ─────────────────────────────────────────────────────────

async function checkin() {
  const body = zlib.gzipSync(encodeCheckinRequest());
  const res  = await httpPost(CHECKIN_URL, body, {
    'Content-Type':     'application/x-protobuffer',
    'Content-Encoding': 'gzip',
    'Accept-Encoding':  'gzip',
    'User-Agent':       'Android-Checkin/2.0 (generic JLS36G); gzip'
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error('checkin HTTP ' + res.status);
  }
  const { androidId, securityToken } = decodeCheckinResponse(res.body);
  if (!androidId || !securityToken) {
    throw new Error('checkin returned no android id (' + res.body.length + ' B)');
  }
  return { androidId: androidId.toString(), securityToken: securityToken.toString() };
}

function generateFid() {
  const raw = crypto.randomBytes(FID_BYTES);
  raw[0] = 0b01110000 | (raw[0] & 0b00001111);
  return raw.toString('base64url').slice(0, FID_LENGTH);
}

async function fisInstall(config, existingFid) {
  const fid  = existingFid || generateFid();
  const body = Buffer.from(JSON.stringify({
    fid,
    appId:       config.appId,
    authVersion: 'FIS_v2',
    sdkVersion:  'a:17.0.0'
  }), 'utf8');

  const res = await httpPost(FIS_URL.replace('%s', config.projectId), body, {
    'Content-Type':    'application/json',
    'Accept':          'application/json',
    'Cache-Control':   'no-cache',
    'User-Agent':      'Dalvik/2.1.0 (Linux; U; Android 11; Pixel 2 Build/RP1A.201005.004) FirebaseInstallations/17.0.0',
    'X-Firebase-Client': Buffer.from('{"heartbeats":[],"version":2}', 'utf8').toString('base64url'),
    'x-goog-api-key':  config.apiKey,
    'X-Android-Package': config.packageName,
    'X-Android-Cert':  config.certSha1.replace(/:/g, '').toUpperCase()
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error('FIS install HTTP ' + res.status + ': ' + res.body.toString('utf8').slice(0, 200));
  }

  let parsed;
  try { parsed = JSON.parse(res.body.toString('utf8')); }
  catch (_) { throw new Error('FIS install returned non-JSON'); }

  const auth = parsed.authToken || {};
  return {
    fid:          parsed.fid || fid,
    authToken:    auth.token || '',
    refreshToken: parsed.refreshToken || '',
    expiresAt:    Math.floor(Date.now() / 1000) + parseDurationSeconds(auth.expiresIn)
  };
}

// Google writes durations as "604800s". A missing or malformed value becomes 0,
// which reads as already expired and simply forces a refresh next time.
function parseDurationSeconds(text) {
  const m = /^(\d+)s$/.exec(String(text || ''));
  return m ? parseInt(m[1], 10) : 0;
}

async function register3(config, session) {
  const form = {
    app:           config.packageName,
    sender:        config.senderId,
    device:        session.androidId,
    cert:          config.certSha1.replace(/:/g, '').toLowerCase(),
    app_ver:       '1',
    target_ver:    '30',
    info:          '',
    'X-subtype':      config.senderId,
    'X-subscription': config.senderId,
    'X-app_ver':      '1',
    'X-osv':          '30',
    'X-cliv':         'fiid-21.1.0',
    'X-gmsv':         '240913000',
    'X-scope':        '*',
    'X-appid':        session.fid,
    'X-gmp_app_id':   config.appId,
    'X-Goog-Firebase-Installations-Auth': session.fisAuthToken,
    'X-firebase-app-name-hash': ''
  };

  const body = Buffer.from(
    Object.keys(form)
      .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(form[k]))
      .join('&'),
    'utf8'
  );

  const res = await httpPost(REGISTER_URL, body, {
    'Authorization': 'AidLogin ' + session.androidId + ':' + session.securityToken,
    'Content-Type':  'application/x-www-form-urlencoded',
    'User-Agent':    'Android-GCM/1.5 (generic LRX22C)',
    'app':           config.packageName
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error('register3 HTTP ' + res.status + ': ' + res.body.toString('utf8').slice(0, 200));
  }

  // The answer is a flat key=value list; anything other than a token line is
  // an error Google chose to report with a 200.
  const text = res.body.toString('utf8').trim();
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0 && line.slice(0, eq).trim() === 'token') {
      const token = line.slice(eq + 1).trim();
      if (token) return token;
    }
  }
  throw new Error('register3 returned no token: ' + text.slice(0, 200));
}

// ─── public entry point ──────────────────────────────────────────────────────

/** Whether push-token acquisition is switched on. Opt out with WA_FCM_PUSH=0. */
function enabled() {
  const v = process.env.WA_FCM_PUSH;
  return v === undefined || !(v === '0' || v.toLowerCase() === 'false' || v === 'off');
}

// A token in hand is reused. Google mints an android id once and expects it
// back; running checkin again per registration step would present a new phantom
// device every time.
function cached(store) {
  const s = store && store.fcm;
  return s && s.token ? s.token : null;
}

/**
 * The FCM push token for this account, or null.
 *
 * Never throws and never rejects: every failure path ends as null, which
 * attestationFields turns into an omitted field and buildForm leaves out of the
 * body entirely — byte for byte what registration sent before this existed.
 *
 * @param {object} store   the account store; the session is cached on store.fcm
 * @param {object} device  device config; device.business picks the w4b package
 * @returns {Promise<string|null>}
 */
async function getPushToken(store, device) {
  if (!enabled()) return null;
  if (!store) return null;

  const hit = cached(store);
  if (hit) {
    _whaDbg('[DBG] FCM push token from cache, length=' + hit.length);
    return hit;
  }

  const config = (device && device.business) ? FCM_CONFIG.business : FCM_CONFIG.personal;
  const prev   = store.fcm || {};

  try {
    let androidId     = prev.androidId;
    let securityToken = prev.securityToken;

    if (!androidId || !securityToken) {
      _whaDbg('[DBG] FCM step 1/3 checkin');
      const ids = await checkin();
      androidId     = ids.androidId;
      securityToken = ids.securityToken;
    }

    _whaDbg('[DBG] FCM step 2/3 FIS install (' + config.packageName + ')');
    const fis = await fisInstall(config, prev.fid);

    _whaDbg('[DBG] FCM step 3/3 register3');
    const token = await register3(config, {
      androidId, securityToken,
      fid:           fis.fid,
      fisAuthToken:  fis.authToken
    });

    store.fcm = {
      androidId, securityToken,
      fid:             fis.fid,
      fisAuthToken:    fis.authToken,
      fisRefreshToken: fis.refreshToken,
      fisExpiresAt:    fis.expiresAt,
      token
    };
    _whaDbg('[DBG] FCM push token acquired, length=' + token.length);
    return token;
  } catch (err) {
    // Keep whatever identity was established: a checkin that succeeded before a
    // later step failed is worth carrying into the next attempt rather than
    // minting a second android id.
    _whaDbg('[DBG] FCM push token unavailable: ' + (err && err.message) +
      ' — registering without one');
    return null;
  }
}

module.exports = {
  getPushToken,
  enabled,
  FCM_CONFIG,
  // exported for tests
  encodeCheckinRequest,
  decodeCheckinResponse,
  generateFid,
  parseDurationSeconds
};
