'use strict';

// A WebSocket that behaves like a net.Socket.
//
// NoiseSocket was written against a raw TLS socket to g.whatsapp.net and knows
// nothing about WebSockets. Rather than fork it, this wraps `ws` in the same
// small surface NoiseSocket already uses — write/destroy/setKeepAlive plus the
// connect/data/error/close events — so a single handshake implementation drives
// both transports.
//
// The length framing is unchanged: even inside a WebSocket message WhatsApp
// still prefixes each frame with three big-endian length bytes, so the existing
// buffer loop applies as-is.

const EventEmitter = require('events');
const { WEB_SOCKET_URL, WEB_ORIGIN } = require('./constants');

function loadWs() {
  try {
    return require('ws');
  } catch (_) {
    throw new Error(
      "The 'ws' package is required for WhatsApp Web mode. Install it with: npm install ws"
    );
  }
}

class WebSocketStream extends EventEmitter {
  constructor(opts) {
    super();
    opts = opts || {};
    this._url     = opts.url     || WEB_SOCKET_URL;
    this._origin  = opts.origin  || WEB_ORIGIN;
    this._ws      = null;
    this._closed  = false;
    this._opened  = false;
  }

  connect() {
    const WebSocket = loadWs();
    this._ws = new WebSocket(this._url, {
      origin:  this._origin,
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
                      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      handshakeTimeout: 20000
    });

    this._ws.on('open', () => {
      this._opened = true;
      this.emit('connect');
    });

    // ws hands us a Buffer for binary frames; normalise anything else so the
    // caller only ever deals in Buffers.
    this._ws.on('message', (data) => {
      this.emit('data', Buffer.isBuffer(data) ? data : Buffer.from(data));
    });

    this._ws.on('error', (err) => this.emit('error', err));

    this._ws.on('close', () => {
      if (this._closed) return;
      this._closed = true;
      this.emit('close');
    });

    return this;
  }

  write(buf) {
    if (!this._ws || this._ws.readyState !== 1) return false;
    this._ws.send(buf);
    return true;
  }

  // net.Socket parity — a WebSocket has no equivalent knob, and `ws` sends its
  // own pings, so this is deliberately a no-op rather than an error.
  setKeepAlive() { /* no-op */ }

  destroy() {
    if (!this._ws) return;
    try {
      // terminate() rather than close(): we are tearing down, not negotiating,
      // and a half-open socket here would leave the client waiting on a reply
      // that is never coming.
      this._ws.terminate();
    } catch (_) {}
    this._ws = null;
    if (!this._closed) {
      this._closed = true;
      this.emit('close');
    }
  }
}

module.exports = { WebSocketStream };
