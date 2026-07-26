'use strict';

// ─── Device attestation client ────────────────────────────────────────────────
//
// Talks to the on-device Frida attestation server shipped in ./frida (Android
// Play Integrity / Keystore attestation, iOS App Attest) and folds its output
// into the registration request, mirroring how Auties00/cobalt consumes the
// same scripts.
//
// Design (matches Cobalt's LinkedWhatsAppClientDeviceAttestor):
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

const DEFAULT_PORT   = 1119;   // WhatsApp consumer; Business build listens on 1120
const REQUEST_TIMEMS = 15000;

// ─── Empty (NONE) fallbacks ───────────────────────────────────────────────────

const EMPTY_ANDROID = { gpia: '', gg: '', gi: '', gp: '', ge: '', ga: '' };
const EMPTY_IOS     = { attestation: '', assertion: '', keyId: '' };
const EMPTY_BODY    = { bodyAttestation: null, authorizationHeader: null };

function fridaHost() {
  return process.env.WA_FRIDA_HOST || null;
}

function fridaPort() {
  return parseInt(process.env.WA_FRIDA_PORT, 10) || DEFAULT_PORT;
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

function fridaGet(pathname, query) {
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
      { host, port: fridaPort(), path: pathname + qs, method: 'GET', timeout: REQUEST_TIMEMS },
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
// Queries /integrity?authKey=<nonce>. The Frida server returns { token }, which
// becomes the Play Integrity verdict token (gpia). The _gg/_gi/_gp/_ge/_ga GMS
// legs are only produced by the full native attestor, so a Frida-only setup
// leaves them empty — the server accepts a gpia-only attestation.
//
// nonceB64 is the URL-safe base64 request nonce (see attestationFieldsAndroid).
async function androidIntegrity(nonceB64) {
  if (!isEnabled()) return { ...EMPTY_ANDROID };
  const res = await fridaGet('/integrity', { authKey: nonceB64 });
  if (!res || !res.token) return { ...EMPTY_ANDROID };
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
async function androidAttestBody(encB64, authKeyB64) {
  if (!isEnabled()) return { ...EMPTY_BODY };
  const encParam = Buffer.from(encB64, 'utf8').toString('base64');
  const res = await fridaGet('/cert', { authKey: authKeyB64, enc: encParam });
  if (!res || !res.signature || !res.certificate) return { ...EMPTY_BODY };
  return { bodyAttestation: res.signature, authorizationHeader: res.certificate };
}

// ─── Android: device /info (apk hashes / signature / secret key) ──────────────
async function androidInfo() {
  if (!isEnabled()) return null;
  return fridaGet('/info');
}

// ─── iOS: App Attest (attestation + assertion + keyId) ────────────────────────
//
// Queries /integrity?authKey=<clientDataHashB64>. The Frida server returns
// { attestation, assertion }; the keyId is generated per call on-device and
// echoed by the server when available. clientDataHash is the base64 of the
// Noise public key (the server SHA-256-hashes it internally).
async function iosAppAttest(noisePubB64) {
  if (!isEnabled()) return { ...EMPTY_IOS };
  const res = await fridaGet('/integrity', { authKey: noisePubB64 });
  if (!res || !res.attestation || !res.assertion) return { ...EMPTY_IOS };
  return {
    attestation: res.attestation,
    assertion:   res.assertion,
    keyId:       res.keyId || ''
  };
}

// ─── High-level: attestation fields shipped on every attested endpoint ────────
//
// Returns the alternating name/value pairs Cobalt ships via attestationFields():
//   Android → gpia,_gg,_gi,_gp,_ge,_ga,push_token
//   iOS     → push_token
//
// These fields are part of the plaintext that gets AES-GCM-sealed into the
// ENC envelope, so the Play Integrity nonce is derived from the store (a stable
// per-session value), NOT from the ENC body. pushToken comes from the optional
// push client — empty by default.
async function attestationFields(device, nonceB64, opts) {
  opts = opts || {};
  const pushToken = opts.pushToken || '';

  if (device && device.os === 'android') {
    const a = await androidIntegrity(nonceB64 || '');
    return [
      'gpia',       a.gpia,
      '_gg',        a.gg,
      '_gi',        a.gi,
      '_gp',        a.gp,
      '_ge',        a.ge,
      '_ga',        a.ga,
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
    return androidAttestBody(encB64, keys.noisePubB64 || '');
  }
  const data = await iosAppAttest(keys.noisePubB64 || '');
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
