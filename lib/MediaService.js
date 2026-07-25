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

async function uploadMedia(mediaType, data, hosts, auth) {
  const typeInfo = MEDIA_PATH[mediaType];
  if (!typeInfo) throw new Error('Unknown media type: ' + mediaType);

  const mediaKey        = crypto.randomBytes(32);
  const plaintext       = Buffer.isBuffer(data) ? data : fs.readFileSync(data);
  const { encrypted, sha256Plain, sha256Enc } = encryptMedia(plaintext, mediaKey, typeInfo.keyName);

  const token = sha256Enc.toString('base64url');
  const authEncoded = encodeURIComponent(auth || '');

  for (const host of hosts) {
    try {
      const result = await _tryUpload(host, typeInfo.path, token, authEncoded, encrypted, sha256Enc, sha256Plain);
      if (result) {
        return {
          url:          result.url        || '',
          directPath:   result.direct_path || result.directPath || '',
          mediaKey,
          fileSha256:   sha256Plain,
          fileEncSha256: sha256Enc,
          fileLength:   plaintext.length,
          mediaKeyTimestamp: Math.floor(Date.now() / 1000)
        };
      }
    } catch (_) {}
  }

  throw new Error('Failed to upload media to all available hosts');
}

function _tryUpload(host, mediaPath, token, auth, encrypted, encSha256, sha256) {
  return new Promise((resolve, reject) => {
    const hostname = typeof host === 'string' ? host : host.hostname;
    const urlPath  = `/${mediaPath}/${token}?auth=${auth}&token=${token}`;

    const options = {
      hostname,
      port:    443,
      path:    urlPath,
      method:  'POST',
      headers: {
        'Content-Type':   'application/octet-stream',
        'Content-Length': encrypted.length,
        'Accept':         'application/json',
        'User-Agent':     (() => { const d = getDeviceConfig(); return d.os === 'android' ? `WhatsApp/${d.version || '2.26.7.75'} A` : `WhatsApp/${d.version || '2.26.7.75'} iOS/${d.osVersion} Device/${d.model}`; })()
      }
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return resolve(null);
        }
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(body);
        } catch (_) {
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));
    req.write(encrypted);
    req.end();
  });
}

async function downloadMedia(url, mediaKey, keyName) {
  const encrypted = await _httpGet(url);
  return decryptMedia(encrypted, Buffer.from(mediaKey), keyName);
}

function _httpGet(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return _httpGet(res.headers.location).then(resolve).catch(reject);
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
  deriveMediaKeyData,
  getMediaKeyName
};
