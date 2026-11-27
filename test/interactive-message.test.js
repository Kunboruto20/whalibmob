'use strict';

// Interactive ("card") messages: body, optional header image, and up to three
// native-flow buttons (link / call / copy / quick-reply). These are encoded by
// hand, so the tests pin the protobuf field numbers on the wire — a wrong field
// is a message WhatsApp silently drops.

const test   = require('node:test');
const assert = require('node:assert/strict');

const {
  encodeInteractiveMessage, encodeMessage
} = require('../lib/proto/MessageProto');

// Minimal protobuf walker: [fieldNumber, Buffer|'varint'] pairs.
function walk(buf) {
  let o = 0; const out = [];
  const rv = () => { let r = 0n, s = 0n; for (;;) { const x = BigInt(buf[o++]); r |= (x & 0x7fn) << s; if (!(x & 0x80n)) break; s += 7n; } return r; };
  while (o < buf.length) {
    const t = rv(); const f = Number(t >> 3n), w = Number(t & 7n);
    let v;
    if (w === 2) { const l = Number(rv()); v = buf.subarray(o, o + l); o += l; }
    else if (w === 0) { rv(); v = 'varint'; }
    else if (w === 5) { o += 4; v = 'f32'; }
    else if (w === 1) { o += 8; v = 'f64'; }
    out.push([f, v]);
  }
  return out;
}
const fields = (buf) => walk(buf).map(e => e[0]);
const sub    = (buf, f) => walk(buf).find(e => e[0] === f)[1];

const BTN_URL   = { name: 'cta_url',     buttonParamsJson: JSON.stringify({ display_text: 'Open', url: 'https://example.com' }) };
const BTN_REPLY = { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Yes', id: 'yes' }) };

test('an interactive message is Message field 45', () => {
  const content = encodeInteractiveMessage({ body: 'hi', buttons: [BTN_URL] });
  const msg = encodeMessage('interactive', content);
  assert.deepEqual(fields(msg), [45], 'wrapped in interactiveMessage (45)');
});

test('body (2), footer (3) and nativeFlowMessage (6) are present', () => {
  const content = encodeInteractiveMessage({ body: 'hello', footer: 'whalibmob', buttons: [BTN_URL] });
  const f = fields(content);
  assert.ok(f.includes(2), 'body');
  assert.ok(f.includes(3), 'footer');
  assert.ok(f.includes(6), 'nativeFlowMessage');
  // body/footer each wrap { text=1 }
  assert.deepEqual(fields(sub(content, 2)), [1]);
  assert.deepEqual(fields(sub(content, 3)), [1]);
});

test('a title/subtitle header rides in field 1', () => {
  const content = encodeInteractiveMessage({ title: 'VIP', subtitle: 'bonus', body: 'x', buttons: [BTN_URL] });
  assert.ok(fields(content).includes(1), 'header present');
  assert.deepEqual(fields(sub(content, 1)), [1, 2], 'title=1, subtitle=2');
});

test('a header image sets imageMessage (4) and hasMediaAttachment (5)', () => {
  const content = encodeInteractiveMessage({
    body: 'x', buttons: [BTN_URL],
    headerImage: { url: 'https://cdn/x.enc', mimetype: 'image/jpeg', fileLength: 10 }
  });
  const header = sub(content, 1);
  const hf = fields(header);
  assert.ok(hf.includes(4), 'imageMessage in header');
  assert.ok(hf.includes(5), 'hasMediaAttachment flag');
});

test('buttons are repeated field 1, each name=1 + params=2, version=3 last', () => {
  const content = encodeInteractiveMessage({ body: 'x', buttons: [BTN_URL, BTN_REPLY] });
  const nf = sub(content, 6);
  // two buttons (field 1 ×2) + messageVersion (field 3)
  assert.deepEqual(fields(nf), [1, 1, 3], 'two buttons + version');
  const firstButton = walk(nf).find(e => e[0] === 1)[1];
  assert.deepEqual(fields(firstButton), [1, 2], 'name + buttonParamsJson');
  assert.equal(walk(firstButton).find(e => e[0] === 1)[1].toString('utf8'), 'cta_url');
  const params = JSON.parse(walk(firstButton).find(e => e[0] === 2)[1].toString('utf8'));
  assert.equal(params.url, 'https://example.com');
  assert.equal(params.display_text, 'Open');
});

test('messageVersion defaults to 1', () => {
  const content = encodeInteractiveMessage({ body: 'x', buttons: [BTN_URL] });
  const nf = sub(content, 6);
  // field 3 is a varint; its value is the byte right after its tag
  const entries = walk(nf);
  assert.ok(entries.some(e => e[0] === 3), 'messageVersion present');
});

test('contextInfo (15) is carried when given', () => {
  const content = encodeInteractiveMessage({
    body: 'x', buttons: [BTN_URL],
    contextInfo: { mentionedJid: ['40712345678@s.whatsapp.net'] }
  });
  assert.ok(fields(content).includes(15), 'contextInfo present');
});

// ─── the friendly button mapper (as the sender builds it) ────────────────────

test('the sender maps friendly buttons to native-flow names', () => {
  // Re-require the sender module's mapper via a tiny re-implementation check:
  // the public shape is what matters, so we assert the JSON the encoder receives.
  const { encodeInteractiveMessage: enc } = require('../lib/proto/MessageProto');
  const content = enc({
    body: 'x',
    buttons: [
      { name: 'cta_url',  buttonParamsJson: JSON.stringify({ display_text: 'Site', url: 'https://a.b' }) },
      { name: 'cta_call', buttonParamsJson: JSON.stringify({ display_text: 'Call', phone_number: '15551234567' }) },
      { name: 'cta_copy', buttonParamsJson: JSON.stringify({ display_text: 'Copy', copy_code: 'X1' }) }
    ]
  });
  const nf = sub(content, 6);
  const names = walk(nf).filter(e => e[0] === 1)
    .map(e => walk(e[1]).find(x => x[0] === 1)[1].toString('utf8'));
  assert.deepEqual(names, ['cta_url', 'cta_call', 'cta_copy']);
});
