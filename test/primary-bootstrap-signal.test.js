'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createNewStore } = require('../lib/Store');
const { SignalProtocol } = require('../lib/signal/SignalProtocol');
const { SignalStore } = require('../lib/signal/SignalStore');
const { keyShare } = require('../lib/PrimaryBootstrap');
const { decodeFields, decodeMessageContainer } = require('../lib/proto/MessageProto');
function signal(store) {
    const keys = new SignalStore();
    keys.init({ pubKey: store.identityKeyPair.public, privKey: store.identityKeyPair.private }, store.registrationId);
    const protocol = new SignalProtocol(keys);
    protocol._ensureSignedPreKey(store);
    protocol.generatePreKeys(1);
    return protocol;
}
test('primary key-share travels through real Signal encryption and the companion independently decodes its complete ADV fingerprint', async () => {
    const primary = signal(createNewStore('15550000123')), secondaryStore = createNewStore('15550000123'), companion = signal(secondaryStore);
    const preKey = companion.getPreKeysForUpload(1)[0];
    await primary.buildSessionFromBundle('15550000123:7@s.whatsapp.net', { registrationId: secondaryStore.registrationId,
        identityKey: secondaryStore.identityKeyPair.public,
        signedPreKey: { keyId: secondaryStore.signedPreKey.id, publicKey: secondaryStore.signedPreKey.public, signature: secondaryStore.signedPreKey.signature },
        preKey: { keyId: preKey.keyId, publicKey: preKey.pubKey } });
    const state = { rawId: 12345, currentIndex: 2, timestamp: 123, validIndexes: [0, 2] };
    const keyData = Buffer.alloc(32, 17), keyId = Buffer.alloc(6, 19), timestamp = 1793000000000;
    const plaintext = keyShare(keyId, keyData, state, timestamp);
    const encrypted = await primary.encrypt('15550000123:7@s.whatsapp.net', plaintext);
    assert.equal(encrypted.type, 'pkmsg');
    assert.notDeepEqual(encrypted.ciphertext, plaintext);
    const decrypted = await companion.decrypt('15550000123:0@s.whatsapp.net', encrypted.type, encrypted.ciphertext);
    assert.deepEqual(decrypted, plaintext);
    const decoded = decodeMessageContainer(decrypted).appStateSyncKeyShare.keys[0];
    assert.equal(decoded.keyId, keyId.toString('hex'));
    assert.deepEqual(decoded.keyData, keyData);
    assert.equal(decoded.timestamp, timestamp);
    const pm = decodeFields(decodeFields(decrypted)[12]);
    assert.equal(pm[2], 6);
    const fingerprint = decodeFields(decodeFields(decodeFields(pm[7])[1])[2])[2];
    const fields = decodeFields(fingerprint);
    assert.equal(fields[1], state.rawId);
    assert.equal(fields[2], state.currentIndex);
    assert.deepEqual([...fields[3]], state.validIndexes);
});
