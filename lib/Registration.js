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
const { dbg: _whaDbg, warn: _whaWarn } = require('./logger');

// ---------- Request envelope ----------
//
// The registration server reads which platform is calling out of the
// User-Agent. There is no form field for it — none is sent — so a request whose
// User-Agent does not name a platform it knows is refused with
// {"param":"platform","reason":"bad_param"} on every endpoint. The
// giveaway is that /client_log is refused the same way, and its body carries no
// device fields at all: nothing about the platform is in the body to begin with.
//
// Android used to be sent as `WhatsApp/<version> A`, which names nothing, and
// was refused everywhere. iOS has always sent the full form and has always
// worked, which is why only one of the two platforms was broken.
//
// The three extra Android headers were observed on a live native Android
// registration. The native iOS client omits all three, so the iOS envelope
// stays exactly as it was.
// The platform token in the User-Agent. The Business builds name themselves
// differently — `SMBA` on Android, `SMB iOS` on iOS — and the registration
// server reads the platform out of exactly this string.
function _uaPlatformName(device) {
  if (device.os === 'android') return device.business ? 'SMBA' : 'Android';
  return device.business ? 'SMB iOS' : 'iOS';
}

function registrationHeaders(device, waVersion) {
  if (device.os === 'android') {
    return {
      'User-Agent':     `WhatsApp/${waVersion} ${_uaPlatformName(device)}/${device.osVersion} Device/${device.manufacturer}-${device.modelId}`,
      'Content-Type':   'application/x-www-form-urlencoded',
      'Accept':         'text/json',
      'WaMsysRequest':  '1',
      // A fresh one per request, the way the native client mints it.
      'request_token':  uuidv4()
    };
  }
  return {
    'User-Agent':   `WhatsApp/${waVersion} ${_uaPlatformName(device)}/${device.osVersion} Device/${device.model}`,
    'Content-Type': 'application/x-www-form-urlencoded'
  };
}

// ---------- SOCKS4 / SOCKS5 / Tor support ----------
//
// The parsing, the dialer and the HTTPS agent all live in ./socks now, because
// registration is no longer the only thing that needs them: the version
// lookups below, the web sw.js probe, the WhatsApp Web socket and the mobile
// TCP socket route through the same proxy. They are re-exported at the bottom
// of this file so existing importers keep working.
const {
  parseSocksProxy, socksProxyUrl, socksConnect, proxyAgent
} = require('./socks');

async function httpPostViaSocks(path, body, waVersion, proxyUrl, authHeader, device) {
  const dHost = 'v.whatsapp.net';
  const dPort = 443;

  // socksConnect carries the same 20s handshake timeout this used to set
  // inline: without one, a proxy that accepts the TCP connection and then says
  // nothing leaves the whole registration hanging with no error.
  const rawSocket = await socksConnect(proxyUrl, dHost, dPort);

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
  IOS_BUSINESS_STATIC_TOKEN,
  IOS_VERSION_FALLBACK,
  ANDROID_VERSION_FALLBACK,
  IOS_USER_AGENT,
  IOS_DEVICE,
  SIGNAL_KEY_TYPE,
  RELEASE_CHANNEL,
  WHATSAPP_PACKAGE,
  WHATSAPP_BUSINESS_PACKAGE,
  IOS_BUNDLE_ID,
  IOS_BUSINESS_BUNDLE_ID
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
  // Filled in from the ITU mobile-network tables so a number from anywhere
  // reports the carrier its country actually has. Without an entry a session
  // falls back to 000/000, which is what a handset with no SIM card reports.
  // One operational national operator per country; the point is a plausible
  // home network, not a particular one.
  '53':    { mcc: '368', mnc: '01', lg: 'es', lc: 'CU' }, // Cuba (CUBACEL)
  '211':   { mcc: '659', mnc: '02', lg: 'en', lc: 'SS' }, // South Sudan (MTN)
  '220':   { mcc: '607', mnc: '01', lg: 'en', lc: 'GM' }, // Gambia (Gamcel)
  '221':   { mcc: '608', mnc: '01', lg: 'fr', lc: 'SN' }, // Senegal (Orange)
  '222':   { mcc: '609', mnc: '01', lg: 'ar', lc: 'MR' }, // Mauritania (Mattel)
  '223':   { mcc: '610', mnc: '01', lg: 'fr', lc: 'ML' }, // Mali (Malitel)
  '224':   { mcc: '611', mnc: '01', lg: 'fr', lc: 'GN' }, // Guinea (Orange)
  '225':   { mcc: '612', mnc: '02', lg: 'fr', lc: 'CI' }, // Ivory Coast (Moov)
  '226':   { mcc: '613', mnc: '01', lg: 'fr', lc: 'BF' }, // Burkina Faso (Telmob)
  '227':   { mcc: '614', mnc: '01', lg: 'fr', lc: 'NE' }, // Niger (SahelCom)
  '228':   { mcc: '615', mnc: '01', lg: 'fr', lc: 'TG' }, // Togo (Togo Cell)
  '229':   { mcc: '616', mnc: '01', lg: 'fr', lc: 'BJ' }, // Benin (Benin Telecoms Mob)
  '230':   { mcc: '617', mnc: '01', lg: 'en', lc: 'MU' }, // Mauritius (my.t)
  '231':   { mcc: '618', mnc: '01', lg: 'en', lc: 'LR' }, // Liberia (Lonestar Cell MTN)
  '232':   { mcc: '619', mnc: '01', lg: 'en', lc: 'SL' }, // Sierra Leone (Orange)
  '233':   { mcc: '620', mnc: '01', lg: 'en', lc: 'GH' }, // Ghana (MTN)
  '235':   { mcc: '622', mnc: '01', lg: 'ar', lc: 'TD' }, // Chad (Airtel)
  '236':   { mcc: '623', mnc: '01', lg: 'fr', lc: 'CF' }, // Central African Republic (Moov)
  '237':   { mcc: '624', mnc: '01', lg: 'en', lc: 'CM' }, // Cameroon (MTN Cameroon)
  '238':   { mcc: '625', mnc: '01', lg: 'pt', lc: 'CV' }, // Cape Verde (CVMOVEL)
  '239':   { mcc: '626', mnc: '01', lg: 'pt', lc: 'ST' }, // São Tomé and Príncipe (CSTmovel)
  '240':   { mcc: '627', mnc: '01', lg: 'fr', lc: 'GQ' }, // Equatorial Guinea (Orange GQ)
  '241':   { mcc: '628', mnc: '01', lg: 'fr', lc: 'GA' }, // Gabon (Libertis)
  '242':   { mcc: '629', mnc: '01', lg: 'fr', lc: 'CG' }, // Republic of the Congo (Airtel)
  '243':   { mcc: '630', mnc: '01', lg: 'fr', lc: 'CD' }, // DR Congo (Vodacom)
  '244':   { mcc: '631', mnc: '02', lg: 'pt', lc: 'AO' }, // Angola (UNITEL)
  '245':   { mcc: '632', mnc: '01', lg: 'pt', lc: 'GW' }, // Guinea-Bissau (Guinetel)
  '248':   { mcc: '633', mnc: '01', lg: 'en', lc: 'SC' }, // Seychelles (Cable & Wireless)
  '249':   { mcc: '634', mnc: '01', lg: 'ar', lc: 'SD' }, // Sudan (Zain SD)
  '250':   { mcc: '635', mnc: '10', lg: 'en', lc: 'RW' }, // Rwanda (MTN)
  '251':   { mcc: '636', mnc: '01', lg: 'am', lc: 'ET' }, // Ethiopia (MTN)
  '252':   { mcc: '637', mnc: '01', lg: 'ar', lc: 'SO' }, // Somalia (Telesom)
  '253':   { mcc: '638', mnc: '01', lg: 'ar', lc: 'DJ' }, // Djibouti (Evatis)
  '257':   { mcc: '642', mnc: '01', lg: 'fr', lc: 'BI' }, // Burundi (econet Leo)
  '258':   { mcc: '643', mnc: '01', lg: 'pt', lc: 'MZ' }, // Mozambique (mCel)
  '260':   { mcc: '645', mnc: '01', lg: 'en', lc: 'ZM' }, // Zambia (Airtel)
  '261':   { mcc: '646', mnc: '01', lg: 'fr', lc: 'MG' }, // Madagascar (Airtel)
  '263':   { mcc: '648', mnc: '01', lg: 'en', lc: 'ZW' }, // Zimbabwe (Net*One)
  '264':   { mcc: '649', mnc: '01', lg: 'af', lc: 'NA' }, // Namibia (MTC)
  '265':   { mcc: '650', mnc: '01', lg: 'en', lc: 'MW' }, // Malawi (TNM)
  '266':   { mcc: '651', mnc: '01', lg: 'en', lc: 'LS' }, // Lesotho (Vodacom)
  '267':   { mcc: '652', mnc: '01', lg: 'en', lc: 'BW' }, // Botswana (Mascom)
  '268':   { mcc: '653', mnc: '02', lg: 'en', lc: 'SZ' }, // Eswatini (Eswatini Mobile Li)
  '269':   { mcc: '654', mnc: '01', lg: 'ar', lc: 'KM' }, // Comoros (HURI)
  '290':   { mcc: '658', mnc: '01', lg: 'en', lc: 'SH' }, // Saint Helena, Ascension and Tristan da Cunha (Sure)
  '291':   { mcc: '657', mnc: '01', lg: 'ar', lc: 'ER' }, // Eritrea (Eritel)
  '297':   { mcc: '363', mnc: '01', lg: 'nl', lc: 'AW' }, // Aruba (SETAR)
  '298':   { mcc: '288', mnc: '01', lg: 'da', lc: 'FO' }, // Faroe Islands (Føroya Tele)
  '299':   { mcc: '290', mnc: '01', lg: 'kl', lc: 'GL' }, // Greenland (tusass)
  '350':   { mcc: '266', mnc: '01', lg: 'en', lc: 'GI' }, // Gibraltar (GibTel)
  '352':   { mcc: '270', mnc: '01', lg: 'de', lc: 'LU' }, // Luxembourg (POST)
  '354':   { mcc: '274', mnc: '01', lg: 'is', lc: 'IS' }, // Iceland (Síminn)
  '355':   { mcc: '276', mnc: '01', lg: 'sq', lc: 'AL' }, // Albania (ONE)
  '356':   { mcc: '278', mnc: '01', lg: 'en', lc: 'MT' }, // Malta (Epic)
  '357':   { mcc: '280', mnc: '01', lg: 'el', lc: 'CY' }, // Cyprus (Cytamobile-Vodafon)
  '359':   { mcc: '284', mnc: '01', lg: 'bg', lc: 'BG' }, // Bulgaria (A1 BG)
  '370':   { mcc: '246', mnc: '01', lg: 'lt', lc: 'LT' }, // Lithuania (Telia)
  '371':   { mcc: '247', mnc: '01', lg: 'lv', lc: 'LV' }, // Latvia (LMT)
  '372':   { mcc: '248', mnc: '01', lg: 'et', lc: 'EE' }, // Estonia (Telia)
  '373':   { mcc: '259', mnc: '01', lg: 'ro', lc: 'MD' }, // Moldova (Orange)
  '374':   { mcc: '283', mnc: '01', lg: 'hy', lc: 'AM' }, // Armenia (Beeline)
  '375':   { mcc: '257', mnc: '01', lg: 'be', lc: 'BY' }, // Belarus (A1)
  '376':   { mcc: '213', mnc: '03', lg: 'ca', lc: 'AD' }, // Andorra (Som, Mobiland)
  '377':   { mcc: '212', mnc: '10', lg: 'fr', lc: 'MC' }, // Monaco (Office des Telepho)
  '378':   { mcc: '292', mnc: '01', lg: 'it', lc: 'SM' }, // San Marino (PRIMA)
  '381':   { mcc: '220', mnc: '01', lg: 'sr', lc: 'RS' }, // Serbia (Yettel)
  '382':   { mcc: '297', mnc: '01', lg: 'en', lc: 'ME' }, // Montenegro (One)
  '383':   { mcc: '221', mnc: '01', lg: 'sq', lc: 'XK' }, // Kosovo (Vala)
  '385':   { mcc: '219', mnc: '01', lg: 'hr', lc: 'HR' }, // Croatia (HT HR)
  '386':   { mcc: '293', mnc: '10', lg: 'sl', lc: 'SI' }, // Slovenia (SŽ - Infrastruktur)
  '387':   { mcc: '218', mnc: '03', lg: 'bs', lc: 'BA' }, // Bosnia and Herzegovina (HT-ERONET)
  '389':   { mcc: '294', mnc: '01', lg: 'mk', lc: 'MK' }, // North Macedonia (Telekom.mk)
  '421':   { mcc: '231', mnc: '01', lg: 'sk', lc: 'SK' }, // Slovakia (Orange)
  '423':   { mcc: '295', mnc: '01', lg: 'de', lc: 'LI' }, // Liechtenstein (Swisscom)
  '500':   { mcc: '750', mnc: '001', lg: 'en', lc: 'FK' }, // Falkland Islands (Sure)
  '501':   { mcc: '702', mnc: '67', lg: 'en', lc: 'BZ' }, // Belize (DigiCell)
  '502':   { mcc: '704', mnc: '01', lg: 'es', lc: 'GT' }, // Guatemala (Claro)
  '503':   { mcc: '706', mnc: '01', lg: 'es', lc: 'SV' }, // El Salvador (Claro)
  '504':   { mcc: '708', mnc: '001', lg: 'es', lc: 'HN' }, // Honduras (Claro)
  '505':   { mcc: '710', mnc: '21', lg: 'es', lc: 'NI' }, // Nicaragua (Claro)
  '506':   { mcc: '712', mnc: '01', lg: 'es', lc: 'CR' }, // Costa Rica (Kölbi ICE)
  '507':   { mcc: '714', mnc: '01', lg: 'es', lc: 'PA' }, // Panama (Cable & Wireless)
  '508':   { mcc: '308', mnc: '01', lg: 'fr', lc: 'PM' }, // Saint Pierre and Miquelon (Ameris)
  '509':   { mcc: '372', mnc: '02', lg: 'fr', lc: 'HT' }, // Haiti (Digicel)
  '591':   { mcc: '736', mnc: '01', lg: 'ay', lc: 'BO' }, // Bolivia (Viva)
  '592':   { mcc: '738', mnc: '00', lg: 'en', lc: 'GY' }, // Guyana (E-Networks)
  '593':   { mcc: '740', mnc: '00', lg: 'es', lc: 'EC' }, // Ecuador (Movistar)
  '594':   { mcc: '340', mnc: '01', lg: 'fr', lc: 'GF' }, // French Guiana (Orange)
  '595':   { mcc: '744', mnc: '01', lg: 'gn', lc: 'PY' }, // Paraguay (VOX)
  '597':   { mcc: '746', mnc: '02', lg: 'nl', lc: 'SR' }, // Suriname (Telesur)
  '598':   { mcc: '748', mnc: '01', lg: 'es', lc: 'UY' }, // Uruguay (Antel)
  '670':   { mcc: '514', mnc: '01', lg: 'pt', lc: 'TL' }, // Timor-Leste (Telkomcel)
  '672':   { mcc: '505', mnc: '10', lg: 'en', lc: 'NF' }, // Norfolk Island (Norfolk Telecom)
  '673':   { mcc: '528', mnc: '02', lg: 'ms', lc: 'BN' }, // Brunei (PCSB)
  '674':   { mcc: '536', mnc: '02', lg: 'en', lc: 'NR' }, // Nauru (Digicel)
  '675':   { mcc: '537', mnc: '01', lg: 'en', lc: 'PG' }, // Papua New Guinea (bmobile)
  '676':   { mcc: '539', mnc: '01', lg: 'en', lc: 'TO' }, // Tonga (U-Call)
  '677':   { mcc: '540', mnc: '01', lg: 'en', lc: 'SB' }, // Solomon Islands (BREEZE)
  '678':   { mcc: '541', mnc: '00', lg: 'bi', lc: 'VU' }, // Vanuatu (AIL)
  '679':   { mcc: '542', mnc: '01', lg: 'en', lc: 'FJ' }, // Fiji (Vodafone)
  '680':   { mcc: '552', mnc: '01', lg: 'en', lc: 'PW' }, // Palau (PNCC)
  '681':   { mcc: '543', mnc: '01', lg: 'fr', lc: 'WF' }, // Wallis and Futuna (Manuia)
  '682':   { mcc: '548', mnc: '01', lg: 'en', lc: 'CK' }, // Cook Islands (Vodafone)
  '683':   { mcc: '555', mnc: '01', lg: 'en', lc: 'NU' }, // Niue (Telecom Niue)
  '685':   { mcc: '549', mnc: '01', lg: 'en', lc: 'WS' }, // Samoa (Digicel)
  '686':   { mcc: '545', mnc: '01', lg: 'en', lc: 'KI' }, // Kiribati (Kiribati - ATH)
  '687':   { mcc: '546', mnc: '01', lg: 'fr', lc: 'NC' }, // New Caledonia (Mobilis)
  '688':   { mcc: '553', mnc: '01', lg: 'en', lc: 'TV' }, // Tuvalu (TTC)
  '689':   { mcc: '547', mnc: '05', lg: 'fr', lc: 'PF' }, // French Polynesia (Ora)
  '690':   { mcc: '554', mnc: '01', lg: 'en', lc: 'TK' }, // Tokelau (Teletok)
  '691':   { mcc: '550', mnc: '01', lg: 'en', lc: 'FM' }, // Micronesia (FSMTC)
  '692':   { mcc: '551', mnc: '01', lg: 'en', lc: 'MH' }, // Marshall Islands (Marshall Islands N)
  '850':   { mcc: '467', mnc: '05', lg: 'ko', lc: 'KP' }, // North Korea (Koryolink)
  '852':   { mcc: '454', mnc: '00', lg: 'en', lc: 'HK' }, // Hong Kong (1O1O / One2Free / )
  '853':   { mcc: '455', mnc: '00', lg: 'pt', lc: 'MO' }, // Macau (SmarTone)
  '855':   { mcc: '456', mnc: '01', lg: 'km', lc: 'KH' }, // Cambodia (Cellcard)
  '856':   { mcc: '457', mnc: '01', lg: 'lo', lc: 'LA' }, // Laos (LaoTel)
  '886':   { mcc: '466', mnc: '01', lg: 'zh', lc: 'TW' }, // Taiwan (FarEasTone)
  '960':   { mcc: '472', mnc: '01', lg: 'dv', lc: 'MV' }, // Maldives (Dhiraagu)
  '961':   { mcc: '415', mnc: '01', lg: 'ar', lc: 'LB' }, // Lebanon (Alfa)
  '962':   { mcc: '416', mnc: '01', lg: 'ar', lc: 'JO' }, // Jordan (zain JO)
  '963':   { mcc: '417', mnc: '01', lg: 'ar', lc: 'SY' }, // Syria (Syriatel)
  '964':   { mcc: '418', mnc: '00', lg: 'ar', lc: 'IQ' }, // Iraq (Asia Cell)
  '965':   { mcc: '419', mnc: '02', lg: 'ar', lc: 'KW' }, // Kuwait (zain KW)
  '967':   { mcc: '421', mnc: '01', lg: 'ar', lc: 'YE' }, // Yemen (SabaFon)
  '968':   { mcc: '422', mnc: '02', lg: 'ar', lc: 'OM' }, // Oman (Omantel)
  '970':   { mcc: '425', mnc: '05', lg: 'ar', lc: 'PS' }, // Palestine (Jawwal)
  '973':   { mcc: '426', mnc: '01', lg: 'ar', lc: 'BH' }, // Bahrain (Batelco)
  '974':   { mcc: '427', mnc: '01', lg: 'ar', lc: 'QA' }, // Qatar (Ooredoo)
  '975':   { mcc: '402', mnc: '11', lg: 'dz', lc: 'BT' }, // Bhutan (B-Mobile)
  '976':   { mcc: '428', mnc: '88', lg: 'mn', lc: 'MN' }, // Mongolia (Unitel)
  '977':   { mcc: '429', mnc: '01', lg: 'ne', lc: 'NP' }, // Nepal (Namaste / NT Mobil)
  '992':   { mcc: '436', mnc: '01', lg: 'ru', lc: 'TJ' }, // Tajikistan (Tcell)
  '993':   { mcc: '438', mnc: '02', lg: 'ru', lc: 'TM' }, // Turkmenistan (TM-Cell)
  '994':   { mcc: '400', mnc: '01', lg: 'az', lc: 'AZ' }, // Azerbaijan (Azercell)
  '995':   { mcc: '282', mnc: '01', lg: 'ka', lc: 'GE' }, // Georgia (Geocell)
  '996':   { mcc: '437', mnc: '01', lg: 'ky', lc: 'KG' }, // Kyrgyzstan (Beeline)
  '998':   { mcc: '434', mnc: '03', lg: 'ru', lc: 'UZ' }, // Uzbekistan (UzMobile)
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
  '211','212','213','216','218','220','221','222','223','224','225','226',
  '227','228','229','230','231','232','233','234','235','236','237','238',
  '239','240','241','242','243','244','245','246','247','248','249','250',
  '251','252','253','254','255','256','257','258','260','261','262','263',
  '264','265','266','267','268','269','290','291','297','298','299','350',
  '351','352','353','354','355','356','357','358','359','370','371','372',
  '373','374','375','376','377','378','380','381','382','383','385','386',
  '387','389','420','421','423','500','501','502','503','504','505','506',
  '507','508','509','590','591','592','593','594','595','596','597','598',
  '599','670','672','673','674','675','676','677','678','679','680','681',
  '682','683','685','686','687','688','689','690','691','692','850','852',
  '853','855','856','880','886','960','961','962','963','964','965','966',
  '967','968','970','971','972','973','974','975','976','977','992','993',
  '994','995','996','998'
]);

const TWO_DIGIT_CCS = new Set([
  '20','27','30','31','32','33','34','36','39','40','41','43','44','45',
  '46','47','48','49','51','52','53','54','55','56','57','58','60','61',
  '62','63','64','65','66','81','82','84','86','90','91','92','93','94',
  '95','98'
]);

// The country table only covers the places we carry carrier metadata for, which
// is far fewer than the places that can register. Anything it names still has to
// be splittable, so it is folded in — a no-op while the lists above are complete,
// and a backstop if a code is ever added to the table and not to them.
for (const cc of Object.keys(COUNTRY_META)) {
  if      (cc.length === 3) THREE_DIGIT_CCS.add(cc);
  else if (cc.length === 2) TWO_DIGIT_CCS.add(cc);
}

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

// Cached per variant: the consumer and Business builds ship on their own
// schedules, and announcing one's version as the other is a version the server
// has no record of for that platform.
//
// The entries expire. Without that the first answer of a process is its last:
// a session that reconnects for weeks would keep announcing whatever the store
// happened to say the morning it started, which is the same stale-version
// problem the refresh exists to solve. Six hours is short enough that a release
// is picked up the day it lands and long enough that a connection flapping
// every few seconds never reaches the network for it.
const VERSION_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const _cachedIosVersion     = {};
const _cachedAndroidVersion = {};
const _cachedPlayVersion    = {};

function _cachedVersion(cache, key) {
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() - entry.at > VERSION_CACHE_TTL_MS) {
    delete cache[key];
    return null;
  }
  return entry.value;
}

function _cacheVersion(cache, key, value) {
  if (value) cache[key] = { value, at: Date.now() };
  return value;
}

/**
 * Drop the memoised lookups so the next call goes to the network.
 *
 * Ordinary callers are served by the TTL above; this exists for tests and for
 * anything that needs a definite answer right now.
 */
function clearVersionCache() {
  for (const k of Object.keys(_cachedIosVersion))     delete _cachedIosVersion[k];
  for (const k of Object.keys(_cachedAndroidVersion)) delete _cachedAndroidVersion[k];
  for (const k of Object.keys(_cachedPlayVersion))    delete _cachedPlayVersion[k];
}

// How long to let the Play lookup run before giving up on it. This is on the
// connect path, so a slow answer has to become "no answer" rather than a
// connection that hangs; the caller keeps whatever version it already had.
const PLAY_VERSION_TIMEOUT_MS = 20000;

/**
 * The version Google Play is actually serving, read through Play's own API.
 *
 * This is the Android counterpart of the iTunes lookup, and the only Android
 * source that can be trusted. The store *page* stopped carrying a version to
 * scrape: fetchAndroidVersion() below now usually returns the pinned fallback,
 * and when it does find a number on the page it can be the wrong one — a live
 * run had it read 2.26.27.85 off a listing that was serving 2.26.31.77, which
 * is older than the fallback it was supposed to improve on.
 *
 * Play's device-facing API answers with the real thing. It needs a Google
 * account, which the Aurora dispenser hands out anonymously — a free
 * third-party service that rate-limits, hence the six-hour memoisation shared
 * with the other lookups and the timeout above. A failure here is not an
 * error: the caller falls back to the scrape and then to the pinned version.
 *
 * @param {boolean} business  the w4b package rather than the consumer one
 * @returns {Promise<string|null>} e.g. "2.26.31.77", or null if Play did not answer
 */
async function fetchPlayVersion(business) {
  const key = business ? 'business' : 'personal';
  const hit = _cachedVersion(_cachedPlayVersion, key);
  if (hit) return hit;

  const packageName = business ? WHATSAPP_BUSINESS_PACKAGE : WHATSAPP_PACKAGE;
  const PlayStore   = require('./PlayStore');

  const lookup = (async () => {
    const auth    = await PlayStore.fetchAnonymousAuth();
    const headers = PlayStore.buildFdfeHeaders(auth);
    const info    = await PlayStore.fetchVersion(packageName, headers);
    return info && info.versionName ? info.versionName : null;
  })();

  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), PLAY_VERSION_TIMEOUT_MS);
  });

  let version = null;
  try {
    version = await Promise.race([lookup, deadline]);
  } catch (err) {
    _whaDbg('[DBG] PLAY_VERSION lookup failed: ' + (err && err.message));
    version = null;
  } finally {
    if (timer) clearTimeout(timer);
  }
  // The race leaves the lookup running when the deadline wins; it must not take
  // the process down if it rejects after nobody is waiting on it any more.
  lookup.catch(() => {});

  if (!version) return null;
  _whaDbg('[DBG] PLAY_VERSION ' + packageName + ' -> ' + version);
  return _cacheVersion(_cachedPlayVersion, key, version);
}

/**
 * The current Android version for a client that is connecting, best source
 * first: Play's API, then the store page, then the pinned fallback.
 *
 * Registration does not come through here — it reads the version off the APK
 * material it computed its token from, and the two must not be confused. See
 * fetchWaVersion().
 */
async function fetchAndroidVersionLive(business) {
  const fromPlay = await fetchPlayVersion(business);
  if (fromPlay) return fromPlay;
  _whaDbg('[DBG] PLAY_VERSION unavailable — falling back to the store page');
  return fetchAndroidVersion(business);
}

async function fetchIosVersion(business) {
  const key = business ? 'business' : 'personal';
  const hit = _cachedVersion(_cachedIosVersion, key);
  if (hit) return hit;
  const bundleId = business ? IOS_BUSINESS_BUNDLE_ID : IOS_BUNDLE_ID;
  return new Promise((resolve) => {
    const agent = proxyAgent();
    const req = https.get(
      'https://itunes.apple.com/lookup?bundleId=' + bundleId,
      { agent: agent || undefined, headers: { 'User-Agent': IOS_USER_AGENT } },
      (res) => {
        const chunks = [];
        res.on('data', d => chunks.push(d));
        res.on('end', () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            let ver = (json.results && json.results[0] && json.results[0].version) || IOS_VERSION_FALLBACK;
            if (!ver.startsWith('2.')) ver = '2.' + ver;
            _cacheVersion(_cachedIosVersion, key, ver);
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
async function fetchAndroidVersion(business) {
  const key = business ? 'business' : 'personal';
  const hit = _cachedVersion(_cachedAndroidVersion, key);
  if (hit) return hit;
  const packageName = business ? WHATSAPP_BUSINESS_PACKAGE : WHATSAPP_PACKAGE;
  try {
    const axios = require('axios');
    // Unlike https.get, axios reads HTTP_PROXY/HTTPS_PROXY on its own. That
    // stays untouched when no SOCKS proxy is configured; `proxy: false` is set
    // only alongside our own agent, so the two never fight over the socket.
    const socksAgent = proxyAgent();
    const resp = await axios.get(
      'https://play.google.com/store/apps/details?id=' + packageName + '&hl=en&gl=us',
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
          // Only what every axios build decompresses. A default that asks for
          // brotli and then gets bytes back undecoded is a page that parses to
          // nothing.
          'Accept-Encoding': 'gzip, deflate'
        },
        responseType: 'text',
        decompress:   true,
        timeout: 12000,
        // axios takes an agent under a different key than https.get does, but
        // drives it identically. Omitted, this lookup ignores SOCKS_PROXY and
        // silently falls back to a pinned version on a blocked network.
        ...(socksAgent ? { httpsAgent: socksAgent, proxy: false } : {})
      }
    );
    // Buffer when the response was compressed and axios handed the bytes back
    // as-is. String() on a Buffer of gzip is a page no regex will ever match,
    // which is how this came to fall through to a two-year-old fallback without
    // saying a word.
    const html = Buffer.isBuffer(resp.data)
      ? resp.data.toString('utf8')
      : String(resp.data);

    // Primary: first quoted 4-part version string matching WhatsApp's "2.x.x.x" scheme.
    // In Play Store JSON the current stable version appears first, before beta/history entries.
    const primary = html.match(/"(2\.\d+\.\d+\.\d+)"/);
    if (primary) {
      return _cacheVersion(_cachedAndroidVersion, key, primary[1]);
    }

    // Secondary: unquoted version adjacent to "WhatsApp" text (catches alternate HTML structures).
    const secondary = html.match(/WhatsApp[^<"]{0,200}?(2\.\d+\.\d+\.\d+)/);
    if (secondary) {
      return _cacheVersion(_cachedAndroidVersion, key, secondary[1]);
    }

    // Last resort: the highest 4-part version anywhere on the page. Play has
    // rearranged this page before, and a version read from the wrong element
    // still beats announcing one from two years ago.
    const all = html.match(/2\.\d+\.\d+\.\d+/g);
    if (all && all.length) {
      const newest = all.sort(compareVersions).pop();
      _whaDbg('[DBG] ANDROID_VERSION scraped from an unrecognised page layout: ' + newest);
      return _cacheVersion(_cachedAndroidVersion, key, newest);
    }

    _whaWarn('could not read the current WhatsApp version off the Play Store page — ' +
      'falling back to ' + ANDROID_VERSION_FALLBACK + '. If the server refuses the ' +
      'client with 405, set WA_VERSION to a current version.');
    return ANDROID_VERSION_FALLBACK;
  } catch (err) {
    _whaWarn('could not reach the Play Store to read the current WhatsApp version (' +
      err.message + ') — falling back to ' + ANDROID_VERSION_FALLBACK + '.');
  }
  return ANDROID_VERSION_FALLBACK;
}

// Numeric, part by part: '2.26.9.75' is older than '2.26.29.73', which a
// lexicographic sort gets backwards.
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// Return the appropriate WhatsApp version for the active device.
// If WA_VERSION is set in the environment, that value is always used.
//
// On Android the APK the token material came from decides it: the versionName
// of the APK that was downloaded. The token is signed over
// that build's classes.dex, so a version read from anywhere else describes a
// different build than the one the token proves — which the server sees as a
// token that does not belong to the client sending it. The live lookup stays as
// the fallback for when there is no material yet.
/**
 * The version a device profile should be announcing right now, and where it
 * came from.
 *
 * Deliberately ignores WA_VERSION: this answers "what is current" so a stored
 * version can be brought up to date, and an override in the environment is the
 * opposite of that — it is what masks the session's own value at connect.
 *
 * @param {object} device  the profile, for os and business
 * @returns {Promise<{version: string, source: string}>}
 */
async function currentVersionFor(device) {
  device = device || getDeviceConfig();
  const business = !!device.business;
  if (device.os === 'android') {
    const material = tryLoadAndroidMaterial(device);
    if (material && material.apkVersion) {
      return { version: material.apkVersion, source: 'the APK the token material came from' };
    }
    return { version: await fetchAndroidVersion(business), source: 'the Play Store listing' };
  }
  return { version: await fetchIosVersion(business), source: 'the App Store listing' };
}

/**
 * Bring a session's stored version up to date.
 *
 * A session records the version it registered with and announces that forever
 * after; nothing else ever writes the field. Months later the server stops
 * accepting it and the connect is refused with a 405 that has nothing to do
 * with the account. Refreshing the APK material does not help on its own — it
 * updates the material, not the sessions already on disk. This is the part that
 * was missing.
 *
 * Touches `version` and nothing else. The device profile, the keys and the
 * registration are left exactly as they were.
 *
 * @param {string} sessionFile   path to <number>.json
 * @param {object} [opts]        { version } to set one explicitly
 * @returns {Promise<{phoneNumber, before, after, changed, source}>}
 */
async function refreshSessionVersion(sessionFile, opts) {
  opts = opts || {};
  const { loadStore, saveStore } = require('./Store');

  const store = loadStore(sessionFile);
  if (!store) throw new Error('no session at ' + sessionFile);

  const device = store.device || getDeviceConfig();
  const before = store.version;

  const explicit = opts.version != null;
  const resolved = explicit
    ? { version: String(opts.version), source: 'the value you passed' }
    : await currentVersionFor(device);

  // Never go backwards on a lookup. The store the version is read from can be
  // behind what a session already holds — Play serves the build that matches
  // the device profile it was asked with, which is not always the newest one on
  // the listing — and moving a session to an older version is the one outcome
  // that makes a 405 more likely rather than less. A version named on the
  // command line is a decision, so that still applies either way.
  const olderThanStored = !explicit && !!before &&
    compareVersions(resolved.version, before) < 0;

  const changed = !olderThanStored && resolved.version !== before;
  if (changed) {
    store.version = resolved.version;
    saveStore(store, sessionFile);
  }

  return {
    phoneNumber: store.phoneNumber,
    before,
    after:       changed ? resolved.version : before,
    candidate:   resolved.version,
    changed,
    keptNewer:   olderThanStored,
    source:      resolved.source,
    os:          device.os,
    business:    !!device.business
  };
}

async function fetchWaVersion(device) {
  if (process.env.WA_VERSION) return process.env.WA_VERSION;
  const business = !!(device && device.business);
  if (device && device.os === 'android') {
    const material = tryLoadAndroidMaterial(device);
    if (material && material.apkVersion) return material.apkVersion;
    return fetchAndroidVersion(business);
  }
  return fetchIosVersion(business);
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
// One file per package. The two builds are signed with different certificates
// and carry a different classes.dex, so a token computed from the consumer APK
// is not the token the Business endpoint expects — and the consumer file keeps
// its original name, so nothing that already exists has to move.
function androidMaterialPath(device) {
  if (process.env.WA_ANDROID_APK_MATERIAL) return process.env.WA_ANDROID_APK_MATERIAL;
  const name = (device && device.business)
    ? 'android-apk-material-business.json'
    : 'android-apk-material.json';
  return path.join(os.homedir(), '.waSession', name);
}

const _androidMaterial = {};

// The material if there is any, without insisting on it. fetchWaVersion asks
// this way: a missing file is the token's problem to report, not the version's.
function tryLoadAndroidMaterial(device) {
  try { return loadAndroidMaterial(device); } catch (_) { return null; }
}

/**
 * Which platform a registration speaks.
 *
 * Once a session has an account behind it, or has a code outstanding, its
 * platform is settled: the account was created as that, the token and the
 * User-Agent have to keep saying so, and re-reading WA_OS could only break it.
 * A confirmation run from a shell without the variables must not flip to iOS
 * halfway through.
 *
 * Before that, a session holds nothing but keys. Re-running the code request is
 * how you start it over, and the environment is how you say what to start it
 * over as — so the environment decides, and this stops being consulted the
 * moment a code goes out.
 *
 * When the two disagree on a session that is settled, that is said out loud.
 * Silently ignoring WA_OS is how you end up watching an Android registration go
 * out under an iOS User-Agent and not knowing why.
 */
function deviceForRegistration(store, opts) {
  const env    = getDeviceConfig();
  const stored = store && store.device;
  const settled = !!(store && (store.registered || store.codePending));
  if (!settled || !stored) return env;

  const say = (opts && opts.onProgress) || (m => _whaDbg('[DBG] REG ' + m));

  if (stored.os !== env.os) {
    say('note: this session was started as ' + stored.os + ', so it stays ' + stored.os +
        ' — WA_OS=' + env.os + ' does not apply to a number that is already part-way ' +
        'through registering. Delete the session file to start it over as ' + env.os + '.');
  }

  // The same rule for the variant: an account is created as Business or as
  // consumer, and the token, the User-Agent and the vname certificate all have
  // to keep saying which. Flipping it halfway leaves a registration that no
  // build can finish.
  if (!!stored.business !== !!env.business) {
    say('note: this session was started as ' + (stored.business ? 'Business' : 'consumer') +
        ', so it stays that — WA_BUSINESS=' + (env.business ? '1' : '0') +
        ' does not apply to a number that is already part-way through registering. ' +
        'Delete the session file to start it over.');
  }

  return stored;
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

  const variant    = device.business ? 'business' : 'personal';
  const packageName = device.business ? WHATSAPP_BUSINESS_PACKAGE : WHATSAPP_PACKAGE;

  try {
    return loadAndroidMaterial(device);
  } catch (err) {
    if (err.code !== 'NO_APK_MATERIAL') throw err;
    if (process.env.WA_NO_APK_DOWNLOAD === '1') throw err;
  }

  const say = opts.onProgress || (m => _whaDbg('[DBG] APK ' + m));
  const AndroidApk = require('./AndroidApk');
  const PlayStore  = require('./PlayStore');

  say('no Android token material yet — fetching ' + packageName + ' from Google Play');
  let apk;
  try {
    apk = await PlayStore.downloadApk({ packageName, onProgress: m => say('  ' + m) });
  } catch (err) {
    throw new Error('could not fetch the WhatsApp APK automatically: ' + err.message +
      '\nRead it out of an APK you have instead:\n' +
      '  wa apk-material <base.apk> [split.apk ...]');
  }

  const material = AndroidApk.extractMaterial(apk.base, apk.splits);
  if (!material.apkVersion)     material.apkVersion     = apk.versionName;
  if (!material.apkVersionCode) material.apkVersionCode = apk.versionCode;

  const file = androidMaterialPath(device);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(AndroidApk.materialToJson(material), null, 2));
  say('  token material written to ' + file);

  // Re-read it rather than using what is in hand, so the downloaded APK goes
  // through the same signature check as one that was already on disk.
  _androidMaterial[variant] = null;
  return loadAndroidMaterial(device);
}

function loadAndroidMaterial(device) {
  const variant = (device && device.business) ? 'business' : 'personal';
  if (_androidMaterial[variant]) return _androidMaterial[variant];
  const file = androidMaterialPath(device);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (_) {
    const err = new Error('registering as Android needs the token material from a WhatsApp APK, ' +
      'and there is none at ' + file + '. Fetch it with:\n' +
      '  wa apk-material --download' + (variant === 'business' ? ' --business' : '') + '\n' +
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
      '  pm path ' + (variant === 'business' ? WHATSAPP_BUSINESS_PACKAGE : WHATSAPP_PACKAGE) + '\n' +
      'then re-run wa apk-material with it. Set WA_ALLOW_FOREIGN_APK=1 to send it anyway.');
  }

  _androidMaterial[variant] = material;
  return material;
}

function computeToken(waVersion, national, device) {
  device = device || getDeviceConfig();
  if (device.os === 'android') {
    return AndroidApk.computeToken(loadAndroidMaterial(device), national);
  }
  // The Business build signs with its own constant. WA_STATIC_TOKEN still
  // overrides either, for anyone who has a newer one than this ships with.
  const staticToken    = process.env.WA_STATIC_TOKEN ||
    (device.business ? IOS_BUSINESS_STATIC_TOKEN : IOS_STATIC_TOKEN);
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
// 16 random bytes → URL-safe base64 without
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

// ---------- /code verification-code parameters (per platform) ----------
// Returns the alternating name/value form fields the native client emits on a
// /code request. Android sends the long device-fingerprint list; iOS sends the
// short list. sim_mcc/sim_mnc/mcc/mnc carry real per-country values rather than
// a "000" placeholder, and advertising_id / backup_token come from the store.

// How long the server said to wait, in seconds, or null when it did not say.
//
// The wait comes back in a field named after the delivery method, and there are
// seven of them. Reading only `sms_wait` meant a rate-limited voice or wa_old
// request reported no wait at all — which is the one number that matters in a
// `too_recent`, because without it the only advice left is "wait a few minutes"
// and people re-run the command instead, spending attempts and extending the
// very cooldown they are trying to get out of.
//
// The method's own field wins; the longest of the others is the fallback, since
// the server sometimes answers about a method other than the one asked for.
const WAIT_FIELDS = ['sms_wait', 'voice_wait', 'wa_old_wait', 'flash_wait',
                     'email_otp_wait', 'send_sms_wait', 'silent_auth_wait'];

function waitHint(response, method) {
  if (!response) return null;

  const preferred = Number(response[method + '_wait']);
  if (preferred > 0) return preferred;

  let max = null;
  for (const key of WAIT_FIELDS) {
    const v = Number(response[key]);
    if (v > 0 && (max === null || v > max)) max = v;
  }
  if (max !== null) return max;

  const retry = Number(response.retry_after);
  return retry > 0 ? retry : null;
}

function buildClientMetrics(attempt) {
  const json = '{"attempts":' + (attempt || 1)
    + ',"app_campaign_download_source":"google-play|unknown"'
    + ',"is_sim_absent":false}';
  return encodeURIComponent(json);
}

function getRequestVerificationCodeParameters(store, method, meta, device, attempt) {
  if (device && device.os === 'android') {
    // Flash call is the one method whose delivery the server only routes when
    // the client says it can observe an incoming call. The three fields below
    // are that statement, and asking for `flash` while any of them still says
    // otherwise gets the request answered with an SMS — or with no route at
    // all. They stay at their headless-safe values for every other method.
    const wantsFlash = method === 'flash';
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
      'prefer_sms_over_flash',      wantsFlash ? 'false' : 'true',
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
      'call_log_permission',        wantsFlash ? 'true' : 'false',
      'manage_call_permission',     wantsFlash ? 'true' : 'false',
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

// ---------- vname: the Business verified-name certificate ----------
//
// A Business registration carries one extra form field, `vname`, and a consumer
// one carries none. It is a VerifiedNameCertificate the client signs itself:
//
//   Details      { 1 serial (uint64), 2 issuer "smb:wa", 4 verifiedName "" }
//   Certificate  { 1 details (the encoded Details), 2 signature }
//
// The name is empty because there is nothing verified yet — WhatsApp issues the
// real one later, after the business is reviewed. What the server checks here is
// that the signature over the details is made with the identity key the same
// request registers, which ties the certificate to this account and no other.
//
// Written by hand rather than through the protobuf models: these two messages
// exist nowhere else in the library, and the encoder here is the same field/
// wire-type pair used everywhere else in proto.js.

const VNAME_ISSUER_SMALL_BUSINESS = 'smb:wa';

function _pbVarint(n) {
  const out = [];
  let v = BigInt(n);
  while (v > 127n) { out.push(Number((v & 0x7fn) | 0x80n)); v >>= 7n; }
  out.push(Number(v));
  return Buffer.from(out);
}

function _pbLenField(fieldNum, buf) {
  return Buffer.concat([_pbVarint((fieldNum << 3) | 2), _pbVarint(buf.length), buf]);
}

function _pbVarintField(fieldNum, value) {
  return Buffer.concat([_pbVarint((fieldNum << 3) | 0), _pbVarint(value)]);
}

/**
 * The `vname` form value for a Business registration, or null for a consumer one.
 *
 * @param {object} store   the session, for the identity key that signs it
 * @param {object} device  the active device profile
 */
function buildVerifiedNameCertificate(store, device) {
  if (!device || !device.business) return null;

  // A positive 63-bit serial: Java takes the absolute value of a random long,
  // and Math.abs(Long.MIN_VALUE) is still negative there, so the top bit is
  // simply never set here instead.
  const serialBytes = crypto.randomBytes(8);
  serialBytes[0] &= 0x7f;
  const serial = serialBytes.readBigUInt64BE(0);

  const details = Buffer.concat([
    _pbVarintField(1, serial),
    _pbLenField(2, Buffer.from(VNAME_ISSUER_SMALL_BUSINESS, 'utf8')),
    _pbLenField(4, Buffer.alloc(0))            // verifiedName: empty, not absent
  ]);

  // Signed with the identity key, over the encoded details exactly as they go
  // on the wire — the same XEdDSA signature the signed pre-key uses.
  const signature = Buffer.from(
    curveJs.sign(store.identityKeyPair.private, details));

  return toBase64Url(Buffer.concat([
    _pbLenField(1, details),
    _pbLenField(2, signature)
  ]));
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

  // Device-attestation fields shipped on every attested endpoint.
  // Empty by default (NONE fallback); populated when a
  // Frida attestation server is configured via WA_FRIDA_HOST. The Play
  // Integrity nonce is a stable per-session value derived from the store.
  const nonceB64 = attestation.toBase64Url(
    crypto.createHash('sha256')
      .update(Buffer.concat([store.identityId, stripKeyPrefix(store.noiseKeyPair.public)]))
      .digest()
  );
  // The push token a real install always has. Acquired from Google once and
  // then cached on the store, so the two registration steps share one. Returns
  // null on any failure, which drops the field and leaves the body exactly as
  // it was before push tokens were wired up.
  const pushToken = await require('./fcm').getPushToken(store, device);

  const attestFields = await attestation.attestationFields(device, nonceB64, { pushToken });

  return buildForm([
    'cc',                cc,
    'in',                national,
    'rc',                String(RELEASE_CHANNEL),
    'lg',                meta.lg,
    'lc',                meta.lc,
    'authkey',           toBase64Url(stripKeyPrefix(store.noiseKeyPair.public)),
    // Business only; buildForm drops a null, so a consumer registration sends
    // the same body it always has.
    'vname',             buildVerifiedNameCertificate(store, device),
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

// A flash call carries no code of its own: WhatsApp rings the number from a
// one-time caller ID and drops the call, and the verification code IS that
// number — its trailing digits. The official Android app reads them out of the
// call log, which is a thing no server-side client has; here the person holding
// the handset reads the missed call instead and types what they see.
//
// So whatever arrives has to be reduced to those digits. Someone reading a
// missed call types it however their phone showed it — "+40 21 555 123456",
// "0040...", or already just the last six — and all three have to land on the
// same code. Digits are taken first, then the tail: a full number is longer
// than the code, and its END is the part the server compares.
//
// Six is what the decompiled app defaults to. Flash-call providers vary between
// four and six, so it is overridable rather than baked in, for the number whose
// server wants a different length.
const FLASH_CODE_LENGTH = 6;

function flashCodeLength() {
  const raw = parseInt(process.env.WA_FLASH_CODE_LEN, 10);
  return raw > 0 ? raw : FLASH_CODE_LENGTH;
}

function flashCodeFromCallerId(input, len) {
  const digits = normalizeCodeResult(input);
  const want   = len > 0 ? len : flashCodeLength();
  // Shorter than the code means the caller already typed just the tail (or the
  // handset showed a short number); there is nothing to trim and guessing would
  // only corrupt it.
  return digits.length > want ? digits.slice(-want) : digits;
}

// The digits /register is given, for whichever method the pending code came by.
// Split out so the choice can be tested on its own: it is the whole difference
// between confirming a flash call and confirming anything else, and it runs at
// a point in verifyCode that a test cannot otherwise reach without a network.
//
// The method is read off the session because the request and the confirmation
// are usually two separate commands; opts.method overrides it for a caller that
// knows better, or for a session saved before the field existed.
function codeForSubmission(store, code, opts) {
  const pending = String(
    (opts && opts.method) || (store && store.codeMethod) || ''
  ).toLowerCase();
  return pending === 'flash'
    ? flashCodeFromCallerId(code)
    : normalizeCodeResult(code);
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

// The retry policy below is "unknown error once, then give up", so this only
// bites when the server keeps answering with a different reason each time.
const MAX_CODE_REQUEST_ATTEMPTS = 5;

// The display name a registration is carrying, if the caller gave one. It is
// never sent to the registration endpoints — those take no name, and adding one
// would be inventing a field. It is written to the session, and the handshake
// on the first connection is what announces it.
function applyRegistrationName(store, opts) {
  if (!store || !opts || opts.name === undefined || opts.name === null) return;
  const { normalizePushName } = require('./Store');
  const clean = normalizePushName(opts.name);
  if (clean) store.name = clean;
}

async function requestSmsCode(store, method, opts) {
  method = method || 'sms';
  opts   = opts   || {};
  applyRegistrationName(store, opts);
  // Before the version is read, since on Android the version comes out of the
  // APK this fetches.
  const _device   = deviceForRegistration(store, opts);
  await ensureAndroidMaterial(opts, _device);
  const waVersion = await fetchWaVersion(_device);
  store.version = waVersion;
  store.device  = _device;

  // The email OTP carries the address alongside the usual parameters. It goes
  // through the same request path as every other method rather than around it:
  // it used to have its own branch, which meant a rate-limited email request
  // reported no wait, a block screen was reported as a raw reason, and none of
  // the funnel events the other methods emit were sent.
  const emailAddr = method === 'email' ? (opts.email || '') : '';
  if (method === 'email' && !emailAddr) {
    throw new Error('requestSmsCode: email method requires opts.email address');
  }

  // Flash exists on Android and nowhere else. iOS has no public way to read an
  // incoming call's number, so the platform never offers the method and asking
  // for it as iOS is answered with an ordinary SMS at best. Refusing here costs
  // nothing; letting it through spends one of the number's attempts to learn
  // the same thing from the server.
  if (method === 'flash' && !(_device && _device.os === 'android')) {
    throw new Error(
      'Flash call verification is Android-only — iOS has no API for reading an ' +
      'incoming call\'s number, so WhatsApp does not offer it there.\n' +
      '  Re-run as Android:  WA_OS=android wa registration --request-code ' +
      store.phoneNumber + ' --method flash'
    );
  }

  // Auto-fallback: if the primary method gets no_routes, try the alternate once.
  // sms → wa_old, wa_old → sms, voice → sms. Never for email: falling back
  // would send an SMS to somebody who asked for an email.
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
      if (m === 'email') extra.push('email', emailAddr);

      // The screen a later event belongs to is named after the method asked
      // for here, so record it before the request rather than after.
      store._lastRequestedMethod = m;
      const verifyScreen = currentVerifyScreen(store);
      await sendFunnelLog(store, waVersion, verifyScreen, 'request_code', 'request_code_attempt');

      const result = await sendRequest('/code', store, waVersion, true, extra);

      const status = result.status;
      if (status === 'ok' || status === 'sent') {
        // Which method actually went through, not which one was asked for: a
        // flash request that fell back to SMS leaves a code in an SMS, and
        // confirming it as flash would take the last six digits of a six-digit
        // code — right by accident here, wrong the moment the lengths differ.
        // The confirmation step is usually a separate command, so this is
        // written to the session rather than kept in memory.
        store.codeMethod = m;
        await sendFunnelLog(store, waVersion, verifyScreen, 'request_code', 'request_code_success');
        return result;
      }

      const reason = result.reason || status || '';

      // isTooRecent() — throw immediately, no point retrying
      if (/too_recent|too_many|too_many_guesses|too_many_all_methods/i.test(reason) ||
          /too_recent|too_many|too_many_guesses|too_many_all_methods/i.test(status)) {
        const waitSec = waitHint(result, m);
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

      // Same error twice in a row → give up. Compared even when the reason is
      // empty: a 200 carrying a non-JSON body leaves both status and reason
      // undefined, and skipping those would retry a real /code request forever.
      if (reason === lastReason) {
        throw new Error(`Registration error (${m}): ${reason || 'no status in response'} — raw: ${JSON.stringify(result)}`);
      }

      // First occurrence of unknown error → retry once
      lastReason = reason;
      attemptNum++;

      // A server answering with a different reason every time would otherwise
      // keep this loop going indefinitely.
      if (attemptNum > MAX_CODE_REQUEST_ATTEMPTS) {
        throw new Error(`Registration error (${m}): giving up after ${MAX_CODE_REQUEST_ATTEMPTS} attempts — raw: ${JSON.stringify(result)}`);
      }
    }
  }

  // Try primary method
  let result = await _tryMethod(method);

  // Auto-fallback on no_routes
  if (result && result._noRoutes && !autoFallbackDone && method !== 'email') {
    autoFallbackDone = true;
    process.stderr.write(`[REG] ${method} returned no_routes — auto-trying ${fallbackMethod}\n`);
    result = await _tryMethod(fallbackMethod);
  }

  // Final no_routes — give up, and say what actually changes the answer.
  //
  // no_routes is the server declining to deliver, and what it weighs is the
  // requester: the reputation of the IP, the history the number carries, and
  // whether the platform has a route for it. None of that is in the client, so
  // the advice has to point outside it. The old text suggested a VoIP number,
  // which is backwards — virtual numbers are among the most refused.
  if (result && result._noRoutes) {
    const tried = autoFallbackDone ? `${method}, then ${fallbackMethod}` : method;
    throw new Error(
      `Registration blocked (no_routes) — WhatsApp has no route to deliver the ` +
      `code (tried: ${tried}).\n` +
      `  • Most often the IP: datacenter, VPS and VPN addresses are refused. ` +
      `Use a residential connection, or SOCKS_PROXY=socks5://…\n` +
      `  • Try another method: --method voice, or --method flash ` +
      `(WA_OS=android — rings the number and hangs up; the code is the ` +
      `last 6 digits of the calling number)\n` +
      `  • Try the other platform: WA_OS=ios (routes differ per platform)\n` +
      `  • wa_old only works if the number is already active on WhatsApp\n` +
      `  • Real SIM numbers fare better than virtual or VoIP ones\n` +
      `  • Leave the number alone for 24h rather than retrying — every attempt ` +
      `counts against it`
    );
  }

  return result;
}

async function verifyCode(store, code, opts) {
  opts = opts || {};
  applyRegistrationName(store, opts);
  // Normally already there from the code request, but a confirmation can be run
  // from a fresh shell that never made one.
  const _device   = deviceForRegistration(store, opts);
  await ensureAndroidMaterial(opts, _device);
  const waVersion = await fetchWaVersion(_device);
  store.version = waVersion;
  store.device  = _device;
  // A verification code is all digits, so callers reasonably hand one over as a
  // number; coercing here keeps that from dying on .replace before we ask.
  //
  // Flash is the exception: nothing was ever sent to this number, so what the
  // caller has is the missed call's own number and the code is its tail. Which
  // method is pending is remembered from the code request — the two steps are
  // usually separate commands, so it is read back off the session rather than
  // assumed to still be in memory. opts.method lets a caller state it outright
  // for a session that predates the field.
  const pendingMethod = String(opts.method || store.codeMethod || '').toLowerCase();
  const normalized    = codeForSubmission(store, code, opts);

  if (pendingMethod === 'flash') {
    const typed = normalizeCodeResult(code);
    if (typed.length !== normalized.length) {
      _whaDbg('[DBG] REG flash caller-id ' + typed.length + ' digits → code ' +
        normalized + ' (last ' + normalized.length + ')');
    }
  }

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

module.exports = { checkIfRegistered, checkNumberStatus, requestSmsCode, verifyCode, fetchIosVersion, fetchAndroidVersion, fetchPlayVersion, fetchAndroidVersionLive, fetchWaVersion, currentVersionFor, refreshSessionVersion, clearVersionCache, tryLoadAndroidMaterial, compareVersions, parsePhone, getCountryMeta, assertRegistrationKeys, parseSocksProxy, socksProxyUrl };

// The HTTP reader, exposed for tests. Not part of the public API.
module.exports._http = { readHttpResponse, parseHttpResponse, decodeChunkedBody };

// Token computation, exposed for tests. Not part of the public API.
module.exports._token = { computeToken, androidMaterialPath, registrationHeaders, ensureAndroidMaterial, deviceForRegistration, buildVerifiedNameCertificate, buildPayload };

// Challenge / two-factor internals, exposed for tests. Not part of the public API.
module.exports._verify = {
  hasChallenge, is2FARequired, decodeOrNull, isSuccessful,
  normalizeCodeResult, currentVerifyScreen, adoptCanonicalNumber, funnelEnabled, waitHint,
  flashCodeFromCallerId, flashCodeLength, codeForSubmission,
  getRequestVerificationCodeParameters
};
