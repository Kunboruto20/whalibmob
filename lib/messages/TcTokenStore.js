'use strict';

const fs   = require('fs');
const path = require('path');

// 7-day buckets, 4 buckets = ~28-day rolling window
const TC_BUCKET_DURATION = 604800;
const TC_NUM_BUCKETS     = 4;
// Expired rows are pruned out of the token store at most once a day; it is a
// JSON file, so there is nothing to gain from doing it more often.
const TC_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

// The two phone-number ranges WhatsApp uses for bots, including Meta AI.
const BOT_USER_RE = /^1313555\d{4}$|^131655500\d{2}$/;

function tcTokenExpired(timestamp) {
  if (timestamp == null) return true;
  const ts = typeof timestamp === 'string' ? parseInt(timestamp, 10) : timestamp;
  if (!ts || isNaN(ts)) return true;
  const now           = Math.floor(Date.now() / 1000);
  const curBucket     = Math.floor(now / TC_BUCKET_DURATION);
  const cutoffBucket  = curBucket - (TC_NUM_BUCKETS - 1);
  return ts < cutoffBucket * TC_BUCKET_DURATION;
}

function shouldSendNewTcToken(senderTimestamp) {
  if (senderTimestamp == null) return true;
  const now       = Math.floor(Date.now() / 1000);
  const curBucket    = Math.floor(now / TC_BUCKET_DURATION);
  const senderBucket = Math.floor(senderTimestamp / TC_BUCKET_DURATION);
  return curBucket > senderBucket;
}

// Whether a JID is a real person we may hold a trusted-contact token for.
//
// The rule is: a user address (phone or LID), not the PSA pseudo-contact 0@…,
// and not a bot.
// Without it we issue a privacy IQ to WhatsApp's own announcement account and
// to Meta AI, which no real client ever does.
function isRegularTcTokenUser(jid) {
  if (!jid) return false;
  const norm   = normalizeJidForTcToken(jid);
  const atIdx  = norm.indexOf('@');
  if (atIdx < 0) return false;
  const user   = norm.slice(0, atIdx);
  const server = norm.slice(atIdx + 1);
  if (server !== 's.whatsapp.net' && server !== 'c.us' && server !== 'lid') return false;
  if (user === '0') return false;              // PSA
  if (BOT_USER_RE.test(user)) return false;    // bots, Meta AI
  return true;
}

// Strip device part and normalize to bare JID
function normalizeJidForTcToken(jid) {
  if (!jid) return String(jid || '');
  const str    = String(jid);
  const atIdx  = str.indexOf('@');
  if (atIdx < 0) return str;
  const server = str.slice(atIdx + 1);
  let user     = str.slice(0, atIdx);
  const colon  = user.indexOf(':');
  if (colon >= 0) user = user.slice(0, colon);
  return user + '@' + server;
}

class TcTokenStore {
  constructor(filePath) {
    this._path = filePath;
    // jid → { token: Buffer|null, timestamp: number|null, senderTimestamp: number|null }
    this._map  = new Map();
    this._lastPrune = 0;
    this._load();
    this.pruneExpired();
  }

  // Drop entries that are past the 28-day window on both counts.
  //
  // An entry whose token has expired but whose senderTimestamp is still inside
  // the window has to stay: that timestamp is what keeps us from re-issuing on
  // every single send.
  pruneExpired() {
    let removed = 0;
    for (const [jid, entry] of this._map) {
      const tokenDead  = !entry.token || !entry.token.length || tcTokenExpired(entry.timestamp);
      const senderDead = tcTokenExpired(entry.senderTimestamp);
      if (tokenDead && senderDead) {
        this._map.delete(jid);
        removed++;
      }
    }
    this._lastPrune = Date.now();
    if (removed) this._save();
    return removed;
  }

  _maybePrune() {
    if (Date.now() - this._lastPrune < TC_PRUNE_INTERVAL_MS) return;
    this.pruneExpired();
  }

  _load() {
    try {
      if (!fs.existsSync(this._path)) return;
      const raw = JSON.parse(fs.readFileSync(this._path, 'utf8'));
      for (const [jid, entry] of Object.entries(raw)) {
        this._map.set(jid, {
          token:           entry.token ? Buffer.from(entry.token, 'base64') : null,
          timestamp:       entry.timestamp        != null ? entry.timestamp        : null,
          senderTimestamp: entry.senderTimestamp  != null ? entry.senderTimestamp  : null
        });
      }
    } catch (_) {}
  }

  _save() {
    try {
      const dir = path.dirname(this._path);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const obj = {};
      for (const [jid, entry] of this._map) {
        obj[jid] = {
          token:           (entry.token && entry.token.length) ? entry.token.toString('base64') : null,
          timestamp:       entry.timestamp        != null ? entry.timestamp        : null,
          senderTimestamp: entry.senderTimestamp  != null ? entry.senderTimestamp  : null
        };
      }
      fs.writeFileSync(this._path, JSON.stringify(obj, null, 2), 'utf8');
    } catch (_) {}
  }

  get(jid) {
    // Pruning happens on the read path, rate-limited to once a day.
    this._maybePrune();
    return this._map.get(normalizeJidForTcToken(jid)) || null;
  }

  // Returns true when the token was accepted.
  //
  // Two rejections:
  //  - a token with no timestamp is already expired by definition, so storing
  //    it only wastes a slot and guarantees a miss on the next send;
  //  - a token older than the one on file must never overwrite it. Token
  //    deliveries are not ordered — an issuance result and a privacy_token
  //    notification for the same contact can land in either order — so without
  //    this a stale copy can replace a fresh one.
  setToken(jid, tokenBuf, timestamp) {
    const key      = normalizeJidForTcToken(jid);
    const incoming = timestamp != null ? Number(timestamp) : 0;
    if (!incoming || isNaN(incoming)) return false;

    const existing   = this._map.get(key) || {};
    const existingTs = existing.timestamp != null ? Number(existing.timestamp) : 0;
    if (existingTs > 0 && existingTs > incoming &&
        existing.token && existing.token.length) {
      return false;
    }

    this._map.set(key, { ...existing, token: tokenBuf, timestamp: incoming });
    this._save();
    return true;
  }

  /**
   * Fold an entry filed under one JID into the entry for another.
   *
   * The same contact can end up with two entries — one under their phone JID
   * and one under their LID — when a send happens before the LID mapping is
   * known. That is not just untidy: whichever key the next send resolves to is
   * the only one it looks at, so a live token under the LID goes unused and the
   * message ships without one.
   *
   * The live token wins, newest first. The sender timestamp takes the newer of
   * the two, since an older one would say we are due to issue again when we are
   * not.
   *
   * @returns {boolean} whether anything was moved
   */
  mergeEntry(fromJid, toJid) {
    const fromKey = normalizeJidForTcToken(fromJid);
    const toKey   = normalizeJidForTcToken(toJid);
    if (fromKey === toKey) return false;

    const from = this._map.get(fromKey);
    if (!from) return false;

    const to = this._map.get(toKey) || {};

    const fromLive = !!(from.token && from.token.length) && !tcTokenExpired(from.timestamp);
    const toLive   = !!(to.token   && to.token.length)   && !tcTokenExpired(to.timestamp);

    let token     = to.token != null ? to.token : null;
    let timestamp = to.timestamp != null ? to.timestamp : null;
    if (fromLive && (!toLive || Number(from.timestamp) > Number(to.timestamp || 0))) {
      token     = from.token;
      timestamp = from.timestamp;
    }

    const senderTimestamp =
      Math.max(Number(to.senderTimestamp || 0), Number(from.senderTimestamp || 0)) || null;

    this._map.set(toKey, { token, timestamp, senderTimestamp });
    this._map.delete(fromKey);
    this._save();
    return true;
  }

  clearToken(jid) {
    const key      = normalizeJidForTcToken(jid);
    const existing = this._map.get(key) || {};
    this._map.set(key, { ...existing, token: null });
    this._save();
  }

  setSenderTimestamp(jid, ts) {
    const key      = normalizeJidForTcToken(jid);
    const existing = this._map.get(key) || {};
    this._map.set(key, { ...existing, senderTimestamp: ts });
    this._save();
  }

  isExpired(jid) {
    const entry = this.get(jid);
    if (!entry || !entry.token || !entry.token.length) return true;
    return tcTokenExpired(entry.timestamp);
  }

  shouldIssue(jid) {
    const entry = this.get(jid);
    return shouldSendNewTcToken(entry && entry.senderTimestamp);
  }
}

module.exports = {
  TcTokenStore,
  tcTokenExpired,
  shouldSendNewTcToken,
  normalizeJidForTcToken,
  isRegularTcTokenUser,
  TC_BUCKET_DURATION,
  TC_NUM_BUCKETS
};
