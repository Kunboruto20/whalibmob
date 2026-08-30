'use strict';

// Contact sync — the address-book upload every phone does on first launch.
//
// The usync machinery already existed for device discovery; this only drives
// it with the contact protocol and the mode and context that make the stanza an
// address-book upload rather than a lookup. So what is worth testing is not the
// stanza (DeviceManager builds it, and has for a long time) but the decisions
// around it: which numbers get asked about, how the answer is matched back to
// what the caller passed in, and — the one that matters — what happens to a
// chunk the server does not answer.
//
// That last one is the whole reason for the unclassified case. Reporting "not
// on WhatsApp" for a timeout is the single wrong answer available here, because
// a caller acts on it: it skips the number, or worse, deletes it.

const test   = require('node:test');
const assert = require('node:assert/strict');

const { WhalibmobClient } = require('../lib/Client');

// A client whose usync layer is a recorder. `answer` is called with the query
// and returns whatever the server would have said.
function client(answer) {
  const queries = [];
  const c = Object.assign(Object.create(WhalibmobClient.prototype), {
    _connected: true,
    _socket:    {},
    _genMsgId:  () => 'IQ1',
    _devMgr: {
      executeUSyncQuery: async (query) => {
        queries.push(query);
        return answer(query);
      }
    }
  });
  c.queries = queries;
  return c;
}

// The shape parseUSyncQueryResult produces: one entry per user, keyed by JID,
// with the contact protocol's verdict under `contact`.
const list = (entries) => ({
  list: entries.map(([user, on]) => ({ contact: on, id: user + '@s.whatsapp.net' })),
  sideList: []
});

// ─── the query ───────────────────────────────────────────────────────────────

test('a full sync goes out as mode=full, context=registration', async () => {
  const c = client(() => list([['40712345678', true]]));
  await c.syncContacts(['40712345678']);

  assert.equal(c.queries.length, 1);
  const [q] = c.queries;
  assert.equal(q.mode,    'full');
  assert.equal(q.context, 'registration',
    'the context the app itself uses for a first-launch book upload');
  assert.deepEqual(q.protocols.map(p => p.name), ['contact'],
    'a book upload asks about contacts, not devices');
});

test('a non-full sync defaults to the interactive context', async () => {
  const c = client(() => list([]));
  await c.syncContacts(['40712345678'], { mode: 'delta' });

  assert.equal(c.queries[0].mode,    'delta');
  assert.equal(c.queries[0].context, 'interactive');
});

test('an explicit context wins over the default', async () => {
  const c = client(() => list([]));
  await c.syncContacts(['40712345678'], { mode: 'full', context: 'interactive' });
  assert.equal(c.queries[0].context, 'interactive');
});

test('numbers go on the wire as +digits, however they were written', async () => {
  const c = client(() => list([]));
  await c.syncContacts(['+40 712 345 678', '40712345679', '(407) 1234-5680']);

  const phones = c.queries[0].users.map(u => u.phone);
  assert.deepEqual(phones, ['+40712345678', '+40712345679', '+40712345680']);
});

test('a number given twice is asked about once', async () => {
  const c = client(() => list([]));
  await c.syncContacts(['+40712345678', '40712345678', '40 712 345 678']);
  assert.equal(c.queries[0].users.length, 1);
});

test('an empty book sends nothing at all', async () => {
  const c = client(() => { throw new Error('should not have been called'); });
  const out = await c.syncContacts([]);
  assert.equal(c.queries.length, 0);
  assert.deepEqual(out, { registered: [], unregistered: [], jids: {} });
});

test('entries that are not numbers at all are dropped before sending', async () => {
  const c = client(() => list([]));
  await c.syncContacts(['', null, undefined, '   ', '40712345678']);
  assert.equal(c.queries[0].users.length, 1);
});

// ─── the answer ──────────────────────────────────────────────────────────────

test('the verdict is split, and answered in the caller\'s own spelling', async () => {
  const c = client(() => list([['40712345678', true], ['40712345679', false]]));
  const out = await c.syncContacts(['+40 712 345 678', '40712345679']);

  assert.deepEqual(out.registered,   ['+40 712 345 678'],
    'answered with what was passed in, not with the normalised form');
  assert.deepEqual(out.unregistered, ['40712345679']);
  assert.deepEqual(out.jids, { '+40 712 345 678': '40712345678@s.whatsapp.net' });
});

test('a number the server did not mention is left unclassified', async () => {
  const c = client(() => list([['40712345678', true]]));
  const out = await c.syncContacts(['40712345678', '40799999999']);

  assert.deepEqual(out.registered,   ['40712345678']);
  assert.deepEqual(out.unregistered, [],
    'silence about a number is not a verdict on it');
});

test('an unanswered chunk classifies none of its numbers', async () => {
  const c = client(() => null);   // the IQ timed out
  const out = await c.syncContacts(['40712345678', '40712345679']);

  assert.deepEqual(out.registered,   []);
  assert.deepEqual(out.unregistered, [],
    'a timeout must never be reported as "not on WhatsApp"');
});

test('a reply with no list is treated the same as no reply', async () => {
  const c = client(() => ({ sideList: [] }));
  const out = await c.syncContacts(['40712345678']);
  assert.deepEqual(out.unregistered, []);
});

test('a device-suffixed JID in the reply still matches its number', async () => {
  const c = client(() => ({
    list: [{ contact: true, id: '40712345678:3@s.whatsapp.net' }],
    sideList: []
  }));
  const out = await c.syncContacts(['40712345678']);
  assert.deepEqual(out.registered, ['40712345678']);
});

// ─── chunking ────────────────────────────────────────────────────────────────

test('a book larger than the chunk size goes out in several queries', async () => {
  const phones = Array.from({ length: 250 }, (_, i) => '4071234' + String(1000 + i));
  const c = client((q) => list(q.users.map(u => [u.phone.slice(1), true])));

  const out = await c.syncContacts(phones, { chunkSize: 100 });

  assert.equal(c.queries.length, 3);
  assert.deepEqual(c.queries.map(q => q.users.length), [100, 100, 50]);
  assert.equal(out.registered.length, 250, 'every chunk is accounted for');
});

test('one unanswered chunk does not cost the others their answers', async () => {
  const phones = ['40711111111', '40722222222', '40733333333', '40744444444'];
  let round = 0;
  const c = client((q) => {
    round++;
    if (round === 1) return null;                         // first chunk times out
    return list(q.users.map(u => [u.phone.slice(1), true]));
  });

  const out = await c.syncContacts(phones, { chunkSize: 2 });
  assert.equal(c.queries.length, 2);
  assert.deepEqual(out.registered, ['40733333333', '40744444444']);
});

test('a chunk size that makes no sense falls back to the default', async () => {
  const c = client(() => list([]));
  await c.syncContacts(['40712345678'], { chunkSize: 0 });
  assert.equal(c.queries.length, 1);
});

// ─── guards ──────────────────────────────────────────────────────────────────

test('syncing while disconnected is refused', async () => {
  const c = client(() => list([]));
  c._connected = false;
  await assert.rejects(() => c.syncContacts(['40712345678']), /Not connected/);
});

test('a non-array book is refused rather than iterated', async () => {
  const c = client(() => list([]));
  await assert.rejects(() => c.syncContacts('40712345678'), /must be an array/);
});

test('a torn-down session says so instead of dereferencing null', async () => {
  const c = client(() => list([]));
  c._devMgr = null;
  await assert.rejects(() => c.syncContacts(['40712345678']), /not initialised/);
});
