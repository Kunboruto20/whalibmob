'use strict';
// Primary-origin bootstrap for a newly registered, locally empty account.
// This is encrypted protocol housekeeping, never a chat send. It is explicit,
// single-attempt, targets one authorized companion and never marks Web ready.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { Writer } = require('protobufjs/minimal');
const C = require('./PrimaryLinkCrypto');
const { BinaryNode } = require('./BinaryNode');
const { jidStrToObj } = require('./DeviceManager');
const Sync = require('./appstate/AppStateSync');
const { pushNamePatch } = require('./appstate/Mutations');

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
    // bootstrap. Nonempty-history export is a separate, unsupported capability.
    C.requireValue(snapshot && snapshot.source === 'owned_primary_store' && snapshot.messageCount === 0 && snapshot.conversationCount === 0, 'PRIMARY_BOOTSTRAP_HISTORY_REQUIRED');
    const compressed = zlib.deflateSync(proto([[1, 0], [5, 0], [6, 100]]));
    return protocol(5, 6, proto([[6, 0], [7, 0], [9, 100], [11, compressed]]));
}
function createPrivate(file, value, previous = null) {
    if (previous) {
        const current = fs.lstatSync(file);
        C.requireValue(current.isFile() && !current.isSymbolicLink() && current.ino === previous.ino && current.mtimeMs === previous.mtimeMs && current.size === previous.size, 'PRIMARY_BOOTSTRAP_KEYS_CHANGED');
    }
    const target = previous ? file + '.tmp-' + crypto.randomBytes(8).toString('hex') : file;
    const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    if (previous) fs.renameSync(target, file);
    const dir = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
async function strictPeer(linking, target, plaintext, operation, label) {
    const client = linking.client, id = client._genMsgId();
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
        linking.journal.update(s => { s.transaction.bootstrap.phase = label + '_sending'; s.transaction.bootstrap.messageId = id; });
        client._socket.sendNode(node);
        await linking.wait(reply, operation);
        linking.journal.update(s => { s.transaction.bootstrap.phase = label + '_accepted'; });
    } finally { clearTimeout(timer); client._pendingAcks.delete(id); }
}
async function bootstrapEmptyPrimary(linking, options = {}) {
    const operation = linking.begin({ timeoutMs: 60000, signal: options.signal });
    let prepared = false;
    try {
        const client = linking.client, saved = linking.journal.snapshot(), tx = saved.transaction;
        C.requireValue(tx && ['awaiting_confirmation', 'committed'].includes(tx.phase) && tx.peer && tx.state && tx.before, 'PRIMARY_BOOTSTRAP_AUTHORIZED_LINK_REQUIRED');
        const recover = options.recoverRejected === true && tx.bootstrap?.phase === 'key_share_sending' && tx.bootstrap.ack?.errorCode === '479' && tx.bootstrap.ack.errorPresent === true && !tx.bootstrap.recoveryCount;
        C.requireValue(!tx.bootstrap || recover, 'PRIMARY_BOOTSTRAP_ALREADY_ATTEMPTED');
        C.requireValue(tx.before.length === 1 && tx.before[0].id === 0, 'PRIMARY_BOOTSTRAP_EXISTING_COMPANIONS_UNSUPPORTED');
        C.requireValue(typeof options.getInitialHistory === 'function', 'PRIMARY_BOOTSTRAP_HISTORY_REQUIRED');
        const snapshot = await linking.wait(options.getInitialHistory(), operation), history = initialHistory(snapshot);
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
        C.requireValue(own.devices.length === 2 && peer.length === 1 && peer[0].keyIndex === tx.state.currentIndex && (!tx.expectedDeviceId || peer[0].id === tx.expectedDeviceId), 'PRIMARY_BOOTSTRAP_DEVICE_UNCONFIRMED');
        const target = linking.ownPhone.replace('@', ':' + peer[0].id + '@');
        // Bind the transport's Signal peer to the key authorized by phone code
        // or QR. Never silently reuse/replace an unrelated old session.
        const bundles = await linking.wait(client._devMgr.fetchBundles([target]), operation), bundle = bundles.get(target);
        C.requireValue(bundle && C.equal(C.bare(bundle.identityKey), Buffer.from(tx.peer, 'base64')), 'PRIMARY_BOOTSTRAP_PEER_UNMATCHED');
        if (recover) {
            const trusted = await client._signal.store.loadIdentityKey(client._devMgr._jidToAddr(target));
            C.requireValue(trusted && C.equal(C.bare(trusted), Buffer.from(tx.peer, 'base64')), 'PRIMARY_BOOTSTRAP_PEER_UNMATCHED');
        } else C.requireValue(!(await client._signal.hasSession(target)), 'PRIMARY_BOOTSTRAP_EXISTING_SESSION');
        C.requireValue(client._appState && Object.values(client._appState.versions()).every(v => v === 0), 'PRIMARY_BOOTSTRAP_EXISTING_STATE');
        C.requireValue(!fs.existsSync(path.join(client._sessionDir, client._store.phoneNumber + '.appState.json')), 'PRIMARY_BOOTSTRAP_EXISTING_STATE');
        const keyFile = path.join(client._sessionDir, client._store.phoneNumber + '.appStateKeys.json');
        let previous = null, keys = {};
        if (fs.existsSync(keyFile)) {
            previous = fs.lstatSync(keyFile);
            C.requireValue(previous.isFile() && !previous.isSymbolicLink() && (previous.mode & 0o777) === 0o600 && previous.size < 65536, 'PRIMARY_BOOTSTRAP_EXISTING_KEYS');
            keys = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
            C.requireValue(Object.keys(keys).length > 0 && Object.keys(keys).length < 16 && Object.entries(keys).every(([id, k]) => /^[a-f0-9]{12}$/.test(id) && k.source === 'primary_bootstrap' && k.fingerprint?.rawId === tx.state.rawId && Buffer.from(k.keyData, 'base64').length === 32), 'PRIMARY_BOOTSTRAP_EXISTING_KEYS');
        }
        for (const suffix of ['.history.json', '.messages.json'])
            C.requireValue(!fs.existsSync(path.join(client._sessionDir, client._store.phoneNumber + suffix)), 'PRIMARY_BOOTSTRAP_EXISTING_HISTORY');
        // Do not initialize a collection over any unknown server state.
        const response = await linking.iq([new BinaryNode('sync', {}, [new BinaryNode('collection', { name: 'critical_block', return_snapshot: 'true' }, null)])], 'w:sync:app:state', 'set', operation);
        const collection = C.child(C.child(response, 'sync'), 'collection');
        const empty = !collection.content || (Array.isArray(collection.content) && collection.content.every(n => n.description === 'patches' && (!n.content || (Array.isArray(n.content) && n.content.length === 0))));
        C.requireValue(collection.attrs.name === 'critical_block' && (!collection.attrs.version || collection.attrs.version === '0') && empty, 'PRIMARY_BOOTSTRAP_SERVER_STATE_REQUIRED');
        // Record the attempt before creating any key, session or server write.
        let selected;
        if (recover) {
            const matching = Object.entries(keys).filter(([, k]) => k.fingerprint?.currentIndex === tx.state.currentIndex && JSON.stringify(k.fingerprint.deviceIndexes) === JSON.stringify(tx.state.validIndexes));
            C.requireValue(matching.length === 1, 'PRIMARY_BOOTSTRAP_EXISTING_KEYS');
            selected = matching[0];
        }
        linking.journal.update(s => { s.transaction.bootstrap = { phase: 'prepared', startedAt: Date.now(), deviceId: peer[0].id, ...(recover ? { recoveryCount: 1, previousAck: tx.bootstrap.ack } : {}) }; });
        prepared = true;
        const id = recover ? Buffer.from(selected[0], 'hex') : crypto.randomBytes(6), data = recover ? Buffer.from(selected[1].keyData, 'base64') : crypto.randomBytes(32), timestamp = recover ? selected[1].timestamp : Date.now();
        try {
            if (!recover) createPrivate(keyFile, { ...keys, [id.toString('hex')]: { keyData: data.toString('base64'), timestamp,
                fingerprint: { rawId: tx.state.rawId, currentIndex: tx.state.currentIndex, deviceIndexes: tx.state.validIndexes }, source: 'primary_bootstrap' } }, previous);
            if (!recover) await linking.wait(client._signal.buildSessionFromBundle(target, bundle), operation);
            await strictPeer(linking, target, keyShare(id, data, tx.state, timestamp), operation, 'key_share');
            // Producer patches carry the previous revision on the collection.
            // The server assigns SyncdPatch.version; match the independent Go
            // encoder and do not send a reader-side version field in this write.
            const desc = { ...pushNamePatch(name), omitWireVersion: true }, built = Sync.buildPatch(desc, id, data, client._appState.get(desc.name));
            linking.journal.update(s => { s.transaction.bootstrap.phase = 'critical_patch_sending'; });
            const applied = await linking.iq([new BinaryNode('sync', {}, [new BinaryNode('collection', { name: desc.name, version: '0', return_snapshot: 'false' }, [new BinaryNode('patch', {}, built.patch)])])], 'w:sync:app:state', 'set', operation,
                node => linking.journal.update(s => { s.transaction.bootstrap.iq = summarizeSyncResponse(node); }));
            const rejected = node => node && (node.description === 'error' || node.attrs?.error || node.attrs?.type === 'error' || (Array.isArray(node.content) && node.content.some(rejected)));
            C.requireValue(!rejected(applied), 'PRIMARY_BOOTSTRAP_PATCH_REJECTED');
            client._appState.set(desc.name, built.state);
            const persisted = JSON.parse(fs.readFileSync(path.join(client._sessionDir, client._store.phoneNumber + '.appState.json'), 'utf8'));
            C.requireValue(persisted[desc.name]?.version === built.state.version, 'PRIMARY_BOOTSTRAP_PERSISTENCE_REQUIRED');
            linking.journal.update(s => { s.transaction.bootstrap.phase = 'critical_patch_accepted'; });
            await strictPeer(linking, target, history, operation, 'initial_history');
            linking.journal.update(s => { s.transaction.bootstrap.phase = 'sent'; });
            return { status: 'sent', browserReady: false, operationId: tx.id };
        } finally { data.fill(0); }
    } catch (error) {
        if (prepared && !linking.journal.closed && linking.journal.snapshot().transaction?.bootstrap) {
            const code = /^PRIMARY_(?:LINK|BOOTSTRAP)_[A-Z_0-9]+$/.test(error?.code || '') ? error.code : 'PRIMARY_BOOTSTRAP_LOCAL_ERROR';
            linking.journal.update(s => { s.transaction.bootstrap.errorCode = code; });
        }
        throw error;
    } finally { linking.end(operation); }
}
module.exports = { bootstrapEmptyPrimary, keyShare, initialHistory, proto, strictPeer, summarizeSyncResponse };
