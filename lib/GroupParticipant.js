'use strict';

// Participant results for group operations.
//
// A group action is not all-or-nothing. When four people are added to a group,
// the server answers with four <participant> nodes and decides each one on its
// own merits: three go in, the fourth comes back carrying error="403" because
// their privacy settings do not let strangers add them. Reporting only the JIDs
// that worked throws that away — the caller sees three where it asked for four
// and has no idea which one failed, let alone why.
//
// So every participant the server answered about is returned, with its status
// attached. The objects stringify to the bare JID, so anything that used to
// print or join the plain string list keeps working untouched.

const OK_STATUS = '200';

function _toInt(v) {
  if (v == null) return null;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

function _child(node, desc) {
  if (!node || !Array.isArray(node.content)) return null;
  return node.content.find(c => c && c.description === desc) || null;
}

class GroupParticipantResult {
  constructor(fields) {
    /** @type {string} bare JID the server answered about */
    this.jid = fields.jid;
    /** @type {string} '200' when the action went through, else the error code */
    this.status = fields.status;
    /** @type {number|null} the error code as a number, null on success */
    this.error = fields.error;
    /** @type {'admin'|'superadmin'|null} */
    this.admin = fields.admin || null;
    /** @type {string|null} phone JID — set for both address families */
    this.phoneNumber = fields.phoneNumber || null;
    /** @type {string|null} LID — set when the server told us one */
    this.lid = fields.lid || null;
    /** @type {string|null} */
    this.displayName = fields.displayName || null;
    // Present when an add was refused because the person cannot be put into a
    // group directly. The code inside is what a group invite message is built
    // from, and it stops working at `expiration`.
    /** @type {{code: string, expiration: number}|null} */
    this.addRequest = fields.addRequest || null;
    // The raw node, for anything the server sends that is not modelled here.
    Object.defineProperty(this, 'node', {
      value: fields.node || null, enumerable: false, writable: false
    });
  }

  /** Whether the server carried the action out for this participant. */
  get ok() { return this.error == null; }

  /** Whether the refusal is the kind an invite message can work around. */
  get needsInvite() { return !!(this.addRequest && this.addRequest.code); }

  toString() { return this.jid; }

  toJSON() {
    return {
      jid: this.jid, status: this.status, error: this.error, admin: this.admin,
      phoneNumber: this.phoneNumber, lid: this.lid,
      displayName: this.displayName, addRequest: this.addRequest
    };
  }
}

// One <participant jid=… [error=…] [type=…] [phone_number=…] [lid=…]> node,
// optionally wrapping an <add_request code=… expiration=…/>.
function parseParticipantNode(node) {
  const a = (node && node.attrs) || {};
  const rawJid = a.jid != null ? a.jid : a.value;
  if (rawJid == null) return null;
  const jid = String(rawJid);

  const error  = _toInt(a.error) || null;   // error="0" means the same as absent
  const type   = a.type ? String(a.type) : null;
  const isLid  = jid.endsWith('@lid');

  let addRequest = null;
  const reqNode = _child(node, 'add_request');
  if (reqNode && reqNode.attrs && reqNode.attrs.code) {
    addRequest = {
      code:       String(reqNode.attrs.code),
      expiration: _toInt(reqNode.attrs.expiration) || 0
    };
  }

  return new GroupParticipantResult({
    jid,
    status:      error != null ? String(error) : OK_STATUS,
    error,
    admin:       (type === 'admin' || type === 'superadmin') ? type : null,
    phoneNumber: isLid ? (a.phone_number ? String(a.phone_number) : null) : jid,
    lid:         isLid ? jid : (a.lid ? String(a.lid) : null),
    displayName: a.display_name ? String(a.display_name) : null,
    addRequest,
    node
  });
}

// Every <participant> under the given node, parsed. Failures included — that is
// the whole point.
function parseParticipantNodes(parent) {
  if (!parent || !Array.isArray(parent.content)) return [];
  return parent.content
    .filter(n => n && n.description === 'participant')
    .map(parseParticipantNode)
    .filter(Boolean);
}

// Somebody waiting for an admin to let them into a group.
class GroupJoinRequest {
  constructor(jid, requestedAt) {
    this.jid = jid;
    /** @type {number} unix seconds, 0 when the server did not say */
    this.requestedAt = requestedAt || 0;
  }
  toString() { return this.jid; }
  toJSON() { return { jid: this.jid, requestedAt: this.requestedAt }; }
}

function parseJoinRequestNode(node) {
  const a = (node && node.attrs) || {};
  const rawJid = a.jid != null ? a.jid : a.user;
  if (rawJid == null) return null;
  return new GroupJoinRequest(String(rawJid), _toInt(a.request_time) || 0);
}

module.exports = {
  GroupParticipantResult,
  GroupJoinRequest,
  parseParticipantNode,
  parseParticipantNodes,
  parseJoinRequestNode
};
