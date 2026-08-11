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

// ─── Server certificate validator ────────
//
// ServerHello.payload carries the certificate that authenticates the static
// Noise key the server presented in this handshake. Two shapes travel on the
// wire, and they do not share a Details layout:
//
//   flat NoiseCertificate — what a native mobile server returns
//     field1 details, field2 signature (64 bytes, by the root CA)
//     Details{ 1 serial, 2 issuer, 3 expires, 4 subject, 5 key }
//
//   CertChain — what a companion server returns
//     field1 leaf, field2 intermediate, each { 1 details, 2 signature }
//     Details{ 1 serial, 2 issuerSerial, 3 key, 4 notBefore, 5 notAfter }
//     the intermediate is signed by the root CA, the leaf by the intermediate
//
// Whichever shape arrives, two things decide whether the server is genuine:
// the signature must chain back to the root CA below, and the certified key
// must equal the static key from this handshake. That second check is the one
// that binds the certificate to this connection — a signature alone only
// proves the certificate is real, not that it belongs to whoever is talking.
// Neither check may be skipped, so every path out of here either validates or
// throws; there is no quiet return.
//
// All decoded manually to avoid a protobufjs dependency in noise.js.

// The root of trust. A certificate that does not chain back to this key did
// not come from WhatsApp.
const NOISE_ROOT_CA_PUBLIC_KEY = Buffer.from(
  '142375574d0a587166aae71ebe516437c4a28b73e3695c6ce1f7f9545da8ee6b', 'hex'
);

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
    } else if (wt === 5) {
      off.pos += 4; // no message here uses fixed32/fixed64, but stepping over
    } else if (wt === 1) {
      off.pos += 8; // one costs nothing and keeps later fields readable
    } else {
      break; // unexpected wire type — stop parsing
    }
  }
  return fields;
}

function _certFail(what) {
  throw new Error('WA server cert validation failed: ' + what);
}

function _certBytes(value, what) {
  if (!Buffer.isBuffer(value) || value.length === 0) _certFail('missing ' + what);
  return value;
}

// A public key travels either bare or behind the 0x05 Signal type byte. Accept
// both spellings so an encoding difference never reads as a forged key.
function _certKeyBytes(value, what) {
  const key = _certBytes(value, what);
  const bare = (key.length === 33 && key[0] === 0x05) ? key.slice(1) : key;
  if (bare.length !== 32) _certFail(what + ' is ' + bare.length + ' bytes, expected 32');
  return bare;
}

function _certVerifySignature(signerKey, details, signature, what) {
  const sig = _certBytes(signature, what + ' signature');
  if (sig.length !== 64) {
    _certFail(what + ' signature is ' + sig.length + ' bytes, expected 64');
  }
  if (!curveJs.verify(signerKey, details, sig)) {
    _certFail(what + ' has an invalid signature');
  }
}

// The certified key is what the rest of the handshake has been talking to.
function _certRequireBinding(certKey, serverStaticKey) {
  if (Buffer.compare(certKey, serverStaticKey) !== 0) {
    _certFail('certified key does not match the static key this server presented');
  }
}

// Flat NoiseCertificate: signed by the root CA, key in Details field 5.
function _validateFlatCert(cert, serverStaticKey) {
  const details = _certBytes(cert[1], 'certificate details');
  _certVerifySignature(NOISE_ROOT_CA_PUBLIC_KEY, details, cert[2], 'certificate');

  const det = _pbReadFields(details);
  _certRequireBinding(_certKeyBytes(det[5], 'certificate key'), serverStaticKey);
}

// CertChain: root CA signs the intermediate, the intermediate signs the leaf,
// and the leaf carries the key that must match the handshake.
function _validateCertChain(chain, serverStaticKey) {
  const intermediate = _pbReadFields(_certBytes(chain[2], 'intermediate certificate'));
  const intDetails   = _certBytes(intermediate[1], 'intermediate certificate details');
  _certVerifySignature(NOISE_ROOT_CA_PUBLIC_KEY, intDetails, intermediate[2],
    'intermediate certificate');

  const intDet = _pbReadFields(intDetails);
  if (intDet[2] !== undefined && intDet[2] !== 0) {
    _certFail('intermediate certificate was not issued by the root CA, issuerSerial=' + intDet[2]);
  }
  const intKey = _certKeyBytes(intDet[3], 'intermediate certificate key');

  const leaf       = _pbReadFields(_certBytes(chain[1], 'leaf certificate'));
  const leafDetail = _certBytes(leaf[1], 'leaf certificate details');
  _certVerifySignature(intKey, leafDetail, leaf[2], 'leaf certificate');

  const leafDet = _pbReadFields(leafDetail);
  if (leafDet[2] === undefined) _certFail('missing leaf certificate issuerSerial');
  if (intDet[1] === undefined)  _certFail('missing intermediate certificate serial');
  if (leafDet[2] !== intDet[1]) {
    _certFail('leaf certificate was not issued by the intermediate');
  }

  _certRequireBinding(_certKeyBytes(leafDet[3], 'leaf certificate key'), serverStaticKey);
}

// payloadBuf is the decrypted ServerHello.payload, serverStaticKey the static
// key decrypted out of the same ServerHello.
function validateServerCert(payloadBuf, serverStaticKey) {
  if (!Buffer.isBuffer(payloadBuf) || payloadBuf.length === 0) {
    _certFail('the server sent no certificate');
  }
  const staticKey = _certKeyBytes(serverStaticKey, 'server static key');
  const fields    = _pbReadFields(payloadBuf);

  // Tell the two shapes apart by what sits in field 2: a flat certificate keeps
  // its own 64-byte signature there, a chain keeps a whole nested certificate,
  // which is always longer. Reading it off the bytes rather than off the
  // transport means neither side can be validated against the wrong layout.
  const flat = Buffer.isBuffer(fields[1]) &&
               Buffer.isBuffer(fields[2]) &&
               fields[2].length === 64;

  if (flat) _validateFlatCert(fields, staticKey);
  else      _validateCertChain(fields, staticKey);
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

// A frame is a 3-byte big-endian length followed by that many bytes, and the
// wire is symmetric: what we write is shaped exactly like what we read below.
// The only thing that travels outside this framing is the handshake prologue,
// which the first frame is concatenated onto rather than wrapped in.
const FRAME_HEADER_SIZE = 3;
const MAX_FRAME_LENGTH  = 0xffffff; // what a 3-byte length can express

function makeFrame(payload) {
  const len = payload.length;
  if (len > MAX_FRAME_LENGTH) {
    // Silently truncating the length here would desync the stream for good.
    throw new Error('Frame length ' + len + ' exceeds ' + MAX_FRAME_LENGTH);
  }
  const header = Buffer.alloc(FRAME_HEADER_SIZE);
  header[0] = (len >>> 16) & 0xff;
  header[1] = (len >>>  8) & 0xff;
  header[2] =  len         & 0xff;
  return Buffer.concat([header, payload]);
}

function readFrameLength(data) {
  if (data.length < FRAME_HEADER_SIZE) return -1;
  return (data[0] << 16) | (data[1] << 8) | data[2];
}

// ─── Handshake trace ─────────────────────────────────────────────────────────
//
// The handshake runs before there are stanzas to log, so without this the debug
// output jumps from "connecting" to either a secured channel or an error with
// nothing in between — and when it fails, nothing to say which step it got to.
//
// Only public material is rendered: ephemeral and static public keys, frame and
// field sizes, certificate outcome. Derived session keys and anything private
// are named but never printed, because a debug trace is the thing people paste
// into a bug report.
function _hsKey(buf) {
  if (!Buffer.isBuffer(buf)) return String(buf);
  return buf.toString('hex') + ' (' + buf.length + 'B)';
}

function _hsSize(buf) {
  return Buffer.isBuffer(buf) ? buf.length + 'B' : 'absent';
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

      // Armed before the socket exists so it covers a SOCKS handshake that
      // never completes, not just a TCP one.
      this._connectTimeoutTimer = setTimeout(() => {
        if (this._connectReject) {
          const err = new Error('WA TCP connect timeout (20s)');
          this._connectReject(err);
          this._connectResolve = null;
          this._connectReject  = null;
        }
        try { if (this.socket) this.socket.destroy(); } catch (_) {}
      }, 20000);

      // `alreadyConnected` is the SOCKS case: the proxy hands back a socket
      // whose handshake is finished, so no 'connect' event will ever fire on
      // it and waiting for one would stall until the watchdog fires.
      const attach = (sock, alreadyConnected) => {
        this.socket = sock;
        // OS-level TCP keepalive: detects silently-dead NAT connections that
        // never send FIN/RST.
        sock.setKeepAlive(true, 15000);

        sock.on('data',  (data) => this._onData(data));
        sock.on('error', (err)  => this._onTcpError(err));
        sock.on('close', ()     => this._onTcpClose());

        const onUp = () => {
          clearTimeout(this._connectTimeoutTimer);
          this._connectTimeoutTimer = null;
          this._onTcpConnect();
        };
        if (alreadyConnected) onUp();
        else sock.on('connect', onUp);
      };

      if (this.transport === 'web') {
        const { WebSocketStream } = require('./WebSocketStream');
        attach(new WebSocketStream().connect(), false);
        return;
      }

      // Mobile is a raw TCP socket, and net.createConnection has no notion of
      // a proxy. Dial through SOCKS when one is configured so the mobile
      // transport is reachable from the same networks the web one is.
      const { socksProxyUrl, socksConnect } = require('./socks');
      const proxyUrl = socksProxyUrl();
      if (!proxyUrl) {
        attach(net.createConnection({ host: WHATSAPP_HOST, port: WHATSAPP_PORT }), false);
        return;
      }

      _whaDbg('[DBG] TCP via SOCKS proxy → ' + WHATSAPP_HOST + ':' + WHATSAPP_PORT);
      socksConnect(proxyUrl, WHATSAPP_HOST, WHATSAPP_PORT)
        .then(sock => attach(sock, true))
        .catch(err => {
          clearTimeout(this._connectTimeoutTimer);
          this._connectTimeoutTimer = null;
          this._onTcpError(err);
        });
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

    _whaDbg('[DBG] NOISE handshake begin  transport=' + this.transport +
      '  prologue=' + this._prologue.toString('hex') +
      '  pattern=Noise_XX_25519_AESGCM_SHA256');
    _whaDbg('[DBG] NOISE ──▶ ClientHello  ephemeral=' + _hsKey(this._ephemeralKeyPair.public));

    const helloPayload = encodeHandshakeClientHello(this._ephemeralKeyPair.public);
    const frame        = Buffer.concat([this._prologue, makeFrame(helloPayload)]);
    _whaDbg('[DBG] NOISE ──▶ ClientHello  ' + frame.length + 'B on the wire = prologue ' +
      this._prologue.length + 'B + header ' + FRAME_HEADER_SIZE + 'B + payload ' +
      helloPayload.length + 'B');
    this.socket.write(frame);
    _whaDbg('[DBG] NOISE     waiting for ServerHello');
  }

  _onData(data) {
    this._lastRxAt = Date.now();   // watchdog uses this to detect dead connections
    this.rxBuf = Buffer.concat([this.rxBuf, data]);
    this._processBuffer();
  }

  _processBuffer() {
    while (true) {
      if (this.rxBuf.length < FRAME_HEADER_SIZE) break;
      const frameLen = readFrameLength(this.rxBuf);
      if (this.rxBuf.length < FRAME_HEADER_SIZE + frameLen) break;
      const frame    = this.rxBuf.slice(FRAME_HEADER_SIZE, FRAME_HEADER_SIZE + frameLen);
      this.rxBuf     = this.rxBuf.slice(FRAME_HEADER_SIZE + frameLen);

      if (!this.secured) {
        this._handleHandshakeFrame(frame);
      } else {
        this._handleSecuredFrame(frame);
      }
    }
  }

  _handleHandshakeFrame(frame) {
    try {
      _whaDbg('[DBG] NOISE ◀── ServerHello  ' + frame.length + 'B frame');
      const serverHello = decodeServerHello(frame);
      _whaDbg('[DBG] NOISE ◀── ServerHello  ephemeral=' + _hsSize(serverHello.ephemeral) +
        '  static=' + _hsSize(serverHello.staticEnc) + ' encrypted' +
        '  certificate=' + _hsSize(serverHello.payload) + ' encrypted');
      if (!serverHello.ephemeral) throw new Error('No server ephemeral in ServerHello');
      _whaDbg('[DBG] NOISE ◀── server ephemeral=' + _hsKey(serverHello.ephemeral));

      this.noiseState.hash(serverHello.ephemeral);
      const sharedEE  = dhShared(this._ephemeralKeyPair.private, serverHello.ephemeral);
      this.noiseState.mixKey(sharedEE);
      _whaDbg('[DBG] NOISE     mixed DH(our ephemeral, server ephemeral)');

      const serverStaticDec = this.noiseState.decryptWithAd(serverHello.staticEnc);
      _whaDbg('[DBG] NOISE ◀── server static key decrypted=' + _hsKey(serverStaticDec));
      const sharedSE        = dhShared(this._ephemeralKeyPair.private, serverStaticDec);
      this.noiseState.mixKey(sharedSE);
      _whaDbg('[DBG] NOISE     mixed DH(our ephemeral, server static)');

      // The server is authenticated here, before ClientFinish hands it our
      // static key and payload. A ServerHello without a certificate leaves
      // nothing to authenticate it with, so it does not get that far.
      if (!serverHello.payload) {
        throw new Error('WA server cert validation failed: the server sent no certificate');
      }
      const certPlain = this.noiseState.decryptWithAd(serverHello.payload);
      _whaDbg('[DBG] NOISE ◀── certificate decrypted=' + certPlain.length + 'B — verifying');
      validateServerCert(certPlain, serverStaticDec);
      _whaDbg('[DBG] NOISE ◀── certificate verified: signed by the root CA and ' +
        'certifying the static key above — server authenticated');

      const noisePriv  = this.store.noiseKeyPair.private;
      // Send the raw 32-byte noise public key (no 0x05 Signal prefix)
      const noisePub   = stripKeyPrefix(this.store.noiseKeyPair.public);
      const encStatic  = this.noiseState.encryptWithAd(noisePub);
      _whaDbg('[DBG] NOISE ──▶ our static key=' + _hsKey(noisePub) +
        ' encrypted to ' + encStatic.length + 'B');
      const sharedSS   = dhShared(noisePriv, serverHello.ephemeral);
      this.noiseState.mixKey(sharedSS);
      _whaDbg('[DBG] NOISE     mixed DH(our static, server ephemeral)');

      // Web mode hands us a finished companion payload; there is no phone
      // identity to derive anything from, and the fields below do not exist on
      // that side of the protocol.
      if (this._buildPayload) {
        const encPayload = this.noiseState.encryptWithAd(this._buildPayload());
        const finish     = encodeHandshakeClientFinish(encStatic, encPayload);
        _whaDbg('[DBG] NOISE ──▶ ClientFinish  static=' + encStatic.length + 'B  payload=' +
          encPayload.length + 'B (companion)  ' + (finish.length + FRAME_HEADER_SIZE) +
          'B on the wire');
        this.socket.write(makeFrame(finish));

        const webKeys     = this.noiseState.split();
        this.writeKey     = webKeys.writeKey;
        this.readKey      = webKeys.readKey;
        this.writeCounter = 0;
        this.readCounter  = 0;
        this.secured      = true;
        _whaDbg('[DBG] NOISE     split() derived the send and receive keys — channel secured');

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
      const _reconnect  = (this.store.connectAttemptCount || 0) > 0;
      const _version    = process.env.WA_VERSION || this.store.version;

      this._announcedVersion    = _version;
      this._versionFromEnv      = !!process.env.WA_VERSION;
      this._sessionVersion      = this.store.version;
      _whaDbg('[DBG] ANNOUNCING version=' + _version +
        (this._versionFromEnv ? ' (from WA_VERSION, session holds ' +
          this.store.version + ')' : ' (from the session)') +
        ' platform=' + platformForOs(_device.os, _device.business));

      const payload = encodeClientPayload({
        username:           BigInt(this.store.phoneNumber),
        passive:            false,
        // A session starts out named "User" because the store needs something
        // there, not because the account is called that. Announcing it says the
        // account IS called "User", and the handshake runs on every connect, so
        // a name set while online was overwritten by the placeholder the moment
        // the connection came back. Send nothing until there is a real name —
        // the companion payload has always guarded this the same way.
        pushName:           (this.store.registered && this.store.name &&
                             this.store.name !== 'User') ? this.store.name : null,
        shortConnect:       _reconnect,
        // ConnectType is a closed set — 0 CELLULAR_UNKNOWN, 1 WIFI_UNKNOWN,
        // and 100-112 for the named cellular radios. There is no 3, which is
        // what every reconnect used to send. This is the only one of these
        // four that was wrong rather than merely different.
        connectType:        CONNECT_TYPE_WIFI,
        connectReason:      CONNECT_REASON_USER_ACTIVATED,
        connectAttemptCount: (this.store.connectAttemptCount || 0),
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
          platform:        platformForOs(_device.os, _device.business),
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
          // The real carrier and locale, derived from the number, on both
          // platforms. Other clients send 000/000 and en/US here, and the
          // server accepts a session either way — this was tried against it
          // both ways and neither is refused. 000/000 is what a handset with
          // no SIM reports, so a number with a carrier behind it saying so is
          // the more ordinary thing to be, which is why this library picked
          // the real values in the first place.
          mcc:             _phoneMeta.mcc,
          mnc:             _phoneMeta.mnc,
          osVersion:       _device.osVersion,
          manufacturer:    _device.manufacturer,
          device:          _device.model,
          osBuildNumber:   _device.osBuildNumber,
          phoneId:         this.store.fdid.toUpperCase(),
          releaseChannel:  0,
          localeLanguage:  _phoneMeta.lg,
          localeCountry:   _phoneMeta.lc,
          // DeviceType enum (field 15): PHONE. Every profile shipped here is a
          // phone — the numeric `deviceModelType` on the profiles is unrelated
          // to this and is read by nothing.
          deviceType:      DEVICE_TYPE_PHONE,
          deviceModelType: _device.modelId
        }
      });

      const encPayload = this.noiseState.encryptWithAd(payload);
      const finish     = encodeHandshakeClientFinish(encStatic, encPayload);
      _whaDbg('[DBG] NOISE ──▶ ClientFinish  static=' + encStatic.length + 'B  payload=' +
        encPayload.length + 'B (username=' + this.store.phoneNumber + ' version=' +
        _version + ')  ' + (finish.length + FRAME_HEADER_SIZE) + 'B on the wire');
      this.socket.write(makeFrame(finish));

      const keys        = this.noiseState.split();
      this.writeKey     = keys.writeKey;
      this.readKey      = keys.readKey;
      this.writeCounter = 0;
      this.readCounter  = 0;
      _whaDbg('[DBG] NOISE     split() derived the send and receive keys — channel secured');
      _whaDbg('[DBG] NOISE     waiting for the server to accept the payload');
      this.secured      = true;

      // Wait for the server's <success> or <failure> confirmation before
      // declaring the channel open. _processBuffer() will call
      // _handleSecuredFrame() for the next frame, which handles auth.
      this._awaitingAuth = true;

    } catch (err) {
      // The step that failed is the one after the last line traced above.
      _whaDbg('[DBG] NOISE ✗ handshake failed: ' + (err && err.message));
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
        _whaDbg('[DBG] NOISE ◀── <' + tag + '> — the first frame over the secured channel, ' +
          'and the server\'s answer on the payload');

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
