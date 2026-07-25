'use strict';

const fs   = require('fs');
const path = require('path');

// 7-day buckets, 4 buckets = ~28-day rolling window (matches Baileys tc-token-utils)
const TC_BUCKET_DURATION = 604800;
const TC_NUM_BUCKETS     = 4;

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
    this._load();
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
    return this._map.get(normalizeJidForTcToken(jid)) || null;
  }

  setToken(jid, tokenBuf, timestamp) {
    const key      = normalizeJidForTcToken(jid);
    const existing = this._map.get(key) || {};
    this._map.set(key, { ...existing, token: tokenBuf, timestamp });
    this._save();
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

module.exports = { TcTokenStore, tcTokenExpired, shouldSendNewTcToken, normalizeJidForTcToken };
