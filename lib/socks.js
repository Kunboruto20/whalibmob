'use strict';

// SOCKS4 / SOCKS5 / Tor support for every outbound connection the library makes.
//
// Set SOCKS_PROXY (or TOR_PROXY) and everything goes through it:
//
//   socks5://127.0.0.1:9050              Tor
//   socks5://user:pass@host:1080         authenticated residential proxy
//   socks5h://host:1080                  resolve the destination at the proxy
//   socks4://host:1080                   older proxies
//
// Requires the `socks` package, which ships as an optional dependency.
//
// Why this module exists at all: the proxy used to be honoured by exactly one
// call site, the registration POST. Everything else — the App Store and Play
// Store version lookups, the web client's sw.js revision probe, the WhatsApp
// Web socket and the mobile TCP socket — went out through `https.get`,
// `axios` and `net.createConnection`, none of which look at proxy environment
// variables. Node has no built-in proxy support; an agent has to be handed in.
//
// The visible symptom was a connection that "worked" in curl and timed out in
// the library:
//
//   [DBG] WEB_VERSION 2.3000.1035194821 (pinned fallback: sw.js fetch timed out)
//
// curl honours SOCKS_PROXY, https.get does not. Same machine, same proxy,
// opposite results.

const https = require('https');
const tls   = require('tls');

const SOCKS_SCHEMES = {
  'socks:':   5,
  'socks5:':  5,
  'socks5h:': 5,
  'socks4:':  4,
  'socks4a:': 4
};

// How long a SOCKS handshake may take before it is treated as dead. A proxy
// that accepts the TCP connection and then says nothing would otherwise hang
// whatever asked for the connection.
const SOCKS_TIMEOUT_MS = 20000;

// Resolve the library the way every other dependency is resolved.
//
// WA_SOCKS_LIB stays as an escape hatch for unusual layouts, but it is an
// override, not the only way in.
function loadSocks() {
  const override = process.env.WA_SOCKS_LIB;
  if (override) {
    try { return require(override); }
    catch (err) {
      throw new Error('WA_SOCKS_LIB points at ' + override +
        ' but it could not be loaded: ' + err.message);
    }
  }
  try {
    return require('socks');
  } catch (_) {
    throw new Error(
      "A SOCKS proxy is configured but the 'socks' package is not installed. " +
      'Run: npm install socks'
    );
  }
}

/**
 * Parse a proxy URL into what SocksClient expects.
 *
 * Accepts the schemes above, with or without credentials, and defaults the
 * port to 1080 the way every SOCKS client does.
 */
function parseSocksProxy(proxyUrl) {
  let raw = String(proxyUrl || '').trim();
  if (!raw) throw new Error('No SOCKS proxy configured');

  // A bare host:port is what .env.example has always shown and what most people
  // type. Without a scheme `new URL` reads "127.0.0.1:" as the protocol and the
  // rest as the path, so it has to be filled in before parsing.
  if (!/^[a-z0-9+.-]+:\/\//i.test(raw)) raw = 'socks5://' + raw;

  let url;
  try { url = new URL(raw); }
  catch (_) { throw new Error('Invalid SOCKS proxy URL: ' + proxyUrl); }

  const type = SOCKS_SCHEMES[url.protocol];
  if (!type) {
    throw new Error('Unsupported proxy scheme "' + url.protocol + '" — use ' +
      Object.keys(SOCKS_SCHEMES).map(s => s.replace(':', '')).join(', '));
  }
  if (!url.hostname) throw new Error('SOCKS proxy URL has no host: ' + proxyUrl);

  const proxy = {
    host: url.hostname,
    port: parseInt(url.port, 10) || 1080,
    type
  };
  // Credentials may be percent-encoded in a URL; a password with an @ or a :
  // in it is common enough on paid proxies to be worth decoding.
  if (url.username) proxy.userId   = decodeURIComponent(url.username);
  if (url.password) proxy.password = decodeURIComponent(url.password);
  return proxy;
}

// TOR_PROXY wins when both are set — the precedence .env.example has always
// documented. Read from the environment on every call rather than cached at
// require time, so a process that sets it late still gets it.
function socksProxyUrl() {
  return process.env.TOR_PROXY || process.env.SOCKS_PROXY || '';
}

/** Whether a proxy is configured at all. Cheap, and never throws. */
function hasProxy() {
  return !!socksProxyUrl();
}

/**
 * Open a raw TCP connection to host:port through the configured proxy.
 *
 * Resolves with a connected socket — the SOCKS handshake is already done, so
 * no 'connect' event will fire on it. Callers that key off 'connect' have to
 * account for that.
 */
async function socksConnect(proxyUrl, host, port, timeoutMs) {
  const proxy = parseSocksProxy(proxyUrl);
  const { SocksClient } = loadSocks();
  const { socket } = await SocksClient.createConnection({
    proxy,
    command:     'connect',
    destination: { host, port },
    timeout:     timeoutMs > 0 ? timeoutMs : SOCKS_TIMEOUT_MS
  });
  return socket;
}

/**
 * An https.Agent that tunnels through SOCKS.
 *
 * `https.get`, `axios` and `ws` all accept an agent and all drive it the same
 * way, so one of these covers every HTTPS and WSS call site in the library.
 *
 * The base agent's createConnection calls tls.connect on a fresh TCP socket;
 * this one gets the TCP socket from the proxy first and layers TLS on top of
 * it. Everything else — pooling, keep-alive, timeouts — is inherited.
 */
class SocksHttpsAgent extends https.Agent {
  constructor(proxyUrl, opts) {
    super(opts);
    this._proxyUrl = proxyUrl;
    // Fail fast on a malformed URL, at construction rather than on first use,
    // so a typo surfaces as a clear error instead of a stalled request.
    this._proxy = parseSocksProxy(proxyUrl);
  }

  createConnection(options, callback) {
    const { SocksClient } = loadSocks();
    const host = options.host || options.hostname;
    const port = Number(options.port) || 443;

    SocksClient.createConnection({
      proxy:       this._proxy,
      command:     'connect',
      destination: { host, port },
      timeout:     SOCKS_TIMEOUT_MS
    }).then(({ socket }) => {
      // servername has to be set explicitly: the TLS socket is built on a
      // socket that was never given a hostname, so without it SNI goes out
      // empty and WhatsApp's edge answers with the wrong certificate.
      const tlsSocket = tls.connect(Object.assign({}, options, {
        socket,
        host,
        port,
        servername: options.servername || (typeof host === 'string' ? host : undefined)
      }));
      callback(null, tlsSocket);
    }).catch(err => callback(err));
  }
}

// One agent per proxy URL. Agents pool sockets, so building a fresh one per
// request would throw the pool away every time.
const _agentCache = new Map();

/**
 * The agent for a given proxy URL, or null when none is configured.
 *
 * Never throws: a proxy that cannot be parsed, or a missing `socks` package,
 * returns null and leaves the caller on a direct connection. A version lookup
 * that has a pinned fallback must not take the process down over its proxy.
 */
function socksAgent(proxyUrl) {
  const url = proxyUrl || socksProxyUrl();
  if (!url) return null;
  if (_agentCache.has(url)) return _agentCache.get(url);

  let agent = null;
  try {
    agent = new SocksHttpsAgent(url, { keepAlive: false });
  } catch (_) {
    agent = null;
  }
  _agentCache.set(url, agent);
  return agent;
}

/** The agent for the environment's proxy, or null. */
function proxyAgent() {
  return socksAgent(socksProxyUrl());
}

/** Drop cached agents. For tests, and for a process that swaps proxies. */
function clearAgentCache() {
  for (const agent of _agentCache.values()) {
    if (agent && typeof agent.destroy === 'function') {
      try { agent.destroy(); } catch (_) {}
    }
  }
  _agentCache.clear();
}

module.exports = {
  SOCKS_SCHEMES,
  SOCKS_TIMEOUT_MS,
  loadSocks,
  parseSocksProxy,
  socksProxyUrl,
  hasProxy,
  socksConnect,
  socksAgent,
  proxyAgent,
  clearAgentCache,
  SocksHttpsAgent
};
