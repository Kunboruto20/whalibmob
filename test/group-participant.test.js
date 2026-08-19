'use strict';

// Group actions are decided per participant by the server, so the parser has to
// keep the failures rather than filter them out. These tests pin that down,
// plus the backward-compatible stringification the objects promise.

const test   = require('node:test');
const assert = require('node:assert/strict');

const {
  GroupParticipantResult,
  GroupJoinRequest,
  parseParticipantNode,
  parseParticipantNodes,
  parseJoinRequestNode
} = require('../lib/GroupParticipant');

/** A binary node as the decoder produces one. */
const node = (description, attrs, content) => ({ description, attrs, content: content || null });

test('a participant the server accepted reports ok with status 200', () => {
  const r = parseParticipantNode(node('participant', { jid: '919634847671@s.whatsapp.net' }));
  assert.equal(r.jid, '919634847671@s.whatsapp.net');
  assert.equal(r.status, '200');
  assert.equal(r.error, null);
  assert.equal(r.ok, true);
  assert.equal(r.needsInvite, false);
});

test('error="0" means the same as no error at all', () => {
  // A literal zero is the server saying "fine", not failure code zero.
  const r = parseParticipantNode(node('participant', { jid: '919634847671@s.whatsapp.net', error: '0' }));
  assert.equal(r.error, null);
  assert.equal(r.ok, true);
  assert.equal(r.status, '200');
});

test('a refused participant keeps its error code and is not ok', () => {
  const r = parseParticipantNode(node('participant', { jid: '12345678901@s.whatsapp.net', error: '403' }));
  assert.equal(r.error, 403);
  assert.equal(r.status, '403');
  assert.equal(r.ok, false);
});

test('a 403 carrying an add_request can be invited instead', () => {
  const r = parseParticipantNode(
    node('participant', { jid: '12345678901@s.whatsapp.net', error: '403' }, [
      node('add_request', { code: 'AbCdEfGh', expiration: '1790000000' })
    ])
  );
  assert.equal(r.ok, false);
  assert.equal(r.needsInvite, true);
  assert.deepEqual(r.addRequest, { code: 'AbCdEfGh', expiration: 1790000000 });
});

test('a 403 with no add_request cannot be invited around', () => {
  const r = parseParticipantNode(node('participant', { jid: '12345678901@s.whatsapp.net', error: '403' }));
  assert.equal(r.needsInvite, false);
  assert.equal(r.addRequest, null);
});

test('a LID-addressed participant carries the phone number behind it', () => {
  const r = parseParticipantNode(node('participant', {
    jid: '112713111982325@lid',
    phone_number: '919634847671@s.whatsapp.net'
  }));
  assert.equal(r.lid, '112713111982325@lid');
  assert.equal(r.phoneNumber, '919634847671@s.whatsapp.net');
});

test('a phone-addressed participant fills phoneNumber from the jid itself', () => {
  const r = parseParticipantNode(node('participant', { jid: '919634847671@s.whatsapp.net' }));
  assert.equal(r.phoneNumber, '919634847671@s.whatsapp.net');
  assert.equal(r.lid, null);
});

test('admin and superadmin are recognised; anything else is not an admin', () => {
  const admin = parseParticipantNode(node('participant', { jid: 'a@s.whatsapp.net', type: 'admin' }));
  const supa  = parseParticipantNode(node('participant', { jid: 'b@s.whatsapp.net', type: 'superadmin' }));
  const other = parseParticipantNode(node('participant', { jid: 'c@s.whatsapp.net', type: 'member' }));
  assert.equal(admin.admin, 'admin');
  assert.equal(supa.admin, 'superadmin');
  assert.equal(other.admin, null);
});

test('a participant node with no jid at all is dropped, not half-parsed', () => {
  assert.equal(parseParticipantNode(node('participant', {})), null);
  assert.equal(parseParticipantNode(null), null);
});

test('parseParticipantNodes keeps the failures alongside the successes', () => {
  const parent = node('add', {}, [
    node('participant', { jid: 'ok@s.whatsapp.net' }),
    node('participant', { jid: 'bad@s.whatsapp.net', error: '403' }),
    node('something-else', { jid: 'ignored@s.whatsapp.net' }),
    node('participant', {})                                   // no jid — dropped
  ]);
  const rs = parseParticipantNodes(parent);
  assert.equal(rs.length, 2, 'both participants, and only participants');
  assert.equal(rs[0].ok, true);
  assert.equal(rs[1].ok, false);
});

test('parseParticipantNodes on nothing returns an empty list, never throws', () => {
  assert.deepEqual(parseParticipantNodes(null), []);
  assert.deepEqual(parseParticipantNodes(node('add', {})), []);
});

test('a result stringifies to its bare JID, so old string code keeps working', () => {
  const rs = parseParticipantNodes(node('add', {}, [
    node('participant', { jid: 'a@s.whatsapp.net' }),
    node('participant', { jid: 'b@s.whatsapp.net' })
  ]));
  assert.equal(String(rs[0]), 'a@s.whatsapp.net');
  assert.equal(`${rs[0]}`, 'a@s.whatsapp.net');
  assert.equal(rs.join(', '), 'a@s.whatsapp.net, b@s.whatsapp.net');
});

test('toJSON exposes the fields without the raw node', () => {
  const r = parseParticipantNode(node('participant', { jid: 'a@s.whatsapp.net', error: '403' }));
  const j = r.toJSON();
  assert.equal(j.jid, 'a@s.whatsapp.net');
  assert.equal(j.error, 403);
  assert.equal('node' in j, false, 'the binary node does not belong in JSON output');
});

test('GroupParticipantResult can be built directly', () => {
  const r = new GroupParticipantResult({ jid: 'x@s.whatsapp.net', status: '200', error: null });
  assert.equal(r.ok, true);
  assert.equal(String(r), 'x@s.whatsapp.net');
});

test('a join request keeps its timestamp, and defaults it to 0', () => {
  const withTime = parseJoinRequestNode(node('membership_approval_request', {
    jid: '919634847671@s.whatsapp.net', request_time: '1790000000'
  }));
  assert.equal(withTime.jid, '919634847671@s.whatsapp.net');
  assert.equal(withTime.requestedAt, 1790000000);

  const noTime = parseJoinRequestNode(node('membership_approval_request', { jid: 'a@s.whatsapp.net' }));
  assert.equal(noTime.requestedAt, 0, 'a missing time is 0, not NaN or undefined');

  assert.equal(parseJoinRequestNode(node('membership_approval_request', {})), null);
});

test('a join request also stringifies to its JID', () => {
  const r = new GroupJoinRequest('a@s.whatsapp.net', 123);
  assert.equal(String(r), 'a@s.whatsapp.net');
  assert.deepEqual(r.toJSON(), { jid: 'a@s.whatsapp.net', requestedAt: 123 });
});
