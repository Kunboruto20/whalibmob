'use strict';

// Regression tests for newsletter (channel) operations.
//
// The previous implementation used stale GraphQL persisted-query IDs (so the
// server rejected the queries), sent the wrong variables shape for metadata
// (`newsletter_id` instead of `input:{key,type}`), read the response from the
// wrong data path, and swallowed server-side GraphQL errors.

const assert = require('assert');
const { WhalibmobClient } = require('../lib/Client');
const { BinaryNode } = require('../lib/BinaryNode');

// Build a fake client that captures the outgoing IQ and returns a canned
// w:mex result body.
function fakeClient(responseJson) {
  const client = Object.create(WhalibmobClient.prototype);
  client._genMsgId = () => 'id1';
  client._sent = null;
  client._sendIq = async (node) => {
    client._sent = node;
    const body = Buffer.from(JSON.stringify(responseJson), 'utf8');
    return new BinaryNode('iq', { type: 'result' }, [
      new BinaryNode('result', {}, body),
    ]);
  };
  return client;
}

function sentQuery(client) {
  const q = client._sent.content.find(n => n.description === 'query');
  const vars = JSON.parse(q.content.toString('utf8')).variables;
  return { queryId: q.attrs.query_id, vars };
}

async function testCreate() {
  const client = fakeClient({
    data: { xwa2_newsletter_create: {
      id: '123@newsletter',
      thread_metadata: {
        name: { text: 'My Channel' },
        description: { text: 'hello' },
        subscribers_count: '42',
        creation_time: '1700000000',
        invite: 'ABC',
      },
      viewer_metadata: { mute: 'off' },
    } },
  });
  const res = await client.createNewsletter('My Channel', 'hello');
  const { queryId, vars } = sentQuery(client);

  assert.strictEqual(queryId, '8823471724422422', 'current CREATE query id');
  assert.deepStrictEqual(vars, { input: { name: 'My Channel', description: 'hello' } }, 'create variables shape');
  assert.strictEqual(res.jid, '123@newsletter');
  assert.strictEqual(res.name, 'My Channel', 'name unwrapped from {text}');
  assert.strictEqual(res.description, 'hello', 'description unwrapped from {text}');
  assert.strictEqual(res.subscriberCount, 42);
  assert.strictEqual(res.creationTime, 1700000000);
  console.log('  ✓ createNewsletter: current query id, correct variables, parsed thread');
}

async function testMetadataShape() {
  const client = fakeClient({
    data: { xwa2_newsletter: {
      id: '999@newsletter',
      thread_metadata: { name: { text: 'Chan' }, description: { text: '' }, subscribers_count: '5' },
    } },
  });
  const res = await client.queryNewsletterMetadata('999@newsletter');
  const { queryId, vars } = sentQuery(client);

  assert.strictEqual(queryId, '6563316087068696', 'current METADATA query id');
  assert.deepStrictEqual(vars, {
    fetch_creation_time: true,
    fetch_full_image: true,
    fetch_viewer_metadata: true,
    input: { key: '999@newsletter', type: 'JID' },
  }, 'metadata uses input:{key,type}, not newsletter_id');
  assert.strictEqual(res.jid, '999@newsletter');
  assert.strictEqual(res.subscriberCount, 5);
  console.log('  ✓ queryNewsletterMetadata: current query id and input:{key,type} shape');
}

async function testFollowLeaveMuteQueryIds() {
  const cases = [
    ['joinNewsletter',  '24404358912487870'],
    ['leaveNewsletter', '9767147403369991'],
    ['muteNewsletter',  '29766401636284406'],
    ['unmuteNewsletter','9864994326891137'],
    ['deleteNewsletter','30062808666639665'],
  ];
  for (const [method, expectedId] of cases) {
    const client = fakeClient({ data: {} });
    await client[method]('123@newsletter');
    const { queryId, vars } = sentQuery(client);
    assert.strictEqual(queryId, expectedId, `${method} uses current query id`);
    assert.strictEqual(vars.newsletter_id, '123@newsletter', `${method} sends newsletter_id`);
  }
  console.log('  ✓ join/leave/mute/unmute/delete use current query ids');
}

async function testGraphQlErrorSurfaced() {
  const client = fakeClient({ errors: [{ message: 'not authorized', extensions: { error_code: 403 } }] });
  let threw = false;
  try { await client.createNewsletter('x', 'y'); }
  catch (e) { threw = true; assert.ok(/not authorized/.test(e.message), 'error message surfaced'); }
  assert.ok(threw, 'GraphQL errors must be thrown, not swallowed');
  console.log('  ✓ server-side GraphQL errors are surfaced');
}

async function testUpdateDescription() {
  const client = fakeClient({ data: { xwa2_newsletter_update: { id: '1@newsletter' } } });
  await client.changeNewsletterDescription('1@newsletter', 'new desc');
  const { queryId, vars } = sentQuery(client);
  assert.strictEqual(queryId, '24250201037901610', 'current UPDATE_METADATA query id');
  assert.deepStrictEqual(vars, { newsletter_id: '1@newsletter', updates: { description: 'new desc', settings: null } });
  console.log('  ✓ changeNewsletterDescription: current query id and updates shape');
}

(async () => {
  console.log('Newsletter operations:');
  await testCreate();
  await testMetadataShape();
  await testFollowLeaveMuteQueryIds();
  await testGraphQlErrorSurfaced();
  await testUpdateDescription();
  console.log('\nAll newsletter tests passed.');
})().catch(err => { console.error('\nTEST FAILED:', err && err.stack || err); process.exit(1); });
