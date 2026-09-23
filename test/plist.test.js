'use strict';

// Property lists — the encoding both halves of the APNs handshake speak.
//
// Two things have to hold. The writer has to produce a document Apple's parser
// accepts, which here means the shape is pinned rather than merely round-trips.
// And the reader has to handle the binary encoding, because the /bag response
// nests a binary plist inside an XML one and the courier hostname is on the
// inside.

const test   = require('node:test');
const assert = require('node:assert/strict');

const plist = require('../lib/plist');

// ─── the writer ──────────────────────────────────────────────────────────────

test('the writer emits the preamble Apple expects', () => {
  const xml = plist.writeXml({ a: 1 }).toString('utf8');
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n'), 'the declaration is first');
  assert.ok(xml.includes('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"'), 'the doctype is Apple\'s');
  assert.ok(xml.includes('<plist version="1.0">'), 'the root is versioned');
  assert.ok(xml.trimEnd().endsWith('</plist>'), 'and closed');
});

test('each type is written as its own element', () => {
  const xml = plist.writeXml({
    flag:   true,
    off:    false,
    count:  42,
    ratio:  1.5,
    text:   'hello',
    blob:   Buffer.from('hi'),
    when:   new Date('2024-01-02T03:04:05.678Z'),
    items:  ['a'],
    nested: { b: 2 }
  }).toString('utf8');

  assert.ok(xml.includes('<key>flag</key>\n\t<true/>'), 'booleans are empty elements');
  assert.ok(xml.includes('<false/>'), 'and so is false');
  assert.ok(xml.includes('<integer>42</integer>'), 'whole numbers are integers');
  assert.ok(xml.includes('<real>1.5</real>'), 'fractional ones are reals');
  assert.ok(xml.includes('<string>hello</string>'), 'strings are strings');
  assert.ok(xml.includes('<data>aGk=</data>'), 'a Buffer is data, base64 on one line');
  // The plist date grammar has no fractional part.
  assert.ok(xml.includes('<date>2024-01-02T03:04:05Z</date>'), 'dates lose their milliseconds');
  assert.ok(xml.includes('<array>'), 'arrays are arrays');
  assert.ok(xml.includes('<dict>'), 'and dictionaries nest');
});

test('a value that could close a tag early is escaped', () => {
  const xml = plist.writeXml({ 'a&b': '</string><key>x</key><string>y' }).toString('utf8');
  assert.ok(!xml.includes('</string><key>x</key>'), 'the payload cannot close its own element');
  assert.ok(xml.includes('<key>a&amp;b</key>'), 'and the key is escaped too');
  assert.deepEqual(plist.parse(xml), { 'a&b': '</string><key>x</key><string>y' });
});

test('empty containers are written as empty elements', () => {
  const xml = plist.writeXml({ nothing: {}, none: [] }).toString('utf8');
  assert.ok(xml.includes('<dict/>'), 'an empty dict');
  assert.ok(xml.includes('<array/>'), 'an empty array');
  assert.deepEqual(plist.parse(xml), { nothing: {}, none: [] });
});

test('key order survives the round trip', () => {
  // The activation body is signed over its own bytes, so a writer that
  // reordered keys would produce a document whose signature covers something
  // else on the next call.
  const source = { z: 1, a: 2, m: 3 };
  assert.deepEqual(Object.keys(plist.parse(plist.writeXml(source))), ['z', 'a', 'm']);
});

test('a value the format has no element for is refused, not guessed', () => {
  assert.throws(() => plist.writeXml({ fn: () => {} }), /cannot serialise/);
});

// ─── the reader ──────────────────────────────────────────────────────────────

test('entities, comments and whitespace in base64 are all read', () => {
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <!-- albert puts one of these in the response -->',
    '  <key>text</key>',
    '  <string>a &amp; b &lt; c &#65;</string>',
    '  <key>blob</key>',
    '  <data>',
    '  aGVsbG8g',
    '  d29ybGQ=',
    '  </data>',
    '</dict>',
    '</plist>'
  ].join('\n');

  const parsed = plist.parse(xml);
  assert.equal(parsed.text, 'a & b < c A');
  assert.equal(parsed.blob.toString('utf8'), 'hello world');
});

test('the activation response shape is reachable by plain property access', () => {
  // The record albert answers with, trimmed to the path lib/apns reads.
  const xml = plist.writeXml({
    'device-activation': {
      'activation-record': { DeviceCertificate: Buffer.from('CERT') }
    }
  });
  const record = plist.parse(xml);
  assert.equal(
    record['device-activation']['activation-record'].DeviceCertificate.toString('utf8'),
    'CERT');
});

// ─── the binary encoding ─────────────────────────────────────────────────────

// A hand-built bplist00: { "n": 1, "s": "hi" }. Written out rather than
// generated so the test would notice a reader that agrees with a broken writer.
const BINARY_FIXTURE = Buffer.from([
  0x62, 0x70, 0x6c, 0x69, 0x73, 0x74, 0x30, 0x30,  // bplist00
  0xd2,                                            // dict, 2 entries
  0x01, 0x02, 0x03, 0x04,                          // key refs 1,2 / value refs 3,4
  0x51, 0x6e,                                      // ASCII "n"
  0x51, 0x73,                                      // ASCII "s"
  0x10, 0x01,                                      // integer 1, one byte
  0x52, 0x68, 0x69,                                // ASCII "hi"
  // offset table: the five objects above
  0x08, 0x0d, 0x0f, 0x11, 0x13,
  // trailer: 6 unused, offsetSize 1, refSize 1, 5 objects, root 0, table at 0x16
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x01,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16
]);

test('a binary plist is recognised by its magic and read', () => {
  assert.equal(plist.isBinary(BINARY_FIXTURE), true);
  assert.equal(plist.isBinary(Buffer.from('<?xml version="1.0"?>')), false);
  assert.deepEqual(plist.parse(BINARY_FIXTURE), { n: 1, s: 'hi' });
});

test('parse picks the encoding from the bytes, not from the caller', () => {
  // This is the case that makes it matter: the bag is XML on the outside and
  // binary on the inside, and both go through the same call.
  const outer = plist.writeXml({ bag: BINARY_FIXTURE, signature: Buffer.from('sig') });
  const bag = plist.parse(outer);
  assert.ok(Buffer.isBuffer(bag.bag), 'the inner document arrives as data');
  assert.deepEqual(plist.parse(bag.bag), { n: 1, s: 'hi' });
});

test('a truncated binary plist is refused rather than read as garbage', () => {
  assert.throws(() => plist.parse(BINARY_FIXTURE.subarray(0, 20)), /plist/);
});
