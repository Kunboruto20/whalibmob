'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// WA_DEBUG_BOOTSTRAP_STOP_AFTER=<phase> is a testing aid for the interrupted
// bootstrap: the process kills itself, as kill -9 would, right after <phase>
// is journaled, so "kill it after history_uploaded, restart, resume" can be
// done by hand on a real link. It is checked here the way it is used: in a
// process of its own that really dies, with what it left on disk read back.

const ROOT = path.join(__dirname, '..');
const PHONE = '15550000123';

// The bootstrapping process. It is passed to `node -e` rather than kept as a
// file under test/, so `node --test` never runs it on its own. The link it
// bootstraps is already approved (written straight into the journal), and the
// server and the companion are a socket that accepts everything at once.
function child() {
    const path = require('node:path');
    const crypto = require('node:crypto');
    const [root, dir, size] = process.argv.slice(1);
    const lib = name => require(path.join(root, 'lib', name));
    const { WhalibmobClient } = lib('Client');
    const { createNewStore } = lib('Store');
    const { BinaryNode } = lib('BinaryNode');
    const C = lib('PrimaryLinkCrypto');
    const { AppStateStore } = lib(path.join('appstate', 'AppStateStore'));
    const PHONE = '15550000123', ANA = '40799999999@s.whatsapp.net', T = 1790000000;

    const client = new WhalibmobClient({ sessionDir: dir, refreshVersion: false });
    client._store = createNewStore(PHONE);
    client._store.registered = true;
    client._store.name = 'Local Primary';
    client._myLid = '1234567890@lid';
    client._connected = true;
    client._scheduleReconnect = () => { };
    client._appState = new AppStateStore(path.join(dir, PHONE + '.appState.json'));
    const peer = crypto.randomBytes(32);
    client._devMgr = { async fetchBundles(jids) { return new Map([[jids[0], { identityKey: peer }]]); } };
    client._signal = { async hasSession() { return false; }, async buildSessionFromBundle() { }, async encrypt(jid, plaintext) { return { type: 'pkmsg', ciphertext: Buffer.from(plaintext) }; } };
    let version = 0;
    const reply = (query, content) => client._handleIq(new BinaryNode('iq', { id: query.attrs.id, type: 'result', from: 's.whatsapp.net' }, content));
    const collection = () => new BinaryNode('sync', {}, [new BinaryNode('collection', { name: 'critical_block', version: String(version) }, null)]);
    client._socket = { close() { }, sendNode(node) {
        if (node.description === 'message') {
            queueMicrotask(() => client._handleAck(new BinaryNode('ack', { id: node.attrs.id, class: 'message', from: PHONE + '@s.whatsapp.net' }, null)));
            return;
        }
        queueMicrotask(() => {
            if (node.attrs.xmlns === 'usync') {
                const devices = [new BinaryNode('device', { id: '0' }, null), new BinaryNode('device', { id: '7', 'key-index': '1' }, null)];
                reply(node, [new BinaryNode('usync', { sid: C.child(node, 'usync').attrs.sid }, [new BinaryNode('list', {}, [
                    new BinaryNode('user', { jid: PHONE + '@s.whatsapp.net' }, [new BinaryNode('devices', {}, [new BinaryNode('device-list', {}, devices)])])
                ])])]);
                return;
            }
            if (C.optionalChild(C.child(C.child(node, 'sync'), 'collection'), 'patch')) version += 1;
            reply(node, [collection()]);
        });
    } };
    client._primaryLinkingForSession().journal.update(s => {
        s.transaction = { id: crypto.randomUUID(), method: 'code', phase: 'awaiting_confirmation', startedAt: Date.now(), peer: peer.toString('base64'),
            state: { rawId: 4242, currentIndex: 1, timestamp: Math.floor(Date.now() / 1000), validIndexes: [0, 1] }, before: [{ id: 0, hasKeyIndex: false, keyIndex: 0 }] };
    });
    // Bytes deflate cannot shrink, when the history is to go up as a blob.
    const raw = Number(size) > 0 ? crypto.randomBytes(Number(size)) : Buffer.from('hello');
    const snapshot = { seq: 1, capture: { since: T * 1000, origin: 'registration', lc: 0 }, chats: [{ id: ANA, conversationTimestamp: T, unreadCount: 0 }],
        records: { [ANA]: [{ id: 'M1', seq: 1, fromMe: false, ts: T, status: 3, raw }] }, losses: [], retained: { evicted: 0 }, pushNames: [], counts: { chats: 1, records: 1 } };
    const upload = async bytes => ({ directPath: '/v/t62.synthetic/blob', mediaKey: crypto.randomBytes(32), fileSha256: crypto.createHash('sha256').update(bytes).digest(),
        fileEncSha256: crypto.randomBytes(32), fileLength: bytes.length });
    client.bootstrapPrimaryCompanion({ history: async () => snapshot, upload }).then(
        result => { process.stdout.write('finished ' + result.status + '\n'); process.exit(0); },
        error => { process.stdout.write('failed ' + error.code + '\n'); process.exit(1); });
}
const CHILD = '(' + child + ')()';

function bootstrapInChild(t, stopAfter, size = 0) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'primary-bootstrap-stop-'));
    fs.chmodSync(dir, 0o700);
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const env = { ...process.env };
    delete env.WA_DEBUG_BOOTSTRAP_STOP_AFTER;
    if (stopAfter !== undefined) env.WA_DEBUG_BOOTSTRAP_STOP_AFTER = stopAfter;
    const r = spawnSync(process.execPath, ['-e', CHILD, ROOT, dir, String(size)], { env, encoding: 'utf8', timeout: 30000 });
    if (r.error) throw r.error;
    const journal = JSON.parse(fs.readFileSync(path.join(dir, PHONE + '.primary-linking.json'), 'utf8'));
    const outbox = path.join(dir, PHONE + '.primary-history-outbox.json');
    return { r, phase: journal.transaction.bootstrap?.phase, outbox: fs.existsSync(outbox) ? JSON.parse(fs.readFileSync(outbox, 'utf8')) : null };
}

const skip = process.platform === 'win32' && 'a process killing itself is reported differently on Windows';

test('the bootstrap kills its process right after the phase named is journaled', { skip }, t => {
    for (const phase of ['prepared', 'key_share_sending', 'critical_patch_accepted', 'history_prepared']) {
        const { r, phase: left } = bootstrapInChild(t, phase);
        assert.equal(r.signal, 'SIGKILL', phase + ': ' + r.stdout + r.stderr);
        assert.equal(r.stdout, '', phase + ': nothing ran after it');
        assert.equal(left, phase);
    }
    // After the upload: the blob is recorded beside the pinned bytes, for a resume.
    const { r, phase, outbox } = bootstrapInChild(t, 'history_uploaded', 70000);
    assert.equal(r.signal, 'SIGKILL', r.stdout + r.stderr);
    assert.equal(phase, 'history_uploaded');
    assert.equal(outbox.blob.directPath, '/v/t62.synthetic/blob');
});

test('without a known phase name the bootstrap runs to the end', { skip }, t => {
    for (const value of [undefined, '', 'history_upload', 'SENT', 'critical_patch']) {
        const { r, phase, outbox } = bootstrapInChild(t, value);
        assert.equal(r.signal, null, String(value) + ': ' + r.stdout + r.stderr);
        assert.equal(r.status, 0, String(value) + ': ' + r.stdout + r.stderr);
        assert.equal(r.stdout, 'finished sent\n');
        assert.equal(phase, 'sent');
        assert.equal(outbox, null);
    }
});
