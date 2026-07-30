'use strict';

const crypto = require('crypto');
const https  = require('https');
const tls    = require('tls');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const curveJs = require('curve25519-js');
const { v4: uuidv4 } = require('uuid');
const { getDeviceConfig } = require('./DeviceConfig');
const AndroidApk  = require('./AndroidApk');
const attestation = require('./Attestation');
const { dbg: _whaDbg } = require('./logger');

// ---------- Request envelope ----------
//
// The registration server reads which platform is calling out of the
// User-Agent. There is no form field for it — neither this library nor Cobalt
// sends one — so a request whose User-Agent does not name a platform it knows is
// refused with {"param":"platform","reason":"bad_param"} on every endpoint. The
// giveaway is that /client_log is refused the same way, and its body carries no
// device fields at all: nothing about the platform is in the body to begin with.
//
// Android used to be sent as `WhatsApp/<version> A`, which names nothing, and
// was refused everywhere. iOS has always sent the full form and has always
// worked, which is why only one of the two platforms was broken.
//
// The three extra Android headers come from Cobalt's AndroidClientRegistration,
// which records them as observed on a live native Android registration. Its iOS
// counterpart documents that the native iOS client omits all three, so the iOS
// envelope stays exactly as it was.
function registrationHeaders(device, waVersion) {
  if (device.os === 'android') {
    return {
      'User-Agent':     `WhatsApp/${waVersion} Android/${device.osVersion} Device/${device.manufacturer}-${device.modelId}`,
      'Content-Type':   'application/x-www-form-urlencoded',
      'Accept':         'text/json',
      'WaMsysRequest':  '1',
      // A fresh one per request, the way the native client mints it.
      'request_token':  uuidv4()
    };
  }
  return {
    'User-Agent':   `WhatsApp/${waVersion} iOS/${device.osVersion} Device/${device.model}`,
    'Content-Type': 'application/x-www-form-urlencoded'
  };
}

// ---------- SOCKS4 / SOCKS5 / Tor support ----------
//
// Set SOCKS_PROXY (or TOR_PROXY) to route registration traffic through a proxy:
//
//   socks5://127.0.0.1:9050              Tor
//   socks5://user:pass@host:1080         authenticated residential proxy
//   socks5h://host:1080                  resolve the destination at the proxy
//   socks4://host:1080                   older proxies
//
// Requires the `socks` package: npm install socks

const SOCKS_SCHEMES = {
  'socks:':   5,
  'socks5:':  5,
  'socks5h:': 5,
  'socks4:':  4,
  'socks4a:': 4
};

// Resolve the library the way every other dependency is resolved.
//
// This used to be a hardcoded absolute path into one particular machine's
// global npm directory. It resolved there and nowhere else, so proxy support
// was dead for everybody who installed whalibmob normally — the require threw
// MODULE_NOT_FOUND the moment a proxy was configured. WA_SOCKS_LIB stays as an
// escape hatch for unusual layouts, but it is an override now, not the only
// way in.
function loadSocks() {
  const override = process.env.WA_SOCKS_LIB;
  if (override) {
    try { return require(override); }
    catch (err) {
      throw new Error('WA_SOCKS_LIB points at ' + override +
        ' but it could not be loaded: ' + err.message);
    }
  }
  try {
    return require('socks');
  } catch (_) {
    throw new Error(
      "A SOCKS proxy is configured but the 'socks' package is not installed. " +
      'Run: npm install socks'
    );
  }
}

/**
 * Parse a proxy URL into what SocksClient expects.
 *
 * Accepts the schemes above, with or without credentials, and defaults the
 * port to 1080 the way every SOCKS client does.
 */
function parseSocksProxy(proxyUrl) {
  let raw = String(proxyUrl || '').trim();
  if (!raw) throw new Error('No SOCKS proxy configured');

  // A bare host:port is what .env.example has always shown and what most people
  // type. Without a scheme `new URL` reads "127.0.0.1:" as the protocol and the
  // rest as the path, so it has to be filled in before parsing.
  if (!/^[a-z0-9+.-]+:\/\//i.test(raw)) raw = 'socks5://' + raw;

  let url;
  try { url = new URL(raw); }
  catch (_) { throw new Error('Invalid SOCKS proxy URL: ' + proxyUrl); }

  const type = SOCKS_SCHEMES[url.protocol];
  if (!type) {
    throw new Error('Unsupported proxy scheme "' + url.protocol + '" — use ' +
      Object.keys(SOCKS_SCHEMES).map(s => s.replace(':', '')).join(', '));
  }
  if (!url.hostname) throw new Error('SOCKS proxy URL has no host: ' + proxyUrl);

  const proxy = {
    host: url.hostname,
    port: parseInt(url.port, 10) || 1080,
    type
  };
  // Credentials may be percent-encoded in a URL; a password with an @ or a :
  // in it is common enough on paid proxies to be worth decoding.
  if (url.username) proxy.userId   = decodeURIComponent(url.username);
  if (url.password) proxy.password = decodeURIComponent(url.password);
  return proxy;
}

// TOR_PROXY wins when both are set — the precedence .env.example has always
// documented.
function socksProxyUrl() {
  return process.env.TOR_PROXY || process.env.SOCKS_PROXY || '';
}

async function httpPostViaSocks(path, body, waVersion, proxyUrl, authHeader, device) {
  const proxy = parseSocksProxy(proxyUrl);
  const dHost = 'v.whatsapp.net';
  const dPort = 443;

  const { SocksClient } = loadSocks();
  const { socket: rawSocket } = await SocksClient.createConnection({
    proxy,
    command:     'connect',
    destination: { host: dHost, port: dPort },
    // Without this a proxy that accepts the TCP connection and then says
    // nothing leaves the whole registration hanging with no error.
    timeout: 20000
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

  const headers  = registrationHeaders(device || getDeviceConfig(), waVersion);
  const reqLines = [
    `POST /v2${path} HTTP/1.1`,
    `Host: ${dHost}`,
    ...Object.keys(headers).map(k => `${k}: ${headers[k]}`),
    `Content-Length: ${Buffer.byteLength(body)}`
  ];
  if (authHeader) reqLines.push(`Authorization: ${authHeader}`);
  // Asked for, but not relied on: the server answers and then keeps the
  // connection open anyway. The response is finished by its own length, not by
  // the socket closing.
  reqLines.push(`Connection: close`, '', body);
  const req = reqLines.join('\r\n');

  tlsSocket.write(req);

  const { status, body: bodyBuf } = await readHttpResponse(tlsSocket, path);
  const bodyStr = bodyBuf.toString('utf8');

  if (status !== 200) throw new Error(`HTTP ${status} ${path}: ${bodyStr}`);
  try { return JSON.parse(bodyStr); } catch (_) { return { raw: bodyStr }; }
}

// A response is over when its own length says so, not when the socket shuts.
//
// This is the part `https.request` does for you and a hand-rolled socket does
// not. WhatsApp answers a registration request in well under a second and then
// leaves the connection open — `Connection: close` in the request does not
// change that. Waiting for end or close therefore waited for something that
// never came, and every proxied registration died on the read timeout with the
// reply already sitting in the buffer.
//
// So: parse as the bytes arrive, and stop at the end of the body — the byte
// count in Content-Length, or the terminating zero-length chunk. end and close
// stay as a fallback, for a reply that declares neither and can only be
// delimited by the connection itself.
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function readHttpResponse(socket, label, timeoutMs) {
  return new Promise((resolve, reject) => {
    let raw    = Buffer.alloc(0);
    let done   = false;

    const timer = setTimeout(() => {
      settle(reject, new Error('SOCKS proxy timed out reading ' + label));
    }, timeoutMs || 30000);

    function settle(fn, arg) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.removeListener('data',  onData);
      socket.removeListener('end',   onEnd);
      socket.removeListener('close', onEnd);
      socket.removeListener('error', onError);
      socket.destroy();
      fn(arg);
    }

    function onData(chunk) {
      raw = raw.length ? Buffer.concat([raw, chunk]) : chunk;
      if (raw.length > MAX_RESPONSE_BYTES) {
        return settle(reject, new Error('response too large reading ' + label));
      }
      const parsed = parseHttpResponse(raw, false);
      if (parsed) settle(resolve, parsed);
    }

    // The connection did close after all — then whatever arrived is the whole
    // reply, even without a declared length.
    function onEnd() {
      const parsed = parseHttpResponse(raw, true);
      if (parsed) return settle(resolve, parsed);
      settle(reject, new Error('connection closed mid-response reading ' + label));
    }

    function onError(err) { settle(reject, err); }

    socket.on('data',  onData);
    socket.on('end',   onEnd);
    socket.on('close', onEnd);
    socket.on('error', onError);
  });
}

/**
 * Parse what has arrived so far.
 *
 * Returns { status, headers, body } once the response is complete, or null
 * while it is still short. With `atEof` the caller is telling us no more bytes
 * are coming, which is itself a valid way for a body to end.
 */
function parseHttpResponse(raw, atEof) {
  const headerEnd = raw.indexOf('\r\n\r\n');
  if (headerEnd < 0) return null;

  // Headers are latin1 by definition; only the body may be UTF-8.
  const headers   = raw.slice(0, headerEnd).toString('latin1');
  const status    = parseInt(headers.split(' ')[1], 10);
  const bodyStart = headerEnd + 4;

  if (/^transfer-encoding:[ \t]*chunked/im.test(headers)) {
    const decoded = decodeChunkedBody(raw.slice(bodyStart));
    if (decoded) return { status, headers, body: decoded };
    return atEof ? { status, headers, body: Buffer.alloc(0) } : null;
  }

  const match = /^content-length:[ \t]*(\d+)/im.exec(headers);
  if (match) {
    const length = parseInt(match[1], 10);
    // Counted in bytes, which is why this works on the buffer and not on a
    // decoded string — one accented character in an error message is two bytes
    // and would leave the check one short forever.
    if (raw.length - bodyStart >= length) {
      return { status, headers, body: raw.slice(bodyStart, bodyStart + length) };
    }
    return atEof ? { status, headers, body: raw.slice(bodyStart) } : null;
  }

  // These two carry no body at all, whatever else the headers say.
  if (status === 204 || status === 304) {
    return { status, headers, body: Buffer.alloc(0) };
  }

  // No length anywhere: the body runs to the end of the connection.
  return atEof ? { status, headers, body: raw.slice(bodyStart) } : null;
}

/** Decode a chunked body, or null while the terminating chunk is still missing. */
function decodeChunkedBody(buf) {
  const parts = [];
  let pos = 0;

  for (;;) {
    const lineEnd = buf.indexOf('\r\n', pos);
    if (lineEnd < 0) return null;
    // A size line may carry extensions after a semicolon; parseInt stops there.
    const size = parseInt(buf.slice(pos, lineEnd).toString('latin1'), 16);
    if (!Number.isFinite(size) || size < 0) return null;
    if (size === 0) return Buffer.concat(parts);      // the terminating chunk
    const start = lineEnd + 2;
    const end   = start + size;
    if (buf.length < end + 2) return null;            // chunk still arriving
    parts.push(buf.slice(start, end));
    pos = end + 2;
  }
}
const {
  REGISTRATION_ENDPOINT,
  REGISTRATION_PUBLIC_KEY,
  IOS_STATIC_TOKEN,
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
//
// On Android the APK the token material came from decides it, the way Cobalt
// announces the versionName of the APK it downloaded. The token is signed over
// that build's classes.dex, so a version read from anywhere else describes a
// different build than the one the token proves — which the server sees as a
// token that does not belong to the client sending it. The live lookup stays as
// the fallback for when there is no material yet.
async function fetchWaVersion(device) {
  if (process.env.WA_VERSION) return process.env.WA_VERSION;
  if (device && device.os === 'android') {
    const material = tryLoadAndroidMaterial();
    if (material && material.apkVersion) return material.apkVersion;
    return fetchAndroidVersion();
  }
  return fetchIosVersion();
}

// ---------- Token computation ----------
//
// The two platforms compute this differently, and only iOS derives it from a
// static string:
//
//   iOS      MD5( staticToken + MD5hex(waVersion) + nationalNumber )
//   Android  HMAC-SHA1, keyed by material taken out of the APK, over the
//            signing certificates, MD5(classes.dex) and the national number
//
// Android was being sent the iOS calculation with a different constant put in
// front of it. No such constant exists — the Android client signs the token
// with its own APK — and the server answered every attempt with bad_token. See
// AndroidApk.js for the algorithm and where the material comes from.
//
// WA_STATIC_TOKEN therefore only means anything on iOS. It cannot substitute
// for the Android material, so it is deliberately not consulted there.

// Where the extracted Android material is kept. Beside the sessions by default,
// since that is the directory the CLI already owns.
function androidMaterialPath() {
  return process.env.WA_ANDROID_APK_MATERIAL ||
    path.join(os.homedir(), '.waSession', 'android-apk-material.json');
}

let _androidMaterial = null;

// The material if there is any, without insisting on it. fetchWaVersion asks
// this way: a missing file is the token's problem to report, not the version's.
function tryLoadAndroidMaterial() {
  try { return loadAndroidMaterial(); } catch (_) { return null; }
}

/**
 * Have the Android token material ready, fetching the APK if it is not.
 *
 * Registering as Android cannot produce a token without material read out of a
 * WhatsApp APK, and that material goes stale on every WhatsApp release. Asking
 * the caller to go and find an APK first turns one command into a chore, so a
 * registration that finds none fetches one from Play itself and carries on.
 *
 * Only a *missing* file is answered this way. An APK that turns out to be a
 * repack is refused as it was before — downloading over somebody's deliberate
 * choice of APK would be the wrong way to be helpful.
 *
 * A no-op on iOS, and WA_NO_APK_DOWNLOAD=1 turns it off for anyone who would
 * rather a hundred megabytes were never fetched without being asked for.
 */
async function ensureAndroidMaterial(opts, device) {
  opts = opts || {};
  device = device || getDeviceConfig();
  if (device.os !== 'android') return null;

  try {
    return loadAndroidMaterial();
  } catch (err) {
    if (err.code !== 'NO_APK_MATERIAL') throw err;
    if (process.env.WA_NO_APK_DOWNLOAD === '1') throw err;
  }

  const say = opts.onProgress || (m => _whaDbg('[DBG] APK ' + m));
  const AndroidApk = require('./AndroidApk');
  const PlayStore  = require('./PlayStore');

  say('no Android token material yet — fetching the WhatsApp APK from Google Play');
  let apk;
  try {
    apk = await PlayStore.downloadApk({ onProgress: m => say('  ' + m) });
  } catch (err) {
    throw new Error('could not fetch the WhatsApp APK automatically: ' + err.message +
      '\nRead it out of an APK you have instead:\n' +
      '  wa apk-material <base.apk> [split.apk ...]');
  }

  const material = AndroidApk.extractMaterial(apk.base, apk.splits);
  if (!material.apkVersion)     material.apkVersion     = apk.versionName;
  if (!material.apkVersionCode) material.apkVersionCode = apk.versionCode;

  const file = androidMaterialPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(AndroidApk.materialToJson(material), null, 2));
  say('  token material written to ' + file);

  // Re-read it rather than using what is in hand, so the downloaded APK goes
  // through the same signature check as one that was already on disk.
  _androidMaterial = null;
  return loadAndroidMaterial();
}

function loadAndroidMaterial() {
  if (_androidMaterial) return _androidMaterial;
  const file = androidMaterialPath();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (_) {
    const err = new Error('registering as Android needs the token material from a WhatsApp APK, ' +
      'and there is none at ' + file + '. Fetch it with:\n' +
      '  wa apk-material --download\n' +
      'or read it out of an APK you already have:\n' +
      '  wa apk-material <base.apk> [split.apk ...]\n' +
      'Registering as iOS needs none of this.');
    // Told apart from a refused repack, which must never be answered by
    // downloading over it.
    err.code = 'NO_APK_MATERIAL';
    throw err;
  }
  const material = AndroidApk.materialFromJson(JSON.parse(raw));

  // Refuse a repack before anything is sent.
  //
  // The token is an HMAC over the APK's signing certificates. An APK a mirror
  // re-signed — commonly with the AOSP test key, whose private half ships in the
  // Android sources — produces a well-formed token that belongs to nobody, and
  // the server answers bad_token, exactly as it does when there is no material
  // at all. Left to run, that spends /code attempts against a real phone number
  // on a request that cannot succeed, and attempts are what gets a number rate
  // limited. Checking the subject costs nothing and is the difference between a
  // refusal here and a number burned.
  const signer = AndroidApk.describeCertificate(material.certificates[0]);
  if (signer && !AndroidApk.looksLikeWhatsAppCertificate(signer) &&
      process.env.WA_ALLOW_FOREIGN_APK !== '1') {
    throw new Error('the APK this token material came from was not signed by WhatsApp — ' +
      'it is signed by "' + signer.subject.replace(/\n/g, ', ') + '". Re-signing replaces ' +
      'the certificate the token is built from, so every attempt would come back as ' +
      'bad_token. Take the APK from a phone that has WhatsApp installed:\n' +
      '  pm path com.whatsapp\n' +
      'then re-run wa apk-material with it. Set WA_ALLOW_FOREIGN_APK=1 to send it anyway.');
  }

  _androidMaterial = material;
  return _androidMaterial;
}

function computeToken(waVersion, national, device) {
  device = device || getDeviceConfig();
  if (device.os === 'android') {
    return AndroidApk.computeToken(loadAndroidMaterial(), national);
  }
  const staticToken    = process.env.WA_STATIC_TOKEN || IOS_STATIC_TOKEN;
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

// ---------- access_session_id ----------
// Cobalt's newAccessSessionId(): 16 random bytes → URL-safe base64 without
// padding (a 22-char token). Generated once per store/session and reused on
// every attested endpoint, matching the native client.

function newAccessSessionId() {
  return crypto.randomBytes(16).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function getAccessSessionId(store) {
  if (!store._accessSessionId) store._accessSessionId = newAccessSessionId();
  return store._accessSessionId;
}

// ---------- /code verification-code parameters (per platform, mirrors Cobalt) ----------
// Returns the alternating name/value form fields the native client emits on a
// /code request. Android sends the long device-fingerprint list; iOS sends the
// short list. Values match AndroidClientRegistration / IosClientRegistration;
// sim_mcc/sim_mnc/mcc/mnc keep whalibmob's real per-country values (better than
// Cobalt's "000" placeholder), and advertising_id / backup_token come from the
// store.

function buildClientMetrics(attempt) {
  const json = '{"attempts":' + (attempt || 1)
    + ',"app_campaign_download_source":"google-play|unknown"'
    + ',"is_sim_absent":false}';
  return encodeURIComponent(json);
}

function getRequestVerificationCodeParameters(store, method, meta, device, attempt) {
  if (device && device.os === 'android') {
    return [
      'method',                     method,
      'sim_mcc',                    meta.mcc,
      'sim_mnc',                    meta.mnc,
      'reason',                     '',
      'mcc',                        meta.mcc,
      'mnc',                        meta.mnc,
      'feo2_query_status',          'error_security_exception',
      'db',                         '1',
      'sim_type',                   '1',
      'recaptcha',                  '%7B%22stage%22%3A%22ABPROP_DISABLED%22%7D',
      'network_radio_type',         '1',
      'prefer_sms_over_flash',      'true',
      'simnum',                     '0',
      'airplane_mode_type',         '0',
      'client_metrics',             buildClientMetrics(attempt),
      'mistyped',                   '7',
      'advertising_id',             store.advertisingId || '',
      'hasinrc',                    '1',
      'roaming_type',               '0',
      'device_ram',                 '3.57',
      'education_screen_displayed', 'true',
      'pid',                        String(process.pid),
      'cellular_strength',          '5',
      'backup_token',               store.backupToken ? toUrlHex(store.backupToken) : '',
      'tos_version',                '5',
      'call_log_permission',        'false',
      'manage_call_permission',     'false',
      'clicked_education_link',     'false',
      'aid',                        '',
      // Omitted unless a push client supplies a real code — an empty value is
      // rejected as bad_format, an absent field is not validated at all.
      'push_code',                  null
    ];
  }

  // iOS
  return [
    'method',            method,
    'sim_mcc',           meta.mcc,
    'sim_mnc',           meta.mnc,
    'jailbroken',        '0',
    // Omitted unless a push client supplies a real code (see above).
    'push_code',         null,
    'cellular_strength', '1'
  ];
}

// ---------- Payload ----------

// base64url WITH padding — matches Java's Base64.getUrlEncoder().encodeToString()
function toBase64Url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

async function buildPayload(store, waVersion, useToken, extraPairs) {
  const { cc, national } = parsePhone(store.phoneNumber);
  const meta   = getCountryMeta(cc);
  const device = store.device || getDeviceConfig();
  const token  = useToken ? computeToken(waVersion, national, device) : null;
  // Android formats fdid lowercase, iOS uppercase (matches the native clients).
  const fdid   = device.os === 'android'
    ? store.fdid.toLowerCase()
    : store.fdid.toUpperCase();

  // Device-attestation fields shipped on every attested endpoint (Cobalt
  // attestationFields). Empty by default (NONE fallback); populated when a
  // Frida attestation server is configured via WA_FRIDA_HOST. The Play
  // Integrity nonce is a stable per-session value derived from the store.
  const nonceB64 = attestation.toBase64Url(
    crypto.createHash('sha256')
      .update(Buffer.concat([store.identityId, stripKeyPrefix(store.noiseKeyPair.public)]))
      .digest()
  );
  const attestFields = await attestation.attestationFields(device, nonceB64);

  return buildForm([
    'cc',                cc,
    'in',                national,
    'rc',                String(RELEASE_CHANNEL),
    'lg',                meta.lg,
    'lc',                meta.lc,
    'authkey',           toBase64Url(stripKeyPrefix(store.noiseKeyPair.public)),
    'e_regid',           toBase64Url(intToBytes(store.registrationId, 4)),
    'e_keytype',         toBase64Url(Buffer.from([SIGNAL_KEY_TYPE])),
    'e_ident',           toBase64Url(stripKeyPrefix(store.identityKeyPair.public)),
    'e_skey_id',         toBase64Url(intToBytes(store.signedPreKey.id, 3)),
    'e_skey_val',        toBase64Url(stripKeyPrefix(store.signedPreKey.public)),
    'e_skey_sig',        toBase64Url(store.signedPreKey.signature),
    'fdid',              fdid,
    'expid',             toBase64Url(store.deviceId),
    'id',                toUrlHex(store.identityId),
    'access_session_id', getAccessSessionId(store),
    'token',             token,
    ...attestFields
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

function httpPost(path, body, waVersion, authHeader, device) {
  const proxy = socksProxyUrl();
  if (proxy) return httpPostViaSocks(path, body, waVersion, proxy, authHeader, device);

  return new Promise((resolve, reject) => {
    const bodyBuf = Buffer.from(body, 'utf8');
    const headers = Object.assign(
      registrationHeaders(device || getDeviceConfig(), waVersion),
      { 'Content-Length': bodyBuf.length }
    );
    // Attestation cert-chain / App Attest header (Android cert chain, iOS
    // <attestation>|<keyId>). Only present when body attestation is available.
    if (authHeader) headers['Authorization'] = authHeader;
    const opts = {
      hostname: 'v.whatsapp.net',
      port: 443,
      path: '/v2' + path,
      method: 'POST',
      timeout: 20000,
      headers
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
  const plaintext = await buildPayload(store, waVersion, useToken, extraPairs);
  return sendEncrypted(path, plaintext, store, waVersion);
}

/**
 * Encrypt an already-built form body and post it.
 *
 * The attested endpoints reach this through sendRequest, which assembles the
 * shared registration fields first. The funnel endpoints build their own much
 * shorter body and come straight here — the native client sends no registration
 * fields with a client log, only the identifiers and the screen names.
 */
async function sendEncrypted(path, plaintext, store, waVersion) {
  const enc  = encryptPayload(plaintext);   // base64url ENC payload (no prefix)
  let   body = 'ENC=' + enc;

  // Body attestation over the ENC payload: Android appends a hex Keystore
  // signature as &H= and a cert-chain Authorization header; iOS appends the
  // App Attest assertion as &H= and an <attestation>|<keyId> Authorization
  // header. Both are empty (skipped) unless a Frida server is configured.
  const device  = store.device || getDeviceConfig();
  const bodyAtt = await attestation.attestBody(enc, device, {
    noisePubB64: stripKeyPrefix(store.noiseKeyPair.public).toString('base64')
  });
  if (bodyAtt.bodyAttestation) body += '&H=' + bodyAtt.bodyAttestation;

  _whaDbg('[DBG] REG → ' + path + ' (' + body.length + ' bytes' +
    (bodyAtt.bodyAttestation ? ', attested' : '') + ')');
  const result = await httpPost(path, body, waVersion, bodyAtt.authorizationHeader, device);
  _whaDbg('[DBG] REG ← ' + path + ' ' +
    (result && result.status ? result.status : JSON.stringify(result).slice(0, 120)) +
    (result && result.reason ? ' reason=' + result.reason : ''));
  return result;
}

// ---------- Funnel telemetry ----------
//
// The native client reports every screen it moves through — the number entry,
// the code request, the code submission, a captcha appearing, a PIN prompt —
// to /client_log, and one session-start event to /pre_pn_client_log before the
// number is even known. A client that registers without any of that is doing
// something no real installation does.
//
// It is fire-and-forget by design. Every failure is swallowed: telemetry that
// can abort a registration is worse than no telemetry. Set WA_FUNNEL_LOG=0 to
// send none of it.

function funnelEnabled() {
  return process.env.WA_FUNNEL_LOG !== '0';
}

// The screen a verification event belongs to, named after the method that was
// asked for — verify_sms, verify_voice. Before any request there is only the
// number entry screen.
function currentVerifyScreen(store) {
  return store._lastRequestedMethod ? 'verify_' + store._lastRequestedMethod : 'enter_number';
}

async function sendFunnelLog(store, waVersion, currentScreen, actionTaken, eventName) {
  if (!funnelEnabled()) return;
  try {
    const { cc, national } = parsePhone(store.phoneNumber);
    const device = store.device || getDeviceConfig();
    const fdid   = device.os === 'android'
      ? store.fdid.toLowerCase()
      : store.fdid.toUpperCase();

    const body = buildForm([
      'cc',              cc,
      'in',              national,
      'lg',              'en',
      'lc',              'US',
      'expid',           toBase64Url(store.deviceId),
      'fdid',            fdid,
      'id',              toUrlHex(store.identityId),
      'current_screen',  currentScreen,
      'previous_screen', store._funnelPreviousScreen || '',
      'action_taken',    actionTaken,
      'event_name',      eventName
    ], null);

    _whaDbg('[DBG] REG funnel ' + (store._funnelPreviousScreen || '—') + ' → ' +
      currentScreen + '  ' + actionTaken + '/' + eventName);
    await sendEncrypted('/client_log', body, store, waVersion);
    store._funnelPreviousScreen = currentScreen;
  } catch (err) {
    _whaDbg('[DBG] REG funnel log failed (' + currentScreen + '/' + actionTaken + '): ' +
      (err && err.message));
  }
}

// The one event that fires before a phone number is committed, so it carries
// neither cc nor in.
async function sendPrePnFunnelLog(store, waVersion, actionTaken, eventName) {
  if (!funnelEnabled()) return;
  try {
    const device = store.device || getDeviceConfig();
    const fdid   = device.os === 'android'
      ? store.fdid.toLowerCase()
      : store.fdid.toUpperCase();

    const body = buildForm([
      'lg',              'en',
      'lc',              'US',
      'expid',           toBase64Url(store.deviceId),
      'fdid',            fdid,
      'id',              toUrlHex(store.identityId),
      'current_screen',  'enter_number',
      'previous_screen', '',
      'action_taken',    actionTaken,
      'event_name',      eventName
    ], null);

    _whaDbg('[DBG] REG funnel (pre-pn)  ' + actionTaken + '/' + eventName);
    await sendEncrypted('/pre_pn_client_log', body, store, waVersion);
  } catch (err) {
    _whaDbg('[DBG] REG pre-pn funnel log failed: ' + (err && err.message));
  }
}

// ---------- Challenge and two-factor ----------

/** A captcha is a reply carrying an image or an audio blob to be solved. */
function hasChallenge(response) {
  if (!response) return false;
  return !!((response.image_blob && String(response.image_blob).length) ||
            (response.audio_blob && String(response.audio_blob).length));
}

/** Three spellings of the same demand, all of them still in use. */
function is2FARequired(response) {
  const reason = response && response.reason;
  if (!reason) return false;
  const r = String(reason).toLowerCase();
  return r === '2fa_required' || r === 'security_code' || r === 'two_factor_required';
}

/**
 * Decode a blob defensively.
 *
 * The server has been seen to switch between the standard and URL-safe base64
 * alphabets between releases, so both are tried before giving up.
 */
function decodeOrNull(b64) {
  if (!b64) return null;
  const str = String(b64);
  if (!str.length) return null;
  for (const alphabet of ['base64', 'base64url']) {
    try {
      const out = Buffer.from(str, alphabet);
      if (out.length) return out;
    } catch (_) {}
  }
  return null;
}

function isSuccessful(status) {
  return status === 'ok' || status === 'sent' || status === 'verified';
}

function normalizeCodeResult(code) {
  return String(code == null ? '' : code).replace(/[\s\-]/g, '').replace(/\D/g, '');
}

// Take the digits the server filed the account under. Brazilian mobiles are the
// standing example: they gained a ninth digit WhatsApp never adopted, and a
// session saved under the typed number sends a username on every connection
// that matches no registration.
function adoptCanonicalNumber(store, result) {
  const canonical = result.login ? String(result.login).replace(/\D/g, '') : null;
  if (canonical && canonical !== String(store.phoneNumber)) {
    result.canonicalPhoneNumber = canonical;
    result.typedPhoneNumber     = String(store.phoneNumber);
    store.phoneNumber           = canonical;
  }
  return result;
}

/**
 * Answer a captcha, and keep answering while the server keeps asking.
 *
 * A wrong answer is replied to with another challenge rather than a refusal,
 * which is why this loops. Solving needs a caller that can show the image to
 * somebody: without one there is nothing to do but say so, and hand the blobs
 * over on the error so it can be dealt with elsewhere.
 */
async function handleChallenge(store, waVersion, initial, opts) {
  const screen = currentVerifyScreen(store);
  await sendFunnelLog(store, waVersion, screen, 'challenge_shown', 'captcha_shown');

  let response = initial;
  for (;;) {
    const image = decodeOrNull(response.image_blob);
    const audio = decodeOrNull(response.audio_blob);

    let answer = null;
    if (typeof opts.solveCaptcha === 'function') {
      answer = await opts.solveCaptcha({ image, audio, response });
    }
    if (!answer) {
      await sendFunnelLog(store, waVersion, screen, 'challenge_abandoned', 'captcha_abandoned');
      const err = new Error(
        'Registration needs a CAPTCHA solved' +
        (typeof opts.solveCaptcha === 'function'
          ? ', and the solveCaptcha handler returned nothing.'
          : ', and no solveCaptcha handler was given.\n' +
            '  Pass one to verifyCode: verifyCode(store, code, { solveCaptcha: async ({ image, audio }) => "…" }).\n' +
            '  image and audio are Buffers, or null when that variant was not sent.')
      );
      err.captcha = { image, audio };
      err.raw     = response;
      throw err;
    }

    await sendFunnelLog(store, waVersion, screen, 'challenge_submitted', 'captcha_submitted');
    response = await sendRequest('/challenge', store, waVersion, true,
      ['code', normalizeCodeResult(answer)]);

    if (isSuccessful(response.status)) {
      await sendFunnelLog(store, waVersion, 'account_verification_complete',
        'challenge_submitted', 'captcha_success');
      return adoptCanonicalNumber(store, response);
    }
    if (hasChallenge(response)) {
      await sendFunnelLog(store, waVersion, screen, 'challenge_retry', 'captcha_retry');
      continue;                                   // wrong answer, another one
    }
    if (is2FARequired(response)) return handle2FA(store, waVersion, opts);

    const err = new Error('Registration CAPTCHA refused: ' +
      (response.reason || response.status || JSON.stringify(response)));
    err.raw = response;
    throw err;
  }
}

/**
 * Supply the two-step verification PIN the account has set.
 *
 * This is the account owner's own PIN, not anything the library can work out —
 * without a handler to ask, the registration stops here.
 */
async function handle2FA(store, waVersion, opts) {
  await sendFunnelLog(store, waVersion, 'verify_twofac', 'twofac_shown', 'twofac_prompt_shown');

  let pin = null;
  if (typeof opts.twoFactorPin === 'function') pin = await opts.twoFactorPin();
  if (!pin) {
    await sendFunnelLog(store, waVersion, 'verify_twofac', 'twofac_abandoned', 'twofac_abandoned');
    throw new Error(
      'This number has two-step verification switched on and the registration ' +
      'needs its PIN' +
      (typeof opts.twoFactorPin === 'function'
        ? ', but the twoFactorPin handler returned nothing.'
        : '.\n  Pass one to verifyCode: verifyCode(store, code, { twoFactorPin: async () => "123456" }).\n' +
          '  It is the six-digit PIN set on the phone under Settings → Account → Two-step verification.')
    );
  }

  await sendFunnelLog(store, waVersion, 'verify_twofac', 'twofac_submitted', 'twofac_submitted');
  const response = await sendRequest('/security', store, waVersion, true,
    ['code', normalizeCodeResult(pin)]);

  if (isSuccessful(response.status)) {
    await sendFunnelLog(store, waVersion, 'account_verification_complete',
      'twofac_submitted', 'twofac_success');
    return adoptCanonicalNumber(store, response);
  }

  const err = new Error('Two-step verification PIN refused: ' +
    (response.reason || response.status || JSON.stringify(response)));
  err.raw = response;
  throw err;
}

// ---------- Public API ----------

async function checkIfRegistered(store) {
  const waVersion = await fetchWaVersion(store.device || getDeviceConfig());
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
  const _device   = getDeviceConfig();
  const store     = createNewStore(phoneNumber);
  const waVersion = await fetchWaVersion(_device);
  const { cc }    = parsePhone(phoneNumber);
  const meta      = getCountryMeta(cc);

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
      const extra = getRequestVerificationCodeParameters(store, method, meta, _device, 1);
      return await sendRequest('/code', store, waVersion, true, extra);
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
  // The session-start event the native client fires before it knows the number.
  await sendPrePnFunnelLog(store, waVersion, 'session_start', 'registration_session_start');
  await sendFunnelLog(store, waVersion, 'enter_number', 'exist_check', 'exist_attempt');

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await sendRequest('/exist', store, waVersion, false, null);
      // reason === 'incorrect' → keys not found → fresh
      if (result && result.reason === 'incorrect') {
        await sendFunnelLog(store, waVersion, 'enter_number', 'exist_check', 'exist_success');
        return true;
      }
      // Any non-ok status on 2nd attempt → still treat as fresh (network/server glitch)
      if (attempt === 1 && result && result.status && result.status !== 'ok') {
        await sendFunnelLog(store, waVersion, 'enter_number', 'exist_check', 'exist_success');
        return true;
      }
    } catch (_) {
      // Network error = treat keys as fresh
      return true;
    }
  }

  await sendFunnelLog(store, waVersion, 'enter_number', 'exist_check', 'exist_failure');
  return false;
}

async function requestSmsCode(store, method, opts) {
  method = method || 'sms';
  opts   = opts   || {};
  // Before the version is read, since on Android the version comes out of the
  // APK this fetches.
  // What a session registered as is settled when it is created, so it is the
  // store that decides — not whatever WA_OS the shell happens to carry now. A
  // confirmation run from a shell without the variables would otherwise sign an
  // Android registration with an iOS token.
  const _device   = store.device || getDeviceConfig();
  await ensureAndroidMaterial(opts, _device);
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
      ...getRequestVerificationCodeParameters(store, 'email', _regMeta, _device, 1),
      'email', emailAddr
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
    // Retry loop:
    //   1. Try /code
    //   2. Success → return result
    //   3. too_recent/too_many → throw immediately
    //   4. no_routes → return null (caller handles fallback)
    //   5. custom_block_screen → throw with IP hint
    //   6. Same error twice → throw to break loop
    //   7. Unknown error first time → retry once
    let lastReason = null;
    let attemptNum = 1;
    while (true) {
      // Rebuilt per attempt so client_metrics carries the current attempt count.
      const extra = getRequestVerificationCodeParameters(store, m, _regMeta, _device, attemptNum);

      // The screen a later event belongs to is named after the method asked
      // for here, so record it before the request rather than after.
      store._lastRequestedMethod = m;
      const verifyScreen = currentVerifyScreen(store);
      await sendFunnelLog(store, waVersion, verifyScreen, 'request_code', 'request_code_attempt');

      const result = await sendRequest('/code', store, waVersion, true, extra);

      const status = result.status;
      if (status === 'ok' || status === 'sent') {
        await sendFunnelLog(store, waVersion, verifyScreen, 'request_code', 'request_code_success');
        return result;
      }

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
      attemptNum++;
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

async function verifyCode(store, code, opts) {
  opts = opts || {};
  // Normally already there from the code request, but a confirmation can be run
  // from a fresh shell that never made one.
  // What a session registered as is settled when it is created, so it is the
  // store that decides — not whatever WA_OS the shell happens to carry now. A
  // confirmation run from a shell without the variables would otherwise sign an
  // Android registration with an iOS token.
  const _device   = store.device || getDeviceConfig();
  await ensureAndroidMaterial(opts, _device);
  const waVersion = await fetchWaVersion(_device);
  store.version = waVersion;
  store.device  = _device;
  const normalized = code.replace(/[\s\-]/g, '').replace(/\D/g, '');

  const screen = currentVerifyScreen(store);
  await sendFunnelLog(store, waVersion, screen, 'submit_code', 'submit_code_attempt');

  const result = await sendRequest('/register', store, waVersion, true, ['code', normalized]);

  const status = result.status;
  if (status === 'ok' || status === 'sent' || status === 'verified') {
    await sendFunnelLog(store, waVersion, 'account_verification_complete',
      'submit_code', 'submit_code_success');
    // Adopt the number in the server's own form.
    //
    // WhatsApp answers with `login`, the canonical digits it filed the account
    // under, and that is not always what was typed. Brazilian mobiles are the
    // standing example: they gained a ninth digit, WhatsApp keeps the account
    // under the eight-digit form, and a session saved under the typed number
    // sends a username on every connection that matches no registration. The
    // handshake then fails with 401 and nothing in the message hints at why.
    return adoptCanonicalNumber(store, result);
  }

  // Before reading the reason, because neither of these arrives as one. A
  // captcha comes as image and audio blobs with nothing else to go on, and a
  // PIN demand names a reason that none of the branches below would match —
  // both would otherwise fall through to the generic failure.
  if (hasChallenge(result))  return handleChallenge(store, waVersion, result, opts);
  if (is2FARequired(result)) return handle2FA(store, waVersion, opts);

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
  // Age / consent gate.
  //
  // The server found the account and did not complain about the code — it is
  // asking for an age signal that only a real app-store install carries, and
  // refusing to finish without it. Brazil is where this shows up, which fits:
  // it is the market with an age-verification law behind it.
  //
  // Worth knowing before trying anything: the iOS request carries six fields
  // and not one of them says anything about consent, terms or age. The Android
  // one carries tos_version, education_screen_displayed and
  // clicked_education_link. That is the difference to try first, and it costs
  // nothing to try.
  if (result.pending === 'app_store_age' || reason === 'consent') {
    const canonical = result.login ? String(result.login).replace(/\D/g, '') : null;
    const lines = [
      'Verification failed: WhatsApp wants an age-consent signal for this number ' +
        'and will not finish the registration without one' +
        (result.pending ? ' (pending: ' + result.pending + ')' : '') + '.',
      '  The code itself was not refused — the account was found' +
        (canonical ? ', filed as +' + canonical : '') + '.'
    ];
    if (canonical && canonical !== String(store.phoneNumber)) {
      lines.push('  Note the digits: you typed +' + store.phoneNumber +
        ', WhatsApp keeps it as +' + canonical + '. Brazilian mobiles gained a ' +
        'ninth digit that WhatsApp did not adopt, and that alone is not the failure here.');
    }
    lines.push(
      '  Try registering as an Android device instead — that request carries the ' +
        'terms and education fields the iOS one has none of:',
      '      WA_OS=android wa registration --code ' + store.phoneNumber,
      '  If that is refused too, this number needs the real app once, on a phone, ' +
        'to clear the gate.'
    );
    const err = new Error(lines.join('\n'));
    err.reason    = reason;
    err.pending   = result.pending || null;
    err.canonicalPhoneNumber = canonical;
    err.raw       = result;
    throw err;
  }
  throw new Error(`Verification failed: ${reason || JSON.stringify(result)}`);
}

module.exports = { checkIfRegistered, checkNumberStatus, requestSmsCode, verifyCode, fetchIosVersion, fetchAndroidVersion, fetchWaVersion, parsePhone, getCountryMeta, assertRegistrationKeys, parseSocksProxy, socksProxyUrl };

// The HTTP reader, exposed for tests. Not part of the public API.
module.exports._http = { readHttpResponse, parseHttpResponse, decodeChunkedBody };

// Token computation, exposed for tests. Not part of the public API.
module.exports._token = { computeToken, androidMaterialPath, registrationHeaders, ensureAndroidMaterial };

// Challenge / two-factor internals, exposed for tests. Not part of the public API.
module.exports._verify = {
  hasChallenge, is2FARequired, decodeOrNull, isSuccessful,
  normalizeCodeResult, currentVerifyScreen, adoptCanonicalNumber, funnelEnabled
};
