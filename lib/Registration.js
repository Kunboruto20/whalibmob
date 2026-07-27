'use strict';

const crypto = require('crypto');
const https  = require('https');
const tls    = require('tls');
const curveJs = require('curve25519-js');
const { getDeviceConfig } = require('./DeviceConfig');
const attestation = require('./Attestation');

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

async function httpPostViaSocks(path, body, waVersion, proxyUrl, authHeader) {
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

  const _dev = getDeviceConfig();
  const userAgent = _dev.os === 'android'
    ? `WhatsApp/${waVersion} A`
    : `WhatsApp/${waVersion} iOS/${_dev.osVersion} Device/${_dev.model}`;
  const reqLines = [
    `POST /v2${path} HTTP/1.1`,
    `Host: ${dHost}`,
    `User-Agent: ${userAgent}`,
    `Content-Type: application/x-www-form-urlencoded`,
    `Content-Length: ${Buffer.byteLength(body)}`
  ];
  if (authHeader) reqLines.push(`Authorization: ${authHeader}`);
  // close, not keep-alive: the response is read by waiting for the server to
  // end the stream. Asking it to keep the connection open means that never
  // happens and the request hangs until something else times out.
  reqLines.push(`Connection: close`, '', body);
  const req = reqLines.join('\r\n');

  tlsSocket.write(req);

  const chunks = [];
  await new Promise((res, rej) => {
    const timer = setTimeout(() => {
      tlsSocket.destroy();
      rej(new Error('SOCKS proxy timed out reading ' + path));
    }, 30000);
    const finish = (fn, arg) => { clearTimeout(timer); fn(arg); };
    tlsSocket.on('data',  d  => chunks.push(d));
    tlsSocket.on('end',   () => finish(res));
    tlsSocket.on('close', () => finish(res));
    tlsSocket.on('error', e  => finish(rej, e));
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
  const token  = useToken ? computeToken(waVersion, national) : null;
  const device = store.device || getDeviceConfig();
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

function httpPost(path, body, waVersion, authHeader) {
  const proxy = socksProxyUrl();
  if (proxy) return httpPostViaSocks(path, body, waVersion, proxy, authHeader);

  return new Promise((resolve, reject) => {
    const _httpDev  = getDeviceConfig();
    const userAgent = _httpDev.os === 'android'
      ? `WhatsApp/${waVersion} A`
      : `WhatsApp/${waVersion} iOS/${_httpDev.osVersion} Device/${_httpDev.model}`;
    const bodyBuf = Buffer.from(body, 'utf8');
    const headers = {
      'User-Agent':      userAgent,
      'Content-Type':   'application/x-www-form-urlencoded',
      'Content-Length': bodyBuf.length
    };
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

  return httpPost(path, body, waVersion, bodyAtt.authorizationHeader);
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

async function verifyCode(store, code) {
  const _device   = getDeviceConfig();
  const waVersion = await fetchWaVersion(_device);
  store.version = waVersion;
  store.device  = _device;
  const normalized = code.replace(/[\s\-]/g, '').replace(/\D/g, '');
  const result = await sendRequest('/register', store, waVersion, true, ['code', normalized]);

  const status = result.status;
  if (status === 'ok' || status === 'sent' || status === 'verified') {
    // Adopt the number in the server's own form.
    //
    // WhatsApp answers with `login`, the canonical digits it filed the account
    // under, and that is not always what was typed. Brazilian mobiles are the
    // standing example: they gained a ninth digit, WhatsApp keeps the account
    // under the eight-digit form, and a session saved under the typed number
    // sends a username on every connection that matches no registration. The
    // handshake then fails with 401 and nothing in the message hints at why.
    const canonical = result.login ? String(result.login).replace(/\D/g, '') : null;
    if (canonical && canonical !== String(store.phoneNumber)) {
      result.canonicalPhoneNumber = canonical;
      result.typedPhoneNumber     = String(store.phoneNumber);
      store.phoneNumber           = canonical;
    }
    return result;
  }

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

module.exports = { checkIfRegistered, checkNumberStatus, requestSmsCode, verifyCode, fetchIosVersion, fetchAndroidVersion, fetchWaVersion, parsePhone, getCountryMeta, assertRegistrationKeys, parseSocksProxy, socksProxyUrl };
