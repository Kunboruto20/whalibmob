'use strict';

const net          = require('net');
const crypto       = require('crypto');
const EventEmitter = require('events');
const curveJs      = require('curve25519-js');
const { sha256 }   = require('@noble/hashes/sha256');
const { hkdf }     = require('@noble/hashes/hkdf');
const { MOBILE_PROLOGUE, WHATSAPP_HOST, WHATSAPP_PORT } = require('./constants');
const { encodeHandshakeClientHello, encodeHandshakeClientFinish,
        decodeServerHello, encodeClientPayload } = require('./proto');
const { parsePhone, getCountryMeta } = require('./Registration');

// ─── CertChain validator ────────
//
// Server payload inside ServerHello is a CertChain protobuf:
//   CertChain.field2 (intermediate) → NoiseCertificate
//     NoiseCertificate.field1 (details) → NoiseCertificate.Details
//       Details.field2 (issuerSerial) must === 0
//
// All decoded manually to avoid a protobufjs dependency in noise.js.

function _pbReadVarint(buf, off) {
  let v = 0, shift = 0;
  while (off.pos < buf.length) {
    const b = buf[off.pos++];
    v |= (b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7;
  }
  return v;
}

function _pbReadFields(buf) {
  const fields = {};
  const off = { pos: 0 };
  while (off.pos < buf.length) {
    const tag = _pbReadVarint(buf, off);
    const fn  = tag >>> 3;
    const wt  = tag & 7;
    if (wt === 0) {
      fields[fn] = _pbReadVarint(buf, off);
    } else if (wt === 2) {
      const len = _pbReadVarint(buf, off);
      fields[fn] = buf.slice(off.pos, off.pos + len);
      off.pos += len;
    } else {
      break; // unexpected wire type — stop parsing
    }
  }
  return fields;
}

function validateServerCert(payloadBuf) {
  // payloadBuf is the decrypted ServerHello.payload (CertChain protobuf)
  const chain        = _pbReadFields(payloadBuf);
  const intermediate = chain[2]; // field 2 = intermediate NoiseCertificate
  if (!Buffer.isBuffer(intermediate)) return; // no intermediate cert — skip
  const cert    = _pbReadFields(intermediate);
  const details = cert[1]; // field 1 = details bytes
  if (!Buffer.isBuffer(details)) return;
  const det          = _pbReadFields(details);
  const issuerSerial = det[2]; // field 2 = issuerSerial (uint32)
  if (issuerSerial !== undefined && issuerSerial !== 0) {
    throw new Error('WA server cert validation failed: issuerSerial=' + issuerSerial + ' expected 0');
  }
}

// ─── Curve25519 DH helpers ───────────────────────────────────────────────────

function stripKeyPrefix(pub) {
  if (pub.length === 33 && pub[0] === 0x05) return pub.slice(1);
  if (pub.length === 32) return pub;
  throw new Error('Invalid DH public key length: ' + pub.length);
}

function dhShared(privKey32, pubKey) {
  return Buffer.from(curveJs.sharedKey(privKey32, stripKeyPrefix(pubKey)));
}

// ─── Noise_XX_25519_AESGCM_SHA256 ────────────────────────────────────────────

const NOISE_MODE = 'Noise_XX_25519_AESGCM_SHA256\0\0\0\0';

function hash256(data) {
  return Buffer.from(sha256(data));
}

function aesgcmEncrypt(key, counter, plaintext, aad) {
  const iv = Buffer.alloc(12);
  iv.writeBigUInt64BE(BigInt(counter), 4);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(aad);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([enc, tag]);
}

function aesgcmDecrypt(key, counter, ciphertext, aad) {
  const iv  = Buffer.alloc(12);
  iv.writeBigUInt64BE(BigInt(counter), 4);
  const tag  = ciphertext.slice(ciphertext.length - 16);
  const data = ciphertext.slice(0, ciphertext.length - 16);
  const dec  = crypto.createDecipheriv('aes-256-gcm', key, iv);
  dec.setAuthTag(tag);
  if (aad) dec.setAAD(aad);
  return Buffer.concat([dec.update(data), dec.final()]);
}

function deriveHkdf(salt, ikm, length) {
  return Buffer.from(hkdf(sha256, ikm, salt, new Uint8Array(0), length));
}

class NoiseState {
  constructor() {
    // Noise spec: if protocol_name.length <= HASHLEN(32), h = protocol_name padded with zeros.
    // Do NOT hash — use the raw 32-byte name directly as the initial h and ck.
    const modeBytes = Buffer.from(NOISE_MODE, 'utf8'); // 'Noise_XX_25519_AESGCM_SHA256\0\0\0\0' = 32 bytes
    this.h       = modeBytes;
    this.ck      = Buffer.from(modeBytes);
    this.key     = null;  // single key for both enc+dec during handshake
    this.counter = 0;     // single counter for both encrypt+decrypt
    this.hash(MOBILE_PROLOGUE);
  }

  hash(data) {
    this.h = hash256(Buffer.concat([this.h, data]));
  }

  mixKey(dhResult) {
    const derived = deriveHkdf(this.ck, dhResult, 64);
    this.ck      = derived.slice(0, 32);
    this.key     = derived.slice(32, 64);
    this.counter = 0;
  }

  encryptWithAd(plaintext) {
    const ciphertext = aesgcmEncrypt(this.key, this.counter++, plaintext, this.h);
    this.hash(ciphertext);
    return ciphertext;
  }

  decryptWithAd(ciphertext) {
    const plaintext = aesgcmDecrypt(this.key, this.counter++, ciphertext, this.h);
    this.hash(ciphertext);
    return plaintext;
  }

  split() {
    const derived = deriveHkdf(this.ck, Buffer.alloc(0), 64);
    return {
      writeKey: derived.slice(0, 32),
      readKey:  derived.slice(32, 64)
    };
  }
}

// ─── Frame helpers ────────────────────────────────────────────────────────────

// writeRequestHeader: writes 6 bytes (4 for upper part + 2 for lower).
// Used for ALL outgoing frames (client → server).
function makeFrame(payload) {
  const len    = payload.length;
  const header = Buffer.alloc(6);
  const mss    = len >> 16;
  header[0] = (mss >> 24) & 0xff;
  header[1] = (mss >> 16) & 0xff;
  header[2] = (mss >>  8) & 0xff;
  header[3] =  mss        & 0xff;
  const lss    = len & 0xffff;
  header[4] = (lss >> 8) & 0xff;
  header[5] =  lss       & 0xff;
  return Buffer.concat([header, payload]);
}

// messageLengthBuffer: always 3 bytes (server → client).
function readFrameLength(data) {
  if (data.length < 3) return -1;
  return (data[0] << 16) | (data[1] << 8) | data[2];
}

// ─── NoiseSocket ─────────────────────────────────────────────────────────────
//
// Events emitted:
//   'open'        — handshake complete, channel secured
//   'node'(node)  — received a decoded BinaryNode
//   'close'       — TCP connection closed
//   'error'(err)  — an error occurred
//
class NoiseSocket extends EventEmitter {
  constructor(store) {
    super();
    this.store        = store;
    this.socket       = null;
    this.noiseState   = null;
    this.writeKey     = null;
    this.readKey      = null;
    this.writeCounter = 0;
    this.readCounter  = 0;
    this.connected    = false;
    this.secured      = false;
    this._awaitingAuth = false;  // true after ClientFinish sent, before server <success>/<failure>
    this.rxBuf        = Buffer.alloc(0);
    this._ephemeralKeyPair = null;
    this._lastRxAt           = Date.now();   // updated on every TCP data received
    this._connectTimeoutTimer = null;         // cleared once TCP connect fires
  }

  connect() {
    return new Promise((resolve, reject) => {
      this._connectResolve = resolve;
      this._connectReject  = reject;

      this.socket = net.createConnection({ host: WHATSAPP_HOST, port: WHATSAPP_PORT });
      // OS-level TCP keepalive: detects silently-dead NAT connections that never send FIN/RST
      this.socket.setKeepAlive(true, 15000);
      // Connect-phase watchdog: abort if TCP handshake takes >20s
      this._connectTimeoutTimer = setTimeout(() => {
        if (this._connectReject) {
          const err = new Error('WA TCP connect timeout (20s)');
          this._connectReject(err);
          this._connectResolve = null;
          this._connectReject  = null;
        }
        try { this.socket.destroy(); } catch (_) {}
      }, 20000);
      this.socket.on('connect', () => {
        clearTimeout(this._connectTimeoutTimer);
        this._connectTimeoutTimer = null;
        this._onTcpConnect();
      });
      this.socket.on('data',    (data) => this._onData(data));
      this.socket.on('error',   (err)  => this._onTcpError(err));
      this.socket.on('close',   ()     => this._onTcpClose());
    });
  }

  _onTcpConnect() {
    this.connected = true;
    this._startHandshake();
  }

  _startHandshake() {
    this.noiseState    = new NoiseState();
    const seed         = crypto.randomBytes(32);
    const kp           = curveJs.generateKeyPair(seed);
    this._ephemeralKeyPair = {
      private: Buffer.from(kp.private),
      public:  Buffer.from(kp.public)
    };
    this.noiseState.hash(this._ephemeralKeyPair.public);

    const helloPayload = encodeHandshakeClientHello(this._ephemeralKeyPair.public);
    const frame        = Buffer.concat([MOBILE_PROLOGUE, makeFrame(helloPayload)]);
    this.socket.write(frame);
  }

  _onData(data) {
    this._lastRxAt = Date.now();   // watchdog uses this to detect dead connections
    this.rxBuf = Buffer.concat([this.rxBuf, data]);
    this._processBuffer();
  }

  _processBuffer() {
    while (true) {
      if (this.rxBuf.length < 3) break;
      const frameLen = readFrameLength(this.rxBuf);
      if (this.rxBuf.length < 3 + frameLen) break;
      const frame    = this.rxBuf.slice(3, 3 + frameLen);
      this.rxBuf     = this.rxBuf.slice(3 + frameLen);

      if (!this.secured) {
        this._handleHandshakeFrame(frame);
      } else {
        this._handleSecuredFrame(frame);
      }
    }
  }

  _handleHandshakeFrame(frame) {
    try {
      const serverHello = decodeServerHello(frame);
      if (!serverHello.ephemeral) throw new Error('No server ephemeral in ServerHello');

      this.noiseState.hash(serverHello.ephemeral);
      const sharedEE  = dhShared(this._ephemeralKeyPair.private, serverHello.ephemeral);
      this.noiseState.mixKey(sharedEE);

      const serverStaticDec = this.noiseState.decryptWithAd(serverHello.staticEnc);
      const sharedSE        = dhShared(this._ephemeralKeyPair.private, serverStaticDec);
      this.noiseState.mixKey(sharedSE);

      if (serverHello.payload) {
        const certPlain = this.noiseState.decryptWithAd(serverHello.payload);
        validateServerCert(certPlain);
      }

      const noisePriv  = this.store.noiseKeyPair.private;
      // Send the raw 32-byte noise public key (no 0x05 Signal prefix)
      const noisePub   = stripKeyPrefix(this.store.noiseKeyPair.public);
      const encStatic  = this.noiseState.encryptWithAd(noisePub);
      const sharedSS   = dhShared(noisePriv, serverHello.ephemeral);
      this.noiseState.mixKey(sharedSS);

      // Auto-derive MCC/MNC and locale from the registered phone number so the
      // ClientPayload userAgent is never sent with the telltale '000'/'000' values.
      const _phoneMeta  = getCountryMeta(parsePhone(this.store.phoneNumber).cc);

      const payload = encodeClientPayload({
        username:           BigInt(this.store.phoneNumber),
        passive:            false,
        pushName:           this.store.registered ? (this.store.name || null) : null,
        shortConnect:       (this.store.connectAttemptCount || 0) > 0,
        connectType:        (this.store.connectAttemptCount || 0) > 0 ? 3 : 1,
        connectReason:      1,
        connectAttemptCount: (this.store.connectAttemptCount || 0),
        device:             0,
        oc:                 false,
        userAgent: {
          platform:        (this.store.device && this.store.device.platform) || 1,
          version:         this.store.version,
          mcc:             _phoneMeta.mcc,
          mnc:             _phoneMeta.mnc,
          osVersion:       this.store.device.osVersion,
          manufacturer:    this.store.device.manufacturer,
          device:          this.store.device.model,
          osBuildNumber:   this.store.device.osBuildNumber,
          phoneId:         this.store.fdid.toUpperCase(),
          releaseChannel:  0,
          localeLanguage:  _phoneMeta.lg,
          localeCountry:   _phoneMeta.lc,
          deviceType:      0,
          deviceModelType: this.store.device.modelId
        }
      });

      const encPayload = this.noiseState.encryptWithAd(payload);
      const finish     = encodeHandshakeClientFinish(encStatic, encPayload);
      this.socket.write(makeFrame(finish));

      const keys        = this.noiseState.split();
      this.writeKey     = keys.writeKey;
      this.readKey      = keys.readKey;
      this.writeCounter = 0;
      this.readCounter  = 0;
      this.secured      = true;

      // Wait for the server's <success> or <failure> confirmation before
      // declaring the channel open. _processBuffer() will call
      // _handleSecuredFrame() for the next frame, which handles auth.
      this._awaitingAuth = true;

    } catch (err) {
      if (this._connectReject) {
        this._connectReject(err);
        this._connectResolve = null;
        this._connectReject  = null;
      }
      this.emit('error', err);
    }
  }

  _handleSecuredFrame(frame) {
    try {
      const plain = aesgcmDecrypt(this.readKey, this.readCounter++, frame, null);
      const { decodeNode } = require('./BinaryNode');
      const node  = decodeNode(plain);

      // ── Auth confirmation from server ─────────────────────────────────────
      // The very first secured frame must be <success> or <failure>.
      // Only after <success> do we resolve the connect() promise and emit 'open'.
      if (this._awaitingAuth) {
        this._awaitingAuth = false;
        const tag = node && node.description;

        if (tag === 'success') {
          if (this._connectResolve) {
            this._connectResolve();
            this._connectResolve = null;
            this._connectReject  = null;
          }
          // Pass the full success node so Client can extract ADV identity,
          // platform, expiration, and other server-provided account info.
          this.emit('open', node);
          return;
        }

        if (tag === 'failure') {
          const attrs  = (node && node.attrs) || {};
          const reason = attrs.reason || attrs.location || '401';
          const err    = new Error('WhatsApp auth failure: ' + reason);
          err.code     = reason;
          if (this._connectReject) {
            this._connectReject(err);
            this._connectResolve = null;
            this._connectReject  = null;
          }
          this.emit('error', err);
          return;
        }

        // Unexpected first node — log it as an error but try to continue
        const err = new Error('Unexpected first server node after handshake: ' + tag);
        if (this._connectReject) {
          this._connectReject(err);
          this._connectResolve = null;
          this._connectReject  = null;
        }
        this.emit('error', err);
        return;
      }
      // ─────────────────────────────────────────────────────────────────────

      this.emit('node', node);
    } catch (err) {
      this.emit('error', err);
    }
  }

  sendNode(node) {
    if (!this.secured) throw new Error('Channel not secured — handshake incomplete');
    const { encodeNode } = require('./BinaryNode');
    const plain      = encodeNode(node);
    const ciphertext = aesgcmEncrypt(this.writeKey, this.writeCounter++, plain, null);
    this.socket.write(makeFrame(ciphertext));
  }

  _onTcpError(err) {
    clearTimeout(this._connectTimeoutTimer);
    this._connectTimeoutTimer = null;
    if (this._connectReject) {
      this._connectReject(err);
      this._connectResolve = null;
      this._connectReject  = null;
    }
    this.emit('error', err);
  }

  _onTcpClose() {
    clearTimeout(this._connectTimeoutTimer);
    this._connectTimeoutTimer = null;
    this.connected = false;
    this.secured   = false;
    // If the TCP connection closed while the WA handshake was still in progress,
    // the Promise returned by connect() would hang forever — reject it now.
    if (this._connectReject) {
      this._connectReject(new Error('WA TCP closed during handshake'));
      this._connectResolve = null;
      this._connectReject  = null;
    }
    this.emit('close');
  }

  close() {
    if (this.socket) {
      try { this.socket.destroy(); } catch (_) {}
      this.socket = null;
    }
  }
}

module.exports = { NoiseSocket };
