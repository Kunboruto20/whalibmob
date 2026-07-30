'use strict';

// The Android registration token.
//
// iOS derives its token from a static string and the client version, and that
// is the algorithm this library used for both platforms — with a different
// constant substituted for Android. There is no such constant: the Android
// client signs the token with material taken out of its own APK, and no value
// put in WA_STATIC_TOKEN can stand in for it. Sending the iOS-shaped token as
// Android is answered with {"reason":"bad_token"}.
//
// What the native client actually computes, and what this file reproduces from
// Cobalt's WhatsAppAndroidClientInfo:
//
//   key   = PBKDF2-HMAC-SHA1(password = packageName || about_logo.png,
//                            salt = ANDROID_SALT, iterations = 128, dkLen = 64)
//   mac   = HMAC-SHA1(key) over each APK signing certificate in order,
//           then MD5(classes.dex), then the national number as ASCII
//   token = urlencode(base64(mac))
//
// The three pieces of material live in the APK, so they cannot be derived —
// they have to be read out of one. extractMaterial does that; the CLI's
// apk-material command drives it and writes the result where computeToken
// looks for it.

const crypto = require('crypto');
const zlib   = require('zlib');

// Reverse engineered from the Android binary and identical for the consumer and
// business builds. Cobalt notes it has been stable across many releases.
const ANDROID_SALT = Buffer.from(
  'PkTwKSZqUfAUyR0rPQ8hYJ0wNsQQ3dW1+3SCnyTXIfEAxxS75FwkDf47wNv/c8pP' +
  '3p0GXKR6OOQmhyERwx74fw1RYSU10I4r1gyBVDbRJ40pidjM41G1I1oN', 'base64');

// Where about_logo.png has shipped across releases. The base APK is searched in
// this order first; App Bundle releases moved density-qualified drawables into
// per-density splits, which is why the splits are searched after it.
const ABOUT_LOGO_PATHS = [
  'res/drawable-hdpi/about_logo.png',
  'res/drawable-hdpi-v4/about_logo.png',
  'res/drawable-xxhdpi-v4/about_logo.png'
];

const PERSONAL_PACKAGE = 'com.whatsapp';
const BUSINESS_PACKAGE = 'com.whatsapp.w4b';

const PBKDF2_ITERATIONS = 128;
const PBKDF2_KEY_SIZE   = 64;

// ─── ZIP ──────────────────────────────────────────────────────────────────────
//
// An APK is a ZIP. Only two things are needed from it — a named entry's bytes
// and the list of entry names — so this reads the central directory and inflates
// on demand rather than pulling in an archive library.

function _findEndOfCentralDirectory(buf) {
  // The record is 22 bytes plus a comment of up to 64 KiB, so it sits within the
  // last 64 KiB + 22. Scanning backwards finds the real one before any earlier
  // byte sequence that happens to look like the signature.
  const min = Math.max(0, buf.length - (0xffff + 22));
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

// name → { method, compressedSize, size, localHeaderOffset }, in central
// directory order.
function readZipDirectory(buf) {
  const eocd = _findEndOfCentralDirectory(buf);
  if (eocd < 0) throw new Error('not a zip archive: no end-of-central-directory record');

  let count  = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  // ZIP64: the 32-bit fields are saturated and the real ones live in the ZIP64
  // record the locator points at. A WhatsApp APK is far from needing it, but an
  // archive that does would otherwise be read as garbage rather than refused.
  if (count === 0xffff || offset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || buf.readUInt32LE(loc) !== 0x07064b50) {
      throw new Error('zip needs ZIP64 but carries no ZIP64 locator');
    }
    const z64 = Number(buf.readBigUInt64LE(loc + 8));
    if (buf.readUInt32LE(z64) !== 0x06064b50) throw new Error('bad ZIP64 end-of-central-directory');
    count  = Number(buf.readBigUInt64LE(z64 + 32));
    offset = Number(buf.readBigUInt64LE(z64 + 48));
  }

  const entries = new Map();
  let p = offset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method         = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size           = buf.readUInt32LE(p + 24);
    const nameLen        = buf.readUInt16LE(p + 28);
    const extraLen       = buf.readUInt16LE(p + 30);
    const commentLen     = buf.readUInt16LE(p + 32);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, compressedSize, size, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readZipEntry(buf, entries, name) {
  const e = entries.get(name);
  if (!e) return null;
  const lh = e.localHeaderOffset;
  if (buf.readUInt32LE(lh) !== 0x04034b50) throw new Error('bad local header for ' + name);
  // The local header's extra field is allowed to differ in length from the
  // central directory's, so the data offset is computed from the local one.
  const nameLen  = buf.readUInt16LE(lh + 26);
  const extraLen = buf.readUInt16LE(lh + 28);
  const start    = lh + 30 + nameLen + extraLen;
  const raw      = buf.slice(start, start + e.compressedSize);
  if (e.method === 0) return raw;
  if (e.method === 8) return zlib.inflateRawSync(raw);
  throw new Error('unsupported zip compression method ' + e.method + ' for ' + name);
}

// ─── DER / PKCS#7 ─────────────────────────────────────────────────────────────
//
// The signing certificates come out of the v1 (JAR) signature block, which is
// what Cobalt reads — apk-parser's getApkSingers() is the v1 signer list. Only
// enough DER is parsed to walk into SignedData and lift each certificate out
// whole; nothing here validates a signature.

function _readTlv(buf, pos) {
  const tag = buf[pos];
  let p = pos + 1;
  let len = buf[p++];
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0) throw new Error('indefinite DER length');
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | buf[p++];
  }
  return { tag, headerLength: p - pos, length: len, contentStart: p, end: p + len };
}

// Every certificate in a PKCS#7 SignedData, each as its own DER blob, in the
// order the structure carries them.
function certificatesFromPkcs7(der) {
  const contentInfo = _readTlv(der, 0);                 // SEQUENCE
  let p = contentInfo.contentStart;
  const oid = _readTlv(der, p);                         // contentType OID
  p = oid.end;
  const explicit = _readTlv(der, p);                    // [0] EXPLICIT
  const signedData = _readTlv(der, explicit.contentStart);

  // SignedData ::= version, digestAlgorithms, contentInfo, [0] certificates …
  let q = signedData.contentStart;
  while (q < signedData.end) {
    const field = _readTlv(der, q);
    if (field.tag === 0xa0) {                           // [0] IMPLICIT certificates
      const out = [];
      let c = field.contentStart;
      while (c < field.end) {
        const cert = _readTlv(der, c);
        if (cert.tag === 0x30) out.push(der.slice(c, cert.end));
        c = cert.end;
      }
      return out;
    }
    q = field.end;
  }
  return [];
}

// ─── Binary AndroidManifest.xml ───────────────────────────────────────────────
//
// The manifest inside an APK is Android's binary XML, not text. Three things are
// read out of it — the package name, the version name and the version code —
// the same three Cobalt takes from its parsed manifest. The version name is the
// one that matters most: the token is signed over this APK's classes.dex, so the
// version announced to the server has to be this APK's, not whatever the Play
// Store currently lists.
//
// Chunk layout is AOSP's ResourceTypes.h. Only what is needed to reach the
// attributes of the first element is decoded.

const _RES_STRING_POOL_TYPE     = 0x0001;
const _RES_XML_START_ELEMENT    = 0x0102;
const _UTF8_FLAG                = 0x0100;
const _TYPE_STRING              = 0x03;

function _readStringPool(buf, pos) {
  const size        = buf.readUInt32LE(pos + 4);
  const stringCount = buf.readUInt32LE(pos + 8);
  const flags       = buf.readUInt32LE(pos + 16);
  const stringsStart = buf.readUInt32LE(pos + 20);
  const utf8 = (flags & _UTF8_FLAG) !== 0;

  const strings = [];
  for (let i = 0; i < stringCount; i++) {
    const offset = buf.readUInt32LE(pos + 28 + i * 4);
    let p = pos + stringsStart + offset;
    if (p >= pos + size) { strings.push(''); continue; }
    if (utf8) {
      // Two lengths, characters then bytes, each one or two bytes wide.
      let charLen = buf[p++];
      if (charLen & 0x80) charLen = ((charLen & 0x7f) << 8) | buf[p++];
      let byteLen = buf[p++];
      if (byteLen & 0x80) byteLen = ((byteLen & 0x7f) << 8) | buf[p++];
      strings.push(buf.toString('utf8', p, p + byteLen));
    } else {
      let len = buf.readUInt16LE(p); p += 2;
      if (len & 0x8000) { len = ((len & 0x7fff) << 16) | buf.readUInt16LE(p); p += 2; }
      strings.push(buf.toString('utf16le', p, p + len * 2));
    }
  }
  return strings;
}

/**
 * { packageName, versionName, versionCode } out of a binary AndroidManifest.xml.
 * Any field the manifest does not carry comes back null.
 */
function parseManifest(buf) {
  const empty = { packageName: null, versionName: null, versionCode: null };
  if (!buf || buf.length < 8) return empty;

  let strings = null;
  let pos = 8;                                     // past the file's own chunk header
  while (pos + 8 <= buf.length) {
    const type      = buf.readUInt16LE(pos);
    const chunkSize = buf.readUInt32LE(pos + 4);
    if (chunkSize <= 0 || pos + chunkSize > buf.length) break;

    if (type === _RES_STRING_POOL_TYPE) {
      strings = _readStringPool(buf, pos);
    } else if (type === _RES_XML_START_ELEMENT && strings) {
      // ResXMLTree_node (8 bytes) then ResXMLTree_attrExt.
      const ext            = pos + 16;
      const nameIndex      = buf.readUInt32LE(ext + 4);
      const attributeStart = buf.readUInt16LE(ext + 8);
      const attributeSize  = buf.readUInt16LE(ext + 10);
      const attributeCount = buf.readUInt16LE(ext + 12);
      if (strings[nameIndex] !== 'manifest') { pos += chunkSize; continue; }

      const out = Object.assign({}, empty);
      for (let i = 0; i < attributeCount; i++) {
        const a        = ext + attributeStart + i * attributeSize;
        const attrName = strings[buf.readUInt32LE(a + 4)];
        const rawValue = buf.readUInt32LE(a + 8);
        const dataType = buf[a + 15];
        const data     = buf.readUInt32LE(a + 16);
        // A string attribute names its value in the pool twice — the raw source
        // text and the typed value. Either will do; the raw one is absent when
        // the manifest was written without it.
        const asString = () =>
          (rawValue !== 0xffffffff && strings[rawValue] !== undefined) ? strings[rawValue]
          : (dataType === _TYPE_STRING ? strings[data] : String(data));

        if (attrName === 'package')      out.packageName = asString();
        else if (attrName === 'versionName') out.versionName = asString();
        else if (attrName === 'versionCode') out.versionCode = dataType === _TYPE_STRING
          ? parseInt(strings[data], 10) : data;
      }
      return out;
    }
    pos += chunkSize;
  }
  return empty;
}

// A split's own name, as Android files it: "config.xxhdpi" out of
// "base-config.xxhdpi.apk" or "split_config.xxhdpi.apk". Cobalt only searches
// splits whose name ends in "dpi", which is the density-qualified set.
function _isDensitySplit(fileName) {
  const base = String(fileName).replace(/\.apk$/i, '');
  return /dpi$/i.test(base);
}

/**
 * Read the token material out of a WhatsApp APK.
 *
 * base:   Buffer with the base APK.
 * splits: optional [{ name, data }] for the density splits, searched only when
 *         the base APK does not carry about_logo.png — which is the case for
 *         every App Bundle release.
 *
 * Returns { packageName, secretKey, classesDexMd5, certificates } with the
 * three derived pieces as Buffers, ready for computeToken.
 */
function extractMaterial(base, splits) {
  const entries = readZipDirectory(base);

  let aboutLogo = null;
  for (const p of ABOUT_LOGO_PATHS) {
    aboutLogo = readZipEntry(base, entries, p);
    if (aboutLogo) break;
  }
  if (!aboutLogo) {
    for (const split of (splits || [])) {
      if (!_isDensitySplit(split.name)) continue;
      const sEntries = readZipDirectory(split.data);
      for (const p of ABOUT_LOGO_PATHS) {
        aboutLogo = readZipEntry(split.data, sEntries, p);
        if (aboutLogo) break;
      }
      if (aboutLogo) break;
    }
  }
  if (!aboutLogo) {
    throw new Error('about_logo.png is in neither the base APK nor any density split — ' +
      'pass the split APKs alongside the base one (' + ABOUT_LOGO_PATHS.join(', ') + ')');
  }

  const classesDex = readZipEntry(base, entries, 'classes.dex');
  if (!classesDex) throw new Error('classes.dex missing from the base APK');

  const certificates = [];
  for (const name of entries.keys()) {
    if (!/^META-INF\/[^/]+\.(RSA|DSA|EC)$/i.test(name)) continue;
    for (const cert of certificatesFromPkcs7(readZipEntry(base, entries, name))) {
      certificates.push(cert);
    }
  }
  if (!certificates.length) {
    throw new Error('no v1 signing certificate in META-INF — this APK is not JAR-signed, ' +
      'and the token is built from the v1 signature block');
  }

  const manifest    = parseManifest(readZipEntry(base, entries, 'AndroidManifest.xml'));
  const packageName = manifest.packageName || PERSONAL_PACKAGE;

  return {
    packageName,
    secretKey:     deriveSecretKey(packageName, aboutLogo),
    classesDexMd5: crypto.createHash('md5').update(classesDex).digest(),
    certificates,
    // The version this APK is. Announced instead of the live one, because the
    // token is signed over this build's classes.dex.
    apkVersion:     manifest.versionName,
    apkVersionCode: manifest.versionCode
  };
}

// PBKDF2-HMAC-SHA1 over the package name followed by the raw PNG bytes.
//
// Cobalt runs the derivation by hand because the JCA factory rejects a binary
// password; the loop it runs is standard PBKDF2, so this calls the platform's.
// The two are checked against each other in the token test.
function deriveSecretKey(packageName, aboutLogo) {
  const password = Buffer.concat([Buffer.from(packageName, 'utf8'), aboutLogo]);
  return crypto.pbkdf2Sync(password, ANDROID_SALT, PBKDF2_ITERATIONS, PBKDF2_KEY_SIZE, 'sha1');
}

/**
 * The registration token for a national number, as the Android client signs it.
 *
 * material: as returned by extractMaterial (or loaded from its JSON form).
 * national: the number without the country code, digits only.
 */
function computeToken(material, national) {
  const mac = crypto.createHmac('sha1', material.secretKey);
  for (const cert of material.certificates) mac.update(cert);
  mac.update(material.classesDexMd5);
  mac.update(Buffer.from(String(national), 'utf8'));
  // Java's URLEncoder over base64: '+', '/' and '=' are the only characters it
  // touches, and encodeURIComponent escapes those three identically.
  return encodeURIComponent(mac.digest().toString('base64'));
}

// Who signed the APK, so it can be told apart from a repack.
//
// The token is an HMAC over the signing certificates, so it is only the token
// the server expects when those certificates are WhatsApp's own. An APK a mirror
// re-signed carries the mirror's certificate instead and produces a token that
// is perfectly well-formed and belongs to nobody — which comes back as
// bad_token, indistinguishable from having no material at all. Reading the
// subject out is what turns that into something visible before it is sent.
//
// Returns null on a runtime without X509Certificate (Node < 15.6) rather than
// making the extraction depend on it.
function describeCertificate(der) {
  if (typeof crypto.X509Certificate !== 'function') return null;
  try {
    const cert = new crypto.X509Certificate(der);
    return {
      subject:       cert.subject.replace(/\n/g, ', '),
      issuer:        cert.issuer.replace(/\n/g, ', '),
      fingerprint256: cert.fingerprint256,
      validFrom:     cert.validFrom,
      validTo:       cert.validTo
    };
  } catch (_) {
    return null;
  }
}

// WhatsApp's own signing certificate names the company in its subject. A repack
// cannot keep that — re-signing replaces the certificate outright — so a subject
// without it is the one thing worth saying out loud.
function looksLikeWhatsAppCertificate(description) {
  return !!(description && /WhatsApp/i.test(description.subject));
}

// ─── Storage ──────────────────────────────────────────────────────────────────
//
// Only the derived pieces are kept, the way Cobalt caches them — the APK itself
// is never needed again.

function materialToJson(material) {
  return {
    packageName:    material.packageName,
    secretKey:      material.secretKey.toString('base64'),
    classesDexMd5:  material.classesDexMd5.toString('base64'),
    certificates:   material.certificates.map(c => c.toString('base64')),
    apkVersion:     material.apkVersion || null,
    apkVersionCode: material.apkVersionCode || null
  };
}

function materialFromJson(json) {
  if (!json || !json.secretKey || !json.classesDexMd5 || !Array.isArray(json.certificates)) {
    throw new Error('android APK material file is incomplete');
  }
  return {
    packageName:    json.packageName || PERSONAL_PACKAGE,
    secretKey:      Buffer.from(json.secretKey, 'base64'),
    classesDexMd5:  Buffer.from(json.classesDexMd5, 'base64'),
    certificates:   json.certificates.map(c => Buffer.from(c, 'base64')),
    apkVersion:     json.apkVersion || null,
    apkVersionCode: json.apkVersionCode || null
  };
}

module.exports = {
  extractMaterial,
  parseManifest,
  describeCertificate,
  looksLikeWhatsAppCertificate,
  deriveSecretKey,
  computeToken,
  materialToJson,
  materialFromJson,
  certificatesFromPkcs7,
  readZipDirectory,
  readZipEntry,
  ANDROID_SALT,
  ABOUT_LOGO_PATHS,
  PERSONAL_PACKAGE,
  BUSINESS_PACKAGE
};
