'use strict';

// Which collection, index and api version each kind of change is filed under.
//
// None of this is ours to pick. The server keys a mutation by its index, sorts
// it by collection, and rejects an api version it does not expect — get any of
// the three wrong and the patch is either refused or silently lands somewhere
// the phone will never look. The index is the identity of the setting: writing
// ['pin_v1', jid] twice replaces, rather than accumulates.

function mutePatch(jid, muteEndTimestampMs) {
  return {
    name:  'regular_high',
    index: ['mute', jid],
    apiVersion: 2,
    action: {
      muteAction: {
        muted: !!muteEndTimestampMs,
        muteEndTimestamp: muteEndTimestampMs || undefined
      }
    }
  };
}

function archivePatch(jid, archived) {
  return {
    name:  'regular_low',
    index: ['archive', jid],
    apiVersion: 3,
    action: { archiveChatAction: { archived: !!archived } }
  };
}

function markReadPatch(jid, read) {
  return {
    name:  'regular_low',
    index: ['markChatAsRead', jid],
    apiVersion: 3,
    action: { markChatAsReadAction: { read: !!read } }
  };
}

function pinPatch(jid, pinned) {
  return {
    name:  'regular_low',
    index: ['pin_v1', jid],
    apiVersion: 5,
    action: { pinAction: { pinned: !!pinned } }
  };
}

// A star is per message, so the index carries the message it belongs to as well
// as the chat — otherwise starring a second message would unstar the first.
function starPatch(jid, msgId, fromMe, starred) {
  return {
    name:  'regular_low',
    index: ['star', jid, msgId, fromMe ? '1' : '0', '0'],
    apiVersion: 2,
    action: { starAction: { starred: !!starred } }
  };
}

function pushNamePatch(name) {
  return {
    name:  'critical_block',
    index: ['setting_pushName'],
    apiVersion: 1,
    action: { pushNameSetting: { name } }
  };
}

function contactPatch(jid, contact) {
  return {
    name:  'critical_unblock_low',
    index: ['contact', jid],
    apiVersion: 2,
    action: { contactAction: contact || {} },
    // No contact means forget this one, which is a removal rather than an
    // empty value.
    operation: contact ? 0 : 1
  };
}

// The index tells you what a decoded mutation was about. The first element is
// the kind; what follows depends on it.
function describeIndex(index) {
  if (!Array.isArray(index) || !index.length) return null;
  const [kind, jid, msgId, fromMe] = index;
  switch (kind) {
    case 'mute':            return { kind: 'mute',     jid };
    case 'archive':         return { kind: 'archive',  jid };
    case 'markChatAsRead':  return { kind: 'markRead', jid };
    case 'pin_v1':          return { kind: 'pin',      jid };
    case 'star':            return { kind: 'star',     jid, msgId, fromMe: fromMe === '1' };
    case 'contact':         return { kind: 'contact',  jid };
    case 'setting_pushName':return { kind: 'pushName' };
    case 'clearChat':       return { kind: 'clear',    jid };
    case 'deleteChat':      return { kind: 'delete',   jid };
    // Account-wide, no jid: the salt the cstoken fallback is derived from.
    case 'nct_salt_sync':   return { kind: 'nct_salt_sync' };
    default:                return { kind, jid };
  }
}

module.exports = {
  mutePatch, archivePatch, markReadPatch, pinPatch, starPatch,
  pushNamePatch, contactPatch, describeIndex
};
