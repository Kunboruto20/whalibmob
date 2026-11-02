'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { parseCompanionQr } = require('../lib/PrimaryLinkQr');
const { buildQrData } = require('../lib/QrPairing');

function qrFields() {
    return ['3@owned-companion#reference', ...Array.from({ length: 3 }, () => crypto.randomBytes(32).toString('base64')), '1'];
}

test('primary QR parser consumes the existing companion QR producer, including wa.me wrapping', () => {
    const f = qrFields();
    for (const opts of [undefined, { wrap: true }]) {
        const qr = buildQrData(...f.slice(0, 4), ['Mac OS', 'Chrome', '1.0'], opts);
        const parsed = parseCompanionQr(qr);
        assert.equal(parsed.ref.toString(), f[0]);
        assert.deepEqual(parsed.noise, Buffer.from(f[1], 'base64'));
        assert.deepEqual(parsed.peer, Buffer.from(f[2], 'base64'));
        assert.deepEqual(parsed.secret, Buffer.from(f[3], 'base64'));
    }
});

test('QR parser accepts canonical padded or unpadded keys, and optional platform', () => {
    const f = qrFields();
    for (const parts of [f, f.slice(0, 4), [...f.slice(0, 4), ''], f.map((v, i) => i > 0 && i < 4 ? v.replace(/=$/, '') : v)]) {
        assert.equal(parseCompanionQr(parts.join(',')).secret.length, 32);
    }
});

test('QR parser rejects malformed, ambiguous or oversized fields without echoing the input', () => {
    const f = qrFields(), raw = f.join(',');
    const bad = [null, {}, '', 'x'.repeat(4097), 'one,two', [...f, 'extra'].join(','),
        ['', ...f.slice(1)].join(','), ['x'.repeat(257), ...f.slice(1)].join(','),
        ['ref\nnewline', ...f.slice(1)].join(','), [...f.slice(0, 4), '1junk'].join(','),
        [...f.slice(0, 4), '256'].join(','), [...f.slice(0, 4), '-1'].join(',')];
    for (let i = 1; i <= 3; i++) {
        for (const value of [f[i] + '!', Buffer.alloc(31).toString('base64'), f[i].slice(0, 42) + 'B=']) {
            const parts = f.slice(); parts[i] = value; bad.push(parts.join(','));
        }
    }
    for (const input of bad) assert.throws(() => parseCompanionQr(input), { code: 'PRIMARY_LINK_QR_INVALID', message: 'PRIMARY_LINK_QR_INVALID' });
    assert.equal(parseCompanionQr('  ' + raw + '  ').ref.toString(), f[0]);
});

test('QR URL parser only accepts the exact linked-devices wa.me location', () => {
    const raw = qrFields().join(',');
    assert.equal(parseCompanionQr('http://wa.me/settings/linked_devices#' + raw).secret.length, 32);
    for (const prefix of ['https://foreign.invalid/settings/linked_devices#', 'https://wa.me.evil.invalid/settings/linked_devices#',
        'https://owner@wa.me/settings/linked_devices#', 'https://wa.me:8443/settings/linked_devices#',
        'https://wa.me/other#', 'https://wa.me/settings/linked_devices?x=1#', 'https://wa.me/settings/linked_devices/#']) {
        assert.throws(() => parseCompanionQr(prefix + raw), { code: 'PRIMARY_LINK_QR_INVALID' });
    }
});
