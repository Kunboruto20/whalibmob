'use strict';

// MCS — the long-lived Firebase connection that carries WhatsApp's verification
// code as a silent push, so a number can be registered without an SMS.
//
// The push token from lib/fcm.js is the address; this is the mailbox. WhatsApp
// sends the six-digit code as a data message over Firebase Cloud Messaging, and
// the only way to receive it is to hold a connection open to Google's MCS
// endpoint and speak its binary protocol — the same one every Android phone
// keeps running in the background.
//
// The wire format, tag for tag, is WhatsApp's own client's:
//
//   connect TLS to mtalk.google.com:5228
//   → write one version byte (41), then a LoginRequest frame
//   ← read one version byte, then a LoginResponse frame
//   then frames both ways: [tag:1][length:varint][protobuf payload]
//
//   tags: 0 heartbeat-ping  1 heartbeat-ack  2 login-request
//         3 login-response  4 close          7 iq  8 data-message
//
// The code rides on a data-message whose appData carries a
// key="registration_code". Everything else — heartbeats, iqs, acks — is
// bookkeeping that keeps the stream alive long enough to receive it.
//
// This mirrors Cobalt's FcmMcsConnection. Where Cobalt uses virtual threads and
// a generated protobuf runtime, this uses the event loop and a hand-written
// codec for the handful of messages involved; the bytes on the wire are the
// same.
//
// Nothing here is reachable without a push token, and the whole path is
// optional: registration falls back to SMS whenever any of it fails.

const tls    = require('tls');
const { dbg: _whaDbg } = require('./logger');

const MCS_HOST = 'mtalk.google.com';
const MCS_PORT = 5228;
const MCS_VERSION = 41;

const TAG_HEARTBEAT_PING   = 0;
const TAG_HEARTBEAT_ACK    = 1;
const TAG_LOGIN_REQUEST    = 2;
const TAG_LOGIN_RESPONSE   = 3;
const TAG_CLOSE            = 4;
const TAG_IQ_STANZA        = 7;
const TAG_DATA_MESSAGE     = 8;

// Ten minutes, matching the native client. Google closes an idle stream, and a
// ping well inside its window keeps it open without chattering.
const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000;

// The last N persistent ids are echoed on the next login so the server does not
// redeliver messages already seen. A short buffer is enough for a code fetch.
const PERSISTENT_ID_BUFFER = 50;

// The appData key WhatsApp files the verification code under.
const PUSH_CODE_APP_DATA_KEY = 'registration_code';

// ─── minimal protobuf codec ──────────────────────────────────────────────────

function encodeVarint(value) {
  let v = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
  if (v < 0n) v += 1n << 64n;
  const out = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return Buffer.from(out);
}

const pbTag  = (field, wire) => encodeVarint((field << 3) | wire);
const pbInt  = (field, n) => Buffer.concat([pbTag(field, 0), encodeVarint(n)]);
function pbStr(field, s) {
  const b = Buffer.from(String(s), 'utf8');
  return Buffer.concat([pbTag(field, 2), encodeVarint(b.length), b]);
}
function pbMsg(field, buf) {
  return Buffer.concat([pbTag(field, 2), encodeVarint(buf.length), buf]);
}

// Read a protobuf message into { field: value | [values] }. Length-delimited
// fields come back as Buffers, varints as BigInt, so a 64-bit id never loses
// precision. Repeated fields collect into arrays.
function pbDecode(buf) {
  const out = {};
  let i = 0;
  const put = (f, v) => {
    if (out[f] === undefined) out[f] = v;
    else if (Array.isArray(out[f])) out[f].push(v);
    else out[f] = [out[f], v];
  };
  const varint = () => {
    let r = 0n, s = 0n;
    while (i < buf.length) { const b = buf[i++]; r |= BigInt(b & 0x7f) << s; s += 7n; if (!(b & 0x80)) break; }
    return r;
  };
  while (i < buf.length) {
    const key = Number(varint()), field = key >> 3, wire = key & 7;
    if (wire === 0) put(field, varint());
    else if (wire === 2) { const n = Number(varint()); put(field, buf.slice(i, i + n)); i += n; }
    else if (wire === 1) { i += 8; }
    else if (wire === 5) { i += 4; }
    else break;
  }
  return out;
}

// ─── message builders ────────────────────────────────────────────────────────

function buildLoginRequest(session) {
  const androidId = String(session.androidId);
  const setting = Buffer.concat([pbStr(1, 'new_vc'), pbStr(2, '1')]);

  const parts = [
    pbStr(1, 'android-30'),                            // id
    pbStr(2, 'mcs.android.com'),                       // domain
    pbStr(3, androidId),                               // user
    pbStr(4, androidId),                               // resource
    pbStr(5, String(session.securityToken)),           // authToken
    pbStr(6, 'android-' + BigInt(androidId).toString(16)), // deviceId
    pbMsg(8, setting)                                   // settings[0]
  ];
  for (const pid of (session.persistentIds || [])) parts.push(pbStr(10, pid));
  // adaptiveHeartbeat (12) is false → omitted. Then:
  parts.push(pbInt(14, 1));   // useRmq2 = true
  parts.push(pbInt(16, 2));   // authService = 2
  parts.push(pbInt(17, 1));   // networkType = 1
  return Buffer.concat(parts);
}

const buildHeartbeatAck  = streamId => pbInt(2, streamId);          // lastStreamIdReceived
const buildHeartbeatPing = streamId => pbInt(2, streamId);

function frame(tag, payload) {
  const len = encodeVarint(payload.length);
  return Buffer.concat([Buffer.from([tag]), len, payload]);
}

// ─── connection ──────────────────────────────────────────────────────────────

/**
 * Open MCS, log in, and resolve with the verification code the moment it
 * arrives — or null on timeout or any failure. Never throws.
 *
 * The connection must be established before the /code request is sent, or the
 * push can arrive with nowhere to land; callers open this first and request the
 * code once `onReady` has fired.
 *
 * @param {object} session   { androidId, securityToken, persistentIds? } from lib/fcm
 * @param {object} [opts]    { timeoutMs=180000, onReady, signal }
 * @returns {Promise<string|null>}
 */
function receivePushCode(session, opts) {
  opts = opts || {};
  const timeoutMs = opts.timeoutMs > 0 ? opts.timeoutMs : 180000;

  return new Promise((resolve) => {
    if (!session || !session.androidId || !session.securityToken) {
      _whaDbg('[DBG] MCS no android id — cannot receive push code');
      return resolve(null);
    }

    let settled = false;
    let socket = null;
    let heartbeat = null;
    let deadline = null;
    let rx = Buffer.alloc(0);
    let sawVersion = false;
    let loggedIn = false;
    let streamId = 0;
    const persistentIds = Array.isArray(session.persistentIds) ? session.persistentIds : [];

    const finish = (code) => {
      if (settled) return;
      settled = true;
      if (heartbeat) clearInterval(heartbeat);
      if (deadline)  clearTimeout(deadline);
      try { if (socket) socket.destroy(); } catch (_) {}
      resolve(code);
    };

    deadline = setTimeout(() => {
      if (!settled) { _whaDbg('[DBG] MCS timed out after ' + timeoutMs + 'ms'); finish(null); }
    }, timeoutMs);

    if (opts.signal) {
      if (opts.signal.aborted) return finish(null);
      opts.signal.addEventListener('abort', () => finish(null), { once: true });
    }

    const write = (tag, payload) => {
      try { socket.write(frame(tag, payload)); } catch (e) {
        _whaDbg('[DBG] MCS write failed: ' + (e && e.message)); finish(null);
      }
    };

    // Route MCS through the SOCKS agent's dialer when one is set, so a proxied
    // process reaches Google here too. Loaded lazily to avoid a cycle.
    const { socksProxyUrl, socksConnect } = require('./socks');
    const proxyUrl = socksProxyUrl();

    const onRaw = (rawSocket) => {
      socket = tls.connect({
        socket:     rawSocket || undefined,
        host:       MCS_HOST,
        port:       MCS_PORT,
        servername: MCS_HOST
      }, () => {
        // version byte first, then the login frame
        try {
          socket.write(Buffer.from([MCS_VERSION]));
          socket.write(frame(TAG_LOGIN_REQUEST, buildLoginRequest({
            androidId: session.androidId, securityToken: session.securityToken, persistentIds
          })));
          _whaDbg('[DBG] MCS connected, login sent');
        } catch (e) { _whaDbg('[DBG] MCS login write failed: ' + (e && e.message)); finish(null); }
      });

      socket.setNoDelay(true);
      socket.on('data', onData);
      socket.on('error', (e) => { _whaDbg('[DBG] MCS socket error: ' + (e && e.message)); finish(null); });
      socket.on('close', () => { if (!settled) { _whaDbg('[DBG] MCS closed'); finish(null); } });
    };

    if (proxyUrl) {
      _whaDbg('[DBG] MCS dialing via SOCKS proxy');
      socksConnect(proxyUrl, MCS_HOST, MCS_PORT)
        .then(onRaw)
        .catch(e => { _whaDbg('[DBG] MCS proxy dial failed: ' + (e && e.message)); finish(null); });
    } else {
      onRaw(null);
    }

    function onData(chunk) {
      rx = Buffer.concat([rx, chunk]);

      // The server's first byte is its protocol version, once, before any frame.
      if (!sawVersion) {
        if (rx.length < 1) return;
        _whaDbg('[DBG] MCS server version=' + rx[0]);
        rx = rx.slice(1);
        sawVersion = true;
      }

      // Drain whole frames. A varint length that runs past the buffer means the
      // rest is still in flight — wait for more.
      for (;;) {
        if (rx.length < 1) return;
        const tag = rx[0];

        let len = 0, shift = 0n, p = 1, complete = false;
        for (; p < rx.length && p <= 10; p++) {
          const b = rx[p];
          len |= (b & 0x7f) << Number(shift);
          shift += 7n;
          if (!(b & 0x80)) { p++; complete = true; break; }
        }
        if (!complete) return;                 // length varint not fully here yet
        if (rx.length < p + len) return;       // payload not fully here yet

        const payload = rx.slice(p, p + len);
        rx = rx.slice(p + len);
        handleFrame(tag, payload);
        if (settled) return;
      }
    }

    function handleFrame(tag, payload) {
      if (!loggedIn) {
        if (tag !== TAG_LOGIN_RESPONSE) {
          _whaDbg('[DBG] MCS expected login response, got tag=' + tag); return finish(null);
        }
        const resp = pbDecode(payload);
        if (resp[3]) {                                    // error info present
          const err = pbDecode(resp[3]);
          _whaDbg('[DBG] MCS login refused code=' + (err[1] && err[1].toString()));
          return finish(null);
        }
        loggedIn = true;
        streamId = 1;
        _whaDbg('[DBG] MCS logged in — waiting for push code');
        heartbeat = setInterval(() => write(TAG_HEARTBEAT_PING, buildHeartbeatPing(streamId)),
          HEARTBEAT_INTERVAL_MS);
        if (typeof opts.onReady === 'function') { try { opts.onReady(); } catch (_) {} }
        return;
      }

      streamId++;

      switch (tag) {
        case TAG_DATA_MESSAGE: {
          const code = extractCode(payload, persistentIds);
          if (code) { _whaDbg('[DBG] MCS push code received'); return finish(code); }
          break;
        }
        case TAG_HEARTBEAT_PING:
          write(TAG_HEARTBEAT_ACK, buildHeartbeatAck(streamId));
          break;
        case TAG_HEARTBEAT_ACK:
        case TAG_IQ_STANZA:
          break;
        case TAG_CLOSE:
          _whaDbg('[DBG] MCS server requested close'); return finish(null);
        default:
          _whaDbg('[DBG] MCS unknown tag ' + tag + ' (' + payload.length + 'b)');
      }
    }
  });
}

// Pull the verification code out of a data-message stanza, and remember its
// persistent id so a reconnect does not ask for it again.
//
//   field 9  persistentId (string)
//   field 7  appData, repeated { 1: key, 2: value }
function extractCode(payload, persistentIds) {
  const stanza = pbDecode(payload);

  const pid = stanza[9];
  if (pid && pid.length) {
    persistentIds.push(pid.toString('utf8'));
    if (persistentIds.length > PERSISTENT_ID_BUFFER) {
      persistentIds.splice(0, persistentIds.length - PERSISTENT_ID_BUFFER);
    }
  }

  let appData = stanza[7];
  if (!appData) return null;
  if (!Array.isArray(appData)) appData = [appData];

  for (const entry of appData) {
    const kv = pbDecode(entry);
    const key = kv[1] ? kv[1].toString('utf8') : '';
    if (key === PUSH_CODE_APP_DATA_KEY) {
      return kv[2] ? kv[2].toString('utf8') : null;
    }
  }
  return null;
}

module.exports = {
  receivePushCode,
  MCS_HOST,
  MCS_PORT,
  MCS_VERSION,
  PUSH_CODE_APP_DATA_KEY,
  // exported for tests
  buildLoginRequest,
  frame,
  pbDecode,
  extractCode,
  encodeVarint,
  TAG_LOGIN_RESPONSE,
  TAG_DATA_MESSAGE,
  TAG_HEARTBEAT_PING,
  TAG_HEARTBEAT_ACK
};
