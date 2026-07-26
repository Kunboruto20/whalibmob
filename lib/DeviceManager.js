'use strict';

const { dbg: _whaDbg } = require('./logger');

const { BinaryNode }  = require('./BinaryNode');
const { USyncQuery, USyncUser } = require('./WAUSync');
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
  // @lid multi-device (e.g. "112713111982325:2@lid"): AD_JID with the domain in
  // the agent byte — 1 for lid, matching Baileys' writeJid, which emits AD_JID
  // with domainType whenever a device is present.
  //
  // This previously packed the device into the user string as a JID_PAIR
  // ("112713111982325:2"), a workaround from when the encoder could not express
  // a LID agent at all and would otherwise have flattened the JID to device 0.
  // The server does not recognise that shape: a prekey IQ addressed with it got
  // no reply whatsoever and timed out, so no session was ever built for the
  // contact's linked devices and sends failed with NO_OPEN_SESSION.
  if (server === 'lid' && device > 0) {
    return { user, agent: 1, device, server, toString() { return self; } };
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

    // Use the shared converter. The local copy this replaced dropped the device
    // suffix on @lid JIDs: it split "112713111982325:49@lid" into user and
    // device, then fell through to a JID_PAIR built from `user` alone, so every
    // device of a contact encoded to the identical "112713111982325@lid". The
    // server saw one repeated JID, returned a single device-0 bundle, and no
    // session was ever built for the other devices — leaving them unable to
    // decrypt anything we sent. jidStrToObj keeps the colon inside the user
    // part for @lid, which is what the server expects.
    const userNodes = jids.map(jid => new BinaryNode('user', { jid: jidStrToObj(jid) }, null));
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

  // ─── USync executor (Baileys WAUSync, mobile-API transport) ─────────────────
  //
  // Mirrors Baileys' socket.js `executeUSyncQuery`: it builds the <query> and
  // <list> nodes from the USyncQuery protocols/users, sends the IQ, and parses
  // the response through `usyncQuery.parseUSyncQueryResult`.  The difference is
  // purely the transport — whalibmob talks the WhatsApp *mobile* protocol, not
  // the web protocol — so three adaptations are applied:
  //
  //   1. Nodes use whalibmob's BinaryNode (`description` field) instead of the
  //      web `{ tag }` object literals.
  //   2. A trailing <side_list/> element and a `sid` on <usync> are REQUIRED —
  //      the mobile server silently drops usync IQs that omit them.
  //   3. <user jid="..."> attributes are encoded as JID objects (JID_PAIR) so
  //      the binary encoder emits proper JID bytes instead of raw UTF-8.
  //
  // Addressing note (mobile vs web):
  //   • Device discovery by phone uses USyncUser().withPhone() + the contact
  //     protocol → <user><contact>+phone</contact></user>.  The mobile server
  //     ignores the <user jid="..."> form for phone-based device discovery.
  //   • Discovery for an already-known routing JID (a LID) uses
  //     USyncUser().withId(jid) → <user jid="..."> exactly like Baileys.
  async executeUSyncQuery(usyncQuery) {
    if (!usyncQuery || usyncQuery.protocols.length === 0) {
      throw new Error('USyncQuery must have at least one protocol');
    }

    // Convert a WAUSync element ({ tag, attrs, content }) into a BinaryNode.
    // Array content is recursed into child nodes; strings/Buffers/null pass
    // through as leaf content.
    const toNode = (el) => {
      if (!el) return null;
      const content = Array.isArray(el.content)
        ? el.content.map(toNode).filter(Boolean)
        : (el.content !== undefined ? el.content : null);
      return new BinaryNode(el.tag, el.attrs || {}, content);
    };

    // Encode a jid string as a JID object so BinaryNode emits JID_PAIR bytes.
    const toJidObj = (jidStr) => {
      const str    = String(jidStr);
      const at     = str.indexOf('@');
      const raw    = at >= 0 ? str.slice(0, at) : str;
      const server = at >= 0 ? str.slice(at + 1) : 's.whatsapp.net';
      const colon  = raw.indexOf(':');
      const user   = colon >= 0 ? raw.slice(0, colon) : raw;
      const device = colon >= 0 ? (parseInt(raw.slice(colon + 1), 10) || 0) : 0;
      // AD_JID (agent+device) only for multi-device @s.whatsapp.net JIDs.
      if (server === 's.whatsapp.net' && device > 0) {
        return { user, agent: 0, device, server, toString() { return str; } };
      }
      return { user: (server === 'lid' && device > 0) ? raw : user, server, toString() { return str; } };
    };

    // <user> nodes — jid attr is set only when the user has no phone (Baileys:
    // `jid: !user.phone ? user.id : undefined`); phone users carry a <contact>
    // child instead, produced by the contact protocol's getUserElement.
    const userNodes = usyncQuery.users.map(user => {
      const children = usyncQuery.protocols
        .map(p => p.getUserElement(user))
        .filter(el => el !== null)
        .map(toNode);
      const attrs = {};
      if (!user.phone && user.id) attrs.jid = toJidObj(user.id);
      return new BinaryNode('user', attrs, children.length ? children : null);
    });

    const queryNode = new BinaryNode('query', {},
      usyncQuery.protocols.map(p => toNode(p.getQueryElement())));

    const iqId = this._client._genMsgId();
    const sid  = this._client._genMsgId();

    const iqNode = new BinaryNode('iq',
      { id: iqId, to: 's.whatsapp.net', type: 'get', xmlns: 'usync' },
      [new BinaryNode('usync',
        { sid, mode: usyncQuery.mode, last: 'true', index: '0', context: usyncQuery.context },
        [
          queryNode,
          new BinaryNode('list', {}, userNodes),
          // Mobile API requires <side_list/> — server ignores the IQ without it.
          new BinaryNode('side_list', {}, null)
        ]
      )]
    );

    const response = await this._client._sendIq(iqNode);
    if (!response) return null;
    return usyncQuery.parseUSyncQueryResult(response);
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
    // Build the device-discovery query exactly as Baileys does — via USyncQuery
    // and the device / LID / contact protocols — then run it through the
    // mobile-API executor and parse it with the shared parseUSyncQueryResult.
    //
    // Users are addressed by PHONE (USyncUser().withPhone → <contact>+phone</>)
    // because the WA *mobile* server silently drops usync IQs that address
    // users via the <user jid="..."> form for phone-based device discovery.
    const query = new USyncQuery()
      .withContext('interactive')
      .withDeviceProtocol()
      .withLIDProtocol()
      .withContactProtocol();
    for (const p of phones) {
      query.withUser(new USyncUser().withPhone('+' + p));
    }

    _whaDbg('[USYNC_IQ] phones=[' + phones.join(',') + ']');

    const parsed = await this.executeUSyncQuery(query).catch(err => {
      _whaDbg('[USYNC_ERR] ' + (err && err.message));
      return null;
    });

    if (!parsed || !Array.isArray(parsed.list)) {
      _whaDbg('[USYNC_NULL_RESP]');
      // Timed out / unparseable — fall back to contact usync for LID mapping.
      await this._doContactUsync(phones).catch(() => {});
    } else {
      for (let i = 0; i < parsed.list.length; i++) {
        const entry   = parsed.list[i];
        const userJid = entry && entry.id != null ? String(entry.id) : null;
        if (!userJid) continue;

        const isLidUser = userJid.endsWith('@lid');
        const { user: rawUser } = stripUser(userJid);

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

          // The LID protocol parser returns the <lid val=...> value — populate
          // both directions of the PN↔LID mapping and pre-seed the lid: cache
          // key so bulkEnsureSessionsForLid can skip a second IQ.
          const lidVal = entry.lid;
          if (lidVal) {
            const lidUser = (lidVal && lidVal.user)
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

        this._dcEnsure(cachePhone);

        // A server-side error means the device list is missing entirely — log it
        // so the device-0-only fallback below is diagnosable instead of silent.
        if (entry.devices && entry.devices.error) {
          _whaDbg('[USYNC_DEVICES_ERR] phone=' + cachePhone +
            ' code=' + entry.devices.error.code + ' ' + entry.devices.error.text);
        }

        const deviceList = entry.devices && Array.isArray(entry.devices.deviceList)
          ? entry.devices.deviceList
          : null;

        if (deviceList && deviceList.length) {
          for (const dev of deviceList) {
            const devId  = Number.isFinite(dev.id)       ? dev.id       : 0;
            const keyIdx = Number.isFinite(dev.keyIndex) ? dev.keyIndex : -1;
            // Mirror Baileys extractDeviceJids: keep device 0 or non-zero
            // devices that carry a valid key-index (otherwise the encrypt IQ
            // returns a bad-request / empty bundle for that device).
            if (devId === 0 || keyIdx > 0) {
              this._dcAdd(cachePhone, devId);
            }
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
      // Ask for the bundles by phone JID. The encrypt IQ is not answered at all
      // when its <user> entries are @lid — it just times out — while the same
      // request in phone form comes back in full. Translate through the known
      // LID→PN mapping, keeping a link back so each bundle is installed under
      // the LID address the participants node will use.
      const pnForLid = this._client._lidToPn && this._client._lidToPn.get(lidUser);
      const wireToLid = new Map();
      let wireJids = fetchJids;
      if (pnForLid) {
        wireJids = fetchJids.map(j => {
          const at    = j.indexOf('@');
          const base  = at >= 0 ? j.slice(0, at) : j;
          const colon = base.indexOf(':');
          const dev   = colon >= 0 ? (parseInt(base.slice(colon + 1), 10) || 0) : 0;
          const wire  = makeDeviceJid(pnForLid, dev, 's.whatsapp.net');
          wireToLid.set(wire, j);
          return wire;
        });
        _whaDbg('[DBG] LID_BUNDLE_VIA_PN lid=' + lidUser + ' pn=' + pnForLid +
          ' jids=[' + wireJids.join(',') + ']\n');
      } else {
        _whaDbg('[DBG] LID_BUNDLE_NO_PN lid=' + lidUser + ' — requesting by LID\n');
      }

      const bundles = await this.fetchBundles(wireJids);
      for (const [wireJid, bundle] of bundles) {
        // Install under the @lid address: that is what the outgoing
        // participants node — and therefore the encrypt step — looks the
        // session up by. Stored under the phone user it is a different Signal
        // address and would never be found.
        const jid = wireToLid.get(wireJid) || wireJid;
        try {
          await signalProto.buildSessionFromBundle(jid, bundle);
          // ── CRITICAL: remap bundle JID back to @lid format ────────────────────
          // fetchBundles always returns JIDs in @s.whatsapp.net format (because the
          // WA server uses its own AD_JID / JID_PAIR encoding in responses).
          // But the outer <message to="lidUser@lid"> requires ALL participant <to>
          // nodes to also use @lid format — mixing @s.whatsapp.net participants with
          // a @lid routing address causes the server to close the connection.
          //
          // A Signal address is (user, device) with the @server stripped — but
          // the user of a LID and the user of a phone JID are different strings,
          // so a session is NOT reachable under both. That assumption is what
          // left sends failing: bundles fetched in phone form were stored under
          // the phone user while the participants node looked them up by LID.
          // The session is installed under the @lid address above; this only
          // normalises the JID pushed into readyJids.
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
    // Contact-only fallback (device/lid protocols omitted): the plain contact
    // query is the form the mobile server reliably answers when the richer
    // device query times out.  Built via the shared Baileys USyncQuery builder.
    const query = new USyncQuery()
      .withContext('interactive')
      .withContactProtocol();
    for (const p of phones) {
      query.withUser(new USyncUser().withPhone('+' + p));
    }

    _whaDbg('[CONTACT_USYNC] phones=[' + phones.join(',') + ']');

    const parsed = await this.executeUSyncQuery(query).catch(err => {
      _whaDbg('[CONTACT_USYNC_ERR] ' + (err && err.message));
      return null;
    });

    if (!parsed || !Array.isArray(parsed.list)) {
      _whaDbg('[CONTACT_USYNC_NULL]');
      return;
    }

    for (let i = 0; i < parsed.list.length; i++) {
      const entry = parsed.list[i];
      const actualJidStr = entry && entry.id != null ? String(entry.id) : null;
      if (!actualJidStr) continue;

      const isLid = actualJidStr.endsWith('@lid');
      // For single-phone queries the phone is unambiguous; for multi-phone
      // queries match by list index (order preserved by parseUSyncQueryResult).
      const phone = phones.length === 1 ? phones[0] : phones[i];

      if (isLid) {
        const { user: lidUser } = stripUser(actualJidStr);
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
        _whaDbg('[DBG] CONTACT_USYNC_PN phone=' + phone + ' jid=' + actualJidStr);
      }
    }
    this._scheduleSave();
  }

  // ─── usync IQ for a specific JID (LID or phone-based) ─────────────────────
  // Used when we already know the routing JID and want to look up devices for it.
  async _doUsyncIqByJid(jid, cacheKey, lidUser) {
    const jidStr = typeof jid === 'string' ? jid : String(jid);

    // Discovery for an already-known routing JID (a LID) — addressed via
    // USyncUser().withId(jid) → <user jid="...">, exactly as Baileys'
    // getUSyncDevices does.  executeUSyncQuery encodes the jid attr as a
    // JID object so the mobile binary encoder emits proper JID_PAIR bytes.
    const query = new USyncQuery()
      .withContext('interactive')
      .withDeviceProtocol()
      .withLIDProtocol();
    query.withUser(new USyncUser().withId(jidStr));

    _whaDbg('[USYNC_LID_IQ] jid=' + jidStr);

    const parsed = await this.executeUSyncQuery(query).catch(err => {
      _whaDbg('[USYNC_LID_ERR] ' + (err && err.message));
      return null;
    });

    this._dcEnsure(cacheKey);

    if (parsed && Array.isArray(parsed.list) && parsed.list.length) {
      for (const entry of parsed.list) {
        if (entry.devices && entry.devices.error) {
          _whaDbg('[USYNC_LID_DEVICES_ERR] jid=' + jidStr +
            ' code=' + entry.devices.error.code + ' ' + entry.devices.error.text);
        }

        const deviceList = entry.devices && Array.isArray(entry.devices.deviceList)
          ? entry.devices.deviceList
          : null;

        if (deviceList && deviceList.length) {
          for (const dev of deviceList) {
            const devId  = Number.isFinite(dev.id)       ? dev.id       : 0;
            const keyIdx = Number.isFinite(dev.keyIndex) ? dev.keyIndex : -1;
            if (devId === 0 || keyIdx > 0) {
              this._dcAdd(cacheKey, devId);
            }
          }
          _whaDbg('[USYNC_LID_DEVICES] jid=' + jidStr +
            ' ids=[' + (this._dcGet(cacheKey) || []).join(',') + ']');
        } else {
          this._dcAdd(cacheKey, 0);
          _whaDbg('[USYNC_LID_NO_DEVLIST] jid=' + jidStr + ' → device 0 only');
        }
      }
    } else {
      _whaDbg('[USYNC_LID_NULL_RESP] jid=' + jidStr);
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
