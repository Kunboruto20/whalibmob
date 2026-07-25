'use strict';

//
// AttestationClient — Node.js consumer of the Frida device-attestation
// middleware shipped in `frida/`.
//
// WhatsApp's registration endpoints (/v2/exist, /v2/code, /v2/register) are
// gated by device attestation that only a genuine device can mint:
//
//   Android  — a Play Integrity verdict token (`gpia`) plus an Android Keystore
//              hardware-attested signature over the ENC body (`H=` + the
//              `Authorization` certificate chain).
//   iOS      — an Apple App Attest attestation/assertion pair.
//
// The scripts in `frida/` run on a rooted/jailbroken device and expose a local
// HTTP server (port 1119 = WhatsApp, 1120 = WhatsApp Business) that produces
// those tokens on demand. This module speaks that HTTP contract and maps the
// results into the exact registration wire shape Cobalt reproduces:
//
//   attestationFields(store) -> pairs injected INTO the encrypted body
//     Android: gpia,_gg,_gi,_gp,_ge,_ga (+ push_token)
//     iOS:     push_token only
//
//   attestBody(store, enc)   -> the `H=` suffix + `Authorization` header
//     Android: H = hex(signature),          Authorization = urlbase64(chain)
//     iOS:     H = {"assertion":"<b64>"},   Authorization = <b64 attestation>|<keyId>
//
// The whole layer is OFF unless WA_FRIDA_ATTESTATION is set, so default
// whalibmob behaviour is unchanged and the device is never contacted.
//

const http = require('http');
const crypto = require('crypto');

// ---------- base64 helpers ----------

function toBase64Url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

function toBase64UrlNoPad(buf) {
  return toBase64Url(buf).replace(/=+$/, '');
}

function fromBase64Url(str) {
  return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function toHex(buf) {
  return Buffer.from(buf).toString('hex');
}

// The noise public key is stored with a leading 0x05 Curve25519 type byte; the
// registration `authkey` field and the attestation nonce both use the raw
// 32-byte point, matching lib/Registration.js:stripKeyPrefix.
function stripKeyPrefix(buf) {
  if (buf && buf.length === 33 && buf[0] === 0x05) return buf.slice(1);
  return buf;
}

// ---------- HTTP to the on-device Frida server ----------

class FridaAttestor {
  /**
   * @param {object} [opts]
   * @param {string} [opts.host]     host of the Frida HTTP server (default 127.0.0.1)
   * @param {number} [opts.port]     1119 (WhatsApp) or 1120 (Business)
   * @param {number} [opts.timeout]  per-request timeout in ms (default 20000)
   * @param {boolean}[opts.optional] when true, unreachable server -> no attestation
   *                                 instead of throwing (default false)
   * @param {string} [opts.os]       'android' | 'ios' (default 'android')
   */
  constructor(opts = {}) {
    this.host = opts.host || '127.0.0.1';
    this.port = opts.port || 1119;
    this.timeout = opts.timeout || 20000;
    this.optional = !!opts.optional;
    this.os = (opts.os || 'android').toLowerCase();
  }

  // Low-level GET returning parsed JSON. The Frida servers always answer with a
  // JSON object; an `error` field signals a device-side failure.
  _get(path, query) {
    return new Promise((resolve, reject) => {
      const qs = query
        ? '?' + Object.entries(query)
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
            .join('&')
        : '';
      const req = http.get(
        { host: this.host, port: this.port, path: path + qs, timeout: this.timeout },
        (res) => {
          const chunks = [];
          res.on('data', (d) => chunks.push(d));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json;
            try { json = JSON.parse(text); }
            catch (_) { return reject(new Error(`Frida ${path}: non-JSON response: ${text.slice(0, 200)}`)); }
            if (json && json.error) return reject(new Error(`Frida ${path}: ${json.error}`));
            resolve(json);
          });
        }
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error(`Frida ${path}: timeout after ${this.timeout}ms`)));
    });
  }

  // GET /info — device/apk descriptor (Android only). Useful for diagnostics.
  getInfo() {
    return this._get('/info');
  }

  // GET /integrity?authKey=<...>
  //   Android -> { token }                    (Play Integrity verdict)
  //   iOS     -> { attestation, assertion }    (App Attest)
  getIntegrity(authKey) {
    return this._get('/integrity', { authKey });
  }

  // GET /cert?authKey=<pubkey b64>&enc=<ENC b64url>  (Android only)
  //   -> { signature, certificate }
  getCert(authKey, enc) {
    return this._get('/cert', { authKey, enc });
  }

  // The Play Integrity / App Attest request nonce. The Frida android server
  // re-encodes it (base64url-decode -> base64-no-pad) before setRequestHash, so
  // it must be passed base64url. Defaults to the raw noise public key, which is
  // stable per identity; override via WA_FRIDA_NONCE or by supplying store.fridaNonce.
  _nonce(store) {
    if (process.env.WA_FRIDA_NONCE) return process.env.WA_FRIDA_NONCE;
    if (store && store.fridaNonce) return store.fridaNonce;
    const pub = store && store.noiseKeyPair && store.noiseKeyPair.public;
    if (pub) return toBase64UrlNoPad(stripKeyPrefix(pub));
    // Last resort: a random nonce (still a valid attestation, just not identity-bound).
    return toBase64UrlNoPad(crypto.randomBytes(32));
  }

  // Handles the "optional" fallback uniformly: on failure either swallow (return
  // the supplied empty value) or rethrow, depending on this.optional.
  async _guard(promise, emptyValue, what) {
    try {
      return await promise;
    } catch (err) {
      if (this.optional) {
        process.stderr.write(`[FRIDA] ${what} failed (optional, continuing without it): ${err.message}\n`);
        return emptyValue;
      }
      throw new Error(
        `${what} failed: ${err.message}\n` +
        `  Is the Frida server running on ${this.host}:${this.port}? See frida/README.md.\n` +
        `  Set WA_FRIDA_OPTIONAL=1 to continue without attestation on failure.`
      );
    }
  }

  /**
   * Form fields injected INTO the encrypted registration body, before
   * encryption. Returns an array of alternating name/value pairs.
   *
   * Android: the Play Integrity sextuple. Only `gpia` is minted by the Frida
   *          server; `_gg/_gi/_gp/_ge/_ga` are the Gaia/Instance/PackageManager
   *          tokens the native client also sends and are left empty (matching
   *          Cobalt's frida-only setup).
   * iOS:     none here (App Attest rides entirely in H= + Authorization).
   */
  async attestationFields(store) {
    if (this.os === 'ios') return [];
    const nonce = this._nonce(store);
    const res = await this._guard(this.getIntegrity(nonce), null, 'Play Integrity token request');
    const gpia = res && res.token ? res.token : '';
    if (!gpia) return [];
    return [
      'gpia', gpia,
      '_gg', '',
      '_gi', '',
      '_gp', '',
      '_ge', '',
      '_ga', ''
    ];
  }

  /**
   * The body-attestation slots attached AFTER the `ENC=` envelope.
   * @param {object} store the registration store (for the pubkey/nonce)
   * @param {string} enc   the base64url ENC payload string
   * @returns {Promise<{h: string, authorization: (string|null)}|null>}
   */
  async attestBody(store, enc) {
    if (this.os === 'ios') return this._attestBodyIos(store, enc);
    return this._attestBodyAndroid(store, enc);
  }

  // Android: /cert signs the ENC bytes with the hardware-attested Keystore key.
  // Cobalt sends H= as the lowercase hex of the raw signature bytes and the
  // Authorization header as the url-base64 (no padding) certificate chain, so we
  // decode the server's encodings and re-encode to match that exact wire shape.
  async _attestBodyAndroid(store, enc) {
    const pub = store && store.noiseKeyPair && store.noiseKeyPair.public;
    const authKey = pub ? toBase64Url(stripKeyPrefix(pub)) : this._nonce(store);
    const res = await this._guard(this.getCert(authKey, enc), null, 'Keystore certificate request');
    if (!res || !res.signature) return null;
    const h = toHex(fromBase64Url(res.signature));
    const authorization = res.certificate
      ? toBase64UrlNoPad(Buffer.from(res.certificate, 'base64'))
      : null;
    return { h, authorization };
  }

  // iOS: the App Attest assertion is bound to SHA-256(enc). The Frida iOS server
  // exposes only /integrity, returning { attestation, assertion }; the keyId is
  // internal to the device, so we emit the assertion + attestation and leave the
  // keyId slot empty (documented limitation vs a real device that also sends it).
  async _attestBodyIos(store, enc) {
    const clientDataHash = crypto.createHash('sha256').update(Buffer.from(enc, 'utf8')).digest();
    const res = await this._guard(
      this.getIntegrity(clientDataHash.toString('base64')),
      null,
      'App Attest request'
    );
    if (!res || !res.assertion) return null;
    const h = JSON.stringify({ assertion: res.assertion });
    const keyId = res.keyId || '';
    const authorization = res.attestation ? `${res.attestation}|${keyId}` : null;
    return { h, authorization };
  }
}

// ---------- env factory ----------

// Returns a configured FridaAttestor when WA_FRIDA_ATTESTATION is truthy,
// otherwise null (attestation disabled -> zero overhead, default behaviour).
function getAttestorFromEnv(deviceOs) {
  const flag = process.env.WA_FRIDA_ATTESTATION;
  if (!flag || /^(0|false|no|off)$/i.test(flag)) return null;

  const os = (process.env.WA_OS || deviceOs || 'android').toLowerCase();
  let port = parseInt(process.env.WA_FRIDA_PORT, 10);
  if (!port) {
    // 1119 personal / 1120 business, chosen by WA_APP; default personal.
    port = /business|smb/i.test(process.env.WA_APP || '') ? 1120 : 1119;
  }
  return new FridaAttestor({
    host: process.env.WA_FRIDA_HOST || '127.0.0.1',
    port,
    timeout: parseInt(process.env.WA_FRIDA_TIMEOUT, 10) || 20000,
    optional: /^(1|true|yes|on)$/i.test(process.env.WA_FRIDA_OPTIONAL || ''),
    os
  });
}

module.exports = {
  FridaAttestor,
  getAttestorFromEnv,
  // exported for tests
  _internals: { toBase64Url, toBase64UrlNoPad, fromBase64Url, toHex, stripKeyPrefix }
};
