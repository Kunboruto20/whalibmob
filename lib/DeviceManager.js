'use strict';

const { BinaryNode } = require('./BinaryNode');

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

function phoneFromJid(jid) {
  const { user } = stripUser(jid);
  return user;
}

// ─── Bundle parsing ───────────────────────────────────────────────────────────

function findChild(node, desc) {
  if (!node || !Array.isArray(node.content)) return null;
  return node.content.find(c => c && c.description === desc) || null;
}

function findChildren(node, desc) {
  if (!node || !Array.isArray(node.content)) return [];
  return node.content.filter(c => c && c.description === desc);
}

// Recursively locate the first descendant node with the given description.
function findDeep(node, desc) {
  if (!node) return null;
  if (node.description === desc) return node;
  if (!Array.isArray(node.content)) return null;
  for (const child of node.content) {
    const hit = findDeep(child, desc);
    if (hit) return hit;
  }
  return null;
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
    // phone → Set<deviceId>  (populated after first usync)
    this._deviceCache   = new Map();
    // phone → Promise<jids[]>  (in-flight usync dedup)
    this._usyncInflight = new Map();
    // own device list cache (populated once per connection)
    this._ownDeviceJids = null;
  }

  // ─── Fetch pre-key bundles for a list of JIDs via encrypt IQ ───────────────
  // Only called for JIDs where no Signal session exists yet.
  // Returns Map<jid, bundle>
  async fetchBundles(jids) {
    if (!jids || jids.length === 0) return new Map();

    const userNodes = jids.map(jid => { const lidMatch = jid.match(/(\d{15,})@s\.whatsapp\.net/); return new BinaryNode('user', { jid }, null); });
    const iqId   = this._client._genMsgId();
    const iqNode = new BinaryNode('iq',
      { id: iqId, xmlns: 'encrypt', type: 'get', to: 's.whatsapp.net' },
      [new BinaryNode('key', {}, userNodes)]
    );

    const response = await this._client._sendIq(iqNode);
    const bundles  = new Map();
    if (!response) return bundles;

    const listNode = findChild(response, 'list');
    const children = listNode ? listNode.content : (response.content || []);
    for (const userNode of (Array.isArray(children) ? children : [])) {
      if (!userNode || userNode.description !== 'user') continue;
      const jid = userNode.attrs && userNode.attrs.jid;
      if (!jid) continue;
      const bundle = parseBundleFromUserNode(userNode);
      if (bundle) bundles.set(jid, bundle);
    }
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
    // Fast path: all phones cached
    const uncached = phones.filter(p => !this._deviceCache.has(p));
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
      const devices = this._deviceCache.get(p);
      if (devices && devices.size > 0) {
        for (const dev of devices) jids.push(makeDeviceJid(p, dev));
      } else {
        jids.push(makeDeviceJid(p, 0));
      }
    }
    return jids.length > 0 ? jids : phones.map(p => makeDeviceJid(p, 0));
  }

  // Actual usync IQ — only called for phones NOT in _deviceCache
  //
  // Query structure (matches the WhatsApp mobile / MD protocol as used by
  // WhatsApp Web and Baileys):
  //
  //   <iq xmlns='usync' type='get' to='s.whatsapp.net'>
  //     <usync sid mode='query' last='true' index='0' context='message'>
  //       <query><devices version='2'/></query>   ← empty protocol marker
  //       <list>
  //         <user jid='PHONE@s.whatsapp.net'/>     ← one per requested phone
  //       </list>
  //     </usync>
  //   </iq>
  //
  // The response nests the actual device list under each user:
  //
  //   <usync><list>
  //     <user jid='PHONE@s.whatsapp.net'>
  //       <devices><device-list>
  //         <device id='0'/>
  //         <device id='11' key-index='2'/>        ← linked device
  //       </device-list></devices>
  //     </user>
  //   </list></usync>
  //
  // The previous implementation looked for a `jid` attribute on <device>
  // nodes, but devices are identified by an `id` attribute with the JID on
  // the parent <user>. As a result no linked devices were ever extracted and
  // every recipient collapsed to device 0 only — messages reached the primary
  // phone but linked devices showed "waiting for this message".
  async _doUsyncIq(phones) {
    const iqId = this._client._genMsgId();
    const sid  = this._client._genMsgId();

    const listChildren = phones.map(p =>
      new BinaryNode('user', { jid: makeDeviceJid(p, 0) }, null)
    );

    const iqNode = new BinaryNode('iq',
      { id: iqId, to: 's.whatsapp.net', type: 'get', xmlns: 'usync' },
      [new BinaryNode('usync',
        { sid, mode: 'query', last: 'true', index: '0', context: 'message' },
        [
          new BinaryNode('query', {},
            [new BinaryNode('devices', { version: '2' }, null)]
          ),
          new BinaryNode('list', {}, listChildren)
        ]
      )]
    );

    const response = await this._client._sendIq(iqNode).catch(() => null);

    if (response) this._ingestUsyncResponse(response);

    // For any phone that returned no devices, cache device=0 so we don't query
    // again and so a send still reaches at least the primary device.
    for (const p of phones) {
      if (!this._deviceCache.has(p)) {
        this._deviceCache.set(p, new Set([0]));
      }
    }
  }

  // Parse a usync IQ response and populate _deviceCache.
  // Extracts every <device id='N'> under each <user jid='...'>. Non-zero
  // devices are only accepted when a key-index is present (mirrors the
  // server contract — a bad request results otherwise). Exposed as a method
  // so it can be unit-tested with a synthesized response node.
  _ingestUsyncResponse(response) {
    const usync = findDeep(response, 'usync');
    const list  = usync ? findChild(usync, 'list') : findDeep(response, 'list');
    const users = list ? findChildren(list, 'user') : [];

    for (const userNode of users) {
      const jid = userNode.attrs && userNode.attrs.jid;
      if (!jid) continue;
      const { user } = stripUser(jid);

      const devicesNode = findChild(userNode, 'devices');
      const deviceList  = devicesNode ? findChild(devicesNode, 'device-list') : null;
      const deviceNodes = deviceList ? findChildren(deviceList, 'device') : [];

      const set = this._deviceCache.get(user) || new Set();
      // Always include the primary device.
      set.add(0);
      for (const dev of deviceNodes) {
        const idAttr = dev.attrs && dev.attrs.id;
        if (idAttr == null) continue;
        const device = parseInt(idAttr, 10);
        if (Number.isNaN(device)) continue;
        if (device === 0) { set.add(0); continue; }
        // Non-zero devices require a key-index to be addressable.
        const hasKeyIndex = dev.attrs && dev.attrs['key-index'] != null;
        if (hasKeyIndex) set.add(device);
      }
      this._deviceCache.set(user, set);
    }
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

  // ─── Ensure sessions for own linked devices (device != 0) ─────────────────
  //
  // OPTIMISATION: own device list is cached for the entire connection lifetime.
  //   On the first call we query usync, on all subsequent calls we return
  //   from cache — zero extra network round-trips.
  //
  async ensureOwnDeviceSessions(ownPhone, signalProto, allowPkmsg = true) {
    // If own device list is already cached, use it directly
    if (this._ownDeviceJids !== null) {
      const others = this._ownDeviceJids.filter(j => stripUser(j).device !== 0);
      return this._ensureSessions(others, signalProto, allowPkmsg);
    }

    // First call: query usync for own devices (same as before, but we cache the result)
    const deviceJids   = await this._usyncGetDevices([ownPhone]);
    this._ownDeviceJids = deviceJids;

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
      this._deviceCache.clear();
      this._ownDeviceJids = null;
    } else {
      for (const p of phones) this._deviceCache.delete(p);
    }
  }

  // ─── Build participants node ───────────────────────────────────────────────
  static buildParticipantsNode(encryptedList, mediaSubtype) {
    const toNodes = encryptedList.map(({ jid, type, ciphertext }) => {
      const encAttrs = { type, v: '2' };
      if (mediaSubtype) encAttrs.mediatype = mediaSubtype;
      return new BinaryNode('to', { jid },
        [new BinaryNode('enc', encAttrs, ciphertext)]
      );
    });
    return new BinaryNode('participants', {}, toNodes);
  }
}

module.exports = { DeviceManager, makeDeviceJid, stripUser, phoneFromJid, parseBundleFromUserNode };
