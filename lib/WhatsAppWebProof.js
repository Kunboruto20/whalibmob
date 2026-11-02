'use strict';
const C = require('./PrimaryLinkCrypto');
const KEYS = ['jid', 'lid', 'details', 'accountSignatureKey', 'accountSignature', 'deviceSignature'];
function exact(value, keys) {
  C.requireValue(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k)), 'PRIMARY_LINK_WEB_PROOF_INVALID');
}
// This decoder does not authorize a device. Pass the result to the existing
// approve/reconcile method, which checks both signatures and a fresh own list.
function parseWhatsAppWebPublicProof(input) {
  if (typeof input === 'string') {
    C.requireValue(Buffer.byteLength(input) <= 8192, 'PRIMARY_LINK_WEB_PROOF_INVALID');
    try { input = JSON.parse(input); } catch (_) { throw C.failure('PRIMARY_LINK_WEB_PROOF_INVALID'); }
  }
  exact(input, ['format_version', 'kind', 'proof', 'bootstrap']);
  C.requireValue(input.format_version === 1 && input.kind === 'whatsapp_web_public_binding', 'PRIMARY_LINK_WEB_PROOF_INVALID');
  exact(input.proof, KEYS);
  const p = input.proof;
  C.requireValue(typeof p.jid === 'string' && typeof p.lid === 'string' && p.jid.length <= 80 && p.lid.length <= 80, 'PRIMARY_LINK_WEB_PROOF_INVALID');
  const out = { jid: p.jid, lid: p.lid };
  for (const [key, size] of [['details', 0], ['accountSignatureKey', 32], ['accountSignature', 64], ['deviceSignature', 64]]) {
    C.requireValue(typeof p[key] === 'string' && p[key].length <= 684, 'PRIMARY_LINK_WEB_PROOF_INVALID');
    const b = Buffer.from(p[key], 'base64');
    C.requireValue(b.toString('base64') === p[key] && b.length > 0 && b.length <= 512 && (!size || b.length === size), 'PRIMARY_LINK_WEB_PROOF_INVALID');
    out[key] = b;
  }
  // bootstrap is informational only: it cannot substitute for cryptographic
  // proof or for observing the actual browser become usable.
  return out;
}
module.exports = { parseWhatsAppWebPublicProof };
