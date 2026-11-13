'use strict';
// Primary-role consumer E2EE linking. This module is pure: no socket, store,
// device verification, registration or provider credentials.
const { Boom } = require('@hapi/boom');
const crypto = require('node:crypto');
const { Reader, Writer } = require('protobufjs/minimal');
const curve = require('./curve');
const pairing = require('./PairingCode');
const { BinaryNode } = require('./BinaryNode');
function failure(code = 'PRIMARY_LINK_INVALID') {
    const error = new Boom(code, { statusCode: 400 });
    error.code = code;
    return error;
}
function requireValue(ok, code) { if (!ok)
    throw failure(code); }
function bytes(value, size) {
    requireValue(Buffer.isBuffer(value) && value.length === size);
    return value;
}
function equal(a, b) {
    return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.length === b.length && crypto.timingSafeEqual(a, b);
}
function bare(key) { return bytes(pairing.stripKeyPrefix(key), 32); }
function child(node, tag) {
    const found = Array.isArray(node && node.content) ? node.content.filter(c => c && c.description === tag) : [];
    requireValue(found.length === 1);
    return found[0];
}
function optionalChild(node, tag) {
    const found = Array.isArray(node && node.content) ? node.content.filter(c => c && c.description === tag) : [];
    requireValue(found.length <= 1);
    return found[0] || null;
}
function payload(node, tag, size) { return bytes(child(node, tag).content, size); }
function reference(node) {
    const value = child(node, 'link_code_pairing_ref').content;
    requireValue(Buffer.isBuffer(value) && value.length > 0 && value.length <= 256);
    return value;
}
function jid(value) {
    if (typeof value === 'string')
        return value;
    // A bare server JID uses JID_PAIR with an empty user on the mobile wire.
    // BinaryNode decodes that as {user:null,server}, rather than a string.
    // Preserve that server identity so all existing exact sender checks apply.
    if (value && (value.user === null || value.user === '') && typeof value.server === 'string')
        return value.server;
    if (!value || typeof value.user !== 'string' || typeof value.server !== 'string')
        throw failure();
    const device = Number(value.device || 0);
    return `${value.user}${device ? ':' + device : ''}@${value.server}`;
}
function parseDevice(value, ownPhone, ownLid) {
    const text = jid(value);
    const match = /^(\d+):(\d+)@(s\.whatsapp\.net|lid)$/.exec(text);
    requireValue(match && Number(match[2]) > 0 && Number(match[2]) <= 99);
    const user = match[1] + '@' + match[3];
    requireValue(user === ownPhone || (ownLid && user === ownLid));
    return { jid: text, id: Number(match[2]) };
}
function number(value, max = 0x7fffffff) {
    requireValue(typeof value === 'number' || typeof value === 'string');
    if (typeof value === 'string')
        requireValue(/^(0|[1-9]\d*)$/.test(value));
    const n = Number(value);
    requireValue(Number.isSafeInteger(n) && n >= 0 && n <= max);
    return n;
}
function code(value) {
    requireValue(typeof value === 'string');
    const normalized = value.toUpperCase().replace(/-/g, '');
    requireValue(/^[123456789ABCDEFGHJKLMNPQRSTVWXYZ]{8}$/.test(normalized), 'PRIMARY_LINK_CODE_INVALID');
    return normalized;
}
// These small ADV messages reject duplicate/unknown fields and truncated input.
// Do not use the companion module's permissive convenience decoder for state.
const schemas = {
    identity: { 1: 'n', 2: 'n', 3: 'n', 4: 'n', 5: 'n' },
    signed: { 1: 'b', 2: 'b', 3: 'b', 4: 'b' },
    indexes: { 1: 'n', 2: 'n', 3: 'n', 4: 'r', 5: 'n' },
    signedIndexes: { 1: 'b', 2: 'b', 3: 'b' },
    hmac: { 1: 'b', 2: 'b', 3: 'n' }
};
function decode(kind, data) {
    requireValue(Buffer.isBuffer(data) && data.length > 0 && data.length <= 8192);
    const reader = Reader.create(data), schema = schemas[kind], out = {};
    requireValue(schema);
    try {
        while (reader.pos < reader.len) {
            const tag = reader.uint32(), field = tag >>> 3, wire = tag & 7;
            const type = schema[field];
            requireValue(type && (!Object.hasOwn(out, field) || type === 'r'));
            if (type === 'b') {
                requireValue(wire === 2);
                out[field] = Buffer.from(reader.bytes());
            }
            else if (type === 'n') {
                requireValue(wire === 0);
                out[field] = number(reader.uint64().toString(), Number.MAX_SAFE_INTEGER);
            }
            else {
                const values = out[field] || (out[field] = []);
                if (wire === 2) {
                    const length = reader.uint32(), end = reader.pos + length;
                    requireValue(end <= reader.len);
                    while (reader.pos < end)
                        values.push(reader.uint32());
                    requireValue(reader.pos === end);
                }
                else {
                    requireValue(wire === 0);
                    values.push(reader.uint32());
                }
                requireValue(values.length <= 63);
            }
        }
    }
    catch (_) {
        throw failure('PRIMARY_LINK_PROTO_INVALID');
    }
    return out;
}
function encode(kind, fields) {
    const schema = schemas[kind], writer = Writer.create();
    for (const key of Object.keys(fields).map(Number).sort((a, b) => a - b)) {
        const type = schema[key], value = fields[key];
        requireValue(type);
        if (type === 'b')
            writer.uint32(key * 8 + 2).bytes(value);
        else if (type === 'n')
            writer.uint32(key * 8).uint64(number(value, Number.MAX_SAFE_INTEGER));
        else {
            writer.uint32(key * 8 + 2).fork();
            for (const n of value)
                writer.uint32(number(n));
            writer.ldelim();
        }
    }
    return Buffer.from(writer.finish());
}
function validateState(state) {
    requireValue(state && number(state.rawId) > 0 && number(state.currentIndex) > 0 && number(state.timestamp, Number.MAX_SAFE_INTEGER) > 0);
    requireValue(Array.isArray(state.validIndexes) && state.validIndexes.length >= 2 && state.validIndexes.length <= 63);
    const indexes = state.validIndexes.map(n => number(n));
    requireValue(new Set(indexes).size === indexes.length && indexes.includes(0) && indexes.includes(state.currentIndex));
    return { rawId: state.rawId, currentIndex: state.currentIndex, timestamp: state.timestamp, validIndexes: indexes.slice().sort((a, b) => a - b) };
}
function reserveState(previous, devices, now, reservationFloor = null) {
    requireValue(Array.isArray(devices) && devices.some(d => d.id === 0) && devices.length < 63);
    const floor = reservationFloor ? validateState(reservationFloor) : null;
    if (!previous) {
        requireValue(devices.length === 1, 'PRIMARY_LINK_EXISTING_ADV_REQUIRED');
        if (floor) {
            const index = number(floor.currentIndex + 1);
            return { rawId: floor.rawId, currentIndex: index, timestamp: Math.max(now, floor.timestamp + 1), validIndexes: [0, index] };
        }
        let rawId = 0;
        while (!rawId)
            rawId = crypto.randomBytes(4).readUInt32BE() & 0x7fffffff;
        return { rawId, currentIndex: 1, timestamp: number(now, Number.MAX_SAFE_INTEGER), validIndexes: [0, 1] };
    }
    const p = validateState(previous);
    requireValue(!floor || floor.rawId === p.rawId, 'PRIMARY_LINK_ADV_MISMATCH');
    // A companion can have logged out since the last committed list. Only a
    // subset of known indexes may disappear; an unknown index still requires
    // authoritative state. Keep the index high-water mark when pruning.
    requireValue(devices.every(d => d.id === 0 || (d.hasKeyIndex && p.validIndexes.includes(d.keyIndex))), 'PRIMARY_LINK_ADV_MISMATCH');
    const index = Math.max(...p.validIndexes, floor ? floor.currentIndex : 0) + 1;
    requireValue(index <= 0x7fffffff);
    return { rawId: p.rawId, currentIndex: index, timestamp: Math.max(now, p.timestamp + 1, floor ? floor.timestamp + 1 : 0), validIndexes: [...devices.map(d => d.id === 0 ? 0 : d.keyIndex), index] };
}
function makeADV(peer, secret, identity, state) {
    validateState(state);
    bytes(peer, 32);
    bytes(secret, 32);
    const own = bare(identity.public);
    const details = encode('identity', { 1: state.rawId, 2: state.timestamp, 3: state.currentIndex, 4: 0, 5: 0 });
    const message = Buffer.concat([Buffer.from([6, 0]), details, peer]);
    const signature = Buffer.from(curve.sign(bytes(identity.private, 32), message));
    requireValue(curve.verify(own, message, signature));
    const signed = encode('signed', { 1: details, 2: own, 3: signature });
    const deviceIdentity = encode('hmac', { 1: signed, 2: crypto.createHmac('sha256', secret).update(signed).digest(), 3: 0 });
    const list = encode('indexes', { 1: state.rawId, 2: state.timestamp, 3: state.currentIndex, 4: state.validIndexes, 5: 0 });
    const listMessage = Buffer.concat([Buffer.from([6, 2]), list]);
    const listSignature = Buffer.from(curve.sign(identity.private, listMessage));
    requireValue(curve.verify(own, listMessage, listSignature));
    return { deviceIdentity, keyIndexList: encode('signedIndexes', { 1: list, 2: listSignature }) };
}
function primaryPairNode(id, invitation, peer, secret, identity, state, method = 'code') {
    requireValue(method === 'code' || method === 'qr');
    const adv = makeADV(peer, secret, identity, state);
    const children = [
        new BinaryNode('ref', {}, invitation.ref), new BinaryNode('pub-key', {}, invitation.noise),
        new BinaryNode('device-identity', {}, adv.deviceIdentity),
        new BinaryNode('key-index-list', { ts: String(state.timestamp) }, adv.keyIndexList)
    ];
    // QR already conveys the ADV secret. The phone-code exchange additionally
    // carries the companion nonce envelope; keep that existing wire unchanged.
    if (method === 'qr')
        return new BinaryNode('iq', { to: 's.whatsapp.net', xmlns: 'md', type: 'set', id }, [new BinaryNode('pair-device', {}, children)]);
    const nonceKey = pairing.hkdf(secret, 32, 'Canonical Ent Companion Nonce Encrypt', invitation.noise);
    try {
        children.push(new BinaryNode('pem', { version: '1', algorithm: 'rsa2048' }, [
            new BinaryNode('pem', {}, Buffer.from(nonceKey)), new BinaryNode('ttl', { ts_s: '432000' }), new BinaryNode('key_id', {}, Buffer.from('1'))
        ]));
        return new BinaryNode('iq', { to: 's.whatsapp.net', xmlns: 'md', type: 'set', id }, [new BinaryNode('pair-device', {}, children)]);
    }
    finally {
        nonceKey.fill(0);
    }
}
async function primaryHello(invitation, pairingCode, identity) {
    const ephemeral = pairing.generateEphemeralKeyPair();
    let unwrapped;
    try {
        unwrapped = await pairing.decipherLinkPublicKey(bytes(invitation.wrapped, 80), code(pairingCode));
        const shared = pairing.sharedKey(ephemeral.private, bytes(unwrapped, 32));
        const wrapped = await pairing.buildWrappedEphemeralPub(code(pairingCode), ephemeral.public);
        return { ephemeral, shared, children: [
                new BinaryNode('link_code_pairing_wrapped_primary_ephemeral_pub', {}, wrapped),
                new BinaryNode('primary_identity_pub', {}, bare(identity.public)),
                new BinaryNode('link_code_pairing_ref', {}, invitation.ref)
            ] };
    }
    catch (_) {
        ephemeral.private.fill(0);
        throw failure('PRIMARY_LINK_KEY_EXCHANGE_INVALID');
    }
    finally {
        if (unwrapped)
            unwrapped.fill(0);
    }
}
function primaryFinish(node, invitation, exchange, identity, expectedPeer) {
    requireValue(equal(reference(node), invitation.ref));
    const peer = payload(node, 'companion_identity_public', 32);
    if (expectedPeer)
        requireValue(equal(peer, bare(expectedPeer)));
    const wrapped = payload(node, 'link_code_pairing_wrapped_key_bundle', 156);
    const key = pairing.hkdf(exchange.shared, 32, 'link_code_pairing_key_bundle_encryption_key', wrapped.subarray(0, 32));
    let plain, identityShared;
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, wrapped.subarray(32, 44));
        decipher.setAuthTag(wrapped.subarray(-16));
        plain = Buffer.concat([decipher.update(wrapped.subarray(44, -16)), decipher.final()]);
        requireValue(plain.length === 96 && equal(plain.subarray(0, 32), peer) && equal(plain.subarray(32, 64), bare(identity.public)));
        identityShared = pairing.sharedKey(identity.private, peer);
        const input = Buffer.concat([exchange.shared, identityShared, plain.subarray(64)]);
        try {
            return { peer: Buffer.from(peer), secret: pairing.hkdf(input, 32, 'adv_secret') };
        }
        finally {
            input.fill(0);
        }
    }
    catch (_) {
        throw failure('PRIMARY_LINK_KEY_EXCHANGE_INVALID');
    }
    finally {
        key.fill(0);
        if (plain)
            plain.fill(0);
        if (identityShared)
            identityShared.fill(0);
    }
}
function verifyProof(proof, transaction, identity, ownPhone, ownLid) {
    requireValue(proof && typeof proof === 'object');
    const details = proof.details;
    const fields = decode('identity', details), state = validateState(transaction.state);
    requireValue(fields[1] === state.rawId && fields[2] === state.timestamp && fields[3] === state.currentIndex && (fields[4] || 0) === 0 && (fields[5] || 0) === 0);
    const peer = bytes(Buffer.from(transaction.peer, 'base64'), 32), own = bare(identity.public);
    requireValue(equal(bytes(proof.accountSignatureKey, 32), own));
    const device = parseDevice(proof.jid, ownPhone, ownLid);
    const lidDevice = parseDevice(proof.lid, ownPhone, ownLid);
    requireValue(device.id === lidDevice.id && jid(proof.jid).endsWith('@s.whatsapp.net') && jid(proof.lid).endsWith('@lid'));
    requireValue(curve.verify(own, Buffer.concat([Buffer.from([6, 0]), details, peer]), bytes(proof.accountSignature, 64)));
    requireValue(curve.verify(peer, Buffer.concat([Buffer.from([6, 1]), details, peer, own]), bytes(proof.deviceSignature, 64)));
    return device;
}
module.exports = { failure, requireValue, bytes, equal, bare, child, optionalChild, payload, reference, jid, parseDevice, number, code, decode, encode, validateState, reserveState, makeADV, primaryPairNode, primaryHello, primaryFinish, verifyProof };
