'use strict';

// ─── The APNs courier stream ──────────────────────────────────────────────────
//
// What MCS is to an Android install, the courier is to an iPhone: one TLS
// connection to Apple that stays open for as long as the app is alive, over
// which every push arrives. WhatsApp's silent verification push is one of them,
// so a library that wants to read that code has to speak the same stream.
//
// The shape of it:
//
//   1. /bag           names the courier pool: a hostname and how many hosts are
//                     in it. A device picks one at random and dials
//                     "<n>-<hostname>:443".
//   2. TLS            with ALPN "apns-security-v3". The protocol name matters —
//                     it is what tells Apple the credentials ride in the first
//                     frame rather than in a TLS client certificate, which is
//                     how the older revision worked.
//   3. CONNECT/READY  the device presents its activation certificate and a
//                     signature over a fresh nonce; Apple answers with the
//                     device token that identifies it from here on.
//   4. FILTER         the topics (iOS bundle ids) this connection wants pushes
//                     for, as SHA-1 hashes.
//   5. GET_TOKEN      the per-topic token. This — not the device token — is
//                     what an app hands its server, and what goes into
//                     WhatsApp's registration body as push_token.
//
// Frames are a byte tag, a four-byte big-endian length, and a payload of
// fields. A field is a byte id, a two-byte big-endian length, and its bytes.
// A field id may repeat within one frame: that is how FILTER carries several
// topics, so fields are kept as a list of pairs on the way out and as a map of
// arrays on the way in. Collapsing them into a plain object would silently drop
// every topic but the last.

const tls = require('tls');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const { dbg: _whaDbg } = require('./logger');
const { proxyAgent, socksProxyUrl, socksConnect } = require('./socks');
const plist = require('./plist');

const BAG_HOST = 'init-p01st.push.apple.com';
const BAG_PATH = '/bag';
const COURIER_PORT = 443;
const COURIER_ALPN = 'apns-security-v3';

// The pool as it has been for years. Only used when /bag cannot be reached: a
// courier that answers is better than no push line at all, and these are the
// same values the bag hands back.
const DEFAULT_BAG = { hostCount: 50, hostname: 'courier.push.apple.com' };

const HTTP_TIMEOUT_MS = 15000;
const CONNECT_TIMEOUT_MS = 20000;
const REQUEST_TIMEOUT_MS = 30000;
// Far below Apple's idle cutoff, and far above a heartbeat that would look like
// a client stuck in a loop. A verification listen lasts minutes, not hours.
const KEEP_ALIVE_MS = 30000;

// ─── Frame tags ───────────────────────────────────────────────────────────────

const TAG = {
  CONNECT:         0x07,
  READY:           0x08,
  FILTER:          0x09,
  NOTIFICATION:    0x0a,
  ACK:             0x0b,
  KEEP_ALIVE:      0x0c,
  KEEP_ALIVE_ACK:  0x0d,
  NO_STORAGE:      0x0e,
  GET_TOKEN:       0x11,
  TOKEN_RESPONSE:  0x12,
  STATE:           0x14
};

// Field ids, named per frame because the same number means different things in
// different frames — 0x03 is the device token in READY and the payload in a
// NOTIFICATION.
const F_CONNECT_TOKEN     = 0x01;
const F_CONNECT_STATE     = 0x02;
const F_CONNECT_FLAGS     = 0x05;
const F_CONNECT_CERT      = 0x0c;
const F_CONNECT_NONCE     = 0x0d;
const F_CONNECT_SIGNATURE = 0x0e;

const F_READY_STATUS = 0x01;
const F_READY_TOKEN  = 0x03;

const F_NOTIFICATION_TOPIC   = 0x01;
const F_NOTIFICATION_PAYLOAD = 0x03;
const F_NOTIFICATION_ID      = 0x04;

const F_ACK_TOKEN  = 0x01;
const F_ACK_ID     = 0x04;
const F_ACK_STATUS = 0x08;

const F_GET_TOKEN_TOKEN = 0x01;
const F_GET_TOKEN_TOPIC = 0x02;
const F_GET_TOKEN_PAD   = 0x03;

const F_TOKEN_RESPONSE_TOKEN = 0x02;
const F_TOKEN_RESPONSE_TOPIC = 0x03;

// CONNECT flags, as a real client sends them. Opaque on the wire; kept as the
// literal four bytes rather than dressed up as a bitfield nobody can check.
const CONNECT_FLAGS = Buffer.from([0x00, 0x00, 0x00, 0x41]);
const CONNECT_STATE = Buffer.from([0x01]);

// ─── Framing ──────────────────────────────────────────────────────────────────

/**
 * Encode one frame.
 *
 * @param {number} tag     the frame tag
 * @param {Array<[number, Buffer]>} fields  id/value pairs, in wire order; an id
 *                                          may appear more than once
 * @returns {Buffer}
 */
function encodeFrame(tag, fields) {
  const parts = [];
  let payloadLength = 0;
  for (const [id, value] of fields) {
    if (value == null) continue;
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const header = Buffer.alloc(3);
    header[0] = id & 0xff;
    header.writeUInt16BE(buf.length, 1);
    parts.push(header, buf);
    payloadLength += 3 + buf.length;
  }
  const head = Buffer.alloc(5);
  head[0] = tag & 0xff;
  head.writeUInt32BE(payloadLength, 1);
  return Buffer.concat([head, ...parts], 5 + payloadLength);
}

/**
 * Decode a frame payload into its fields.
 *
 * Repeated ids accumulate, so `fields.get(id)` is always an array. `first` is
 * the reader for the ids that only ever appear once.
 *
 * @param {Buffer} payload
 * @returns {Map<number, Buffer[]>}
 */
function decodeFields(payload) {
  const fields = new Map();
  let offset = 0;
  while (offset + 3 <= payload.length) {
    const id = payload[offset];
    const length = payload.readUInt16BE(offset + 1);
    if (offset + 3 + length > payload.length) break;
    const value = payload.subarray(offset + 3, offset + 3 + length);
    if (fields.has(id)) fields.get(id).push(value);
    else fields.set(id, [value]);
    offset += 3 + length;
  }
  return fields;
}

function first(fields, id) {
  const values = fields.get(id);
  return values && values.length ? values[0] : null;
}

// ─── The bag ──────────────────────────────────────────────────────────────────
//
// Served signed rather than encrypted, which is why plain HTTP is the canonical
// URL. HTTPS is tried first anyway — it works, it is what a proxied session can
// route, and it costs one attempt. Every failure ends at DEFAULT_BAG.

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isTls = u.protocol === 'https:';
    const transport = isTls ? https : http;
    const agent = isTls ? proxyAgent() : null;

    const req = transport.request({
      hostname: u.hostname,
      port:     u.port || (isTls ? 443 : 80),
      path:     u.pathname + u.search,
      method:   'GET',
      headers:  { 'User-Agent': 'com.apple.ist.ds.appleconnect.web/1.0' },
      agent:    agent || undefined
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(HTTP_TIMEOUT_MS, () => req.destroy(new Error('timed out')));
    req.end();
  });
}

function parseBag(body) {
  const outer = plist.parse(body);
  const inner = plist.parse(outer.bag);
  const hostCount = Number(inner.APNSCourierHostcount);
  const hostname = String(inner.APNSCourierHostname || '');
  if (!hostname || !Number.isFinite(hostCount) || hostCount < 1) {
    throw new Error('bag has no courier pool');
  }
  return { hostCount, hostname };
}

/**
 * The courier pool, or the long-standing default when Apple cannot be asked.
 *
 * @returns {Promise<{hostCount: number, hostname: string}>}
 */
/**
 * Where to ask for the bag, in the order to try.
 *
 * Plain HTTP is the canonical URL and the one that actually answers: the bag is
 * signed rather than encrypted, and the host does not serve a certificate for
 * its own name — it presents one for images.apple.com, so HTTPS fails the
 * hostname check every time. It is tried second only in case that ever changes.
 *
 * With a proxy configured the order inverts and HTTP is dropped entirely: the
 * SOCKS agent is an https.Agent, so a plain-HTTP attempt would go out direct,
 * around the proxy the user set precisely so that nothing does. Losing the bag
 * costs nothing — the default pool below is the same answer it would have
 * given.
 *
 * @returns {string[]}
 */
function bagUrls() {
  if (socksProxyUrl()) return ['https://' + BAG_HOST + BAG_PATH];
  return ['http://' + BAG_HOST + BAG_PATH, 'https://' + BAG_HOST + BAG_PATH];
}

async function fetchBag() {
  for (const url of bagUrls()) {
    try {
      const res = await httpGet(url);
      if (res.status < 200 || res.status >= 300) throw new Error('HTTP ' + res.status);
      const bag = parseBag(res.body);
      _whaDbg('[DBG] APNs bag: ' + bag.hostCount + ' hosts at ' + bag.hostname);
      return bag;
    } catch (err) {
      _whaDbg('[DBG] APNs bag fetch failed (' + url + '): ' + (err && err.message));
    }
  }
  _whaDbg('[DBG] APNs bag unavailable — using the default courier pool');
  return Object.assign({}, DEFAULT_BAG);
}

// ─── Connection credentials ───────────────────────────────────────────────────

/** SHA-1 of a topic name — how the wire names an iOS bundle id. */
function topicHash(topic) {
  return crypto.createHash('sha1').update(String(topic), 'utf8').digest();
}

// 17 bytes: a zero, the current time in milliseconds, and eight random ones.
// Apple checks the timestamp is recent, which is what stops a captured
// signature from being replayed.
function createNonce() {
  const nonce = Buffer.alloc(17);
  nonce.writeBigUInt64BE(BigInt(Date.now()), 1);
  crypto.randomBytes(8).copy(nonce, 9);
  return nonce;
}

// The signature is prefixed with a two-byte version tag. Apple rejects the bare
// signature, so the tag is part of the field rather than framing around it.
const NONCE_SIGNATURE_TAG = Buffer.from([0x01, 0x01]);

function signNonce(privateKeyDer, nonce) {
  const key = crypto.createPrivateKey({ key: privateKeyDer, format: 'der', type: 'pkcs8' });
  return Buffer.concat([NONCE_SIGNATURE_TAG, crypto.sign('sha1', nonce, key)]);
}

// Apple hands the activation certificate back in whatever encoding it pleases
// (the activation record carries PEM); the courier wants DER. Round-tripping it
// through X509Certificate normalises both cases and rejects a corrupt one here,
// where the error still says what it is.
function certificateDer(certificate) {
  return new crypto.X509Certificate(certificate).raw;
}

// ─── The connection ───────────────────────────────────────────────────────────

class ApnsCourierConnection {
  /**
   * @param {object} session  { privateKeyDer, publicKeyDer, deviceCertificate, deviceToken? }
   *                          all Buffers; deviceToken is the one from a previous
   *                          connection, re-presented so Apple issues the same
   *                          one again
   * @param {object} [opts]   { topics, onNotification, onLost }
   */
  constructor(session, opts) {
    opts = opts || {};
    this.session = session;
    this.topics = Array.isArray(opts.topics) ? opts.topics.slice() : [];
    this.onNotification = typeof opts.onNotification === 'function' ? opts.onNotification : null;
    this.onLost = typeof opts.onLost === 'function' ? opts.onLost : null;

    this.socket = null;
    // Set by the TLS handshake. Until then nothing has been negotiated, and
    // assuming it had would put the interception note on failures that happen
    // before a socket exists at all.
    this.alpnNegotiated = true;
    this.deviceToken = session.deviceToken || null;
    // Set by the handshake when Apple hands back a device token other than the
    // one presented. False until then, including before any connection.
    this.tokenReissued = false;
    this.closed = false;
    this.buffer = Buffer.alloc(0);
    this.pending = [];
    this.keepAliveTimer = null;
  }

  // ── lifecycle ──

  async connect() {
    const bag = await fetchBag();
    // Host 0 does not exist; the pool is 1..hostCount.
    const index = 1 + Math.floor(Math.random() * Math.max(1, bag.hostCount - 1));
    const host = index + '-' + bag.hostname;

    _whaDbg('[DBG] APNs courier dialling ' + host);
    this.socket = await this._dial(host);
    this.socket.on('data', chunk => this._onData(chunk));
    this.socket.on('error', err => this._fail(err));
    this.socket.on('close', () => this._fail(new Error('courier connection closed')));

    try {
      await this._handshake();
      if (this.topics.length) this._sendFilter();
      this._startKeepAlive();
    } catch (err) {
      // A handshake that did not finish leaves a socket nobody will ever read
      // from. Callers do close on failure, but the connection should not depend
      // on them remembering to.
      this.close();
      // A failure on a connection that negotiated no ALPN is the signature of
      // TLS being terminated in the middle: the courier never saw the frame,
      // something else did and hung up. Worth naming, because the error on its
      // own reads like Apple refused the credentials.
      if (!this.alpnNegotiated) {
        err.message += ' (no ' + COURIER_ALPN + ' was negotiated, which is what' +
          ' a network that intercepts TLS looks like)';
      }
      throw err;
    }
    return this;
  }

  async _dial(host) {
    const proxyUrl = socksProxyUrl();
    const base = proxyUrl
      ? await socksConnect(proxyUrl, host, COURIER_PORT, CONNECT_TIMEOUT_MS)
      : null;

    return new Promise((resolve, reject) => {
      const options = {
        host,
        port: COURIER_PORT,
        servername: host,
        ALPNProtocols: [COURIER_ALPN],
        // The courier answers with a certificate from an Apple-internal issuer
        // that is in no public trust store, so chain validation cannot succeed
        // here and is not what protects this connection: the device proves
        // itself with a signature over a fresh nonce, and every push that
        // matters is a WhatsApp payload the registration server signs for
        // separately. Verification stays on for every other socket in the
        // library — this is the one endpoint that cannot use it.
        rejectUnauthorized: false
      };
      if (base) options.socket = base;

      const socket = tls.connect(options, () => {
        socket.setTimeout(0);
        socket.setNoDelay(true);
        // Whether the server echoed the ALPN name back. A middlebox that
        // terminates TLS — a corporate gateway, an inspecting proxy — echoes
        // nothing and then drops the connection the moment a frame that is not
        // HTTP goes out, so this is the single most useful thing to know when
        // the handshake below fails.
        //
        // It is recorded, not enforced. A server is free to accept the
        // protocol without echoing the extension, and refusing to speak to one
        // that does would turn a working connection into a failure for the
        // sake of a diagnostic. The handshake itself decides; this only
        // explains it afterwards.
        this.alpnNegotiated = socket.alpnProtocol === COURIER_ALPN;
        if (!this.alpnNegotiated) {
          _whaDbg('[DBG] APNs courier negotiated no ALPN (saw ' +
            JSON.stringify(socket.alpnProtocol) + ') — continuing anyway');
        }
        resolve(socket);
      });
      socket.setTimeout(CONNECT_TIMEOUT_MS, () => socket.destroy(new Error('courier connect timed out')));
      socket.once('error', reject);
    });
  }

  async _handshake() {
    const nonce = createNonce();
    const fields = [
      [F_CONNECT_STATE,     CONNECT_STATE],
      [F_CONNECT_FLAGS,     CONNECT_FLAGS],
      [F_CONNECT_CERT,      certificateDer(this.session.deviceCertificate)],
      [F_CONNECT_NONCE,     nonce],
      [F_CONNECT_SIGNATURE, signNonce(this.session.privateKeyDer, nonce)]
    ];
    // Presenting the previous device token asks Apple for the same one back.
    // It has to be the same one: the per-topic push token already handed to
    // WhatsApp is derived from it, and a new device token would leave that
    // push_token addressing a connection nobody is listening on.
    if (this.deviceToken) fields.unshift([F_CONNECT_TOKEN, this.deviceToken]);

    const ready = await this._exchange(TAG.CONNECT, fields,
      packet => packet.tag === TAG.READY);

    const status = first(ready.fields, F_READY_STATUS);
    if (!status || status.length === 0 || status[0] !== 0) {
      throw new Error('courier refused CONNECT: status=' +
        (status && status.length ? status[0] : 'none'));
    }

    const token = first(ready.fields, F_READY_TOKEN);
    if (!token) throw new Error('courier READY carried no device token');

    // A reissued device token invalidates every per-topic token derived from
    // the old one, including the push_token WhatsApp may already hold. Say so,
    // so the caller can drop what it cached rather than keep sending an address
    // nothing answers on.
    this.tokenReissued = Boolean(this.deviceToken && !this.deviceToken.equals(token));
    if (this.tokenReissued) {
      _whaDbg('[DBG] APNs device token was reissued — per-topic tokens have to be refetched');
    }
    this.deviceToken = Buffer.from(token);
    _whaDbg('[DBG] APNs courier connected');

    // Says the connection wants stored pushes delivered now. Without it a push
    // that arrived while the device was offline stays parked at Apple.
    this._send(TAG.STATE, [
      [0x01, Buffer.from([0x01])],
      [0x02, Buffer.from([0x7f, 0xff, 0xff, 0xff])]
    ]);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) { try { socket.destroy(); } catch (_) {} }
    this._rejectPending(new Error('courier closed'));
  }

  // ── requests ──

  /**
   * The push token for one topic, hex-encoded — the value a WhatsApp
   * registration carries as push_token.
   *
   * @param {string} topic  an iOS bundle id, e.g. net.whatsapp.WhatsApp
   * @returns {Promise<string>}
   */
  async requestToken(topic) {
    const hash = topicHash(topic);
    const packet = await this._exchange(TAG.GET_TOKEN, [
      [F_GET_TOKEN_TOKEN, this.deviceToken],
      [F_GET_TOKEN_TOPIC, hash],
      [F_GET_TOKEN_PAD,   Buffer.from([0x00, 0x00])]
    ], p => p.tag === TAG.TOKEN_RESPONSE &&
           (!first(p.fields, F_TOKEN_RESPONSE_TOPIC) ||
            first(p.fields, F_TOKEN_RESPONSE_TOPIC).equals(hash)));

    const token = first(packet.fields, F_TOKEN_RESPONSE_TOKEN);
    if (!token) throw new Error('courier TOKEN_RESPONSE carried no token');
    return token.toString('hex');
  }

  // FILTER is the subscription: one field 0x02 per topic, all in one frame.
  _sendFilter() {
    const fields = [[0x01, this.deviceToken]];
    for (const topic of this.topics) fields.push([0x02, topicHash(topic)]);
    this._send(TAG.FILTER, fields);
    _whaDbg('[DBG] APNs subscribed to ' + this.topics.join(', '));
  }

  _startKeepAlive() {
    this.keepAliveTimer = setInterval(() => {
      if (this.closed) return;
      try { this._send(TAG.KEEP_ALIVE, []); } catch (_) {}
    }, KEEP_ALIVE_MS);
    if (this.keepAliveTimer.unref) this.keepAliveTimer.unref();
  }

  // ── wire ──

  _send(tag, fields) {
    if (!this.socket) throw new Error('courier is not connected');
    this.socket.write(encodeFrame(tag, fields));
  }

  _exchange(tag, fields, match) {
    return new Promise((resolve, reject) => {
      const entry = {
        match,
        resolve,
        reject,
        timer: setTimeout(() => {
          this._drop(entry);
          reject(new Error('courier request timed out'));
        }, REQUEST_TIMEOUT_MS)
      };
      if (entry.timer.unref) entry.timer.unref();
      this.pending.push(entry);
      try {
        this._send(tag, fields);
      } catch (err) {
        this._drop(entry);
        clearTimeout(entry.timer);
        reject(err);
      }
    });
  }

  _drop(entry) {
    const index = this.pending.indexOf(entry);
    if (index >= 0) this.pending.splice(index, 1);
  }

  _rejectPending(err) {
    const waiting = this.pending.splice(0, this.pending.length);
    for (const entry of waiting) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
  }

  _fail(err) {
    if (this.closed) return;
    this.closed = true;
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
    _whaDbg('[DBG] APNs courier lost: ' + (err && err.message));
    const error = err instanceof Error ? err : new Error(String(err));
    this._rejectPending(error);
    // A listener waiting on a push has no other way to learn the line is gone,
    // and waiting out a three-minute timeout on a dead socket helps nobody.
    if (this.onLost) {
      try { this.onLost(error); } catch (_) {}
    }
  }

  _onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      if (this.buffer.length < 5) return;
      const length = this.buffer.readUInt32BE(1);
      if (this.buffer.length < 5 + length) return;
      const tag = this.buffer[0];
      const payload = this.buffer.subarray(5, 5 + length);
      this.buffer = this.buffer.subarray(5 + length);
      this._dispatch({ tag, fields: decodeFields(payload) });
    }
  }

  _dispatch(packet) {
    if (packet.tag === TAG.NOTIFICATION) {
      this._acknowledge(packet);
      if (this.onNotification) {
        try { this.onNotification(packet); } catch (_) {}
      }
    }
    for (const entry of this.pending) {
      let hit = false;
      try { hit = entry.match(packet); } catch (_) { hit = false; }
      if (hit) {
        this._drop(entry);
        clearTimeout(entry.timer);
        entry.resolve(packet);
        return;
      }
    }
  }

  // An unacknowledged push is redelivered on every reconnect, so this is not
  // politeness — it is what stops the same notification arriving forever.
  _acknowledge(packet) {
    const id = first(packet.fields, F_NOTIFICATION_ID);
    if (!id) return;
    try {
      this._send(TAG.ACK, [
        [F_ACK_TOKEN,  this.deviceToken],
        [F_ACK_ID,     id],
        [F_ACK_STATUS, Buffer.from([0x00])]
      ]);
    } catch (_) {}
  }
}

// ─── Reading the verification code out of a push ─────────────────────────────

/**
 * The WhatsApp verification code carried by a silent push, or null.
 *
 * The payload is JSON; WhatsApp files the code under "regcode". Anything else
 * on the stream — a message notification, a call, a payload that is not JSON at
 * all — reads as null and is simply not the push being waited for.
 *
 * @param {{fields: Map<number, Buffer[]>}} packet
 * @returns {string|null}
 */
function extractRegCode(packet) {
  const payload = first(packet.fields, F_NOTIFICATION_PAYLOAD);
  if (!payload) return null;
  try {
    const json = JSON.parse(payload.toString('utf8'));
    const code = json && json.regcode;
    return code ? String(code) : null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  ApnsCourierConnection,
  extractRegCode,
  fetchBag,
  bagUrls,
  parseBag,
  encodeFrame,
  decodeFields,
  first,
  topicHash,
  createNonce,
  certificateDer,
  TAG,
  DEFAULT_BAG,
  F_NOTIFICATION_TOPIC,
  F_NOTIFICATION_PAYLOAD,
  F_NOTIFICATION_ID
};
