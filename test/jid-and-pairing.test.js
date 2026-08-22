'use strict';

// JID normalisation, message ids, and the pairing-code primitives. The pairing
// code is a password rather than an identifier, so its alphabet and length are
// what the 32^8 search space rests on.

const test   = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { makeJid, generateMessageId } = require('../lib/messages/MessageSender');
const {
  CROCKFORD_CHARACTERS, bytesToCrockford, generatePairingCode,
  derivePairingCodeKey, aesEncryptCTR, aesDecryptCTR
} = require('../lib/PairingCode');

// ── makeJid ─────────────────────────────────────────────────────────────────

test('bare digits become a contact JID', () => {
  assert.equal(makeJid('919634847671'), '919634847671@s.whatsapp.net');
});

test('punctuation and spacing in a number are stripped', () => {
  assert.equal(makeJid('+91 963-484 7671'), '919634847671@s.whatsapp.net');
  assert.equal(makeJid('(91) 9634847671'), '919634847671@s.whatsapp.net');
});

test('anything already carrying an @ is left exactly as it is', () => {
  // Group, LID, newsletter and broadcast addresses must survive untouched —
  // stripping non-digits from a group JID would destroy it.
  for (const jid of [
    '120363000000000000@g.us',
    '112713111982325@lid',
    '120363000000000004@newsletter',
    'status@broadcast',
    '919634847671:7@s.whatsapp.net'
  ]) {
    assert.equal(makeJid(jid), jid);
  }
});

test('a different server can be asked for', () => {
  assert.equal(makeJid('120363000000000000', 'g.us'), '120363000000000000@g.us');
});

test('a number given as a number, not a string, still works', () => {
  assert.equal(makeJid(919634847671), '919634847671@s.whatsapp.net');
});

// ── generateMessageId ───────────────────────────────────────────────────────

test('message ids are 16 uppercase hex characters', () => {
  const id = generateMessageId();
  assert.match(id, /^[0-9A-F]{16}$/);
});

test('message ids do not repeat', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) seen.add(generateMessageId());
  assert.equal(seen.size, 2000, 'every id in a batch is distinct');
});

// ── pairing code ────────────────────────────────────────────────────────────

test('the Crockford alphabet has 32 characters and excludes the confusable ones', () => {
  assert.equal(CROCKFORD_CHARACTERS.length, 32);
  assert.equal(new Set(CROCKFORD_CHARACTERS).size, 32, 'no duplicates');
  // 0/O, 1/I and U are left out so a code read aloud or off a screen is not
  // ambiguous.
  for (const ch of ['0', 'O', 'I', 'U']) {
    assert.equal(CROCKFORD_CHARACTERS.includes(ch), false, `${ch} must not be in the alphabet`);
  }
});

test('a pairing code is exactly 8 characters from that alphabet', () => {
  for (let i = 0; i < 200; i++) {
    const code = generatePairingCode();
    assert.equal(code.length, 8, 'the phone expects exactly 8');
    for (const ch of code) {
      assert.ok(CROCKFORD_CHARACTERS.includes(ch), `unexpected character ${ch} in ${code}`);
    }
  }
});

test('pairing codes are not predictable', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(generatePairingCode());
  assert.ok(seen.size > 495, `expected near-total uniqueness, got ${seen.size}/500`);
});

test('bytesToCrockford turns 5 bytes into 8 characters', () => {
  // 40 bits / 5 bits per character = 8 characters, with nothing left over.
  assert.equal(bytesToCrockford(Buffer.alloc(5)).length, 8);
  assert.equal(bytesToCrockford(Buffer.alloc(5)), CROCKFORD_CHARACTERS[0].repeat(8));
  assert.equal(bytesToCrockford(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff])).length, 8);
});

test('the same code and salt always derive the same key', async () => {
  const salt = crypto.randomBytes(32);
  const a = await derivePairingCodeKey('K7M2QX4B', salt);
  const b = await derivePairingCodeKey('K7M2QX4B', salt);
  assert.equal(a.length, 32);
  assert.equal(a.toString('hex'), b.toString('hex'));
});

test('a different code, or a different salt, derives a different key', async () => {
  const salt  = crypto.randomBytes(32);
  const base  = await derivePairingCodeKey('K7M2QX4B', salt);
  const other = await derivePairingCodeKey('K7M2QX4C', salt);
  const reSalted = await derivePairingCodeKey('K7M2QX4B', crypto.randomBytes(32));

  assert.notEqual(base.toString('hex'), other.toString('hex'));
  assert.notEqual(base.toString('hex'), reSalted.toString('hex'));
});

test('AES-CTR round-trips the bytes it is given', () => {
  const key = crypto.randomBytes(32);
  const iv  = crypto.randomBytes(16);
  const plaintext = crypto.randomBytes(64);

  const ct = aesEncryptCTR(plaintext, key, iv);
  assert.notEqual(ct.toString('hex'), plaintext.toString('hex'));
  assert.equal(aesDecryptCTR(ct, key, iv).toString('hex'), plaintext.toString('hex'));
});
