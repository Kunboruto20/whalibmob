'use strict';

const { dbg: _whaDbg } = require('./logger');

const { BinaryNode }  = require('./BinaryNode');
const { NodeCache }   = require('@cacheable/node-cache');
const fs   = require('fs');
const path = require('path');

const DEVICE_CACHE_TTL = '5m';

// ─── JID helpers ─────────────────────────────────────────────────────────────

function stripUser(jid) {
  const at    = jid.indexOf('@');
  const user  = at >= 0 ? jid.slice(0, at) : jid;
  const colon = user.indexOf(':');
  if (colon >= 0) return { user: user.slice(0, colon), device: parseInt(user.slice(colon + 1), 10) };
  return { user, device: 0 };
}

function makeDeviceJid(user, device, server) {
  server = server || 's.whatsapp.net';
  if (!device || device === 0) return `${user}@${server}`;
  return `${user}:${device}@${server}`;
}

// Convert a JID string like "user@server" or "user:device@server" into the
// BinaryNode JID object format so _writeJid() emits proper binary JID_PAIR /
// AD_JID bytes instead of raw UTF-8.  The server requires binary JID encoding
// for routing attributes — raw UTF-8 strings are silently ignored for @lid JIDs.
function jidStrToObj(jidStr) {
  const str    = typeof jidStr === 'string' ? jidStr : String(jidStr);
  const at     = str.indexOf('@');
  const raw    = at >= 0 ? str.slice(0, at) : str;
  const server = at >= 0 ? str.slice(at + 1) : 's.whatsapp.net';
  const colon  = raw.indexOf(':');
  const user   = colon >= 0 ? raw.slice(0, colon) : raw;
  const device = colon >= 0 ? (parseInt(raw.slice(colon + 1), 10) || 0) : 0;
  const self   = str;
  // AD_JID binary format requires both agent AND device fields — use only for
  // multi-device @s.whatsapp.net JIDs where device > 0.
  if (server === 's.whatsapp.net' && device > 0) {
    return { user, agent: 0, device, server, toString() { return self; } };
  }
  // @lid multi-device (e.g. "112713111982325:2@lid"): JID_PAIR with user="112713111982325:2"
  // so the server receives the colon-device in the user string, not stripped.
  // Without this, ":2@lid" is encoded as device-0 "@lid" and the server
  // returns the wrong bundle (or ignores device 2 entirely).
  if (server === 'lid' && device > 0) {
    return { user: raw, server, toString() { return self; } };
  }
  // JID_PAIR: used for @lid device-0, @g.us, and primary (device-0) @s.whatsapp.net
  return { user, server, toString() { return self; } };
}

function phoneFromJid(jid) {
  const { user } = stripUser(jid);
  return user;
}

// ─── Bundle parsing ───────────────────────────────────────────────────────────

function findChild(node, desc) {
  if (!node || !Array.isArray(node.content)) return null;
  return node.content.find(c => c && c.description === desc) || null;
}

function getContent(node) {
  if (!node) return null;
  if (Buffer.isBuffer(node.content)) return node.content;
  if (typeof node.content === 'string') return Buffer.from(node.content);
  return null;
}

function intFromBuf(buf) {
  if (!buf) return 0;
  let v = 0;
  for (const b of buf) v = (v << 8) | b;
  return v;
}

function toSignalKey(raw) {
  if (!raw) return null;
  if (raw.length === 33 && raw[0] === 0x05) return Buffer.from(raw);
  if (raw.length === 32) return Buffer.concat([Buffer.from([0x05]), Buffer.from(raw)]);
  return Buffer.from(raw);
}

function parseBundleFromUserNode(userNode) {
  if (!userNode) return null;

  const identity   = getContent(findChild(userNode, 'identity'));
  const regBuf     = getContent(findChild(userNode, 'registration'));
  const sskeyNode  = findChild(userNode, 'skey');
  const preKeyNode = findChild(userNode, 'key');

  if (!identity || !sskeyNode) return null;

  const identityKey = toSignalKey(identity);

  function parseKeyNode(kn) {
    if (!kn) return null;
    const id  = getContent(findChild(kn, 'id'));
    const val = getContent(findChild(kn, 'value'));
    const sig = getContent(findChild(kn, 'signature'));
    return { keyId: intFromBuf(id), publicKey: toSignalKey(val), signature: sig ? Buffer.from(sig) : null };
  }

  const spk = parseKeyNode(sskeyNode);
  const pk  = parseKeyNode(preKeyNode);

  if (!spk || !spk.publicKey) return null;

  const bundle = {
    registrationId: regBuf ? regBuf.readUInt32BE(0) : 0,
    identityKey,
    signedPreKey: {
      keyId:     spk.keyId,
      publicKey: spk.publicKey,
      signature: spk.signature
    }
  };
  if (pk && pk.publicKey) {
    bundle.preKey = { keyId: pk.keyId, publicKey: pk.publicKey };
  }
  return bundle;
}

// ─── DeviceManager ────────────────────────────────────────────────────────────
//
// KEY OPTIMISATIONS:
//
//  1. _deviceCache hit → skip usync IQ entirely (saves ~500 ms per send)
//  2. hasSession check before fetchBundles → skip encrypt IQ for known sessions
//     (saves another ~500 ms per send after the first message to a recipient)
//  3. Own device list is cached for the connection lifetime
//     (ensureOwnDeviceSessions stops calling usync repeatedly)
//  4. Inflight de-duplication: if two concurrent sends need the same phone's
//     device list, only one usync IQ is sent; the second awaits the first.
//
// Net result: after the very first message to a given recipient, every
// subsequent message needs ZERO extra network round-trips.

class DeviceManager {
  constructor(client) {
    this._client        = client;
    // phone → deviceId[]  (TTL-based: expires after 5 min, triggers fresh usync)
    this._deviceCache   = new NodeCache({ ttl: DEVICE_CACHE_TTL });
    // phone → Promise<jids[]>  (in-flight usync dedup)
    this._usyncInflight = new Map();
    // own device list cache + expiry timestamp (refreshed every 5 min)
    this._ownDeviceJids   = null;
    this._ownDeviceExpiry = 0;
    // ─── Disk persistence ─────────────────────────────────────────────
    this._cacheSnapshot = {};  // mirrors _deviceCache for serialisation
    this._sessionDir    = null;
    this._phone         = null;
    this._cacheFile     = null;
    this._lidMapFile    = null;
    this._diskSaveTimer = null;
  }

  // ─── NodeCache helper methods ─────────────────────────────────────────────
  // _deviceCache stores deviceId arrays (not Sets) because NodeCache serialises
  // values and Sets don't round-trip reliably.  All callers use these helpers.

  _dcHas(key)       { return this._deviceCache.has(key); }
  _dcGet(key)       { return this._deviceCache.get(key) || null; }   // number[] | null
  _dcSet(key, arr)  { this._deviceCache.set(key, arr); this._cacheSnapshot[key] = arr; }
  _dcAdd(key, id) {
    const arr = this._deviceCache.get(key) || [];
    if (!arr.includes(id)) arr.push(id);
    this._deviceCache.set(key, arr);
    this._cacheSnapshot[key] = arr;
  }
  _dcEnsure(key) {
    if (!this._deviceCache.has(key)) {
      this._deviceCache.set(key, []);
      this._cacheSnapshot[key] = [];
    }
  }
  _dcDel(keys) {
    for (const k of keys) { this._deviceCache.del(k); delete this._cacheSnapshot[k]; }
  }
  _dcFlush() {
    this._deviceCache.flushAll();
    this._cacheSnapshot   = {};
    this._ownDeviceJids   = null;
    this._ownDeviceExpiry = 0;
  }


  // ─── Session-dir attachment & disk persistence ─────────────────────────────
  //
  // Call attachSession(sessionDir, phone) right after DeviceManager construction.
  // It loads the on-disk device cache so the very first send after a process
  // restart is instant — no cold-start usync round-trip needed.
  //
  // Files saved in session dir (baileys-compatible naming):
  //   <phone>.device-cache.json                          ← combined cache (internal)
  //   device-list-447911234567@s.whatsapp.net.json       ← per-phone device IDs
  //   device-list-139471160877194@lid.json               ← per-LID device IDs
  //   <phone>.lid-mapping.json                           ← phone ↔ LID mappings
  //   <phone>.lid-reverse-mapping.json                   ← LID → phone mappings
  //
  // Cache validity: only restored if saved < 5 min ago (matches NodeCache TTL).
  // After 5 min the TTL fires in-memory AND the next usync rewrites the files.

  attachSession(sessionDir, phone) {
    this._sessionDir = sessionDir;
    this._phone      = String(phone);
    this._cacheFile  = path.join(sessionDir, this._phone + '.device-cache.json');
    this._lidMapFile = path.join(sessionDir, this._phone + '.lid-mapping.json');
    this._loadFromDisk();
  }

  _loadFromDisk() {
    if (!this._cacheFile) return;
    try {
      if (fs.existsSync(this._cacheFile)) {
        const raw  = fs.readFileSync(this._cacheFile, 'utf8');
        const data = JSON.parse(raw);
        const age  = Date.now() - (data.saved || 0);
        if (data.entries && age < 5 * 60 * 1000) {
          for (const [key, ids] of Object.entries(data.entries)) {
            if (Array.isArray(ids)) {
              this._deviceCache.set(key, ids);
              this._cacheSnapshot[key] = ids;
            }
          }
          _whaDbg('[DBG] DEVICE_CACHE_LOADED entries=' + Object.keys(data.entries).length + ' age=' + Math.round(age / 1000) + 's');
        } else if (data.entries) {
          _whaDbg('[DBG] DEVICE_CACHE_STALE age=' + Math.round(age / 1000) + 's — usync will re-query');
        }
      }
    } catch (e) {
      _whaDbg('[DBG] DEVICE_CACHE_LOAD_ERR ' + e.message);
    }
  }

  // Debounced save (300 ms) so rapid usync responses don't cause I/O storms
  _scheduleSave() {
    if (!this._cacheFile) return;
    if (this._diskSaveTimer) clearTimeout(this._diskSaveTimer);
    this._diskSaveTimer = setTimeout(() => {
      this._diskSaveTimer = null;
      this._saveToDisk();
    }, 300);
  }

  _saveToDisk() {
    if (!this._sessionDir || !this._cacheFile) return;
    try {
      const entries = Object.assign({}, this._cacheSnapshot);

      // ── Combined cache file ─────────────────────────────────────────────────
      fs.writeFileSync(
        this._cacheFile,
        JSON.stringify({ saved: Date.now(), ttl: 300000, entries }, null, 2),
        'utf8'
      );

      // ── Individual device-list files (baileys-compatible) ──────────────────
      for (const [key, ids] of Object.entries(entries)) {
        let fileName;
        if (key.startsWith('lid:')) {
          fileName = 'device-list-' + key.slice(4) + '@lid.json';
        } else {
          fileName = 'device-list-' + key + '@s.whatsapp.net.json';
        }
        try {
          fs.writeFileSync(path.join(this._sessionDir, fileName), JSON.stringify(ids), 'utf8');
        } catch (_) {}
      }

      // ── LID mapping files ────────────────────────────────────────────────────
      if (this._client._pnToLid && this._client._lidToPn) {
        const pnToLid = {};
        const lidToPn = {};
        for (const [pn, lid] of this._client._pnToLid)  { pnToLid[pn]  = lid; }
        for (const [lid, pn] of this._client._lidToPn)  { lidToPn[lid] = pn; }
        fs.writeFileSync(
          this._lidMapFile,
          JSON.stringify({ pnToLid, lidToPn }, null, 2),
          'utf8'
        );
        fs.writeFileSync(
          path.join(this._sessionDir, this._phone + '.lid-reverse-mapping.json'),
          JSON.stringify(lidToPn, null, 2),
          'utf8'
        );
      }

      _whaDbg('[DBG] DEVICE_CACHE_SAVED entries=' + Object.keys(entries).length);
    } catch (e) {
      _whaDbg('[DBG] DEVICE_CACHE_SAVE_ERR ' + e.message);
    }
  }

  // ─── Fetch pre-key bundles for a list of JIDs via encrypt IQ ───────────────
  // Only called for JIDs where no Signal session exists yet.
  // Returns Map<string_jid, bundle> — keys are always normalised strings.
  async fetchBundles(jids) {
    if (!jids || jids.length === 0) return new Map();

    // Convert a string JID like "user@server" or "user:device@server" into
    // a proper JID object so the binary encoder uses JID_PAIR / AD_JID format.
    // Raw UTF-8 strings are NOT recognised by the WA server for @lid JIDs — the
    // server silently ignores unknown JIDs and returns an empty bundle list.
    const toJidObj = jidStr => {
      const str    = typeof jidStr === 'string' ? jidStr : String(jidStr);
      const at     = str.indexOf('@');
      const raw    = at >= 0 ? str.slice(0, at) : str;
      const server = at >= 0 ? str.slice(at + 1) : 's.whatsapp.net';
      const colon  = raw.indexOf(':');
      const user   = colon >= 0 ? raw.slice(0, colon) : raw;
      const device = colon >= 0 ? (parseInt(raw.slice(colon + 1), 10) || 0) : 0;
      const self   = str;
      // AD_JID binary format is for @s.whatsapp.net with device > 0.
      // JID_PAIR binary format is used for @lid and for device-0 @s.whatsapp.net.
      if (server === 's.whatsapp.net' && device > 0) {
        // AD_JID: agent=0, device=N
        return { user, agent: 0, device, server, toString() { return self; } };
      }
      // JID_PAIR: user@server  — server may be 'lid' or 's.whatsapp.net'
      return { user, server, toString() { return self; } };
    };

    const userNodes = jids.map(jid => new BinaryNode('user', { jid: toJidObj(jid) }, null));
    const iqId   = this._client._genMsgId();
    const iqNode = new BinaryNode('iq',
      { id: iqId, xmlns: 'encrypt', type: 'get', to: 's.whatsapp.net' },
      [new BinaryNode('key', {}, userNodes)]
    );

    _whaDbg('[DBG] FETCH_BUNDLES jids=[' + jids.join(',') + ']\n');

    const response = await this._client._sendIq(iqNode);
    const bundles  = new Map();
    if (!response) {
      _whaDbg('[DBG] FETCH_BUNDLES_NULL\n');
      return bundles;
    }

    const listNode = findChild(response, 'list');
    const children = listNode ? listNode.content : (response.content || []);

    _whaDbg('[DBG] FETCH_BUNDLES_RESP childCount=' +
      (Array.isArray(children) ? children.length : 0));

    for (const userNode of (Array.isArray(children) ? children : [])) {
      if (!userNode || userNode.description !== 'user') continue;
      const jidRaw = userNode.attrs && userNode.attrs.jid;
      if (!jidRaw) continue;
      // Always normalise to a string key so Map lookups are consistent
      const jidStr = String(jidRaw);
      _whaDbg('[DBG] FETCH_BUNDLES_USER jid=' + jidStr +
        ' childTags=' + (Array.isArray(userNode.content)
          ? userNode.content.map(c => c && c.description).filter(Boolean).join(',')
          : ''));
      const bundle = parseBundleFromUserNode(userNode);
      if (bundle) bundles.set(jidStr, bundle);
      else _whaDbg('[DBG] FETCH_BUNDLES_NO_BUNDLE jid=' + jidStr);
    }
    _whaDbg('[DBG] FETCH_BUNDLES_DONE count=' + bundles.size);
    return bundles;
  }

  // ─── usync device list query ───────────────────────────────────────────────
  //
  // OPTIMISATION 1: check _deviceCache FIRST.
  //   If ALL requested phones are already in the cache, return immediately
  //   without any network round-trip.
  //
  // OPTIMISATION 2: inflight de-duplication.
  //   If a usync IQ for the same set of phones is already in flight
  //   (e.g. two concurrent sends to the same recipient), the second caller
  //   awaits the first IQ instead of sending a duplicate.
  //
  // Only truly unknown phones trigger a network IQ.

  async _usyncGetDevices(phones) {
    // Fast path: all phones cached (TTL-based: NodeCache returns null for expired entries)
    const uncached = phones.filter(p => !this._dcHas(p));
    if (uncached.length === 0) {
      return this._jidsFromCache(phones);
    }

    // De-duplicate in-flight usync for the same phones
    const inflightKey = uncached.slice().sort().join(',');
    if (this._usyncInflight.has(inflightKey)) {
      // Wait for the existing IQ and merge with cached phones
      await this._usyncInflight.get(inflightKey);
      return this._jidsFromCache(phones);
    }

    // Launch a new usync IQ only for uncached phones
    const iqPromise = this._doUsyncIq(uncached).finally(() => {
      this._usyncInflight.delete(inflightKey);
    });
    this._usyncInflight.set(inflightKey, iqPromise);

    await iqPromise;
    return this._jidsFromCache(phones);
  }

  // Build JID list from cache (called after cache is guaranteed to contain all phones)
  _jidsFromCache(phones) {
    const jids = [];
    for (const p of phones) {
      const devices = this._dcGet(p);
      if (devices && devices.length > 0) {
        for (const dev of devices) jids.push(makeDeviceJid(p, dev));
      } else {
        jids.push(makeDeviceJid(p, 0));
      }
    }
    return jids.length > 0 ? jids : phones.map(p => makeDeviceJid(p, 0));
  }

  // ─── usync IQ — builds the device-list query exactly as WhatsApp APK does ────
  //
  //  APK-confirmed format (extracted from WhatsApp DEX string tables):
  //
  //  Correct wire format (verified against live WA server):
  //
  //  <iq to="s.whatsapp.net" type="get" xmlns="usync">
  //    <usync sid="..." mode="query" last="true" index="0" context="interactive">
  //      <query>
  //        <devices version="2"/>
  //        <lid/>
  //        <contact/>
  //      </query>
  //      <list>
  //        <user><contact>+phone</contact></user>  ← Buffer, NOT jid attr
  //      </list>
  //      <side_list/>
  //    </usync>
  //  </iq>
  //
  //  Key findings vs original buggy whalibmob implementation:
  //
  //  Fix A — User list format was wrong (jid attr → server ignored IQ):
  //    Correct: <user><contact>+phone</contact></user>  (Buffer content, same as _doContactUsync)
  //    Wrong:   <user jid="phone@s.whatsapp.net"/>      (jid attr — server silently drops IQ)
  //
  //  Fix B — Extra <devices> attributes break the IQ:
  //    device_orientation="0" and fetch_options="5" both cause the server to ignore the IQ.
  //    fetch_options is not in the binary token dict → encoded as BINARY_8 → server parse error.
  //    Use only version="2" on <devices>. Server returns ALL linked devices without extra attrs.
  //
  //  Fix C — context and side_list must match _doContactUsync (the working format):
  //    context="interactive" + <side_list/> is REQUIRED. context="message" → server ignores IQ.
  async _doUsyncIq(phones) {
    const iqId = this._client._genMsgId();
    const sid  = this._client._genMsgId();

    // User list: identical to contact usync format that the server responds to.
    const listChildren = phones.map(p =>
      new BinaryNode('user', {}, [
        new BinaryNode('contact', {}, Buffer.from('+' + p, 'utf8'))
      ])
    );

    // Same structure as _doContactUsync (which works) but with <devices> and <lid>
    // added to the query. context="interactive" + side_list matches the working format.
    const iqNode = new BinaryNode('iq',
      { id: iqId, to: 's.whatsapp.net', type: 'get', xmlns: 'usync' },
      [new BinaryNode('usync',
        { sid, mode: 'query', last: 'true', index: '0', context: 'interactive' },
        [
          new BinaryNode('query', {},
            [
              new BinaryNode('devices', { version: '2' }, null),
              new BinaryNode('lid', {}, null),
              new BinaryNode('contact', {}, null)
            ]
          ),
          new BinaryNode('list', {}, listChildren),
          new BinaryNode('side_list', {}, null)
        ]
      )]
    );

    _whaDbg('[USYNC_IQ] phones=[' + phones.join(',') + ']');

    const response = await this._client._sendIq(iqNode).catch(err => {
      _whaDbg('[USYNC_ERR] ' + (err && err.message));
      return null;
    });

    if (!response) {
      _whaDbg('[USYNC_NULL_RESP]');
      // Timed out — fall back to contact usync for LID mapping only.
      await this._doContactUsync(phones).catch(() => {});
    } else {
      const usyncNode = findChild(response, 'usync');
      const listNode  = usyncNode
        ? findChild(usyncNode, 'list')
        : findChild(response, 'list');

      if (listNode && Array.isArray(listNode.content)) {
        for (const userNode of listNode.content) {
          if (!userNode || userNode.description !== 'user') continue;

          const userJid = userNode.attrs && (userNode.attrs.jid || userNode.attrs.value);
          if (!userJid) continue;

          const isLidUser = String(userJid).endsWith('@lid');
          const { user: rawUser } = stripUser(String(userJid));

          let cachePhone;
          if (isLidUser) {
            // Server returned a LID JID — look up the corresponding phone number.
            const pn = this._client._lidToPn && this._client._lidToPn.get(rawUser);
            if (pn) {
              cachePhone = pn;
            } else if (phones.length === 1) {
              cachePhone = phones[0];
              if (this._client._lidToPn) this._client._lidToPn.set(rawUser, phones[0]);
              if (this._client._pnToLid) this._client._pnToLid.set(phones[0], rawUser);
            } else {
              cachePhone = rawUser; // last resort
            }
            _whaDbg('[USYNC_LID_USER] jid=' + userJid + ' → phone=' + cachePhone);
          } else {
            // Server returned a phone JID (phone@s.whatsapp.net).
            cachePhone = rawUser;

            // The LID is in a <lid val={user:"NNNN",...}> CHILD NODE, NOT an attr.
            // Extract and populate both directions of the PN↔LID mapping, and
            // pre-populate the lid: cache key so bulkEnsureSessionsForLid can
            // skip a second IQ for this recipient.
            const lidChildNode = findChild(userNode, 'lid');
            const lidVal       = lidChildNode && lidChildNode.attrs && lidChildNode.attrs.val;
            if (lidVal) {
              const lidUser = lidVal.user
                ? String(lidVal.user)
                : String(lidVal).split('@')[0].split(':')[0];
              if (lidUser) {
                if (this._client._lidToPn) this._client._lidToPn.set(lidUser, cachePhone);
                if (this._client._pnToLid) this._client._pnToLid.set(cachePhone, lidUser);
                const store = this._client._signal && this._client._signal.store;
                if (store && store.setLidMapping) store.setLidMapping(cachePhone, lidUser);
                _whaDbg('[USYNC_LID_MAP] phone=' + cachePhone + ' ↔ lid=' + lidUser);
                this._lidForPhone = this._lidForPhone || new Map();
                this._lidForPhone.set(cachePhone, lidUser);
              }
            }
          }

          // Parse device list: user → devices → device-list → device[id=N]
          const devicesNode    = findChild(userNode, 'devices');
          const deviceListNode = devicesNode ? findChild(devicesNode, 'device-list') : null;

          this._dcEnsure(cachePhone);

          if (deviceListNode && Array.isArray(deviceListNode.content)) {
            for (const devNode of deviceListNode.content) {
              if (!devNode || devNode.description !== 'device') continue;
              const devId = devNode.attrs && devNode.attrs.id != null
                ? parseInt(String(devNode.attrs.id), 10)
                : 0;
              this._dcAdd(cachePhone, devId);
            }

            // Mirror device IDs to the lid: cache key so _doUsyncIqByJid is
            // skipped when bulkEnsureSessionsForLid is later called for this LID.
            const knownLid = this._lidForPhone && this._lidForPhone.get(cachePhone);
            if (knownLid) {
              const devIds = this._dcGet(cachePhone) || [];
              this._dcSet('lid:' + knownLid, devIds.slice());
              _whaDbg('[USYNC_LID_CACHE] lid=' + knownLid + ' ids=[' + devIds.join(',') + ']');
            }

            _whaDbg('[USYNC_DEVICES] phone=' + cachePhone +
              ' ids=[' + (this._dcGet(cachePhone) || []).join(',') + ']');
          } else {
            this._dcAdd(cachePhone, 0);
            _whaDbg('[USYNC_NO_DEVLIST] phone=' + cachePhone + ' → device 0 only');
          }
        }
      } else {
        _whaDbg('[USYNC_RESP_NO_LIST]');
      }
    }

    // Fallback: any phone not resolved → device 0
    for (const p of phones) {
      if (!this._dcHas(p)) {
        this._dcSet(p, [0]);
        _whaDbg('[USYNC_FALLBACK] phone=' + p);
      }
    }
    this._scheduleSave();
  }

  // ─── Ensure sessions exist for all devices of a set of recipients ──────────
  //
  // OPTIMISATION: check hasSession BEFORE calling fetchBundles.
  //   After the very first message to a recipient, all their sessions exist
  //   in memory — fetchBundles is never called again for that recipient.
  //
  // Flow:
  //   1. _usyncGetDevices() — returns from cache if known, otherwise one IQ
  //   2. for each deviceJid: if hasSession → ready; else add to fetchList
  //   3. fetchBundles(fetchList) — only for truly new sessions
  //   4. buildSessionFromBundle for each new session
  //
  async bulkEnsureSessions(phones, signalProto, allowPkmsg = true) {
    const uniquePhones = [...new Set(phones)];
    if (uniquePhones.length === 0) return [];

    const deviceJids = await this._usyncGetDevices(uniquePhones);

    // Split: existing sessions (ready immediately) vs new (need bundle fetch)
    const readyJids  = [];
    const fetchJids  = [];
    for (const jid of deviceJids) {
      if (signalProto.store.hasSession(this._jidToAddr(jid))) {
        readyJids.push(jid);
      } else {
        fetchJids.push(jid);
      }
    }

    if (allowPkmsg && fetchJids.length > 0) {
      const bundles = await this.fetchBundles(fetchJids);
      for (const [jid, bundle] of bundles) {
        try {
          await signalProto.buildSessionFromBundle(jid, bundle);
          readyJids.push(jid);
        } catch (_) {}
      }
    }

    // Fallback: if still nothing, use main device JIDs directly
    if (readyJids.length === 0) {
      for (const phone of uniquePhones) readyJids.push(makeDeviceJid(phone, 0));
    }

    return readyJids;
  }

  // ─── Ensure sessions for a LID-addressed recipient ────────────────────────
  //
  // For accounts migrated to WhatsApp LID, devices are registered under the
  // LID identity (e.g. 139471160877194@lid), NOT the phone number.
  // This method:
  //   1. Queries usync for device list by LID JID
  //   2. Establishes Signal sessions for LID device JIDs (e.g. 139471160877194:0@lid)
  //   3. Returns the list of ready LID device JIDs for participant fanout
  //
  async bulkEnsureSessionsForLid(lidUser, signalProto, allowPkmsg = true, skipUsync = false) {
    const lidJid    = `${lidUser}@lid`;
    const cacheKey  = `lid:${lidUser}`;

    // skipUsync=true: skip usync ONLY if we already have a cache hit (i.e. we
    // fetched this LID's devices in the last 5 min).  On a cache miss we MUST
    // run a real usync even with skipUsync=true, otherwise linked devices (tablets,
    // desktop, web) are silently ignored and only device 0 (primary phone) is used.
    if (skipUsync) {
      if (!this._dcHas(cacheKey)) {
        _whaDbg('[DBG] LID_SKIP_USYNC_CACHE_MISS lidUser=' + lidUser + ' → real usync\n');
        await this._doUsyncIqByJid(lidJid, cacheKey, lidUser);
      } else {
        _whaDbg('[DBG] LID_SKIP_USYNC_HIT lidUser=' + lidUser + ' → cache\n');
      }
    } else if (!this._dcHas(cacheKey)) {
      await this._doUsyncIqByJid(lidJid, cacheKey, lidUser);
    }

    const deviceIds  = this._dcGet(cacheKey) || [0];
    const deviceJids = deviceIds.map(d => makeDeviceJid(lidUser, d, 'lid'));

    _whaDbg('[DBG] LID_DEVICES lidUser=' + lidUser +
      ' deviceJids=[' + deviceJids.join(',') + ']\n');

    // Split: existing sessions (ready) vs new (need bundle fetch)
    const readyJids = [];
    const fetchJids = [];
    for (const jid of deviceJids) {
      if (signalProto.store.hasSession(this._jidToAddr(jid))) {
        readyJids.push(jid);
      } else {
        fetchJids.push(jid);
      }
    }

    if (allowPkmsg && fetchJids.length > 0) {
      const bundles = await this.fetchBundles(fetchJids);
      for (const [jid, bundle] of bundles) {
        try {
          await signalProto.buildSessionFromBundle(jid, bundle);
          // ── CRITICAL: remap bundle JID back to @lid format ────────────────────
          // fetchBundles always returns JIDs in @s.whatsapp.net format (because the
          // WA server uses its own AD_JID / JID_PAIR encoding in responses).
          // But the outer <message to="lidUser@lid"> requires ALL participant <to>
          // nodes to also use @lid format — mixing @s.whatsapp.net participants with
          // a @lid routing address causes the server to close the connection.
          //
          // The Signal session address is keyed only by (user, device) — the @server
          // suffix is stripped by jidToAddress() — so the session is reachable via
          // either @lid or @s.whatsapp.net.  We push the @lid form so the participants
          // node is consistent with the routing.
          //
          // Mapping: strip @s.whatsapp.net / @lid suffix from jid, re-append @lid
          // e.g. "112713111982325@s.whatsapp.net"   → "112713111982325@lid"
          //      "112713111982325:2@s.whatsapp.net" → "112713111982325:2@lid"
          const jidBase = jid.replace(/@(?:s\.whatsapp\.net|lid)$/, '');
          const lidJidForDevice = jidBase + '@lid';
          readyJids.push(lidJidForDevice);
          _whaDbg('[DBG] LID_SESSION_BUILT jid=' + jid + ' → participant=' + lidJidForDevice);
        } catch (e) {
          _whaDbg('[DBG] LID_SESSION_ERR jid=' + jid + ' err=' + e.message);
        }
      }
    }

    // Fallback: use primary LID device 0 directly (no session yet, will use pkmsg)
    if (readyJids.length === 0) {
      readyJids.push(makeDeviceJid(lidUser, 0, 'lid'));
    }

    return readyJids;
  }

  // ─── Contact usync fallback ────────────────────────────────────────────────
  // When query/devices usync times out (server silently ignores it for LID
  // accounts), we fall back to query/contact which uses the older
  // <user><contact>+phone</contact></user> format and DOES get a response.
  // The response includes the actual JID (LID or PN) for each phone.
  // Calling this populates _pnToLid / _lidToPn in the Client, which is used
  // by _sendDMMessage (checked AFTER the await of _usyncGetDevices).
  async _doContactUsync(phones) {
    const iqId = this._client._genMsgId();
    const sid  = this._client._genMsgId();

    const userNodes = phones.map(p =>
      new BinaryNode('user', {}, [
        new BinaryNode('contact', {}, Buffer.from('+' + p, 'utf8'))
      ])
    );

    const iqNode = new BinaryNode('iq',
      { id: iqId, to: 's.whatsapp.net', type: 'get', xmlns: 'usync' },
      [new BinaryNode('usync',
        { sid, mode: 'query', last: 'true', index: '0', context: 'interactive' },
        [
          new BinaryNode('query', {}, [new BinaryNode('contact', {}, null)]),
          new BinaryNode('list', {}, userNodes),
          new BinaryNode('side_list', {}, null)
        ]
      )]
    );

    _whaDbg('[CONTACT_USYNC] phones=[' + phones.join(',') + ']');

    const response = await this._client._sendIq(iqNode).catch(err => {
      _whaDbg('[CONTACT_USYNC_ERR] ' + (err && err.message));
      return null;
    });

    if (!response) {
      _whaDbg('[CONTACT_USYNC_NULL]');
      return;
    }

    const usyncNode = findChild(response, 'usync');
    const listNode  = usyncNode ? findChild(usyncNode, 'list') : findChild(response, 'list');

    if (!listNode || !Array.isArray(listNode.content)) {
      _whaDbg('[DBG] CONTACT_USYNC_NO_LIST\n');
      return;
    }

    for (let i = 0; i < listNode.content.length; i++) {
      const userNode = listNode.content[i];
      if (!userNode || userNode.description !== 'user') continue;

      const actualJid = userNode.attrs && (userNode.attrs.jid || userNode.attrs.value);
      if (!actualJid) continue;

      const actualJidStr = String(actualJid);
      const isLid = actualJidStr.endsWith('@lid');

      if (isLid) {
        const { user: lidUser } = stripUser(actualJidStr);
        // Determine the corresponding phone.  For single-phone queries it's
        // unambiguous; for multi-phone queries match by index.
        const phone = phones.length === 1 ? phones[0] : phones[i];
        if (phone) {
          _whaDbg('[DBG] CONTACT_USYNC_LID phone=' + phone + ' → lid=' + lidUser);
          if (this._client._pnToLid) this._client._pnToLid.set(phone, lidUser);
          if (this._client._lidToPn) this._client._lidToPn.set(lidUser, phone);
          // Persist the mapping so future sessions don't need to re-query
          const store = this._client._signal && this._client._signal.store;
          if (store && store.setLidMapping) store.setLidMapping(phone, lidUser);
        }
      } else {
        // PN account — note it (still on phone-based routing, no LID needed)
        const { user: pnUser } = stripUser(actualJidStr);
        const phone = phones.length === 1 ? phones[0] : phones[i];
        _whaDbg('[DBG] CONTACT_USYNC_PN phone=' + phone + ' jid=' + actualJidStr);
      }
    }
    this._scheduleSave();
  }

  // ─── usync IQ for a specific JID (LID or phone-based) ─────────────────────
  // Used when we already know the routing JID and want to look up devices for it.
  async _doUsyncIqByJid(jid, cacheKey, lidUser) {
    const iqId = this._client._genMsgId();
    const sid  = this._client._genMsgId();

    // Build proper JID object for binary encoding (JID_PAIR format, not raw string)
    const jidStr   = typeof jid === 'string' ? jid : String(jid);
    const atIdx    = jidStr.indexOf('@');
    const jidUser  = atIdx >= 0 ? jidStr.slice(0, atIdx) : jidStr;
    const jidSrv   = atIdx >= 0 ? jidStr.slice(atIdx + 1) : 'lid';
    const jidObj   = { user: jidUser, server: jidSrv, toString() { return jidStr; } };

    const iqNode = new BinaryNode('iq',
      { id: iqId, to: 's.whatsapp.net', type: 'get', xmlns: 'usync' },
      [new BinaryNode('usync',
        { sid, mode: 'query', last: 'true', index: '0', context: 'interactive' },
        [
          new BinaryNode('query', {},
            [
              new BinaryNode('devices', { version: '2' }, null),
              new BinaryNode('lid', {}, null)
            ]
          ),
          new BinaryNode('list', {},
            [new BinaryNode('user', { jid: jidObj }, null)]
          ),
          new BinaryNode('side_list', {}, null)
        ]
      )]
    );

    _whaDbg('[USYNC_LID_IQ] jid=' + jid);

    const response = await this._client._sendIq(iqNode).catch(err => {
      _whaDbg('[USYNC_LID_ERR] ' + (err && err.message));
      return null;
    });

    this._dcEnsure(cacheKey);

    if (response) {
      const usyncNode = findChild(response, 'usync');
      const listNode  = usyncNode ? findChild(usyncNode, 'list') : findChild(response, 'list');

      if (listNode && Array.isArray(listNode.content)) {
        for (const userNode of listNode.content) {
          if (!userNode || userNode.description !== 'user') continue;

          const devicesNode    = findChild(userNode, 'devices');
          const deviceListNode = devicesNode ? findChild(devicesNode, 'device-list') : null;

          if (deviceListNode && Array.isArray(deviceListNode.content)) {
            for (const devNode of deviceListNode.content) {
              if (!devNode || devNode.description !== 'device') continue;
              const devId = devNode.attrs && devNode.attrs.id != null
                ? parseInt(String(devNode.attrs.id), 10) : 0;
              this._dcAdd(cacheKey, devId);
            }
            _whaDbg('[USYNC_LID_DEVICES] jid=' + jid +
              ' ids=[' + (this._dcGet(cacheKey) || []).join(',') + ']');
          } else {
            this._dcAdd(cacheKey, 0);
            _whaDbg('[USYNC_LID_NO_DEVLIST] jid=' + jid + ' → device 0 only');
          }
        }
      } else {
        _whaDbg('[USYNC_LID_NO_LIST] jid=' + jid);
        this._dcAdd(cacheKey, 0);
      }
    } else {
      _whaDbg('[USYNC_LID_NULL_RESP] jid=' + jid);
      this._dcAdd(cacheKey, 0);
    }
    this._scheduleSave();
  }

  // ─── Ensure sessions for own linked devices (device != 0) ─────────────────
  //
  // OPTIMISATION: own device list is cached for the entire connection lifetime.
  //   On the first call we query usync, on all subsequent calls we return
  //   from cache — zero extra network round-trips.
  //
  async ensureOwnDeviceSessions(ownPhone, signalProto, allowPkmsg = true) {
    // Use cached own device list if it hasn't expired (5-min TTL matches _deviceCache)
    if (this._ownDeviceJids !== null && Date.now() < this._ownDeviceExpiry) {
      const others = this._ownDeviceJids.filter(j => stripUser(j).device !== 0);
      return this._ensureSessions(others, signalProto, allowPkmsg);
    }

    // Cache miss or expired: re-query usync for own devices
    const deviceJids      = await this._usyncGetDevices([ownPhone]);
    this._ownDeviceJids   = deviceJids;
    this._ownDeviceExpiry = Date.now() + 5 * 60 * 1000;

    const others = deviceJids.filter(j => stripUser(j).device !== 0);
    return this._ensureSessions(others, signalProto, allowPkmsg);
  }

  // Internal: ensure Signal sessions for a list of JIDs (own linked devices)
  async _ensureSessions(jids, signalProto, allowPkmsg = true) {
    if (jids.length === 0) return [];
    const fetchJids  = [];
    const readyJids  = [];
    for (const jid of jids) {
      if (signalProto.store.hasSession(this._jidToAddr(jid))) {
        readyJids.push(jid);
      } else {
        fetchJids.push(jid);
      }
    }
    if (allowPkmsg && fetchJids.length > 0) {
      const bundles = await this.fetchBundles(fetchJids);
      for (const [jid, bundle] of bundles) {
        const has = await signalProto.hasSession(jid);
        if (!has) {
          try { await signalProto.buildSessionFromBundle(jid, bundle); }
          catch (_) { continue; }
        }
        readyJids.push(jid);
      }
    }
    return readyJids;
  }

  // Convert a JID string to the Signal session address string
  _jidToAddr(jid) {
    const { user, device } = stripUser(jid);
    return `${user}.${device}`;
  }

  // ─── Invalidate cached device list (used on phash mismatch / 421 retry) ───
  clearCache(phones) {
    if (!phones || phones.length === 0) {
      this._dcFlush();
    } else {
      this._dcDel(phones);
    }
  }

  // ─── Build participants node ───────────────────────────────────────────────
  static buildParticipantsNode(encryptedList, mediaSubtype) {
    const toNodes = encryptedList.map(({ jid, type, ciphertext }) => {
      const encAttrs = { type, v: '2' };
      if (mediaSubtype) encAttrs.mediatype = mediaSubtype;
      // Always encode the jid as a binary JID object (JID_PAIR / AD_JID) so the
      // server can route the per-device enc payload to the correct Signal session.
      // Raw UTF-8 strings are silently dropped for @lid recipients.
      const jidAttr = jidStrToObj(jid);
      return new BinaryNode('to', { jid: jidAttr },
        [new BinaryNode('enc', encAttrs, ciphertext)]
      );
    });
    return new BinaryNode('participants', {}, toNodes);
  }
}

module.exports = { DeviceManager, makeDeviceJid, stripUser, phoneFromJid, parseBundleFromUserNode, jidStrToObj };
