'use strict';
// Primary-origin bootstrap of a newly linked companion: share an app-state
// sync key, write the critical_block push-name patch, send the INITIAL_BOOTSTRAP
// history. This is encrypted protocol housekeeping, never a chat send. It is
// explicit, targets one authorized companion and never marks Web ready.
//
// Every step is journaled before it goes out, and the history is pinned on
// disk before it does, so a resume continues after the last accepted step with
// the recorded key, message id and bytes. A step whose outcome is unknown is
// sent again only when the caller asks for exactly that; one that was refused
// is not sent again at all.
//
// The pinned history is plaintext, and so is the media key of a history blob:
// both live only in the 0600 outbox, bound to its link transaction, and the
// outbox goes as soon as nothing can send it any more. The link journal keeps
// their digests.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { Writer } = require('protobufjs/minimal');
const C = require('./PrimaryLinkCrypto');
const { BinaryNode } = require('./BinaryNode');
const { jidStrToObj } = require('./DeviceManager');
const Sync = require('./appstate/AppStateSync');
const SyncdProto = require('./appstate/SyncdProto');
const { newState } = require('./appstate/LTHash');
const { pushNamePatch } = require('./appstate/Mutations');
const H = require('./primary/HistoryExport');

// The journaled phases, in the order a bootstrap passes them. A re-link has
// no critical_patch_* (its patch is already on the server); a bootstrap without
// a delta goes from history_accepted to sent.
const PHASES = ['prepared', 'key_share_sending', 'key_share_accepted', 'critical_patch_sending', 'critical_patch_accepted',
    'history_prepared', 'history_uploaded', 'history_sending', 'history_accepted',
    'delta_prepared', 'delta_uploaded', 'delta_sending', 'delta_accepted', 'sent'];
const at = phase => PHASES.indexOf(phase);
// A testing aid for an interrupted bootstrap, off unless asked for:
// WA_DEBUG_BOOTSTRAP_STOP_AFTER=<phase> kills this process, the way kill -9
// does and with no cleanup, the moment <phase> is journaled. Only a name in
// PHASES counts; any other value does nothing.
function journaled(phase) {
    const stop = process.env.WA_DEBUG_BOOTSTRAP_STOP_AFTER;
    if (stop && stop === phase && at(stop) >= 0) process.kill(process.pid, 'SIGKILL');
}
// Every phase a bootstrap passes is entered here.
function enter(linking, phase, change) {
    const saved = linking.journal.update(s => {
        if (phase === 'prepared') s.transaction.bootstrap = { phase };
        else s.transaction.bootstrap.phase = phase;
        if (change) change(s.transaction.bootstrap);
    });
    journaled(phase);
    return saved;
}
const EMPTY_HISTORY = Object.freeze({ seq: 0, chats: Object.freeze([]), records: Object.freeze({}), pushNames: Object.freeze([]) });
const RECENT = 3; // HistorySyncType of the delta
const WRITE_NEW = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;

function proto(fields) {
    const w = Writer.create();
    for (const [id, value] of fields) {
        if (Buffer.isBuffer(value)) w.uint32(id * 8 + 2).bytes(value);
        else w.uint32(id * 8).uint64(value);
    }
    return Buffer.from(w.finish());
}
function protocol(type, field, value) { return proto([[12, proto([[2, type], [field, value]])]]); }
function summarizeSyncResponse(node) {
    const collection = C.optionalChild(C.optionalChild(node, 'sync'), 'collection');
    const patches = C.optionalChild(collection, 'patches');
    const patchNodes = Array.isArray(patches?.content) ? patches.content.filter(n => n.description === 'patch') : [];
    const errors = [];
    function visit(n) {
        if (!n) return;
        for (const value of [n.attrs?.code, n.attrs?.error]) if (/^\d{3}$/.test(String(value || ''))) errors.push(String(value));
        if (Array.isArray(n.content)) n.content.forEach(visit);
    }
    visit(node);
    return { received: !!node, result: node?.attrs?.type === 'result', collection: collection?.attrs?.name === 'critical_block',
        version: /^\d{1,12}$/.test(String(collection?.attrs?.version || '')) ? Number(collection.attrs.version) : null,
        snapshot: !!C.optionalChild(collection, 'snapshot'), patches: !!patches, patchCount: patchNodes.length, errorCodes: [...new Set(errors)].slice(0, 8) };
}
function keyShare(id, keyData, state, timestamp) {
    const w = Writer.create().uint32(8).uint32(state.rawId).uint32(16).uint32(state.currentIndex).uint32(26).fork();
    for (const index of state.validIndexes) w.uint32(index);
    const fingerprint = Buffer.from(w.ldelim().finish());
    return protocol(6, 7, proto([[1, proto([[1, proto([[1, id]])], [2, proto([[1, keyData], [2, fingerprint], [3, timestamp]])]])]]));
}
function initialHistory(snapshot) {
    // An application must actually read its authoritative store. An absent
    // provider, nonempty history or unknown data cannot become a fake empty
    // bootstrap. bootstrapPrimaryCompanion is the entry point for real history.
    C.requireValue(snapshot && snapshot.source === 'owned_primary_store' && snapshot.messageCount === 0 && snapshot.conversationCount === 0, 'PRIMARY_BOOTSTRAP_HISTORY_REQUIRED');
    const compressed = zlib.deflateSync(proto([[1, 0], [5, 0], [6, 100]]));
    return protocol(5, 6, proto([[6, 0], [7, 0], [9, 100], [11, compressed]]));
}
function syncDirectory(file) {
    const dir = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
// Written beside the file and renamed over it: a reader finds the old file or
// the new one, never part of either.
function replacePrivate(file, text) {
    const target = file + '.tmp-' + crypto.randomBytes(8).toString('hex');
    try {
        const fd = fs.openSync(target, WRITE_NEW, 0o600);
        try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(target, file);
    } catch (error) {
        try { fs.unlinkSync(target); } catch (_) { /* never created, or already renamed */ }
        throw error;
    }
    syncDirectory(file);
}
function createPrivate(file, value, previous = null) {
    if (previous) {
        const current = fs.lstatSync(file);
        C.requireValue(current.isFile() && !current.isSymbolicLink() && current.ino === previous.ino && current.mtimeMs === previous.mtimeMs && current.size === previous.size, 'PRIMARY_BOOTSTRAP_KEYS_CHANGED');
        replacePrivate(file, JSON.stringify(value));
        return;
    }
    const fd = fs.openSync(file, WRITE_NEW, 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    syncDirectory(file);
}
// A resend passes the recorded messageId, so the companion sees the same
// message again rather than a second one.
async function strictPeer(linking, target, plaintext, operation, label, messageId) {
    const client = linking.client, id = messageId || client._genMsgId();
    linking.assertActive();
    const encrypted = await linking.wait(client._signal.encrypt(target, plaintext), operation);
    linking.assertActive();
    const node = new BinaryNode('message', { id, to: jidStrToObj(target), type: 'text', category: 'peer' }, [
        new BinaryNode('meta', { appdata: 'default' }, null),
        new BinaryNode('enc', { v: '2', type: encrypted.type }, encrypted.ciphertext)
    ]);
    let timer;
    const reply = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(C.failure('PRIMARY_BOOTSTRAP_ACK_UNCERTAIN')), 15000);
        client._pendingAcks.set(id, attrs => {
            try {
                const sender = attrs?.from ? C.jid(attrs.from) : null;
                const deviceId = target.split(':')[1]?.split('@')[0];
                const expected = [null, 's.whatsapp.net', linking.ownPhone, linking.ownLid, target, linking.ownLid ? linking.ownLid.replace('@', ':' + deviceId + '@') : null];
                const numeric = /^\d{3}$/.test(String(attrs?.error || '')) ? String(attrs.error) : null;
                linking.journal.update(s => { s.transaction.bootstrap.ack = { idMatched: attrs?.id === id, messageClass: attrs?.class === 'message', senderExpected: expected.includes(sender), errorCode: numeric, errorPresent: !!attrs?.error }; });
                C.requireValue(attrs && attrs.id === id && attrs.class === 'message' && !attrs.error && expected.includes(sender), numeric ? 'PRIMARY_BOOTSTRAP_ACK_' + numeric : 'PRIMARY_BOOTSTRAP_ACK_REJECTED');
                resolve();
            } catch (e) { reject(e); }
        });
    });
    reply.catch(() => {});
    try {
        enter(linking, label + '_sending', b => { b.messageId = id; });
        client._socket.sendNode(node);
        await linking.wait(reply, operation);
        enter(linking, label + '_accepted');
    } finally { clearTimeout(timer); client._pendingAcks.delete(id); }
}

// ─── local state ─────────────────────────────────────────────────────────────

function sessionFile(client, suffix) { return path.join(client._sessionDir, client._store.phoneNumber + suffix); }
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
// Only keys this primary made for its own bootstraps, under this raw ADV id.
function loadKeys(client, rawId) {
    const keyFile = sessionFile(client, '.appStateKeys.json');
    let previous = null, keys = {};
    if (fs.existsSync(keyFile)) {
        previous = fs.lstatSync(keyFile);
        C.requireValue(previous.isFile() && !previous.isSymbolicLink() && (previous.mode & 0o777) === 0o600 && previous.size < 65536, 'PRIMARY_BOOTSTRAP_EXISTING_KEYS');
        keys = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
        C.requireValue(Object.keys(keys).length > 0 && Object.keys(keys).length < 16 && Object.entries(keys).every(([id, k]) => /^[a-f0-9]{12}$/.test(id) && k.source === 'primary_bootstrap' && (rawId === undefined || k.fingerprint?.rawId === rawId) && Buffer.from(k.keyData, 'base64').length === 32), 'PRIMARY_BOOTSTRAP_EXISTING_KEYS');
    }
    return { keyFile, previous, keys };
}
const keyOf = ([hex, k]) => ({ hex, id: Buffer.from(hex, 'hex'), data: Buffer.from(k.keyData, 'base64'), timestamp: k.timestamp });
// The key this attempt recorded. Journals written before keys were recorded
// name it only by the ADV state it was made under.
function recordedKey(bootstrap, keys, state) {
    const matching = bootstrap.keyId
        ? Object.entries(keys).filter(([hex]) => hex === bootstrap.keyId)
        : Object.entries(keys).filter(([, k]) => k.fingerprint?.currentIndex === state.currentIndex && JSON.stringify(k.fingerprint.deviceIndexes) === JSON.stringify(state.validIndexes));
    return matching.length === 1 ? keyOf(matching[0]) : null;
}
async function trustedPeer(client, target, tx) {
    const trusted = await client._signal.store.loadIdentityKey(client._devMgr._jidToAddr(target));
    C.requireValue(trusted && C.equal(C.bare(trusted), Buffer.from(tx.peer, 'base64')), 'PRIMARY_BOOTSTRAP_PEER_UNMATCHED');
}

// ─── critical_block on the server ────────────────────────────────────────────

async function queryCriticalBlock(linking, operation) {
    const response = await linking.iq([new BinaryNode('sync', {}, [new BinaryNode('collection', { name: 'critical_block', return_snapshot: 'true' }, null)])], 'w:sync:app:state', 'set', operation);
    return C.child(C.child(response, 'sync'), 'collection');
}
function emptyCollection(collection) {
    return !collection.content || (Array.isArray(collection.content) && collection.content.every(n => n.description === 'patches' && (!n.content || (Array.isArray(n.content) && n.content.length === 0))));
}
// Run a decoder over server data; anything it cannot read is not ours.
function decoded(fn) { try { return fn(); } catch (_) { return null; } }
// critical_block as the server holds it, decoded from nothing with our own
// keys and every MAC checked. foreign: some part of it does not verify with
// them — an unknown key, a bad MAC, a record skipped, more than was sent.
async function readCriticalBlock(linking, operation, keys, collection = null) {
    const client = linking.client;
    collection = collection || await queryCriticalBlock(linking, operation);
    const attr = collection.attrs.version;
    const version = attr === undefined || attr === '' ? 0 : /^\d{1,12}$/.test(String(attr)) ? Number(attr) : null;
    const foreign = { version, foreign: true, state: null, keyId: null, indexes: [] };
    if (collection.attrs.name !== 'critical_block' || version === null) return foreign;
    if (emptyCollection(collection)) return version === 0 ? { ...foreign, foreign: false, state: newState() } : foreign;
    if (collection.attrs.has_more_patches === 'true' || !Array.isArray(collection.content) || !collection.content.every(n => n && ['snapshot', 'patches'].includes(n.description))) return foreign;
    for (const tag of ['snapshot', 'patches']) if (collection.content.filter(n => n.description === tag).length > 1) return foreign;
    const snapshotNode = C.optionalChild(collection, 'snapshot'), patchesNode = C.optionalChild(collection, 'patches');
    const byId = new Map(Object.entries(keys).map(([hex, k]) => [Buffer.from(hex, 'hex').toString('base64'), { keyData: Buffer.from(k.keyData, 'base64') }]));
    const getKey = id => byId.get(id) || null, indexes = [], collect = m => indexes.push(JSON.stringify(m.index));
    let state = newState(), keyId = null;
    if (snapshotNode) {
        const ref = decoded(() => SyncdProto.decodeExternalBlobReference(snapshotNode.content));
        if (!ref || !Buffer.isBuffer(snapshotNode.content)) return foreign;
        const blob = await linking.wait(client._fetchAppStateBlob(ref), operation);
        const snapshot = decoded(() => SyncdProto.decodeSnapshot(blob));
        const result = snapshot && snapshot.keyId && decoded(() => Sync.decodeSnapshot('critical_block', snapshot, getKey, collect, true));
        if (!result || !result.macOk || result.skipped) return foreign;
        state = result.state;
        keyId = snapshot.keyId;
    }
    const nodes = patchesNode?.content || [];
    if (!Array.isArray(nodes) || !nodes.every(n => n.description === 'patch' && Buffer.isBuffer(n.content))) return foreign;
    const patches = [];
    for (const n of nodes) {
        const patch = decoded(() => SyncdProto.decodePatch(n.content));
        if (!patch || !patch.keyId || patch.version === null) return foreign;
        if (patch.externalMutations) {
            const blob = await linking.wait(client._fetchAppStateBlob(patch.externalMutations), operation);
            const more = decoded(() => SyncdProto.decodeMutations(blob));
            if (!more) return foreign;
            patch.mutations = patch.mutations.concat(more);
        }
        patches.push(patch);
    }
    if (patches.length) {
        const result = decoded(() => Sync.decodePatches('critical_block', patches, state, getKey, collect, true));
        if (!result || result.macFailed || result.skipped) return foreign;
        state = result.state;
        keyId = patches[patches.length - 1].keyId;
    }
    if (state.version !== version) return foreign;
    return { version, foreign: false, state, keyId: Buffer.from(keyId).toString('hex'), indexes };
}
// verified: the server's critical_block is the one we hold, at our version.
function sameAsLocal(client, seen) {
    const local = client._appState.get('critical_block');
    return !seen.foreign && seen.version === local.version && C.equal(Buffer.from(seen.state.hash), Buffer.from(local.hash));
}
async function verifyServerCriticalBlock(linking, operation = null) {
    const client = linking.client, tx = linking.journal.snapshot().transaction;
    C.requireValue(client._appState, 'PRIMARY_BOOTSTRAP_EXISTING_STATE');
    // A key file that cannot be read as only our own keys is foreign state
    // already, whatever the server holds.
    let keys = null;
    try { keys = loadKeys(client, tx?.state?.rawId).keys; } catch (_) { /* not ours */ }
    const seen = await readCriticalBlock(linking, operation, keys || {});
    return { version: seen.version, verified: !!keys && sameAsLocal(client, seen), foreign: !keys || seen.foreign };
}
// first: nothing local and nothing on the server. relink: our own key wrote
// what the server holds, at our version. Nothing else is bootstrapped over.
async function classify(linking, operation, tx, legacy) {
    const client = linking.client;
    C.requireValue(client._appState, 'PRIMARY_BOOTSTRAP_EXISTING_STATE');
    const relink = !legacy && client._appState.get('critical_block').version > 0;
    if (!relink) {
        C.requireValue(Object.values(client._appState.versions()).every(v => v === 0), 'PRIMARY_BOOTSTRAP_EXISTING_STATE');
        C.requireValue(!fs.existsSync(sessionFile(client, '.appState.json')), 'PRIMARY_BOOTSTRAP_EXISTING_STATE');
    }
    const keyring = loadKeys(client, tx.state.rawId);
    for (const suffix of ['.history.json', '.messages.json'])
        C.requireValue(!fs.existsSync(sessionFile(client, suffix)), 'PRIMARY_BOOTSTRAP_EXISTING_HISTORY');
    // Do not initialize a collection over any unknown server state.
    const collection = await queryCriticalBlock(linking, operation);
    if (!relink) {
        C.requireValue(collection.attrs.name === 'critical_block' && (!collection.attrs.version || collection.attrs.version === '0') && emptyCollection(collection), legacy ? 'PRIMARY_BOOTSTRAP_SERVER_STATE_REQUIRED' : 'PRIMARY_BOOTSTRAP_FOREIGN_STATE');
        return { ...keyring, mode: 'first', keyId: null };
    }
    const seen = await readCriticalBlock(linking, operation, keyring.keys, collection);
    C.requireValue(sameAsLocal(client, seen), 'PRIMARY_BOOTSTRAP_FOREIGN_STATE');
    return { ...keyring, mode: 'relink', keyId: seen.keyId };
}
function rejected(node) {
    return !!node && !!(node.description === 'error' || node.attrs?.error || node.attrs?.type === 'error' || (Array.isArray(node.content) && node.content.some(rejected)));
}
function adoptCriticalBlock(linking, state) {
    const client = linking.client;
    client._appState.set('critical_block', state);
    const persisted = JSON.parse(fs.readFileSync(sessionFile(client, '.appState.json'), 'utf8'));
    C.requireValue(persisted.critical_block?.version === state.version, 'PRIMARY_BOOTSTRAP_PERSISTENCE_REQUIRED');
    enter(linking, 'critical_patch_accepted');
}
async function writeCriticalPatch(linking, operation, name, key) {
    const client = linking.client;
    C.requireValue(client._appState.get('critical_block').version === 0, 'PRIMARY_BOOTSTRAP_EXISTING_STATE');
    // Producer patches carry the previous revision on the collection.
    // The server assigns SyncdPatch.version; match the independent Go
    // encoder and do not send a reader-side version field in this write.
    const desc = { ...pushNamePatch(name), omitWireVersion: true }, built = Sync.buildPatch(desc, key.id, key.data, client._appState.get(desc.name));
    enter(linking, 'critical_patch_sending');
    // An answer that refuses the write is final: a resume does not write it again.
    const applied = await linking.iq([new BinaryNode('sync', {}, [new BinaryNode('collection', { name: desc.name, version: '0', return_snapshot: 'false' }, [new BinaryNode('patch', {}, built.patch)])])], 'w:sync:app:state', 'set', operation,
        node => linking.journal.update(s => { s.transaction.bootstrap.iq = summarizeSyncResponse(node); s.transaction.bootstrap.patchRefused = rejected(node); }));
    C.requireValue(!rejected(applied), 'PRIMARY_BOOTSTRAP_PATCH_REJECTED');
    adoptCriticalBlock(linking, built.state);
}

// ─── history ─────────────────────────────────────────────────────────────────

function checkSnapshot(snapshot) {
    C.requireValue(snapshot && Number.isSafeInteger(snapshot.seq) && snapshot.seq >= 0 && Array.isArray(snapshot.chats) && snapshot.records && typeof snapshot.records === 'object' && Array.isArray(snapshot.pushNames)
        && Object.values(snapshot.records).every(Array.isArray), 'PRIMARY_BOOTSTRAP_HISTORY_REQUIRED');
    return snapshot;
}
// Counted as exported: records the export leaves out are not counted.
function encode(snapshot, syncType) {
    checkSnapshot(snapshot);
    const bytes = H.buildHistorySync(snapshot, { syncType }), counts = H.exportedCounts(snapshot);
    return { bytes, seq: snapshot.seq, chats: counts.chats, records: counts.records };
}
// What the store says it missed, so a partial history is not reported as a
// whole one: losses is how many loss records the snapshot holds (a run of
// messages seen but not stored, or a time the store was not capturing),
// evicted how many messages its limits dropped. null where a provider does
// not say.
function completeness(snapshot) {
    return { losses: Array.isArray(snapshot.losses) ? snapshot.losses.length : null,
        evicted: Number.isSafeInteger(snapshot.retained?.evicted) ? snapshot.retained.evicted : null,
        captureOrigin: typeof snapshot.capture?.origin === 'string' ? snapshot.capture.origin : null };
}
const outboxFile = client => sessionFile(client, '.primary-history-outbox.json');
// The pinned payload, only if it is still this transaction's and still the
// bytes the journal recorded.
function readOutbox(file, record, txId) {
    try {
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        let saved;
        try {
            const info = fs.fstatSync(fd);
            C.requireValue(info.isFile() && !(info.mode & 0o077));
            saved = JSON.parse(fs.readFileSync(fd, 'utf8'));
        } finally { fs.closeSync(fd); }
        const bytes = Buffer.from(saved.bytes, 'base64');
        C.requireValue(saved.txId === txId && saved.sha256 === record.sha256 && digest(bytes) === record.sha256 && bytes.length === record.bytes && saved.inline === record.inline && saved.cutoff.seq === record.cutoff.seq);
        return { saved, bytes };
    } catch (_) { throw C.failure('PRIMARY_BOOTSTRAP_OUTBOX_INVALID'); }
}
// Best effort: the outbox only ever holds what may be sent, and nothing reads
// one that is gone as anything but gone.
function discardOutbox(client) {
    try { fs.unlinkSync(outboxFile(client)); } catch (_) { /* already gone */ }
}
// At the start of every bootstrap: one its own attempt can never send now goes,
// and so does one that was read and names no transaction or another one. An
// outbox that cannot be read (EACCES, EIO, a damaged file) says nothing about
// whose it is, and is left for the resume to judge: deleting it would leave an
// attempt that can never be finished.
function discardStaleOutbox(client, tx) {
    if (tx?.bootstrap && finished(tx.bootstrap)) { discardOutbox(client); return; }
    let saved;
    try { saved = JSON.parse(fs.readFileSync(outboxFile(client), 'utf8')); }
    catch (_) { return; }
    if (!tx || !saved || typeof saved !== 'object' || saved.txId !== tx.id) discardOutbox(client);
}
const blobDigest = blob => digest(JSON.stringify([blob.directPath, blob.mediaKey, blob.fileSha256, blob.fileEncSha256, blob.fileLength]));
// What the upload says it stored must be the pinned bytes, or it is not sent.
function uploaded(result, record) {
    C.requireValue(result && typeof result.directPath === 'string' && result.directPath.length > 0 && Buffer.isBuffer(result.mediaKey) && result.mediaKey.length === 32
        && Buffer.isBuffer(result.fileSha256) && result.fileSha256.toString('hex') === record.sha256 && Buffer.isBuffer(result.fileEncSha256) && result.fileEncSha256.length === 32
        && result.fileLength === record.bytes, 'PRIMARY_BOOTSTRAP_UPLOAD_INVALID');
    return { directPath: result.directPath, mediaKey: result.mediaKey.toString('base64'), fileSha256: result.fileSha256.toString('base64'),
        fileEncSha256: result.fileEncSha256.toString('base64'), fileLength: result.fileLength };
}
// The upload of a history blob runs on a clock of its own, outside the
// bootstrap's time limit: a minute, and a second more for each 16 KiB (an
// upload slower than 128 kbit/s), at most 20 minutes. uploadTimeoutMs, when
// given, replaces it.
const UPLOAD_BASE_MS = 60000, UPLOAD_BYTES_PER_SECOND = 16384, UPLOAD_MAX_MS = 20 * 60000;
function uploadBudget(bytes) {
    return Math.min(UPLOAD_MAX_MS, UPLOAD_BASE_MS + Math.ceil(bytes / UPLOAD_BYTES_PER_SECOND) * 1000);
}
// A failed upload is said as one, with what failed as its cause.
async function uploadOnce(upload, bytes) {
    try { return await upload(bytes); }
    catch (failure) {
        if (/^PRIMARY_/.test(failure?.code || '')) throw failure;
        const error = C.failure('PRIMARY_BOOTSTRAP_UPLOAD_FAILED');
        error.cause = failure;
        throw error;
    }
}
function blobOf(saved) {
    return { directPath: saved.directPath, mediaKey: Buffer.from(saved.mediaKey, 'base64'), fileSha256: Buffer.from(saved.fileSha256, 'base64'),
        fileEncSha256: Buffer.from(saved.fileEncSha256, 'base64'), fileLength: saved.fileLength };
}
// One history payload ('history' or 'delta') from pinning to its ACK. fresh is
// the encoded payload when this label has not been pinned yet; after that the
// outbox and the journal are the only source of what goes out.
async function deliver(linking, operation, context, label, fresh, syncType) {
    const { target, txId, upload, uploadTimeoutMs } = context, file = outboxFile(linking.client);
    let bootstrap = linking.journal.snapshot().transaction.bootstrap, pinned = null;
    if (at(bootstrap.phase) < at(label + '_prepared')) {
        const record = { sha256: digest(fresh.bytes), bytes: fresh.bytes.length, inline: fresh.bytes.length <= H.INLINE_MAX, cutoff: { seq: fresh.seq },
            chats: fresh.chats, records: fresh.records, ...fresh.completeness };
        pinned = { saved: { txId, sha256: record.sha256, bytes: fresh.bytes.toString('base64'), inline: record.inline, cutoff: record.cutoff }, bytes: fresh.bytes };
        replacePrivate(file, JSON.stringify(pinned.saved));
        bootstrap = enter(linking, label + '_prepared', b => { b[label] = record; }).transaction.bootstrap;
    }
    // Until a message points at it, a blob is uploaded afresh: a resume from
    // _uploaded uploads again, since the blob it recorded may have expired.
    if (!bootstrap[label].inline && at(bootstrap.phase) < at(label + '_sending')) {
        pinned = pinned || readOutbox(file, bootstrap[label], txId);
        C.requireValue(typeof upload === 'function', 'PRIMARY_BOOTSTRAP_UPLOAD_REQUIRED');
        const budget = uploadTimeoutMs === undefined ? uploadBudget(pinned.bytes.length) : uploadTimeoutMs;
        const blob = uploaded(await linking.apart(uploadOnce(upload, pinned.bytes), operation, budget, 'PRIMARY_BOOTSTRAP_UPLOAD_TIMEOUT'), bootstrap[label]);
        // Its media key goes beside the bytes it encrypts, never into the journal.
        pinned = { ...pinned, saved: { ...pinned.saved, blob } };
        replacePrivate(file, JSON.stringify(pinned.saved));
        bootstrap = enter(linking, label + '_uploaded', b => {
            Object.assign(b[label], { uploaded: true, uploadedAt: Date.now(), blobDigest: blobDigest(blob) });
        }).transaction.bootstrap;
    }
    const record = bootstrap[label];
    if (at(bootstrap.phase) < at(label + '_accepted')) {
        pinned = pinned || readOutbox(file, record, txId);
        // A resend from _sending carries the very blob its first send pointed at.
        C.requireValue(record.inline || (pinned.saved.blob && blobDigest(pinned.saved.blob) === record.blobDigest), 'PRIMARY_BOOTSTRAP_OUTBOX_INVALID');
        const payload = record.inline ? { inline: pinned.bytes } : { blob: blobOf(pinned.saved.blob) };
        await strictPeer(linking, target, H.buildNotification(payload, { syncType }), operation, label, bootstrap.phase === label + '_sending' ? bootstrap.messageId : undefined);
    }
    return record;
}
// An attempt that can never send its history any more: sent, or a step the
// other side refused. An accepting ACK may be an earlier step's and proves
// nothing; any refusal stops the attempt at its own step, so a refusing ACK
// at a *_sending phase is that step's.
const accepting = ack => ack.idMatched && ack.messageClass && ack.senderExpected && !ack.errorPresent;
function finished(bootstrap) {
    const phase = String(bootstrap.phase);
    if (phase === 'sent') return true;
    if (phase === 'critical_patch_sending') return bootstrap.patchRefused === true;
    return phase.endsWith('_sending') && !!bootstrap.ack && !accepting(bootstrap.ack);
}
// Whether a recorded attempt may continue. Checked before anything is read
// from the server or sent, so a refusal changes nothing.
function checkResumable(bootstrap, resendUncertain) {
    // A refusal is an answer, not an uncertainty.
    C.requireValue(at(bootstrap.phase) >= 0 && !finished(bootstrap), 'PRIMARY_BOOTSTRAP_ALREADY_ATTEMPTED');
    // An unanswered critical_patch_sending is settled by reading critical_block back.
    if (!bootstrap.phase.endsWith('_sending') || bootstrap.phase === 'critical_patch_sending') return;
    C.requireValue(resendUncertain, bootstrap.phase === 'key_share_sending' ? 'PRIMARY_BOOTSTRAP_KEY_SHARE_UNCERTAIN' : 'PRIMARY_BOOTSTRAP_HISTORY_UNCERTAIN');
}

// ─── the bootstrap ───────────────────────────────────────────────────────────

// legacy: bootstrapEmptyPrimary's contract — first mode only, never resumed,
// and its original error codes.
async function bootstrap(linking, options, legacy) {
    // The time the bootstrap has, the history upload aside (uploadBudget).
    const operation = linking.begin({ timeoutMs: legacy ? 60000 : options.timeoutMs === undefined ? 90000 : options.timeoutMs, signal: options.signal });
    let started = false;
    try {
        const client = linking.client, tx = linking.journal.snapshot().transaction;
        const limit = options.uploadTimeoutMs;
        C.requireValue(limit === undefined || (Number.isInteger(limit) && limit >= 1000 && limit <= 3600000), 'PRIMARY_BOOTSTRAP_UPLOAD_TIMEOUT_INVALID');
        discardStaleOutbox(client, tx);
        // A connection that drops mid-bootstrap leaves the link uncertain
        // (PrimaryLinking.close). The attempt recorded on it may still resume,
        // bound below to the same device and peer it started with.
        const resumable = !legacy && options.resume === true && tx?.phase === 'uncertain' && !!tx.bootstrap;
        C.requireValue(tx && (['awaiting_confirmation', 'committed'].includes(tx.phase) || resumable) && tx.peer && tx.state && tx.before, 'PRIMARY_BOOTSTRAP_AUTHORIZED_LINK_REQUIRED');
        const was = tx.bootstrap;
        const recover = options.recoverRejected === true && was?.phase === 'key_share_sending' && was.ack?.errorCode === '479' && was.ack.errorPresent === true && !was.recoveryCount;
        const resume = !legacy && !recover && options.resume === true && !!was;
        C.requireValue(!was || recover || resume, 'PRIMARY_BOOTSTRAP_ALREADY_ATTEMPTED');
        if (resume) checkResumable(was, options.resendUncertain === true);
        const step = resume ? at(was.phase) : -1;
        C.requireValue(tx.before.length === 1 && tx.before[0].id === 0, 'PRIMARY_BOOTSTRAP_EXISTING_COMPANIONS_UNSUPPORTED');
        C.requireValue(typeof options.history === 'function', 'PRIMARY_BOOTSTRAP_HISTORY_REQUIRED');
        // Read and encode the history before anything goes out: a store that
        // cannot be exported never gets a link half bootstrapped.
        let history = null;
        if (step < at('history_prepared')) {
            const snapshot = await linking.wait(options.history(), operation);
            history = { ...encode(snapshot, 0), completeness: completeness(snapshot) };
        }
        const name = client._store.name;
        C.requireValue(typeof name === 'string' && name.trim() && name !== 'User' && name.length <= 25, 'PRIMARY_BOOTSTRAP_NAME_REQUIRED');
        // Pair IQ acceptance precedes usync visibility. Only poll the exact old
        // baseline; any unexpected device/index fails immediately.
        let own, peer;
        const visibleUntil = Date.now() + 10000;
        for (let attempt = 0; ; attempt++) {
            own = await linking.queryOwn(operation);
            peer = own.devices.filter(d => d.id !== 0);
            if (own.devices.length === 2 && peer.length === 1) break;
            C.requireValue(own.devices.length === tx.before.length && tx.before.every(p => own.devices.some(d => d.id === p.id && d.keyIndex === p.keyIndex && d.hasKeyIndex === p.hasKeyIndex)), 'PRIMARY_BOOTSTRAP_DEVICE_UNCONFIRMED');
            C.requireValue(Date.now() < visibleUntil, 'PRIMARY_BOOTSTRAP_DEVICE_UNCONFIRMED');
            await linking.wait(new Promise(resolve => setTimeout(resolve, Math.min(1000, 100 * (attempt + 1)))), operation);
        }
        C.requireValue(own.devices.length === 2 && peer.length === 1 && peer[0].keyIndex === tx.state.currentIndex && (!tx.expectedDeviceId || peer[0].id === tx.expectedDeviceId) && (!was || peer[0].id === was.deviceId), 'PRIMARY_BOOTSTRAP_DEVICE_UNCONFIRMED');
        const target = linking.ownPhone.replace('@', ':' + peer[0].id + '@');
        // Bind the transport's Signal peer to the key authorized by phone code
        // or QR. Never silently reuse/replace an unrelated old session.
        const bundles = await linking.wait(client._devMgr.fetchBundles([target]), operation), bundle = bundles.get(target);
        C.requireValue(bundle && C.equal(C.bare(bundle.identityKey), Buffer.from(tx.peer, 'base64')), 'PRIMARY_BOOTSTRAP_PEER_UNMATCHED');
        let buildSession = !recover;
        if (recover) await trustedPeer(client, target, tx);
        else if (resume) {
            // This attempt's own session, if it got as far as building one.
            if (await client._signal.hasSession(target)) { await trustedPeer(client, target, tx); buildSession = false; }
        } else C.requireValue(!(await client._signal.hasSession(target)), 'PRIMARY_BOOTSTRAP_EXISTING_SESSION');
        // Until its patch is accepted, an attempt is re-checked as if new.
        let mode = was?.mode || 'first', keyring = null, key = null;
        if (step < at('critical_patch_sending')) {
            const found = await classify(linking, operation, tx, legacy);
            C.requireValue(!resume || found.mode === mode, 'PRIMARY_BOOTSTRAP_FOREIGN_STATE');
            mode = found.mode;
            keyring = found;
            if (recover || resume) {
                key = recordedKey(was, keyring.keys, tx.state);
                C.requireValue(key || !recover, 'PRIMARY_BOOTSTRAP_EXISTING_KEYS');
                C.requireValue(mode === 'first' || (key && key.hex === found.keyId), 'PRIMARY_BOOTSTRAP_FOREIGN_STATE');
                // Only a first bootstrap that stopped before its key file
                // existed may make the key now: nothing was sent with it.
                C.requireValue(key || (mode === 'first' && was.phase === 'prepared'), 'PRIMARY_BOOTSTRAP_KEYS_CHANGED');
            } else if (mode === 'relink') key = keyOf([found.keyId, keyring.keys[found.keyId]]);
        } else if (mode === 'first' && step < at('critical_patch_accepted')) {
            keyring = loadKeys(client, tx.state.rawId);
            key = recordedKey(was, keyring.keys, tx.state);
            C.requireValue(key, 'PRIMARY_BOOTSTRAP_KEYS_CHANGED');
        }
        const created = !!keyring && !key;
        if (created) {
            const id = crypto.randomBytes(6);
            key = { hex: id.toString('hex'), id, data: crypto.randomBytes(32), timestamp: Date.now() };
        }
        // Record the attempt before creating any key, session or server write.
        if (!resume) {
            enter(linking, 'prepared', b => { Object.assign(b, { startedAt: Date.now(), deviceId: peer[0].id, mode, keyId: key.hex, ...(recover ? { recoveryCount: 1, previousAck: was.ack } : {}) }); });
        } else if (created) linking.journal.update(s => { s.transaction.bootstrap.keyId = key.hex; });
        started = true;
        try {
            if (created) createPrivate(keyring.keyFile, { ...keyring.keys, [key.hex]: { keyData: key.data.toString('base64'), timestamp: key.timestamp,
                fingerprint: { rawId: tx.state.rawId, currentIndex: tx.state.currentIndex, deviceIndexes: tx.state.validIndexes }, source: 'primary_bootstrap' } }, keyring.previous);
            if (buildSession) await linking.wait(client._signal.buildSessionFromBundle(target, bundle), operation);
            // A re-link shares the key it already uses, under this link's ADV state.
            if (step < at('key_share_accepted'))
                await strictPeer(linking, target, keyShare(key.id, key.data, tx.state, key.timestamp), operation, 'key_share', step === at('key_share_sending') ? was.messageId : undefined);
            if (mode === 'first' && step < at('critical_patch_accepted')) {
                let landed = false;
                if (step === at('critical_patch_sending')) {
                    // The write's answer was lost. Read critical_block back
                    // rather than guess: our patch there is accepted, an empty
                    // collection never got it, anything else is not ours.
                    const seen = await readCriticalBlock(linking, operation, keyring.keys);
                    landed = !seen.foreign && seen.version === 1 && seen.keyId === key.hex && seen.indexes.length === 1 && seen.indexes[0] === JSON.stringify(['setting_pushName']);
                    C.requireValue(landed || (!seen.foreign && seen.version === 0), 'PRIMARY_BOOTSTRAP_FOREIGN_STATE');
                    if (landed) adoptCriticalBlock(linking, seen.state);
                }
                if (!landed) await writeCriticalPatch(linking, operation, name, key);
            }
        } finally { if (key) key.data.fill(0); }
        // The handshake above takes seconds, and messages keep arriving. The
        // history is read again, and encoded, right before it is pinned, so
        // what the store kept by now goes too. The read at the start stays:
        // nothing went out for a store that could not be exported then.
        if (!legacy && at(linking.journal.snapshot().transaction.bootstrap.phase) < at('history_prepared')) {
            const snapshot = await linking.wait(options.history(), operation);
            try { history = { ...encode(snapshot, 0), completeness: completeness(snapshot) }; }
            catch (failure) {
                const error = C.failure('PRIMARY_BOOTSTRAP_HISTORY_INVALID');
                error.cause = failure;
                throw error;
            }
        }
        const context = { target, txId: tx.id, upload: options.upload, uploadTimeoutMs: options.uploadTimeoutMs };
        const pinned = await deliver(linking, operation, context, 'history', history, 0);
        // What reached the store after the pinned cutoff, as a RECENT chunk. A
        // delta once pinned is finished whatever this call asked for.
        let delta = null;
        if (at(linking.journal.snapshot().transaction.bootstrap.phase) >= at('delta_prepared'))
            delta = { records: (await deliver(linking, operation, context, 'delta', null, RECENT)).records };
        else if (options.delta === true) {
            const after = H.recordsAfter(checkSnapshot(await linking.wait(options.history(), operation)), pinned.cutoff);
            const records = H.exportedCounts(after).records;
            // Nothing that goes over arrived after the cutoff: nothing to send.
            if (records) await deliver(linking, operation, context, 'delta', encode(after, RECENT), RECENT);
            delta = { records };
        }
        // What went over, kept for the status: it outlives the run that sent it.
        enter(linking, 'sent', b => { delete b.errorCode; b.delivered = { chats: pinned.chats, records: pinned.records }; });
        // Sent: nothing pinned stays on disk, revoked content included.
        discardOutbox(client);
        return { status: 'sent', mode, operationId: tx.id, delta, history: { chats: pinned.chats, records: pinned.records, bytes: pinned.bytes, inline: pinned.inline,
            losses: pinned.losses ?? null, evicted: pinned.evicted ?? null, captureOrigin: pinned.captureOrigin ?? null } };
    } catch (failure) {
        // The encoder's own codes stay its own; out of here they are one.
        let error = failure;
        if (/^PRIMARY_HISTORY_EXPORT_/.test(failure?.code || '')) {
            error = C.failure('PRIMARY_BOOTSTRAP_HISTORY_INVALID');
            error.cause = failure;
        }
        if (started && !linking.journal.closed && linking.journal.snapshot().transaction?.bootstrap) {
            const code = /^PRIMARY_(?:LINK|BOOTSTRAP|MESSAGE_STORE)_[A-Z_0-9]+$/.test(error?.code || '') ? error.code : 'PRIMARY_BOOTSTRAP_LOCAL_ERROR';
            const now = linking.journal.update(s => { s.transaction.bootstrap.errorCode = code; }).transaction.bootstrap;
            // Refused: what was pinned for it can never be sent.
            if (finished(now)) discardOutbox(linking.client);
            // Whether a resume can go on from here, for whoever tells the person what to do next.
            try { error.resumable = !finished(now); } catch (_) { /* a frozen error still carries its code */ }
        }
        throw error;
    } finally { linking.end(operation); }
}
// history: () => Promise<Snapshot> (PrimaryMessageStore.snapshot() shape).
// upload: (bytes) => Promise<{ directPath, mediaKey, fileSha256, fileEncSha256,
// fileLength }>, used only for a history above INLINE_MAX.
async function bootstrapPrimaryCompanion(linking, options = {}) {
    return bootstrap(linking, options, false);
}
// The original single-attempt empty bootstrap, now the empty case of the one
// above: same checks, same codes, the same bytes on the wire.
async function bootstrapEmptyPrimary(linking, options = {}) {
    const read = options.getInitialHistory;
    const history = typeof read === 'function' ? async () => { initialHistory(await read()); return EMPTY_HISTORY; } : undefined;
    const result = await bootstrap(linking, { history, recoverRejected: options.recoverRejected, signal: options.signal }, true);
    return { status: 'sent', browserReady: false, operationId: result.operationId };
}
module.exports = { bootstrapEmptyPrimary, bootstrapPrimaryCompanion, verifyServerCriticalBlock, discardOutbox, finished, keyShare, initialHistory, proto, strictPeer, summarizeSyncResponse, uploadBudget };
