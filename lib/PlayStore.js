'use strict';

// Fetching the WhatsApp APK from Google Play, the way Cobalt's PlayStoreUtils
// does it, so the Android token material can be refreshed without anyone having
// to find an APK by hand.
//
// The route, in three hops:
//
//   1. POST an Aurora-style device profile to the Aurora OSS token dispenser,
//      which mints an anonymous Google account and hands back a Play auth token
//      plus the device metadata that has to accompany it. No Google account of
//      the caller's is involved at any point.
//   2. GET /fdfe/details for the version, then /fdfe/purchase to acquire the
//      free app, then /fdfe/delivery for the signed CDN URLs. All three answer
//      in protobuf.
//   3. GET each URL with the delivery cookies attached, which yields the base
//      APK and every split.
//
// Two things are worth knowing before relying on this. The dispenser is a free
// third-party service — when it is down or rate limited, so is this, and the
// APK on a phone is always available where this is not. And a current WhatsApp
// bundle is well over a hundred megabytes across its splits, which is a real
// download on a phone connection; only the density splits are actually needed
// for the token, so this fetches only those.

const https = require('https');
const { URL } = require('url');
const DEVICE_PROFILE = require('./playstore-device');
const { dbg: _whaDbg } = require('./logger');

const AURORA_DISPENSER_URL = 'https://auroraoss.com/api/auth';
// The dispenser refuses a request with an arbitrary user-agent.
const AURORA_USER_AGENT    = 'com.aurora.store-4.6.1-70';

const FDFE_BASE_URL = 'https://android.clients.google.com/fdfe';
const DETAILS_URL   = FDFE_BASE_URL + '/details';
const PURCHASE_URL  = FDFE_BASE_URL + '/purchase';
const DELIVERY_URL  = FDFE_BASE_URL + '/delivery';

// Which Play protocol features the client claims to understand. The same blob
// gplaydl and the Aurora Store ship; required on every FDFE call.
const X_DFE_ENCODED_TARGETS =
  'CAESN/qigQYC2AMBFfUbyA7SM5Ij/CvfBoIDgxXrBPsDlQUdMfOLAfoFrwEHgAcBrQYhoA0cGt4MKK0Y2gI';

const FALLBACK_FINSKY_USER_AGENT =
  'Android-Finsky/41.2.29-23 [0] [PR] 639844241 ' +
  '(api=3,versionCode=84122900,sdk=34,device=lynx,' +
  'hardware=lynx,product=lynx,platformVersionRelease=14,' +
  'model=Pixel%207a,buildId=UQ1A.231205.015,' +
  'isWideScreen=0,supportedAbis=arm64-v8a;armeabi-v7a;armeabi)';

const LOCALE          = 'en_US';
const REQUEST_TIMEOUT = 120000;

const PERSONAL_PACKAGE = 'com.whatsapp';

// ─── protobuf ─────────────────────────────────────────────────────────────────
//
// Only enough of the wire format to walk to a handful of known fields. Every
// message here is read by field number, and anything unrecognised is skipped —
// which is most of what Play returns.

function _readVarint(buf, pos) {
  let result = 0, shift = 0, byte;
  do {
    if (pos >= buf.length) throw new Error('truncated varint');
    byte = buf[pos++];
    result += (byte & 0x7f) * Math.pow(2, shift);
    shift += 7;
  } while (byte & 0x80);
  return { value: result, pos };
}

// field number → array of values. Length-delimited fields come back as Buffers,
// varints as numbers; everything else is skipped.
function decodeFields(buf) {
  const out = new Map();
  let pos = 0;
  while (pos < buf.length) {
    let key;
    try { ({ value: key, pos } = _readVarint(buf, pos)); } catch (_) { break; }
    const field    = Math.floor(key / 8);
    const wireType = key & 7;
    let value;
    if (wireType === 0) {
      ({ value, pos } = _readVarint(buf, pos));
    } else if (wireType === 2) {
      let len;
      ({ value: len, pos } = _readVarint(buf, pos));
      if (pos + len > buf.length) break;
      value = buf.slice(pos, pos + len);
      pos += len;
    } else if (wireType === 5) {
      value = buf.readUInt32LE(pos); pos += 4;
    } else if (wireType === 1) {
      value = buf.slice(pos, pos + 8); pos += 8;
    } else {
      break;                              // groups: not used by these messages
    }
    if (!out.has(field)) out.set(field, []);
    out.get(field).push(value);
  }
  return out;
}

function _one(fields, n) {
  const v = fields && fields.get(n);
  return v && v.length ? v[0] : null;
}

// Walk a chain of message field numbers, e.g. msg(1).msg(2).msg(21).
function _walk(buf, path) {
  let cur = buf;
  for (const n of path) {
    const next = _one(decodeFields(cur), n);
    if (next === null || !Buffer.isBuffer(next)) return null;
    cur = next;
  }
  return cur;
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

function _request(url, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const u   = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      port:     u.port || 443,
      path:     u.pathname + u.search,
      method:   opts.method || 'GET',
      headers:  opts.headers || {},
      timeout:  REQUEST_TIMEOUT
    }, (res) => {
      // The CDN answers a signed URL with a redirect more often than not.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location &&
          (opts.redirects || 0) < 5) {
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
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function fetchAnonymousAuth() {
  const body = JSON.stringify(DEVICE_PROFILE);
  const res  = await _request(AURORA_DISPENSER_URL, {
    method:  'POST',
    headers: {
      'Content-Type':   'application/json',
      'User-Agent':     AURORA_USER_AGENT,
      'Content-Length': Buffer.byteLength(body)
    },
    body
  });
  if (res.status !== 200) {
    throw new Error('the Aurora token dispenser answered HTTP ' + res.status +
      ' — it is a free third-party service and this is what it does when it is ' +
      'down or rate limiting. Nothing is wrong with your setup; either try again ' +
      'later or pass an APK path instead.');
  }

  let json;
  try { json = JSON.parse(res.body.toString('utf8')); }
  catch (_) { throw new Error('the Aurora token dispenser returned something that is not JSON'); }
  if (!json || !json.authToken) {
    throw new Error('the Aurora token dispenser returned no authToken');
  }

  const provider = json.deviceInfoProvider || {};
  return {
    authToken:  json.authToken,
    gsfId:      json.gsfId    || '',
    dfeCookie:  json.dfeCookie || '',
    checkinConsistencyToken: json.deviceCheckInConsistencyToken || null,
    deviceConfigToken:       json.deviceConfigToken || null,
    userAgent:  provider.userAgentString || FALLBACK_FINSKY_USER_AGENT,
    mccMnc:     provider.mccMnc || null
  };
}

function buildFdfeHeaders(auth) {
  const headers = {
    'Authorization':               'Bearer ' + auth.authToken,
    'User-Agent':                  auth.userAgent,
    'X-DFE-Device-Id':             auth.gsfId,
    'Accept-Language':             'en-US',
    'X-DFE-Encoded-Targets':       X_DFE_ENCODED_TARGETS,
    'X-DFE-Client-Id':             'am-android-google',
    'X-DFE-Network-Type':          '4',
    'X-DFE-Content-Filters':       '',
    'X-Limit-Ad-Tracking-Enabled': 'false',
    'X-Ad-Id':                     '',
    'X-DFE-UserLanguages':         LOCALE,
    'X-DFE-Request-Params':        'timeoutMs=4000',
    'X-DFE-Cookie':                auth.dfeCookie,
    'X-DFE-No-Prefetch':           'true'
  };
  if (auth.checkinConsistencyToken) headers['X-DFE-Device-Checkin-Consistency-Token'] = auth.checkinConsistencyToken;
  if (auth.deviceConfigToken)       headers['X-DFE-Device-Config-Token']              = auth.deviceConfigToken;
  if (auth.mccMnc)                  headers['X-DFE-MCCMNC']                           = auth.mccMnc;
  return headers;
}

async function _protoGet(url, headers) {
  const res = await _request(url, {
    headers: Object.assign({
      'Content-Type': 'application/x-protobuf',
      'Accept':       'application/x-protobuf'
    }, headers)
  });
  if (res.status !== 200) throw new Error('GET ' + url + ' returned HTTP ' + res.status);
  return res.body;
}

// ─── Catalogue ────────────────────────────────────────────────────────────────

// { versionCode, versionName } for a package, without downloading anything.
async function fetchVersion(packageName, headers) {
  const raw = await _protoGet(DETAILS_URL + '?doc=' + encodeURIComponent(packageName), headers);
  // ResponseWrapper(1).Payload → detailsResponse(2).docV2(4).docDetails(13).appDetails(1)
  const details = _walk(raw, [1, 2, 4, 13, 1]);
  if (!details) throw new Error('the Play details response carried no AppDetails for ' + packageName);
  const fields = decodeFields(details);
  const code   = _one(fields, 3);
  const name   = _one(fields, 4);
  if (code === null) throw new Error('the Play details response carried no versionCode for ' + packageName);
  return { versionCode: code, versionName: name ? name.toString('utf8') : '' };
}

// The "Install" button. An app already associated with the rotated account
// answers 4xx, and the download works regardless, so failures are ignored.
async function acquire(packageName, versionCode, headers) {
  const body = 'doc=' + encodeURIComponent(packageName) + '&ot=1&vc=' + versionCode;
  try {
    await _request(PURCHASE_URL, {
      method: 'POST',
      headers: Object.assign({
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }, headers),
      body
    });
  } catch (_) { /* best effort, as in Cobalt */ }
}

// { baseUrl, splits: [{name, url}], cookies: {name: value} }
async function fetchDelivery(packageName, versionCode, headers) {
  const raw = await _protoGet(
    DELIVERY_URL + '?doc=' + encodeURIComponent(packageName) + '&ot=1&vc=' + versionCode,
    headers);
  // ResponseWrapper(1).Payload → deliveryResponse(21).appDeliveryData(2)
  const data = _walk(raw, [1, 21, 2]);
  if (!data) throw new Error('the Play delivery response carried no AppDeliveryData for ' + packageName);

  const fields  = decodeFields(data);
  const baseUrl = _one(fields, 3);
  if (!baseUrl || !baseUrl.length) {
    throw new Error('Play issued no download URL for ' + packageName +
      ' — the app is unavailable for this synthetic device profile');
  }

  const splits = [];
  for (const s of (fields.get(15) || [])) {
    const sf   = decodeFields(s);
    const name = _one(sf, 1);
    const url  = _one(sf, 5);
    if (!url || !url.length) continue;
    splits.push({
      name: name ? name.toString('utf8') : 'split-' + splits.length,
      url:  url.toString('utf8')
    });
  }

  // Tag 4 is overloaded: cookies and OBB metadata share it. A cookie starts with
  // the tag byte for a length-delimited field 1 (its name), which is what tells
  // the two apart.
  const cookies = {};
  for (const entry of (fields.get(4) || [])) {
    if (!entry.length || entry[0] !== 0x0a) continue;
    const cf    = decodeFields(entry);
    const name  = _one(cf, 1);
    const value = _one(cf, 2);
    if (!name || !name.length) continue;
    cookies[name.toString('utf8')] = value ? value.toString('utf8') : '';
  }

  return { baseUrl: baseUrl.toString('utf8'), splits, cookies };
}

async function _download(url, cookies) {
  const headers = {};
  const pairs   = Object.keys(cookies || {}).map(k => k + '=' + cookies[k]);
  if (pairs.length) headers.Cookie = pairs.join('; ');
  const res = await _request(url, { headers });
  if (res.status < 200 || res.status >= 300) {
    throw new Error('APK download failed with HTTP ' + res.status);
  }
  return res.body;
}

/**
 * Download what the Android token material needs from Play.
 *
 * Returns { packageName, versionCode, versionName, base, splits: [{name,data}] }
 * with the APK bytes in hand.
 *
 * Only the density splits are fetched. The token's key comes from
 * about_logo.png, which lives in one of those; the architecture and language
 * splits are a hundred megabytes that nothing here would ever read. Pass
 * { allSplits: true } to take everything anyway.
 */
async function downloadApk(opts) {
  opts = opts || {};
  const packageName = opts.packageName || PERSONAL_PACKAGE;

  _whaDbg('[DBG] PLAY → dispenser');
  const auth    = await fetchAnonymousAuth();
  const headers = buildFdfeHeaders(auth);

  _whaDbg('[DBG] PLAY → details ' + packageName);
  const version = await fetchVersion(packageName, headers);
  if (opts.onProgress) opts.onProgress('version ' + version.versionName + ' (code ' + version.versionCode + ')');

  await acquire(packageName, version.versionCode, headers);

  _whaDbg('[DBG] PLAY → delivery ' + packageName + ' vc=' + version.versionCode);
  const delivery = await fetchDelivery(packageName, version.versionCode, headers);

  const wanted = opts.allSplits
    ? delivery.splits
    : delivery.splits.filter(s => /dpi$/i.test(String(s.name).replace(/\.apk$/i, '')));

  if (opts.onProgress) {
    opts.onProgress('downloading base.apk and ' + wanted.length + ' density split' +
      (wanted.length === 1 ? '' : 's') +
      ' (of ' + delivery.splits.length + ' the server offered)');
  }

  const base = await _download(delivery.baseUrl, delivery.cookies);
  const splits = [];
  for (const s of wanted) {
    if (opts.onProgress) opts.onProgress('  ' + s.name);
    splits.push({ name: s.name, data: await _download(s.url, delivery.cookies) });
  }

  return {
    packageName,
    versionCode: version.versionCode,
    versionName: version.versionName,
    base,
    splits
  };
}

module.exports = {
  downloadApk,
  fetchAnonymousAuth,
  buildFdfeHeaders,
  fetchVersion,
  fetchDelivery,
  decodeFields,
  AURORA_DISPENSER_URL,
  PERSONAL_PACKAGE
};
