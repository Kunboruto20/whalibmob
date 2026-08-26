'use strict';

// The wire format app state travels in.
//
// A collection ("regular_low", "critical_block", …) is a versioned list of
// mutations. Each mutation names an index — a JSON array like ["pin_v1", jid] —
// and carries the encrypted value filed under it. The server hands them over
// either as a snapshot (the whole collection, from scratch) or as patches (what
// changed since a version you name).
//
//   SyncdPatch   { version=1, mutations=2, externalMutations=3,
//                  snapshotMac=4, patchMac=5, keyId=6 }
//   SyncdSnapshot{ version=1, records=2, mac=3, keyId=4 }
//   SyncdMutation{ operation=1 (SET=0 REMOVE=1), record=2 }
//   SyncdRecord  { index=1, value=2, keyId=3 }
//   SyncdIndex   { blob=1 }   SyncdValue { blob=1 }   KeyId { id=1 }
//   SyncdVersion { version=1 }
//   SyncdMutations { mutations=1 }
//   ExternalBlobReference { mediaKey=1, directPath=2, handle=3,
//                           fileSizeBytes=4, fileSha256=5, fileEncSha256=6 }
//   SyncActionData { index=1, value=2, padding=3, version=4 }

const {
  decodeFields, field, varint, str, bytes, WIRE_VARINT, WIRE_LEN
} = require('../proto/MessageProto');

const SET    = 0;
const REMOVE = 1;

const _b   = v => (v == null ? null : (Buffer.isBuffer(v) ? v : Buffer.from(v)));
const _arr = v => (v == null ? [] : (Array.isArray(v) ? v : [v]));
const _num = v => {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (Buffer.isBuffer(v)) { let n = 0; for (let i = v.length - 1; i >= 0; i--) n = n * 256 + v[i]; return n; }
  return Number(v) || 0;
};
const _str = v => (v == null ? '' : (Buffer.isBuffer(v) ? v.toString('utf8') : String(v)));

// ─── decoding ────────────────────────────────────────────────────────────────

function decodeKeyId(buf) {
  if (!buf) return null;
  const f = decodeFields(buf);
  return _b(f[1]);
}

function decodeRecord(buf) {
  const f = decodeFields(buf);
  return {
    indexBlob: f[1] ? _b(decodeFields(f[1])[1]) : null,
    valueBlob: f[2] ? _b(decodeFields(f[2])[1]) : null,
    keyId:     decodeKeyId(f[3])
  };
}

// A bare record is a SET; only a SyncdMutation carries an operation of its own.
function decodeMutation(buf) {
  const f = decodeFields(buf);
  if (!f[2]) return Object.assign({ operation: SET }, decodeRecord(buf));
  return Object.assign({ operation: _num(f[1]) }, decodeRecord(f[2]));
}

function decodeExternalBlobReference(buf) {
  if (!buf) return null;
  const f = decodeFields(buf);
  return {
    mediaKey:      _b(f[1]),
    directPath:    _str(f[2]),
    handle:        _str(f[3]),
    fileSizeBytes: _num(f[4]),
    fileSha256:    _b(f[5]),
    fileEncSha256: _b(f[6])
  };
}

function decodePatch(buf) {
  const f = decodeFields(buf);
  return {
    version:           f[1] ? _num(decodeFields(f[1])[1]) : null,
    mutations:         _arr(f[2]).filter(Buffer.isBuffer).map(decodeMutation),
    externalMutations: decodeExternalBlobReference(f[3]),
    snapshotMac:       _b(f[4]),
    patchMac:          _b(f[5]),
    keyId:             decodeKeyId(f[6])
  };
}

function decodeSnapshot(buf) {
  const f = decodeFields(buf);
  return {
    version: f[1] ? _num(decodeFields(f[1])[1]) : 0,
    records: _arr(f[2]).filter(Buffer.isBuffer)
      .map(r => Object.assign({ operation: SET }, decodeRecord(r))),
    mac:     _b(f[3]),
    keyId:   decodeKeyId(f[4])
  };
}

// The blob an oversized patch is moved out into.
function decodeMutations(buf) {
  const f = decodeFields(buf);
  return _arr(f[1]).filter(Buffer.isBuffer).map(decodeMutation);
}

function decodeSyncActionData(buf) {
  const f = decodeFields(buf);
  return {
    index:   _b(f[1]),
    value:   f[2] ? decodeSyncActionValue(f[2]) : null,
    version: _num(f[4])
  };
}

// ─── SyncActionValue ─────────────────────────────────────────────────────────
//
// One field per kind of change. Only the ones this library acts on are decoded;
// anything else is reported by name so a caller can see it went by.
const ACTION_FIELDS = {
  2:  'starAction',
  3:  'contactAction',
  4:  'muteAction',
  5:  'pinAction',
  7:  'pushNameSetting',
  17: 'archiveChatAction',
  20: 'markChatAsReadAction',
  21: 'clearChatAction',
  22: 'deleteChatAction',
  // NctSaltSyncAction { salt = 1 }. The salt a cstoken is derived from; the
  // server distributes it into app state and a companion reads it from here.
  80: 'nctSaltSyncAction'
};

function decodeSyncActionValue(buf) {
  const f   = decodeFields(buf);
  const out = { timestamp: _num(f[1]) };

  for (const [num, name] of Object.entries(ACTION_FIELDS)) {
    const raw = f[num];
    if (!Buffer.isBuffer(raw)) continue;
    const a = decodeFields(raw);
    switch (name) {
      case 'starAction':
        out.starAction = { starred: !!_num(a[1]) }; break;
      case 'pinAction':
        out.pinAction = { pinned: !!_num(a[1]) }; break;
      case 'muteAction':
        out.muteAction = {
          muted: !!_num(a[1]),
          muteEndTimestamp: _num(a[2]),
          autoMuted: !!_num(a[3])
        };
        break;
      case 'archiveChatAction':
        out.archiveChatAction = { archived: !!_num(a[1]) }; break;
      case 'markChatAsReadAction':
        out.markChatAsReadAction = { read: !!_num(a[1]) }; break;
      case 'clearChatAction':
        out.clearChatAction = {}; break;
      case 'deleteChatAction':
        out.deleteChatAction = {}; break;
      case 'nctSaltSyncAction':
        out.nctSaltSyncAction = { salt: Buffer.isBuffer(a[1]) ? a[1] : null }; break;
      case 'pushNameSetting':
        out.pushNameSetting = { name: _str(a[1]) }; break;
      case 'contactAction':
        out.contactAction = {
          fullName:  _str(a[1]) || null,
          firstName: _str(a[2]) || null,
          lidJid:    _str(a[3]) || null,
          pnJid:     _str(a[5]) || null,
          username:  _str(a[6]) || null
        };
        break;
      default: break;
    }
  }

  // Whatever else the server sent, so a caller is not left guessing why nothing
  // happened for a mutation that plainly said something.
  const known    = new Set(['1', ...Object.keys(ACTION_FIELDS)]);
  out.otherFields = Object.keys(f).filter(k => !known.has(k)).map(Number);
  return out;
}

// ─── encoding (the write path) ───────────────────────────────────────────────

function encodeKeyId(id)      { return field(1, WIRE_LEN, bytes(id)); }
function encodeVersion(v)     { return field(1, WIRE_VARINT, varint(v)); }

function encodeSyncActionValue(action, timestampMs) {
  const parts = [field(1, WIRE_VARINT, varint(timestampMs))];

  if (action.starAction) {
    parts.push(field(2, WIRE_LEN,
      field(1, WIRE_VARINT, varint(action.starAction.starred ? 1 : 0))));
  }
  if (action.contactAction) {
    const c = action.contactAction;
    parts.push(field(3, WIRE_LEN, Buffer.concat([
      c.fullName  ? field(1, WIRE_LEN, str(c.fullName))  : Buffer.alloc(0),
      c.firstName ? field(2, WIRE_LEN, str(c.firstName)) : Buffer.alloc(0)
    ])));
  }
  if (action.muteAction) {
    const m = action.muteAction;
    parts.push(field(4, WIRE_LEN, Buffer.concat([
      field(1, WIRE_VARINT, varint(m.muted ? 1 : 0)),
      m.muteEndTimestamp
        ? field(2, WIRE_VARINT, varint(m.muteEndTimestamp))
        : Buffer.alloc(0)
    ])));
  }
  if (action.pinAction) {
    parts.push(field(5, WIRE_LEN,
      field(1, WIRE_VARINT, varint(action.pinAction.pinned ? 1 : 0))));
  }
  if (action.pushNameSetting) {
    parts.push(field(7, WIRE_LEN, field(1, WIRE_LEN, str(action.pushNameSetting.name))));
  }
  if (action.archiveChatAction) {
    parts.push(field(17, WIRE_LEN,
      field(1, WIRE_VARINT, varint(action.archiveChatAction.archived ? 1 : 0))));
  }
  if (action.markChatAsReadAction) {
    parts.push(field(20, WIRE_LEN,
      field(1, WIRE_VARINT, varint(action.markChatAsReadAction.read ? 1 : 0))));
  }
  return Buffer.concat(parts);
}

function encodeSyncActionData({ index, value, apiVersion, timestampMs }) {
  return Buffer.concat([
    field(1, WIRE_LEN,    bytes(index)),
    field(2, WIRE_LEN,    encodeSyncActionValue(value, timestampMs)),
    field(3, WIRE_LEN,    Buffer.alloc(0)),           // padding, always empty
    field(4, WIRE_VARINT, varint(apiVersion || 1))
  ]);
}

function encodeMutation({ operation, indexMac, valueBlob, keyId }) {
  const record = Buffer.concat([
    field(1, WIRE_LEN, field(1, WIRE_LEN, bytes(indexMac))),
    field(2, WIRE_LEN, field(1, WIRE_LEN, bytes(valueBlob))),
    field(3, WIRE_LEN, encodeKeyId(keyId))
  ]);
  return Buffer.concat([
    field(1, WIRE_VARINT, varint(operation)),
    field(2, WIRE_LEN,    record)
  ]);
}

function encodePatch({ version, mutations, snapshotMac, patchMac, keyId }) {
  return Buffer.concat([
    field(1, WIRE_LEN, encodeVersion(version)),
    ...mutations.map(m => field(2, WIRE_LEN, encodeMutation(m))),
    field(4, WIRE_LEN, bytes(snapshotMac)),
    field(5, WIRE_LEN, bytes(patchMac)),
    field(6, WIRE_LEN, encodeKeyId(keyId))
  ]);
}

module.exports = {
  SET, REMOVE,
  decodePatch, decodeSnapshot, decodeMutations, decodeMutation,
  decodeExternalBlobReference, decodeSyncActionData, decodeSyncActionValue,
  encodePatch, encodeMutation, encodeSyncActionData, encodeSyncActionValue
};
