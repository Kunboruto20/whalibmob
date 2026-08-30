'use strict';

// AB props — the per-account feature flags the server hands out.
//
// The wire shape here is not inferred: it is the one Cobalt's ABPropsService
// builds and parses, which in turn is adapted from WhatsApp Web's own
// WAGetAbPropsProtocol. What these tests pin down is the half that is easy to
// get subtly wrong and impossible to notice: which attribute goes on the
// request, how a delta merges onto what is already held, and the three
// readings of a value that the wire always spells as a string.

const test   = require('node:test');
const assert = require('node:assert/strict');

const { WhalibmobClient } = require('../lib/Client');
const { BinaryNode }      = require('../lib/BinaryNode');

// A client with the socket stubbed. Object.create skips the constructor, so
// anything the methods read has to be set here — which is itself a check that
// nothing reads state the constructor did not promise.
function client(reply) {
  const sent = [];
  const c = Object.assign(Object.create(WhalibmobClient.prototype), {
    _connected:   true,
    _socket:      {},
    _abProps:     null,
    _abPropsHash: null,
    _genMsgId:    () => 'IQ1',
    _sendIq:      async (node) => { sent.push(node); return reply; }
  });
  c.sent = sent;
  return c;
}

// <iq type=result><props ...><prop .../>...</props></iq>
function propsReply(attrs, props) {
  return new BinaryNode('iq', { type: 'result', id: 'IQ1' }, [
    new BinaryNode('props', attrs, (props || []).map(p => new BinaryNode('prop', p, null)))
  ]);
}

const errorReply = (code) => new BinaryNode('iq', { type: 'error', id: 'IQ1' }, [
  new BinaryNode('error', { code }, null)
]);

// ─── the request ─────────────────────────────────────────────────────────────

test('the first sync asks under abt with protocol=1 and no hash', async () => {
  const c = client(propsReply({ hash: 'H1' }, []));
  await c.queryAbProps();

  assert.equal(c.sent.length, 1);
  const [iq] = c.sent;
  assert.equal(iq.description, 'iq');
  assert.equal(iq.attrs.xmlns, 'abt');
  assert.equal(iq.attrs.type,  'get');
  assert.equal(iq.attrs.to,    's.whatsapp.net');

  const props = iq.content[0];
  assert.equal(props.description, 'props');
  assert.equal(props.attrs.protocol, '1');
  assert.equal(props.attrs.hash, undefined, 'nothing has been synced yet');
  assert.equal(props.attrs.refresh_id, undefined);
});

test('the hash from a reply rides on the next request, asking for a delta', async () => {
  const c = client(propsReply({ hash: 'H1' }, []));
  await c.queryAbProps();
  await c.queryAbProps({ force: true });

  assert.equal(c.sent.length, 2);
  assert.equal(c.sent[1].content[0].attrs.hash, 'H1');
});

test('a refresh id takes the place of the hash rather than joining it', async () => {
  const c = client(propsReply({ hash: 'H1' }, []));
  await c.queryAbProps();
  await c.queryAbProps({ refreshId: '99' });

  const props = c.sent[1].content[0];
  assert.equal(props.attrs.refresh_id, '99');
  assert.equal(props.attrs.hash, undefined,
    'a refresh id and a hash ask two different questions');
});

test('a cached set is served without a second IQ', async () => {
  const c = client(propsReply({ hash: 'H1' }, [{ config_code: '1', config_value: 'a' }]));
  const first  = await c.queryAbProps();
  const second = await c.queryAbProps();

  assert.equal(c.sent.length, 1);
  assert.equal(second, first);
});

test('force re-asks even with a set in hand', async () => {
  const c = client(propsReply({ hash: 'H1' }, []));
  await c.queryAbProps();
  await c.queryAbProps({ force: true });
  assert.equal(c.sent.length, 2);
});

// ─── the reply ───────────────────────────────────────────────────────────────

test('experiment props and sampling weights are told apart by their attributes', async () => {
  const c = client(propsReply({ hash: 'H1', ab_key: 'K', refresh: '86400' }, [
    { config_code: '4405', config_value: '16' },
    { config_code: '5010', config_value: 'true' },
    { event_code: '1200', sampling_weight: '100' }
  ]));

  const out = await c.queryAbProps();
  assert.deepEqual(out.props,    { 4405: '16', 5010: 'true' });
  assert.deepEqual(out.sampling, { 1200: 100 });
  assert.equal(out.hash,    'H1');
  assert.equal(out.abKey,   'K');
  assert.equal(out.refresh, 86400);
  assert.equal(out.delta,   false);
});

test('a prop of neither shape is skipped, not fatal', async () => {
  const c = client(propsReply({ hash: 'H1' }, [
    { config_code: '1', config_value: 'a' },
    { something_new: '7' },
    { event_code: '2', sampling_weight: '5' }
  ]));

  const out = await c.queryAbProps();
  assert.deepEqual(out.props,    { 1: 'a' });
  assert.deepEqual(out.sampling, { 2: 5 });
});

test('a sampling entry outside the accepted bounds is dropped', async () => {
  const c = client(propsReply({ hash: 'H1' }, [
    { event_code: '0',  sampling_weight: '10' },        // code below 1
    { event_code: '5',  sampling_weight: '-1' },        // weight below 0
    { event_code: '6',  sampling_weight: '2000000' },   // weight above the cap
    { event_code: '7',  sampling_weight: '0' },         // the lower bound, kept
    { event_code: '8',  sampling_weight: '1000000' }    // the upper bound, kept
  ]));

  const out = await c.queryAbProps();
  assert.deepEqual(out.sampling, { 7: 0, 8: 1000000 });
});

test('a delta merges onto what is held instead of replacing it', async () => {
  const c = client(propsReply({ hash: 'H1' }, [
    { config_code: '1', config_value: 'a' },
    { config_code: '2', config_value: 'b' }
  ]));
  await c.queryAbProps();

  // Second round: the server names only what moved.
  c._sendIq = async (node) => {
    c.sent.push(node);
    return propsReply({ hash: 'H2', delta_update: 'true' }, [
      { config_code: '2', config_value: 'B' },
      { config_code: '3', config_value: 'c' }
    ]);
  };

  const out = await c.queryAbProps({ force: true });
  assert.deepEqual(out.props, { 1: 'a', 2: 'B', 3: 'c' },
    'prop 1 was not repeated and must survive');
  assert.equal(out.delta, true);
  assert.equal(c._abPropsHash, 'H2');
});

test('a full reply replaces what is held', async () => {
  const c = client(propsReply({ hash: 'H1' }, [
    { config_code: '1', config_value: 'a' },
    { config_code: '2', config_value: 'b' }
  ]));
  await c.queryAbProps();

  c._sendIq = async () => propsReply({ hash: 'H2' }, [{ config_code: '2', config_value: 'B' }]);

  const out = await c.queryAbProps({ force: true });
  assert.deepEqual(out.props, { 2: 'B' }, 'a full set is the whole truth');
});

test('delta_update is read as a string, so "false" is false', async () => {
  const c = client(propsReply({ hash: 'H1', delta_update: 'false' }, []));
  const out = await c.queryAbProps();
  assert.equal(out.delta, false);
});

test('a missing props child gives an empty set rather than throwing', async () => {
  const c = client(new BinaryNode('iq', { type: 'result', id: 'IQ1' }, []));
  const out = await c.queryAbProps();
  assert.deepEqual(out.props, {});
  assert.deepEqual(out.sampling, {});
  assert.equal(out.hash, null);
});

// ─── failures ────────────────────────────────────────────────────────────────

test('a timed-out IQ throws rather than caching an empty set', async () => {
  const c = client(null);
  await assert.rejects(() => c.queryAbProps(), /timed out/);
  assert.equal(c._abProps, null, 'nothing was cached');
});

test('an error reply names the code', async () => {
  const c = client(errorReply('403'));
  await assert.rejects(() => c.queryAbProps(), /403/);
});

// ─── reading a value ─────────────────────────────────────────────────────────

test('abProp reads a string and falls back when unset', async () => {
  const c = client(propsReply({ hash: 'H1' }, [{ config_code: '4405', config_value: '16' }]));
  await c.queryAbProps();

  assert.equal(c.abProp(4405), '16');
  assert.equal(c.abProp('4405'), '16', 'the code may be given either way');
  assert.equal(c.abProp(9999), null);
  assert.equal(c.abProp(9999, 'x'), 'x');
});

test('abPropInt parses, and falls back on anything that is not a number', async () => {
  const c = client(propsReply({ hash: 'H1' }, [
    { config_code: '1', config_value: '16' },
    { config_code: '2', config_value: 'sixteen' }
  ]));
  await c.queryAbProps();

  assert.equal(c.abPropInt(1), 16);
  assert.equal(c.abPropInt(2, 8), 8, 'unparseable is not zero');
  assert.equal(c.abPropInt(9999, 8), 8);
});

test('abPropBool understands both spellings and refuses the rest', async () => {
  const c = client(propsReply({ hash: 'H1' }, [
    { config_code: '1', config_value: '1' },
    { config_code: '2', config_value: 'true' },
    { config_code: '3', config_value: '0' },
    { config_code: '4', config_value: 'false' },
    { config_code: '5', config_value: '2.24.1' }
  ]));
  await c.queryAbProps();

  assert.equal(c.abPropBool(1), true);
  assert.equal(c.abPropBool(2), true);
  assert.equal(c.abPropBool(3), false);
  assert.equal(c.abPropBool(4), false);
  assert.equal(c.abPropBool(5, null), null, 'a version string is not a flag');
});

test('reading before a sync gives the fallback rather than throwing', () => {
  const c = client(null);
  assert.equal(c.abProp(4405, 'd'), 'd');
  assert.equal(c.abPropInt(4405, 8), 8);
  assert.equal(c.abPropBool(4405, true), true);
});
