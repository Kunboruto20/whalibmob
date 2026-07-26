'use strict';

const crypto = require('crypto');
const https  = require('https');
const tls    = require('tls');
const curveJs = require('curve25519-js');
const { getDeviceConfig } = require('./DeviceConfig');

// ---------- SOCKS5 / Tor support ----------
// Set TOR_PROXY=socks5://127.0.0.1:9050 (or any socks5 host) to route all
// WhatsApp registration traffic through Tor / a residential proxy.
const SOCKS_LIB = '/home/runner/workspace/.config/npm/node_global/lib/node_modules/socks/build/index.js';

async function httpPostViaSocks(path, body, waVersion, proxyUrl) {
  const url     = new URL(proxyUrl);
  const pHost   = url.hostname;
  const pPort   = parseInt(url.port) || 1080;
  const dHost   = 'v.whatsapp.net';
  const dPort   = 443;

  const { SocksClient } = require(SOCKS_LIB);
  const { socket: rawSocket } = await SocksClient.createConnection({
    proxy:       { host: pHost, port: pPort, type: 5 },
    command:     'connect',
    destination: { host: dHost, port: dPort }
  });

  const tlsSocket = tls.connect({
    socket:             rawSocket,
    host:               dHost,
    servername:         dHost,
    rejectUnauthorized: true
  });

  await new Promise((res, rej) => {
    tlsSocket.once('secureConnect', res);
    tlsSocket.once('error', rej);
  });

  const _dev = getDeviceConfig();
  const userAgent = _dev.os === 'android'
    ? `WhatsApp/${waVersion} A`
    : `WhatsApp/${waVersion} iOS/${_dev.osVersion} Device/${_dev.model}`;
  const req = [
    `POST /v2${path} HTTP/1.1`,
    `Host: ${dHost}`,
    `User-Agent: ${userAgent}`,
    `Content-Type: application/x-www-form-urlencoded`,
    `Content-Length: ${Buffer.byteLength(body)}`,
    `Connection: keep-alive`,
    '',
    body
  ].join('\r\n');

  tlsSocket.write(req);

  const chunks = [];
  await new Promise((res, rej) => {
    tlsSocket.on('data', d => chunks.push(d));
    tlsSocket.on('end', res);
    tlsSocket.on('error', rej);
  });

  const raw        = Buffer.concat(chunks);
  const rawStr     = raw.toString('utf8');
  const headerEnd  = rawStr.indexOf('\r\n\r\n');
  const headerPart = rawStr.slice(0, headerEnd);
  const httpStatus = parseInt(rawStr.split(' ')[1]);
  let bodyStr      = rawStr.slice(headerEnd + 4);

  // Handle chunked transfer encoding
  if (/transfer-encoding:\s*chunked/i.test(headerPart)) {
    let decoded = '';
    let pos = 0;
    while (pos < bodyStr.length) {
      const lineEnd = bodyStr.indexOf('\r\n', pos);
      if (lineEnd === -1) break;
      const chunkSize = parseInt(bodyStr.slice(pos, lineEnd), 16);
      if (!chunkSize) break;
      decoded += bodyStr.slice(lineEnd + 2, lineEnd + 2 + chunkSize);
      pos = lineEnd + 2 + chunkSize + 2;
    }
    bodyStr = decoded;
  }

  if (httpStatus !== 200) throw new Error(`HTTP ${httpStatus} ${path}: ${bodyStr}`);
  try { return JSON.parse(bodyStr); } catch (_) { return { raw: bodyStr }; }
}
const {
  REGISTRATION_ENDPOINT,
  REGISTRATION_PUBLIC_KEY,
  IOS_STATIC_TOKEN,
  ANDROID_STATIC_TOKEN,
  IOS_VERSION_FALLBACK,
  ANDROID_VERSION_FALLBACK,
  IOS_USER_AGENT,
  IOS_DEVICE,
  SIGNAL_KEY_TYPE,
  RELEASE_CHANNEL
} = require('./constants');

// ---------- MD5 helpers ----------

function md5Hex(str) {
  return crypto.createHash('md5').update(str, 'utf8').digest('hex');
}

function md5Bytes(str) {
  return crypto.createHash('md5').update(str, 'utf8').digest();
}

// ---------- Country metadata (MCC, MNC, locale) ----------
// MCC  = Mobile Country Code  (3 digits, string)
// MNC  = Mobile Network Code  (2-3 digits, string; most-common operator chosen)
// lg   = language tag (ISO 639-1)
// lc   = country tag  (ISO 3166-1 alpha-2)
//
// WhatsApp uses sim_mcc / sim_mnc to validate that the SIM matches the
// dialled country code.  '000'/'000' is a known red flag that third-party
// clients use.  We map cc → the most-common domestic operator instead.
const COUNTRY_META = {
  '1':   { mcc: '310', mnc: '410', lg: 'en', lc: 'US' }, // US (AT&T)
  '7':   { mcc: '250', mnc: '01',  lg: 'ru', lc: 'RU' }, // Russia
  '20':  { mcc: '602', mnc: '01',  lg: 'ar', lc: 'EG' }, // Egypt
  '27':  { mcc: '655', mnc: '10',  lg: 'en', lc: 'ZA' }, // South Africa
  '30':  { mcc: '202', mnc: '01',  lg: 'el', lc: 'GR' }, // Greece
  '31':  { mcc: '204', mnc: '04',  lg: 'nl', lc: 'NL' }, // Netherlands
  '32':  { mcc: '206', mnc: '01',  lg: 'nl', lc: 'BE' }, // Belgium
  '33':  { mcc: '208', mnc: '01',  lg: 'fr', lc: 'FR' }, // France
  '34':  { mcc: '214', mnc: '01',  lg: 'es', lc: 'ES' }, // Spain
  '36':  { mcc: '216', mnc: '01',  lg: 'hu', lc: 'HU' }, // Hungary
  '39':  { mcc: '222', mnc: '01',  lg: 'it', lc: 'IT' }, // Italy
  '40':  { mcc: '226', mnc: '010', lg: 'ro', lc: 'RO' }, // Romania (Orange)
  '41':  { mcc: '228', mnc: '01',  lg: 'de', lc: 'CH' }, // Switzerland
  '43':  { mcc: '232', mnc: '01',  lg: 'de', lc: 'AT' }, // Austria
  '44':  { mcc: '234', mnc: '30',  lg: 'en', lc: 'GB' }, // UK
  '45':  { mcc: '238', mnc: '01',  lg: 'da', lc: 'DK' }, // Denmark
  '46':  { mcc: '240', mnc: '01',  lg: 'sv', lc: 'SE' }, // Sweden
  '47':  { mcc: '242', mnc: '01',  lg: 'no', lc: 'NO' }, // Norway
  '48':  { mcc: '260', mnc: '01',  lg: 'pl', lc: 'PL' }, // Poland
  '49':  { mcc: '262', mnc: '01',  lg: 'de', lc: 'DE' }, // Germany
  '51':  { mcc: '716', mnc: '10',  lg: 'es', lc: 'PE' }, // Peru
  '52':  { mcc: '334', mnc: '020', lg: 'es', lc: 'MX' }, // Mexico
  '54':  { mcc: '722', mnc: '310', lg: 'es', lc: 'AR' }, // Argentina
  '55':  { mcc: '724', mnc: '05',  lg: 'pt', lc: 'BR' }, // Brazil
  '56':  { mcc: '730', mnc: '01',  lg: 'es', lc: 'CL' }, // Chile
  '57':  { mcc: '732', mnc: '101', lg: 'es', lc: 'CO' }, // Colombia
  '58':  { mcc: '734', mnc: '04',  lg: 'es', lc: 'VE' }, // Venezuela
  '60':  { mcc: '502', mnc: '12',  lg: 'ms', lc: 'MY' }, // Malaysia
  '61':  { mcc: '505', mnc: '01',  lg: 'en', lc: 'AU' }, // Australia
  '62':  { mcc: '510', mnc: '01',  lg: 'id', lc: 'ID' }, // Indonesia
  '63':  { mcc: '515', mnc: '01',  lg: 'en', lc: 'PH' }, // Philippines
  '64':  { mcc: '530', mnc: '01',  lg: 'en', lc: 'NZ' }, // New Zealand
  '65':  { mcc: '525', mnc: '01',  lg: 'en', lc: 'SG' }, // Singapore
  '66':  { mcc: '520', mnc: '01',  lg: 'th', lc: 'TH' }, // Thailand
  '81':  { mcc: '440', mnc: '10',  lg: 'ja', lc: 'JP' }, // Japan
  '82':  { mcc: '450', mnc: '05',  lg: 'ko', lc: 'KR' }, // South Korea
  '84':  { mcc: '452', mnc: '01',  lg: 'vi', lc: 'VN' }, // Vietnam
  '86':  { mcc: '460', mnc: '00',  lg: 'zh', lc: 'CN' }, // China
  '90':  { mcc: '286', mnc: '01',  lg: 'tr', lc: 'TR' }, // Turkey
  '91':  { mcc: '404', mnc: '20',  lg: 'en', lc: 'IN' }, // India (Airtel)
  '92':  { mcc: '410', mnc: '01',  lg: 'ur', lc: 'PK' }, // Pakistan
  '93':  { mcc: '412', mnc: '01',  lg: 'fa', lc: 'AF' }, // Afghanistan
  '94':  { mcc: '413', mnc: '02',  lg: 'si', lc: 'LK' }, // Sri Lanka
  '95':  { mcc: '414', mnc: '01',  lg: 'my', lc: 'MM' }, // Myanmar
  '98':  { mcc: '432', mnc: '11',  lg: 'fa', lc: 'IR' }, // Iran
  '212': { mcc: '604', mnc: '01',  lg: 'ar', lc: 'MA' }, // Morocco
  '213': { mcc: '603', mnc: '01',  lg: 'ar', lc: 'DZ' }, // Algeria
  '216': { mcc: '605', mnc: '02',  lg: 'ar', lc: 'TN' }, // Tunisia
  '218': { mcc: '606', mnc: '01',  lg: 'ar', lc: 'LY' }, // Libya
  '234': { mcc: '621', mnc: '20',  lg: 'en', lc: 'NG' }, // Nigeria
  '254': { mcc: '639', mnc: '02',  lg: 'en', lc: 'KE' }, // Kenya
  '255': { mcc: '640', mnc: '02',  lg: 'sw', lc: 'TZ' }, // Tanzania
  '256': { mcc: '641', mnc: '10',  lg: 'en', lc: 'UG' }, // Uganda
  '351': { mcc: '268', mnc: '01',  lg: 'pt', lc: 'PT' }, // Portugal
  '353': { mcc: '272', mnc: '01',  lg: 'en', lc: 'IE' }, // Ireland
  '358': { mcc: '244', mnc: '03',  lg: 'fi', lc: 'FI' }, // Finland
  '380': { mcc: '255', mnc: '01',  lg: 'uk', lc: 'UA' }, // Ukraine
  '420': { mcc: '230', mnc: '01',  lg: 'cs', lc: 'CZ' }, // Czech Republic
  '966': { mcc: '420', mnc: '01',  lg: 'ar', lc: 'SA' }, // Saudi Arabia
  '971': { mcc: '424', mnc: '02',  lg: 'ar', lc: 'AE' }, // UAE
  '972': { mcc: '425', mnc: '01',  lg: 'he', lc: 'IL' }, // Israel
  '880': { mcc: '470', mnc: '01',  lg: 'bn', lc: 'BD' }, // Bangladesh
};

function getCountryMeta(cc) {
  return COUNTRY_META[cc] || { mcc: '000', mnc: '000', lg: 'en', lc: 'US' };
}

// ---------- Phone number parsing ----------
// Reproduces Java PhoneNumberUtil behaviour:
//   cc       = country calling code string (e.g. "40")
//   national = national significant number string WITHOUT leading zeros
//              (Java long conversion removes them automatically)

const THREE_DIGIT_CCS = new Set([
  '355','213','376','244','672','374','297','994','387','1246','880','226',
  '599','1242','975','267','257','229','590','673','591','238','682','237',
  '236','242','225','269','506','53','357','253','1767','291','240','251',
  '372','500','298','241','995','594','233','299','220','224','245','592',
  '504','353','246','964','354','962','996','855','686','850','965','7',
  '856','423','231','266','370','352','218','261','692','692','389','223',
  '692','222','960','265','692','976','853','258','264','977','674','505',
  '687','227','968','507','675','689','680','595','974','692','250','677',
  '248','963','503','268','235','228','676','1868','688','255','993','690',
  '670','598','678','685','967','692','262','964','993','1784','1242','371',
  '1473','692','1268','692','1869','692'
]);

const TWO_DIGIT_CCS = new Set([
  '20','27','30','31','32','33','34','36','39','40','41','43','44','45',
  '46','47','48','49','51','52','53','54','55','56','57','58','60','61',
  '62','63','64','65','66','81','82','84','86','90','91','92','93','94',
  '95','98'
]);

function parsePhone(phoneNumber) {
  const str = String(phoneNumber).replace(/\D/g, '');

  const cc3 = str.slice(0, 3);
  if (THREE_DIGIT_CCS.has(cc3)) {
    return { cc: cc3, national: String(BigInt(str.slice(3))) };
  }

  const cc2 = str.slice(0, 2);
  if (TWO_DIGIT_CCS.has(cc2)) {
    return { cc: cc2, national: String(BigInt(str.slice(2))) };
  }

  const cc1 = str.slice(0, 1);
  return { cc: cc1, national: String(BigInt(str.slice(1))) };
}

// ---------- WhatsApp version fetch (iOS from iTunes, Android from Play Store) ----------

let _cachedIosVersion     = null;
let _cachedAndroidVersion = null;

async function fetchIosVersion() {
  if (_cachedIosVersion) return _cachedIosVersion;
  return new Promise((resolve) => {
    const req = https.get(
      'https://itunes.apple.com/lookup?bundleId=net.whatsapp.WhatsApp',
      { headers: { 'User-Agent': IOS_USER_AGENT } },
      (res) => {
        const chunks = [];
        res.on('data', d => chunks.push(d));
        res.on('end', () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            let ver = (json.results && json.results[0] && json.results[0].version) || IOS_VERSION_FALLBACK;
            if (!ver.startsWith('2.')) ver = '2.' + ver;
            _cachedIosVersion = ver;
            resolve(ver);
          } catch (_) {
            resolve(IOS_VERSION_FALLBACK);
          }
        });
      }
    );
    req.on('error', () => resolve(IOS_VERSION_FALLBACK));
    req.setTimeout(8000, () => { req.destroy(); resolve(IOS_VERSION_FALLBACK); });
  });
}

// Fetch latest WhatsApp Android version from Google Play Store.
// Parses the 4-part "2.x.x.x" version string embedded in the page JSON data.
// Falls back to ANDROID_VERSION_FALLBACK on any error.
async function fetchAndroidVersion() {
  if (_cachedAndroidVersion) return _cachedAndroidVersion;
  try {
    const axios = require('axios');
    const resp = await axios.get(
      'https://play.google.com/store/apps/details?id=com.whatsapp&hl=en&gl=us',
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        timeout: 12000
      }
    );
    const html = String(resp.data);

    // Primary: first quoted 4-part version string matching WhatsApp's "2.x.x.x" scheme.
    // In Play Store JSON the current stable version appears first, before beta/history entries.
    const primary = html.match(/"(2\.\d+\.\d+\.\d+)"/);
    if (primary) {
      _cachedAndroidVersion = primary[1];
      return primary[1];
    }

    // Secondary: unquoted version adjacent to "WhatsApp" text (catches alternate HTML structures).
    const secondary = html.match(/WhatsApp[^<"]{0,200}?(2\.\d+\.\d+\.\d+)/);
    if (secondary) {
      _cachedAndroidVersion = secondary[1];
      return secondary[1];
    }
  } catch (_) {}
  return ANDROID_VERSION_FALLBACK;
}

// Return the appropriate WhatsApp version for the active device.
// If WA_VERSION is set in the environment, that value is always used.
async function fetchWaVersion(device) {
  if (process.env.WA_VERSION) return process.env.WA_VERSION;
  return (device && device.os === 'android') ? fetchAndroidVersion() : fetchIosVersion();
}

// ---------- Token computation ----------
// token = MD5( staticToken + MD5hex(waVersion) + nationalNumber )
// The static token depends on the platform (iOS vs Android).
// Override with WA_STATIC_TOKEN in .env if the bundled token becomes stale.

function computeToken(waVersion, national) {
  const device      = getDeviceConfig();
  const staticToken = process.env.WA_STATIC_TOKEN
    || (device.os === 'android' ? ANDROID_STATIC_TOKEN : IOS_STATIC_TOKEN);
  const versionHashHex = md5Bytes(waVersion).toString('hex');
  return md5Hex(staticToken + versionHashHex + national);
}

// ---------- Byte helpers ----------

function stripKeyPrefix(buf) {
  if (buf.length === 33 && buf[0] === 0x05) return buf.slice(1);
  return buf;
}

function intToBytes(n, len) {
  const buf = Buffer.alloc(len);
  for (let i = len - 1; i >= 0; i--) {
    buf[i] = n & 0xff;
    n >>= 8;
  }
  return buf;
}

// Java toUrlHex: "%AA%BB..." uppercase
function toUrlHex(buf) {
  return Array.from(buf).map(b => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join('');
}

// ---------- Form builder — NO URL-encoding (matches Java toFormParams) ----------
// Java: entries[i] + "=" + entries[i+1], joined by "&", nulls skipped.
// IMPORTANT: do NOT use URLSearchParams here — it would double-encode the
//            percent-hex sequences in the 'id' field (%AA → %25AA).

function buildForm(pairs, extraPairs) {
  const parts = [];
  for (let i = 0; i < pairs.length; i += 2) {
    if (pairs[i + 1] == null) continue;
    parts.push(pairs[i] + '=' + pairs[i + 1]);
  }
  if (extraPairs) {
    for (let i = 0; i < extraPairs.length; i += 2) {
      if (extraPairs[i + 1] == null) continue;
      parts.push(extraPairs[i] + '=' + extraPairs[i + 1]);
    }
  }
  return parts.join('&');
}

// ---------- Payload ----------

// base64url WITH padding — matches Java's Base64.getUrlEncoder().encodeToString()
function toBase64Url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

function buildPayload(store, waVersion, useToken, extraPairs) {
  const { cc, national } = parsePhone(store.phoneNumber);
  const meta  = getCountryMeta(cc);
  const token = useToken ? computeToken(waVersion, national) : null;
  const fdid  = store.fdid.toUpperCase();

  return buildForm([
    'cc',         cc,
    'in',         national,
    'rc',         String(RELEASE_CHANNEL),
    'lg',         meta.lg,
    'lc',         meta.lc,
    'authkey',    toBase64Url(stripKeyPrefix(store.noiseKeyPair.public)),
    'e_regid',    toBase64Url(intToBytes(store.registrationId, 4)),
    'e_keytype',  toBase64Url(Buffer.from([SIGNAL_KEY_TYPE])),
    'e_ident',    toBase64Url(stripKeyPrefix(store.identityKeyPair.public)),
    'e_skey_id',  toBase64Url(intToBytes(store.signedPreKey.id, 3)),
    'e_skey_val', toBase64Url(stripKeyPrefix(store.signedPreKey.public)),
    'e_skey_sig', toBase64Url(store.signedPreKey.signature),
    'fdid',       fdid,
    'expid',      toBase64Url(store.deviceId),
    'id',         toUrlHex(store.identityId),
    'token',      token
  ], extraPairs);
}

// ---------- Encryption (AES-256-GCM, ephemeral X25519) ----------

function encryptPayload(plaintext) {
  const seed = crypto.randomBytes(32);
  const ephKp = curveJs.generateKeyPair(seed);
  const ephemeralPub = Buffer.from(ephKp.public);
  const sharedKey    = Buffer.from(curveJs.sharedKey(ephKp.private, REGISTRATION_PUBLIC_KEY));

  const iv = Buffer.alloc(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', sharedKey, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return toBase64Url(Buffer.concat([ephemeralPub, enc, tag]));
}

// ---------- HTTP ----------

function httpPost(path, body, waVersion) {
  const proxy = process.env.TOR_PROXY || process.env.SOCKS_PROXY || '';
  if (proxy) return httpPostViaSocks(path, body, waVersion, proxy);

  return new Promise((resolve, reject) => {
    const _httpDev  = getDeviceConfig();
    const userAgent = _httpDev.os === 'android'
      ? `WhatsApp/${waVersion} A`
      : `WhatsApp/${waVersion} iOS/${_httpDev.osVersion} Device/${_httpDev.model}`;
    const bodyBuf = Buffer.from(body, 'utf8');
    const opts = {
      hostname: 'v.whatsapp.net',
      port: 443,
      path: '/v2' + path,
      method: 'POST',
      timeout: 20000,
      headers: {
        'User-Agent':      userAgent,
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': bodyBuf.length
      }
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} ${path}: ${text}`));
        }
        try { resolve(JSON.parse(text)); }
        catch (_) { resolve({ raw: text }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error(`HTTPS timeout on ${path}`)); });
    req.write(bodyBuf);
    req.end();
  });
}

async function sendRequest(path, store, waVersion, useToken, extraPairs) {
  const plaintext = buildPayload(store, waVersion, useToken, extraPairs);
  const enc = encryptPayload(plaintext);
  const body = 'ENC=' + enc;
  return httpPost(path, body, waVersion);
}

// ---------- Public API ----------

async function checkIfRegistered(store) {
  const waVersion = await fetchWaVersion(getDeviceConfig());
  return sendRequest('/exist', store, waVersion, false, null);
}

/**
 * Comprehensive check: determine if a phone number is active on WhatsApp.
 * Does NOT require a pre-existing session. Uses an ephemeral store.
 *
 * Strategy:
 *   1. /exist  — fast; returns 'ok' if the number owns a session on this device.
 *   2. /code wa_old — WhatsApp-to-WhatsApp delivery; non-intrusive for non-WA numbers.
 *      · sent            → number IS on WhatsApp (received code via WA message)
 *      · custom_block_screen → IS on WhatsApp but banned from third-party clients
 *      · fail (no block) → not on WA or IP-level block; go to step 3
 *   3. /code sms — only reached when wa_old was inconclusive.
 *      · sent            → NOT on WhatsApp (can be registered; SMS code was delivered)
 *      · custom_block_screen → IS on WhatsApp but banned from third-party clients
 *      · too_recent      → code already sent; wait 1-2 min
 *      · fail            → likely datacenter IP block; status unknown
 *
 * Returns:
 *   { active: bool|null, usable: bool|null, status: string, note: string }
 *   status values: 'registered' | 'registered_blocked' | 'not_registered' | 'cooldown' | 'unknown'
 */
async function checkNumberStatus(phoneNumber) {
  const { createNewStore } = require('./Store');

  phoneNumber = String(phoneNumber).replace(/\D/g, '');
  const store     = createNewStore(phoneNumber);
  const waVersion = await fetchWaVersion(getDeviceConfig());
  const { cc }    = parsePhone(phoneNumber);
  const meta      = getCountryMeta(cc);

  const baseExtra = [
    'sim_mcc',           meta.mcc,
    'sim_mnc',           meta.mnc,
    'reason',            '',
    'cellular_strength', '1'
  ];

  function hasBlock(r) {
    return r && !!r.custom_block_screen;
  }

  function isCooldown(r) {
    if (!r) return false;
    const s = (r.status || '') + '|' + (r.reason || '');
    return /too_recent|too_many/.test(s);
  }

  async function tryCode(method) {
    try {
      return await sendRequest('/code', store, waVersion, true, ['method', method, ...baseExtra]);
    } catch (_) { return null; }
  }

  // ── Step 1: /exist ──────────────────────────────────────────────────────────
  let r;
  try {
    r = await sendRequest('/exist', store, waVersion, false, null);
    if (r && r.status === 'ok') {
      return { active: true, usable: true, status: 'registered',
               note: 'Number is registered on WhatsApp.' };
    }
    if (r && r.custom_block_screen) {
      return { active: true, usable: false, status: 'registered_blocked',
               note: 'Number is active on WhatsApp but blocked from third-party clients.' };
    }
  } catch (_) {}

  // ── Step 2: /code wa_old ────────────────────────────────────────────────────
  r = await tryCode('wa_old');
  if (r) {
    if (r.status === 'sent' || r.status === 'ok') {
      return { active: true, usable: true, status: 'registered',
               note: 'Number is active on WhatsApp. Verification code delivered via WhatsApp.' };
    }
    if (hasBlock(r) || (r.status === 'fail' && r.custom_block_screen)) {
      return { active: true, usable: false, status: 'registered_blocked',
               note: 'Number is active on WhatsApp but blocked from third-party clients.' };
    }
    if (isCooldown(r)) {
      return { active: null, usable: null, status: 'cooldown',
               note: 'A verification code was recently sent. Wait 1-2 minutes and try again.' };
    }
  }

  // ── Step 3: /code sms ───────────────────────────────────────────────────────
  r = await tryCode('sms');
  if (r) {
    if (r.status === 'sent' || r.status === 'ok') {
      return { active: false, usable: true, status: 'not_registered',
               note: 'Number is NOT on WhatsApp. It can be registered. Verification SMS was sent.' };
    }
    if (hasBlock(r)) {
      return { active: true, usable: false, status: 'registered_blocked',
               note: 'Number is active on WhatsApp but blocked from third-party clients.' };
    }
    if (isCooldown(r)) {
      return { active: null, usable: null, status: 'cooldown',
               note: 'A verification code was recently sent. Wait 1-2 minutes and try again.' };
    }
  }

  return { active: null, usable: null, status: 'unknown',
           note: 'Could not determine status. Possible datacenter IP restriction. Try a residential proxy.' };
}

// ---------- assertRegistrationKeys ----------
// Makes up to two /exist attempts before giving up.
// Returns true  → keys are fresh (safe to proceed with /code).
// Returns false → keys already registered (generate new store before /code).
async function assertRegistrationKeys(store, waVersion) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await sendRequest('/exist', store, waVersion, false, null);
      // reason === 'incorrect' → keys not found → fresh
      if (result && result.reason === 'incorrect') return true;
      // Any non-ok status on 2nd attempt → still treat as fresh (network/server glitch)
      if (attempt === 1 && result && result.status && result.status !== 'ok') return true;
    } catch (_) {
      // Network error = treat keys as fresh
      return true;
    }
  }
  return false;
}

async function requestSmsCode(store, method, opts) {
  method = method || 'sms';
  opts   = opts   || {};
  const _device   = getDeviceConfig();
  const waVersion = await fetchWaVersion(_device);
  store.version = waVersion;
  store.device  = _device;

  // Email method: request code via email instead of SMS/voice.
  // Sends method=email + email=<address> in the /code request.
  // No auto-fallback for email — it either works or fails.
  if (method === 'email') {
    const emailAddr = opts.email || '';
    if (!emailAddr) throw new Error('requestSmsCode: email method requires opts.email address');
    const { cc: _regCc } = parsePhone(store.phoneNumber);
    const _regMeta       = getCountryMeta(_regCc);
    const extra = [
      'method',            'email',
      'email',             emailAddr,
      'sim_mcc',           _regMeta.mcc,
      'sim_mnc',           _regMeta.mnc,
      'reason',            '',
      'cellular_strength', '1'
    ];
    const result = await sendRequest('/code', store, waVersion, true, extra);
    const status = result.status;
    if (status === 'ok' || status === 'sent') return result;
    const reason = result.reason || status || '';
    throw new Error(`Registration email error: ${reason} — raw: ${JSON.stringify(result)}`);
  }

  // Auto-fallback: if the primary method gets no_routes, try the alternate once.
  // sms → wa_old, wa_old → sms, voice → sms
  const fallbackMethod = method === 'wa_old' ? 'sms' : (method === 'sms' ? 'wa_old' : 'sms');
  let autoFallbackDone = false;

  // Derive real MCC/MNC from the phone number being registered.
  const { cc: _regCc } = parsePhone(store.phoneNumber);
  const _regMeta       = getCountryMeta(_regCc);

  async function _tryMethod(m) {
    const extra = [
      'method',            m,
      'sim_mcc',           _regMeta.mcc,
      'sim_mnc',           _regMeta.mnc,
      'reason',            '',
      'cellular_strength', '1'
    ];

    // Retry loop:
    //   1. Try /code
    //   2. Success → return result
    //   3. too_recent/too_many → throw immediately
    //   4. no_routes → return null (caller handles fallback)
    //   5. custom_block_screen → throw with IP hint
    //   6. Same error twice → throw to break loop
    //   7. Unknown error first time → retry once
    let lastReason = null;
    while (true) {
      const result = await sendRequest('/code', store, waVersion, true, extra);

      const status = result.status;
      if (status === 'ok' || status === 'sent') return result;

      const reason = result.reason || status || '';

      // isTooRecent() — throw immediately, no point retrying
      if (/too_recent|too_many|too_many_guesses|too_many_all_methods/i.test(reason) ||
          /too_recent|too_many|too_many_guesses|too_many_all_methods/i.test(status)) {
        const waitSec = result.sms_wait || result.retry_after || null;
        const waitMsg = waitSec ? ` (wait ${Math.ceil(waitSec / 60)} min, ${waitSec}s)` : '';
        throw new Error(`code already sent recently — check your phone or wait a few minutes (${reason})${waitMsg}`);
      }

      // isRegistrationBlocked() — no_routes: signal to try alternate method
      if (reason === 'no_routes' || status === 'no_routes') {
        return { _noRoutes: true, method: m };
      }

      // custom_block_screen = WhatsApp security block (IP/number flagged)
      if (result.custom_block_screen) {
        const body = result.custom_block_screen.body || 'blocked by WhatsApp security';
        throw new Error(`WhatsApp security block: "${body}" — use a residential IP/proxy`);
      }

      // Same error twice in a row → give up
      if (reason && reason === lastReason) {
        throw new Error(`Registration error (${m}): ${reason} — raw: ${JSON.stringify(result)}`);
      }

      // First occurrence of unknown error → retry once
      lastReason = reason;
    }
  }

  // Try primary method
  let result = await _tryMethod(method);

  // Auto-fallback on no_routes
  if (result && result._noRoutes && !autoFallbackDone) {
    autoFallbackDone = true;
    process.stderr.write(`[REG] ${method} returned no_routes — auto-trying ${fallbackMethod}\n`);
    result = await _tryMethod(fallbackMethod);
  }

  // Final no_routes — give up with useful message
  if (result && result._noRoutes) {
    const tried = autoFallbackDone ? `${method} and ${fallbackMethod}` : method;
    throw new Error(
      `Registration blocked (no_routes) for both methods (${tried}).\n` +
      `  • If the number IS on WhatsApp → re-install the app or wait 24h\n` +
      `  • If the number is NEW → try a different carrier or use a VoIP number`
    );
  }

  return result;
}

async function verifyCode(store, code) {
  const _device   = getDeviceConfig();
  const waVersion = await fetchWaVersion(_device);
  store.version = waVersion;
  store.device  = _device;
  const normalized = code.replace(/[\s\-]/g, '').replace(/\D/g, '');
  const result = await sendRequest('/register', store, waVersion, true, ['code', normalized]);

  const status = result.status;
  if (status === 'ok' || status === 'sent' || status === 'verified') return result;

  const reason = result.reason || '';
  if (reason === 'missing') {
    throw new Error(
      'Verification failed: code expired or already used.\n' +
      '  Run /reg code <phone> again to get a new code, then immediately confirm it.'
    );
  }
  if (/bad_code|code_invalid|wrong/.test(reason)) {
    throw new Error('Verification failed: wrong code entered. Check the SMS and try again.');
  }
  if (/too_many/.test(reason)) {
    throw new Error('Verification failed: too many wrong attempts. Wait a few minutes then request a new code.');
  }
  // Apple App Store age-verification / parental-consent gate.
  // The code was accepted, but WhatsApp requires the Apple account holder to
  // approve the app download before the registration can complete.
  if (result.pending === 'app_store_age' || reason === 'consent') {
    return result;
  }
  throw new Error(`Verification failed: ${reason || JSON.stringify(result)}`);
}

module.exports = { checkIfRegistered, checkNumberStatus, requestSmsCode, verifyCode, fetchIosVersion, fetchAndroidVersion, fetchWaVersion, parsePhone, getCountryMeta, assertRegistrationKeys };
