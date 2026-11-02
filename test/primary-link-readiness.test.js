'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// Before a link is approved, find out whether the primary can finish it.
// Approving one it cannot finish is the failure this exists to prevent: Web
// hangs on "Loading chats" and then logs out.
//
// Two halves. evaluateReadiness is pure: facts in, verdict out, one test per
// blocker. client.getPrimaryLinkReadiness gathers those facts from a client and
// must never approve, send a message, write a patch or write the link journal;
// that half runs against a synthetic server and reads back what went out.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
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
const { PrimaryMessageStore } = require('../lib/primary/MessageStore');
const R = require('../lib/primary/Readiness');
const wa = require('../index');

const PHONE = '15550000123';
const NOW = 1790000000000;
const MIN = 60000;

// ─── the pure half ──────────────────────────────────────────────────────────

const ALONE = [{ id: 0, hasKeyIndex: false, keyIndex: 0 }];
const snap = over => ({ seq: 4, capture: { since: NOW - 86400000, origin: 'registration', lc: 1 }, chats: [], records: {}, losses: [],
    retained: { evicted: 0 }, pushNames: [], counts: { chats: 3, records: 42 }, ...over });
const T = 1790000000;   // message timestamps are seconds
const rec = (id, ts, extra) => ({ id, seq: 1, fromMe: false, ts, status: 3, raw: Buffer.from('the text of ' + id), ...extra });
// A primary that can link: alone on the account, nothing foreign on the server
// or on disk, a name, and a store that has kept everything since registration.
const good = over => ({ registered: true, phoneOk: true, transaction: null, devices: ALONE,
    localKeys: { count: 0, foreign: false }, local: { appStateConflict: false, historyFiles: false },
    server: { version: 0, verified: true, foreign: false },
    pushNameValid: true, storeEnabled: true, snapshot: snap(), now: NOW, ...over });
const codes = verdict => verdict.blockers.map(b => b.code);
const only = (verdict, code) => { assert.deepEqual(codes(verdict), [code]); return verdict.blockers[0]; };
const held = (phase, ageMs) => ({ phase, startedAt: NOW - ageMs });

test('a primary alone on its account with nothing foreign is ready, in first mode', () => {
    const verdict = R.evaluateReadiness(good());
    assert.equal(verdict.ready, true);
    assert.equal(verdict.mode, 'first');
    assert.deepEqual(verdict.blockers, []);
    assert.equal(verdict.needsConfirmation, false);
});

test('the verdict has exactly the documented shape', () => {
    assert.deepEqual(Object.keys(R.evaluateReadiness(good())).sort(), ['blockers', 'history', 'mode', 'needsConfirmation', 'ready']);
    assert.deepEqual(Object.keys(R.evaluateReadiness(good({ registered: false }))).sort(), ['blockers', 'history', 'mode', 'needsConfirmation', 'ready']);
});

test('PRIMARY_LINK_ACCOUNT_REQUIRED: an account that is not registered', () => {
    const verdict = R.evaluateReadiness(good({ registered: false }));
    only(verdict, 'PRIMARY_LINK_ACCOUNT_REQUIRED');
    assert.equal(verdict.ready, false);
    assert.equal(verdict.mode, null);
    assert.equal(verdict.history, null);
    assert.equal(verdict.needsConfirmation, false);
});

test('PRIMARY_LINK_ACCOUNT_REQUIRED: a phone number that is not 8 to 15 digits', () => {
    only(R.evaluateReadiness(good({ phoneOk: false })), 'PRIMARY_LINK_ACCOUNT_REQUIRED');
});

test('with no usable account nothing else can be known, so nothing else is claimed', () => {
    const verdict = R.evaluateReadiness({ registered: false, phoneOk: false, now: NOW });
    only(verdict, 'PRIMARY_LINK_ACCOUNT_REQUIRED');
    assert.deepEqual(R.evaluateReadiness(undefined).blockers.map(b => b.code), ['PRIMARY_LINK_ACCOUNT_REQUIRED']);
    assert.deepEqual(R.evaluateReadiness({}).blockers.map(b => b.code), ['PRIMARY_LINK_ACCOUNT_REQUIRED']);
});

test('PRIMARY_LINK_RECONCILIATION_REQUIRED: every phase approve refuses on', () => {
    for (const phase of ['verification_required', 'finish_verified', 'pair_device_sending', 'awaiting_confirmation', 'uncertain']) {
        const blocker = only(R.evaluateReadiness(good({ transaction: held(phase, MIN) })), 'PRIMARY_LINK_RECONCILIATION_REQUIRED');
        assert.equal(blocker.detail.phase, phase);
        assert.equal(blocker.detail.startedAt, NOW - MIN);
        assert.equal(blocker.detail.ageMs, MIN);
    }
});

test('a transaction that holds nothing is not a blocker', () => {
    for (const phase of ['exchange', 'exchange_failed', 'committed', 'abandoned']) {
        assert.deepEqual(codes(R.evaluateReadiness(good({ transaction: held(phase, 10 * MIN) }))), [], phase);
    }
});

test('retirable hint after five minutes', () => {
    for (const phase of ['awaiting_confirmation', 'uncertain', 'pair_device_sending']) {
        const at = ageMs => only(R.evaluateReadiness(good({ transaction: held(phase, ageMs) })), 'PRIMARY_LINK_RECONCILIATION_REQUIRED').detail.retirable;
        assert.equal(at(0), false, phase);
        assert.equal(at(5 * MIN - 1), false, phase);
        assert.equal(at(5 * MIN), true, phase);
        assert.equal(at(60 * MIN), true, phase);
    }
});

test('a hold that retireAbsent cannot retire is never hinted as retirable', () => {
    for (const phase of ['verification_required', 'finish_verified']) {
        assert.equal(only(R.evaluateReadiness(good({ transaction: held(phase, 60 * MIN) })), 'PRIMARY_LINK_RECONCILIATION_REQUIRED').detail.retirable, false, phase);
    }
    // No start time, or one in the future, is not an age of five minutes.
    for (const startedAt of [undefined, null, 'soon', NOW + 10 * MIN, NOW + 0.5]) {
        const blocker = only(R.evaluateReadiness(good({ transaction: { phase: 'awaiting_confirmation', startedAt } })), 'PRIMARY_LINK_RECONCILIATION_REQUIRED');
        assert.equal(blocker.detail.retirable, false, String(startedAt));
    }
});

test('PRIMARY_BOOTSTRAP_EXISTING_COMPANIONS_UNSUPPORTED: another device is linked', () => {
    const verdict = R.evaluateReadiness(good({ devices: [...ALONE, { id: 7, hasKeyIndex: true, keyIndex: 2 }] }));
    assert.equal(only(verdict, 'PRIMARY_BOOTSTRAP_EXISTING_COMPANIONS_UNSUPPORTED').detail.companions, 1);
    const several = R.evaluateReadiness(good({ devices: [...ALONE, { id: 7, hasKeyIndex: true, keyIndex: 2 }, { id: 9, hasKeyIndex: true, keyIndex: 3 }] }));
    assert.equal(only(several, 'PRIMARY_BOOTSTRAP_EXISTING_COMPANIONS_UNSUPPORTED').detail.companions, 2);
});

test('a device list that is not exactly the primary alone is refused, not assumed', () => {
    for (const devices of [undefined, null, [], [{ id: 7, hasKeyIndex: true, keyIndex: 2 }]]) {
        only(R.evaluateReadiness(good({ devices })), 'PRIMARY_BOOTSTRAP_EXISTING_COMPANIONS_UNSUPPORTED');
    }
});

test('PRIMARY_BOOTSTRAP_FOREIGN_STATE: the server holds critical_block that is not ours', () => {
    const blocker = only(R.evaluateReadiness(good({ server: { version: 4, verified: false, foreign: true } })), 'PRIMARY_BOOTSTRAP_FOREIGN_STATE');
    assert.deepEqual(blocker.detail.reasons, ['server_foreign']);
    assert.equal(blocker.detail.serverVersion, 4);
    assert.equal(R.evaluateReadiness(good({ server: { version: 4, verified: false, foreign: true } })).mode, null);
});

test('PRIMARY_BOOTSTRAP_FOREIGN_STATE: ours, but not the state we hold', () => {
    // Decodes with our keys, at a version or with contents that are not our local state.
    const blocker = only(R.evaluateReadiness(good({ server: { version: 2, verified: false, foreign: false } })), 'PRIMARY_BOOTSTRAP_FOREIGN_STATE');
    assert.deepEqual(blocker.detail.reasons, ['server_unverified']);
});

test('PRIMARY_BOOTSTRAP_FOREIGN_STATE: app-state keys on disk that this primary did not make', () => {
    const verdict = R.evaluateReadiness(good({ localKeys: { count: 2, foreign: true } }));
    assert.deepEqual(only(verdict, 'PRIMARY_BOOTSTRAP_FOREIGN_STATE').detail.reasons, ['local_keys']);
    assert.equal(verdict.mode, null);
});

test('PRIMARY_BOOTSTRAP_FOREIGN_STATE: local app state or history the bootstrap refuses to write over', () => {
    assert.deepEqual(only(R.evaluateReadiness(good({ local: { appStateConflict: true, historyFiles: false } })), 'PRIMARY_BOOTSTRAP_FOREIGN_STATE').detail.reasons, ['local_state']);
    assert.deepEqual(only(R.evaluateReadiness(good({ local: { appStateConflict: false, historyFiles: true } })), 'PRIMARY_BOOTSTRAP_FOREIGN_STATE').detail.reasons, ['local_history']);
    const both = R.evaluateReadiness(good({ local: { appStateConflict: true, historyFiles: true }, localKeys: { count: 1, foreign: true } }));
    assert.deepEqual(only(both, 'PRIMARY_BOOTSTRAP_FOREIGN_STATE').detail.reasons, ['local_keys', 'local_state', 'local_history']);
});

test('PRIMARY_BOOTSTRAP_FOREIGN_STATE: local state that was not checked is not local state that is fine', () => {
    // The bootstrap would refuse a first link over existing app state or history
    // (EXISTING_STATE, EXISTING_HISTORY); with no fact either way, neither is ruled out.
    for (const local of [undefined, null, {}, { appStateConflict: false }, { historyFiles: false }, { appStateConflict: 'no', historyFiles: false }, { appStateConflict: 0, historyFiles: 0 }, 'clean']) {
        const verdict = R.evaluateReadiness(good({ local }));
        assert.deepEqual(only(verdict, 'PRIMARY_BOOTSTRAP_FOREIGN_STATE').detail.reasons, ['local_unknown'], JSON.stringify(local));
        assert.equal(verdict.ready, false);
        assert.equal(verdict.mode, null);
    }
    // A fact that says a conflict is exact about which one, even beside one that is missing.
    assert.deepEqual(only(R.evaluateReadiness(good({ local: { appStateConflict: true } })), 'PRIMARY_BOOTSTRAP_FOREIGN_STATE').detail.reasons, ['local_state', 'local_unknown']);
    assert.equal(R.evaluateReadiness(good({ local: { appStateConflict: false, historyFiles: false } })).ready, true);
});

test('PRIMARY_BOOTSTRAP_FOREIGN_STATE: a server that was not checked is not a server that is fine', () => {
    for (const server of [undefined, null, {}, { version: 0, foreign: false }]) {
        const blocker = only(R.evaluateReadiness(good({ server })), 'PRIMARY_BOOTSTRAP_FOREIGN_STATE');
        assert.ok(blocker.detail.reasons.length > 0);
    }
    only(R.evaluateReadiness(good({ localKeys: undefined })), 'PRIMARY_BOOTSTRAP_FOREIGN_STATE');
});

test('PRIMARY_BOOTSTRAP_NAME_REQUIRED', () => {
    const verdict = R.evaluateReadiness(good({ pushNameValid: false }));
    only(verdict, 'PRIMARY_BOOTSTRAP_NAME_REQUIRED');
    assert.equal(verdict.mode, 'first', 'the account state itself is fine');
});

test('PRIMARY_MESSAGE_STORE_DISABLED: no store', () => {
    const verdict = R.evaluateReadiness(good({ storeEnabled: false, snapshot: null }));
    assert.equal(only(verdict, 'PRIMARY_MESSAGE_STORE_DISABLED').detail.reason, 'disabled');
    assert.equal(verdict.history, null);
    assert.equal(verdict.needsConfirmation, false, 'there is no history to confirm');
});

test('PRIMARY_MESSAGE_STORE_DISABLED: a store that cannot be read is no store', () => {
    const blocker = only(R.evaluateReadiness(good({ storeEnabled: true, snapshot: null, storeError: 'PRIMARY_MESSAGE_STORE_CLOSED' })), 'PRIMARY_MESSAGE_STORE_DISABLED');
    assert.deepEqual(blocker.detail, { reason: 'unreadable', code: 'PRIMARY_MESSAGE_STORE_CLOSED' });
    assert.equal(only(R.evaluateReadiness(good({ storeEnabled: true, snapshot: null })), 'PRIMARY_MESSAGE_STORE_DISABLED').detail.reason, 'unreadable');
});

test('every blocker is reported, in a fixed order', () => {
    const verdict = R.evaluateReadiness(good({
        transaction: held('uncertain', 10 * MIN), devices: [...ALONE, { id: 7, hasKeyIndex: true, keyIndex: 1 }],
        server: { version: 1, verified: false, foreign: true }, pushNameValid: false, storeEnabled: false, snapshot: null
    }));
    assert.deepEqual(codes(verdict), ['PRIMARY_LINK_RECONCILIATION_REQUIRED', 'PRIMARY_BOOTSTRAP_EXISTING_COMPANIONS_UNSUPPORTED',
        'PRIMARY_BOOTSTRAP_FOREIGN_STATE', 'PRIMARY_BOOTSTRAP_NAME_REQUIRED', 'PRIMARY_MESSAGE_STORE_DISABLED']);
    assert.equal(verdict.ready, false);
    assert.equal(verdict.mode, null);
});

test('relink mode detected when our verified state exists', () => {
    const verdict = R.evaluateReadiness(good({ localKeys: { count: 1, foreign: false }, server: { version: 3, verified: true, foreign: false } }));
    assert.equal(verdict.ready, true);
    assert.equal(verdict.mode, 'relink');
    assert.deepEqual(verdict.blockers, []);
});

test('an empty server that matches an empty local state is first, even with a key left from an attempt that never landed', () => {
    const verdict = R.evaluateReadiness(good({ localKeys: { count: 1, foreign: false }, server: { version: 0, verified: true, foreign: false } }));
    assert.equal(verdict.mode, 'first');
    assert.equal(verdict.ready, true);
});

test('clean registration-origin store does not ask', () => {
    const verdict = R.evaluateReadiness(good());
    assert.equal(verdict.needsConfirmation, false);
});

test('enabled-origin store asks', () => {
    const verdict = R.evaluateReadiness(good({ snapshot: snap({ capture: { since: NOW - 1000, origin: 'enabled', lc: 1 } }) }));
    assert.equal(verdict.needsConfirmation, true);
    assert.equal(verdict.ready, true, 'asking is not refusing');
});

test('only a store that has kept everything since registration is taken as complete', () => {
    // Anything but 'registration' (an origin this code has never heard of, an
    // origin that is not a string, no capture at all) is a store whose start is
    // not known, and a store whose start is not known may be missing its past.
    for (const capture of [{ since: NOW, origin: 'enabled', lc: 1 }, { since: NOW, origin: 'imported', lc: 1 }, { since: NOW, origin: 'Registration', lc: 1 },
        { since: NOW, origin: '', lc: 1 }, { since: NOW, origin: null, lc: 1 }, { since: NOW, lc: 1 }, {}, null, undefined, 'registration']) {
        const verdict = R.evaluateReadiness(good({ snapshot: snap({ capture }) }));
        assert.equal(verdict.needsConfirmation, true, JSON.stringify(capture));
        assert.equal(verdict.ready, true, 'asking is not refusing: ' + JSON.stringify(capture));
    }
    assert.equal(R.evaluateReadiness(good({ snapshot: snap({ capture: { since: NOW, origin: 'registration', lc: 1 } }) })).needsConfirmation, false);
});

test('a precise loss asks', () => {
    const byIds = R.evaluateReadiness(good({ snapshot: snap({ losses: [{ reason: 'undecryptable', ids: ['A1', 'A2', 'A3'] }] }) }));
    assert.equal(byIds.needsConfirmation, true);
    const byWindow = R.evaluateReadiness(good({ snapshot: snap({ losses: [{ reason: 'store-disabled', from: NOW - 5000, to: NOW }] }) }));
    assert.equal(byWindow.needsConfirmation, true);
    assert.equal(byWindow.ready, true);
});

test('messages the store let go of ask', () => {
    assert.equal(R.evaluateReadiness(good({ snapshot: snap({ retained: { evicted: 1 } }) })).needsConfirmation, true);
    assert.equal(R.evaluateReadiness(good({ snapshot: snap({ retained: { evicted: 0 } }) })).needsConfirmation, false);
});

test('a snapshot that does not say what it lost or let go of is not taken as complete', () => {
    for (const over of [{ losses: undefined }, { losses: null }, { losses: {} }, { retained: undefined }, { retained: null }, { retained: {} }, { retained: { evicted: 'none' } }, { retained: { evicted: NaN } }]) {
        assert.equal(R.evaluateReadiness(good({ snapshot: snap(over) })).needsConfirmation, true, JSON.stringify(over));
    }
});

test('the history it reports is what would be sent, and the range and losses that qualify it', () => {
    const since = NOW - 3600000;
    const losses = [{ reason: 'undecryptable', ids: ['L1', 'L2'] }, { reason: 'store-disabled', from: NOW - 9000, to: NOW - 4000 }];
    const verdict = R.evaluateReadiness(good({ snapshot: snap({
        capture: { since, origin: 'enabled', lc: 2 }, counts: { chats: 2, records: 4 }, retained: { evicted: 5 }, losses,
        // Tombstones are stored records and count towards the range, whatever order the chats come in.
        records: { 'a@s.whatsapp.net': [rec('A1', T + 500), rec('A2', T + 900, { raw: undefined, tombstone: 'revoked' })], 'b@g.us': [rec('G1', T + 100), rec('G2', T + 700)] }
    }) }));
    assert.deepEqual(verdict.history, {
        enabled: true,
        capture: { since, origin: 'enabled', lc: 2 },
        chats: 2, records: 4,
        retained: { evicted: 5, from: T + 100, to: T + 900 },
        losses: [{ reason: 'undecryptable', ids: ['L1', 'L2'] }, { reason: 'store-disabled', from: NOW - 9000, to: NOW - 4000 }]
    });
    assert.deepEqual(R.evaluateReadiness(good()).history.losses, []);
});

test('the retained range is null when nothing is stored, and ignores what is not a timestamp', () => {
    const none = (snapshot) => R.evaluateReadiness(good({ snapshot })).history.retained;
    assert.deepEqual(none(snap({ records: {} })), { evicted: 0, from: null, to: null });
    assert.deepEqual(none(snap({ records: { 'a@s.whatsapp.net': [] } })), { evicted: 0, from: null, to: null });
    assert.deepEqual(none(snap({ records: { 'a@s.whatsapp.net': [rec('A1', undefined), rec('A2', 'soon'), rec('A3', NaN), rec('A4', null)] } })), { evicted: 0, from: null, to: null });
    assert.deepEqual(none(snap({ records: { 'a@s.whatsapp.net': [rec('A1', T), rec('A2', 'soon')] } })), { evicted: 0, from: T, to: T });
    // A snapshot without its records (the gatherer sends one) carries the range it worked out.
    assert.deepEqual(none({ ...snap({ retained: { evicted: 2, from: T + 5, to: T + 9 } }), records: undefined }), { evicted: 2, from: T + 5, to: T + 9 });
    assert.deepEqual(none({ ...snap({ retained: { evicted: 2, from: 'x', to: null } }), records: undefined }), { evicted: 2, from: null, to: null });
});

test('the range is found without a stack limit on how many records there are', () => {
    const many = Array.from({ length: 200000 }, (_, i) => rec('M' + i, T + (i % 1000), { raw: undefined }));
    assert.deepEqual(R.evaluateReadiness(good({ snapshot: snap({ records: { 'a@s.whatsapp.net': many } }) })).history.retained, { evicted: 0, from: T, to: T + 999 });
});

test('a verdict holds no message content, id or name: only counts, a range, and the losses as the store reports them', () => {
    const snapshot = snap({
        chats: [{ id: 'a@s.whatsapp.net', name: 'Ana Secret' }], pushNames: [{ id: 'a@s.whatsapp.net', pushname: 'Ana Secret' }],
        records: { 'a@s.whatsapp.net': [rec('RECORD-ID-1', T + 1, { participant: 'p@s.whatsapp.net', pushName: 'Ana Secret' })] },
        // A loss entry with something it should not have: it is not copied.
        losses: [{ reason: 'undecryptable', ids: ['LOSS-ID-1'], text: 'leaked text' }]
    });
    const text = JSON.stringify(R.evaluateReadiness(good({ snapshot })));
    for (const forbidden of ['the text of RECORD-ID-1', 'RECORD-ID-1', 'Ana Secret', 'p@s.whatsapp.net', 'leaked text', 'a@s.whatsapp.net', Buffer.from('the text of RECORD-ID-1').toString('base64')])
        assert.ok(!text.includes(forbidden), forbidden);
    assert.ok(text.includes('LOSS-ID-1'), 'the loss list is the store\'s own');
});

test('the losses in a verdict are copies, not the store\'s own arrays', () => {
    const snapshot = snap({ losses: [{ reason: 'undecryptable', ids: ['L1'] }] });
    const verdict = R.evaluateReadiness(good({ snapshot }));
    verdict.history.losses[0].ids.push('L2');
    verdict.history.losses.push({ reason: 'x' });
    assert.deepEqual(snapshot.losses, [{ reason: 'undecryptable', ids: ['L1'] }]);
});

test('evaluating is repeatable and leaves the facts alone', () => {
    const facts = good({ transaction: held('uncertain', 6 * MIN), devices: [...ALONE, { id: 3, hasKeyIndex: true, keyIndex: 1 }], snapshot: snap({ losses: [{ reason: 'x', ids: ['a'] }] }) });
    const frozen = JSON.stringify(facts);
    const deepFreeze = o => { if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
    const first = R.evaluateReadiness(deepFreeze(facts));
    assert.equal(JSON.stringify(facts), frozen);
    assert.deepEqual(R.evaluateReadiness(facts), first);
    assert.deepEqual(codes(first), ['PRIMARY_LINK_RECONCILIATION_REQUIRED', 'PRIMARY_BOOTSTRAP_EXISTING_COMPANIONS_UNSUPPORTED']);
});

test('a snapshot without the fields a real one has does not throw, and is not complete', () => {
    for (const snapshot of [{}, { capture: null, losses: null, retained: null, counts: null, records: null }, { records: 5, counts: 'many', losses: [null, 3, 'x'] }]) {
        const verdict = R.evaluateReadiness(good({ snapshot }));
        assert.equal(verdict.needsConfirmation, true);
        assert.deepEqual(verdict.history.capture, { since: null, origin: null, lc: null });
        assert.equal(verdict.history.records, null);
        assert.equal(verdict.history.chats, null);
        assert.deepEqual(verdict.history.retained, { evicted: null, from: null, to: null });
    }
});

// ─── the push name rule ─────────────────────────────────────────────────────

test('push-name validity is the bootstrap rule: non-empty, not "User", at most 25 characters', () => {
    assert.equal(R.validPushName('Local Primary'), true);
    assert.equal(R.validPushName('x'.repeat(25)), true);
    assert.equal(R.validPushName('x'.repeat(26)), false);
    for (const name of ['', '   ', 'User', undefined, null, 5, {}]) assert.equal(R.validPushName(name), false, String(name));
});


// ─── the gatherer ───────────────────────────────────────────────────────────

// A registered primary on a synthetic server. It answers a device list and a
// critical_block read, keeps everything it was sent, and plays the companion
// that links when asked to (after primary-linking.test.js, copied here).
async function fixture(t, { companions = [], name = 'Local Primary' } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'primary-readiness-test-'));
    fs.chmodSync(dir, 0o700);
    const client = new WhalibmobClient({ sessionDir: dir, refreshVersion: false });
    client._store = createNewStore(PHONE);
    client._store.registered = true;
    client._store.name = name;
    client._myLid = '1234567890@lid';
    client._connected = true;
    client._scheduleReconnect = () => { };
    client._appState = new AppStateStore(path.join(dir, PHONE + '.appState.json'));
    const identity = P.generateEphemeralKeyPair(), noise = P.generateEphemeralKeyPair(), ephemeral = P.generateEphemeralKeyPair();
    const code = 'K7M2QX4B', ref = Buffer.from('synthetic-independent-companion-ref');
    // server.patches are critical_block as the server holds it, version first.
    const server = { version: 0, patches: [], companions: [...companions] };
    const requests = [];
    let companionSecret = null;
    const reply = (query, content = []) => client._handleIq(new BinaryNode('iq', { id: query.attrs.id, type: 'result', from: 's.whatsapp.net' }, content));
    client._socket = { close: () => client._onClose(), sendNode(node) {
        requests.push(node);
        if (node.description === 'message') {
            queueMicrotask(() => client._handleAck(new BinaryNode('ack', { id: node.attrs.id, class: 'message', from: PHONE + '@s.whatsapp.net' }, null)));
            return;
        }
        if (node.description !== 'iq') return;
        queueMicrotask(async () => {
            try {
                if (node.attrs.xmlns === 'passive') { reply(node); return; }
                if (node.attrs.xmlns === 'usync') {
                    const devices = [new BinaryNode('device', { id: '0' }, null), ...server.companions.map(c => new BinaryNode('device', { id: String(c.id), 'key-index': String(c.keyIndex) }, null))];
                    reply(node, [new BinaryNode('usync', { sid: C.child(node, 'usync').attrs.sid }, [new BinaryNode('list', {}, [
                        new BinaryNode('user', { jid: PHONE + '@s.whatsapp.net' }, [new BinaryNode('devices', {}, [new BinaryNode('device-list', {}, devices)])])
                    ])])]);
                    return;
                }
                if (node.attrs.xmlns === 'w:sync:app:state') {
                    const patch = C.optionalChild(C.child(C.child(node, 'sync'), 'collection'), 'patch');
                    if (patch) {
                        // The server assigns the version a patch is kept at.
                        server.version += 1;
                        server.patches.push(Buffer.concat([Buffer.from([0x0a, 0x02, 0x08, server.version]), patch.content]));
                    }
                    const held = server.patches.length ? [new BinaryNode('patches', {}, server.patches.map(p => new BinaryNode('patch', {}, p)))] : null;
                    reply(node, [new BinaryNode('sync', {}, [new BinaryNode('collection', { name: 'critical_block', version: String(server.version) }, patch ? null : held)])]);
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
                // The unmodified companion's pair-success implementation.
                const pair = C.child(node, 'pair-device');
                const keyIndex = client._primaryLinking.journal.snapshot().transaction.state.currentIndex;
                configureSuccessfulPairing(new BinaryNode('iq', { id: 'independent-companion-pair-success' }, [
                    new BinaryNode('pair-success', {}, [
                        new BinaryNode('device-identity', {}, C.child(pair, 'device-identity').content),
                        new BinaryNode('device', { jid: PHONE + ':7@s.whatsapp.net', lid: '1234567890:7@lid' }, null)
                    ])
                ]), { advSecretKey: companionSecret, identityKeyPair: identity }, BinaryNode);
                server.companions.push({ id: 7, keyIndex });
                reply(node, [new BinaryNode('device', { jid: '1234567890:7@lid' }, null)]);
            } catch (error) {
                client._pendingIqs.get(node.attrs.id)?.(null);
                t.diagnostic('synthetic peer failure: ' + (error.code || error.name));
            }
        });
    } };
    t.after(() => { client.disconnect(); fs.rmSync(dir, { recursive: true, force: true }); });
    return { client, dir, server, requests, code, identity, noise, ephemeral, ref,
        linking: () => client._primaryLinkingForSession(),
        journalFile: path.join(dir, PHONE + '.primary-linking.json'),
        keyFile: path.join(dir, PHONE + '.appStateKeys.json') };
}

// What the companion's alert looks like, and the approval + bootstrap
// plumbing the bootstrap tests use. Only the agreement tests go this far.
async function offerCompanion(f) {
    const wrapped = await P.buildWrappedEphemeralPub(f.code, f.ephemeral.public);
    f.client._handleNotification(new BinaryNode('notification', { id: 'hello-notification', from: 's.whatsapp.net', type: 'link_code_companion_reg' }, [
        new BinaryNode('link_code_companion_reg', { stage: 'companion_hello' }, [
            new BinaryNode('link_code_pairing_ref', {}, f.ref), new BinaryNode('companion_server_auth_key_pub', {}, f.noise.public), new BinaryNode('link_code_pairing_wrapped_companion_ephemeral_pub', {}, wrapped)
        ])
    ]));
    f.client._devMgr = { async fetchBundles(jids) { return new Map([[jids[0], { identityKey: f.identity.public }]]); } };
    f.client._signal = { async hasSession() { return false; }, async buildSessionFromBundle() { }, async encrypt(jid, plaintext) { return { type: 'pkmsg', ciphertext: Buffer.from(plaintext) }; } };
    return f.client.getPrimaryLinkInvitations()[0];
}

// What an account that linked Web before holds: our own key, critical_block at
// version 1 written with it, and the ADV state that link was made under.
function previousLink(f, { rawId = 4321, source = 'primary_bootstrap' } = {}) {
    const keyId = Buffer.from('a1b2c3d4e5f6', 'hex'), keyData = crypto.randomBytes(32);
    f.linking().journal.update(s => { s.adv = { rawId, currentIndex: 5, timestamp: 1790000000, validIndexes: [0, 5] }; });
    fs.writeFileSync(f.keyFile, JSON.stringify({ a1b2c3d4e5f6: { keyData: keyData.toString('base64'), timestamp: NOW,
        fingerprint: { rawId, currentIndex: 5, deviceIndexes: [0, 5] }, source } }), { mode: 0o600 });
    fs.chmodSync(f.keyFile, 0o600);
    const built = Sync.buildPatch(pushNamePatch('Local Primary'), keyId, keyData, f.client._appState.get('critical_block'));
    f.client._appState.set('critical_block', built.state);
    f.server.version = 1;
    f.server.patches = [built.patch];
    return { keyId, keyData, built };
}
const foreignPatch = (name = 'Someone Else') => Sync.buildPatch(pushNamePatch(name), Buffer.from('0f0e0d0c0b0a', 'hex'), crypto.randomBytes(32), newState()).patch;
function hold(f, phase, ageMs) {
    f.linking().journal.update(s => {
        s.transaction = { id: crypto.randomUUID(), method: 'code', phase, startedAt: Date.now() - ageMs,
            state: { rawId: 4321, currentIndex: 1, timestamp: 1790000000, validIndexes: [0, 1] }, before: ALONE };
    });
}
const kept = () => snap({ capture: { since: Date.now() - 1000, origin: 'registration', lc: 1 } });
const withStore = f => { f.client._messageStore = { snapshot: kept }; return f; };
const iqs = f => f.requests.filter(n => n.description === 'iq');
const writesPatch = n => n.attrs.xmlns === 'w:sync:app:state' && !!C.optionalChild(C.optionalChild(C.optionalChild(n, 'sync'), 'collection'), 'patch');
// Watches every write the link journal is asked for.
function watchJournal(f) {
    const journal = f.linking().journal, update = journal.update.bind(journal), writes = [];
    journal.update = change => { writes.push(change); return update(change); };
    return writes;
}

test('getPrimaryLinkReadiness reads a first-link verdict and sends no approval and writes no journal', async t => {
    const f = withStore(await fixture(t));
    const store = kept();
    f.client._messageStore = { snapshot: () => store };
    // Open the journal first: opening it stamps its lease, which is not what is asserted here.
    const writes = watchJournal(f), before = fs.readFileSync(f.journalFile);

    const verdict = await f.client.getPrimaryLinkReadiness();

    assert.equal(verdict.ready, true);
    assert.equal(verdict.mode, 'first');
    assert.deepEqual(verdict.blockers, []);
    assert.equal(verdict.needsConfirmation, false);
    assert.deepEqual(verdict.history, { enabled: true, capture: store.capture, chats: 3, records: 42, retained: { evicted: 0, from: null, to: null }, losses: [] });

    // It looked: the device list and critical_block. It touched nothing else.
    assert.equal(writes.length, 0, 'the link journal is never written');
    assert.deepEqual(fs.readFileSync(f.journalFile), before);
    assert.equal(fs.existsSync(f.keyFile), false, 'no key is made');
    assert.equal(f.requests.every(n => n.description === 'iq'), true, 'no message, ack or receipt goes out');
    assert.deepEqual(iqs(f).map(n => n.attrs.xmlns), ['usync', 'w:sync:app:state']);
    assert.equal(iqs(f).some(writesPatch), false, 'no critical_block patch is written');
    assert.equal(iqs(f).some(n => n.attrs.xmlns === 'passive' || C.optionalChild(n, 'link_code_companion_reg') || C.optionalChild(n, 'pair-device')), false, 'no approval');
    assert.equal(f.linking().active, null, 'the operation it opened is closed');
    assert.equal(f.linking().journal.snapshot().transaction, null);
});

test('getPrimaryLinkReadiness leaves the local app state and the session directory alone', async t => {
    const f = withStore(await fixture(t));
    f.linking();
    const versions = JSON.stringify(f.client._appState.versions());
    await f.client.getPrimaryLinkReadiness();
    assert.equal(JSON.stringify(f.client._appState.versions()), versions);
    assert.deepEqual(fs.readdirSync(f.dir).sort(), [PHONE + '.primary-linking.json', PHONE + '.primary-linking.json.lock'].sort());
});

test('getPrimaryLinkReadiness detects a re-link when our key wrote what the server holds', async t => {
    const f = withStore(await fixture(t));
    previousLink(f);
    const writes = watchJournal(f), keys = fs.readFileSync(f.keyFile), journal = fs.readFileSync(f.journalFile);
    const verdict = await f.client.getPrimaryLinkReadiness();
    assert.deepEqual(codes(verdict), []);
    assert.equal(verdict.mode, 'relink');
    assert.equal(verdict.ready, true);
    assert.equal(writes.length, 0);
    assert.deepEqual(fs.readFileSync(f.keyFile), keys);
    assert.deepEqual(fs.readFileSync(f.journalFile), journal);
    assert.equal(iqs(f).some(writesPatch), false);
});

// The server states the bootstrap's own tests refuse a re-link over.
const UNVERIFIABLE = {
    'written with a key we do not hold': () => [foreignPatch('Local Primary')],
    'a MAC that does not verify': ours => { const p = Buffer.from(ours.built.patch); p[p.length - 20] ^= 1; return [p]; },
    'our key, but not our state': ours => [Sync.buildPatch(pushNamePatch('Someone Else'), ours.keyId, ours.keyData, newState()).patch],
    'ahead of our version': ours => [ours.built.patch, Sync.buildPatch(pushNamePatch('Later'), ours.keyId, ours.keyData, ours.built.state).patch]
};

test('getPrimaryLinkReadiness refuses a server state that is not the one we hold', async t => {
    for (const [name, patches] of Object.entries(UNVERIFIABLE)) {
        const f = withStore(await fixture(t)), ours = previousLink(f);
        f.server.patches = patches(ours);
        f.server.version = f.server.patches.length;
        const verdict = await f.client.getPrimaryLinkReadiness();
        const blocker = only(verdict, 'PRIMARY_BOOTSTRAP_FOREIGN_STATE');
        assert.ok(blocker.detail.reasons.some(r => r.startsWith('server_')), name);
        assert.equal(verdict.mode, null, name);
    }
});

test('getPrimaryLinkReadiness refuses a first link over a server that already holds critical_block', async t => {
    const f = withStore(await fixture(t));
    f.server.version = 1;
    f.server.patches = [foreignPatch()];
    only(await f.client.getPrimaryLinkReadiness(), 'PRIMARY_BOOTSTRAP_FOREIGN_STATE');
});

// verifyServerCriticalBlock reports a key file the bootstrap cannot use either
// by raising PRIMARY_BOOTSTRAP_EXISTING_KEYS / _FOREIGN_STATE or by returning
// foreign: true. Both are a blocker; a failure to look at all is not a verdict.
test('getPrimaryLinkReadiness takes a foreign server however verifyServerCriticalBlock says so', async t => {
    const Bootstrap = require('../lib/PrimaryBootstrap'), real = Bootstrap.verifyServerCriticalBlock;
    t.after(() => { Bootstrap.verifyServerCriticalBlock = real; });
    const forms = {
        'raised EXISTING_KEYS': async () => { throw C.failure('PRIMARY_BOOTSTRAP_EXISTING_KEYS'); },
        'raised FOREIGN_STATE': async () => { throw C.failure('PRIMARY_BOOTSTRAP_FOREIGN_STATE'); },
        'returned foreign': async () => ({ version: 3, verified: false, foreign: true }),
        'returned foreign and nothing else': async () => ({ foreign: true }),
        'returned foreign that also says verified': async () => ({ version: 1, verified: true, foreign: true })
    };
    for (const [name, form] of Object.entries(forms)) {
        const f = withStore(await fixture(t));
        Bootstrap.verifyServerCriticalBlock = form;
        const verdict = await f.client.getPrimaryLinkReadiness();
        assert.deepEqual(only(verdict, 'PRIMARY_BOOTSTRAP_FOREIGN_STATE').detail.reasons, ['server_foreign'], name);
        assert.equal(verdict.ready, false, name);
        assert.equal(verdict.mode, null, name);
        assert.equal(f.linking().active, null, name);
    }
    // Not having been able to look is not a verdict.
    for (const failure of [C.failure('PRIMARY_LINK_IQ_REJECTED'), C.failure('PRIMARY_LINK_TIMEOUT'), new Error('socket closed')]) {
        const f = withStore(await fixture(t));
        Bootstrap.verifyServerCriticalBlock = async () => { throw failure; };
        await assert.rejects(f.client.getPrimaryLinkReadiness(), error => error === failure);
        assert.equal(f.linking().active, null);
    }
    // And the plain answer is still the plain answer.
    Bootstrap.verifyServerCriticalBlock = async () => ({ version: 0, verified: true, foreign: false });
    const f = withStore(await fixture(t));
    assert.equal((await f.client.getPrimaryLinkReadiness()).mode, 'first');
});

test('getPrimaryLinkReadiness sees app-state keys it did not make, and ones from another ADV lineage', async t => {
    const cases = {
        'a key from another source': f => previousLink(f, { source: 'primary_share' }),
        'a key made under another ADV state': f => { previousLink(f); f.linking().journal.update(s => { s.adv.rawId = 99; }); },
        'a key but no ADV state at all': f => { previousLink(f); f.linking().journal.update(s => { s.adv = null; }); },
        'a key file anyone can read': f => { previousLink(f); fs.chmodSync(f.keyFile, 0o644); },
        'a key file that is not JSON': f => { previousLink(f); fs.writeFileSync(f.keyFile, 'not json', { mode: 0o600 }); },
        'a key file with no keys': f => { previousLink(f); fs.writeFileSync(f.keyFile, '{}', { mode: 0o600 }); },
        'a key of the wrong length': f => { previousLink(f); const keys = JSON.parse(fs.readFileSync(f.keyFile)); keys.a1b2c3d4e5f6.keyData = Buffer.alloc(31).toString('base64'); fs.writeFileSync(f.keyFile, JSON.stringify(keys), { mode: 0o600 }); },
        'a key file that is a link': f => { previousLink(f); const real = f.keyFile + '.real'; fs.renameSync(f.keyFile, real); fs.symlinkSync(real, f.keyFile); }
    };
    for (const [name, arrange] of Object.entries(cases)) {
        const f = withStore(await fixture(t));
        arrange(f);
        const verdict = await f.client.getPrimaryLinkReadiness();
        const blocker = only(verdict, 'PRIMARY_BOOTSTRAP_FOREIGN_STATE');
        assert.ok(blocker.detail.reasons.includes('local_keys'), name);
        assert.equal(verdict.mode, null, name);
        assert.equal(iqs(f).some(n => n.attrs.xmlns === 'w:sync:app:state'), false, name + ': the server is not asked about keys that cannot be used');
    }
});

test('getPrimaryLinkReadiness sees the local state the bootstrap refuses to write over', async t => {
    const stale = withStore(await fixture(t));
    stale.client._appState.set('regular', { version: 3, hash: Buffer.alloc(128), indexValueMap: {} });
    assert.deepEqual(only(await stale.client.getPrimaryLinkReadiness(), 'PRIMARY_BOOTSTRAP_FOREIGN_STATE').detail.reasons, ['local_state']);

    for (const suffix of ['.history.json', '.messages.json']) {
        const f = withStore(await fixture(t));
        fs.writeFileSync(path.join(f.dir, PHONE + suffix), '{}');
        assert.deepEqual(only(await f.client.getPrimaryLinkReadiness(), 'PRIMARY_BOOTSTRAP_FOREIGN_STATE').detail.reasons, ['local_history'], suffix);
    }

    const none = withStore(await fixture(t));
    none.client._appState = null;
    assert.deepEqual(only(await none.client.getPrimaryLinkReadiness(), 'PRIMARY_BOOTSTRAP_FOREIGN_STATE').detail.reasons, ['local_state']);
});

test('getPrimaryLinkReadiness sees a companion that is already linked', async t => {
    const f = withStore(await fixture(t, { companions: [{ id: 7, keyIndex: 1 }] }));
    const blocker = only(await f.client.getPrimaryLinkReadiness(), 'PRIMARY_BOOTSTRAP_EXISTING_COMPANIONS_UNSUPPORTED');
    assert.equal(blocker.detail.companions, 1);
});

test('getPrimaryLinkReadiness sees the name, and the missing store', async t => {
    for (const name of ['User', '', 'x'.repeat(26)]) {
        const f = withStore(await fixture(t, { name }));
        only(await f.client.getPrimaryLinkReadiness(), 'PRIMARY_BOOTSTRAP_NAME_REQUIRED');
    }
    const f = await fixture(t);
    f.client._messageStore = null;
    const verdict = await f.client.getPrimaryLinkReadiness();
    assert.equal(only(verdict, 'PRIMARY_MESSAGE_STORE_DISABLED').detail.reason, 'disabled');
    assert.equal(verdict.history, null);
});

test('getPrimaryLinkReadiness reports a store it cannot read as a store that is not usable', async t => {
    const f = await fixture(t);
    f.client._messageStore = { snapshot: () => { throw C.failure('PRIMARY_MESSAGE_STORE_CLOSED'); } };
    assert.deepEqual(only(await f.client.getPrimaryLinkReadiness(), 'PRIMARY_MESSAGE_STORE_DISABLED').detail, { reason: 'unreadable', code: 'PRIMARY_MESSAGE_STORE_CLOSED' });
    f.client._messageStore = { snapshot: () => { throw new Error('disk on fire'); } };
    assert.deepEqual(only(await f.client.getPrimaryLinkReadiness(), 'PRIMARY_MESSAGE_STORE_DISABLED').detail, { reason: 'unreadable', code: 'PRIMARY_MESSAGE_STORE_FAILED' });
});

test('getPrimaryLinkReadiness asks about a store that only began capturing when it was enabled', async t => {
    const f = await fixture(t);
    f.client._messageStore = PrimaryMessageStore.open({ dir: f.dir, phone: PHONE, origin: 'enabled', lc: 1 });
    const verdict = await f.client.getPrimaryLinkReadiness();
    assert.equal(verdict.ready, true);
    assert.equal(verdict.needsConfirmation, true);
    assert.equal(verdict.history.capture.origin, 'enabled');
    assert.equal(verdict.history.records, 0);
    assert.deepEqual(verdict.history.retained, { evicted: 0, from: null, to: null });

    const g = await fixture(t);
    g.client._messageStore = PrimaryMessageStore.open({ dir: g.dir, phone: PHONE, origin: 'registration', lc: 1 });
    const clean = await g.client.getPrimaryLinkReadiness();
    assert.equal(clean.ready, true);
    assert.equal(clean.needsConfirmation, false);
    assert.equal(clean.history.capture.origin, 'registration');
});

test('getPrimaryLinkReadiness reports the range of messages the store holds, and what it let go of', async t => {
    const f = await fixture(t);
    const store = f.client._messageStore = PrimaryMessageStore.open({ dir: f.dir, phone: PHONE, origin: 'registration', lc: 1, perChat: 2 });
    const incoming = (id, chat, ts) => store.recordIncoming({ id, chat, fromMe: false, ts, raw: Buffer.from('the text of ' + id), info: { kind: 'content' } });
    // A third message in a chat that keeps two lets the oldest go.
    incoming('A1', 'ana@s.whatsapp.net', T + 100);
    incoming('A2', 'ana@s.whatsapp.net', T + 200);
    incoming('A3', 'ana@s.whatsapp.net', T + 300);
    incoming('G1', '120363000000000000@g.us', T + 50);
    incoming('G2', '120363000000000000@g.us', T + 900);
    const verdict = await f.client.getPrimaryLinkReadiness();
    assert.equal(verdict.history.chats, 2);
    assert.equal(verdict.history.records, 4);
    assert.deepEqual(verdict.history.retained, { evicted: 1, from: T + 50, to: T + 900 });
    assert.equal(verdict.needsConfirmation, true, 'it let one go');
    assert.deepEqual(verdict.history.losses, []);
    // None of it is content.
    const text = JSON.stringify(verdict);
    for (const forbidden of ['the text of', 'A1', 'A3', 'G2', 'ana@s.whatsapp.net', '120363000000000000@g.us']) assert.ok(!text.includes(forbidden), forbidden);
});

test('getPrimaryLinkReadiness hands out the range and the losses of a store, never its content', async t => {
    const f = await fixture(t);
    const secret = 'the-text-of-a-message-nobody-asked-for';
    f.client._messageStore = { snapshot: () => ({ ...kept(), counts: { chats: 1, records: 2 },
        losses: [{ reason: 'received-not-stored', ids: ['LOST-1'] }],
        records: { 'x@s.whatsapp.net': [rec('M1', T + 30, { raw: Buffer.from(secret), pushName: secret }), rec('M2', T + 10)] },
        chats: [{ id: 'x@s.whatsapp.net', name: secret }], pushNames: [{ id: 'x', pushname: secret }] }) };
    const verdict = await f.client.getPrimaryLinkReadiness();
    assert.deepEqual(verdict.history.retained, { evicted: 0, from: T + 10, to: T + 30 });
    assert.deepEqual(verdict.history.losses, [{ reason: 'received-not-stored', ids: ['LOST-1'] }]);
    assert.ok(!JSON.stringify(verdict).includes(secret));
    assert.ok(!JSON.stringify(verdict).includes(Buffer.from(secret).toString('base64')));
    assert.ok(!JSON.stringify(verdict).includes('M1') && !JSON.stringify(verdict).includes('x@s.whatsapp.net'));
});

test('getPrimaryLinkReadiness without a usable account asks nothing and creates nothing', async t => {
    const f = withStore(await fixture(t));
    f.client._store.registered = false;
    only(await f.client.getPrimaryLinkReadiness(), 'PRIMARY_LINK_ACCOUNT_REQUIRED');
    f.client._store.registered = true;
    f.client._store.phoneNumber = '123';
    only(await f.client.getPrimaryLinkReadiness(), 'PRIMARY_LINK_ACCOUNT_REQUIRED');
    assert.equal(f.requests.length, 0);
    assert.deepEqual(fs.readdirSync(f.dir), [], 'no journal, no lock');
});

test('getPrimaryLinkReadiness is for a primary, and for a connected one', async t => {
    const f = withStore(await fixture(t));
    f.client._connected = false;
    await assert.rejects(f.client.getPrimaryLinkReadiness(), { code: 'PRIMARY_LINK_CONNECTION_REQUIRED' });
    f.client._connected = true;
    f.client._mode = 'web';
    await assert.rejects(f.client.getPrimaryLinkReadiness(), { code: 'PRIMARY_LINK_PRIMARY_REQUIRED' });
    assert.equal(f.requests.length, 0);
    f.client._mode = 'mobile';
});

test('getPrimaryLinkReadiness does not run over another operation, and lets go of its own', async t => {
    const f = withStore(await fixture(t));
    const operation = f.linking().begin({});
    await assert.rejects(f.client.getPrimaryLinkReadiness(), { code: 'PRIMARY_LINK_BUSY' });
    assert.equal(f.linking().active, operation, 'the other operation is still the active one');
    f.linking().end(operation);
    await f.client.getPrimaryLinkReadiness();
    assert.equal(f.linking().active, null);
});

test('getPrimaryLinkReadiness can be aborted, and lets go when it is', async t => {
    const f = withStore(await fixture(t));
    f.linking();
    f.client._socket.sendNode = node => { f.requests.push(node); };   // the server never answers
    const abort = new AbortController();
    const run = f.client.getPrimaryLinkReadiness({ signal: abort.signal });
    await new Promise(resolve => setImmediate(resolve));
    abort.abort();
    await assert.rejects(run, { code: 'PRIMARY_LINK_ABORTED' });
    assert.equal(f.linking().active, null);
    await assert.rejects(f.client.getPrimaryLinkReadiness({ signal: abort.signal }), { code: 'PRIMARY_LINK_ABORTED' });
});

// ─── readiness and the link it guards never disagree ────────────────────────

test('readiness blocks on exactly the phases approve refuses on', async t => {
    const phases = ['exchange', 'exchange_failed', 'verification_required', 'finish_verified', 'pair_device_sending', 'awaiting_confirmation', 'uncertain', 'committed', 'abandoned'];
    for (const phase of phases) {
        const f = withStore(await fixture(t));
        hold(f, phase, 10 * MIN);
        const blocked = (await f.client.getPrimaryLinkReadiness()).blockers.some(b => b.code === 'PRIMARY_LINK_RECONCILIATION_REQUIRED');
        // approve reads the journal before it looks at the invitation: a hold is
        // refused as such; anything else gets as far as asking for an invitation.
        const refusal = await f.client.approveCompanionCode(f.code, { invitationId: 'f'.repeat(64) }).then(() => null, error => error.code);
        assert.equal(refusal, blocked ? 'PRIMARY_LINK_RECONCILIATION_REQUIRED' : 'PRIMARY_LINK_INVITATION_REQUIRED', phase);
    }
});

test('readiness calls a hold retirable exactly when retireAbsent will retire it', async t => {
    for (const phase of ['verification_required', 'finish_verified', 'pair_device_sending', 'awaiting_confirmation', 'uncertain']) {
        for (const ageMs of [MIN, 10 * MIN]) {
            const f = withStore(await fixture(t));
            hold(f, phase, ageMs);
            const hint = (await f.client.getPrimaryLinkReadiness()).blockers.find(b => b.code === 'PRIMARY_LINK_RECONCILIATION_REQUIRED').detail.retirable;
            const outcome = await f.client.retireAbsentPrimaryLink().then(() => 'retired', error => error.code);
            assert.equal(hint, outcome === 'retired', phase + ' at ' + ageMs + ' -> ' + outcome);
            if (!hint) assert.match(outcome, /^PRIMARY_LINK_(NO_RETIRABLE_TRANSACTION|RETIRE_TOO_EARLY)$/);
        }
    }
});

// Each way an account can be, what readiness says of it, and what approving
// and bootstrapping it then does. A verdict that says ready must be a link
// that completes; one that blocks must name what the bootstrap would refuse.
const AGREEMENT = {
    'a clean first link': { arrange: () => { }, mode: 'first' },
    'a clean re-link': { arrange: f => previousLink(f), mode: 'relink' },
    'a server that holds someone else\'s critical_block': { arrange: f => { f.server.version = 1; f.server.patches = [foreignPatch()]; }, refused: 'PRIMARY_BOOTSTRAP_FOREIGN_STATE', blocker: 'PRIMARY_BOOTSTRAP_FOREIGN_STATE' },
    'keys this primary did not make': { arrange: f => previousLink(f, { source: 'primary_share' }), refused: 'PRIMARY_BOOTSTRAP_EXISTING_KEYS', blocker: 'PRIMARY_BOOTSTRAP_FOREIGN_STATE' },
    'app state that is not empty': { arrange: f => f.client._appState.set('regular', { version: 3, hash: Buffer.alloc(128), indexValueMap: {} }), refused: 'PRIMARY_BOOTSTRAP_EXISTING_STATE', blocker: 'PRIMARY_BOOTSTRAP_FOREIGN_STATE' },
    'a history file already on disk': { arrange: f => fs.writeFileSync(path.join(f.dir, PHONE + '.history.json'), '{}'), refused: 'PRIMARY_BOOTSTRAP_EXISTING_HISTORY', blocker: 'PRIMARY_BOOTSTRAP_FOREIGN_STATE' },
    'a push name that is not one': { arrange: f => { f.client._store.name = 'User'; }, refused: 'PRIMARY_BOOTSTRAP_NAME_REQUIRED', blocker: 'PRIMARY_BOOTSTRAP_NAME_REQUIRED' },
    'no message store': { arrange: f => { f.client._messageStore = null; }, refused: 'PRIMARY_MESSAGE_STORE_DISABLED', blocker: 'PRIMARY_MESSAGE_STORE_DISABLED' }
};
for (const [name, rel] of Object.entries(UNVERIFIABLE))
    AGREEMENT['a re-link over a server state: ' + name] = { arrange: f => { const ours = previousLink(f); f.server.patches = rel(ours); f.server.version = f.server.patches.length; },
        refused: 'PRIMARY_BOOTSTRAP_FOREIGN_STATE', blocker: 'PRIMARY_BOOTSTRAP_FOREIGN_STATE' };

for (const [name, expected] of Object.entries(AGREEMENT)) {
    test('readiness and the bootstrap agree: ' + name, async t => {
        const f = withStore(await fixture(t));
        expected.arrange(f);
        const verdict = await f.client.getPrimaryLinkReadiness();
        const invitation = await offerCompanion(f);
        await f.client.approveCompanionCode(f.code, { invitationId: invitation.id });
        const sentBefore = f.requests.filter(n => n.description === 'message').length, patchesBefore = f.requests.filter(n => n.description === 'iq' && writesPatch(n)).length;
        const outcome = await f.client.bootstrapPrimaryCompanion({ history: 'store' }).then(result => ({ result }), error => ({ error }));
        if (expected.refused) {
            assert.deepEqual(codes(verdict).includes(expected.blocker), true, 'readiness names it: ' + codes(verdict));
            assert.equal(verdict.ready, false);
            assert.equal(outcome.error?.code, expected.refused);
            assert.equal(f.requests.filter(n => n.description === 'message').length, sentBefore, 'nothing is sent to the companion');
            assert.equal(f.requests.filter(n => n.description === 'iq' && writesPatch(n)).length, patchesBefore, 'no patch is written');
        } else {
            assert.deepEqual(verdict.blockers, []);
            assert.equal(verdict.ready, true);
            assert.equal(verdict.mode, expected.mode);
            assert.equal(outcome.error, undefined, outcome.error?.code);
            assert.equal(outcome.result.status, 'sent');
            assert.equal(outcome.result.mode, verdict.mode, 'the mode readiness predicted is the mode the bootstrap ran in');
        }
    });
}

// ─── the public surface ─────────────────────────────────────────────────────

test('Readiness is reachable from the package export, as the module itself', () => {
    assert.equal(wa.Primary.Readiness, R);
    assert.equal(typeof wa.Primary.Readiness.evaluateReadiness, 'function');
    assert.equal(typeof wa.WhalibmobClient.prototype.getPrimaryLinkReadiness, 'function');
});
