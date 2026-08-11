'use strict';

function encodeVarint(n) {
  const out = [];
  let v = BigInt(n);
  while (v > 127n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}

function writeField(fieldNum, wireType, valueBytes) {
  const tag = (fieldNum << 3) | wireType;
  return Buffer.concat([encodeVarint(tag), valueBytes]);
}

function varint(v) { return encodeVarint(v); }
function bytes(b) { return Buffer.concat([encodeVarint(b.length), b]); }
function string(s) { return bytes(Buffer.from(s, 'utf8')); }
function bool(v) { return varint(v ? 1 : 0); }

function field(num, type, v) { return writeField(num, type, v); }
const VARINT = 0, FIXED32 = 5, LEN = 2;

function encodeVersion(major, minor, patch, q) {
  const parts = [];
  if (major !== undefined && major !== null) parts.push(field(1, VARINT, varint(major)));
  if (minor !== undefined && minor !== null) parts.push(field(2, VARINT, varint(minor)));
  if (patch !== undefined && patch !== null) parts.push(field(3, VARINT, varint(patch)));
  if (q !== undefined && q !== null) parts.push(field(4, VARINT, varint(q)));
  return Buffer.concat(parts);
}

function encodeUserAgent({ platform, version, mcc, mnc, osVersion, manufacturer, device, osBuildNumber, phoneId, releaseChannel, localeLanguage, localeCountry, deviceType, deviceModelType }) {
  const versionBuf = encodeVersion(...version.split('.').map(Number));
  const parts = [
    field(1, VARINT, varint(platform)),
    field(2, LEN, bytes(versionBuf)),
    field(3, LEN, string(mcc || '000')),
    field(4, LEN, string(mnc || '000'))
  ];
  if (osVersion) parts.push(field(5, LEN, string(osVersion)));
  if (manufacturer) parts.push(field(6, LEN, string(manufacturer)));
  if (device) parts.push(field(7, LEN, string(String(device).replace(/_/g, ' '))));
  if (osBuildNumber) parts.push(field(8, LEN, string(osBuildNumber)));
  if (phoneId) parts.push(field(9, LEN, string(phoneId)));
  parts.push(field(10, VARINT, varint(releaseChannel || 0)));
  parts.push(field(11, LEN, string(localeLanguage || 'en')));
  parts.push(field(12, LEN, string(localeCountry || 'US')));
  if (deviceType !== undefined) parts.push(field(15, VARINT, varint(deviceType)));
  if (deviceModelType) parts.push(field(16, LEN, string(deviceModelType)));
  return Buffer.concat(parts);
}

function encodeClientPayload({ username, passive, userAgent, pushName, shortConnect, connectType, connectReason, connectAttemptCount, device, oc }) {
  const uaBuf = encodeUserAgent(userAgent);
  const parts = [
    field(1, VARINT, varint(username)),
    field(3, VARINT, bool(passive)),
    field(5, LEN, bytes(uaBuf))
  ];
  if (pushName) parts.push(field(7, LEN, string(pushName)));
  if (shortConnect !== undefined) parts.push(field(10, VARINT, bool(shortConnect)));
  if (connectType !== undefined) parts.push(field(12, VARINT, varint(connectType)));
  if (connectReason !== undefined) parts.push(field(13, VARINT, varint(connectReason)));
  if (connectAttemptCount !== undefined) parts.push(field(16, VARINT, varint(connectAttemptCount)));
  if (device !== undefined) parts.push(field(18, VARINT, varint(device)));
  if (oc !== undefined) parts.push(field(23, VARINT, bool(oc)));
  return Buffer.concat(parts);
}

function encodeClientHello(ephemeralPublic) {
  return field(1, LEN, bytes(ephemeralPublic));
}

function encodeClientFinish(staticEncrypted, payloadEncrypted) {
  return Buffer.concat([
    field(1, LEN, bytes(staticEncrypted)),
    field(2, LEN, bytes(payloadEncrypted))
  ]);
}

function encodeHandshakeClientHello(ephemeralPublic) {
  const clientHello = encodeClientHello(ephemeralPublic);
  return field(2, LEN, bytes(clientHello));
}

function encodeHandshakeClientFinish(staticEnc, payloadEnc) {
  const cf = encodeClientFinish(staticEnc, payloadEnc);
  return field(4, LEN, bytes(cf));
}

function decodeServerHello(buf) {
  let offset = 0;
  let ephemeral = null, staticEnc = null, payload = null;

  function readVarint() {
    let result = 0, shift = 0;
    while (offset < buf.length) {
      const b = buf[offset++];
      result |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    return result;
  }

  while (offset < buf.length) {
    const tag = readVarint();
    const fieldNum = tag >> 3;
    const wireType = tag & 7;
    if (wireType === 2) {
      const len = readVarint();
      const data = buf.slice(offset, offset + len);
      offset += len;

      if (fieldNum === 3) {
        let inner = 0;
        function readInnerVarint() {
          let r = 0, s = 0;
          while (inner < data.length) {
            const b = data[inner++];
            r |= (b & 0x7f) << s;
            if (!(b & 0x80)) break;
            s += 7;
          }
          return r;
        }
        while (inner < data.length) {
          const t = readInnerVarint();
          const fn = t >> 3;
          const wt = t & 7;
          if (wt === 2) {
            const l = readInnerVarint();
            const d = data.slice(inner, inner + l);
            inner += l;
            if (fn === 1) ephemeral = d;
            else if (fn === 2) staticEnc = d;
            else if (fn === 3) payload = d;
          }
        }
      }
    } else if (wireType === 0) {
      readVarint();
    }
  }
  return { ephemeral, staticEnc, payload };
}

module.exports = { encodeClientPayload, encodeHandshakeClientHello, encodeHandshakeClientFinish, decodeServerHello, encodeVersion };
