'use strict';

// Independent mobile contract: target APK DlL/K88/L8m/Kll, exported in the
// separate email audit. These fixtures contain no account, inbox or live OTP.
const test = require('node:test');
const assert = require('node:assert/strict');
const { WhalibmobClient } = require('../lib/Client');
const { BinaryNode, encodeNode, decodeNode } = require('../lib/BinaryNode');

const text = (tag, value) => new BinaryNode(tag, {}, Buffer.from(value));
const result = (request, content = []) => new BinaryNode('iq', {
  id: request.attrs.id, type: 'result', from: { user: null, server: 's.whatsapp.net' }
}, content);
const verdict = (request, matched = 'true', wait = '0') => result(request, [
  new BinaryNode('verify_email', {}, [text('code_match', matched), text('wait_time', wait)])
]);

function fixture(answer) {
  let serial = 0;
  const sent = [];
  const c = Object.assign(Object.create(WhalibmobClient.prototype), {
    _connected: true, _mode: 'mobile', _pendingIqs: new Map(), _pendingAcks: new Map(),
    _genMsgId: () => 'EMAIL' + (++serial),
    _stopTimers() {}, _scheduleReconnect() {},
    _socket: { sendNode(node) {
      sent.push(node);
      const response = answer && answer(node);
      if (response) queueMicrotask(() => c._onNode(response));
    } }
  });
  c.sent = sent;
  return c;
}

test('CLI context and UI default produce the same bind payload, without a context child', async () => {
  const c = fixture(n => result(n, [new BinaryNode('email', { do_verify: 'true' }, [])]));
  await c.setEmail('owner@example.invalid', { context: 'settings' });
  await c.setEmail('owner@example.invalid');
  for (const n of c.sent) {
    assert.equal(n.attrs.type, 'set');
    assert.equal(n.attrs.xmlns, 'urn:xmpp:whatsapp:account');
    assert.equal(n.content.length, 1);
    const email = n.content[0];
    assert.equal(email.description, 'email');
    assert.deepEqual(email.content.map(x => x.description), ['email_address']);
    assert.equal(email.content[0].content.toString(), 'owner@example.invalid');
  }
  assert.deepEqual(encodeNode(c.sent[0].content[0]), encodeNode(c.sent[1].content[0]));
});

test('OTP verification is a GET, preserves leading zeroes and parses code_match', async () => {
  const c = fixture(n => verdict(n));
  const v = await c.verifyEmailCode('000 123');
  assert.equal(c.sent.length, 1);
  const n = decodeNode(encodeNode(c.sent[0]));
  assert.equal(n.attrs.type, 'get');
  assert.equal(n.content[0].description, 'verify_email');
  assert.equal(n.content[0].content[0].description, 'code');
  assert.equal(n.content[0].content[0].content.toString(), '000123');
  assert.deepEqual(v, { verified: true, autoVerifyFailed: false, email: null, waitTimeSeconds: 0 });
});

test('a false code_match is a definite negative verdict with its server wait', async () => {
  const c = fixture(n => verdict(n, 'false', '75'));
  assert.deepEqual(await c.verifyEmailCode('000123'), {
    verified: false, autoVerifyFailed: false, email: null, waitTimeSeconds: 75
  });
  assert.equal(c.sent.length, 1, 'no automatic request or confirmation');
});

for (const bad of ['yes', '', 'TRUE']) {
  test('unknown code_match is an uncertain result, not a false/success verdict: ' + JSON.stringify(bad), async () => {
    const c = fixture(n => verdict(n, bad));
    await assert.rejects(c.verifyEmailCode('000123'), { code: 'EMAIL_IQ_UNCERTAIN', outcomeUnknown: true });
    assert.equal(c.sent.length, 1);
  });
}

test('bind do_verify is not mistaken for the OTP verdict', async () => {
  const c = fixture(n => result(n, [new BinaryNode('email', { do_verify: 'true' }, [])]));
  await assert.rejects(c.verifyEmailCode('000123'), { code: 'EMAIL_IQ_UNCERTAIN' });
});

test('missing verification child is not reported as an incorrect code', async () => {
  const c = fixture(n => result(n));
  await assert.rejects(c.verifyEmailCode('000123'), { code: 'EMAIL_IQ_UNCERTAIN' });
});

for (const context of [undefined, 'settings', 'onboarding']) {
  test('confirm always includes its context: ' + context, async () => {
    const c = fixture(n => result(n));
    assert.equal(await c.confirmEmail(context === undefined ? undefined : { context }), true);
    const n = c.sent[0];
    assert.equal(n.attrs.type, 'set');
    assert.equal(n.content[0].description, 'confirm_email');
    assert.equal(n.content[0].content[0].description, 'context');
    assert.equal(n.content[0].content[0].content.toString(), context || 'settings');
  });
}

test('invalid confirmation context is rejected before a send', async () => {
  const c = fixture();
  await assert.rejects(c.confirmEmail({ context: 'unexpected' }), /context must/);
  assert.equal(c.sent.length, 0);
});

test('requestEmailCode is the distinct SET language request', async () => {
  const c = fixture(n => result(n, [new BinaryNode('verify_email', {}, [text('wait_time', '60')])]));
  assert.equal(await c.requestEmailCode({ lg: 'tr', lc: 'TR' }), true);
  const n = c.sent[0];
  assert.equal(n.attrs.type, 'set');
  assert.equal(n.content[0].description, 'verify_email');
  assert.deepEqual(n.content[0].content.map(x => [x.description, x.content.toString()]), [['lg', 'tr'], ['lc', 'TR']]);
  assert.equal(c.sent.length, 1);
});

test('email status reads the verified element independently of verification and confirm', async () => {
  const c = fixture(n => result(n, [new BinaryNode('email', {}, [
    text('email_address', 'owner@example.invalid'), text('verified', 'true'), text('confirmed', 'false')
  ])]));
  assert.deepEqual(await c.getEmailStatus(), { email: 'owner@example.invalid', verified: true, confirmed: false });
  assert.equal(c.sent[0].attrs.type, 'get');
});

test('an explicit verified=false child overrides a legacy verified=true attribute', async () => {
  const c = fixture(n => result(n, [new BinaryNode('email', { verified: 'true' }, [text('verified', 'false')])]));
  assert.equal((await c.getEmailStatus()).verified, false);
});

test('legacy status attributes remain readable when the element is absent', async () => {
  const c = fixture(n => result(n, [new BinaryNode('email', { verified: 'true' }, [])]));
  assert.equal((await c.getEmailStatus()).verified, true);
});

test('a healthy ping and a late matching response resolve the email beyond the old15s deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const c = fixture();
  let settled = false;
  const pending = c.setEmail('owner@example.invalid').then(x => { settled = true; return x; });
  t.mock.timers.tick(15001);
  c._onNode(new BinaryNode('iq', { id: 'UNRELATED-PING', type: 'result' }, null));
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(5000);
  c._onNode(result(c.sent[0], [new BinaryNode('email', { verified: 'false' }, [])]));
  await pending;
  assert.equal(c._pendingIqs.size, 0);
  assert.equal(c.sent.length, 1, 'no mutation replay');
});

test('an unanswered bind times out at32s as unknown and is never repeated', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const c = fixture();
  const checked = assert.rejects(c.setEmail('owner@example.invalid'), error => {
    assert.equal(error.code, 'EMAIL_IQ_TIMEOUT');
    assert.equal(error.operation, 'setEmail');
    assert.equal(error.outcomeUnknown, true);
    assert.doesNotMatch(error.message, /owner@/);
    return true;
  });
  t.mock.timers.tick(32000);
  await checked;
  assert.equal(c._pendingIqs.size, 0);
  assert.equal(c.sent.length, 1);
});

test('disconnect is distinguished from a deadline and releases the pending request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const c = fixture();
  const checked = assert.rejects(c.confirmEmail(), { code: 'EMAIL_IQ_DISCONNECTED', outcomeUnknown: true });
  c._onClose();
  await checked;
  assert.equal(c._pendingIqs.size, 0);
  t.mock.timers.tick(32000);
  assert.equal(c.sent.length, 1);
});

test('legacy non-email IQ callers retain15s and null on disconnect/timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const c = fixture();
  const timed = c._sendIq(new BinaryNode('iq', { id: 'LEGACY1' }, []));
  t.mock.timers.tick(15000);
  assert.equal(await timed, null);
  const closed = c._sendIq(new BinaryNode('iq', { id: 'LEGACY2' }, []));
  c._onClose();
  assert.equal(await closed, null);
});

for (const code of ['403', '534', '535', '536', '537']) {
  test('a server email refusal remains a refusal: ' + code, async () => {
    const c = fixture(n => new BinaryNode('iq', { id: n.attrs.id, type: 'error' }, [
      new BinaryNode('error', { code }, [])
    ]));
    await assert.rejects(c.verifyEmailCode('000123'), new RegExp(code));
    assert.equal(c.sent.length, 1);
  });
}

test('a foreign reply cannot mark the email confirmed', async () => {
  const c = fixture(n => new BinaryNode('iq', { id: n.attrs.id, type: 'result', from: { user: null, server: 'foreign.invalid' } }, []));
  await assert.rejects(c.confirmEmail(), { code: 'EMAIL_IQ_UNCERTAIN' });
});

test('local validation prevents mail, OTP and companion requests before sending', async () => {
  const c = fixture();
  await assert.rejects(c.setEmail(''), /email must/);
  await assert.rejects(c.verifyEmailCode('12345'), /six|6 digits/);
  c._mode = 'web';
  await assert.rejects(c.confirmEmail(), /primary-account feature/);
  assert.equal(c.sent.length, 0);
});
