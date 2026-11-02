'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { WhalibmobClient } = require('../lib/Client');
const { createNewStore } = require('../lib/Store');
const { BinaryNode } = require('../lib/BinaryNode');
const P = require('../lib/PairingCode');
const C = require('../lib/PrimaryLinkCrypto');
const { PrimaryLinkStore } = require('../lib/PrimaryLinkStore');
const { configureSuccessfulPairing } = require('../lib/CompanionPairing');
test('mobile bare server JID keeps exact sender binding for IQ and notifications', () => {
    const server = { user: null, server: 's.whatsapp.net' };
    assert.equal(C.jid(server), 's.whatsapp.net');
    assert.doesNotThrow(() => require('../lib/PrimaryLinking').checkResponse(new BinaryNode('iq', { id: 'synthetic-id', type: 'result', from: server }, []), 'synthetic-id'));
    assert.throws(() => require('../lib/PrimaryLinking').checkResponse(new BinaryNode('iq', { id: 'synthetic-id', type: 'result', from: { user: null, server: 'foreign.invalid' } }, []), 'synthetic-id'));
    assert.equal(C.jid({ user: '15550000123', device: 7, server: 's.whatsapp.net' }), '15550000123:7@s.whatsapp.net');
});
// Separate primary and companion key sets; no TCP, SMS, account fixture or
// existing session file. The actual companion library verifies and countersigns.
async function fixture(t, options = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'primary-link-test-'));
    fs.chmodSync(dir, 0o700);
    const client = new WhalibmobClient({ sessionDir: dir, refreshVersion: false });
    client._store = createNewStore('15550000123');
    client._store.registered = true;
    client._myLid = '1234567890@lid';
    client._connected = true;
    client._scheduleReconnect = () => { };
    const identity = P.generateEphemeralKeyPair(), noise = P.generateEphemeralKeyPair(), ephemeral = P.generateEphemeralKeyPair();
    const code = 'K7M2QX4B', ref = Buffer.from('synthetic-independent-companion-ref');
    const wrapped = await P.buildWrappedEphemeralPub(code, ephemeral.public);
    const qrSecret = crypto.randomBytes(32);
    const qr = [ref.toString(), noise.public.toString('base64'), identity.public.toString('base64'), qrSecret.toString('base64'), '1'].join(',');
    let companionProof = null, linked = !!options.existingDevice, requests = [], pairWrites = 0, primaryNotices = [];
    let outgoingIdentity = null, challengeResult = null;
    const reply = (query, content = []) => client._handleIq(new BinaryNode('iq', { id: query.attrs.id, type: 'result', from: 's.whatsapp.net' }, content));
    let postPairQueries = 0;
    const devices = () => [new BinaryNode('device', { id: '0' }, null), ...(linked && (!options.bootstrapVisibilityDelay || ++postPairQueries > 1) ? [new BinaryNode('device', { id: '7', 'key-index': String(options.wrongIndex ? 99 : 1) }, null)] : [])];
    let lastFinish;
    const finishNote = (bundle) => lastFinish = new BinaryNode('notification', { id: 'finish-notification', from: 's.whatsapp.net', type: 'link_code_companion_reg' }, [
        new BinaryNode('link_code_companion_reg', { stage: 'companion_finish' }, [
            new BinaryNode('link_code_pairing_ref', {}, ref), new BinaryNode('companion_identity_public', {}, identity.public), new BinaryNode('link_code_pairing_wrapped_key_bundle', {}, bundle)
        ])
    ]);
    client._socket = { close: () => client._onClose(), sendNode(node) {
            requests.push(node);
            if (options.bootstrap && node.description === 'message') {
                if (!options.bootstrapHangAck) queueMicrotask(() => client._handleAck(new BinaryNode('ack', { id: node.attrs.id, class: 'message', from: options.foreignBootstrapAck ? 'foreign.invalid' : '15550000123@s.whatsapp.net', ...(options.bootstrapRejectAck ? { error: '403' } : {}) }, null)));
                return;
            }
            if (node.description !== 'iq')
                return;
            queueMicrotask(async () => {
                try {
                    if (node.attrs.xmlns === 'passive') {
                        reply(node);
                        return;
                    }
                    if (node.attrs.xmlns === 'usync') {
                        const sync = C.child(node, 'usync');
                        reply(node, [new BinaryNode('usync', { sid: sync.attrs.sid }, [new BinaryNode('list', {}, [
                                    new BinaryNode('user', { jid: '15550000123@s.whatsapp.net' }, [new BinaryNode('devices', {}, [new BinaryNode('device-list', {}, devices())])])
                                ])])]);
                        return;
                    }
                    if (options.bootstrap && node.attrs.xmlns === 'w:sync:app:state') {
                        const collection = C.child(C.child(node, 'sync'), 'collection');
                        if (options.bootstrapPatchCode && C.optionalChild(collection, 'patch')) {
                            client._handleIq(new BinaryNode('iq', { id: node.attrs.id, type: 'error', from: 's.whatsapp.net' }, [new BinaryNode('error', { code: options.bootstrapPatchCode }, Buffer.from('not retained'))]));
                            return;
                        }
                        reply(node, [new BinaryNode('sync', {}, [new BinaryNode('collection', { name: 'critical_block', version: options.bootstrapRemoteState ? '12' : '0' }, options.bootstrapEmptyPatches ? [new BinaryNode('patches', {}, [])] : null)])]);
                        return;
                    }
                    const hello = C.optionalChild(node, 'link_code_companion_reg');
                    if (hello) {
                        assert.equal(hello.attrs.stage, 'primary_hello');
                        const finish = await P.buildCompanionFinishBundle({ pairingCode: code, pairingEphemeralPrivate: ephemeral.private, primaryEphemeralPubWrapped: C.payload(hello, 'link_code_pairing_wrapped_primary_ephemeral_pub', 80), primaryIdentityPub: C.payload(hello, 'primary_identity_pub', 32), identityKeyPair: identity });
                        lastCompanionSecret = finish.advSecretKey;
                        if (options.badBundle)
                            finish.wrappedKeyBundle[60] ^= 1;
                        if (options.finishBeforeIQ) {
                            client._handleNotification(finishNote(finish.wrappedKeyBundle));
                            reply(node);
                        }
                        else {
                            reply(node);
                            queueMicrotask(() => client._handleNotification(finishNote(finish.wrappedKeyBundle)));
                        }
                        client.emit('message', { id: 'synthetic-interleaved' });
                        return;
                    }
                    const pair = C.child(node, 'pair-device');
                    pairWrites++;
                    assert.equal(!!C.optionalChild(pair, 'pem'), !options.qr);
                    const signed = C.decode('hmac', C.child(pair, 'device-identity').content);
                    const info = C.decode('signed', signed[1]);
                    const details = C.decode('identity', info[1]);
                    primaryNotices.push(details);
                    if (options.hangPair)
                        return;
                    if (options.nullPair) {
                        client._pendingIqs.get(node.attrs.id)?.(null);
                        return;
                    }
                    if (options.pairError) {
                        client._handleIq(new BinaryNode('iq', { id: node.attrs.id, type: 'error', from: 's.whatsapp.net' }, [new BinaryNode('error', { code: '403' }, null)]));
                        return;
                    }
                    if (options.challenge) {
                        challengeResult = new BinaryNode('retry-after-challenges', {}, [new BinaryNode('friction', {}, null)]);
                        reply(node, [challengeResult]);
                        return;
                    }
                    if (options.retryTimestamp && (pairWrites === 1 || options.retryTimestamp === 'repeat')) {
                        reply(node, [new BinaryNode('retry-ts', { ts: String(details[2] + 1) }, null)]);
                        return;
                    }
                    // Run the unmodified companion's pair-success implementation.
                    const result = configureSuccessfulPairing(new BinaryNode('iq', { id: 'independent-companion-pair-success' }, [
                        new BinaryNode('pair-success', {}, [
                            new BinaryNode('device-identity', {}, C.child(pair, 'device-identity').content),
                            new BinaryNode('device', { jid: '15550000123:7@s.whatsapp.net', lid: '1234567890:7@lid' }, null)
                        ])
                    ]), { advSecretKey: await deriveSecretForCompanion(node), identityKeyPair: identity }, BinaryNode);
                    outgoingIdentity = result.accountEnc;
                    const signedDevice = C.decode('signed', outgoingIdentity);
                    companionProof = { jid: result.me.id, lid: result.me.lid, details: signedDevice[1], accountSignatureKey: signedDevice[2], accountSignature: signedDevice[3], deviceSignature: signedDevice[4] };
                    linked = true;
                    reply(node, options.noDeviceResult ? [] : [new BinaryNode('device', { jid: '1234567890:7@lid' }, null)]);
                }
                catch (error) {
                    client._pendingIqs.get(node.attrs.id)?.(null);
                    t.diagnostic('synthetic peer failure: ' + (error.code || error.name));
                }
            });
        } };
    let lastCompanionSecret = options.qr ? qrSecret.toString('base64') : null;
    async function deriveSecretForCompanion() { return lastCompanionSecret; }
    const hello = new BinaryNode('notification', { id: 'hello-notification', from: 's.whatsapp.net', type: 'link_code_companion_reg' }, [
        new BinaryNode('link_code_companion_reg', { stage: 'companion_hello' }, [
            new BinaryNode('link_code_pairing_ref', {}, ref), new BinaryNode('companion_server_auth_key_pub', {}, noise.public), new BinaryNode('link_code_pairing_wrapped_companion_ephemeral_pub', {}, wrapped)
        ])
    ]);
    if (!options.qr && !options.deferHello) client._handleNotification(hello);
    t.after(() => { client.disconnect(); fs.rmSync(dir, { recursive: true, force: true }); });
    return { client, dir, code, qr, qrSecret, hello, requests, noise, identity, get lastFinish() { return lastFinish; }, removeServerDevice() { linked = false; }, get proof() { return companionProof; }, get pairWrites() { return pairWrites; }, get primaryNotices() { return primaryNotices; }, get outgoingIdentity() { return outgoingIdentity; }, invitation: client.getPrimaryLinkInvitations()[0] };
}
// The fixture is intentionally a complete protocol peer, not a stubbed
// 'success' flag. Store the builder's secret in that peer's own closure.
test('read-only linking status refreshes the device list without exposing or changing a reservation', async t => {
    const f = await fixture(t);
    await f.client.approveCompanionCode(f.code, { invitationId: f.invitation.id });
    const file = path.join(f.dir, '15550000123.primary-linking.json');
    const before = fs.readFileSync(file);
    const status = await f.client.getPrimaryLinkStatus();
    assert.deepEqual(Object.keys(status).sort(), ['bootstrapPhase', 'confirmed', 'devices', 'expectedDeviceId', 'hasADV', 'phase', 'startedAt']);
    assert.equal(status.phase, 'awaiting_confirmation');
    assert.equal(status.hasADV, false);
    assert.deepEqual(status.devices, [{ deviceId: 0, keyIndex: 0 }, { deviceId: 7, keyIndex: 1 }]);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(f.pairWrites, 1);
    await f.client.reconcilePrimaryLink(f.proof);
    assert.equal((await f.client.getPrimaryLinkStatus()).confirmed, true);
    f.removeServerDevice();
    assert.equal((await f.client.getPrimaryLinkStatus()).confirmed, false);
});
test('authenticated finish redelivery with a new delivery ID is ACKed without pairing again', async t => {
    const f = await fixture(t);
    await f.client.approveCompanionCode(f.code, { invitationId: f.invitation.id });
    const linking = f.client._primaryLinking, errors = [], notices = [];
    f.client.on('primary_link_error', e => { errors.push(e.code); notices.push(e); });
    const tx = linking.journal.snapshot().transaction;
    const redelivery = new BinaryNode('notification', { ...f.lastFinish.attrs, id: 'new-delivery-id' }, f.lastFinish.content);
    f.client._handleNotification(redelivery);
    assert.equal(f.pairWrites, 1);
    assert.deepEqual(errors, []);
    assert.deepEqual(linking.journal.snapshot().transaction, tx);
    assert.ok(f.requests.some(n => n.description === 'ack' && n.attrs.id === 'new-delivery-id'));
    const altered = new BinaryNode('notification', { ...redelivery.attrs, id: 'altered-delivery' }, [new BinaryNode('link_code_companion_reg', { stage: 'companion_finish' }, f.lastFinish.content[0].content.map(n => new BinaryNode(n.description, n.attrs, n.description === 'companion_identity_public' ? Buffer.alloc(32) : n.content)))]);
    f.client._handleNotification(altered);
    assert.deepEqual(errors, ['PRIMARY_LINK_FINISH_UNMATCHED']);
    assert.equal(notices[0].scope, 'notification');
    assert.equal(notices[0].operationId, null);
    assert.equal(f.requests.some(n => n.description === 'ack' && n.attrs.id === 'altered-delivery'), false);
});
test('absent pending device can be retired after two baseline queries without reusing its index or committing ADV', async t => {
    const f = await fixture(t);
    await f.client.approveCompanionCode(f.code, { invitationId: f.invitation.id });
    const linking = f.client._primaryLinking;
    await assert.rejects(f.client.retireAbsentPrimaryLink(), { code: 'PRIMARY_LINK_RETIRE_TOO_EARLY' });
    linking.journal.update(s => { s.transaction.startedAt = Date.now() - 300001; });
    await assert.rejects(f.client.retireAbsentPrimaryLink(), { code: 'PRIMARY_LINK_DEVICE_STILL_PRESENT' });
    f.removeServerDevice();
    const before = linking.journal.snapshot();
    const count = f.requests.length;
    assert.equal((await f.client.retireAbsentPrimaryLink()).status, 'abandoned');
    assert.equal(f.requests.slice(count).filter(n => n.description === 'iq').length, 2);
    const after = linking.journal.snapshot();
    assert.equal(after.adv, null);
    assert.deepEqual(after.usedCodes, before.usedCodes);
    assert.equal(after.transaction.phase, 'abandoned');
    const next = C.reserveState(null, before.transaction.before, before.transaction.state.timestamp, after.reservationFloor);
    assert.equal(next.rawId, before.transaction.state.rawId);
    assert.equal(next.currentIndex, before.transaction.state.currentIndex + 1);
    assert.ok(next.timestamp > before.transaction.state.timestamp);
    assert.deepEqual(next.validIndexes, [0, next.currentIndex]);
    assert.equal(f.pairWrites, 1);
});
test('a mandatory verification hold cannot be retired through absence recovery', async t => {
    const f = await fixture(t, { challenge: true });
    await assert.rejects(f.client.approveCompanionCode(f.code, { invitationId: f.invitation.id }));
    const before = f.client._primaryLinking.journal.snapshot();
    await assert.rejects(f.client.retireAbsentPrimaryLink(), { code: 'PRIMARY_LINK_NO_RETIRABLE_TRANSACTION' });
    assert.deepEqual(f.client._primaryLinking.journal.snapshot(), before);
});
test('a fresh server list can prune logged-out companions without resetting raw ID or reusing an index', () => {
    const previous = { rawId: 123, currentIndex: 4, timestamp: 999, validIndexes: [0, 2, 4] };
    const next = C.reserveState(previous, [{ id: 0, keyIndex: 0, hasKeyIndex: false }], 999, previous);
    assert.deepEqual(next, { rawId: 123, currentIndex: 5, timestamp: 1000, validIndexes: [0, 5] });
    assert.throws(() => C.reserveState(previous, [{ id: 0 }, { id: 1, keyIndex: 99, hasKeyIndex: true }], 1000), { code: 'PRIMARY_LINK_ADV_MISMATCH' });
});
async function bootstrapFixture(t, options = {}) {
    const f = await fixture(t, { bootstrap: true, ...options });
    f.client._store.name = 'Local Primary';
    f.client._appState = new (require('../lib/appstate/AppStateStore').AppStateStore)(path.join(f.dir, '15550000123.appState.json'));
    f.client._devMgr = { async fetchBundles(jids) { return new Map([[jids[0], { identityKey: options.foreignBootstrapPeer ? Buffer.alloc(32) : f.identity.public }]]); } };
    f.client._signal = { async hasSession() { return false; }, async buildSessionFromBundle() {}, async encrypt(jid, plaintext) { return { type: 'pkmsg', ciphertext: Buffer.from(plaintext) }; } };
    if (options.qr) await f.client.approveCompanionQr(f.qr);
    else await f.client.approveCompanionCode(f.code, { invitationId: f.invitation.id });
    return f;
}
test('empty primary bootstrap shares one real new key and history only with its authorized peer, without pretending Web is ready', async t => {
    const f = await bootstrapFixture(t);
    const result = await f.client.bootstrapEmptyPrimaryCompanion({ getInitialHistory: async () => ({ source: 'owned_primary_store', messageCount: 0, conversationCount: 0 }) });
    assert.equal(result.status, 'sent');
    assert.equal(result.browserReady, false);
    const messages = f.requests.filter(n => n.description === 'message');
    assert.equal(messages.length, 2);
    const upload = f.requests.find(n => n.description === 'iq' && n.attrs.xmlns === 'w:sync:app:state' && C.optionalChild(C.optionalChild(C.optionalChild(n, 'sync'), 'collection'), 'patch'));
    const patch = C.child(C.child(C.child(upload, 'sync'), 'collection'), 'patch');
    const wire = require('../lib/proto/MessageProto').decodeFields(patch.content);
    assert.equal(wire[1], undefined, 'the producer leaves the patch revision for the server to assign');
    assert.equal(C.child(C.child(upload, 'sync'), 'collection').attrs.version, '0');
    const decoded = messages.map(m => {
        assert.equal(m.attrs.category, 'peer');
        assert.equal(m.attrs.device_fanout, undefined);
        assert.equal(String(m.attrs.to), f.proof.jid);
        assert.equal(C.optionalChild(m, 'participants'), null);
        return require('../lib/proto/MessageProto').decodeMessageContainer(C.child(m, 'enc').content);
    });
    assert.equal(decoded[0].appStateSyncKeyShare.keys.length, 1);
    assert.equal(decoded[0].appStateSyncKeyShare.keys[0].keyData.length, 32);
    const notification = decoded[1].historySyncNotification;
    assert.equal(notification.syncType, 0);
    assert.equal(notification.progress, 100);
    const history = require('../lib/HistorySyncHandler').decodeHistorySync(require('node:zlib').inflateSync(notification.initialHistBootstrapInlinePayload));
    assert.equal(history.conversations.length, 0);
    assert.equal(history.progress, 100);
    const keyFile = path.join(f.dir, '15550000123.appStateKeys.json');
    assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(f.dir, '15550000123.appState.json')).mode & 0o777, 0o600);
    assert.equal(f.client._primaryLinking.journal.snapshot().transaction.phase, 'awaiting_confirmation');
    await assert.rejects(f.client.bootstrapEmptyPrimaryCompanion({ getInitialHistory: async () => ({ source: 'owned_primary_store', messageCount: 0, conversationCount: 0 }) }), { code: 'PRIMARY_BOOTSTRAP_ALREADY_ATTEMPTED' });
    assert.equal(f.requests.filter(n => n.description === 'message').length, 2);
});
test('unknown server state, a different peer, nonempty history and a rejected ACK never get a fake successful bootstrap', async t => {
    for (const [options, expected] of [[{ bootstrapRemoteState: true }, 'PRIMARY_BOOTSTRAP_SERVER_STATE_REQUIRED'], [{ foreignBootstrapPeer: true }, 'PRIMARY_BOOTSTRAP_PEER_UNMATCHED'], [{ bootstrapRejectAck: true }, 'PRIMARY_BOOTSTRAP_ACK_403'], [{ foreignBootstrapAck: true }, 'PRIMARY_BOOTSTRAP_ACK_REJECTED']]) {
        const f = await bootstrapFixture(t, options);
        await assert.rejects(f.client.bootstrapEmptyPrimaryCompanion({ getInitialHistory: async () => ({ source: 'owned_primary_store', messageCount: 0, conversationCount: 0 }) }), { code: expected });
        assert.ok(!f.client._primaryLinking.journal.snapshot().transaction.bootstrap || f.client._primaryLinking.journal.snapshot().transaction.bootstrap.phase !== 'sent');
        assert.ok(f.requests.filter(n => n.description === 'message').length <= 1);
    }
    const f = await bootstrapFixture(t);
    await assert.rejects(f.client.bootstrapEmptyPrimaryCompanion({ getInitialHistory: async () => ({ source: 'owned_primary_store', messageCount: 1, conversationCount: 1 }) }), { code: 'PRIMARY_BOOTSTRAP_HISTORY_REQUIRED' });
    assert.equal(f.requests.filter(n => n.description === 'message').length, 0);
});
test('bootstrap waits for usync visibility after pair acceptance and accepts an explicitly empty patches wrapper', async t => {
    const f = await bootstrapFixture(t, { bootstrapVisibilityDelay: true, bootstrapEmptyPatches: true });
    assert.equal((await f.client.bootstrapEmptyPrimaryCompanion({ getInitialHistory: async () => ({ source: 'owned_primary_store', messageCount: 0, conversationCount: 0 }) })).status, 'sent');
    assert.equal(f.pairWrites, 1);
});
test('an explicit patch rejection remains held, keeps its numeric diagnostic and can only be inspected without another write', async t => {
    const f = await bootstrapFixture(t, { bootstrapPatchCode: '400' });
    await assert.rejects(f.client.bootstrapEmptyPrimaryCompanion({ getInitialHistory: async () => ({ source: 'owned_primary_store', messageCount: 0, conversationCount: 0 }) }), { code: 'PRIMARY_LINK_IQ_REJECTED' });
    const journal = f.client._primaryLinking.journal.snapshot();
    assert.equal(journal.transaction.bootstrap.phase, 'critical_patch_sending');
    assert.equal(journal.transaction.bootstrap.errorCode, 'PRIMARY_LINK_IQ_REJECTED');
    assert.deepEqual(journal.transaction.bootstrap.iq.errorCodes, ['400']);
    assert.equal(fs.existsSync(path.join(f.dir, '15550000123.appState.json')), false);
    const writes = f.requests.filter(n => n.description === 'message' || (n.description === 'iq' && C.optionalChild(C.optionalChild(C.optionalChild(n, 'sync'), 'collection'), 'patch'))).length;
    const file = path.join(f.dir, '15550000123.primary-linking.json'), before = fs.readFileSync(file);
    const status = await f.client.getPrimaryLinkStatus();
    assert.equal(status.bootstrap.remote.version, 0);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(f.requests.filter(n => n.description === 'message' || (n.description === 'iq' && C.optionalChild(C.optionalChild(C.optionalChild(n, 'sync'), 'collection'), 'patch'))).length, writes);
    assert.ok(!JSON.stringify(status).includes('not retained'));
});
test('an unknown existing local collection is preserved even when the old loader treated it as version zero', async t => {
    const f = await bootstrapFixture(t), file = path.join(f.dir, '15550000123.appState.json');
    fs.writeFileSync(file, 'unknown existing state', { mode: 0o600 });
    await assert.rejects(f.client.bootstrapEmptyPrimaryCompanion({ getInitialHistory: async () => ({ source: 'owned_primary_store', messageCount: 0, conversationCount: 0 }) }), { code: 'PRIMARY_BOOTSTRAP_EXISTING_STATE' });
    assert.equal(fs.readFileSync(file, 'utf8'), 'unknown existing state');
    assert.equal(f.requests.filter(n => n.description === 'message').length, 0);
});
test('a never-published bootstrap key from a retired attempt is retained during the next authorized first bootstrap', async t => {
    const f = await bootstrapFixture(t), file = path.join(f.dir, '15550000123.appStateKeys.json');
    const state = f.client._primaryLinking.journal.snapshot().transaction.state;
    const old = { keyData: Buffer.alloc(32, 9).toString('base64'), timestamp: 123, fingerprint: { rawId: state.rawId, currentIndex: 1, deviceIndexes: [0, 1] }, source: 'primary_bootstrap' };
    fs.writeFileSync(file, JSON.stringify({ '010203040506': old }), { mode: 0o600 });
    await f.client.bootstrapEmptyPrimaryCompanion({ getInitialHistory: async () => ({ source: 'owned_primary_store', messageCount: 0, conversationCount: 0 }) });
    const saved = JSON.parse(fs.readFileSync(file));
    assert.deepEqual(saved['010203040506'], old);
    assert.equal(Object.keys(saved).length, 2);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(f.client._primaryLinking.journal.snapshot().transaction.bootstrap.ack.senderExpected, true);
});
test('explicit recovery of a known 479 preserves the same key and pairing; an uncertain or 403 result cannot be retried', async t => {
    const f = await bootstrapFixture(t), original = f.client._handleAck.bind(f.client);
    let first = true;
    f.client._handleAck = node => { if (first) { node.attrs.error = '479'; first = false; } original(node); };
    const history = async () => ({ source: 'owned_primary_store', messageCount: 0, conversationCount: 0 });
    await assert.rejects(f.client.bootstrapEmptyPrimaryCompanion({ getInitialHistory: history }), { code: 'PRIMARY_BOOTSTRAP_ACK_479' });
    const file = path.join(f.dir, '15550000123.appStateKeys.json'), before = fs.readFileSync(file);
    await assert.rejects(f.client.bootstrapEmptyPrimaryCompanion({ getInitialHistory: history }), { code: 'PRIMARY_BOOTSTRAP_ALREADY_ATTEMPTED' });
    f.client._signal.store = { async loadIdentityKey() { return f.identity.public; } };
    f.client._devMgr._jidToAddr = jid => jid;
    assert.equal((await f.client.bootstrapEmptyPrimaryCompanion({ getInitialHistory: history, recoverRejected: true })).status, 'sent');
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(f.pairWrites, 1);
    assert.equal(f.requests.filter(n => n.description === 'message').length, 3);
    const g = await bootstrapFixture(t, { bootstrapRejectAck: true });
    await assert.rejects(g.client.bootstrapEmptyPrimaryCompanion({ getInitialHistory: history }), { code: 'PRIMARY_BOOTSTRAP_ACK_403' });
    await assert.rejects(g.client.bootstrapEmptyPrimaryCompanion({ getInitialHistory: history, recoverRejected: true }), { code: 'PRIMARY_BOOTSTRAP_ALREADY_ATTEMPTED' });
});
for (const settings of [{}, { finishBeforeIQ: true }, { retryTimestamp: true }, { noDeviceResult: true }]) {
    test('primary approves an independent companion, durably commits and keeps its socket ' + JSON.stringify(settings), async (t) => {
        const f = await fixture(t, settings), socket = f.client._socket;
        let interleaved = 0;
        f.client.on('message', () => interleaved++);
        const result = await f.client.approveCompanionCode(f.code, { invitationId: f.invitation.id, expectedNoiseKey: f.noise.public, expectedIdentityKey: f.identity.public, getCompanionProof: async () => f.proof });
        assert.equal(result.status, 'linked');
        assert.equal(result.deviceId, 7);
        assert.equal(f.client._mode, 'mobile');
        assert.equal(f.client._socket, socket);
        assert.equal(interleaved, 1);
        assert.deepEqual(await f.client.listLinkedDevices(), [{ deviceId: 7, keyIndex: 1 }]);
        const file = path.join(f.dir, '15550000123.primary-linking.json'), data = JSON.parse(fs.readFileSync(file));
        assert.equal(data.transaction.phase, 'committed');
        assert.equal(data.adv.currentIndex, 1);
        assert.equal(fs.statSync(file).mode & 0o777, 0o600);
        const raw = fs.readFileSync(file, 'utf8');
        assert.ok(!raw.includes(f.code));
        assert.ok(!raw.includes(f.client._store.identityKeyPair.private.toString('base64')));
        if (settings.retryTimestamp) {
            assert.equal(f.pairWrites, 2);
            assert.equal(f.primaryNotices[0][1], f.primaryNotices[1][1]);
            assert.equal(f.primaryNotices[0][3], f.primaryNotices[1][3]);
            assert.equal(f.primaryNotices[1][2], f.primaryNotices[0][2] + 1);
        }
        else
            assert.equal(f.pairWrites, 1);
        assert.ok(f.outgoingIdentity);
    });
}
test('a missing independent proof returns pending, and restart reconciliation sends only a fresh own query', async (t) => {
    const f = await fixture(t);
    const pending = await f.client.approveCompanionCode(f.code, { invitationId: f.invitation.id });
    assert.equal(pending.status, 'awaiting_confirmation');
    await assert.rejects(f.client.approveCompanionCode(f.code, { invitationId: f.invitation.id }), { code: 'PRIMARY_LINK_RECONCILIATION_REQUIRED' });
    f.client._closePrimaryLinking();
    const before = f.requests.length;
    const result = await f.client.reconcilePrimaryLink(f.proof);
    assert.equal(result.status, 'linked');
    assert.equal(f.pairWrites, 1);
    assert.equal(f.requests.length - before, 1);
    assert.equal(f.requests.at(-1).attrs.xmlns, 'usync');
});
test('a malformed finish cannot send pair-device or mark a device linked', async (t) => {
    const f = await fixture(t, { badBundle: true });
    await assert.rejects(f.client.approveCompanionCode(f.code, { invitationId: f.invitation.id }), { code: 'PRIMARY_LINK_KEY_EXCHANGE_INVALID' });
    assert.equal(f.pairWrites, 0);
});
test('server challenges are held and never automatically answered', async (t) => {
    const f = await fixture(t, { challenge: true });
    await assert.rejects(f.client.approveCompanionCode(f.code, { invitationId: f.invitation.id }), { code: 'PRIMARY_LINK_VERIFICATION_REQUIRED' });
    assert.equal(f.pairWrites, 1);
    await assert.rejects(f.client.approveCompanionCode(f.code, { invitationId: f.invitation.id }), { code: 'PRIMARY_LINK_RECONCILIATION_REQUIRED' });
});
test('wrong signatures and a different server key index cannot commit, and do not replay', async (t) => {
    const f = await fixture(t, { wrongIndex: true });
    await f.client.approveCompanionCode(f.code, { invitationId: f.invitation.id });
    const bad = { ...f.proof, deviceSignature: Buffer.alloc(64) };
    await assert.rejects(f.client.reconcilePrimaryLink(bad));
    await assert.rejects(f.client.reconcilePrimaryLink(f.proof), { code: 'PRIMARY_LINK_DEVICE_LIST_UNCONFIRMED' });
    assert.equal(f.pairWrites, 1);
});
test('unknown existing devices require the authoritative old ADV state', async (t) => {
    const f = await fixture(t, { existingDevice: true });
    await assert.rejects(f.client.approveCompanionCode(f.code, { invitationId: f.invitation.id }), { code: 'PRIMARY_LINK_EXISTING_ADV_REQUIRED' });
    assert.equal(f.pairWrites, 0);
});
test('pending alerts receipt ACKs do not authorize another companion', async (t) => {
    const f = await fixture(t);
    assert.equal(f.pairWrites, 0);
    assert.equal(f.requests.filter(n => n.description === 'ack').length, 1);
    f.client._handleNotification(f.hello);
    assert.equal(f.requests.filter(n => n.description === 'ack').length, 2);
    assert.equal(f.client.getPrimaryLinkInvitations().length, 1);
    assert.equal(f.pairWrites, 0);
    await assert.rejects(f.client.approveCompanionCode(f.code, { invitationId: f.invitation.id, expectedNoiseKey: Buffer.alloc(32) }), { code: 'PRIMARY_LINK_INVITATION_UNMATCHED' });
    assert.equal(f.pairWrites, 0);
});
test('companion-mode notification dispatch retains its original handler', () => {
    let called = 0, acked = 0;
    const client = { _mode: 'web', emit() { }, _handleCompanionFinish() { called++; }, _socket: { sendNode() { acked++; } }, _connected: true };
    WhalibmobClient.prototype._handleNotification.call(client, new BinaryNode('notification', { type: 'link_code_companion_reg', id: 'synthetic' }, []));
    assert.equal(called, 1);
    assert.equal(acked, 1);
});
test('store ownership is exclusive and an account binding cannot be changed', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'primary-link-store-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'journal.json');
    const one = new PrimaryLinkStore(file, 'synthetic-binding');
    assert.throws(() => new PrimaryLinkStore(file, 'synthetic-binding'), { code: 'PRIMARY_LINK_STORE_BUSY' });
    one.close();
    assert.throws(() => new PrimaryLinkStore(file, 'other-binding'), { code: 'PRIMARY_LINK_STORE_INVALID' });
    const same = new PrimaryLinkStore(file, 'synthetic-binding');
    same.close();
});
test('abort after a pair write preserves uncertainty for inspection without a repeat', async (t) => {
    const f = await fixture(t, { hangPair: true });
    const abort = new AbortController();
    const operation = f.client.approveCompanionCode(f.code, { invitationId: f.invitation.id, signal: abort.signal });
    while (!f.pairWrites)
        await new Promise(resolve => setTimeout(resolve, 5));
    abort.abort();
    await assert.rejects(operation, { code: 'PRIMARY_LINK_ABORTED' });
    const data = JSON.parse(fs.readFileSync(path.join(f.dir, '15550000123.primary-linking.json')));
    assert.equal(data.transaction.phase, 'uncertain');
    assert.equal(f.pairWrites, 1);
});
test('an already aborted approval sends no IQ and consumes no code', async (t) => {
    const f = await fixture(t), abort = new AbortController();
    abort.abort();
    const count = f.requests.length;
    await assert.rejects(f.client.approveCompanionCode(f.code, { invitationId: f.invitation.id, signal: abort.signal }), { code: 'PRIMARY_LINK_ABORTED' });
    assert.equal(f.requests.length, count);
    assert.equal(f.client._primaryLinking.journal.snapshot().usedCodes.length, 0);
});
test('wrong code fails the independent GCM check before authorizing a device', async (t) => {
    const f = await fixture(t);
    await assert.rejects(f.client.approveCompanionCode('11111111', { invitationId: f.invitation.id }), { code: 'PRIMARY_LINK_KEY_EXCHANGE_INVALID' });
    assert.equal(f.pairWrites, 0);
});
test('expired invitations cannot start an approval', async (t) => {
    const f = await fixture(t);
    f.client._primaryLinking.journal.update(s => { s.pending[0].receivedAt = 1; });
    const count = f.requests.length;
    await assert.rejects(f.client.approveCompanionCode(f.code, { invitationId: f.invitation.id }), { code: 'PRIMARY_LINK_INVITATION_EXPIRED' });
    assert.equal(f.requests.length, count);
});
test('foreign senders are rejected without an ACK or primary authorization', async (t) => {
    const f = await fixture(t);
    let rejected;
    f.client.on('primary_link_error', e => { rejected = e; });
    const count = f.requests.length;
    f.client._handleNotification(new BinaryNode('notification', { ...f.hello.attrs, from: '15550000999@s.whatsapp.net' }, f.hello.content));
    assert.ok(rejected);
    assert.equal(f.requests.length, count);
    assert.equal(f.client._connected, true);
});
test('existing authoritative ADV can be seeded once and is never overwritten', async (t) => {
    const f = await fixture(t, { existingDevice: true });
    const state = { rawId: 1234, currentIndex: 1, timestamp: 100, validIndexes: [0, 1] };
    await f.client.seedPrimaryLinkState(state);
    await assert.rejects(f.client.seedPrimaryLinkState({ ...state, rawId: 5678 }), { code: 'PRIMARY_LINK_STATE_EXISTS' });
    assert.equal(f.client._primaryLinking.journal.snapshot().adv.rawId, 1234);
    assert.equal(f.pairWrites, 0);
});
test('malformed ADV protobufs cannot hide duplicate fields, unknown fields or unsafe integers', () => {
    assert.throws(() => C.decode('identity', Buffer.from([8, 1, 8, 2])));
    assert.throws(() => C.decode('identity', Buffer.from([48, 1])));
    assert.throws(() => C.decode('signed', Buffer.from([10, 10, 1])));
    assert.throws(() => C.number(Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER));
    assert.throws(() => C.number(null));
});

for (const settings of [{}, { retryTimestamp: true }, { noDeviceResult: true }]) {
    test('QR approval verifies an independent companion without a hello/code exchange ' + JSON.stringify(settings), async t => {
        const f = await fixture(t, { qr: true, ...settings }), socket = f.client._socket, events = [];
        f.client.on('primary_linked', e => events.push(e));
        const result = await f.client.linkCompanionWithQr('https://wa.me/settings/linked_devices#' + f.qr, {
            expectedNoiseKey: f.noise.public, expectedIdentityKey: f.identity.public, getCompanionProof: async () => f.proof
        });
        assert.equal(result.status, 'linked');
        assert.equal(result.deviceId, 7);
        assert.equal(events.length, 1);
        assert.equal(f.client._socket, socket);
        assert.equal(f.client._mode, 'mobile');
        assert.ok(f.requests.every(n => n.description !== 'iq' || !C.optionalChild(n, 'link_code_companion_reg')));
        assert.equal(f.requests.filter(n => n.description === 'ack').length, 0);
        const file = path.join(f.dir, '15550000123.primary-linking.json'), raw = fs.readFileSync(file, 'utf8'), journal = JSON.parse(raw);
        assert.equal(journal.transaction.method, 'qr');
        assert.equal(journal.transaction.phase, 'committed');
        assert.equal(journal.usedQrs.length, 1);
        assert.equal(fs.statSync(file).mode & 0o777, 0o600);
        assert.ok(!raw.includes(f.qr) && !raw.includes(f.qrSecret.toString('base64')));
        assert.ok(!raw.includes(f.client._store.identityKeyPair.private.toString('base64')));
        assert.equal(f.pairWrites, settings.retryTimestamp ? 2 : 1);
        if (settings.retryTimestamp) {
            assert.equal(f.primaryNotices[0][1], f.primaryNotices[1][1]);
            assert.equal(f.primaryNotices[0][3], f.primaryNotices[1][3]);
            assert.equal(f.primaryNotices[1][2], f.primaryNotices[0][2] + 1);
        }
    });
}

test('QR awaiting confirmation survives a normal owner restart; reconcile never sends pair-device again', async t => {
    const f = await fixture(t, { qr: true });
    assert.equal((await f.client.approveCompanionQr(f.qr)).status, 'awaiting_confirmation');
    const wrong = { ...f.proof, deviceSignature: Buffer.alloc(64) };
    await assert.rejects(f.client.reconcilePrimaryLink(wrong));
    await assert.rejects(f.client.approveCompanionQr(f.qr), { code: 'PRIMARY_LINK_RECONCILIATION_REQUIRED' });
    f.client._closePrimaryLinking();
    const before = f.requests.length;
    assert.equal((await f.client.reconcilePrimaryLink(f.proof)).status, 'linked');
    assert.equal(f.requests.length - before, 1);
    assert.equal(f.pairWrites, 1);
    await assert.rejects(f.client.approveCompanionQr(f.qr), { code: 'PRIMARY_LINK_QR_ALREADY_USED' });
});

for (const [settings, expected] of [
    [{ nullPair: true }, 'PRIMARY_LINK_IQ_UNCONFIRMED'],
    [{ pairError: true }, 'PRIMARY_LINK_IQ_REJECTED'],
    [{ challenge: true }, 'PRIMARY_LINK_VERIFICATION_REQUIRED'],
    [{ retryTimestamp: 'repeat' }, 'PRIMARY_LINK_REPEATED_RETRY']
]) {
    test('QR cannot report linked after an unconfirmed or challenged pair result ' + expected, async t => {
        const f = await fixture(t, { qr: true, ...settings }), linked = [];
        f.client.on('primary_linked', e => linked.push(e));
        await assert.rejects(f.client.approveCompanionQr(f.qr), { code: expected });
        assert.deepEqual(linked, []);
        const tx = f.client._primaryLinking.journal.snapshot().transaction;
        assert.equal(tx.phase, settings.challenge ? 'verification_required' : 'uncertain');
        await assert.rejects(f.client.approveCompanionQr(f.qr), { code: 'PRIMARY_LINK_RECONCILIATION_REQUIRED' });
    });
}

test('QR pins, invalid input and an already-aborted operation cannot send or reserve anything', async t => {
    const f = await fixture(t, { qr: true }), before = f.client._primaryLinking.journal.snapshot();
    await assert.rejects(f.client.approveCompanionQr('invalid'), { code: 'PRIMARY_LINK_QR_INVALID' });
    for (const pin of ['expectedNoiseKey', 'expectedIdentityKey']) {
        await assert.rejects(f.client.approveCompanionQr(f.qr, { [pin]: Buffer.alloc(32) }), { code: 'PRIMARY_LINK_INVITATION_UNMATCHED' });
    }
    const signal = AbortSignal.abort();
    await assert.rejects(f.client.approveCompanionQr(f.qr, { signal }), { code: 'PRIMARY_LINK_ABORTED' });
    assert.deepEqual(f.client._primaryLinking.journal.snapshot(), before);
    assert.equal(f.requests.length, 0);
});

test('QR preserves unknown existing ADV and rejects a mismatching fresh server index', async t => {
    const f = await fixture(t, { qr: true, existingDevice: true });
    await assert.rejects(f.client.approveCompanionQr(f.qr), { code: 'PRIMARY_LINK_EXISTING_ADV_REQUIRED' });
    assert.equal(f.pairWrites, 0);
    const g = await fixture(t, { qr: true, wrongIndex: true });
    await g.client.approveCompanionQr(g.qr);
    await assert.rejects(g.client.reconcilePrimaryLink(g.proof), { code: 'PRIMARY_LINK_DEVICE_LIST_UNCONFIRMED' });
    assert.equal(g.client._primaryLinking.journal.snapshot().adv, null);
});

test('QR pair abort keeps its reservation and shares the busy guard with phone-code approval', async t => {
    const f = await fixture(t, { qr: true, hangPair: true }), abort = new AbortController();
    const result = f.client.approveCompanionQr(f.qr, { signal: abort.signal });
    while (!f.pairWrites) await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(f.client.linkCompanionWithCode(f.code, { waitMs: 0 }), { code: 'PRIMARY_LINK_RECONCILIATION_REQUIRED' });
    abort.abort();
    await assert.rejects(result, { code: 'PRIMARY_LINK_ABORTED' });
    assert.equal(f.client._primaryLinking.journal.snapshot().transaction.phase, 'uncertain');
    assert.equal(f.pairWrites, 1);
});

test('QR reads and extends private.10 journals without replacing old state', async t => {
    const f = await fixture(t, { qr: true }), file = path.join(f.dir, '15550000123.primary-linking.json');
    f.client._closePrimaryLinking();
    const old = JSON.parse(fs.readFileSync(file));
    delete old.usedQrs;
    old.usedCodes = ['a'.repeat(64)];
    fs.writeFileSync(file, JSON.stringify(old), { mode: 0o600 });
    await f.client.approveCompanionQr(f.qr);
    assert.deepEqual(f.client._primaryLinking.journal.snapshot().usedCodes, old.usedCodes);
    assert.equal(f.client._primaryLinking.journal.snapshot().usedQrs.length, 1);
});

test('simple code API uses the only unexpired invitation and preserves the strict result', async t => {
    const f = await fixture(t);
    assert.equal((await f.client.linkCompanionWithCode(f.code, { waitMs: 0, getCompanionProof: async () => f.proof })).status, 'linked');
    assert.equal(f.pairWrites, 1);
});

test('simple code API waits for hello and rejects another approval while waiting', async t => {
    const f = await fixture(t, { deferHello: true });
    const result = f.client.linkCompanionWithCode(f.code, { getCompanionProof: async () => f.proof });
    assert.equal(f.requests.length, 0);
    await assert.rejects(f.client.approveCompanionQr(f.qr), { code: 'PRIMARY_LINK_BUSY' });
    f.client._handleNotification(f.hello);
    assert.equal((await result).status, 'linked');
    assert.equal(f.client.listenerCount('primary_link_invitation'), 0);
});

test('simple code API refuses ambiguous invitations; explicit selection still works', async t => {
    const f = await fixture(t);
    const other = new BinaryNode('notification', { ...f.hello.attrs, id: 'other-hello' }, [
        new BinaryNode('link_code_companion_reg', { stage: 'companion_hello' }, f.hello.content[0].content.map(n =>
            new BinaryNode(n.description, n.attrs, n.description === 'link_code_pairing_ref' ? Buffer.from('another-ref') : n.content)))
    ]);
    f.client._handleNotification(other);
    const before = f.requests.length;
    await assert.rejects(f.client.linkCompanionWithCode(f.code, { waitMs: 0 }), { code: 'PRIMARY_LINK_INVITATION_AMBIGUOUS' });
    assert.equal(f.requests.length, before);
    assert.equal((await f.client.linkCompanionWithCode(f.code, { invitationId: f.invitation.id, waitMs: 0 })).status, 'awaiting_confirmation');
});

test('waiting for an invitation cleans up on timeout, abort and primary close without consuming a code', async t => {
    for (const stop of ['timeout', 'abort', 'close']) {
        const f = await fixture(t, { deferHello: true }), abort = new AbortController();
        const result = f.client.linkCompanionWithCode(f.code, { signal: abort.signal, waitMs: stop === 'timeout' ? 5 : 1000 });
        if (stop === 'abort') abort.abort();
        if (stop === 'close') f.client._closePrimaryLinking();
        await assert.rejects(result, { code: stop === 'timeout' ? 'PRIMARY_LINK_INVITATION_TIMEOUT' : stop === 'abort' ? 'PRIMARY_LINK_ABORTED' : 'PRIMARY_LINK_CONNECTION_CLOSED' });
        assert.equal(f.client.listenerCount('primary_link_invitation'), 0);
        assert.equal(f.requests.length, 0);
        const journal = JSON.parse(fs.readFileSync(path.join(f.dir, '15550000123.primary-linking.json')));
        assert.equal(journal.transaction, null);
        assert.deepEqual(journal.usedCodes, []);
    }
});

test('simple code API rejects invalid wait values and ignores expired invitations', async t => {
    const f = await fixture(t);
    for (const waitMs of [-1, 90001, NaN, '100']) {
        await assert.rejects(f.client.linkCompanionWithCode(f.code, { waitMs }), { code: 'PRIMARY_LINK_WAIT_INVALID' });
    }
    f.client._primaryLinking.journal.update(s => { s.pending[0].receivedAt = 1; });
    await assert.rejects(f.client.linkCompanionWithCode(f.code, { waitMs: 0 }), { code: 'PRIMARY_LINK_INVITATION_REQUIRED' });
    assert.equal(f.pairWrites, 0);
    assert.equal(f.client._primaryLinking.journal.snapshot().usedCodes.length, 0);
});

test('the whole-operation deadline also bounds a longer invitation wait', async t => {
    const f = await fixture(t, { deferHello: true });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const result = f.client.linkCompanionWithCode(f.code, { waitMs: 90000, timeoutMs: 1000 });
    t.mock.timers.tick(1000);
    await assert.rejects(result, { code: 'PRIMARY_LINK_TIMEOUT' });
    assert.equal(f.client.listenerCount('primary_link_invitation'), 0);
    assert.equal(f.requests.length, 0);
    assert.equal(f.client._primaryLinking.journal.snapshot().transaction, null);
});

test('QR retains the existing explicit empty-history bootstrap and its independent final confirmation', async t => {
    const f = await bootstrapFixture(t, { qr: true });
    const initial = await f.client.bootstrapEmptyPrimaryCompanion({
        getInitialHistory: async () => ({ source: 'owned_primary_store', messageCount: 0, conversationCount: 0 })
    });
    assert.equal(initial.status, 'sent');
    assert.equal(initial.browserReady, false);
    assert.equal(f.requests.filter(n => n.description === 'message').length, 2);
    assert.equal(f.client._primaryLinking.journal.snapshot().transaction.phase, 'awaiting_confirmation');
    assert.equal((await f.client.reconcilePrimaryLink(f.proof)).status, 'linked');
    assert.equal(f.pairWrites, 1);
});
