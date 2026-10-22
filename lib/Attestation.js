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
// bi  — AES-256-CBC(key=SHA256(std_base64(authkey)), IV=16B random, PKCS7,
//        plaintext=std_base64(32 random bytes)) → std_base64 → 88 chars ending ==
// ap  — age of base.apk in seconds (time() − mtime(base.apk))
// ai  — age of oldest file in dataDir (time() − min_mtime(dataDir))
// ae  — age of oldest file in external files dir; invariant: ae < ai, ae ≈ ai − 30..120
// mp/mu — monkey flags, always false on a non-automated device
//
// authKeyRaw: raw 32-byte Noise static public key (Buffer).
// Fresh-install model: ai ∈ [120, 7200] s; ap ≈ ai ± 300; ae = ai − rand(30, 120).
function generateGaToken(authKeyRaw) {
  // Integrity AES key = SHA256(standard-base64 of the 32-byte auth key WITH padding)
  const aesKey = sha256(Buffer.from(authKeyRaw.toString('base64'), 'utf8'));

  // bi plaintext: std_base64 of 32 random bytes — 44 chars, ends with single '='
  const plaintext = Buffer.from(crypto.randomBytes(32).toString('base64'), 'utf8');

  // AES-256-CBC encrypt: IV(16) ‖ ct(48) = 64 bytes → std_base64 → 88 chars ending '=='
  const iv     = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv);
  const ct     = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  // HTTP variant: '/' inside bi escaped as '\/' (becomes %5C%2F after encodeURIComponent)
  const bi = Buffer.concat([iv, ct]).toString('base64').replace(/\//g, '\\/');

  // Fresh-install file ages (seconds)
  const ai = 120 + Math.floor(Math.random() * 7081);             // [120, 7200]
  const ap = Math.max(1, ai + Math.floor(Math.random() * 601) - 300); // ai ± 300, min 1
  const ae = ai - (30 + Math.floor(Math.random() * 91));         // ai − [30, 120]

  const json = '{"bi":"' + bi + '","ap":' + ap + ',"ai":' + ai + ',"mp":false,"ae":' + ae + ',"mu":false}';
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

// ─── _gg: Play Integrity status envelope ─────────────────────────────────────
// {"_ic": N, "_it": "<token>"}  (same AES-256-CBC envelope as _ga)
//   _ic — Play Integrity error code: 0 = success; 1003 = not prepared (no GMS)
//   _it — Play Integrity JWE token, or the literal "undefined" on error
//
// When a real token is available (Frida path) _ic=0 and _it=gpia.token.
// Without a real device we report _ic=1003 (provider not prepared) so the
// server sees an honest "PI unavailable" rather than a missing field entirely.
// This matches what a fresh install on a device without Google Play Services
// would legitimately report.
function generateGgToken(authKeyRaw, icCode, itToken) {
  const _ic = (icCode  !== undefined) ? icCode  : 1003;
  const _it = (itToken !== undefined) ? itToken : 'undefined';

  const aesKey = sha256(Buffer.from(authKeyRaw.toString('base64'), 'utf8'));
  const json   = '{"_ic":' + _ic + ',"_it":"' + _it.replace(/\//g, '\\/') + '"}';
  const iv     = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv);
  const ct     = Buffer.concat([cipher.update(Buffer.from(json, 'utf8')), cipher.final()]);
  return encodeURIComponent(Buffer.concat([iv, ct]).toString('base64'));
}

// ─── _gp: SHA-256 of the manifest permission list ────────────────────────────
// SHA256(sorted-concat of 85 uses-permission names, Android 12+, no separator)
// Base64-std, percent-encoded on the wire.  Identical in /v2/code and /v2/register
// for the same installation. Stable within a major WhatsApp version; changes
// only when Meta adds or removes a permission from the manifest.
//
// Known values from live captures:
//   2.26.35.75  Android 12+  (85 perms): XpccAx8EKQswlTL2MtpCnGIMXTCaUbAf95ElLECc6jk=
//   2.26.37.73  (same list):              XpccAx8EKQswlTL2MtpCnGIMXTCaUbAf95ElLECc6jk=
const _GP_ANDROID12 = 'XpccAx8EKQswlTL2MtpCnGIMXTCaUbAf95ElLECc6jk%3D';

function generateGpToken() {
  return _GP_ANDROID12;
}

// ─── _gi: APK integrity envelope ─────────────────────────────────────────────
// 10-field JSON encrypted with the same AES-256-CBC envelope as _ga / _gg.
//
// Fields (all '/' escaped as '\/' inside the plaintext):
//   _dh  — base64(SHA256(classes.dex))
//   _iln — base64(SHA256(sorted .so basenames from lib/*/ in APK, deduplicated))
//   _isb — APK size in bytes (string)
//   _ip  — package name
//   did  — Build.ID + "." + Build.VERSION.INCREMENTAL
//   _p   — install path: /data/app/~~<rand>/com.whatsapp-<rand>/base.apk
//   _ln  — base64(SHA256(sorted .so basenames from nativeLibraryDir, arm64-v8a))
//   _ist — base64(SHA256(first 10MB of APK))
//   _icr — base64(SHA1(signing cert DER, first cert))
//   _is  — base64(SHA256(full APK))
//
// material: as returned by extractMaterial (or materialFromJson).
// device:   DeviceConfig entry ({ osBuildNumber, ... }).
// Returns null (field omitted) when material lacks the _gi hashes — e.g. a
// material JSON written before this version.
function generateGiToken(authKeyRaw, material, device) {
  if (!material ||
      !material.classesDexSha256 ||
      !material.soNamesSha256    ||
      !material.soNamesArm64Sha256 ||
      material.apkSize == null   ||
      !material.apkSha256Full    ||
      !material.apkSha256First10M ||
      !material.certificates     || !material.certificates.length) {
    return null;
  }

  const b64 = (buf) => buf.toString('base64').replace(/\//g, '\\/');

  const _dh  = b64(material.classesDexSha256);
  const _iln = b64(material.soNamesSha256);
  const _isb = String(material.apkSize);
  const _ip  = (material.packageName || 'com.whatsapp').replace(/\//g, '\\/');
  const _ln  = b64(material.soNamesArm64Sha256);
  const _ist = b64(material.apkSha256First10M);
  const _icr = b64(crypto.createHash('sha1').update(material.certificates[0]).digest());
  const _is  = b64(material.apkSha256Full);

  // did: Build.ID + "." + BUILD_INCREMENTAL
  // osBuildNumber is Build.ID (e.g. "UP1A.231005.007"); we append a plausible
  // BUILD_INCREMENTAL (a short decimal build number typical for Samsung/AOSP).
  const buildId     = (device && device.osBuildNumber) ? device.osBuildNumber : 'UP1A.231005.007';
  const incremental = (device && device.osBuildIncremental) ? device.osBuildIncremental : '11974865';
  const did         = (buildId + '.' + incremental).replace(/\//g, '\\/');

  // _p: /data/app/~~<rand>/com.whatsapp-<rand>/base.apk
  // The two random suffixes are base64url-like 8-char strings (real Android uses
  // longer random tokens, but 8 chars matches common ADB dumps).
  function _randTag() {
    return crypto.randomBytes(6).toString('base64').replace(/\+/g, 'A').replace(/\//g, 'B').replace(/=/g, 'C');
  }
  const _p = '\\/data\\/app\\/~~' + _randTag() + '\\/' + _ip + '-' + _randTag() + '\\/base.apk';

  const json = '{"_dh":"' + _dh + '","_iln":"' + _iln + '","_isb":"' + _isb +
    '","_ip":"' + _ip + '","did":"' + did + '","_p":"' + _p +
    '","_ln":"' + _ln + '","_ist":"' + _ist + '","_icr":"' + _icr +
    '","_is":"' + _is + '"}';

  const aesKey = sha256(Buffer.from(authKeyRaw.toString('base64'), 'utf8'));
  const iv     = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv);
  const ct     = Buffer.concat([cipher.update(Buffer.from(json, 'utf8')), cipher.final()]);
  return encodeURIComponent(Buffer.concat([iv, ct]).toString('base64'));
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
    // authKeyRaw: raw 32-byte Noise static public key required for bi encryption.
    // Falls back to fresh random bytes so the field ships even without the key.
    const authKeyRaw = (opts.authKeyRaw instanceof Buffer && opts.authKeyRaw.length === 32)
      ? opts.authKeyRaw
      : crypto.randomBytes(32);
    const ga = generateGaToken(authKeyRaw);

    // _gg: Play Integrity status.  When Frida supplies a real token, echo it back
    // with _ic=0.  Otherwise report _ic=1003 (not prepared) — an honest absence
    // rather than a missing field, which some server-side validators distinguish.
    const gg = a.gpia
      ? generateGgToken(authKeyRaw, 0,    a.gpia)
      : generateGgToken(authKeyRaw, 1003, 'undefined');

    const gp = generateGpToken();
    const gi = generateGiToken(authKeyRaw, opts.apkMaterial || null, device);
    _ok('_gs field generated (WASafe envelope, ' + gs.length + ' encoded chars)');
    if (gi) _ok('_gi field generated (' + gi.length + ' encoded chars)');
    return [
      'gpia',       orNull(a.gpia),
      '_gg',        gg,
      '_gi',        gi,
      '_gp',        gp,
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
