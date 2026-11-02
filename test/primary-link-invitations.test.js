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

// The brief's formula, written out here on purpose and not imported, so the
// test pins the wire contract rather than echoing the implementation.
const fingerprint = noise => crypto.createHash('sha256').update(noise).digest('hex').slice(0, 8);
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');

// A mobile primary with a real journal and a socket that swallows writes.
function primary(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'primary-invitation-test-'));
    fs.chmodSync(dir, 0o700);
    const client = new WhalibmobClient({ sessionDir: dir, refreshVersion: false });
    client._store = createNewStore('15550000123');
    client._store.registered = true;
    client._myLid = '1234567890@lid';
    client._connected = true;
    client._scheduleReconnect = () => { };
    const sent = [];
    client._socket = { close: () => client._onClose(), sendNode(node) { sent.push(node); } };
    t.after(() => { client.disconnect(); fs.rmSync(dir, { recursive: true, force: true }); });
    return { client, sent, journal: () => client._primaryLinkingForSession().journal };
}

// A pending journal entry exactly as handleNotification stores it, so it is
// restorable: base64 fields and an id bound to ref, noise and wrapped.
function entry(ref, noise, wrapped = crypto.randomBytes(80)) {
    return {
        id: sha256(Buffer.concat([ref, noise, wrapped])),
        ref: ref.toString('base64'), noise: noise.toString('base64'), wrapped: wrapped.toString('base64'),
        receivedAt: Date.now()
    };
}

function seed(journal, entries) {
    journal.update(s => { s.pending.push(...entries); });
}

function hello(id, ref, noise, wrapped = crypto.randomBytes(80)) {
    return new BinaryNode('notification', { id, from: 's.whatsapp.net', type: 'link_code_companion_reg' }, [
        new BinaryNode('link_code_companion_reg', { stage: 'companion_hello' }, [
            new BinaryNode('link_code_pairing_ref', {}, ref),
            new BinaryNode('companion_server_auth_key_pub', {}, noise),
            new BinaryNode('link_code_pairing_wrapped_companion_ephemeral_pub', {}, wrapped)
        ])
    ]);
}

test('same noise gives the same companion, different noise differs', t => {
    const { client, journal } = primary(t);
    const shared = crypto.randomBytes(32), other = crypto.randomBytes(32);
    const first = entry(Buffer.from('browser-request-1'), shared);
    const second = entry(Buffer.from('browser-request-2'), shared); // Web's twin request, ~200 ms later.
    const third = entry(Buffer.from('another-tab'), other);
    seed(journal(), [first, second, third]);

    const listed = client.getPrimaryLinkInvitations();
    const byId = Object.fromEntries(listed.map(p => [p.id, p]));
    assert.equal(listed.length, 3);
    assert.equal(new Set(listed.map(p => p.id)).size, 3, 'three distinct invitations');

    assert.equal(byId[first.id].companion, byId[second.id].companion);
    assert.notEqual(byId[first.id].companion, byId[third.id].companion);
    assert.equal(byId[first.id].companion, fingerprint(shared));
    assert.equal(byId[third.id].companion, fingerprint(other));
    assert.match(byId[first.id].companion, /^[0-9a-f]{8}$/);
    // The raw 32 key bytes are hashed, never the base64 text stored in the journal.
    assert.notEqual(byId[first.id].companion, sha256(shared.toString('base64')).slice(0, 8));
    // Additive: id and expiresAt are exactly what they were.
    assert.deepEqual(Object.keys(byId[first.id]).sort(), ['companion', 'expiresAt', 'id']);
    assert.equal(byId[first.id].expiresAt, first.receivedAt + 180000);
});

test('the primary_link_invitation event carries the same companion as the listing', t => {
    const { client } = primary(t);
    const shared = crypto.randomBytes(32), other = crypto.randomBytes(32);
    const events = [];
    client.on('primary_link_invitation', event => events.push(event));

    client._handleNotification(hello('hello-1', Buffer.from('browser-request-1'), shared));
    client._handleNotification(hello('hello-2', Buffer.from('browser-request-2'), shared));
    client._handleNotification(hello('hello-3', Buffer.from('another-tab'), other));

    assert.equal(events.length, 3);
    assert.equal(events[0].companion, fingerprint(shared));
    assert.equal(events[1].companion, events[0].companion);
    assert.equal(events[2].companion, fingerprint(other));
    const listed = Object.fromEntries(client.getPrimaryLinkInvitations().map(p => [p.id, p]));
    for (const event of events) assert.deepEqual(listed[event.id], { id: event.id, expiresAt: event.expiresAt, companion: event.companion });
});

test('a journal entry without a usable noise key lists with companion null instead of crashing', t => {
    const { client, journal } = primary(t);
    const good = entry(Buffer.from('ordinary'), crypto.randomBytes(32));
    const missing = { ...entry(Buffer.from('no-noise'), crypto.randomBytes(32)) };
    delete missing.noise;
    const short = { ...entry(Buffer.from('short-noise'), crypto.randomBytes(32)), noise: crypto.randomBytes(16).toString('base64') };
    const wrongType = { ...entry(Buffer.from('typed-noise'), crypto.randomBytes(32)), noise: 7 };
    seed(journal(), [good, missing, short, wrongType]);

    const byId = Object.fromEntries(client.getPrimaryLinkInvitations().map(p => [p.id, p]));
    assert.equal(Object.keys(byId).length, 4);
    assert.match(byId[good.id].companion, /^[0-9a-f]{8}$/);
    assert.equal(byId[missing.id].companion, null);
    assert.equal(byId[short.id].companion, null);
    assert.equal(byId[wrongType.id].companion, null);
});

test('the library still refuses to guess between invitations from the same companion', async t => {
    const { client, journal, sent } = primary(t);
    const shared = crypto.randomBytes(32);
    const first = entry(Buffer.from('browser-request-1'), shared), second = entry(Buffer.from('browser-request-2'), shared);
    seed(journal(), [first, second]);
    const [a, b] = client.getPrimaryLinkInvitations();
    assert.equal(a.companion, b.companion);

    await assert.rejects(client.linkCompanionWithCode('K7M2QX4B', { waitMs: 0 }), { code: 'PRIMARY_LINK_INVITATION_AMBIGUOUS' });
    assert.equal(sent.length, 0, 'nothing is sent while the choice is ambiguous');
});
