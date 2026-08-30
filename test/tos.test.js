'use strict';

// Terms-of-Service notices.
//
// The wire shapes are Cobalt's IqQueryTosRequest, IqUpdateTosRequest and
// IqDeleteTosRequest — read off the stanza builders rather than the javadoc,
// which calls the namespace "w:tos" while the code writes "tos".
//
// The one thing worth pinning hardest is the reading of `state`, because it is
// backwards from how it looks: the attribute is present and "false" for a
// notice that has NOT been accepted, and absent for one that has. Reading a
// missing attribute as "unknown" would report every accepted notice as
// outstanding, and a caller acting on that would prompt for something the user
// already agreed to.

const test   = require('node:test');
const assert = require('node:assert/strict');

const { WhalibmobClient } = require('../lib/Client');
const { BinaryNode }      = require('../lib/BinaryNode');

function client(reply) {
  const sent  = [];
  const nodes = [];
  const c = Object.assign(Object.create(WhalibmobClient.prototype), {
    _connected:   true,
    // The notification dispatcher acks what it handles, so a stub that only
    // stands in for _sendIq is not enough to run it.
    _socket:      { sendNode: (n) => nodes.push(n) },
    _tosAccepted: new Map(),
    _genMsgId:    () => 'IQ1',
    _sendIq:      async (node) => { sent.push(node); return reply === undefined ? okReply() : reply; }
  });
  c.sent     = sent;
  c.nodes    = nodes;
  c.emitted  = [];
  c.emit     = (name, payload) => { c.emitted.push({ name, payload }); return true; };
  return c;
}

const okReply = () => new BinaryNode('iq', { type: 'result', id: 'IQ1' }, null);

const tosReply = (attrs, notices) => new BinaryNode('iq', { type: 'result', id: 'IQ1' }, [
  new BinaryNode('tos', attrs, (notices || []).map(n => new BinaryNode('notice', n, null)))
]);

const errorReply = (code) => new BinaryNode('iq', { type: 'error', id: 'IQ1' }, [
  new BinaryNode('error', { code }, null)
]);

// ─── reading ─────────────────────────────────────────────────────────────────

test('the query asks under tos with one notice child per id', async () => {
  const c = client(tosReply({ refresh: '86400' }, []));
  await c.queryTosNotices(['20230324', '20240101']);

  const [iq] = c.sent;
  assert.equal(iq.attrs.xmlns, 'tos');
  assert.equal(iq.attrs.type,  'get');
  assert.equal(iq.attrs.to,    's.whatsapp.net');

  const request = iq.content[0];
  assert.equal(request.description, 'request');
  assert.equal(request.attrs.type, undefined, 'a read carries no request type');
  assert.equal(request.content.length, 2);
  assert.deepEqual(request.content.map(n => n.attrs.id), ['20230324', '20240101']);
});

test('a missing state means accepted; state="false" means outstanding', async () => {
  const c = client(tosReply({ refresh: '86400' }, [
    { id: 'accepted-one' },
    { id: 'outstanding',  state: 'false' },
    { id: 'accepted-two', state: 'true' }
  ]));

  const out = await c.queryTosNotices(['accepted-one', 'outstanding', 'accepted-two']);
  assert.deepEqual(out.notices, [
    { id: 'accepted-one', accepted: true },
    { id: 'outstanding',  accepted: false },
    { id: 'accepted-two', accepted: true }
  ]);
  assert.equal(out.refresh, 86400);
});

test('what the reply said is remembered, and readable per notice', async () => {
  const c = client(tosReply({}, [
    { id: 'a' },
    { id: 'b', state: 'false' }
  ]));
  await c.queryTosNotices(['a', 'b']);

  assert.equal(c.isTosAccepted('a'), true);
  assert.equal(c.isTosAccepted('b'), false);
});

test('a notice never asked about reads null, not false', () => {
  const c = client();
  assert.equal(c.isTosAccepted('never-asked'), null,
    'unknown and not-accepted are different answers');
});

test('a reply with no tos child gives an empty list rather than throwing', async () => {
  const c = client(new BinaryNode('iq', { type: 'result', id: 'IQ1' }, []));
  const out = await c.queryTosNotices(['a']);
  assert.deepEqual(out.notices, []);
  assert.equal(out.refresh, null);
});

test('a notice child with no id is skipped', async () => {
  const c = client(tosReply({}, [{ state: 'false' }, { id: 'real' }]));
  const out = await c.queryTosNotices(['real']);
  assert.deepEqual(out.notices, [{ id: 'real', accepted: true }]);
});

// ─── accepting ───────────────────────────────────────────────────────────────

test('accepting sends type="session_update" on the request child', async () => {
  const c = client();
  await c.acceptTosNotices(['20230324']);

  const [iq] = c.sent;
  assert.equal(iq.attrs.xmlns, 'tos');
  assert.equal(iq.attrs.type,  'set');

  const request = iq.content[0];
  assert.equal(request.description, 'request');
  assert.equal(request.attrs.type, 'session_update');
  assert.equal(request.content[0].attrs.id, '20230324');
});

test('an accepted notice is remembered without re-asking', async () => {
  const c = client();
  await c.acceptTosNotices(['x']);
  assert.equal(c.isTosAccepted('x'), true);
  assert.equal(c.sent.length, 1, 'no follow-up read');
});

test('accepting nothing is refused rather than sent as an empty stanza', async () => {
  const c = client();
  await assert.rejects(() => c.acceptTosNotices([]), /non-empty/);
  assert.equal(c.sent.length, 0);
});

// ─── clearing ────────────────────────────────────────────────────────────────

test('clearing sends a delete child, not a request child', async () => {
  const c = client();
  await c.clearTosNotice('20230324');

  const [iq] = c.sent;
  assert.equal(iq.attrs.type, 'set');
  assert.equal(iq.content[0].description, 'delete');
  assert.equal(iq.content[0].attrs.id, '20230324');
});

test('a cleared notice reads as not accepted', async () => {
  const c = client();
  await c.acceptTosNotices(['x']);
  await c.clearTosNotice('x');
  assert.equal(c.isTosAccepted('x'), false);
});

test('clearing without an id is refused', async () => {
  const c = client();
  await assert.rejects(() => c.clearTosNotice(''), /required/);
  assert.equal(c.sent.length, 0);
});

// ─── the push ────────────────────────────────────────────────────────────────

test('a pushed tos node updates what is known and raises an event', () => {
  const c = client();
  c._handleTosNotification(new BinaryNode('tos', {}, [
    new BinaryNode('notice', { id: 'a' }, null),
    new BinaryNode('notice', { id: 'b', state: 'false' }, null)
  ]));

  assert.equal(c.isTosAccepted('a'), true);
  assert.equal(c.isTosAccepted('b'), false);
  assert.equal(c.emitted.length, 1);
  assert.equal(c.emitted[0].name, 'tos_notices');
  assert.deepEqual(c.emitted[0].payload.notices, [
    { id: 'a', accepted: true },
    { id: 'b', accepted: false }
  ]);
});

test('a push adds to what is known rather than replacing it', () => {
  const c = client();
  c._tosAccepted.set('untouched', true);
  c._handleTosNotification(new BinaryNode('tos', {}, [
    new BinaryNode('notice', { id: 'a', state: 'false' }, null)
  ]));

  assert.equal(c.isTosAccepted('untouched'), true,
    'a push naming one notice says nothing about another');
  assert.equal(c.isTosAccepted('a'), false);
});

test('an empty push changes nothing and raises nothing', () => {
  const c = client();
  c._handleTosNotification(new BinaryNode('tos', {}, []));
  assert.equal(c.emitted.length, 0);
});

// The wiring, not just the handler: a <tos> child arrives inside the same
// account_sync notification that carries device, blocklist and privacy
// changes, so what matters is that the dispatcher actually reaches it.
test('a tos child inside an account_sync notification is routed to the handler', () => {
  const c = client();
  c._handleNotification(new BinaryNode('notification', { type: 'account_sync', from: 's.whatsapp.net' }, [
    new BinaryNode('tos', {}, [
      new BinaryNode('notice', { id: 'pushed', state: 'false' }, null)
    ])
  ]));

  assert.equal(c.isTosAccepted('pushed'), false);
  assert.ok(c.emitted.some(e => e.name === 'tos_notices'),
    'the dispatcher reached _handleTosNotification');
  // Handling it must not cost the ack: an unacked notification is resent.
  assert.ok(c.nodes.some(n => n.description === 'ack' && n.attrs.type === 'account_sync'),
    'the notification was still acked');
});

test('an account_sync notification with no tos child is left alone', () => {
  const c = client();
  c._handleNotification(new BinaryNode('notification', { type: 'account_sync' }, []));
  assert.equal(c.emitted.filter(e => e.name === 'tos_notices').length, 0);
});

// ─── failures ────────────────────────────────────────────────────────────────

test('a timed-out IQ throws on each of the three calls', async () => {
  const c = client(null);
  await assert.rejects(() => c.queryTosNotices(['a']),  /timed out/);
  await assert.rejects(() => c.acceptTosNotices(['a']), /timed out/);
  await assert.rejects(() => c.clearTosNotice('a'),     /timed out/);
});

test('an error reply names the code, and nothing is recorded as accepted', async () => {
  const c = client(errorReply('403'));
  await assert.rejects(() => c.acceptTosNotices(['a']), /403/);
  assert.equal(c.isTosAccepted('a'), null,
    'a rejected acceptance must not be remembered as an acceptance');
});

test('all three refuse to run while disconnected', async () => {
  const c = client();
  c._connected = false;
  await assert.rejects(() => c.queryTosNotices(['a']),  /Not connected/);
  await assert.rejects(() => c.acceptTosNotices(['a']), /Not connected/);
  await assert.rejects(() => c.clearTosNotice('a'),     /Not connected/);
});
