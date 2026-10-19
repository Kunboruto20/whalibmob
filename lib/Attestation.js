'use strict';

// ─── Device attestation client ────────────────────────────────────────────────
//
// Talks to the on-device Frida attestation server shipped in ./frida (Android
// Play Integrity / Keystore attestation, iOS App Attest) and folds its output
// into the registration request.
//
// Design:
//   • Two data shapes are produced —
//       Android: { gpia, gg, gi, gp, ge, ga }  (Play Integrity legs)
//       iOS:     { attestation, assertion, keyId }  (App Attest)
//   • A NONE fallback returns empty strings for every field. The WhatsApp
//     registration server tolerates empty attestation as a low-trust signal,
//     so registration still works with no rooted/jailbroken device attached.
//
// Activation: set WA_FRIDA_HOST (e.g. 127.0.0.1) — and optionally WA_FRIDA_PORT
// (default 1119 for WhatsApp consumer, 1120 for Business) — to make the client
// query the local Frida server. When WA_FRIDA_HOST is unset every method
// returns the empty NONE fallback and performs no network I/O.

const crypto = require('crypto');
const http   = require('http');
const curve  = require('./curve');

// ─── Logging helpers (always visible, not gated behind WA_DEBUG) ─────────────

function _log(msg)  { process.stderr.write('[INTEGRITY] ' + msg + '\n'); }
function _ok(msg)   { process.stderr.write('[INTEGRITY] ✓ ' + msg + '\n'); }
function _fail(msg) { process.stderr.write('[INTEGRITY] ✗ ' + msg + '\n'); }

const DEFAULT_PORT   = 1119;   // WhatsApp consumer
const BUSINESS_PORT  = 1120;   // the Business build's own attestation server
const REQUEST_TIMEMS = 15000;

// ─── _gs: WASafe environment security signals ─────────────────────────────────
//
// WhatsApp sends a fresh WASafe envelope (_gs) on every registration request
// (/v2/exist, /v2/code, /v2/register).  The envelope is a 167-byte blob
// (ephX25519pub-32 ‖ AES-256-GCM-ct ‖ tag-16) base64url-encoded and wrapped
// in JSON {"em":"<base64url>"}, then percent-encoded for the form body.
//
// The plaintext is a CSV of 19 fields that report an Android environment health
// profile (root/emulator/tamper checks) plus a timestamp and a random.
// We generate a "clean reference" profile: only /system/build.prop succeeds
// (index 2 of 13 stat checks), all others fail — matching a stock Android.
// The cipher key is the raw X25519 shared secret (no KDF), the server key is
// the same 32-byte key used to encrypt the registration ENC envelope.

const GS_SERVER_KEY = Buffer.from(
  '8e8c0f74c3ebc5d7a6865c6c3c843856b06121cce8ea774d22fb6f122512302d',
  'hex'
);

// Base stat codes for the 13 path checks; +1000 when stat() fails.
const GS_BASE_CODES = [10, 11, 0, 100, 101, 102, 103, 104, 1, 105, 106, 107, 108];

// ─── _ge: environment security flags ─────────────────────────────────────────
// sb=false (no security bypass), sv=false (not security-verified by TEE).
// Always false on a headless client — matching a device that passed basic
// checks but has no hardware-backed verification.
function generateGeToken() {
  return encodeURIComponent('{"sb":false,"sv":false}');
}

// ─── _ga: app analytics envelope ─────────────────────────────────────────────
// bi = SHA-512 of the session nonce (deterministic per session, unique per
// device); ap/ai/ae are numeric constants observed across Android builds;
// mp/mu are multi-profile/multi-user booleans (false on a single-user install).
function generateGaToken(nonceB64) {
  const nonceBuf = Buffer.from(
    (nonceB64 || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64'
  );
  const bi = crypto.createHash('sha512').update(nonceBuf).digest('base64');
  const json = '{"bi":"' + bi + '","ap":247444,"ai":145847,"mp":false,"ae":128383,"mu":false}';
  return encodeURIComponent(json);
}

function generateGsToken() {
  const nowMs = Date.now();
  const sec   = Math.floor(nowMs / 1000);
  const usec  = (nowMs % 1000) * 1000;

  // base = ((sec ^ usec) & 0xefff) + 0x1000, range [0x1000, 0xFFFF]
  const base = ((sec ^ usec) & 0xefff) + 0x1000;

  // Stat fields: index 2 (/system/build.prop) succeeds; all others fail (+1000).
  const statFields = GS_BASE_CODES.map((c, i) => {
    const code = (i === 2) ? c : (c + 1000);
    return (code ^ (base + i * 7)) | 0; // signed int32
  });

  const randRaw       = (crypto.randomBytes(4).readUInt32BE(0) >>> 1);
  const rand          = (randRaw ^ (base + 91)) | 0;

  const millis        = BigInt(nowMs);
  const millisLo      = Number(BigInt.asUintN(32, millis));
  const millisHi      = Number(millis >> 32n);
  const millisLoField = (millisLo ^ ((base + 98)  | 0)) | 0;
  const millisHiField = (millisHi ^ ((base + 105) | 0)) | 0;
  const preparedField = (4242     ^ ((base + 112) | 0)) | 0; // WASafeSignalsPrepare called

  const csv       = [1, ...statFields, base >>> 0, rand, millisLoField, millisHiField, preparedField].join(',');
  const plaintext = Buffer.from(csv, 'utf8');

  const ephSeed = crypto.randomBytes(32);
  const ephKp   = curve.generateKeyPair(ephSeed);
  const ephPub  = Buffer.from(ephKp.public);
  const shared  = Buffer.from(curve.sharedKey(ephKp.private, GS_SERVER_KEY));

  const iv     = Buffer.alloc(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', shared, iv);
  const ct     = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag    = cipher.getAuthTag();

  const envelope = Buffer.concat([ephPub, ct, tag]);
  const em = envelope.toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  return encodeURIComponent('{"em":"' + em + '"}');
}

// ─── Empty (NONE) fallbacks ───────────────────────────────────────────────────

const EMPTY_ANDROID = { gpia: '', gg: '', gi: '', gp: '', ge: '', ga: '' };
const EMPTY_IOS     = { attestation: '', assertion: '', keyId: '' };
const EMPTY_BODY    = { bodyAttestation: null, authorizationHeader: null };

function fridaHost() {
  return process.env.WA_FRIDA_HOST || null;
}

// The Business build's attestation server listens on its own port, because a
// device can have both apps installed and each hooks its own process. An
// explicit WA_FRIDA_PORT still wins over both.
function fridaPort(device) {
  return parseInt(process.env.WA_FRIDA_PORT, 10) ||
    ((device && device.business) ? BUSINESS_PORT : DEFAULT_PORT);
}

function isEnabled() {
  return !!fridaHost();
}

// ─── base64 / hex helpers ─────────────────────────────────────────────────────

function toBase64Url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

function toHex(buf) {
  return Buffer.from(buf).toString('hex');
}

// ─── Local Frida HTTP GET (best-effort; never throws) ─────────────────────────
// Returns the parsed JSON object on success, or null on any failure/timeout so
// the caller can fall back to the empty NONE attestation.

function fridaGet(pathname, query, device) {
  return new Promise((resolve) => {
    const host = fridaHost();
    if (!host) return resolve(null);

    const qs = query
      ? '?' + Object.keys(query)
          .filter(k => query[k] != null)
          .map(k => k + '=' + encodeURIComponent(query[k]))
          .join('&')
      : '';

    const req = http.request(
      { host, port: fridaPort(device), path: pathname + qs, method: 'GET', timeout: REQUEST_TIMEMS },
      (res) => {
        const chunks = [];
        res.on('data', d => chunks.push(d));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch (_) { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// ─── Android: Play Integrity legs (gpia + _gg _gi _gp _ge _ga) ────────────────
//
// nonceB64 is the URL-safe base64 request nonce (see attestationFieldsAndroid).
async function androidIntegrity(nonceB64, device) {
  if (!isEnabled()) return { ...EMPTY_ANDROID };
  const res = await fridaGet('/integrity', { authKey: nonceB64 }, device);
  if (!res || !res.token) return { ...EMPTY_ANDROID };
  _ok('gpia field SET from Frida (' + res.token.length + ' chars)');
  return { gpia: res.token, gg: '', gi: '', gp: '', ge: '', ga: '' };
}

// ─── Keybox: local Keystore attestation without Frida ────────────────────────
//
// Set WA_KEYBOX to the path of an Android keybox XML file to sign the ENC body
// locally instead of forwarding the request to a Frida server.
//
// Supported format — standard AOSP keybox XML:
//   <AndroidAttestation>
//     <Keybox DeviceID="...">
//       <Key algorithm="ecdsa">          (or "rsa")
//         <PrivateKey format="pem">...</PrivateKey>
//         <CertificateChain>
//           <Certificate format="pem">...</Certificate>
//           ...
//         </CertificateChain>
//       </Key>
//     </Keybox>
//   </AndroidAttestation>
//
// ECDSA is preferred over RSA when both are present. If WA_KEYBOX is unset or
// the file cannot be parsed the function falls through to Frida as usual.
//
// Note: Keybox covers only the Keystore attestation (&H= + Authorization).
// It does NOT provide a gpia (Play Integrity) token — that still requires Frida
// or a real Google Play Services device.

let _keyboxCache = undefined; // undefined = not yet loaded

function _loadKeybox() {
  if (_keyboxCache !== undefined) return _keyboxCache;
  const kbPath = process.env.WA_KEYBOX;
  if (!kbPath) return (_keyboxCache = null);

  let xml;
  try {
    xml = require('fs').readFileSync(kbPath, 'utf8');
  } catch (e) {
    _fail('Keybox: cannot read ' + kbPath + ': ' + e.message);
    return (_keyboxCache = null);
  }

  const keys = [];
  const keyRe = /<Key\s+algorithm="([^"]+)"[^>]*>([\s\S]*?)<\/Key>/gi;
  let km;
  while ((km = keyRe.exec(xml)) !== null) {
    const algo  = km[1].toLowerCase();
    const block = km[2];
    const pkM   = block.match(/-----BEGIN[^-]+PRIVATE KEY-----[\s\S]*?-----END[^-]+PRIVATE KEY-----/);
    if (!pkM) continue;
    const certs = [];
    const cRe   = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
    let cm;
    while ((cm = cRe.exec(block)) !== null) certs.push(cm[0].trim());
    keys.push({ algo, privateKey: pkM[0].trim(), certs });
  }

  if (!keys.length) {
    _fail('Keybox: no usable Key elements found in ' + kbPath);
    return (_keyboxCache = null);
  }

  const kb = keys.find(k => k.algo === 'ecdsa') || keys[0];
  _ok('Keybox loaded: ' + kb.algo.toUpperCase() + ', ' + kb.certs.length + ' cert(s) — ' + kbPath);
  return (_keyboxCache = kb);
}

// Sign the UTF-8 bytes of encB64 with the Keybox private key.
function _keyboxSign(encB64) {
  const kb = _loadKeybox();
  if (!kb) return null;
  const data = Buffer.from(encB64, 'utf8');
  try {
    const sign = crypto.createSign('SHA256');
    sign.update(data);
    const sigOpts = kb.algo === 'ecdsa'
      ? { key: kb.privateKey, dsaEncoding: 'der' }
      : { key: kb.privateKey, padding: crypto.constants.RSA_PKCS1_PADDING };
    const sig = sign.sign(sigOpts);
    return { signature: sig.toString('base64'), certs: kb.certs };
  } catch (e) {
    _fail('Keybox: sign failed: ' + e.message);
    return null;
  }
}

// ─── Android: Keystore attestation over the ENC body (&H= + Authorization) ────
//
// Queries /cert?authKey=<authKeyB64>&enc=<encB64>. Both parameters are decoded
// with the STANDARD base64 decoder on the device, so they must not be URL-safe:
//   authKey — the 32-byte raw auth key (the Noise public key, no 0x05 prefix);
//             the server embeds it in the Keystore attestation challenge and
//             locates it in the certificate by its 64-hex-char representation.
//   enc     — the UTF-8 bytes of the ENC payload string, base64-encoded; the
//             server signs exactly those bytes.
// The server returns { signature, certificate }: signature → the &H= body
// suffix, certificate → the Authorization cert-chain header.
async function androidAttestBody(encB64, authKeyB64, device) {
  // Keybox path: sign locally — no device needed.
  const kb = _keyboxSign(encB64);
  if (kb) {
    _ok('Keybox: body attested locally (' + (_loadKeybox() || {}).algo + ')');
    return { bodyAttestation: kb.signature, authorizationHeader: kb.certs.join('\n') };
  }

  if (!isEnabled()) return { ...EMPTY_BODY };
  const encParam = Buffer.from(encB64, 'utf8').toString('base64');
  const res = await fridaGet('/cert', { authKey: authKeyB64, enc: encParam }, device);
  if (!res || !res.signature || !res.certificate) return { ...EMPTY_BODY };
  return { bodyAttestation: res.signature, authorizationHeader: res.certificate };
}

// ─── Android: device /info (apk hashes / signature / secret key) ──────────────
async function androidInfo(device) {
  if (!isEnabled()) return null;
  return fridaGet('/info', null, device);
}

// ─── iOS: App Attest (attestation + assertion + keyId) ────────────────────────
//
// Queries /integrity?authKey=<clientDataHashB64>. The Frida server returns
// { attestation, assertion }; the keyId is generated per call on-device and
// echoed by the server when available. clientDataHash is the base64 of the
// Noise public key (the server SHA-256-hashes it internally).
async function iosAppAttest(noisePubB64, device) {
  if (!isEnabled()) return { ...EMPTY_IOS };
  const res = await fridaGet('/integrity', { authKey: noisePubB64 }, device);
  if (!res || !res.attestation || !res.assertion) return { ...EMPTY_IOS };
  return {
    attestation: res.attestation,
    assertion:   res.assertion,
    keyId:       res.keyId || ''
  };
}

// ─── High-level: attestation fields shipped on every attested endpoint ────────
//
// Returns the alternating name/value pairs the attested endpoints expect:
//   Android → gpia,_gg,_gi,_gp,_ge,_ga,push_token
//   iOS     → push_token
//
// These fields are part of the plaintext that gets AES-GCM-sealed into the
// ENC envelope, so the Play Integrity nonce is derived from the store (a stable
// per-session value), NOT from the ENC body. pushToken comes from the optional
// push client — empty by default.
// A field with no value is omitted from the body rather than sent empty.
// buildForm drops null and keeps '', and the registration server validates the
// shape of what it receives: an empty push_code is a malformed push_code, and
// it answers with bad_param/bad_format naming that field. An absent field has
// nothing to validate, which is what an unattested client should send.
// Real values are still sent whenever a Frida attestation server supplies them.
const orNull = (v) => (v === '' || v === undefined ? null : v);

async function attestationFields(device, nonceB64, opts) {
  opts = opts || {};
  const pushToken = orNull(opts.pushToken);

  if (device && device.os === 'android') {
    const a  = await androidIntegrity(nonceB64 || '', device);
    const gs = generateGsToken();
    const ge = generateGeToken();
    const ga = generateGaToken(nonceB64 || '');
    _ok('_gs field generated (WASafe envelope, ' + gs.length + ' encoded chars)');
    return [
      'gpia',       orNull(a.gpia),
      '_gg',        orNull(a.gg),
      '_gi',        orNull(a.gi),
      '_gp',        orNull(a.gp),
      '_ge',        ge,
      '_ga',        ga,
      '_gs',        gs,
      'push_token', pushToken
    ];
  }

  // iOS ships only push_token in the form body; App Attest rides in &H= + header.
  return ['push_token', pushToken];
}

// ─── High-level: body attestation (&H= suffix + Authorization header) ─────────
//
// encB64       — the base64url ENC payload (without the "ENC=" prefix)
// device       — { os }
// keys.noisePubB64 — standard base64 of the 32-byte Noise public key. Android
//                    uses it as the Keystore attestation challenge auth key;
//                    iOS uses it as the App Attest clientDataHash source.
async function attestBody(encB64, device, keys) {
  keys = keys || {};
  if (device && device.os === 'android') {
    return androidAttestBody(encB64, keys.noisePubB64 || '', device);
  }
  const data = await iosAppAttest(keys.noisePubB64 || '', device);
  if (!data.attestation || !data.assertion || !data.keyId) return { ...EMPTY_BODY };
  return {
    bodyAttestation:     '{"assertion":"' + data.assertion + '"}',
    authorizationHeader: data.attestation + '|' + data.keyId
  };
}

module.exports = {
  isEnabled,
  attestationFields,
  attestBody,
  androidInfo,
  toHex,
  toBase64Url,
  EMPTY_ANDROID,
  EMPTY_IOS,
  EMPTY_BODY
};
