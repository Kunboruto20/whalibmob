'use strict';

// The web client's own revision number.
//
// The mobile endpoint tolerates a version that has drifted by months. The web
// endpoint does not: it checks the revision during the Noise handshake and
// refuses an unrecognised one with <failure reason="405"> before a single
// stanza has been exchanged. There is nothing in that failure to say the
// version was the problem, which makes a stale constant an expensive thing to
// carry.
//
// So read the live one. WhatsApp Web ships its service worker at
// /sw.js with the current revision embedded in it; that number, paired with
// the fixed 2.3000 prefix, is the version the browser announces.
//
// Everything here is best-effort — a failed fetch falls back to the pinned
// value rather than blocking a connection.

const https = require('https');
const { WEB_VERSION_FALLBACK } = require('./constants');

const SW_URL   = 'https://web.whatsapp.com/sw.js';
const CACHE_MS = 60 * 60 * 1000;   // an hour; the revision changes far slower

let _cached   = null;
let _cachedAt = 0;

function fetchText(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        // The minimum that gets past the anti-bot check on this path.
        'sec-fetch-site': 'none',
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
                      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      }
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('sw.js returned HTTP ' + res.statusCode));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || 10000, () => req.destroy(new Error('sw.js fetch timed out')));
  });
}

/**
 * Resolve the version to announce.
 *
 * @param {object} [opts]  { force } to bypass the hourly cache
 * @returns {Promise<{version: number[], isLatest: boolean, error?: Error}>}
 */
async function fetchWaWebVersion(opts) {
  opts = opts || {};
  if (!opts.force && _cached && (Date.now() - _cachedAt) < CACHE_MS) {
    return { version: _cached.slice(), isLatest: true };
  }

  try {
    const body  = await fetchText(SW_URL, opts.timeoutMs);
    const match = body.match(/\\?"client_revision\\?":\s*(\d+)/);
    if (!match || !match[1]) throw new Error('client_revision not found in sw.js');

    const version = [2, 3000, parseInt(match[1], 10)];
    _cached   = version;
    _cachedAt = Date.now();
    return { version: version.slice(), isLatest: true };
  } catch (error) {
    return { version: WEB_VERSION_FALLBACK.slice(), isLatest: false, error };
  }
}

module.exports = { fetchWaWebVersion, WEB_VERSION_FALLBACK };
