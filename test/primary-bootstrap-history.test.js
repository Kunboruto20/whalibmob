'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// The primary bootstraps a newly linked companion with the history it holds:
// inline up to 64 KiB deflated, an md-msg-hist blob above that. What goes out
// is pinned on disk first, so a resume sends those bytes and no others, and a
// step whose outcome is unknown is never sent again without being asked to.
//
// The companion side is the same synthetic protocol peer as in
// primary-linking.test.js, copied here, with a critical_block that keeps the
// patches written to it. The notifications are read back with the fixture
// schema, not with the library.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { WhalibmobClient } = require('../lib/Client');
const { createNewStore } = require('../lib/Store');
const { BinaryNode } = require('../lib/BinaryNode');
const P = require('../lib/PairingCode');
const C = require('../lib/PrimaryLinkCrypto');
const { configureSuccessfulPairing } = require('../lib/CompanionPairing');
const { AppStateStore } = require('../lib/appstate/AppStateStore');
const Sync = require('../lib/appstate/AppStateSync');
const { pushNamePatch } = require('../lib/appstate/Mutations');
const { newState } = require('../lib/appstate/LTHash');
const { decodeFields, decodeMessageContainer, field, varint, WIRE_LEN, WIRE_VARINT } = require('../lib/proto/MessageProto');
const SyncdProto = require('../lib/appstate/SyncdProto');
const Bootstrap = require('../lib/PrimaryBootstrap');
const { INLINE_MAX, buildHistorySync } = require('../lib/primary/HistoryExport');
const { type } = require('./helpers/history-proto');

const PHONE = '15550000123';
const ANA = '40799999999@s.whatsapp.net';
const GROUP = '120363000000000000@g.us';
const T = 1790000000;
const EMPTY = { source: 'owned_primary_store', messageCount: 0, conversationCount: 0 };

// ─── the synthetic peer (after primary-linking.test.js) ─────────────────────

// server holds critical_block as patches written to it, at the version the
// server gave them, or as a snapshot blob reference. hangPatch: 'applied'
// keeps the write and never answers it, 'lost' drops it and never answers it.
// refusePatch: 'iq' answers the write with an IQ error, 'node' with an error
// inside a result; either way nothing is kept.
// control.hangAck / control.ackError pick the peer messages whose ACK never
// comes or refuses.
async function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'primary-history-test-'));
    fs.chmodSync(dir, 0o700);
    const client = new WhalibmobClient({ sessionDir: dir, refreshVersion: false });
    client._store = createNewStore(PHONE);
    client._store.registered = true;
    client._myLid = '1234567890@lid';
    client._connected = true;
    client._scheduleReconnect = () => { };
    const identity = P.generateEphemeralKeyPair(), noise = P.generateEphemeralKeyPair(), ephemeral = P.generateEphemeralKeyPair();
    const code = 'K7M2QX4B', ref = Buffer.from('synthetic-independent-companion-ref');
    const wrapped = await P.buildWrappedEphemeralPub(code, ephemeral.public);
    const control = { hangAck: null, ackError: null };
    const server = { version: 0, patches: [], snapshot: null, hangPatch: false, refusePatch: null, unversioned: false };
    const requests = [];
    let linked = false, messageCount = 0, companionSecret = null;
    const reply = (query, content = []) => client._handleIq(new BinaryNode('iq', { id: query.attrs.id, type: 'result', from: 's.whatsapp.net' }, content));
    const devices = () => [new BinaryNode('device', { id: '0' }, null), ...(linked ? [new BinaryNode('device', { id: '7', 'key-index': '1' }, null)] : [])];
    // unversioned: answer a read the way the live server does, with no version
    // on the collection (the version is carried by the patches and snapshot).
    const collection = content => new BinaryNode('sync', {}, [new BinaryNode('collection',
        server.unversioned ? { name: 'critical_block' } : { name: 'critical_block', version: String(server.version) }, content)]);
    client._socket = { close: () => client._onClose(), sendNode(node) {
            requests.push(node);
            if (node.description === 'message') {
                const n = ++messageCount;
                const error = control.ackError && control.ackError(node, n);
                if (!(control.hangAck && control.hangAck(node, n)))
                    queueMicrotask(() => client._handleAck(new BinaryNode('ack', { id: node.attrs.id, class: 'message', from: PHONE + '@s.whatsapp.net', ...(error ? { error } : {}) }, null)));
                return;
            }
            if (node.description !== 'iq') return;
            queueMicrotask(async () => {
                try {
                    if (node.attrs.xmlns === 'passive') { reply(node); return; }
                    if (node.attrs.xmlns === 'usync') {
                        const sync = C.child(node, 'usync');
                        reply(node, [new BinaryNode('usync', { sid: sync.attrs.sid }, [new BinaryNode('list', {}, [
                            new BinaryNode('user', { jid: PHONE + '@s.whatsapp.net' }, [new BinaryNode('devices', {}, [new BinaryNode('device-list', {}, devices())])])
                        ])])]);
                        return;
                    }
                    if (node.attrs.xmlns === 'w:sync:app:state') {
                        const patch = C.optionalChild(C.child(C.child(node, 'sync'), 'collection'), 'patch');
                        if (patch) {
                            // The server assigns the version a patch is kept at.
                            const keep = () => { server.version += 1; server.patches.push(withVersion(patch.content, server.version)); };
                            if (server.hangPatch) { if (server.hangPatch === 'applied') keep(); return; }
                            if (server.refusePatch === 'iq') {
                                client._handleIq(new BinaryNode('iq', { id: node.attrs.id, type: 'error', from: 's.whatsapp.net' }, [new BinaryNode('error', { code: '400' }, null)]));
                                return;
                            }
                            if (server.refusePatch === 'node') { reply(node, [collection([new BinaryNode('error', { code: '400' }, null)])]); return; }
                            keep();
                            reply(node, [collection(null)]);
                            return;
                        }
                        const held = [...(server.snapshot ? [new BinaryNode('snapshot', {}, server.snapshot)] : []),
                            ...(server.patches.length ? [new BinaryNode('patches', {}, server.patches.map(p => new BinaryNode('patch', {}, p)))] : [])];
                        reply(node, [collection(held.length ? held : null)]);
                        return;
                    }
                    const hello = C.optionalChild(node, 'link_code_companion_reg');
                    if (hello) {
                        const finish = await P.buildCompanionFinishBundle({ pairingCode: code, pairingEphemeralPrivate: ephemeral.private, primaryEphemeralPubWrapped: C.payload(hello, 'link_code_pairing_wrapped_primary_ephemeral_pub', 80), primaryIdentityPub: C.payload(hello, 'primary_identity_pub', 32), identityKeyPair: identity });
                        companionSecret = finish.advSecretKey;
                        reply(node);
                        queueMicrotask(() => client._handleNotification(new BinaryNode('notification', { id: 'finish-notification', from: 's.whatsapp.net', type: 'link_code_companion_reg' }, [
                            new BinaryNode('link_code_companion_reg', { stage: 'companion_finish' }, [
                                new BinaryNode('link_code_pairing_ref', {}, ref), new BinaryNode('companion_identity_public', {}, identity.public), new BinaryNode('link_code_pairing_wrapped_key_bundle', {}, finish.wrappedKeyBundle)
                            ])
                        ])));
                        return;
                    }
                    // Run the unmodified companion's pair-success implementation.
                    const pair = C.child(node, 'pair-device');
                    configureSuccessfulPairing(new BinaryNode('iq', { id: 'independent-companion-pair-success' }, [
                        new BinaryNode('pair-success', {}, [
                            new BinaryNode('device-identity', {}, C.child(pair, 'device-identity').content),
                            new BinaryNode('device', { jid: PHONE + ':7@s.whatsapp.net', lid: '1234567890:7@lid' }, null)
                        ])
                    ]), { advSecretKey: companionSecret, identityKeyPair: identity }, BinaryNode);
                    linked = true;
                    reply(node, [new BinaryNode('device', { jid: '1234567890:7@lid' }, null)]);
                } catch (error) {
                    client._pendingIqs.get(node.attrs.id)?.(null);
                    t.diagnostic('synthetic peer failure: ' + (error.code || error.name));
                }
            });
        } };
    client._handleNotification(new BinaryNode('notification', { id: 'hello-notification', from: 's.whatsapp.net', type: 'link_code_companion_reg' }, [
        new BinaryNode('link_code_companion_reg', { stage: 'companion_hello' }, [
            new BinaryNode('link_code_pairing_ref', {}, ref), new BinaryNode('companion_server_auth_key_pub', {}, noise.public), new BinaryNode('link_code_pairing_wrapped_companion_ephemeral_pub', {}, wrapped)
        ])
    ]));
    t.after(() => { client.disconnect(); fs.rmSync(dir, { recursive: true, force: true }); });
    return { client, dir, code, identity, requests, control, server, invitation: client.getPrimaryLinkInvitations()[0], removeServerDevice() { linked = false; } };
}
async function bootstrapFixture(t) {
    const f = await fixture(t);
    f.client._store.name = 'Local Primary';
    f.client._appState = new AppStateStore(path.join(f.dir, PHONE + '.appState.json'));
    f.client._devMgr = { async fetchBundles(jids) { return new Map([[jids[0], { identityKey: f.identity.public }]]); } };
    f.client._signal = { async hasSession() { return false; }, async buildSessionFromBundle() {}, async encrypt(jid, plaintext) { return { type: 'pkmsg', ciphertext: Buffer.from(plaintext) }; } };
    // The default md-msg-hist upload: every RECENT chunk goes up by it, and a
    // large history when the test gives no upload of its own.
    f.uploads = [];
    f.client._sender = { async _uploadMedia(kind, buf) { const done = fakeUpload(buf); f.uploads.push({ kind, buf, done }); return done; } };
    await f.client.approveCompanionCode(f.code, { invitationId: f.invitation.id });
    return f;
}
function withVersion(patch, version) {
    return Buffer.concat([field(1, WIRE_LEN, field(1, WIRE_VARINT, varint(version))), patch]);
}

// ─── reading what went out ──────────────────────────────────────────────────

const messages = f => f.requests.filter(n => n.description === 'message');
const patchWrites = f => f.requests.filter(n => n.description === 'iq' && n.attrs.xmlns === 'w:sync:app:state' && C.optionalChild(C.child(C.child(n, 'sync'), 'collection'), 'patch'));
const plain = m => C.child(m, 'enc').content;   // the fixture's Signal is the identity
const journal = f => f.client._primaryLinking.journal.snapshot();
const outboxFile = f => path.join(f.dir, PHONE + '.primary-history-outbox.json');
const keyFile = f => path.join(f.dir, PHONE + '.appStateKeys.json');
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
// Every file the account keeps in its session directory, as text.
const sessionText = f => fs.readdirSync(f.dir).map(name => fs.readFileSync(path.join(f.dir, name), 'utf8')).join('\n');
function notificationOf(m) {
    const M = type('Message');
    const message = M.toObject(M.decode(plain(m)), { longs: Number });
    assert.equal(message.protocolMessage.type, 5);
    return message.protocolMessage.historySyncNotification;
}
// The bytes a notification carries: inline, or the blob it points at, as the
// synthetic upload was given them.
function payloadOf(hsn) {
    if (hsn.initialHistBootstrapInlinePayload) return hsn.initialHistBootstrapInlinePayload;
    const stored = blobs.get(Buffer.from(hsn.mediaKey).toString('hex'));
    assert.ok(stored, 'the notification points at no blob that was uploaded');
    return stored.buf;
}
// The HistorySync, with each chat's messages in the order they happened, by
// msgOrderID (the wire carries them newest first, pinned in
// primary-history-export.test.js).
function historyOf(hsn) {
    const H = type('HistorySync');
    const history = H.toObject(H.decode(zlib.inflateSync(payloadOf(hsn))), { longs: Number });
    for (const conv of history.conversations || []) if (conv.messages) conv.messages.sort((a, b) => a.msgOrderID - b.msgOrderID);
    return history;
}
const messageIds = history => history.conversations.flatMap(c => (c.messages || []).map(m => m.message.key.ID));
// The RECENT chunk at 100% that follows every history: Web counts the history
// as synced only once one has come. Always a blob, never inline: Web left one
// sent inline at "downloading" for good. The notification points at exactly
// what was uploaded, and it and the chunk both say RECENT at 100%; what the
// chunk carries is returned.
function recentOf(m) {
    const hsn = notificationOf(m);
    assert.equal(hsn.syncType, 3);
    assert.equal(hsn.progress, 100);
    assert.equal(hsn.initialHistBootstrapInlinePayload, undefined);
    const buf = payloadOf(hsn), { done } = blobs.get(Buffer.from(hsn.mediaKey).toString('hex'));
    assert.equal(hsn.directPath, done.directPath);
    assert.deepEqual(hsn.fileSHA256, crypto.createHash('sha256').update(buf).digest());
    assert.deepEqual(hsn.fileEncSHA256, done.fileEncSha256);
    assert.equal(hsn.fileLength, buf.length);
    const chunk = historyOf(hsn);
    assert.equal(chunk.syncType, 3);
    assert.equal(chunk.progress, 100);
    return chunk;
}
// One that carries nothing at all: what follows a history no delta was asked for.
// Its chunkOrder is 1: Web processes a RECENT chunk only as 1 once the initial
// bootstrap is in, or as the one after the last it processed, so a chunk 0 sat
// in its queue unprocessed for good (found live).
const EMPTY_RECENT = { syncType: 3, chunkOrder: 1, progress: 100 };
function keyShareOf(m) {
    const key = decodeMessageContainer(plain(m)).appStateSyncKeyShare.keys[0];
    const pm = decodeFields(decodeFields(plain(m))[12]);
    const fingerprint = decodeFields(decodeFields(decodeFields(decodeFields(pm[7])[1])[2])[2]);
    return { ...key, fingerprint: { rawId: fingerprint[1], currentIndex: fingerprint[2], validIndexes: [...fingerprint[3]] } };
}

// ─── snapshots ──────────────────────────────────────────────────────────────

// A Snapshot in the shape PrimaryMessageStore.snapshot() returns it.
function snapshot({ seq = 0, chats = [], records = {}, pushNames = [] } = {}) {
    let count = 0;
    for (const list of Object.values(records)) count += list.length;
    return { seq, capture: { since: T * 1000, origin: 'enabled', lc: 0 }, chats, records, losses: [], retained: { evicted: 0 }, pushNames, counts: { chats: chats.length, records: count } };
}
function textMessage(text) {
    const M = type('Message');
    return Buffer.from(M.encode(M.create({ conversation: text })).finish());
}
function rec(id, seq, ts, extra = {}) {
    return { id, seq, fromMe: false, ts, status: 3, raw: textMessage('text of ' + id), ...extra };
}
function chatSnapshot(count) {
    const records = [];
    for (let i = 1; i <= count; i++) records.push(rec('M' + i, i, T + i));
    return snapshot({ seq: count, chats: [{ id: ANA, name: 'Ana', conversationTimestamp: T + count, unreadCount: 0 }], records: { [ANA]: records } });
}
// Bytes deflate cannot shrink, from a fixed seed.
function incompressible(n) {
    const out = [];
    let h = Buffer.from('history-blob-seed');
    for (let len = 0; len < n; len += 32) { h = crypto.createHash('sha256').update(h).digest(); out.push(h); }
    return Buffer.concat(out).subarray(0, n);
}
// A snapshot whose deflated HistorySync is exactly `target` bytes.
function sized(target) {
    let n = target - 100;
    for (let i = 0; i < 40; i++) {
        const snap = snapshot({ seq: 1, chats: [{ id: ANA, conversationTimestamp: T, unreadCount: 0 }], records: { [ANA]: [rec('BIG', 1, T, { raw: incompressible(n) })] } });
        const size = buildHistorySync(snap).length;
        if (size === target) return snap;
        n += target - size;
    }
    assert.fail('no snapshot deflates to ' + target + ' bytes');
}
// What each synthetic upload was given and answered, by its media key (one of
// its own, unlike the bytes): a notification that points at a blob is read
// back from here.
const blobs = new Map();
function fakeUpload(buf) {
    const digest = crypto.createHash('sha256').update(buf).digest();
    const done = { url: 'https://mmg.whatsapp.net/synthetic', directPath: '/v/t62.synthetic/' + digest.toString('hex').slice(0, 16), mediaKey: crypto.randomBytes(32),
        fileSha256: digest, fileEncSha256: crypto.randomBytes(32), fileLength: buf.length, mediaKeyTimestamp: T };
    blobs.set(done.mediaKey.toString('hex'), { buf: Buffer.from(buf), done });
    return done;
}

// ─── stopping a bootstrap part-way ──────────────────────────────────────────

async function until(check) {
    for (let i = 0; i < 5000 && !check(); i++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(check(), 'condition never became true');
}
// The journal write that would enter `phase` fails once, as a full disk would.
function failPhaseOnce(f, phase) {
    const store = f.client._primaryLinking.journal, update = store.update.bind(store);
    let armed = true;
    store.update = change => {
        if (armed) {
            const next = store.snapshot();
            change(next);
            if (next.transaction?.bootstrap?.phase === phase) { armed = false; throw C.failure('PRIMARY_LINK_STORE_WRITE_FAILED'); }
        }
        return update(change);
    };
}
// The n-th peer message goes out and its ACK never comes; the caller aborts.
async function stopUnacked(f, n, options) {
    f.control.hangAck = (node, i) => i === n;
    const abort = new AbortController();
    const run = f.client.bootstrapPrimaryCompanion({ ...options, signal: abort.signal });
    await until(() => messages(f).length >= n);
    abort.abort();
    await assert.rejects(run, { code: 'PRIMARY_LINK_ABORTED' });
    f.control.hangAck = null;
}
// The patch write goes out and is never answered; the caller aborts.
async function stopPatch(f, hang, options) {
    f.server.hangPatch = hang;
    const abort = new AbortController();
    const run = f.client.bootstrapPrimaryCompanion({ ...options, signal: abort.signal });
    await until(() => patchWrites(f).length === 1);
    abort.abort();
    await assert.rejects(run, { code: 'PRIMARY_LINK_ABORTED' });
    f.server.hangPatch = false;
}

// ─── re-link ────────────────────────────────────────────────────────────────

// What an account that linked Web before holds: our own key, shared under an
// older ADV index, and critical_block at version 1 written with it.
function previousLink(f) {
    const tx = journal(f).transaction, keyId = Buffer.from('a1b2c3d4e5f6', 'hex'), keyData = crypto.randomBytes(32);
    fs.writeFileSync(keyFile(f), JSON.stringify({ a1b2c3d4e5f6: { keyData: keyData.toString('base64'), timestamp: T * 1000,
        fingerprint: { rawId: tx.state.rawId, currentIndex: 5, deviceIndexes: [0, 5] }, source: 'primary_bootstrap' } }), { mode: 0o600 });
    const built = Sync.buildPatch(pushNamePatch('Local Primary'), keyId, keyData, f.client._appState.get('critical_block'));
    f.client._appState.set('critical_block', built.state);
    return { tx, keyId, keyData, built };
}

// The same state as a SyncdSnapshot blob, its MAC made with macKeyData.
const len = (n, data) => field(n, WIRE_LEN, data);
function snapshotBlob(ours, macKeyData) {
    const m = SyncdProto.decodePatch(ours.built.patch).mutations[0], keyId = len(1, ours.keyId);
    const mac = Sync.snapshotMac(ours.built.state.hash, 1, 'critical_block', Sync.mutationKeys(macKeyData).snapshotMacKey);
    return Buffer.concat([len(1, field(1, WIRE_VARINT, varint(1))), len(2, Buffer.concat([len(1, len(1, m.indexBlob)), len(2, len(1, m.valueBlob)), len(3, keyId)])), len(3, mac), len(4, keyId)]);
}

// ─── tests ──────────────────────────────────────────────────────────────────

test('empty history in first mode sends the live-validated bytes', async t => {
    const f = await bootstrapFixture(t);
    const result = await f.client.bootstrapPrimaryCompanion({ history: async () => snapshot() });
    assert.deepEqual(result, { status: 'sent', mode: 'first', operationId: journal(f).transaction.id,
        history: { chats: 0, records: 0, bytes: buildHistorySync(snapshot()).length, inline: true, losses: 0, evicted: 0, captureOrigin: 'enabled' }, delta: null });
    const sent = messages(f);
    assert.equal(sent.length, 3);
    assert.equal(keyShareOf(sent[0]).keyData.length, 32);
    assert.equal(patchWrites(f).length, 1);
    // Key share, critical_block patch, then the history: its bytes are the
    // ones WhatsApp Web accepted live. Then the RECENT chunk that completes
    // it, empty: no delta was asked for.
    assert.deepEqual(plain(sent[1]), Bootstrap.initialHistory(EMPTY));
    assert.deepEqual(recentOf(sent[2]), EMPTY_RECENT);
    assert.equal(journal(f).transaction.bootstrap.phase, 'sent');
    assert.equal(fs.existsSync(outboxFile(f)), false, 'nothing is left pinned once it is sent');
});

test('store history is delivered inline with the recorded chats', async t => {
    const f = await bootstrapFixture(t);
    const snap = snapshot({ seq: 7,
        chats: [{ id: ANA, name: 'Ana', conversationTimestamp: T + 30, unreadCount: 1, pnJid: ANA, lidJid: '111@lid' }, { id: GROUP, name: 'Group', conversationTimestamp: T + 20, unreadCount: 0 }],
        records: { [ANA]: [rec('A1', 1, T + 10), rec('A2', 5, T + 30, { fromMe: true, status: 4 })], [GROUP]: [rec('G1', 3, T + 20, { participant: ANA, pushName: 'Ana' })] },
        pushNames: [{ id: ANA, pushname: 'Ana' }] });
    f.client._messageStore = { snapshot: () => snap };
    const result = await f.client.bootstrapPrimaryCompanion({ history: 'store' });
    assert.deepEqual(result.history, { chats: 2, records: 3, bytes: buildHistorySync(snap).length, inline: true, losses: 0, evicted: 0, captureOrigin: 'enabled' });
    const hsn = notificationOf(messages(f)[1]);
    assert.equal(hsn.syncType, 0);
    assert.equal(hsn.progress, 100);
    assert.equal(hsn.directPath, undefined);
    const history = historyOf(hsn);
    assert.deepEqual(history.conversations.map(c => c.ID), [ANA, GROUP]);
    assert.deepEqual(messageIds(history), ['A1', 'A2', 'G1']);
    assert.deepEqual(history.conversations[0].messages[0].message.message, textMessage('text of A1'));
    assert.deepEqual(history.pushnames, [{ ID: ANA, pushname: 'Ana' }]);
    assert.deepEqual(history.phoneNumberToLidMappings, [{ pnJID: ANA, lidJID: '111@lid' }]);

    // No store, no bootstrap: nothing is sent and nothing is recorded.
    const g = await bootstrapFixture(t), before = g.requests.length;
    g.client._messageStore = null;
    await assert.rejects(g.client.bootstrapPrimaryCompanion({ history: 'store' }), { code: 'PRIMARY_MESSAGE_STORE_DISABLED' });
    assert.equal(g.requests.length, before);
    assert.equal(journal(g).transaction.bootstrap, undefined);
});

// The handshake before the history (device list, key share, the patch) takes
// seconds, and messages keep arriving. What the store kept by the time the
// history is pinned goes, not only what it held when the bootstrap started.
test('a message stored after the bootstrap started and before the history was pinned goes over', async t => {
    const { PrimaryMessageStore } = require('../lib/primary/MessageStore');
    const f = await bootstrapFixture(t);
    const store = PrimaryMessageStore.open({ dir: f.dir, phone: PHONE });
    t.after(() => store.close());
    store.recordIncoming({ id: 'BEFORE', chat: ANA, ts: T + 1, raw: textMessage('before the link'), info: { kind: 'content' } });
    f.client._messageStore = store;
    // Recorded as the key share goes out: after the start, before the pin.
    f.control.ackError = (node, n) => {
        if (n === 1) store.recordIncoming({ id: 'DURING', chat: ANA, ts: T + 2, raw: textMessage('during the handshake'), info: { kind: 'content' } });
        return null;
    };
    const result = await f.client.bootstrapPrimaryCompanion({ history: 'store' });
    const history = historyOf(notificationOf(messages(f)[1]));
    assert.deepEqual(messageIds(history), ['BEFORE', 'DURING']);
    assert.equal(result.history.records, 2);
    assert.deepEqual(journal(f).transaction.bootstrap.history.cutoff, { seq: store.snapshot().seq });

    // Read at the start and fine then, refused by the encoder at the pin: the
    // key share and the patch went, the history did not, and a resume reads
    // the store again.
    const g = await bootstrapFixture(t), good = chatSnapshot(2);
    const broken = snapshot({ seq: 3, chats: good.chats, records: { [ANA]: [{ id: 'NORAW', seq: 3, fromMe: false, ts: T, status: 3 }] } });
    let calls = 0;
    await assert.rejects(g.client.bootstrapPrimaryCompanion({ history: async () => (calls++ === 0 ? good : broken) }),
        e => e.code === 'PRIMARY_BOOTSTRAP_HISTORY_INVALID' && e.cause?.code === 'PRIMARY_HISTORY_EXPORT_SNAPSHOT_INVALID');
    assert.equal(calls, 2);
    assert.equal(messages(g).length, 1, 'only the key share went');
    assert.equal(journal(g).transaction.bootstrap.phase, 'critical_patch_accepted');
    assert.equal(journal(g).transaction.bootstrap.errorCode, 'PRIMARY_BOOTSTRAP_HISTORY_INVALID');
    assert.equal(fs.existsSync(outboxFile(g)), false);
    // Not a snapshot at all, at the pin: the same.
    const h = await bootstrapFixture(t);
    let reads = 0;
    await assert.rejects(h.client.bootstrapPrimaryCompanion({ history: async () => (reads++ === 0 ? good : { seq: -1 }) }), { code: 'PRIMARY_BOOTSTRAP_HISTORY_INVALID' });
    assert.equal(messages(h).length, 1);
    const resumed = await g.client.bootstrapPrimaryCompanion({ history: async () => good, resume: true });
    assert.equal(resumed.history.records, 2);
    assert.equal(messages(g).length, 3);
    assert.deepEqual(recentOf(messages(g)[2]), EMPTY_RECENT);
    assert.equal(patchWrites(g).length, 1);
});

test('deflated size 65537 selects the blob path', async t => {
    const f = await bootstrapFixture(t), snap = sized(INLINE_MAX + 1), bytes = buildHistorySync(snap), uploads = [];
    // The default upload is the md-msg-hist media upload: the history's, then
    // the RECENT chunk's.
    f.client._sender = { async _uploadMedia(kind, buf) { const done = fakeUpload(buf); uploads.push({ kind, buf, done }); return done; } };
    const result = await f.client.bootstrapPrimaryCompanion({ history: async () => snap });
    assert.equal(uploads.length, 2);
    assert.deepEqual(uploads.map(u => u.kind), ['md-msg-hist', 'md-msg-hist']);
    assert.deepEqual(uploads[0].buf, bytes);
    assert.deepEqual(recentOf(messages(f)[2]), EMPTY_RECENT);
    assert.deepEqual(notificationOf(messages(f)[2]).mediaKey, uploads[1].done.mediaKey);
    assert.deepEqual(result.history, { chats: 1, records: 1, bytes: 65537, inline: false, losses: 0, evicted: 0, captureOrigin: 'enabled' });
    const hsn = notificationOf(messages(f)[1]);
    assert.equal(hsn.directPath, uploads[0].done.directPath);
    assert.deepEqual(hsn.mediaKey, uploads[0].done.mediaKey);
    assert.deepEqual(hsn.fileSHA256, crypto.createHash('sha256').update(bytes).digest());
    assert.deepEqual(hsn.fileEncSHA256, uploads[0].done.fileEncSha256);
    assert.equal(hsn.fileLength, 65537);
    assert.equal(hsn.initialHistBootstrapInlinePayload, undefined);
    assert.equal(hsn.syncType, 0);

    // One byte less still rides inline: the only upload is the RECENT chunk's.
    const g = await bootstrapFixture(t), small = sized(INLINE_MAX), uploaded = [];
    const inline = await g.client.bootstrapPrimaryCompanion({ history: async () => small, upload: async buf => { uploaded.push(buf); return fakeUpload(buf); } });
    assert.equal(inline.history.inline, true);
    assert.deepEqual(notificationOf(messages(g)[1]).initialHistBootstrapInlinePayload, buildHistorySync(small));
    assert.deepEqual(recentOf(messages(g)[2]), EMPTY_RECENT);
    assert.deepEqual(uploaded, [payloadOf(notificationOf(messages(g)[2]))]);
});

// An upload can take minutes, and nothing else is said meanwhile: the start of
// one is announced, with its size, before it begins. An inline history is not.
test('a blob upload is announced before it starts, with its size', async t => {
    const f = await bootstrapFixture(t), snap = sized(INLINE_MAX + 1), seen = [];
    f.client.on('primary_link_progress', e => seen.push({ ...e, uploadsSoFar: uploads }));
    let uploads = 0;
    const result = await f.client.bootstrapPrimaryCompanion({ history: async () => snap, upload: async buf => { uploads++; return fakeUpload(buf); } });
    const announced = seen.filter(e => e.phase === 'history_uploading');
    assert.deepEqual(announced, [{ phase: 'history_uploading', operationId: result.operationId, bytes: 65537, uploadsSoFar: 0 }]);

    // A listener that throws costs the upload nothing.
    const g = await bootstrapFixture(t);
    g.client.on('primary_link_progress', () => { throw new Error('listener'); });
    const sent = await g.client.bootstrapPrimaryCompanion({ history: async () => snap, upload: async buf => fakeUpload(buf) });
    assert.equal(sent.history.inline, false);

    const h = await bootstrapFixture(t), inline = [];
    h.client.on('primary_link_progress', e => inline.push(e.phase));
    await h.client.bootstrapPrimaryCompanion({ history: async () => sized(INLINE_MAX), upload: async buf => fakeUpload(buf) });
    assert.ok(!inline.includes('history_uploading'), inline.join(', '));
});

// A large history used to have to go up inside the bootstrap's 90 seconds,
// with everything else, so past a size it could never finish at all.
test('the history upload runs on a clock of its own, outside the bootstrap\'s time limit', async t => {
    // The limit is the caller's to set, and is kept: an ACK that never comes ends the bootstrap at it.
    const f = await bootstrapFixture(t);
    f.control.hangAck = (node, i) => i === 1;
    const started = Date.now();
    await assert.rejects(f.client.bootstrapPrimaryCompanion({ history: async () => chatSnapshot(1), timeoutMs: 1000 }), { code: 'PRIMARY_LINK_TIMEOUT' });
    assert.ok(Date.now() - started < 10000, 'stopped at the limit, not at the ACK wait');
    assert.equal(journal(f).transaction.bootstrap.errorCode, 'PRIMARY_LINK_TIMEOUT');

    // An upload slower than the whole limit still finishes, and the history
    // goes, then the RECENT chunk, its upload as slow.
    const snap = sized(INLINE_MAX + 1), g = await bootstrapFixture(t);
    const slow = buf => new Promise(resolve => setTimeout(() => resolve(fakeUpload(buf)), 1500));
    const result = await g.client.bootstrapPrimaryCompanion({ history: async () => snap, upload: slow, timeoutMs: 1000 });
    assert.equal(result.history.inline, false);
    assert.equal(messages(g).length, 3);
    assert.deepEqual(recentOf(messages(g)[2]), EMPTY_RECENT);
    assert.equal(journal(g).transaction.bootstrap.phase, 'sent');

    // Its own limit: an upload that never finishes ends there, with the
    // history pinned and not sent, and a resume uploads the pinned bytes again.
    const h = await bootstrapFixture(t);
    const uploads = [];
    await assert.rejects(h.client.bootstrapPrimaryCompanion({ history: async () => snap, uploadTimeoutMs: 1000, upload: buf => { uploads.push(buf); return new Promise(() => { }); } }),
        { code: 'PRIMARY_BOOTSTRAP_UPLOAD_TIMEOUT' });
    assert.equal(journal(h).transaction.bootstrap.phase, 'history_prepared');
    assert.equal(journal(h).transaction.bootstrap.errorCode, 'PRIMARY_BOOTSTRAP_UPLOAD_TIMEOUT');
    assert.equal(messages(h).length, 1);
    const resumed = await h.client.bootstrapPrimaryCompanion({ history: async () => chatSnapshot(1), resume: true, upload: async buf => { uploads.push(buf); return fakeUpload(buf); } });
    assert.equal(resumed.status, 'sent');
    // The history once more, then the RECENT chunk.
    assert.equal(uploads.length, 3);
    assert.deepEqual(uploads[1], uploads[0]);
    assert.deepEqual(recentOf(messages(h)[2]), EMPTY_RECENT);
    assert.deepEqual(uploads[2], payloadOf(notificationOf(messages(h)[2])));

    // A cancel still stops it at once.
    const k = await bootstrapFixture(t), abort = new AbortController();
    await assert.rejects(k.client.bootstrapPrimaryCompanion({ history: async () => snap, signal: abort.signal, upload: () => { abort.abort(); return new Promise(() => { }); } }),
        { code: 'PRIMARY_LINK_ABORTED' });
    assert.equal(journal(k).transaction.bootstrap.errorCode, 'PRIMARY_LINK_ABORTED');

    // An upload that fails says so, with what failed as its cause.
    const u = await bootstrapFixture(t);
    await assert.rejects(u.client.bootstrapPrimaryCompanion({ history: async () => snap, upload: async () => { throw new Error('Failed to upload media to all available hosts'); } }),
        e => e.code === 'PRIMARY_BOOTSTRAP_UPLOAD_FAILED' && /all available hosts/.test(e.cause.message));
    assert.equal(journal(u).transaction.bootstrap.errorCode, 'PRIMARY_BOOTSTRAP_UPLOAD_FAILED');

    // Limits outside what is accepted are refused before anything is sent or recorded.
    for (const [options, code] of [[{ uploadTimeoutMs: 999 }, 'PRIMARY_BOOTSTRAP_UPLOAD_TIMEOUT_INVALID'], [{ uploadTimeoutMs: 3600001 }, 'PRIMARY_BOOTSTRAP_UPLOAD_TIMEOUT_INVALID'],
        [{ uploadTimeoutMs: '60000' }, 'PRIMARY_BOOTSTRAP_UPLOAD_TIMEOUT_INVALID'], [{ timeoutMs: 90001 }, 'PRIMARY_LINK_TIMEOUT_INVALID']]) {
        const v = await bootstrapFixture(t), before = v.requests.length;
        await assert.rejects(v.client.bootstrapPrimaryCompanion({ history: async () => snap, ...options }), { code }, JSON.stringify(options));
        assert.equal(v.requests.length, before);
        assert.equal(journal(v).transaction.bootstrap, undefined);
    }
});

test('the upload is given a minute, and a second more for each 16 KiB, at most 20 minutes', () => {
    assert.equal(Bootstrap.uploadBudget(0), 60000);
    assert.equal(Bootstrap.uploadBudget(INLINE_MAX + 1), 65000);
    assert.equal(Bootstrap.uploadBudget(1 << 20), 124000);
    assert.equal(Bootstrap.uploadBudget(100 << 20), 1200000);
});

test('a blob upload that does not match the pinned bytes is not sent', async t => {
    const f = await bootstrapFixture(t), snap = sized(INLINE_MAX + 1);
    await assert.rejects(f.client.bootstrapPrimaryCompanion({ history: async () => snap, upload: async buf => ({ ...fakeUpload(buf), fileSha256: crypto.randomBytes(32) }) }), { code: 'PRIMARY_BOOTSTRAP_UPLOAD_INVALID' });
    assert.equal(messages(f).length, 1);
    assert.equal(journal(f).transaction.bootstrap.phase, 'history_prepared');
    // Nothing reached the companion, so a resume may upload again: the
    // history, then the RECENT chunk.
    const uploads = [];
    await f.client.bootstrapPrimaryCompanion({ history: async () => snap, upload: async buf => { uploads.push(buf); return fakeUpload(buf); }, resume: true });
    assert.equal(messages(f).length, 3);
    assert.deepEqual(recentOf(messages(f)[2]), EMPTY_RECENT);
    assert.deepEqual(uploads, [buildHistorySync(snap), payloadOf(notificationOf(messages(f)[2]))]);
});

test('resume from history_uploaded uploads the pinned bytes again', async t => {
    // Nothing points at the first blob yet, and it may have expired since.
    const f = await bootstrapFixture(t), pinned = sized(INLINE_MAX + 1), bytes = buildHistorySync(pinned);
    let snap = pinned;
    const uploads = [];
    const upload = async buf => { const done = fakeUpload(buf); uploads.push({ buf, done }); return done; };
    failPhaseOnce(f, 'history_sending');
    await assert.rejects(f.client.bootstrapPrimaryCompanion({ history: async () => snap, upload }), { code: 'PRIMARY_LINK_STORE_WRITE_FAILED' });
    const recorded = journal(f).transaction.bootstrap;
    assert.equal(recorded.phase, 'history_uploaded');
    assert.equal(recorded.errorCode, 'PRIMARY_LINK_STORE_WRITE_FAILED');
    assert.equal(recorded.history.uploaded, true);
    assert.ok(Number.isSafeInteger(recorded.history.uploadedAt));
    assert.match(recorded.history.blobDigest, /^[0-9a-f]{64}$/);
    assert.equal(uploads.length, 1);
    assert.equal(messages(f).length, 1);
    // Without resume, an attempt stays one attempt.
    await assert.rejects(f.client.bootstrapPrimaryCompanion({ history: async () => snap, upload }), { code: 'PRIMARY_BOOTSTRAP_ALREADY_ATTEMPTED' });
    snap = chatSnapshot(3);
    const result = await f.client.bootstrapPrimaryCompanion({ history: async () => snap, upload, resume: true });
    assert.equal(uploads.length, 3, 'exactly one more upload of the history, then the RECENT chunk');
    assert.deepEqual(uploads[1].buf, bytes, 'of the pinned bytes, not the changed store');
    assert.equal(result.history.inline, false);
    const sent = messages(f);
    assert.equal(sent.length, 3);
    assert.equal(patchWrites(f).length, 1);
    const hsn = notificationOf(sent[1]);
    assert.equal(hsn.directPath, uploads[1].done.directPath);
    assert.deepEqual(hsn.mediaKey, uploads[1].done.mediaKey);
    assert.equal(hsn.fileLength, 65537);
    // Nor does the changed store reach the companion by the RECENT chunk.
    assert.deepEqual(recentOf(sent[2]), EMPTY_RECENT);
    assert.deepEqual(notificationOf(sent[2]).mediaKey, uploads[2].done.mediaKey);
});

test('the blob media key stays out of the link journal, and a resume from history_sending reuses that blob', async t => {
    const f = await bootstrapFixture(t), snap = sized(INLINE_MAX + 1), uploads = [];
    const upload = async buf => { const done = fakeUpload(buf); uploads.push(done); return done; };
    await stopUnacked(f, 2, { history: async () => snap, upload });
    const key = uploads[0].mediaKey, journalFile = path.join(f.dir, PHONE + '.primary-linking.json');
    assert.equal(journal(f).transaction.bootstrap.phase, 'history_sending');
    for (const text of [key.toString('base64'), key.toString('hex')]) {
        assert.ok(!fs.readFileSync(journalFile, 'utf8').includes(text), 'not in the journal');
    }
    // Only the 0600 outbox holds it, beside the bytes it encrypts.
    const outbox = JSON.parse(fs.readFileSync(outboxFile(f), 'utf8'));
    assert.equal(outbox.blob.mediaKey, key.toString('base64'));
    assert.equal(outbox.blob.directPath, uploads[0].directPath);
    const first = messages(f)[1];
    await f.client.bootstrapPrimaryCompanion({ history: async () => snap, upload, resume: true, resendUncertain: true });
    // The message already sent points at this blob: it is resent as it was,
    // and the one upload since is the RECENT chunk's.
    assert.equal(uploads.length, 2);
    const sent = messages(f);
    assert.equal(sent.length, 4);
    assert.equal(sent[2].attrs.id, first.attrs.id);
    assert.deepEqual(plain(sent[2]), plain(first));
    assert.deepEqual(recentOf(sent[3]), EMPTY_RECENT);
    assert.deepEqual(notificationOf(sent[3]).mediaKey, uploads[1].mediaKey);
    // Once sent, no session file holds either media key at all.
    for (const k of [key, uploads[1].mediaKey]) {
        for (const text of [k.toString('base64'), k.toString('hex')]) assert.ok(!sessionText(f).includes(text));
    }
    assert.equal(fs.existsSync(outboxFile(f)), false);
});

test('resume uses the pinned outbox even after the store changed', async t => {
    const f = await bootstrapFixture(t);
    let snap = chatSnapshot(2);
    f.client._messageStore = { snapshot: () => snap };
    failPhaseOnce(f, 'history_sending');
    await assert.rejects(f.client.bootstrapPrimaryCompanion({ history: 'store' }), { code: 'PRIMARY_LINK_STORE_WRITE_FAILED' });
    assert.equal(journal(f).transaction.bootstrap.phase, 'history_prepared');
    const file = outboxFile(f), outbox = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(Object.keys(outbox).sort(), ['bytes', 'cutoff', 'inline', 'sha256', 'txId']);
    assert.equal(outbox.txId, journal(f).transaction.id);
    assert.deepEqual(outbox.cutoff, { seq: 2 });
    assert.equal(outbox.inline, true);
    assert.equal(sha(Buffer.from(outbox.bytes, 'base64')), outbox.sha256);
    assert.equal(journal(f).transaction.bootstrap.history.sha256, outbox.sha256);

    snap = chatSnapshot(4);
    const result = await f.client.bootstrapPrimaryCompanion({ history: 'store', resume: true });
    const hsn = notificationOf(messages(f)[1]);
    assert.equal(sha(hsn.initialHistBootstrapInlinePayload), outbox.sha256);
    assert.notEqual(sha(buildHistorySync(snap)), outbox.sha256);
    assert.deepEqual(messageIds(historyOf(hsn)), ['M1', 'M2']);
    assert.equal(result.history.records, 2);
    // Nor does the changed store reach the companion by the RECENT chunk.
    assert.deepEqual(recentOf(messages(f)[2]), EMPTY_RECENT);
    assert.equal(fs.existsSync(file), false);
});

test('a pinned outbox that no longer matches its journal is never sent', async t => {
    const f = await bootstrapFixture(t), snap = chatSnapshot(2);
    failPhaseOnce(f, 'history_sending');
    await assert.rejects(f.client.bootstrapPrimaryCompanion({ history: async () => snap }), { code: 'PRIMARY_LINK_STORE_WRITE_FAILED' });
    const file = outboxFile(f), outbox = JSON.parse(fs.readFileSync(file, 'utf8'));
    const other = buildHistorySync(chatSnapshot(3));
    fs.writeFileSync(file, JSON.stringify({ ...outbox, bytes: other.toString('base64'), sha256: sha(other) }), { mode: 0o600 });
    await assert.rejects(f.client.bootstrapPrimaryCompanion({ history: async () => snap, resume: true }), { code: 'PRIMARY_BOOTSTRAP_OUTBOX_INVALID' });
    assert.equal(messages(f).length, 1);
});

test('history_sending without ack stops with HISTORY_UNCERTAIN', async t => {
    const f = await bootstrapFixture(t), history = async () => chatSnapshot(2);
    await stopUnacked(f, 2, { history });
    const before = journal(f);
    assert.equal(before.transaction.bootstrap.phase, 'history_sending');
    assert.equal(before.transaction.bootstrap.errorCode, 'PRIMARY_LINK_ABORTED');
    const count = f.requests.length;
    await assert.rejects(f.client.bootstrapPrimaryCompanion({ history, resume: true }), { code: 'PRIMARY_BOOTSTRAP_HISTORY_UNCERTAIN' });
    // Refused before anything at all went out, and the journal is untouched.
    assert.equal(f.requests.length, count);
    assert.deepEqual(journal(f), before);
});

test('resendUncertain resends the same message id', async t => {
    const f = await bootstrapFixture(t), history = async () => chatSnapshot(2);
    await stopUnacked(f, 2, { history });
    const first = messages(f)[1];
    const result = await f.client.bootstrapPrimaryCompanion({ history, resume: true, resendUncertain: true });
    assert.equal(result.status, 'sent');
    const sent = messages(f);
    assert.equal(sent.length, 4);
    assert.equal(sent[2].attrs.id, first.attrs.id);
    assert.deepEqual(plain(sent[2]), plain(first));
    assert.deepEqual(recentOf(sent[3]), EMPTY_RECENT);
    assert.equal(patchWrites(f).length, 1);
    assert.equal(journal(f).transaction.bootstrap.phase, 'sent');
});

test('resume from critical_patch_accepted sends history without repeating key share or patch', async t => {
    const f = await bootstrapFixture(t), history = async () => chatSnapshot(1);
    failPhaseOnce(f, 'history_prepared');
    await assert.rejects(f.client.bootstrapPrimaryCompanion({ history }), { code: 'PRIMARY_LINK_STORE_WRITE_FAILED' });
    assert.equal(journal(f).transaction.bootstrap.phase, 'critical_patch_accepted');
    assert.equal(messages(f).length, 1);
    const result = await f.client.bootstrapPrimaryCompanion({ history, resume: true });
    assert.equal(result.status, 'sent');
    const sent = messages(f);
    assert.equal(sent.length, 3);
    assert.equal(patchWrites(f).length, 1);
    assert.ok(decodeMessageContainer(plain(sent[0])).appStateSyncKeyShare);
    assert.deepEqual(messageIds(historyOf(notificationOf(sent[1]))), ['M1']);
    assert.deepEqual(recentOf(sent[2]), EMPTY_RECENT);
});

test('resume from critical_patch_sending treats our verified patch as accepted and resends on an empty collection', async t => {
    const history = async () => chatSnapshot(1);
    // The server kept the patch; only its answer was lost.
    const f = await bootstrapFixture(t);
    await stopPatch(f, 'applied', { history });
    assert.equal(journal(f).transaction.bootstrap.phase, 'critical_patch_sending');
    assert.equal(f.server.version, 1);
    assert.equal(fs.existsSync(path.join(f.dir, PHONE + '.appState.json')), false);
    assert.equal((await f.client.bootstrapPrimaryCompanion({ history, resume: true })).status, 'sent');
    assert.equal(patchWrites(f).length, 1, 'our verified patch is not written again');
    assert.equal(messages(f).length, 3);
    assert.deepEqual(recentOf(messages(f)[2]), EMPTY_RECENT);
    const persisted = JSON.parse(fs.readFileSync(path.join(f.dir, PHONE + '.appState.json'), 'utf8'));
    assert.equal(persisted.critical_block.version, 1);
    assert.equal(f.client._appState.get('critical_block').version, 1);

    // The server never got it: critical_block is still empty, so write it.
    const g = await bootstrapFixture(t);
    await stopPatch(g, 'lost', { history });
    assert.equal(g.server.version, 0);
    assert.equal((await g.client.bootstrapPrimaryCompanion({ history, resume: true })).status, 'sent');
    assert.equal(patchWrites(g).length, 2);
    assert.equal(g.server.version, 1);
    assert.equal(messages(g).length, 3, 'the key share is not repeated');
    assert.deepEqual(recentOf(messages(g)[2]), EMPTY_RECENT);

    // Anything else on the server is not ours to guess about.
    const h = await bootstrapFixture(t);
    await stopPatch(h, 'lost', { history });
    h.server.version = 3;
    await assert.rejects(h.client.bootstrapPrimaryCompanion({ history, resume: true }), { code: 'PRIMARY_BOOTSTRAP_FOREIGN_STATE' });
    assert.equal(patchWrites(h).length, 1);
    assert.equal(messages(h).length, 1);
});

test('key_share_sending without ack stops with KEY_SHARE_UNCERTAIN unless resendUncertain', async t => {
    const f = await bootstrapFixture(t), history = async () => chatSnapshot(1);
    await stopUnacked(f, 1, { history });
    assert.equal(journal(f).transaction.bootstrap.phase, 'key_share_sending');
    const keys = fs.readFileSync(keyFile(f)), count = f.requests.length;
    await assert.rejects(f.client.bootstrapPrimaryCompanion({ history, resume: true }), { code: 'PRIMARY_BOOTSTRAP_KEY_SHARE_UNCERTAIN' });
    assert.equal(f.requests.length, count);
    const result = await f.client.bootstrapPrimaryCompanion({ history, resume: true, resendUncertain: true });
    assert.equal(result.status, 'sent');
    const sent = messages(f);
    assert.equal(sent.length, 4);
    assert.equal(sent[1].attrs.id, sent[0].attrs.id);
    assert.deepEqual(plain(sent[1]), plain(sent[0]), 'the same key, under the same id');
    assert.deepEqual(messageIds(historyOf(notificationOf(sent[2]))), ['M1']);
    assert.deepEqual(recentOf(sent[3]), EMPTY_RECENT);
    assert.deepEqual(fs.readFileSync(keyFile(f)), keys);
    assert.equal(patchWrites(f).length, 1);
});

test('relink shares the existing key, skips the patch, and sends history', async t => {
    const f = await bootstrapFixture(t), { tx, keyId, keyData, built } = previousLink(f);
    // The server holds what our key wrote, at our version.
    f.server.version = 1;
    f.server.patches = [built.patch];
    const keys = fs.readFileSync(keyFile(f));
    assert.deepEqual(await Bootstrap.verifyServerCriticalBlock(f.client._primaryLinking, null), { version: 1, verified: true, foreign: false });
    const result = await f.client.bootstrapPrimaryCompanion({ history: async () => chatSnapshot(2) });
    assert.equal(result.mode, 'relink');
    assert.equal(result.status, 'sent');
    assert.equal(patchWrites(f).length, 0);
    const sent = messages(f);
    assert.equal(sent.length, 3);
    assert.deepEqual(recentOf(sent[2]), EMPTY_RECENT);
    const share = keyShareOf(sent[0]);
    assert.equal(share.keyId, keyId.toString('hex'));
    assert.deepEqual(share.keyData, keyData);
    // Under the ADV state of this link, not the one the key was made under.
    assert.deepEqual(share.fingerprint, { rawId: tx.state.rawId, currentIndex: tx.state.currentIndex, validIndexes: tx.state.validIndexes });
    assert.deepEqual(messageIds(historyOf(notificationOf(sent[1]))), ['M1', 'M2']);
    assert.deepEqual(fs.readFileSync(keyFile(f)), keys);
    assert.equal(f.client._appState.get('critical_block').version, 1);
    assert.equal(journal(f).transaction.bootstrap.mode, 'relink');
});

test('relink reads the version off the patches when the server leaves the collection unversioned', async t => {
    // Captured live: after the companion logged out, a read of critical_block
    // came back as <collection name="critical_block"><patches><patch/></patches>
    // with no version attribute, the one patch being ours at version 1.
    const f = await bootstrapFixture(t), { keyId, built } = previousLink(f);
    f.server.version = 1;
    f.server.patches = [built.patch];
    f.server.unversioned = true;
    assert.deepEqual(await Bootstrap.verifyServerCriticalBlock(f.client._primaryLinking, null), { version: 1, verified: true, foreign: false });
    const result = await f.client.bootstrapPrimaryCompanion({ history: async () => chatSnapshot(1) });
    assert.equal(result.mode, 'relink');
    assert.equal(patchWrites(f).length, 0);
    assert.equal(keyShareOf(messages(f)[0]).keyId, keyId.toString('hex'));
});

test('an unversioned critical_block that is not ours at our version is still refused', async t => {
    const f = await bootstrapFixture(t), ours = previousLink(f);
    f.server.patches = [ours.built.patch, Sync.buildPatch(pushNamePatch('Later'), ours.keyId, ours.keyData, ours.built.state).patch];
    f.server.version = 2;
    f.server.unversioned = true;
    assert.equal((await Bootstrap.verifyServerCriticalBlock(f.client._primaryLinking, null)).verified, false);
    await assert.rejects(f.client.bootstrapPrimaryCompanion({ history: async () => chatSnapshot(1) }), { code: 'PRIMARY_BOOTSTRAP_FOREIGN_STATE' });
    assert.equal(messages(f).length, 0);
});

test('relink refuses a server state we cannot verify', async t => {
    const cases = {
        'written with a key we do not hold': ours => [Sync.buildPatch(pushNamePatch('Local Primary'), Buffer.from('0f0e0d0c0b0a', 'hex'), crypto.randomBytes(32), newState()).patch],
        'a MAC that does not verify': ours => { const p = Buffer.from(ours.built.patch); p[p.length - 20] ^= 1; return [p]; },
        'our key, but not our state': ours => [Sync.buildPatch(pushNamePatch('Someone Else'), ours.keyId, ours.keyData, newState()).patch],
        'ahead of our version': ours => [ours.built.patch, Sync.buildPatch(pushNamePatch('Later'), ours.keyId, ours.keyData, ours.built.state).patch]
    };
    for (const [name, patches] of Object.entries(cases)) {
        const f = await bootstrapFixture(t), ours = previousLink(f);
        f.server.patches = patches(ours);
        f.server.version = f.server.patches.length;
        const seen = await Bootstrap.verifyServerCriticalBlock(f.client._primaryLinking, null);
        assert.equal(seen.verified, false, name);
        await assert.rejects(f.client.bootstrapPrimaryCompanion({ history: async () => chatSnapshot(1) }), { code: 'PRIMARY_BOOTSTRAP_FOREIGN_STATE' }, name);
        assert.equal(messages(f).length, 0, name);
        assert.equal(patchWrites(f).length, 0, name);
        assert.equal(journal(f).transaction.bootstrap, undefined, name);
    }
});

test('relink verifies a critical_block snapshot blob with our key as well', async t => {
    for (const ourMac of [true, false]) {
        const f = await bootstrapFixture(t), ours = previousLink(f), fetched = [];
        const blob = snapshotBlob(ours, ourMac ? ours.keyData : crypto.randomBytes(32));
        f.client._fetchAppStateBlob = async ref => { fetched.push(ref.directPath); return blob; };
        f.server.version = 1;
        f.server.snapshot = Buffer.concat([len(1, crypto.randomBytes(32)), len(2, Buffer.from('/v/t62.synthetic/critical-block'))]);
        if (ourMac) {
            assert.equal((await f.client.bootstrapPrimaryCompanion({ history: async () => chatSnapshot(1) })).mode, 'relink');
            assert.equal(messages(f).length, 3);
            assert.deepEqual(recentOf(messages(f)[2]), EMPTY_RECENT);
        } else {
            await assert.rejects(f.client.bootstrapPrimaryCompanion({ history: async () => chatSnapshot(1) }), { code: 'PRIMARY_BOOTSTRAP_FOREIGN_STATE' });
            assert.equal(messages(f).length, 0);
        }
        assert.deepEqual(fetched, ['/v/t62.synthetic/critical-block']);
        assert.equal(patchWrites(f).length, 0);
    }
});

test('a step its ACK refused is not sent again, even with resendUncertain', async t => {
    const f = await bootstrapFixture(t), history = async () => chatSnapshot(1);
    f.control.ackError = (node, n) => (n === 2 ? '403' : null);
    await assert.rejects(f.client.bootstrapPrimaryCompanion({ history }), { code: 'PRIMARY_BOOTSTRAP_ACK_403' });
    assert.equal(journal(f).transaction.bootstrap.phase, 'history_sending');
    assert.equal(fs.existsSync(outboxFile(f)), false, 'a refused history is not kept');
    const count = f.requests.length;
    await assert.rejects(f.client.bootstrapPrimaryCompanion({ history, resume: true, resendUncertain: true }), { code: 'PRIMARY_BOOTSTRAP_ALREADY_ATTEMPTED' });
    assert.equal(f.requests.length, count);
});

// Web counts the history as synced only once a RECENT chunk at progress 100
// has come (recentCompleted, in handleHistorySyncChunk). Without one it showed
// "Syncing older messages" in the chat, and after two minutes "Syncing paused".
// It goes as a blob even when the history rode inline: Web left a RECENT
// chunk sent inline at "downloading" for good.
test('a RECENT chunk at 100% always follows the history, empty when no delta was asked for', async t => {
    const f = await bootstrapFixture(t);
    const result = await f.client.bootstrapPrimaryCompanion({ history: async () => chatSnapshot(2) });
    assert.equal(result.status, 'sent');
    assert.equal(result.delta, null);
    const sent = messages(f);
    assert.equal(sent.length, 3);
    const initial = notificationOf(sent[1]), recent = notificationOf(sent[2]);
    assert.equal(initial.syncType, 0);
    assert.ok(initial.initialHistBootstrapInlinePayload);
    assert.equal(recent.syncType, 3);
    assert.equal(recent.chunkOrder, 1);
    assert.equal(recent.progress, 100);
    assert.equal(recent.initialHistBootstrapInlinePayload, undefined);
    // Up by the default md-msg-hist upload, the one upload of the bootstrap,
    // and the notification points at exactly that blob.
    assert.equal(f.uploads.length, 1);
    const [{ kind, buf, done }] = f.uploads;
    assert.equal(kind, 'md-msg-hist');
    assert.equal(recent.directPath, done.directPath);
    assert.deepEqual(recent.mediaKey, done.mediaKey);
    assert.deepEqual(recent.fileSHA256, crypto.createHash('sha256').update(buf).digest());
    assert.deepEqual(recent.fileEncSHA256, done.fileEncSha256);
    assert.equal(recent.fileLength, buf.length);
    // The bytes uploaded: RECENT at 100%, with no conversations, nothing at all.
    const H = type('HistorySync'), chunk = H.toObject(H.decode(zlib.inflateSync(buf)), { longs: Number });
    assert.equal(chunk.syncType, 3);
    assert.equal(chunk.progress, 100);
    assert.deepEqual(chunk.conversations || [], []);
    assert.deepEqual(chunk, EMPTY_RECENT);
    // Journaled as the delta, a blob: uploaded, then accepted.
    const recorded = journal(f).transaction.bootstrap;
    assert.equal(recorded.phase, 'sent');
    assert.equal(recorded.delta.inline, false);
    assert.equal(recorded.delta.uploaded, true);
    assert.equal(recorded.delta.records, 0);
    assert.equal(recorded.delta.sha256, sha(buf));
});

test('delta carries only records after the cutoff', async t => {
    const BOB = '40788888888@s.whatsapp.net', CAROL = '40777777777@s.whatsapp.net', DAVE = '40766666666@s.whatsapp.net';
    const gone = (id, seq, ts, tombstone) => ({ id, seq, fromMe: false, ts, status: 3, tombstone });
    const chats = [{ id: ANA, name: 'Ana', conversationTimestamp: T + 5, unreadCount: 0 }, { id: BOB, name: 'Bob', conversationTimestamp: T + 3, unreadCount: 7 },
        { id: GROUP, name: 'Group', conversationTimestamp: T + 7, unreadCount: 2 }];
    const pushNames = [{ id: ANA, pushname: 'Ana' }, { id: BOB, pushname: 'Bob' }, { id: CAROL, pushname: 'Carol' }, { id: DAVE, pushname: 'Dave' }];
    const pinned = snapshot({ seq: 3, chats, pushNames, records: {
        [ANA]: [gone('X0', 1, T, 'expired'), rec('M1', 1, T + 1), rec('M2', 2, T + 2)],
        [BOB]: [rec('B1', 3, T + 3)],
        [GROUP]: [rec('G1', 2, T + 2, { participant: CAROL })] } });
    const later = snapshot({ seq: 7, chats, pushNames, records: {
        [ANA]: [rec('M1', 1, T + 1), gone('M2', 6, T + 2, 'revoked'), rec('M4', 4, T + 4), rec('M5', 5, T + 5)],
        [BOB]: [rec('B1', 3, T + 3), gone('B2', 6, T + 4, 'expired')],
        [GROUP]: [rec('G1', 2, T + 2, { participant: CAROL }), rec('G2', 7, T + 7, { participant: DAVE })] } });
    const f = await bootstrapFixture(t);
    // Read at the start, then again for the pin, then for the delta.
    let calls = 0;
    const result = await f.client.bootstrapPrimaryCompanion({ history: async () => (calls++ < 2 ? pinned : later), delta: true });
    // Counted as exported: the expired X0 never goes over.
    assert.equal(result.history.records, 4);
    assert.equal(result.history.chats, 3);
    assert.deepEqual(result.delta, { records: 4 });
    const sent = messages(f);
    assert.equal(sent.length, 3);
    assert.deepEqual(messageIds(historyOf(notificationOf(sent[1]))), ['M1', 'M2', 'B1', 'G1']);
    const delta = recentOf(sent[2]);
    // Only the chats with something new that goes over: Bob's expired B2 does
    // not bring his chat back with its unread count.
    assert.deepEqual(delta.conversations.map(c => c.ID), [ANA, GROUP]);
    assert.deepEqual(messageIds(delta), ['M2', 'M4', 'M5', 'G2']);
    assert.equal(delta.conversations[0].messages[0].message.messageStubType, 1);
    // Push names of those chats and their senders only.
    assert.deepEqual(delta.pushnames.map(p => p.ID).sort(), [ANA, DAVE].sort());
    assert.deepEqual(journal(f).transaction.bootstrap.delta.cutoff, { seq: 7 });
    assert.equal(journal(f).transaction.bootstrap.phase, 'sent');

    // Nothing that goes over arrived after the cutoff: the RECENT chunk still
    // goes, with nothing in it.
    const quiet = snapshot({ seq: 6, chats, pushNames, records: { ...pinned.records, [BOB]: [rec('B1', 3, T + 3), gone('B2', 6, T + 4, 'expired')] } });
    const g = await bootstrapFixture(t);
    let again = 0;
    const none = await g.client.bootstrapPrimaryCompanion({ history: async () => (again++ < 2 ? pinned : quiet), delta: true });
    assert.deepEqual(none.delta, { records: 0 });
    assert.equal(messages(g).length, 3);
    assert.deepEqual(recentOf(messages(g)[2]), EMPTY_RECENT);
});

test('a dropped connection leaves the bootstrap resumable', async t => {
    const history = async () => chatSnapshot(2);
    // While the history's ACK is outstanding.
    const f = await bootstrapFixture(t);
    f.control.hangAck = (node, i) => i === 2;
    const run = f.client.bootstrapPrimaryCompanion({ history });
    await until(() => messages(f).length >= 2);
    f.client._closePrimaryLinking();
    await assert.rejects(run, { code: 'PRIMARY_LINK_CONNECTION_CLOSED' });
    f.control.hangAck = null;
    const tx = f.client._primaryLinkingForSession().journal.snapshot().transaction;
    assert.equal(tx.phase, 'uncertain');
    assert.equal(tx.bootstrap.phase, 'history_sending');
    // Only a resume of the recorded attempt may continue an uncertain link.
    await assert.rejects(f.client.bootstrapPrimaryCompanion({ history }), { code: 'PRIMARY_BOOTSTRAP_AUTHORIZED_LINK_REQUIRED' });
    await assert.rejects(f.client.bootstrapPrimaryCompanion({ history, resume: true }), { code: 'PRIMARY_BOOTSTRAP_HISTORY_UNCERTAIN' });
    const first = messages(f)[1];
    assert.equal((await f.client.bootstrapPrimaryCompanion({ history, resume: true, resendUncertain: true })).status, 'sent');
    assert.equal(messages(f).length, 4);
    assert.equal(messages(f)[2].attrs.id, first.attrs.id);
    assert.deepEqual(recentOf(messages(f)[3]), EMPTY_RECENT);

    // While the patch write is unanswered: settled by reading it back.
    const g = await bootstrapFixture(t);
    g.server.hangPatch = 'applied';
    const write = g.client.bootstrapPrimaryCompanion({ history });
    await until(() => patchWrites(g).length === 1);
    g.client._closePrimaryLinking();
    await assert.rejects(write, { code: 'PRIMARY_LINK_CONNECTION_CLOSED' });
    g.server.hangPatch = false;
    assert.equal(g.client._primaryLinkingForSession().journal.snapshot().transaction.phase, 'uncertain');
    assert.equal((await g.client.bootstrapPrimaryCompanion({ history, resume: true })).status, 'sent');
    assert.equal(patchWrites(g).length, 1);
    assert.equal(messages(g).length, 3);
    assert.deepEqual(recentOf(messages(g)[2]), EMPTY_RECENT);

    // The resumed attempt stays bound to its device.
    const h = await bootstrapFixture(t);
    h.control.hangAck = (node, i) => i === 2;
    const bound = h.client.bootstrapPrimaryCompanion({ history });
    await until(() => messages(h).length >= 2);
    h.client._closePrimaryLinking();
    await assert.rejects(bound, { code: 'PRIMARY_LINK_CONNECTION_CLOSED' });
    h.control.hangAck = null;
    h.client._devMgr = { async fetchBundles(jids) { return new Map([[jids[0], { identityKey: Buffer.alloc(32, 7) }]]); } };
    await assert.rejects(h.client.bootstrapPrimaryCompanion({ history, resume: true, resendUncertain: true }), { code: 'PRIMARY_BOOTSTRAP_PEER_UNMATCHED' });
    assert.equal(messages(h).length, 2);
});

test('the outbox belongs to its link transaction and is removed once it can no longer be sent', async t => {
    // A bootstrap stopped with its history pinned.
    async function stuck() {
        const f = await bootstrapFixture(t);
        await stopUnacked(f, 2, { history: async () => chatSnapshot(2) });
        assert.equal(JSON.parse(fs.readFileSync(outboxFile(f), 'utf8')).txId, journal(f).transaction.id);
        return f;
    }
    // One some other transaction left is removed when a bootstrap starts.
    const f = await stuck(), pinned = JSON.parse(fs.readFileSync(outboxFile(f), 'utf8'));
    fs.writeFileSync(outboxFile(f), JSON.stringify({ ...pinned, txId: crypto.randomUUID() }), { mode: 0o600 });
    await assert.rejects(f.client.bootstrapPrimaryCompanion({ history: async () => chatSnapshot(2) }), { code: 'PRIMARY_BOOTSTRAP_ALREADY_ATTEMPTED' });
    assert.equal(fs.existsSync(outboxFile(f)), false);

    // Retiring the link removes it.
    const g = await stuck();
    g.client._primaryLinking.journal.update(s => { s.transaction.startedAt = Date.now() - 300001; });
    g.removeServerDevice();
    assert.equal((await g.client.retireAbsentPrimaryLink()).status, 'abandoned');
    assert.equal(fs.existsSync(outboxFile(g)), false);

    // So does a new link transaction taking this one's place.
    const h = await stuck(), previous = journal(h).transaction.id;
    h.client._primaryLinking.journal.update(s => { s.transaction.phase = 'committed'; });   // as reconcilePrimaryLink leaves it
    const key = () => crypto.randomBytes(32).toString('base64');
    await assert.rejects(h.client.approveCompanionQr(['another-companion-ref', key(), key(), key(), '1'].join(',')));
    assert.notEqual(journal(h).transaction.id, previous);
    assert.equal(fs.existsSync(outboxFile(h)), false);
});

// A read that fails says nothing about whose the outbox is. Deleting it then
// would leave an attempt that can never be finished.
test('an outbox that cannot be read at the start is kept, and the attempt finishes from it', async t => {
    const f = await bootstrapFixture(t), snap = chatSnapshot(2);
    failPhaseOnce(f, 'history_sending');
    await assert.rejects(f.client.bootstrapPrimaryCompanion({ history: async () => snap }), { code: 'PRIMARY_LINK_STORE_WRITE_FAILED' });
    const file = outboxFile(f), pinned = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const code of ['EIO', 'EACCES']) {
        // The next read of the outbox by name fails as a flaky disk would.
        const read = fs.readFileSync;
        let failed = 0;
        fs.readFileSync = function (target, ...rest) {
            if (target === file && !failed++) throw Object.assign(new Error(code + ': i/o error'), { code });
            return read.call(this, target, ...rest);
        };
        try {
            // Not resumed: refused as already attempted, and nothing else changes.
            await assert.rejects(f.client.bootstrapPrimaryCompanion({ history: async () => snap }), { code: 'PRIMARY_BOOTSTRAP_ALREADY_ATTEMPTED' });
        } finally { fs.readFileSync = read; }
        assert.equal(failed, 1, code);
        assert.ok(fs.existsSync(file), code + ': the outbox is still there');
    }
    const read = fs.readFileSync;
    let failed = 0;
    fs.readFileSync = function (target, ...rest) {
        if (target === file && !failed++) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
        return read.call(this, target, ...rest);
    };
    let result;
    try { result = await f.client.bootstrapPrimaryCompanion({ history: async () => chatSnapshot(5), resume: true }); }
    finally { fs.readFileSync = read; }
    assert.equal(failed, 1);
    assert.equal(result.status, 'sent');
    assert.equal(sha(notificationOf(messages(f)[1]).initialHistBootstrapInlinePayload), pinned.sha256);
    assert.equal(fs.existsSync(file), false);

    // One that was read and names another transaction still goes.
    const g = await bootstrapFixture(t);
    fs.writeFileSync(outboxFile(g), JSON.stringify({ ...pinned, txId: crypto.randomUUID() }), { mode: 0o600 });
    await g.client.bootstrapPrimaryCompanion({ history: async () => snap });
    assert.equal(fs.existsSync(outboxFile(g)), false);
});

test('losses, evictions and the capture origin are reported with the history', async t => {
    const f = await bootstrapFixture(t);
    const snap = { ...chatSnapshot(2), losses: [{ reason: 'undecryptable', ids: ['L1', 'L2'] }, { reason: 'store-disabled', from: 1, to: 2 }],
        retained: { evicted: 7 }, capture: { since: T * 1000, origin: 'migrated', lc: 3 } };
    failPhaseOnce(f, 'history_sending');
    await assert.rejects(f.client.bootstrapPrimaryCompanion({ history: async () => snap }), { code: 'PRIMARY_LINK_STORE_WRITE_FAILED' });
    // A resume reports what was pinned, not what the store holds now.
    const result = await f.client.bootstrapPrimaryCompanion({ history: async () => chatSnapshot(5), resume: true });
    assert.deepEqual(result.history, { chats: 1, records: 2, bytes: buildHistorySync(snap).length, inline: true, losses: 2, evicted: 7, captureOrigin: 'migrated' });
    // A provider that does not say has no answer, rather than a clean one.
    const g = await bootstrapFixture(t), bare = chatSnapshot(1);
    delete bare.losses; delete bare.retained; delete bare.capture;
    const unknown = (await g.client.bootstrapPrimaryCompanion({ history: async () => bare })).history;
    assert.deepEqual([unknown.losses, unknown.evicted, unknown.captureOrigin], [null, null, null]);
});

test('a patch the server refused is not written again on resume', async t => {
    for (const [refusal, code] of [['iq', 'PRIMARY_LINK_IQ_REJECTED'], ['node', 'PRIMARY_BOOTSTRAP_PATCH_REJECTED']]) {
        const f = await bootstrapFixture(t), history = async () => chatSnapshot(1);
        f.server.refusePatch = refusal;
        await assert.rejects(f.client.bootstrapPrimaryCompanion({ history }), { code });
        assert.equal(journal(f).transaction.bootstrap.phase, 'critical_patch_sending');
        assert.deepEqual(journal(f).transaction.bootstrap.iq.errorCodes, ['400']);
        f.server.refusePatch = null;
        const count = f.requests.length, before = journal(f);
        await assert.rejects(f.client.bootstrapPrimaryCompanion({ history, resume: true }), { code: 'PRIMARY_BOOTSTRAP_ALREADY_ATTEMPTED' }, refusal);
        assert.equal(f.requests.length, count);
        assert.deepEqual(journal(f), before);
        assert.equal(patchWrites(f).length, 1);
    }
});

// Whether a stopped attempt can go on is the journal's to say, so that what
// the person is told next is a resume only when a resume can work.
test('a stopped bootstrap says whether its attempt can be resumed, in the error and in the status', async t => {
    const history = async () => chatSnapshot(1);
    // Refused by WhatsApp: never again.
    const f = await bootstrapFixture(t);
    f.server.refusePatch = 'iq';
    await assert.rejects(f.client.bootstrapPrimaryCompanion({ history }), e => e.code === 'PRIMARY_LINK_IQ_REJECTED' && e.resumable === false);
    const refused = (await f.client.getPrimaryLinkStatus()).bootstrap;
    assert.equal(refused.resumable, false);
    assert.equal(refused.errorCode, 'PRIMARY_LINK_IQ_REJECTED');
    // Stopped by the link's own limit: a resume goes on.
    const g = await bootstrapFixture(t);
    g.control.hangAck = (node, i) => i === 2;
    await assert.rejects(g.client.bootstrapPrimaryCompanion({ history, timeoutMs: 1000 }), e => e.code === 'PRIMARY_LINK_TIMEOUT' && e.resumable === true);
    assert.equal((await g.client.getPrimaryLinkStatus()).bootstrap.resumable, true);
    g.control.hangAck = null;
    assert.equal((await g.client.bootstrapPrimaryCompanion({ history, resume: true, resendUncertain: true })).status, 'sent');
    assert.equal((await g.client.getPrimaryLinkStatus()).bootstrap.resumable, false, 'sent: nothing left to resume');
    // Refused before anything was recorded: nothing to say.
    const h = await bootstrapFixture(t);
    await assert.rejects(h.client.bootstrapPrimaryCompanion({ history, uploadTimeoutMs: 1 }), e => e.code === 'PRIMARY_BOOTSTRAP_UPLOAD_TIMEOUT_INVALID' && e.resumable === undefined);
});

// /linked-devices shows how a companion was linked, when, and what history it
// was handed. All of it is in the journal, so it survives a restart.
test('the status says how and when the companion was linked, which device it is, and what history it got', async t => {
    const f = await bootstrapFixture(t), before = Date.now();
    const approved = await f.client.getPrimaryLinkStatus();
    assert.equal(approved.method, 'code');
    assert.ok(approved.linkedAt >= journal(f).transaction.startedAt && approved.linkedAt <= Date.now(), 'linked when the approval went through');
    assert.equal(approved.deviceId, null, 'no device is claimed before one is seen');
    assert.equal(approved.delivered, null);

    const snap = snapshot({ seq: 4, chats: [{ id: ANA, conversationTimestamp: T + 3, unreadCount: 0 }, { id: GROUP, conversationTimestamp: T + 2, unreadCount: 0 }],
        records: { [ANA]: [rec('A1', 1, T + 1), rec('A2', 2, T + 3)], [GROUP]: [rec('G1', 3, T + 2, { participant: ANA })] } });
    // Stopped part-way: the device is known, nothing is delivered yet.
    failPhaseOnce(f, 'history_sending');
    await assert.rejects(f.client.bootstrapPrimaryCompanion({ history: async () => snap }), { code: 'PRIMARY_LINK_STORE_WRITE_FAILED' });
    const stopped = await f.client.getPrimaryLinkStatus();
    assert.equal(stopped.deviceId, 7);
    assert.equal(stopped.delivered, null);
    await f.client.bootstrapPrimaryCompanion({ history: async () => chatSnapshot(9), resume: true });

    // After a restart, from the journal alone.
    f.client._closePrimaryLinking();
    const status = await f.client.getPrimaryLinkStatus();
    assert.equal(status.method, 'code');
    assert.equal(status.linkedAt, approved.linkedAt);
    assert.equal(status.deviceId, 7);
    assert.deepEqual(status.delivered, { chats: 2, records: 3 });
    assert.equal(journal(f).transaction.bootstrap.delivered.records, 3);
    assert.ok(approved.linkedAt >= before - 60000);
});

test('a history the encoder refuses is HISTORY_INVALID, with the encoder error as its cause', async t => {
    const noBytes = seq => ({ id: 'NORAW', seq, fromMe: false, ts: T, status: 3 });
    const broken = snapshot({ seq: 1, chats: [{ id: ANA, conversationTimestamp: T, unreadCount: 0 }], records: { [ANA]: [noBytes(1)] } });
    const f = await bootstrapFixture(t);
    await assert.rejects(f.client.bootstrapPrimaryCompanion({ history: async () => broken }),
        e => e.code === 'PRIMARY_BOOTSTRAP_HISTORY_INVALID' && e.cause?.code === 'PRIMARY_HISTORY_EXPORT_SNAPSHOT_INVALID');
    assert.equal(messages(f).length, 0);
    assert.equal(journal(f).transaction.bootstrap, undefined);
    // Found only at the delta: thrown and journaled under the same code.
    const g = await bootstrapFixture(t);
    let calls = 0;
    const later = snapshot({ seq: 2, chats: broken.chats, records: { [ANA]: [noBytes(2)] } });
    await assert.rejects(g.client.bootstrapPrimaryCompanion({ history: async () => (calls++ < 2 ? chatSnapshot(1) : later), delta: true }), { code: 'PRIMARY_BOOTSTRAP_HISTORY_INVALID' });
    assert.equal(journal(g).transaction.bootstrap.errorCode, 'PRIMARY_BOOTSTRAP_HISTORY_INVALID');
    assert.equal(journal(g).transaction.bootstrap.phase, 'history_accepted');
});

test('verifyServerCriticalBlock reports a key file that is not ours as foreign', async t => {
    const f = await bootstrapFixture(t);
    fs.writeFileSync(keyFile(f), JSON.stringify({ '0a0b0c0d0e0f': { keyData: crypto.randomBytes(32).toString('base64'), timestamp: 1, source: 'phone' } }), { mode: 0o600 });
    assert.deepEqual(await Bootstrap.verifyServerCriticalBlock(f.client._primaryLinking, null), { version: 0, verified: false, foreign: true });
});

test('resume from prepared shares the recorded key, or makes it if the key file was never written', async t => {
    for (const keyFileLost of [false, true]) {
        const f = await bootstrapFixture(t), history = async () => chatSnapshot(1);
        failPhaseOnce(f, 'key_share_sending');
        await assert.rejects(f.client.bootstrapPrimaryCompanion({ history }), { code: 'PRIMARY_LINK_STORE_WRITE_FAILED' });
        const recorded = journal(f).transaction.bootstrap;
        assert.equal(recorded.phase, 'prepared');
        assert.equal(messages(f).length, 0);
        if (keyFileLost) fs.rmSync(keyFile(f));
        const before = keyFileLost ? null : fs.readFileSync(keyFile(f));
        assert.equal((await f.client.bootstrapPrimaryCompanion({ history, resume: true })).status, 'sent');
        const keyId = journal(f).transaction.bootstrap.keyId;
        assert.equal(keyShareOf(messages(f)[0]).keyId, keyId);
        assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(keyFile(f), 'utf8'))), [keyId]);
        if (keyFileLost) assert.notEqual(keyId, recorded.keyId);
        else {
            assert.equal(keyId, recorded.keyId);
            assert.deepEqual(fs.readFileSync(keyFile(f)), before);
        }
        assert.equal(messages(f).length, 3);
        assert.deepEqual(recentOf(messages(f)[2]), EMPTY_RECENT);
        assert.equal(patchWrites(f).length, 1);
    }
});

test('resume from key_share_accepted writes the patch once and does not share the key again', async t => {
    const f = await bootstrapFixture(t), history = async () => chatSnapshot(1);
    failPhaseOnce(f, 'critical_patch_sending');
    await assert.rejects(f.client.bootstrapPrimaryCompanion({ history }), { code: 'PRIMARY_LINK_STORE_WRITE_FAILED' });
    assert.equal(journal(f).transaction.bootstrap.phase, 'key_share_accepted');
    assert.equal(patchWrites(f).length, 0);
    assert.equal((await f.client.bootstrapPrimaryCompanion({ history, resume: true })).status, 'sent');
    assert.equal(messages(f).length, 3);
    assert.deepEqual(recentOf(messages(f)[2]), EMPTY_RECENT);
    assert.equal(patchWrites(f).length, 1);
});

test('a delta resumes from delta_prepared, delta_sending and delta_accepted', async t => {
    // The start and the pin read 2 records; the delta, 4.
    const twoStep = () => { let calls = 0; return async () => (calls++ < 2 ? chatSnapshot(2) : chatSnapshot(4)); };
    // delta_prepared: the pinned delta goes out even though this call asks for
    // none. It is a blob nothing points at yet, so it is uploaded afresh.
    const f = await bootstrapFixture(t);
    failPhaseOnce(f, 'delta_uploaded');
    await assert.rejects(f.client.bootstrapPrimaryCompanion({ history: twoStep(), delta: true }), { code: 'PRIMARY_LINK_STORE_WRITE_FAILED' });
    assert.equal(journal(f).transaction.bootstrap.phase, 'delta_prepared');
    const fromPrepared = await f.client.bootstrapPrimaryCompanion({ history: async () => chatSnapshot(9), resume: true });
    assert.deepEqual(messageIds(recentOf(messages(f)[2])), ['M3', 'M4']);
    assert.equal(f.uploads.length, 2);
    assert.deepEqual(f.uploads[1].buf, f.uploads[0].buf);
    // delta_sending: uncertain until resendUncertain, then the same message
    // again, pointing at the blob it was first sent with.
    const g = await bootstrapFixture(t), history = twoStep();
    await stopUnacked(g, 3, { history, delta: true });
    assert.equal(journal(g).transaction.bootstrap.phase, 'delta_sending');
    await assert.rejects(g.client.bootstrapPrimaryCompanion({ history, resume: true }), { code: 'PRIMARY_BOOTSTRAP_HISTORY_UNCERTAIN' });
    const fromSending = await g.client.bootstrapPrimaryCompanion({ history, resume: true, resendUncertain: true });
    const sent = messages(g);
    assert.equal(sent.length, 4);
    assert.equal(sent[3].attrs.id, sent[2].attrs.id);
    assert.deepEqual(plain(sent[3]), plain(sent[2]));
    assert.equal(g.uploads.length, 1);
    // delta_accepted: only `sent` was left to record.
    const h = await bootstrapFixture(t);
    failPhaseOnce(h, 'sent');
    await assert.rejects(h.client.bootstrapPrimaryCompanion({ history: twoStep(), delta: true }), { code: 'PRIMARY_LINK_STORE_WRITE_FAILED' });
    assert.equal(journal(h).transaction.bootstrap.phase, 'delta_accepted');
    const fromAccepted = await h.client.bootstrapPrimaryCompanion({ history: async () => chatSnapshot(9), resume: true });
    assert.equal(messages(h).length, 3);
    // The empty RECENT chunk of a bootstrap that asked for no delta resumes the
    // same way: uncertain, then the same message again, and still no delta.
    const k = await bootstrapFixture(t);
    await stopUnacked(k, 3, { history: async () => chatSnapshot(2) });
    assert.equal(journal(k).transaction.bootstrap.phase, 'delta_sending');
    await assert.rejects(k.client.bootstrapPrimaryCompanion({ history: async () => chatSnapshot(4), resume: true }), { code: 'PRIMARY_BOOTSTRAP_HISTORY_UNCERTAIN' });
    assert.equal((await k.client.bootstrapPrimaryCompanion({ history: async () => chatSnapshot(4), resume: true, resendUncertain: true })).delta, null);
    assert.equal(messages(k).length, 4);
    assert.equal(messages(k)[3].attrs.id, messages(k)[2].attrs.id);
    assert.deepEqual(recentOf(messages(k)[3]), EMPTY_RECENT);
    // Each reports the delta it finished, though none of these calls asked
    // for one: it went over all the same.
    assert.deepEqual([fromPrepared.delta, fromSending.delta, fromAccepted.delta], [{ records: 2 }, { records: 2 }, { records: 2 }]);
});

test('a re-link resumes as a re-link, never with a patch', async t => {
    const history = async () => chatSnapshot(2);
    async function relinking() {
        const f = await bootstrapFixture(t), ours = previousLink(f);
        f.server.version = 1;
        f.server.patches = [ours.built.patch];
        return f;
    }
    // From key_share_accepted: critical_block is verified again, then the history goes.
    const f = await relinking();
    failPhaseOnce(f, 'history_prepared');
    await assert.rejects(f.client.bootstrapPrimaryCompanion({ history }), { code: 'PRIMARY_LINK_STORE_WRITE_FAILED' });
    assert.equal(journal(f).transaction.bootstrap.phase, 'key_share_accepted');
    assert.equal((await f.client.bootstrapPrimaryCompanion({ history, resume: true })).mode, 'relink');
    assert.equal(messages(f).length, 3);
    assert.deepEqual(recentOf(messages(f)[2]), EMPTY_RECENT);
    assert.equal(patchWrites(f).length, 0);
    // ...and a critical_block that changed under it in the meantime stops it.
    const g = await relinking();
    failPhaseOnce(g, 'history_prepared');
    await assert.rejects(g.client.bootstrapPrimaryCompanion({ history }), { code: 'PRIMARY_LINK_STORE_WRITE_FAILED' });
    g.server.patches = [Sync.buildPatch(pushNamePatch('Someone Else'), Buffer.from('0f0e0d0c0b0a', 'hex'), crypto.randomBytes(32), newState()).patch];
    await assert.rejects(g.client.bootstrapPrimaryCompanion({ history, resume: true }), { code: 'PRIMARY_BOOTSTRAP_FOREIGN_STATE' });
    assert.equal(messages(g).length, 1);
    // From history_sending: uncertain, then the same message under the same id.
    const h = await relinking();
    await stopUnacked(h, 2, { history });
    await assert.rejects(h.client.bootstrapPrimaryCompanion({ history, resume: true }), { code: 'PRIMARY_BOOTSTRAP_HISTORY_UNCERTAIN' });
    assert.equal((await h.client.bootstrapPrimaryCompanion({ history, resume: true, resendUncertain: true })).mode, 'relink');
    const sent = messages(h);
    assert.equal(sent.length, 4);
    assert.equal(sent[2].attrs.id, sent[1].attrs.id);
    assert.deepEqual(recentOf(sent[3]), EMPTY_RECENT);
    assert.equal(patchWrites(h).length, 0);
});

test('bootstrapEmptyPrimary keeps its contract', async t => {
    const f = await bootstrapFixture(t);
    const result = await f.client.bootstrapEmptyPrimaryCompanion({ getInitialHistory: async () => EMPTY });
    assert.deepEqual(result, { status: 'sent', browserReady: false, operationId: journal(f).transaction.id });
    assert.deepEqual(plain(messages(f)[1]), Bootstrap.initialHistory(EMPTY));
    // Its wire contract has no RECENT chunk: nothing follows, nothing goes up.
    assert.equal(messages(f).length, 2);
    assert.equal(f.uploads.length, 0);
    await assert.rejects(f.client.bootstrapEmptyPrimaryCompanion({ getInitialHistory: async () => EMPTY }), { code: 'PRIMARY_BOOTSTRAP_ALREADY_ATTEMPTED' });
    // Its own codes stay its own: an unknown server state is SERVER_STATE_REQUIRED
    // there, FOREIGN_STATE through the general entry point.
    const g = await bootstrapFixture(t);
    g.server.version = 12;
    await assert.rejects(g.client.bootstrapEmptyPrimaryCompanion({ getInitialHistory: async () => EMPTY }), { code: 'PRIMARY_BOOTSTRAP_SERVER_STATE_REQUIRED' });
    await assert.rejects(g.client.bootstrapPrimaryCompanion({ history: async () => snapshot() }), { code: 'PRIMARY_BOOTSTRAP_FOREIGN_STATE' });
    const h = await bootstrapFixture(t);
    await assert.rejects(h.client.bootstrapEmptyPrimaryCompanion({ getInitialHistory: async () => ({ ...EMPTY, messageCount: 1, conversationCount: 1 }) }), { code: 'PRIMARY_BOOTSTRAP_HISTORY_REQUIRED' });
    assert.equal(messages(h).length, 0);
});
