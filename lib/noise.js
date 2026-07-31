'use strict';

const net          = require('net');
const crypto       = require('crypto');
const EventEmitter = require('events');
const curveJs      = require('curve25519-js');
const { sha256 }   = require('@noble/hashes/sha256');
const { hkdf }     = require('@noble/hashes/hkdf');
const { MOBILE_PROLOGUE, WEB_PROLOGUE, WHATSAPP_HOST, WHATSAPP_PORT,
        platformForOs } = require('./constants');
const { encodeHandshakeClientHello, encodeHandshakeClientFinish,
        decodeServerHello, encodeClientPayload } = require('./proto');
const { dbg: _whaDbg } = require('./logger');
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

// ─── ClientPayload enum values ───────────────────────────────────────────────
//
// ClientPayload.ConnectType, ClientPayload.ConnectReason and
// ClientPayload.UserAgent.DeviceType. Named here because a bare number in the
// payload is exactly how this file came to announce a connect type that is not
// in the enum at all.
const CONNECT_TYPE_WIFI               = 1;  // WIFI_UNKNOWN
const CONNECT_REASON_USER_ACTIVATED   = 1;
const DEVICE_TYPE_PHONE               = 0;

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
  // The prologue is mixed into the handshake hash, so mobile and web produce
  // different transcripts from the first byte and a payload built for one
  // edition can never authenticate against the other.
  constructor(prologue) {
    // Noise spec: if protocol_name.length <= HASHLEN(32), h = protocol_name padded with zeros.
    // Do NOT hash — use the raw 32-byte name directly as the initial h and ck.
    const modeBytes = Buffer.from(NOISE_MODE, 'utf8'); // 'Noise_XX_25519_AESGCM_SHA256\0\0\0\0' = 32 bytes
    this.h       = modeBytes;
    this.ck      = Buffer.from(modeBytes);
    this.key     = null;  // single key for both enc+dec during handshake
    this.counter = 0;     // single counter for both encrypt+decrypt
    this.hash(prologue || MOBILE_PROLOGUE);
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
  /**
   * @param {object} store   session store
   * @param {object} [opts]
   *   transport      'mobile' (raw TLS to g.whatsapp.net) or 'web' (WebSocket
   *                  to web.whatsapp.com). Defaults to mobile — every existing
   *                  caller keeps its behaviour without passing anything.
   *   buildPayload   () => Buffer, replaces the mobile ClientPayload. Web mode
   *                  supplies the companion register/login payload here.
   *   expectSuccess  when false the connect() promise resolves as soon as the
   *                  channel is secured instead of waiting for <success>. A
   *                  companion that has not been paired yet never receives one:
   *                  the server replies with pair-device and waits for a human.
   */
  constructor(store, opts) {
    super();
    opts = opts || {};
    this.transport     = opts.transport === 'web' ? 'web' : 'mobile';
    this._buildPayload = opts.buildPayload || null;
    this._expectSuccess = opts.expectSuccess !== false;
    this._prologue     = this.transport === 'web' ? WEB_PROLOGUE : MOBILE_PROLOGUE;
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

      if (this.transport === 'web') {
        const { WebSocketStream } = require('./WebSocketStream');
        this.socket = new WebSocketStream().connect();
      } else {
        this.socket = net.createConnection({ host: WHATSAPP_HOST, port: WHATSAPP_PORT });
      }
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
    this.noiseState    = new NoiseState(this._prologue);
    const seed         = crypto.randomBytes(32);
    const kp           = curveJs.generateKeyPair(seed);
    this._ephemeralKeyPair = {
      private: Buffer.from(kp.private),
      public:  Buffer.from(kp.public)
    };
    this.noiseState.hash(this._ephemeralKeyPair.public);

    const helloPayload = encodeHandshakeClientHello(this._ephemeralKeyPair.public);
    const frame        = Buffer.concat([this._prologue, makeFrame(helloPayload)]);
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

      // Web mode hands us a finished companion payload; there is no phone
      // identity to derive anything from, and the fields below do not exist on
      // that side of the protocol.
      if (this._buildPayload) {
        const encPayload = this.noiseState.encryptWithAd(this._buildPayload());
        const finish     = encodeHandshakeClientFinish(encStatic, encPayload);
        this.socket.write(makeFrame(finish));

        const webKeys     = this.noiseState.split();
        this.writeKey     = webKeys.writeKey;
        this.readKey      = webKeys.readKey;
        this.writeCounter = 0;
        this.readCounter  = 0;
        this.secured      = true;

        if (this._expectSuccess) {
          this._awaitingAuth = true;
        } else {
          // An unpaired companion gets pair-device, not <success>. Hand the
          // caller a live channel and let the pairing flow drive from here.
          this._awaitingAuth = false;
          if (this._connectResolve) {
            this._connectResolve();
            this._connectResolve = null;
            this._connectReject  = null;
          }
          this.emit('secured');
        }
        return;
      }

      // Auto-derive MCC/MNC and locale from the registered phone number so the
      // ClientPayload userAgent is never sent with the telltale '000'/'000' values.
      const _phoneMeta  = getCountryMeta(parsePhone(this.store.phoneNumber).cc);
      const _device     = this.store.device || {};
      const _isAndroid  = String(_device.os).toLowerCase() === 'android';
      const _version    = process.env.WA_VERSION || this.store.version;

      this._announcedVersion    = _version;
      this._versionFromEnv      = !!process.env.WA_VERSION;
      this._sessionVersion      = this.store.version;
      _whaDbg('[DBG] ANNOUNCING version=' + _version +
        (this._versionFromEnv ? ' (from WA_VERSION, session holds ' +
          this.store.version + ')' : ' (from the session)') +
        ' platform=' + platformForOs(_device.os));

      const payload = encodeClientPayload({
        username:           BigInt(this.store.phoneNumber),
        passive:            false,
        pushName:           this.store.registered ? (this.store.name || null) : null,
        // The next four are constants in the reference client: it announces
        // shortConnect, WIFI_UNKNOWN, USER_ACTIVATED and attempt 0 on every
        // connect, retries included. ConnectType is a closed set — 0
        // CELLULAR_UNKNOWN, 1 WIFI_UNKNOWN, 100-112 for the named cellular
        // radios — and a reconnect used to send 3, which is not in it.
        shortConnect:       true,
        connectType:        CONNECT_TYPE_WIFI,
        connectReason:      CONNECT_REASON_USER_ACTIVATED,
        connectAttemptCount: 0,
        device:             0,
        oc:                 false,
        userAgent: {
          // Which client this says it is. The server checks the announced
          // version against *this* platform, so a wrong number here comes back
          // as 405 "client outdated" and never mentions the platform at all —
          // see PLATFORM in constants.js. Derived from `os` rather than read
          // out of the session, so a session file written before this was
          // corrected cannot keep announcing BlackBerry. ANDROID is 0, so the
          // old `|| 1` fallback would also have quietly turned every Android
          // session into an iOS one.
          platform:        platformForOs(_device.os),
          // The version the session was registered with, unless WA_VERSION says
          // otherwise. Without that override there is no way out of a 405: the
          // version lives in the session file, the server refuses it, and the
          // only remaining move is to register the number again — which is the
          // one thing that should never be the answer to a client-side problem.
          //
          // The override is also a way *into* a 405, and a quiet one: the CLI
          // reads .env before anything else, so a WA_VERSION left in that file
          // is announced by every connect from that directory while the session
          // file still holds a version the server would have accepted. Both are
          // remembered here so the failure can say which one went out.
          version:         _version,
          // Android announces no carrier and no locale of its own: the
          // reference client sends 000/000 and en/US on this platform and is
          // accepted, and this is the half that was being refused. iOS is
          // accepted as it is and keeps sending the real values.
          mcc:             _isAndroid ? '000' : _phoneMeta.mcc,
          mnc:             _isAndroid ? '000' : _phoneMeta.mnc,
          osVersion:       _device.osVersion,
          manufacturer:    _device.manufacturer,
          device:          _device.model,
          // Not sent on Android by the reference client, which describes the
          // handset with manufacturer and model alone. iOS does send it.
          osBuildNumber:   _isAndroid ? null : _device.osBuildNumber,
          // Uppercase on both platforms, even though the Android registration
          // sends the same id lowercase — that asymmetry is the reference
          // client's, not an oversight.
          phoneId:         this.store.fdid.toUpperCase(),
          releaseChannel:  0,
          localeLanguage:  _isAndroid ? 'en' : _phoneMeta.lg,
          localeCountry:   _isAndroid ? 'US' : _phoneMeta.lc,
          // DeviceType enum (field 15): PHONE. Every profile shipped here is a
          // phone — the numeric `deviceModelType` on the profiles is unrelated
          // to this and is read by nothing.
          deviceType:      DEVICE_TYPE_PHONE,
          deviceModelType: _device.modelId
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
          const reason = String(attrs.reason || attrs.location || '401');
          // Say what the code means. "auth failure: 401" sends people looking
          // for a bug in the client; the credentials were rejected by the
          // server, which is a different thing and has different remedies.
          //
          // WhatsApp publishes none of this, so the meanings below come from
          // observing the server. Codes marked "wipe" mean the session is
          // finished and retrying with it is pointless.
          const FAILURE = {
            '400': { wipe: false, text: 'generic failure.' },
            '401': { wipe: true,  text: 'logged out. The session was unpaired ' +
                     'server-side — nothing in the session file can revive it. ' +
                     'For a linked device this means it was removed under ' +
                     'Linked Devices; for a registered number it means the ' +
                     'registration was taken over, usually by verifying the ' +
                     'same number on the official app.' },
            '402': { wipe: false, text: 'temporarily banned.' },
            '403': { wipe: true,  text: "the account's primary device is gone " +
                     '— it is no longer a multi-device account.' },
            // Not a spent session, however much it looks like one. The server
            // declined the *client*: the version we announced is not one it
            // accepts. The registration behind the session is untouched, and
            // telling people to register again over this costs them a real
            // phone number for nothing — the same version would be announced
            // and refused identically. _handleFailure already reads it this way
            // once a session is up; this is the same code arriving during the
            // handshake, and it was the one path still calling it revoked.
            // Filled in below, where the version that actually went out is
            // known. Telling everyone to set WA_VERSION was wrong exactly when
            // it mattered most: a stale WA_VERSION is itself a way to get a 405,
            // and the advice then read as "fix it by doing more of the thing
            // that broke it".
            '405': { wipe: false, text: 'client outdated.' },
            '406': { wipe: true,  text: 'banned.' },
            '409': { wipe: true,  text: 'bad user agent — the client identified ' +
                     'itself in a way the server rejects.' },
            '413': { wipe: false, text: 'auth token expired.' },
            '414': { wipe: false, text: 'auth token invalid.' },
            '415': { wipe: false, text: 'not found.' },
            '500': { wipe: false, text: 'server error — worth retrying.' },
            '503': { wipe: false, text: 'service unavailable — worth retrying.' }
          };
          const info = FAILURE[reason];
          let detail = info ? info.text : '';

          // A refused client is a refused *version*, so name the one that went
          // out and say where it came from. Which of the two it was decides the
          // whole remedy, and the failure itself says neither.
          // The companion path builds its own payload and never sets these, so
          // it gets the short form rather than a sentence about undefined.
          if (reason === '405' && !this._announcedVersion) {
            detail += ' The server refused the version this connect announced.';
          } else if (reason === '405') {
            detail += ' The server refused the version this connect announced, ' +
              'which was ' + this._announcedVersion + '.';
            detail += this._versionFromEnv
              ? ' That value came from WA_VERSION in the environment — the CLI ' +
                'also reads it out of a .env file in the directory it runs from ' +
                '— while the session itself holds ' + this._sessionVersion +
                '. Unset WA_VERSION to announce the session\'s own version again.'
              : ' It came from the session file. Announce a current one with ' +
                'WA_VERSION, or on Android re-read it from the store with ' +
                '`wa apk-material --download`.';
            detail += ' Nothing about the session is wrong and there is nothing ' +
              'to re-register.';
          }

          const err = new Error('WhatsApp auth failure ' + reason +
            (detail ? ' — ' + detail : ''));
          err.code     = reason;
          // True when the session is spent and the caller should register or
          // link again rather than retry.
          err.loggedOut = !!(info && info.wipe);
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

      // A companion that connected unpaired resolves connect() early, so
      // <success> arrives here as an ordinary node once the link completes.
      // It still means the same thing, so it still opens the session.
      if (!this._expectSuccess && node && node.description === 'success') {
        this.emit('open', node);
        return;
      }

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
