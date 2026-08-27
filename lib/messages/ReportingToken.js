'use strict';

// The reporting token that rides on messages carrying a message secret.
//
// It exists so a message can be reported for abuse without the server being
// able to read it. The sender attaches an HMAC over the message's own content,
// keyed by material derived from the message secret. If the recipient later
// reports the message, they hand the server the plaintext; the server cannot
// decrypt anything itself, but it can recompute the HMAC and confirm the text
// being reported is exactly what was sent rather than something the reporter
// made up.
//
// The HMAC is not taken over the whole message. WhatsApp hashes a fixed subset
// of protobuf fields — the ones that carry reportable content — copied out in
// field-number order, so that fields which vary between devices or over time do
// not change the token. REPORTING_FIELDS below is that subset, and it is the
// part that has to match byte for byte or the token is worthless.
//
// The key is derived using the destination JID for both halves. Since the
// server only checks the token when a report is actually filed, the choice is
// not observable on send.

const crypto     = require('crypto');
const { hkdfSha256 } = require('../hkdf');
const { sha256 } = require('@noble/hashes/sha256');

// Protobuf field numbers on Message that the token is computed over.
//   f  field number
//   m  descend into it but keep every subfield
//   s  descend into it and keep only these subfields
const REPORTING_FIELDS = [
  { f: 1 },
  { f: 3,  s: [{ f: 2 }, { f: 3 }, { f: 8 }, { f: 11 }, { f: 17, s: [{ f: 21 }, { f: 22 }] }, { f: 25 }] },
  { f: 4,  s: [{ f: 1 }, { f: 16 }, { f: 17, s: [{ f: 21 }, { f: 22 }] }] },
  { f: 5,  s: [{ f: 3 }, { f: 4 }, { f: 5 }, { f: 16 }, { f: 17, s: [{ f: 21 }, { f: 22 }] }] },
  { f: 6,  s: [{ f: 1 }, { f: 17, s: [{ f: 21 }, { f: 22 }] }, { f: 30 }] },
  { f: 7,  s: [{ f: 2 }, { f: 7 }, { f: 10 }, { f: 17, s: [{ f: 21 }, { f: 22 }] }, { f: 20 }] },
  { f: 8,  s: [{ f: 2 }, { f: 7 }, { f: 9 }, { f: 17, s: [{ f: 21 }, { f: 22 }] }, { f: 21 }] },
  { f: 9,  s: [{ f: 2 }, { f: 6 }, { f: 7 }, { f: 13 }, { f: 17, s: [{ f: 21 }, { f: 22 }] }, { f: 20 }] },
  { f: 12, s: [{ f: 1 }, { f: 2 }, { f: 14, m: true }, { f: 15 }] },
  { f: 18, s: [{ f: 6 }, { f: 16 }, { f: 17, s: [{ f: 21 }, { f: 22 }] }] },
  { f: 26, s: [{ f: 4 }, { f: 5 }, { f: 8 }, { f: 13 }, { f: 17, s: [{ f: 21 }, { f: 22 }] }] },
  { f: 28, s: [{ f: 1 }, { f: 2 }, { f: 4 }, { f: 5 }, { f: 6 }, { f: 7, s: [{ f: 21 }, { f: 22 }] }] },
  { f: 37, s: [{ f: 1, m: true }] },
  { f: 49, s: [{ f: 2 }, { f: 3, s: [{ f: 1 }, { f: 2 }] }, { f: 5, s: [{ f: 21 }, { f: 22 }] },
               { f: 8, s: [{ f: 1 }, { f: 2 }] }] },
  { f: 53, s: [{ f: 1, m: true }] },
  { f: 55, s: [{ f: 1, m: true }] },
  { f: 58, s: [{ f: 1, m: true }] },
  { f: 59, s: [{ f: 1, m: true }] },
  { f: 60, s: [{ f: 2 }, { f: 3, s: [{ f: 1 }, { f: 2 }] }, { f: 5, s: [{ f: 21 }, { f: 22 }] },
               { f: 8, s: [{ f: 1 }, { f: 2 }] }] },
  { f: 64, s: [{ f: 2 }, { f: 3, s: [{ f: 1 }, { f: 2 }] }, { f: 5, s: [{ f: 21 }, { f: 22 }] },
               { f: 8, s: [{ f: 1 }, { f: 2 }] }] },
  { f: 66, s: [{ f: 2 }, { f: 6 }, { f: 7 }, { f: 13 }, { f: 17, s: [{ f: 21 }, { f: 22 }] }, { f: 20 }] },
  { f: 74, s: [{ f: 1, m: true }] },
  { f: 87, s: [{ f: 1, m: true }] },
  { f: 88, s: [{ f: 1 }, { f: 2, s: [{ f: 1 }] }, { f: 3, s: [{ f: 21 }, { f: 22 }] }] },
  { f: 92, s: [{ f: 1, m: true }] },
  { f: 93, s: [{ f: 1, m: true }] },
  { f: 94, s: [{ f: 1, m: true }] }
];

function compileFields(fields) {
  const map = new Map();
  for (const f of fields) {
    map.set(f.f, { m: f.m, children: f.s ? compileFields(f.s) : undefined });
  }
  return map;
}

const COMPILED  = compileFields(REPORTING_FIELDS);
const EMPTY_MAP = new Map();

const ENC_SECRET_REPORT_TOKEN = 'Report Token';

const WIRE = { VARINT: 0, FIXED64: 1, BYTES: 2, FIXED32: 5 };

// Message field numbers that matter here.
const F_MESSAGE_CONTEXT_INFO   = 35;
const F_REACTION               = 46;
const F_POLL_UPDATE            = 50;
const F_ENC_REACTION           = 56;
const F_ENC_EVENT_RESPONSE     = 76;
const F_CTX_MESSAGE_SECRET     = 3;   // inside MessageContextInfo

// ─── varints ─────────────────────────────────────────────────────────────────

function decodeVarint(buffer, offset) {
  let value = 0, bytes = 0, shift = 0;
  while (offset + bytes < buffer.length) {
    const current = buffer[offset + bytes];
    value |= (current & 0x7f) << shift;
    bytes++;
    if ((current & 0x80) === 0) return { value, bytes, ok: true };
    shift += 7;
    if (shift > 35) return { value: 0, bytes: 0, ok: false };
  }
  return { value: 0, bytes: 0, ok: false };
}

function encodeVarint(value) {
  const parts = [];
  let remaining = value >>> 0;
  while (remaining > 0x7f) {
    parts.push((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  parts.push(remaining);
  return Buffer.from(parts);
}

// ─── selective protobuf extraction ───────────────────────────────────────────
//
// Walks the encoded message and copies out only the configured fields, keeping
// their original bytes. Length-delimited fields with a config of their own are
// re-encoded around whatever their own walk produced, so a nested field that
// contributes nothing disappears entirely rather than leaving an empty wrapper.
//
// The result is sorted by field number, which is what makes the token
// independent of the order the encoder happened to write the fields in.
//
// Returns null on malformed input — the caller then attaches no token.
function extractReportingTokenContent(data, cfg) {
  const out = [];
  let i = 0;

  while (i < data.length) {
    const tag = decodeVarint(data, i);
    if (!tag.ok) return null;

    const fieldNum = tag.value >> 3;
    const wireType = tag.value & 0x7;
    const fieldStart = i;
    i += tag.bytes;

    const fieldCfg = cfg.get(fieldNum);

    const pushSlice = (end) => {
      if (end > data.length) return false;
      out.push({ num: fieldNum, bytes: data.subarray(fieldStart, end) });
      i = end;
      return true;
    };
    const skip = (end) => {
      if (end > data.length) return false;
      i = end;
      return true;
    };

    if (wireType === WIRE.VARINT) {
      const v = decodeVarint(data, i);
      if (!v.ok) return null;
      const end = i + v.bytes;
      if (!fieldCfg) { if (!skip(end)) return null; continue; }
      if (!pushSlice(end)) return null;
      continue;
    }

    if (wireType === WIRE.FIXED64) {
      const end = i + 8;
      if (!fieldCfg) { if (!skip(end)) return null; continue; }
      if (!pushSlice(end)) return null;
      continue;
    }

    if (wireType === WIRE.FIXED32) {
      const end = i + 4;
      if (!fieldCfg) { if (!skip(end)) return null; continue; }
      if (!pushSlice(end)) return null;
      continue;
    }

    if (wireType === WIRE.BYTES) {
      const len = decodeVarint(data, i);
      if (!len.ok) return null;
      const valStart = i + len.bytes;
      const valEnd   = valStart + len.value;
      if (valEnd > data.length) return null;

      if (!fieldCfg) { i = valEnd; continue; }

      // Only a field with subfields of its own is walked into. One marked to
      // keep every subfield has nothing to select, so it is copied whole below
      // — walking it with no configured subfields would select nothing and
      // drop the field entirely.
      if (fieldCfg.children) {
        const sub = extractReportingTokenContent(
          data.subarray(valStart, valEnd), fieldCfg.children || EMPTY_MAP
        );
        if (sub === null) return null;
        if (sub.length > 0) {
          out.push({
            num: fieldNum,
            bytes: Buffer.concat([encodeVarint(tag.value), encodeVarint(sub.length), sub])
          });
        }
        i = valEnd;
        continue;
      }

      out.push({ num: fieldNum, bytes: data.subarray(fieldStart, valEnd) });
      i = valEnd;
      continue;
    }

    return null;
  }

  if (out.length === 0) return Buffer.alloc(0);
  out.sort((a, b) => a.num - b.num);
  return Buffer.concat(out.map(f => f.bytes));
}

// ─── key derivation ──────────────────────────────────────────────────────────
//
// The same construction WhatsApp uses for every secret derived from a message
// secret — poll votes, reactions, and this. The use-case string is what keeps
// them from colliding.
function generateMsgSecretKey(modificationType, origMsgId, origMsgSender, modificationSender, origMsgSecret) {
  const useCaseSecret = Buffer.concat([
    Buffer.from(String(origMsgId), 'utf8'),
    Buffer.from(String(origMsgSender), 'utf8'),
    Buffer.from(String(modificationSender), 'utf8'),
    Buffer.from(modificationType, 'utf8')
  ]);
  return hkdfSha256(origMsgSecret, Buffer.alloc(32), useCaseSecret, 32);
}

// ─── reading what we need out of the encoded message ─────────────────────────

// Shallow scan for the top-level field numbers present, plus the message
// secret if MessageContextInfo carries one. Avoids decoding the whole message
// just to answer two questions about it.
function inspectMessage(plaintext) {
  const present = new Set();
  let messageSecret = null;
  let i = 0;

  while (i < plaintext.length) {
    const tag = decodeVarint(plaintext, i);
    if (!tag.ok) return { present, messageSecret, ok: false };
    const fieldNum = tag.value >> 3;
    const wireType = tag.value & 0x7;
    i += tag.bytes;
    present.add(fieldNum);

    if (wireType === WIRE.VARINT) {
      const v = decodeVarint(plaintext, i);
      if (!v.ok) return { present, messageSecret, ok: false };
      i += v.bytes;
    } else if (wireType === WIRE.FIXED64) {
      i += 8;
    } else if (wireType === WIRE.FIXED32) {
      i += 4;
    } else if (wireType === WIRE.BYTES) {
      const len = decodeVarint(plaintext, i);
      if (!len.ok) return { present, messageSecret, ok: false };
      const valStart = i + len.bytes;
      const valEnd   = valStart + len.value;
      if (valEnd > plaintext.length) return { present, messageSecret, ok: false };
      if (fieldNum === F_MESSAGE_CONTEXT_INFO) {
        messageSecret = readMessageSecret(plaintext.subarray(valStart, valEnd));
      }
      i = valEnd;
    } else {
      return { present, messageSecret, ok: false };
    }
  }
  return { present, messageSecret, ok: true };
}

function readMessageSecret(ctxBuf) {
  let i = 0;
  while (i < ctxBuf.length) {
    const tag = decodeVarint(ctxBuf, i);
    if (!tag.ok) return null;
    const fieldNum = tag.value >> 3;
    const wireType = tag.value & 0x7;
    i += tag.bytes;

    if (wireType === WIRE.VARINT) {
      const v = decodeVarint(ctxBuf, i);
      if (!v.ok) return null;
      i += v.bytes;
    } else if (wireType === WIRE.FIXED64) {
      i += 8;
    } else if (wireType === WIRE.FIXED32) {
      i += 4;
    } else if (wireType === WIRE.BYTES) {
      const len = decodeVarint(ctxBuf, i);
      if (!len.ok) return null;
      const valStart = i + len.bytes;
      const valEnd   = valStart + len.value;
      if (valEnd > ctxBuf.length) return null;
      if (fieldNum === F_CTX_MESSAGE_SECRET) return ctxBuf.subarray(valStart, valEnd);
      i = valEnd;
    } else {
      return null;
    }
  }
  return null;
}

/**
 * Whether a message of this shape carries a reporting token at all.
 *
 * Reactions and poll votes are excluded: they are modifications of somebody
 * else's message, and the token belongs to the message being modified.
 */
function shouldIncludeReportingToken(present) {
  return !present.has(F_REACTION) &&
         !present.has(F_ENC_REACTION) &&
         !present.has(F_ENC_EVENT_RESPONSE) &&
         !present.has(F_POLL_UPDATE);
}

/**
 * Build the <reporting> node for an outgoing message, or null when there is
 * nothing to attach.
 *
 * @param {object} opts
 *   plaintext    encoded Message protobuf, exactly as it will be encrypted
 *   msgId        the stanza id
 *   remoteJid    the destination JID
 *   participant  set only on a targeted resend; undefined otherwise
 *   BinaryNode   the node constructor
 */
function buildReportingNode(opts) {
  const { plaintext, msgId, remoteJid, participant, BinaryNode } = opts;
  if (!Buffer.isBuffer(plaintext) || !msgId || !remoteJid) return null;

  const info = inspectMessage(plaintext);
  if (!info.ok || !info.messageSecret || !info.messageSecret.length) return null;
  if (!shouldIncludeReportingToken(info.present)) return null;

  // fromMe is always true here — we only ever build this for our own sends.
  const from = String(remoteJid);
  const to   = String(participant || remoteJid);

  const reportingSecret = generateMsgSecretKey(
    ENC_SECRET_REPORT_TOKEN, msgId, from, to, info.messageSecret
  );

  const content = extractReportingTokenContent(plaintext, COMPILED);
  if (!content || content.length === 0) return null;

  const token = crypto.createHmac('sha256', reportingSecret)
    .update(content).digest().subarray(0, 16);

  return new BinaryNode('reporting', {}, [
    new BinaryNode('reporting_token', { v: '2' }, token)
  ]);
}

module.exports = {
  buildReportingNode,
  shouldIncludeReportingToken,
  extractReportingTokenContent,
  generateMsgSecretKey,
  inspectMessage,
  decodeVarint,
  encodeVarint,
  REPORTING_FIELDS,
  COMPILED
};
