'use strict';
//
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
// bi    AES-256-CBC (key = SHA256(standard base64 of the auth key), random IV
//       prepended) over the base64 of 32 random bytes: 88 base64 characters
// ap    age of base.apk in seconds — the install is hours to days old and
//       independent of (always older than) ai: a real phone had the app long
//       before it re-registered
// ai    age of the oldest file in the data directory — the session's own setup,
//       minutes to several hours
// ae    age of the oldest file in the external files directory, a little
//       younger than ai (tens of seconds to ~30 minutes)
// mp/mu monkey-test flags, false on a device a person is using
//
// The ages model a fresh install, drawn per request: fixed numbers would be
// the same on every registration this library makes, which no phone does.
// The inner JSON object of _ga, without percent-encoding. Shared between the
// registration _ga parameter (which percent-encodes this) and the login
// integrity_payload (which embeds the object verbatim). The slashes inside `bi`
// are escaped here; the integrity_payload builder escapes its other values
// around this fragment and leaves bi as-is, matching the live blob.
function buildGaInner(authKeyRaw) {
  const aesKey    = sha256(Buffer.from(authKeyRaw.toString('base64'), 'utf8'));
  const plaintext = Buffer.from(crypto.randomBytes(32).toString('base64'), 'utf8');
  const iv        = crypto.randomBytes(16);
  const cipher    = crypto.createCipheriv('aes-256-cbc', aesKey, iv);
  const ct        = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const bi        = Buffer.concat([iv, ct]).toString('base64').replace(/\//g, '\\/');

  // A live client was observed sending ap≈4 days ≫ ai≈5.5 h > ae (ai − ~26 min).
  // The earlier model made ap≈ai, which no real install shows: base.apk predates
  // the data directory by far more than a few minutes.
  const ai = 600 + crypto.randomInt(28800);                   // 10 min .. 8 h
  const ap = ai + 3600 + crypto.randomInt(864000);            // ai + 1 h .. +10 d
  const ae = Math.max(1, ai - (30 + crypto.randomInt(1771))); // ai − 30 s .. 30 min

  return '{"bi":"' + bi + '","ap":' + ap + ',"ai":' + ai + ',"mp":false,"ae":' + ae + ',"mu":false}';
}

function generateGaToken(authKeyRaw) {
  return encodeURIComponent(buildGaInner(authKeyRaw));
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

// ─── Integrity envelope shared by _gg and _gi ────────────────────────────────
// AES-256-CBC, key = SHA256(standard base64 of the 32-byte auth key), a random
// 16-byte IV prepended to the ciphertext, then standard base64.
function integrityEnvelope(authKeyRaw, json) {
  const aesKey = sha256(Buffer.from(authKeyRaw.toString('base64'), 'utf8'));
  const iv     = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv);
  const ct     = Buffer.concat([cipher.update(Buffer.from(json, 'utf8')), cipher.final()]);
  return encodeURIComponent(Buffer.concat([iv, ct]).toString('base64'));
}

// ─── _gg: Play Integrity status ──────────────────────────────────────────────
// {"_ic": N, "_it": "<token>"}
//   _ic — 0 on success, 1003 when the provider is not prepared (no GMS)
//   _it — the Play Integrity token, or the literal "undefined" on error
function generateGgToken(authKeyRaw, icCode, itToken) {
  const json = '{"_ic":' + icCode + ',"_it":"' + String(itToken).replace(/\//g, '\\/') + '"}';
  return integrityEnvelope(authKeyRaw, json);
}

// ─── _gp: SHA-256 of the manifest permission list ────────────────────────────
// Base64 SHA-256 of the sorted, separator-less permission names, percent-encoded
// on the wire. Computed from the installed APK's own manifest (material.gpHash)
// so it tracks the version — that is always preferred when a real APK is loaded.
// When no material hash is available (a headless run, or a build read without
// the manifest permissions), WA_GP_HASH overrides the fallback for a specific
// version, and otherwise GP_DEFAULT is sent: the value a live current client was
// observed sending. The previous known value for 2.26.35.75+ on Android 12
// (85 permissions) was 'XpccAx8EKQswlTL2MtpCnGIMXTCaUbAf95ElLECc6jk='.
const GP_DEFAULT = 'q19gmaQaITVtyoBCdLsD7CiZKryGA9zltE8yTd30NdI=';

function gpHashValue(material) {
  return (material && material.gpHash) ||
    (process.env.WA_GP_HASH && process.env.WA_GP_HASH.trim()) ||
    GP_DEFAULT;
}

function generateGpToken(material) {
  return encodeURIComponent(gpHashValue(material));
}

// ─── _lh: hash of the native library from nativeLibraryDir ────────────────────
// _lh = base64(SHA-256(<nativeLibraryDir>/libwhatsapp.so)). It appears only
// inside the login integrity_payload (never in the registration _gi), new in
// 2.26.37.73. A headless client has no nativeLibraryDir to read — modern builds
// ship the libraries in the superpack and leave that directory empty — so the
// exact on-device file cannot be observed here. The value is taken, in order,
// from the extracted APK material (AndroidApk hashes libwhatsapp.so out of the
// APK, which matches the device on extractNativeLibs=true builds and is the best
// candidate otherwise), the WA_LH_HASH override, or the documented per-version
// candidate for libwhatsapp.so (2.26.35.75). This mirrors how _gp falls back
// when no manifest hash is available.
const LH_DEFAULT = 'euEs+17faTS6Mt7WHjzn7spB95xywNpuimy0sWbyuME=';

function lhHashValue(material) {
  const m = material && material.nativeLibSha256;
  if (m) return Buffer.isBuffer(m) ? m.toString('base64') : m;
  return (process.env.WA_LH_HASH && process.env.WA_LH_HASH.trim()) || LH_DEFAULT;
}

// ─── _gi: installation integrity ─────────────────────────────────────────────
// Ten keys, in this order:
//   _dh  SHA256(classes.dex of base.apk)
//   _iln SHA256 of the sorted .so names the app unpacks under its data
//        directory (files/decompressed/libs.spo); fixed per package, below
//   _isb size of base.apk in bytes, as a string
//   _ip  package name
//   did  Build.ID + "." + Build.VERSION.INCREMENTAL
//   _p   ApplicationInfo.sourceDir, the installed base.apk path
//   _ln  SHA256 of the names in nativeLibraryDir; that directory is empty on
//        current builds, so the app hashes its fallback string "signal_error"
//   _ist SHA256(first 10 MiB of base.apk)
//   _icr SHA1(DER signing certificate)
//   _is  SHA256(base.apk)
// Values are standard base64 with '/' written as '\/'. Returns null when the
// material predates these hashes, so the field is omitted instead of faked.
const GI_ILN = {
  'com.whatsapp':     'i7ls4vAnG2Bvmsp8NDKh7uREGcY4q8Hi4JtdCLix+Cc=',
  'com.whatsapp.w4b': 'Mw3rbAdtB9wUHE6w9vpff27e6I9/ruCa555vkJXh+N4='
};
const GI_LN = crypto.createHash('sha256').update('signal_error').digest('base64');

// install: { did, sourceDir } — the firmware string and the base.apk path of
// the install this session claims to be.
function generateGiToken(authKeyRaw, material, install) {
  if (!material || !material.classesDexSha256 || material.apkSize == null ||
      !material.apkSha256Full || !material.apkSha256First10M ||
      !material.certificates || !material.certificates.length ||
      !install || !install.did || !install.sourceDir) {
    return null;
  }
  const pkg = material.packageName || 'com.whatsapp';
  const iln = GI_ILN[pkg];
  if (!iln) return null;

  const esc = (s) => String(s).replace(/\//g, '\\/');
  const b64 = (buf) => esc(buf.toString('base64'));

  const json = '{' +
    '"_dh":"'  + b64(material.classesDexSha256)  + '",' +
    '"_iln":"' + esc(iln)                        + '",' +
    '"_isb":"' + String(material.apkSize)        + '",' +
    '"_ip":"'  + esc(pkg)                        + '",' +
    '"did":"'  + esc(install.did)                + '",' +
    '"_p":"'   + esc(install.sourceDir)          + '",' +
    '"_ln":"'  + esc(GI_LN)                      + '",' +
    '"_ist":"' + b64(material.apkSha256First10M) + '",' +
    '"_icr":"' + b64(crypto.createHash('sha1').update(material.certificates[0]).digest()) + '",' +
    '"_is":"'  + b64(material.apkSha256Full)     + '"' +
  '}';
  return integrityEnvelope(authKeyRaw, json);
}

// ─── Post-login integrity_payload ─────────────────────────────────────────────
// The blob the client hands over in <ib><integrity_payload> after the first
// login, in response to the server's <ib><safetynet><integrity nonce='…'>. It is
// the same AES-256-CBC envelope as the registration _gi (key
// SHA256(std-base64(authkey)), IV‖ciphertext, PKCS7), but the plaintext JSON has
// a fixed, wider key order and nests _ge and _ga as objects rather than as the
// separate percent-encoded parameters they are at registration:
//
//   aid, _dh, _lh, _iln, _ln, _ge, _gp, _ga, _ip, _isb, _n, _icr, _is
//
// _n echoes the server's safetynet nonce in plaintext inside the envelope, which
// binds the blob to the request. The result is standard base64 (not URL-safe,
// not percent-encoded): it is the text content of the <integrity_payload> node.
//
// Returns null when the material/identity needed to build a faithful blob is
// missing, so the caller sends nothing rather than a half-formed envelope.
function generateIntegrityPayload(opts) {
  opts = opts || {};
  const { material, aid, serverNonce } = opts;
  const authKeyRaw = (Buffer.isBuffer(opts.authKeyRaw) && opts.authKeyRaw.length === 32)
    ? opts.authKeyRaw : null;
  if (!authKeyRaw || !aid || !serverNonce) return null;
  if (!material || !material.classesDexSha256 || material.apkSize == null ||
      !material.apkSha256Full || !material.certificates || !material.certificates.length) {
    return null;
  }
  const pkg = material.packageName || 'com.whatsapp';
  const iln = GI_ILN[pkg];
  if (!iln) return null;

  const esc = (s) => String(s).replace(/\//g, '\\/');
  const b64 = (buf) => esc(buf.toString('base64'));

  const json = '{' +
    '"aid":"'  + esc(aid)                        + '",' +
    '"_dh":"'  + b64(material.classesDexSha256)  + '",' +
    '"_lh":"'  + esc(lhHashValue(material))      + '",' +
    '"_iln":"' + esc(iln)                        + '",' +
    '"_ln":"'  + esc(GI_LN)                      + '",' +
    '"_ge":'   + '{"sb":false,"sv":false}'       + ',' +
    '"_gp":"'  + esc(gpHashValue(material))      + '",' +
    '"_ga":'   + buildGaInner(authKeyRaw)        + ',' +
    '"_ip":"'  + esc(pkg)                        + '",' +
    '"_isb":"' + String(material.apkSize)        + '",' +
    '"_n":"'   + esc(serverNonce)                + '",' +
    '"_icr":"' + b64(crypto.createHash('sha1').update(material.certificates[0]).digest()) + '",' +
    '"_is":"'  + b64(material.apkSha256Full)     + '"' +
  '}';

  const aesKey = sha256(Buffer.from(authKeyRaw.toString('base64'), 'utf8'));
  const iv     = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv);
  const ct     = Buffer.concat([cipher.update(Buffer.from(json, 'utf8')), cipher.final()]);
  return Buffer.concat([iv, ct]).toString('base64');
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
    // The envelope key comes from the Noise static public key; a random one
    // still yields a well-formed field when the caller has no key to give.
    const authKeyRaw = (Buffer.isBuffer(opts.authKeyRaw) && opts.authKeyRaw.length === 32)
      ? opts.authKeyRaw
      : crypto.randomBytes(32);
    const ga = opts.ga || generateGaToken(authKeyRaw);
    const gg = a.gpia
      ? generateGgToken(authKeyRaw, 0, a.gpia)
      : generateGgToken(authKeyRaw, 1003, 'undefined');
    const gp = generateGpToken(opts.apkMaterial || null);
    const gi = generateGiToken(authKeyRaw, opts.apkMaterial || null, opts.install || null);
    _ok('_gs field generated (WASafe envelope, ' + gs.length + ' encoded chars)');
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
  generateGaToken,
  generateIntegrityPayload,
  toHex,
  toBase64Url,
  EMPTY_ANDROID,
  EMPTY_IOS,
  EMPTY_BODY
};
