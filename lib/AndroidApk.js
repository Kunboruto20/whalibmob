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

// ─── Material ─────────────────────────────────────────────────────────────────

// Which build an APK is, read out of the binary AndroidManifest.xml.
//
// Cobalt takes the package name from the parsed manifest, having chosen it
// already to pick what to download — the two always agree. Rather than decode
// Android's binary XML for one string, this looks for the two names it can be
// in the manifest's UTF-16 string pool, business first so the longer name is
// not mistaken for the shorter one it contains.
function _packageNameFrom(manifest) {
  if (!manifest) return null;
  for (const name of [BUSINESS_PACKAGE, PERSONAL_PACKAGE]) {
    if (manifest.includes(Buffer.from(name, 'utf16le'))) return name;
    if (manifest.includes(Buffer.from(name, 'latin1')))  return name;
  }
  return null;
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

  const packageName = _packageNameFrom(readZipEntry(base, entries, 'AndroidManifest.xml'))
    || PERSONAL_PACKAGE;

  return {
    packageName,
    secretKey:     deriveSecretKey(packageName, aboutLogo),
    classesDexMd5: crypto.createHash('md5').update(classesDex).digest(),
    certificates
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

// ─── Storage ──────────────────────────────────────────────────────────────────
//
// Only the derived pieces are kept, the way Cobalt caches them — the APK itself
// is never needed again.

function materialToJson(material) {
  return {
    packageName:   material.packageName,
    secretKey:     material.secretKey.toString('base64'),
    classesDexMd5: material.classesDexMd5.toString('base64'),
    certificates:  material.certificates.map(c => c.toString('base64')),
    apkVersion:    material.apkVersion || null
  };
}

function materialFromJson(json) {
  if (!json || !json.secretKey || !json.classesDexMd5 || !Array.isArray(json.certificates)) {
    throw new Error('android APK material file is incomplete');
  }
  return {
    packageName:   json.packageName || PERSONAL_PACKAGE,
    secretKey:     Buffer.from(json.secretKey, 'base64'),
    classesDexMd5: Buffer.from(json.classesDexMd5, 'base64'),
    certificates:  json.certificates.map(c => Buffer.from(c, 'base64')),
    apkVersion:    json.apkVersion || null
  };
}

module.exports = {
  extractMaterial,
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
