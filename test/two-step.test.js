'use strict';

// Two-step verification.
//
// The wire format here is inferred rather than copied from a reference client —
// no open-source implementation has it. That makes these tests worth more than
// usual, not less: they pin down exactly what goes on the wire, so when the real
// format is confirmed the diff is one edit and the tests say what changed.
//
// They also cover the half that is certain regardless of the stanza's shape: a
// PIN that is not six digits must never reach the server, because a number whose
// PIN is wrong cannot be registered for seven days.

const test   = require('node:test');
const assert = require('node:assert/strict');

const { WhalibmobClient } = require('../lib/Client');
const { BinaryNode }      = require('../lib/BinaryNode');

// A client with the socket stubbed. _sendIq is replaced by a recorder that
// answers with whatever `reply` says, so the whole path runs without a network.
function client(reply) {
  const sent = [];
  const c = Object.assign(Object.create(WhalibmobClient.prototype), {
    _connected: true,
    _socket: {},
    _genMsgId: () => 'IQ1',
    _sendIq: async (node) => { sent.push(node); return reply === undefined ? okReply() : reply; }
  });
  c.sent = sent;
  return c;
}

const okReply    = () => new BinaryNode('iq', { type: 'result', id: 'IQ1' }, null);
const errorReply = (code, text) => new BinaryNode('iq', { type: 'error', id: 'IQ1' }, [
  new BinaryNode('error', text ? { code, text } : { code }, null)
]);

const textOf = (n) => (n && n.content ? Buffer.from(n.content).toString('utf8') : '');

// ─── what actually goes on the wire ──────────────────────────────────────────

test('setTwoStep sends the PIN under urn:xmpp:whatsapp:account', async () => {
  const c = client();
  await c.setTwoStep('123456');

  assert.equal(c.sent.length, 1);
  const [iq] = c.sent;
  assert.equal(iq.description, 'iq');
  assert.equal(iq.attrs.xmlns, 'urn:xmpp:whatsapp:account');
  assert.equal(iq.attrs.type, 'set');
  assert.equal(iq.attrs.to, 's.whatsapp.net');

  const twoFa = iq.content[0];
  assert.equal(twoFa.description, '2fa');
  assert.equal(twoFa.content.length, 1, 'no email means no email node');
  assert.equal(twoFa.content[0].description, 'code');
  assert.equal(textOf(twoFa.content[0]), '123456');
});

test('an email is carried beside the PIN, in that order', async () => {
  const c = client();
  await c.setTwoStep('654321', 'recovery@example.com');

  const twoFa = c.sent[0].content[0];
  assert.equal(twoFa.content.length, 2);
  assert.equal(twoFa.content[0].description, 'code');
  assert.equal(twoFa.content[1].description, 'email');
  assert.equal(textOf(twoFa.content[1]), 'recovery@example.com');
});

test('removeTwoStep sends an empty code rather than a verb of its own', async () => {
  const c = client();
  await c.removeTwoStep();

  const twoFa = c.sent[0].content[0];
  assert.equal(c.sent[0].attrs.type, 'set');
  assert.equal(twoFa.content.length, 1);
  assert.equal(twoFa.content[0].description, 'code');
  assert.equal(twoFa.content[0].content, null, 'empty is what clears it');
});

test('queryTwoStep asks rather than sets', async () => {
  const c = client(okReply());
  await c.queryTwoStep();

  const [iq] = c.sent;
  assert.equal(iq.attrs.type, 'get', 'a read must never be a write');
  assert.equal(iq.attrs.xmlns, 'urn:xmpp:whatsapp:account');
  assert.equal(iq.content[0].description, '2fa');
});

// ─── a bad PIN never reaches the server ──────────────────────────────────────

test('a PIN that is not six digits is refused before anything is sent', async () => {
  for (const bad of ['12345', '1234567', '', null, undefined, 'abcdef', '12 34 56', '12345a']) {
    const c = client();
    await assert.rejects(() => c.setTwoStep(bad), /six digits/,
      'refused: ' + JSON.stringify(bad));
    assert.equal(c.sent.length, 0, 'and nothing went out for ' + JSON.stringify(bad));
  }
});

test('a six-digit PIN given as a number is accepted', async () => {
  const c = client();
  await c.setTwoStep(123456);
  assert.equal(textOf(c.sent[0].content[0].content[0]), '123456');
});

test('a leading-zero PIN keeps its zero', async () => {
  const c = client();
  await c.setTwoStep('001234');
  assert.equal(textOf(c.sent[0].content[0].content[0]), '001234');
});

test('something that is plainly not an email is refused', async () => {
  const c = client();
  await assert.rejects(() => c.setTwoStep('123456', '40712345678'),
    /does not look like an email/);
  assert.equal(c.sent.length, 0);
});

// ─── the server's answer is reported, never assumed ──────────────────────────

test('a rejection carries the server reply on the error', async () => {
  const c = client(errorReply('400', 'bad-request'));
  await assert.rejects(
    () => c.setTwoStep('123456'),
    (err) => {
      assert.match(err.message, /server rejected the change/);
      assert.match(err.message, /400/);
      assert.equal(err.code, '400');
      assert.ok(err.raw, 'the reply itself is attached');
      assert.match(err.message, /inferred rather than verified/,
        'and says the format is a guess, so a 400 is read correctly');
      return true;
    }
  );
});

test('a timeout is an error, not a silent success', async () => {
  const c = client(null);
  await assert.rejects(() => c.setTwoStep('123456'), /IQ timed out/);
  await assert.rejects(() => c.removeTwoStep(), /IQ timed out/);
});

test('queryTwoStep reports an error instead of throwing', async () => {
  const c = client(errorReply('501'));
  const r = await c.queryTwoStep();
  assert.equal(r.supported, false);
  assert.equal(r.enabled, null);
  assert.match(r.error, /501/);
  assert.ok(r.raw, 'the reply is there to look at');
});

test('queryTwoStep reads an email out of the reply, either shape', async () => {
  const asChild = new BinaryNode('iq', { type: 'result' }, [
    new BinaryNode('2fa', {}, [
      new BinaryNode('email', {}, Buffer.from('a@b.com', 'utf8'))
    ])
  ]);
  const r1 = await client(asChild).queryTwoStep();
  assert.equal(r1.supported, true);
  assert.equal(r1.email, 'a@b.com');

  const asAttr = new BinaryNode('iq', { type: 'result' }, [
    new BinaryNode('2fa', { email: 'c@d.com', enabled: 'true' }, null)
  ]);
  const r2 = await client(asAttr).queryTwoStep();
  assert.equal(r2.email, 'c@d.com');
  assert.equal(r2.enabled, true);
});

test('nothing is attempted while disconnected', async () => {
  const c = client();
  c._connected = false;
  await assert.rejects(() => c.setTwoStep('123456'), /Not connected/);
  await assert.rejects(() => c.removeTwoStep(), /Not connected/);
  assert.equal(c.sent.length, 0);
});

// ─── it is the same stanza on both halves of a number ────────────────────────

test('an SMS session and a companion send the identical stanza', async () => {
  const stanza = async (mode) => {
    const c = client();
    c._mode = mode;
    await c.setTwoStep('112233');
    const iq = c.sent[0];
    return JSON.stringify([iq.attrs.xmlns, iq.attrs.type, iq.attrs.to,
                           iq.content[0].description,
                           textOf(iq.content[0].content[0])]);
  };
  assert.equal(await stanza('mobile'), await stanza('web'),
    'the setting belongs to the account, not to the device');
});

// ─── the probe: telling "not allowed" apart from "not a thing" ───────────────

test('probeTwoStep asks every variant as a read', async () => {
  const asked = [];
  const c = Object.assign(Object.create(WhalibmobClient.prototype), {
    _connected: true, _socket: {}, _genMsgId: () => 'IQ1',
    _sendIq: async (n) => { asked.push(n); return okReply(); }
  });

  const rows = await c.probeTwoStep();
  assert.equal(rows.length, 6);
  assert.equal(asked.length, 6);
  for (const n of asked) {
    assert.equal(n.attrs.type, 'get', 'a probe must never write');
  }
  // the baselines that make the comparison mean anything
  assert.ok(rows.some(r => r.xmlns === 'urn:xmpp:whatsapp:nonexistent'),
    'a namespace that cannot exist');
  assert.ok(rows.some(r => r.xmlns === 'privacy'),
    'and one that certainly does');
});

test('the probe reports each answer separately', async () => {
  const byNs = {
    'urn:xmpp:whatsapp:account':     errorReply('403', 'forbidden'),
    'urn:xmpp:whatsapp:nonexistent': errorReply('400', 'bad-request'),
    'privacy':                       okReply()
  };
  const c = Object.assign(Object.create(WhalibmobClient.prototype), {
    _connected: true, _socket: {}, _genMsgId: () => 'IQ1',
    _sendIq: async (n) => byNs[n.attrs.xmlns]
  });

  const rows = await c.probeTwoStep();
  const ours     = rows.find(r => r.name === 'ours');
  const nonsense = rows.find(r => r.name === 'nonsense ns');
  const known    = rows.find(r => r.name === 'known-good (privacy)');

  assert.equal(ours.code, '403');
  assert.equal(ours.text, 'forbidden');
  assert.equal(nonsense.code, '400', 'a different code is the whole point');
  assert.equal(known.ok, true, 'and the probe itself works');
});

test('the probe survives a timeout on one variant', async () => {
  let n = 0;
  const c = Object.assign(Object.create(WhalibmobClient.prototype), {
    _connected: true, _socket: {}, _genMsgId: () => 'IQ1',
    _sendIq: async () => (++n === 2 ? null : okReply())
  });
  const rows = await c.probeTwoStep();
  assert.equal(rows.length, 6, 'one bad answer does not stop the rest');
  assert.equal(rows[1].ok, false);
  assert.match(rows[1].text, /timed out/);
});
