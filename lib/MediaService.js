'use strict';

const crypto  = require('crypto');
const https   = require('https');
const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const { hkdf } = require('@noble/hashes/hkdf');
const { sha256 } = require('@noble/hashes/sha256');
const { getDeviceConfig } = require('./DeviceConfig');

const MEDIA_PATH = {
  image:    { path: 'mms/image',    keyName: 'WhatsApp Image Keys' },
  video:    { path: 'mms/video',    keyName: 'WhatsApp Video Keys' },
  audio:    { path: 'mms/audio',    keyName: 'WhatsApp Audio Keys' },
  ptt:      { path: 'mms/ptt',      keyName: 'WhatsApp Audio Keys' },
  document: { path: 'mms/document', keyName: 'WhatsApp Document Keys' },
  sticker:  { path: 'mms/sticker',  keyName: 'WhatsApp Image Keys' },
  gif:      { path: 'mms/gif',      keyName: 'WhatsApp Video Keys' }
};

// The web client does not have a path per media type. A sticker is uploaded to
// the image endpoint, a GIF and a voice note to the video and audio ones — the
// distinction lives in the message protobuf, not in the URL. Uploading a
// sticker to /mms/sticker as a companion gets a 404 from the CDN.
//
// The encryption key names are unchanged; those come from the media type and
// have nothing to do with the endpoint.
const WEB_MEDIA_PATH = {
  image:    'mms/image',
  video:    'mms/video',
  audio:    'mms/audio',
  ptt:      'mms/audio',
  document: 'mms/document',
  sticker:  'mms/image',
  gif:      'mms/video'
};

const WEB_ORIGIN_HEADER = 'https://web.whatsapp.com';
const WEB_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Safari/537.36';

// A companion is a browser as far as the CDN is concerned: it wants an Origin,
// and a mobile WhatsApp User-Agent on a web-issued auth token is a mismatch it
// can reject. A primary sends neither, exactly as before.
function mediaHeaders(web) {
  if (!web) {
    const d = getDeviceConfig();
    return {
      'User-Agent': d.os === 'android'
        ? `WhatsApp/${d.version || '2.26.7.75'} A`
        : `WhatsApp/${d.version || '2.26.7.75'} iOS/${d.osVersion} Device/${d.model}`
    };
  }
  return { 'User-Agent': WEB_USER_AGENT, 'Origin': WEB_ORIGIN_HEADER };
}

function mediaPathFor(mediaType, web) {
  if (web) return WEB_MEDIA_PATH[mediaType] || (MEDIA_PATH[mediaType] || {}).path;
  return (MEDIA_PATH[mediaType] || {}).path;
}

const EXPANDED_SIZE = 112;
const IV_LEN        = 16;
const KEY_LEN       = 32;
const MAC_LEN       = 10;

function deriveMediaKeyData(mediaKey, keyName) {
  const ikm  = Buffer.isBuffer(mediaKey) ? mediaKey : Buffer.from(mediaKey);
  const info = Buffer.from(keyName, 'utf8');
  return Buffer.from(hkdf(sha256, ikm, Buffer.alloc(0), info, EXPANDED_SIZE));
}

function encryptMedia(plaintext, mediaKey, keyName) {
  const expanded  = deriveMediaKeyData(mediaKey, keyName);
  const iv        = expanded.slice(0, IV_LEN);
  const cipherKey = expanded.slice(IV_LEN, IV_LEN + KEY_LEN);
  const macKey    = expanded.slice(IV_LEN + KEY_LEN, IV_LEN + KEY_LEN * 2);

  const cipher    = crypto.createCipheriv('aes-256-cbc', cipherKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  const mac = crypto.createHmac('sha256', macKey)
    .update(iv)
    .update(ciphertext)
    .digest()
    .slice(0, MAC_LEN);

  const encrypted = Buffer.concat([ciphertext, mac]);
  const sha256Plain = crypto.createHash('sha256').update(plaintext).digest();
  const sha256Enc   = crypto.createHash('sha256').update(encrypted).digest();

  return { encrypted, sha256Plain, sha256Enc, mediaKey };
}

function decryptMedia(encryptedWithMac, mediaKey, keyName) {
  const expanded   = deriveMediaKeyData(mediaKey, keyName);
  const iv         = expanded.slice(0, IV_LEN);
  const cipherKey  = expanded.slice(IV_LEN, IV_LEN + KEY_LEN);
  const macKey     = expanded.slice(IV_LEN + KEY_LEN, IV_LEN + KEY_LEN * 2);

  const ciphertext = encryptedWithMac.slice(0, -MAC_LEN);
  const mac        = encryptedWithMac.slice(-MAC_LEN);

  const expectedMac = crypto.createHmac('sha256', macKey)
    .update(iv)
    .update(ciphertext)
    .digest()
    .slice(0, MAC_LEN);

  if (!crypto.timingSafeEqual(mac, expectedMac)) {
    throw new Error('Media MAC verification failed');
  }

  const decipher = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// Upload encrypted media, trying every CDN host in turn.
//
// refreshAuth (optional) mirrors Baileys' refreshMediaConn(true): when a host
// answers but the upload yields no usable URL — the signature of an expired or
// rejected auth token — the auth is force-refreshed once and the hosts are
// retried with the fresh credentials. Without this a token that expires between
// the TTL check and the upload burns through every host and fails permanently
// ("connection expired"), because each retry reuses the same stale auth.
async function uploadMedia(mediaType, data, hosts, auth, refreshAuth, opts) {
  const typeInfo = MEDIA_PATH[mediaType];
  if (!typeInfo) throw new Error('Unknown media type: ' + mediaType);
  const web       = !!(opts && opts.web);
  const uploadPath = mediaPathFor(mediaType, web);

  const mediaKey        = crypto.randomBytes(32);
  const plaintext       = Buffer.isBuffer(data) ? data : fs.readFileSync(data);
  const { encrypted, sha256Plain, sha256Enc } = encryptMedia(plaintext, mediaKey, typeInfo.keyName);

  const token = sha256Enc.toString('base64url');

  let currentHosts = hosts || [];
  let currentAuth  = auth  || '';
  let refreshed    = false;

  const finish = (result) => ({
    url:          result.url         || '',
    directPath:   result.direct_path || result.directPath || '',
    mediaKey,
    fileSha256:   sha256Plain,
    fileEncSha256: sha256Enc,
    fileLength:   plaintext.length,
    mediaKeyTimestamp: Math.floor(Date.now() / 1000)
  });

  // Two passes at most: the original credentials, then the refreshed ones.
  for (let pass = 0; pass < 2; pass++) {
    const authEncoded = encodeURIComponent(currentAuth);
    let authRejected  = false;

    for (const host of currentHosts) {
      let res;
      try {
        res = await _tryUpload(host, uploadPath, token, authEncoded, encrypted, web);
      } catch (_) {
        continue;
      }
      if (res && res.body && (res.body.url || res.body.direct_path || res.body.directPath)) {
        return finish(res.body);
      }
      // 401/403 (and a 4xx with no usable body) mean the auth token is stale —
      // no other host will accept it either, so stop and refresh.
      if (res && res.status >= 400 && res.status < 500) {
        authRejected = true;
        break;
      }
    }

    if (!authRejected || refreshed || typeof refreshAuth !== 'function') break;

    // Force-refresh the media connection once, then retry with fresh creds.
    let fresh;
    try { fresh = await refreshAuth(); } catch (_) { break; }
    if (!fresh || !fresh.hosts || !fresh.hosts.length) break;
    currentHosts = fresh.hosts;
    currentAuth  = fresh.auth || '';
    refreshed    = true;
  }

  throw new Error('Failed to upload media to all available hosts');
}

// Resolves { status, body } — status 0 marks a transport-level failure, so the
// caller can tell an expired auth (4xx) apart from an unreachable host.
function _tryUpload(host, mediaPath, token, auth, encrypted, web) {
  return new Promise((resolve) => {
    const hostname = typeof host === 'string' ? host : host.hostname;
    const urlPath  = `/${mediaPath}/${token}?auth=${auth}&token=${token}`;

    const options = {
      hostname,
      port:    443,
      path:    urlPath,
      method:  'POST',
      headers: Object.assign({
        'Content-Type':   'application/octet-stream',
        'Content-Length': encrypted.length,
        'Accept':         'application/json'
      }, mediaHeaders(web))
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) {}
        resolve({ status: res.statusCode || 0, body });
      });
    });

    req.on('error', () => resolve({ status: 0, body: null }));
    req.write(encrypted);
    req.end();
  });
}

async function downloadMedia(url, mediaKey, keyName, opts) {
  const encrypted = await _httpGet(url, opts);
  return decryptMedia(encrypted, Buffer.from(mediaKey), keyName);
}

// The CDN applies the same Origin check on the way down as on the way up, so a
// companion has to identify itself as a browser here too.
function _httpGet(url, opts) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const web = !!(opts && opts.web);
    lib.get(url, { headers: mediaHeaders(web) }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return _httpGet(res.headers.location, opts).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function getMediaKeyName(mediaType) {
  const typeInfo = MEDIA_PATH[mediaType];
  return typeInfo ? typeInfo.keyName : null;
}

module.exports = {
  MEDIA_PATH,
  encryptMedia,
  decryptMedia,
  uploadMedia,
  downloadMedia,
  // Plain unauthenticated GET. Profile pictures are served in the clear, unlike
  // message media, so they need a fetch that does not try to decrypt anything.
  httpGetBuffer: _httpGet,
  deriveMediaKeyData,
  getMediaKeyName
};
