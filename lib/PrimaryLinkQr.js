'use strict';
const C = require('./PrimaryLinkCrypto');

// The QR transports a one-time secret as well as public keys. Parse it only
// locally: never put the raw string or this result in events, logs or journals.
function parseCompanionQr(input) {
    C.requireValue(typeof input === 'string' && input.length <= 4096, 'PRIMARY_LINK_QR_INVALID');
    let raw = input.trim();
    if (/^https?:\/\//i.test(raw)) {
        let url;
        try { url = new URL(raw); } catch (_) { throw C.failure('PRIMARY_LINK_QR_INVALID'); }
        C.requireValue(['http:', 'https:'].includes(url.protocol) && url.hostname === 'wa.me' &&
            !url.username && !url.password && !url.port && !url.search &&
            url.pathname === '/settings/linked_devices' && url.hash.length > 1, 'PRIMARY_LINK_QR_INVALID');
        raw = url.hash.slice(1);
    }
    const parts = raw.split(',');
    C.requireValue(parts.length === 4 || parts.length === 5, 'PRIMARY_LINK_QR_INVALID');
    const ref = Buffer.from(parts[0], 'utf8');
    C.requireValue(ref.length > 0 && ref.length <= 256 && /^[\x21-\x7e]+$/.test(parts[0]), 'PRIMARY_LINK_QR_INVALID');
    function key(text) {
        C.requireValue(/^[A-Za-z0-9+/]{43}=?$/.test(text), 'PRIMARY_LINK_QR_INVALID');
        const value = Buffer.from(text, 'base64');
        C.requireValue(value.length === 32 && value.toString('base64').replace(/=$/, '') === text.replace(/=$/, ''), 'PRIMARY_LINK_QR_INVALID');
        return value;
    }
    let platformId = null;
    if (parts.length === 5 && parts[4] !== '') {
        C.requireValue(/^(0|[1-9]\d{0,2})$/.test(parts[4]) && Number(parts[4]) <= 255, 'PRIMARY_LINK_QR_INVALID');
        platformId = Number(parts[4]);
    }
    return { ref, noise: key(parts[1]), peer: key(parts[2]), secret: key(parts[3]), platformId };
}

module.exports = { parseCompanionQr };
