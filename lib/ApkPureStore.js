'use strict';
//
// A second source for the Android token material, used when the Google Play
// route in PlayStore.js cannot reach the Aurora dispenser.
//
// APKPure serves the app as an XAPK — a ZIP that holds the base APK and its
// config splits side by side. We fetch that one file, read the base APK and the
// density splits out of it, and hand back the exact shape
// PlayStore.downloadApk returns, so everything downstream — the key from
// about_logo.png, the classes.dex hash, the signing certificate, the token —
// is derived byte for byte the same way regardless of which source the bytes
// came from.
//
// It is a fallback, never the primary route. APKPure sits behind the same kind
// of anti-bot filtering that blocks datacenter IPs, so it answers where a
// residential proxy does and 403s where it does not — the proxy the rest of the
// library already uses is attached here too. And the APK on a phone, passed to
// `wa apk-material <base.apk>`, is always available where neither source is.
//
// The download is whatever the endpoint hands back, so both shapes are handled:
// an XAPK/APKM bundle (a ZIP of .apk entries) is unpacked into base + splits,
// and a plain single APK (a ZIP carrying AndroidManifest.xml at its root) is
// used as the base with no splits.

const https = require('https');
const { URL } = require('url');
const { dbg: _whaDbg } = require('./logger');
const {
  readZipDirectory,
  readZipEntry,
  parseManifest,
  certificatesFromPkcs7,
  describeCertificate,
  looksLikeWhatsAppCertificate,
  PERSONAL_PACKAGE
} = require('./AndroidApk');

const REQUEST_TIMEOUT = 120000;

// A browser-shaped User-Agent. The bare Node default is refused outright, and a
// mobile Chrome string is what a phone fetching the same file would send.
const BROWSER_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7a) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

// The bundle endpoint. ?version=latest resolves to the newest build server-side.
// WA_APK_FALLBACK_URL overrides it (a {pkg} placeholder is filled with the
// package name), for a different mirror or a pinned version.
function _fallbackUrl(packageName) {
  const tpl = process.env.WA_APK_FALLBACK_URL;
  if (tpl) return tpl.replace('{pkg}', encodeURIComponent(packageName));
  return 'https://d.apkpure.com/b/XAPK/' + encodeURIComponent(packageName) + '?version=latest';
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

function _request(url, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    // The same proxy the Google Play route and registration use. A mirror is
    // reachable from a residential exit where a datacenter one is filtered, and
    // routing it anywhere else than the rest of the traffic would defeat that.
    const { proxyAgent } = require('./socks');
    const agent = proxyAgent();
    const req = https.request({
      hostname: u.hostname,
      port:     u.port || 443,
      path:     u.pathname + u.search,
      method:   'GET',
      headers:  opts.headers || {},
      agent:    agent || undefined,
      timeout:  REQUEST_TIMEOUT
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location &&
          (opts.redirects || 0) < 6) {
        res.resume();
        return resolve(_request(new URL(res.headers.location, url).toString(),
          Object.assign({}, opts, { redirects: (opts.redirects || 0) + 1 })));
      }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout on ' + url)));
    req.end();
  });
}

// ─── Bundle layout ──────────────────────────────────────────────────────────

// A config split names itself `split_config.<x>.apk` or `config.<x>.apk`; the
// base is the .apk that is neither. Of the config splits only the density ones
// carry about_logo.png, and a density split's name (without .apk) ends in `dpi`
// — the same rule PlayStore and AndroidApk apply.
function _isConfigSplit(name) {
  const base = String(name).replace(/^.*\//, '');
  return /^split[_.]/i.test(base) || /(^|[._-])config[._-]/i.test(base);
}

function _isDensityName(name) {
  return /dpi$/i.test(String(name).replace(/\.apk$/i, ''));
}

/**
 * Pick the base APK and the density splits out of a bundle's entry names.
 *
 * Returns { baseName, splitNames }. baseName is null when no base-like .apk is
 * present, which the caller treats as "not a bundle".
 */
function _classifyBundle(names, packageName) {
  const apks = names.filter(n => /\.apk$/i.test(n));
  const nonSplits = apks.filter(n => !_isConfigSplit(n));
  const configSplits = apks.filter(_isConfigSplit);

  const wantPkg = String(packageName || '').toLowerCase() + '.apk';
  const baseName =
    nonSplits.find(n => n.replace(/^.*\//, '').toLowerCase() === wantPkg) ||
    nonSplits.find(n => /(^|\/)base\.apk$/i.test(n)) ||
    nonSplits[0] ||
    null;

  const splitNames = configSplits.filter(_isDensityName);
  return { baseName, splitNames };
}

// Whether a ZIP is a single APK rather than a bundle: an APK carries the binary
// manifest at its root, a bundle carries .apk entries instead.
function _looksLikeApk(entries) {
  return entries.has('AndroidManifest.xml');
}

// Confirm the APK was signed by WhatsApp before its material is trusted. The
// mirror is not Google Play, so a repacked or wrong APK has to be caught here
// rather than discovered as a token the server rejects.
function _assertWhatsAppSigned(base, entries) {
  const certs = [];
  for (const name of entries.keys()) {
    if (!/^META-INF\/[^/]+\.(RSA|DSA|EC)$/i.test(name)) continue;
    for (const cert of certificatesFromPkcs7(readZipEntry(base, entries, name))) {
      certs.push(cert);
    }
  }
  if (!certs.length) {
    throw new Error('the downloaded APK is not JAR-signed — refusing it');
  }
  // X509Certificate is absent on very old Node; there the subject cannot be read
  // and the check is skipped rather than failing a download it cannot inspect.
  if (typeof require('crypto').X509Certificate !== 'function') return;
  const genuine = certs.some(c => looksLikeWhatsAppCertificate(describeCertificate(c)));
  if (!genuine) {
    throw new Error('the downloaded APK is not signed by WhatsApp — refusing a repack');
  }
}

// ─── Download ─────────────────────────────────────────────────────────────────

/**
 * Fetch the WhatsApp APK from the fallback mirror.
 *
 * Returns { packageName, versionCode, versionName, base, splits: [{name,data}] }
 * — the same shape as PlayStore.downloadApk, so extractMaterial consumes it
 * unchanged.
 */
async function downloadApk(opts) {
  opts = opts || {};
  const packageName = opts.packageName || PERSONAL_PACKAGE;
  const url = _fallbackUrl(packageName);

  if (opts.onProgress) opts.onProgress('fetching ' + packageName + ' from the APK mirror');
  _whaDbg('[DBG] APKMIRROR → ' + url);

  const res = await _request(url, { headers: { 'User-Agent': BROWSER_UA, 'Accept': '*/*' } });
  if (res.status !== 200) {
    throw new Error('the APK mirror answered HTTP ' + res.status +
      ' — it filters automated requests the way the dispenser does; try again later ' +
      'or pass an APK path with `wa apk-material <base.apk>`');
  }
  if (!res.body || res.body.length < 1024) {
    throw new Error('the APK mirror returned ' + (res.body ? res.body.length : 0) +
      ' bytes — not an APK');
  }

  let outer;
  try {
    outer = readZipDirectory(res.body);
  } catch (e) {
    throw new Error('the APK mirror did not return a ZIP (XAPK/APK): ' + e.message);
  }

  let base, splits;
  if (_looksLikeApk(outer)) {
    // A plain APK is itself the base; it carries no splits.
    base = res.body;
    splits = [];
  } else {
    const names = Array.from(outer.keys());
    const { baseName, splitNames } = _classifyBundle(names, packageName);
    if (!baseName) {
      throw new Error('the downloaded bundle holds no base APK (entries: ' +
        names.filter(n => /\.apk$/i.test(n)).join(', ') + ')');
    }
    base = readZipEntry(res.body, outer, baseName);
    if (!base) throw new Error('could not read ' + baseName + ' out of the bundle');
    splits = [];
    for (const name of splitNames) {
      const data = readZipEntry(res.body, outer, name);
      if (data) splits.push({ name: name.replace(/^.*\//, ''), data });
    }
    if (opts.onProgress) {
      opts.onProgress('unpacked base.apk and ' + splits.length + ' density split' +
        (splits.length === 1 ? '' : 's') + ' from the bundle');
    }
  }

  const baseEntries = readZipDirectory(base);
  _assertWhatsAppSigned(base, baseEntries);

  const manifestBuf = readZipEntry(base, baseEntries, 'AndroidManifest.xml');
  if (!manifestBuf) throw new Error('the base APK carries no AndroidManifest.xml');
  const manifest = parseManifest(manifestBuf);

  if (manifest.packageName && manifest.packageName !== packageName) {
    throw new Error('the mirror served ' + manifest.packageName + ', not ' + packageName);
  }

  if (opts.onProgress) {
    opts.onProgress('version ' + (manifest.versionName || '?') +
      ' (code ' + (manifest.versionCode == null ? '?' : manifest.versionCode) + ')');
  }

  return {
    packageName: manifest.packageName || packageName,
    versionCode: manifest.versionCode,
    versionName: manifest.versionName || '',
    base,
    splits
  };
}

module.exports = {
  downloadApk,
  // Exposed for tests; not part of the public API.
  _classifyBundle
};
