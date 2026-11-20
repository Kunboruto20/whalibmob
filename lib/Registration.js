'use strict';
//registration tool//
const { Boom } = require('@hapi/boom');
const { statusFrom } = require('./errors');
const crypto = require('crypto');
const https  = require('https');
const tls    = require('tls');
const zlib   = require('zlib');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const curveJs = require('./curve');
const { v4: uuidv4 } = require('uuid');
const { getDeviceConfig } = require('./DeviceConfig');
const AndroidApk  = require('./AndroidApk');
const attestation = require('./Attestation');
const { pushClientFor } = require('./PushClient');
const { dbg: _whaDbg, warn: _whaWarn } = require('./logger');

// ---------- Request envelope ----------
//
// The server reads the platform only from the User-Agent; an unknown one is
// refused with {"param":"platform","reason":"bad_param"}. The extra Android
// headers match a live native registration; iOS sends none of them.
// Platform token: `SMBA` / `SMB iOS` for Business builds.
function _uaPlatformName(device) {
  if (device.os === 'android') return device.business ? 'SMBA' : 'Android';
  return device.business ? 'SMB iOS' : 'iOS';
}

function registrationHeaders(device, waVersion) {
  if (device.os === 'android') {
    // Same headers and order as the native POST. request_token is an UPPERCASE UUID.
    return {
      'User-Agent':      `WhatsApp/${waVersion} ${_uaPlatformName(device)}/${device.osVersion} Device/${device.manufacturer}-${device.modelId}`,
      'WaMsysRequest':   '1',
      // Fresh per request.
      'request_token':   uuidv4().toUpperCase(),
      'Content-Type':    'application/x-www-form-urlencoded',
      'Connection':      'Keep-Alive',
      'Accept-Encoding': 'gzip'
    };
  }
  return {
    'User-Agent':   `WhatsApp/${waVersion} ${_uaPlatformName(device)}/${device.osVersion} Device/${device.model}`,
    'Content-Type': 'application/x-www-form-urlencoded'
  };
}

// ---------- SOCKS4 / SOCKS5 / Tor support ----------
// Lives in ./socks (shared by all transports); re-exported below for old importers.
const {
  parseSocksProxy, socksProxyUrl, socksConnect, proxyAgent
} = require('./socks');

async function httpPostViaSocks(path, body, waVersion, proxyUrl, authHeader, device, query) {
  const dHost = 'v.whatsapp.net';
  const dPort = 443;

  // socksConnect has a 20s handshake timeout, so a silent proxy cannot hang us.
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
  // Like the native client, params go both as the URL query and encrypted in ENC.
  const target   = query ? `/v2${path}?${query}` : `/v2${path}`;
  const reqLines = [
    `POST ${target} HTTP/1.1`,
    `Host: ${dHost}`,
    ...Object.keys(headers).map(k => `${k}: ${headers[k]}`),
    `Content-Length: ${Buffer.byteLength(body)}`
  ];
  if (authHeader) reqLines.push(`Authorization: ${authHeader}`);
  // Keep-Alive comes from registrationHeaders; the socket is destroyed after the read.
  reqLines.push('', body);
  const req = reqLines.join('\r\n');

  tlsSocket.write(req);

  const { status, headers: resHeaders, body: bodyBuf } = await readHttpResponse(tlsSocket, path);
  const bodyStr = decodeBody(bodyBuf, resHeaders).toString('utf8');

  if (status !== 200) throw new Boom(`HTTP ${status} ${path}: ${bodyStr}`, { statusCode: statusFrom(status) });
  try { return JSON.parse(bodyStr); } catch (_) { return { raw: bodyStr }; }
}

// A response ends at its declared length (Content-Length or the last chunk),
// not when the socket closes: WhatsApp keeps the connection open. end/close
// remain a fallback for replies with no declared length.
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function readHttpResponse(socket, label, timeoutMs) {
  return new Promise((resolve, reject) => {
    let raw    = Buffer.alloc(0);
    let done   = false;

    const timer = setTimeout(() => {
      settle(reject, new Boom('SOCKS proxy timed out reading ' + label, { statusCode: 408 }));
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
        return settle(reject, new Boom('response too large reading ' + label, { statusCode: 413 }));
      }
      const parsed = parseHttpResponse(raw, false);
      if (parsed) settle(resolve, parsed);
    }

    // Connection closed: whatever arrived is the whole reply.
    function onEnd() {
      const parsed = parseHttpResponse(raw, true);
      if (parsed) return settle(resolve, parsed);
      settle(reject, new Boom('connection closed mid-response reading ' + label, { statusCode: 502 }));
    }

    function onError(err) { settle(reject, err); }

    socket.on('data',  onData);
    socket.on('end',   onEnd);
    socket.on('close', onEnd);
    socket.on('error', onError);
  });
}

// Gunzip when content-encoding says gzip; otherwise (or on failure) raw bytes.
function decodeBody(bodyBuf, headers) {
  if (/^content-encoding:[ \t]*gzip/im.test(headers || '')) {
    try { return zlib.gunzipSync(bodyBuf); } catch (_) { /* fall through */ }
  }
  return bodyBuf;
}

/** Returns { status, headers, body } when complete, else null. `atEof`: no more bytes coming. */
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
    // Count bytes on the buffer, not characters on a string.
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
// cc → { mcc, mnc (main operator), lg (ISO 639-1), lc (ISO 3166-1) }.
// '000'/'000' looks like a SIM-less third-party client, so map to a real operator.
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
  // From the ITU tables: one real operator per country (else 000/000 = no SIM).
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

// Carrier metadata for a calling code: one operator per country (number
// portability makes guessing from the prefix worse). WA_SIM_MCC/WA_SIM_MNC or
// opts.simMcc/simMnc override it. MNC width is kept as given (10 ≠ 010).
function getCountryMeta(cc, opts) {
  const base = COUNTRY_META[cc] || { mcc: '000', mnc: '000', lg: 'en', lc: 'US' };

  const mcc = (opts && opts.simMcc) || process.env.WA_SIM_MCC;
  const mnc = (opts && opts.simMnc) || process.env.WA_SIM_MNC;
  if (!mcc && !mnc) return base;

  const out = Object.assign({}, base);
  if (mcc) out.mcc = String(mcc).trim();
  if (mnc) out.mnc = String(mnc).trim();
  return out;
}

// ---------- Phone number parsing ----------
// Like Java PhoneNumberUtil: cc (e.g. "40") and national number without leading zeros.

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

// Backstop: every code in COUNTRY_META must also be splittable.
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

// Cached per variant (consumer / Business ship separately), for 6 hours, so
// long-running sessions pick up new releases without hammering the network.
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

/** Clear the cached versions so the next call hits the network (mainly for tests). */
function clearVersionCache() {
  for (const k of Object.keys(_cachedIosVersion))     delete _cachedIosVersion[k];
  for (const k of Object.keys(_cachedAndroidVersion)) delete _cachedAndroidVersion[k];
  for (const k of Object.keys(_cachedPlayVersion))    delete _cachedPlayVersion[k];
}

// Play lookup timeout; on the connect path, so slow means "no answer", never a hang.
const PLAY_VERSION_TIMEOUT_MS = 20000;

/**
 * The version Google Play serves, via Play's API (anonymous Aurora account).
 * The only trustworthy Android source; the store page is often stale.
 * Failure is not an error — the caller falls back.
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
  // Swallow a late rejection after the deadline won.
  lookup.catch(() => {});

  if (!version) return null;
  _whaDbg('[DBG] PLAY_VERSION ' + packageName + ' -> ' + version);
  return _cacheVersion(_cachedPlayVersion, key, version);
}

/**
 * Android version for connecting: Play API, then store page, then the pinned
 * fallback. Registration uses the APK material's version instead (fetchWaVersion).
 */
async function fetchAndroidVersionLive(business) {
  const fromPlay = await fetchPlayVersion(business);
  if (fromPlay) return fromPlay;

  // Play unavailable (common on datacenter IPs). The store page can be stale,
  // so the pinned version is a floor: older page values are discarded.
  const fromPage = await fetchAndroidVersion(business);
  if (fromPage && compareVersions(fromPage, ANDROID_VERSION_FALLBACK) > 0) {
    _whaDbg('[DBG] PLAY_VERSION unavailable — the store page says ' + fromPage);
    return fromPage;
  }
  _whaDbg('[DBG] PLAY_VERSION unavailable, and the store page said ' +
    (fromPage || 'nothing') + ' — using the pinned ' + ANDROID_VERSION_FALLBACK);
  return ANDROID_VERSION_FALLBACK;
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

// Scrape the 2.x.x.x version from the Play Store page; fallback on any error.
async function fetchAndroidVersion(business) {
  const key = business ? 'business' : 'personal';
  const hit = _cachedVersion(_cachedAndroidVersion, key);
  if (hit) return hit;
  const packageName = business ? WHATSAPP_BUSINESS_PACKAGE : WHATSAPP_PACKAGE;
  try {
    const axios = require('axios');
    // `proxy: false` only with our SOCKS agent, so axios' env proxy never conflicts.
    const socksAgent = proxyAgent();
    const resp = await axios.get(
      'https://play.google.com/store/apps/details?id=' + packageName + '&hl=en&gl=us',
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
          // No brotli: not every axios build decodes it.
          'Accept-Encoding': 'gzip, deflate'
        },
        responseType: 'text',
        decompress:   true,
        timeout: 12000,
        // Route through SOCKS_PROXY when set.
        ...(socksAgent ? { httpsAgent: socksAgent, proxy: false } : {})
      }
    );
    // axios may hand back a Buffer; decode it before matching.
    const html = Buffer.isBuffer(resp.data)
      ? resp.data.toString('utf8')
      : String(resp.data);

    // Primary: first quoted "2.x.x.x" (the stable version comes first).
    const primary = html.match(/"(2\.\d+\.\d+\.\d+)"/);
    if (primary) {
      return _cacheVersion(_cachedAndroidVersion, key, primary[1]);
    }

    // Secondary: a version next to "WhatsApp" text.
    const secondary = html.match(/WhatsApp[^<"]{0,200}?(2\.\d+\.\d+\.\d+)/);
    if (secondary) {
      return _cacheVersion(_cachedAndroidVersion, key, secondary[1]);
    }

    // Last resort: the highest version anywhere on the page.
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

// Numeric compare, part by part ('2.26.9' < '2.26.29').
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/**
 * The current version for a device profile, and its source. On Android it is
 * the APK the token material came from (the token proves that build).
 * Ignores WA_VERSION on purpose.
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
 * Update a session's stored version (an old one gets 405 on connect).
 * Changes only `version`.
 *
 * @param {string} sessionFile   path to <number>.json
 * @param {object} [opts]        { version } to set one explicitly
 * @returns {Promise<{phoneNumber, before, after, changed, source}>}
 */
async function refreshSessionVersion(sessionFile, opts) {
  opts = opts || {};
  const { loadStore, saveStore } = require('./Store');

  const store = loadStore(sessionFile);
  if (!store) throw new Boom('no session at ' + sessionFile, { statusCode: 404 });

  const device = store.device || getDeviceConfig();
  const before = store.version;

  const explicit = opts.version != null;
  const resolved = explicit
    ? { version: String(opts.version), source: 'the value you passed' }
    : await currentVersionFor(device);

  // A looked-up version never goes backwards; an explicit one always applies.
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
//   iOS      MD5( staticToken + MD5hex(waVersion) + nationalNumber )
//   Android  HMAC-SHA1 keyed from the APK, over the signing certs,
//            MD5(classes.dex) and the national number (see AndroidApk.js)
//
// WA_STATIC_TOKEN applies to iOS only.

// Android material file, one per package (consumer / Business), in the session dir.
function androidMaterialPath(device) {
  if (process.env.WA_ANDROID_APK_MATERIAL) return process.env.WA_ANDROID_APK_MATERIAL;
  const name = (device && device.business)
    ? 'android-apk-material-business.json'
    : 'android-apk-material.json';

  // Same resolver the writer (`wa apk-material`) uses.
  const { defaultBaseDir } = require('./SessionPaths');
  const primary = path.join(defaultBaseDir(), name);

  // Fall back to the legacy ~/.waSession copy.
  if (!fs.existsSync(primary)) {
    const legacy = path.join(os.homedir(), '.waSession', name);
    if (legacy !== primary && fs.existsSync(legacy)) return legacy;
  }
  return primary;
}

const _androidMaterial = {};

// The material, or null if missing.
function tryLoadAndroidMaterial(device) {
  try { return loadAndroidMaterial(device); } catch (_) { return null; }
}

// A session's device, frozen for the whole registration: /exist, /code,
// /register and retries all use the stored one, never a mix (see
// test/registration-device-consistency.test.js). WA_OS / WA_BUSINESS apply only
// to a session with no device; to switch, delete the session file. A mismatch is logged.
function deviceForRegistration(store, opts) {
  const env    = getDeviceConfig();
  const stored = store && store.device;
  if (!stored || !stored.os) return env;

  const say = (opts && opts.onProgress) || (m => _whaDbg('[DBG] REG ' + m));

  if (stored.os !== env.os) {
    say('note: this session was started as ' + stored.os + ', so it stays ' + stored.os +
        ' — WA_OS=' + env.os + ' does not apply to a number that already has a ' +
        'device. Delete the session file to start it over as ' + env.os + '.');
  }

  // Same rule for Business vs consumer.
  if (!!stored.business !== !!env.business) {
    say('note: this session was started as ' + (stored.business ? 'Business' : 'consumer') +
        ', so it stays that — WA_BUSINESS=' + (env.business ? '1' : '0') +
        ' does not apply to a number that already has a device. ' +
        'Delete the session file to start it over.');
  }

  return stored;
}

// Debug log of the device identity (and real User-Agent) a request goes out with.
function logDeviceIdentity(tag, store, waVersion) {
  const stored = store && store.device;
  const d      = stored || getDeviceConfig();
  const ver    = waVersion || (store && store.version) || '';
  let ua = '';
  try { ua = registrationHeaders(d, ver)['User-Agent']; } catch (_) {}
  _whaDbg('[DBG] DEVICE_IDENTITY ' + tag +
    ' os=' + d.os +
    ' osVersion=' + d.osVersion +
    ' manufacturer=' + (d.manufacturer || '-') +
    ' model=' + (d.model || d.modelId || '-') +
    ' modelId=' + (d.modelId || '-') +
    ' business=' + !!d.business +
    ' waVersion=' + (ver || '-') +
    ' source=' + (stored ? 'store.device (frozen)' : 'getDeviceConfig() (env/default)') +
    ' ua="' + ua + '"');
}

/**
 * Ensure Android token material exists, downloading the APK from Play if it is
 * missing (a repacked APK is still refused). No-op on iOS;
 * WA_NO_APK_DOWNLOAD=1 disables the download.
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
    throw new Boom('could not fetch the WhatsApp APK automatically: ' + err.message +
      '\nRead it out of an APK you have instead:\n' +
      '  wa apk-material <base.apk> [split.apk ...]', { statusCode: 502 });
  }

  const material = AndroidApk.extractMaterial(apk.base, apk.splits);
  if (!material.apkVersion)     material.apkVersion     = apk.versionName;
  if (!material.apkVersionCode) material.apkVersionCode = apk.versionCode;

  const file = androidMaterialPath(device);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(AndroidApk.materialToJson(material), null, 2));
  say('  token material written to ' + file);

  // Re-read so the download passes the same signature check.
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
    const err = new Boom('registering as Android needs the token material from a WhatsApp APK, ' +
      'and there is none at ' + file + '. Fetch it with:\n' +
      '  wa apk-material --download' + (variant === 'business' ? ' --business' : '') + '\n' +
      'or read it out of an APK you already have:\n' +
      '  wa apk-material <base.apk> [split.apk ...]\n' +
      'Registering as iOS needs none of this.', { statusCode: 404 });
    // Distinct from a refused repack (never download over that).
    err.code = 'NO_APK_MATERIAL';
    throw err;
  }
  const material = AndroidApk.materialFromJson(JSON.parse(raw));

  // Refuse a re-signed APK up front: its token always gets bad_token and
  // would only burn /code attempts on the number.
  const signer = AndroidApk.describeCertificate(material.certificates[0]);
  if (signer && !AndroidApk.looksLikeWhatsAppCertificate(signer) &&
      process.env.WA_ALLOW_FOREIGN_APK !== '1') {
    throw new Boom('the APK this token material came from was not signed by WhatsApp — ' +
      'it is signed by "' + signer.subject.replace(/\n/g, ', ') + '". Re-signing replaces ' +
      'the certificate the token is built from, so every attempt would come back as ' +
      'bad_token. Take the APK from a phone that has WhatsApp installed:\n' +
      '  pm path ' + (variant === 'business' ? WHATSAPP_BUSINESS_PACKAGE : WHATSAPP_PACKAGE) + '\n' +
      'then re-run wa apk-material with it. Set WA_ALLOW_FOREIGN_APK=1 to send it anyway.', { statusCode: 400 });
  }

  _androidMaterial[variant] = material;
  return material;
}

function computeToken(waVersion, national, device) {
  device = device || getDeviceConfig();
  if (device.os === 'android') {
    return AndroidApk.computeToken(loadAndroidMaterial(device), national);
  }
  // Business has its own constant; WA_STATIC_TOKEN overrides both.
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
// k=v joined by "&", nulls skipped. Not URLSearchParams: it would
// double-encode the %AA hex in 'id'.

// Native field order (LinkedHashMap insertion order) captured from Android:
// 51 fields for /v2/code, 49 for /v2/register. Missing fields just drop out.
const CODE_PARAM_ORDER = [
  'method', 'backup_token', '_gs', 'sim_mnc', 'id', 'mnc', '_gg',
  'network_radio_type', 'lg', 'rc', 'pid', '_ge', 'cellular_strength', 'gpia',
  'hasinrc', 'aid', 'mcc', '_gp', 'hasav', 'device_ram', 'db', 'sim_type',
  'prefer_sms_over_flash', 'access_session_id', 'sim_mcc', 'roaming_type',
  'mistyped', 'airplane_mode_type', 'e_ident', 'e_skey_sig', 'entrypoint',
  'token', 'in', 'expid', 'simnum', 'cc', 'education_screen_displayed',
  'e_skey_val', 'authkey', 'e_keytype', 'e_regid', 'client_metrics', '_gi',
  'e_skey_id', 'first_api_level', 'feo2_query_status', 'reason', 'fdid',
  'recaptcha', '_ga', 'lc'
];

const REGISTER_PARAM_ORDER = [
  'code', 'backup_token', 'sim_mnc', '_gs', 'id', 'device_ram', 'db', '_gg',
  'sim_operator_name', 'passkey_login_status', 'lg', 'rc', 'network_radio_type',
  'pid', '_ge', 'cellular_strength', 'gpia', 'hasinrc', 'aid',
  'network_operator_name', 'mcc', '_gp', 'mnc', 'entered', 'access_session_id',
  'sim_mcc', 'roaming_type', 'mistyped', 'airplane_mode_type', 'has_play_store',
  'sim_type', 'e_ident', 'e_skey_sig', 'entrypoint', 'in', 'expid', 'simnum',
  'cc', 'e_skey_val', 'authkey', 'e_keytype', 'e_regid', '_gi', 'client_metrics',
  'e_skey_id', 'fdid', 'recaptcha', '_ga', 'lc'
];

// Reorder [k, v, …] to the native order for /code and /register (Android
// only). Unknown keys keep their order and go last; nothing is dropped.
function reorderRegistrationPairs(pairs, path, device) {
  const order = path === '/code' ? CODE_PARAM_ORDER
              : path === '/register' ? REGISTER_PARAM_ORDER
              : null;
  if (!order || !device || device.os !== 'android') return pairs;

  const orderSet = new Set(order);
  const seen     = new Map();
  const extras   = [];
  for (let i = 0; i < pairs.length; i += 2) {
    const k = pairs[i];
    if (seen.has(k)) continue;
    seen.set(k, pairs[i + 1]);
    if (!orderSet.has(k)) extras.push(k);
  }

  const out = [];
  for (const k of order)  if (seen.has(k)) out.push(k, seen.get(k));
  for (const k of extras) out.push(k, seen.get(k));
  return out;
}

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
// 16 random bytes, URL-safe base64 without padding; one per session.

function newAccessSessionId() {
  return crypto.randomBytes(16).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function getAccessSessionId(store) {
  if (!store._accessSessionId) store._accessSessionId = newAccessSessionId();
  return store._accessSessionId;
}

// ---------- /code verification-code parameters (per platform) ----------
// Name/value pairs for /code: Android sends the long list, iOS the short one.

// Server-requested wait in seconds, or null. The method's own *_wait field
// wins, else the longest of the others, else retry_after.
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

// ---------- device_ram ----------
// Usable RAM in GiB (totalMem, below the nominal size: 12 GB → ~11.5), taken
// from the device profile so it matches the declared phone.
const DEFAULT_DEVICE_RAM = '5.62';

function deviceRam(device) {
  const ram = device && device.ram;
  if (ram == null) return DEFAULT_DEVICE_RAM;
  const n = Number(ram);
  // Two decimals, the way the client formats it.
  return Number.isFinite(n) && n > 0 ? n.toFixed(2) : DEFAULT_DEVICE_RAM;
}

// ---------- first_api_level ----------
// ro.product.first_api_level: the SDK the phone shipped with (not the current
// OS). From the profile's firstApiLevel, else derived from osVersion, else 34.
const ANDROID_VERSION_TO_API = {
  '10': 29, '11': 30, '12': 31, '13': 33, '14': 34, '15': 35, '16': 36
};
const DEFAULT_FIRST_API_LEVEL = 34;

function firstApiLevel(device) {
  const pinned = device && device.firstApiLevel;
  if (pinned != null && String(pinned).trim() !== '') {
    const n = parseInt(pinned, 10);
    if (Number.isFinite(n) && n > 0) return String(n);
  }
  const osVersion = device && device.osVersion;
  if (osVersion != null) {
    // Major version only ('14.1' → '14').
    const major = String(osVersion).trim().split('.')[0];
    if (ANDROID_VERSION_TO_API[major] != null) {
      return String(ANDROID_VERSION_TO_API[major]);
    }
  }
  return String(DEFAULT_FIRST_API_LEVEL);
}

// ---------- pid ----------
// A realistic Android app pid, derived from the session identity so it stays
// the same across /exist, /code and /register (not Node's process.pid).
function getAppPid(store) {
  if (store._appPid) return store._appPid;
  const seed = (store.identityId && Buffer.isBuffer(store.identityId))
    ? store.identityId
    : Buffer.from(String(store.phoneNumber || ''), 'utf8');
  const h = crypto.createHash('sha256').update(seed).update('pid').digest();
  // 1024..32767 — clear of the kernel and early-boot range, inside pid_max.
  store._appPid = String(1024 + (h.readUInt32BE(0) % (32768 - 1024)));
  return store._appPid;
}

// ---------- the install _gi describes ----------
// sourceDir: base.apk path with two random 16-byte tags, as PackageManager
// names it. did: Build.ID + "." + INCREMENTAL (Samsung-style for SM- models,
// numeric otherwise). Both derived from the session identity, like pid.
function getInstallIdentity(store, device, packageName) {
  const seed = (store.identityId && Buffer.isBuffer(store.identityId))
    ? store.identityId
    : Buffer.from(String(store.phoneNumber || ''), 'utf8');
  const h = (label) => crypto.createHash('sha256').update(seed).update(label).digest();
  const tag = (label) => h(label).subarray(0, 16).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_');

  const sourceDir = '/data/app/~~' + tag('apkdir') + '/' +
    packageName + '-' + tag('pkgdir') + '/base.apk';

  let incremental = device && device.osBuildIncremental;
  if (!incremental) {
    const f = h('firmware');
    const model = String((device && device.modelId) || '');
    if (/^SM-/i.test(model)) {
      incremental = model.replace(/^SM-/i, '').toUpperCase() + 'XXU' +
        String(1 + f[0] % 3) +
        'ABC'[f[1] % 3] +
        'X' +
        'ABCDEFGHIJKL'[f[2] % 12] +
        String(1 + f[3] % 9);
    } else {
      incremental = String(10000000 + f.readUInt32BE(4) % 90000000);
    }
  }
  const buildId = (device && device.osBuildNumber) || 'UP1A.231005.007';

  return { did: buildId + '.' + incremental, sourceDir };
}

// No SIM when mcc is missing or all zeros. Every SIM field uses this one test,
// so a request never contradicts itself.
function _simAbsent(meta) {
  const mcc = meta && meta.mcc != null ? String(meta.mcc).trim() : '';
  return !/^\d+$/.test(mcc) || /^0+$/.test(mcc);
}

function buildClientMetrics(attempt, meta) {
  const simAbsent = _simAbsent(meta);
  const json = '{"attempts":' + (attempt == null ? 1 : attempt)
    + ',"app_campaign_download_source":"google-play|unknown"'
    + ',"is_sim_absent":' + (simAbsent ? 'true' : 'false') + '}';
  return encodeURIComponent(json);
}

// `push_code` is intentionally absent: the push code arrives after /code and is
// sent on /register (see receivePushCode). An empty value would get bad_param,
// so it stays null and buildForm drops it.
function deviceAid(store) {
  const seed = (store.identityKeyPair && store.identityKeyPair.public)
    ? Buffer.from(store.identityKeyPair.public)
    : Buffer.from(String(store.phoneNumber || ''), 'utf8');
  return crypto.createHash('sha256').update(seed).update('aid').digest('base64');
}

function getRequestVerificationCodeParameters(store, method, meta, device, attempt) {
  if (device && device.os === 'android') {
    // Flash call is only routed when these three fields say the app can see calls.
    const wantsFlash = method === 'flash';
    // One SIM story: no SIM → "000" operator codes and SIM flags at 0.
    const simAbsent = _simAbsent(meta);
    const simMcc    = simAbsent ? '000' : meta.mcc;
    const simMnc    = simAbsent ? '000' : meta.mnc;
    return [
      'method',                     method,
      'sim_mcc',                    simMcc,
      'sim_mnc',                    simMnc,
      'reason',                     '',
      'mcc',                        simMcc,
      'mnc',                        simMnc,
      'feo2_query_status',          'success_get_client_capabilities',
      'db',                         '1',
      'sim_type',                   simAbsent ? '0' : '1',
      'recaptcha',                  '%7B%22stage%22%3A%22ABPROP_DISABLED%22%7D',
      'network_radio_type',         '1',
      'prefer_sms_over_flash',      wantsFlash ? 'true' : 'false',
      'simnum',                     simAbsent ? '0' : '1',
      'airplane_mode_type',         '0',
      'client_metrics',             buildClientMetrics(attempt, meta),
      'mistyped',                   '7',
      'advertising_id',             store.advertisingId || '',
      'hasinrc',                    '1',
      'roaming_type',               '0',
      'device_ram',                 deviceRam(device),
      'first_api_level',            firstApiLevel(device),
      'education_screen_displayed', 'false',
      'pid',                        getAppPid(store),
      'cellular_strength',          '5',
      'backup_token',               store.backupToken ? toUrlHex(store.backupToken) : '',
      'tos_version',                '5',
      'call_log_permission',        wantsFlash ? 'true' : 'false',
      'manage_call_permission',     wantsFlash ? 'true' : 'false',
      'clicked_education_link',     'false',
      'aid',                        deviceAid(store),
      'hasav',                      '2',
      'entrypoint',                 'suma',
      // Always absent — see the note above the function.
      'push_code',                  null
    ];
  }

  // iOS
  return [
    'method',            method,
    'sim_mcc',           meta.mcc,
    'sim_mnc',           meta.mnc,
    'jailbroken',        '0',
    // Always absent — see the note above the function.
    'push_code',         null,
    'cellular_strength', '1'
  ];
}

// ---------- /register device parameters (Android) ----------
// Same values as on /code; client_metrics restarts its attempt counter at 0.
const REGISTER_DEVICE_FIELDS = new Set([
  'backup_token', 'sim_mnc', 'device_ram', 'db', 'network_radio_type', 'pid',
  'cellular_strength', 'hasinrc', 'aid', 'mcc', 'mnc', 'sim_mcc',
  'roaming_type', 'mistyped', 'airplane_mode_type', 'sim_type', 'simnum',
  'recaptcha'
]);

function getRegisterDeviceParameters(store, meta, device) {
  if (!device || device.os !== 'android') return [];
  const code = getRequestVerificationCodeParameters(
    store, store.codeMethod || 'sms', meta, device, 0);
  const out = [];
  for (let i = 0; i < code.length; i += 2) {
    if (REGISTER_DEVICE_FIELDS.has(code[i])) out.push(code[i], code[i + 1]);
  }
  out.push('client_metrics', buildClientMetrics(0, meta));
  return out;
}

// ---------- Payload ----------

// base64url WITH padding — matches Java's Base64.getUrlEncoder().encodeToString()
function toBase64Url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

// URL-safe base64 without padding, as the native client sends the Signal-key
// fields and expid (Base64 flags 11). ENC and vname keep the padded form.
function toBase64UrlNoPad(buf) {
  return toBase64Url(buf).replace(/=+$/, '');
}

// ---------- vname: the Business verified-name certificate ----------
// Business only. A self-signed VerifiedNameCertificate:
//
//   Details      { 1 serial (uint64), 2 issuer "smb:wa", 4 verifiedName "" }
//   Certificate  { 1 details (the encoded Details), 2 signature }
//
// Signed with the identity key being registered; the name stays empty until
// WhatsApp verifies the business.

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

  // Positive 63-bit serial (top bit cleared).
  const serialBytes = crypto.randomBytes(8);
  serialBytes[0] &= 0x7f;
  const serial = serialBytes.readBigUInt64BE(0);

  const details = Buffer.concat([
    _pbVarintField(1, serial),
    _pbLenField(2, Buffer.from(VNAME_ISSUER_SMALL_BUSINESS, 'utf8')),
    _pbLenField(4, Buffer.alloc(0))            // verifiedName: empty, not absent
  ]);

  // XEdDSA over the encoded details, with the identity key.
  const signature = Buffer.from(
    curveJs.sign(store.identityKeyPair.private, details));

  return toBase64Url(Buffer.concat([
    _pbLenField(1, details),
    _pbLenField(2, signature)
  ]));
}

async function buildPayload(store, waVersion, useToken, extraPairs, path) {
  const { cc, national } = parsePhone(store.phoneNumber);
  const meta   = getCountryMeta(cc, store);
  const device = store.device || getDeviceConfig();
  const token  = useToken ? computeToken(waVersion, national, device) : null;
  // Android formats fdid lowercase, iOS uppercase (matches the native clients).
  const fdid   = device.os === 'android'
    ? store.fdid.toLowerCase()
    : store.fdid.toUpperCase();

  // Attestation fields: empty unless WA_FRIDA_HOST is set. Stable per-session nonce.
  const nonceB64 = attestation.toBase64Url(
    crypto.createHash('sha256')
      .update(Buffer.concat([store.identityId, stripKeyPrefix(store.noiseKeyPair.public)]))
      .digest()
  );
  // Push token from the platform's own transport (FCM / APNs), cached on the
  // store; null on failure, which just drops the field.
  const pushToken = await pushClientFor(device).getPushToken(store, device);

  const authKeyRaw  = stripKeyPrefix(store.noiseKeyPair.public);
  const apkMaterial = device.os === 'android' ? tryLoadAndroidMaterial(device) : null;
  // One _ga per session: the app sends the same one on /code and /register.
  if (device.os === 'android' && !store._gaToken) {
    store._gaToken = attestation.generateGaToken(authKeyRaw);
  }
  const attestFields = await attestation.attestationFields(device, nonceB64, {
    pushToken,
    authKeyRaw,
    apkMaterial,
    install: apkMaterial ? getInstallIdentity(store, device, apkMaterial.packageName) : null,
    ga: store._gaToken
  });

  const basePairs = [
    'cc',                cc,
    'in',                national,
    'rc',                String(RELEASE_CHANNEL),
    'lg',                meta.lg,
    'lc',                meta.lc,
    'authkey',           toBase64UrlNoPad(stripKeyPrefix(store.noiseKeyPair.public)),
    // Business only (null is dropped).
    'vname',             buildVerifiedNameCertificate(store, device),
    'e_regid',           toBase64UrlNoPad(intToBytes(store.registrationId, 4)),
    'e_keytype',         toBase64UrlNoPad(Buffer.from([SIGNAL_KEY_TYPE])),
    'e_ident',           toBase64UrlNoPad(stripKeyPrefix(store.identityKeyPair.public)),
    'e_skey_id',         toBase64UrlNoPad(intToBytes(store.signedPreKey.id, 3)),
    'e_skey_val',        toBase64UrlNoPad(stripKeyPrefix(store.signedPreKey.public)),
    'e_skey_sig',        toBase64UrlNoPad(store.signedPreKey.signature),
    'fdid',              fdid,
    'expid',             toBase64UrlNoPad(store.deviceId),
    'id',                toUrlHex(store.identityId),
    'access_session_id', getAccessSessionId(store),
    'token',             token,
    ...attestFields
  ];
  const allPairs = extraPairs ? basePairs.concat(extraPairs) : basePairs;
  // Native field order for /code and /register (part of the fingerprint).
  return buildForm(reorderRegistrationPairs(allPairs, path, device));
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

function httpPost(path, body, waVersion, authHeader, device, query) {
  const proxy = socksProxyUrl();
  if (proxy) return httpPostViaSocks(path, body, waVersion, proxy, authHeader, device, query);

  return new Promise((resolve, reject) => {
    const bodyBuf = Buffer.from(body, 'utf8');
    const headers = Object.assign(
      registrationHeaders(device || getDeviceConfig(), waVersion),
      { 'Content-Length': bodyBuf.length }
    );
    // Attestation header, only when available.
    if (authHeader) headers['Authorization'] = authHeader;
    // Params go both as the URL query and encrypted in ENC.
    const opts = {
      hostname: 'v.whatsapp.net',
      port: 443,
      path: query ? '/v2' + path + '?' + query : '/v2' + path,
      method: 'POST',
      timeout: 20000,
      headers
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const encoding = String(res.headers['content-encoding'] || '');
        let buf = Buffer.concat(chunks);
        if (/gzip/i.test(encoding)) {
          try { buf = zlib.gunzipSync(buf); } catch (_) { /* keep raw */ }
        }
        const text = buf.toString('utf8');
        if (res.statusCode !== 200) {
          return reject(new Boom(`HTTP ${res.statusCode} ${path}: ${text}`, { statusCode: statusFrom(res.statusCode) }));
        }
        try { resolve(JSON.parse(text)); }
        catch (_) { resolve({ raw: text }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Boom(`HTTPS timeout on ${path}`, { statusCode: 408 })); });
    req.write(bodyBuf);
    req.end();
  });
}

async function sendRequest(path, store, waVersion, useToken, extraPairs) {
  const plaintext = await buildPayload(store, waVersion, useToken, extraPairs, path);
  return sendEncrypted(path, plaintext, store, waVersion);
}

/** Encrypt a built form body and post it (funnel endpoints call this directly). */
async function sendEncrypted(path, plaintext, store, waVersion) {
  const enc  = encryptPayload(plaintext);   // base64url ENC payload (no prefix)
  let   body = 'ENC=' + enc;

  // Body attestation (&H= plus an Authorization header); skipped unless Frida is configured.
  const device  = store.device || getDeviceConfig();
  const bodyAtt = await attestation.attestBody(enc, device, {
    noisePubB64: stripKeyPrefix(store.noiseKeyPair.public).toString('base64')
  });
  if (bodyAtt.bodyAttestation) body += '&H=' + bodyAtt.bodyAttestation;

  _whaDbg('[DBG] REG → ' + path + ' (' + body.length + ' bytes' +
    (bodyAtt.bodyAttestation ? ', attested' : '') + ')');
  // Mirror the plaintext into the URL query, only for Android /code and /register.
  const mirrorQuery = device.os === 'android' && (path === '/code' || path === '/register');
  const result = await httpPost(path, body, waVersion, bodyAtt.authorizationHeader, device,
    mirrorQuery ? plaintext : undefined);
  _whaDbg('[DBG] REG ← ' + path + ' ' +
    (result && result.status ? result.status : JSON.stringify(result).slice(0, 120)) +
    (result && result.reason ? ' reason=' + result.reason : ''));
  return result;
}

// ---------- Pacing ----------
//
// Random human-like pauses between steps (a range, never a fixed delay):
//
//   enter_number    typing the number in before the lookup fires
//   confirm_number  the "is this your number?" sheet, and tapping through it
//   retry_code      after a refused request, before asking again
//   switch_method   picking a different delivery method out of the list
//
// WA_REG_PACING=0 disables them.
const PACING_RANGES_MS = {
  enter_number:   [1800, 5200],
  confirm_number: [1200, 3600],
  retry_code:     [2800, 7500],
  switch_method:  [2000, 5000]
};

function pacingEnabled() {
  return process.env.WA_REG_PACING !== '0';
}

function humanPause(kind) {
  const range = PACING_RANGES_MS[kind];
  if (!range || !pacingEnabled()) return Promise.resolve();
  const ms = range[0] + Math.floor(Math.random() * (range[1] - range[0] + 1));
  _whaDbg('[DBG] REG pacing ' + kind + ' ' + ms + 'ms');
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- Funnel telemetry ----------
// Screen events to /client_log (and /pre_pn_client_log before the number), as
// the native client sends. Fire-and-forget; WA_FUNNEL_LOG=0 disables it.

function funnelEnabled() {
  return process.env.WA_FUNNEL_LOG !== '0';
}

// verify_<method>, or enter_number before any request.
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
      'expid',           toBase64UrlNoPad(store.deviceId),
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

// Fires before the number is known, so no cc / in.
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
      'expid',           toBase64UrlNoPad(store.deviceId),
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

/** Decode base64 or base64url (the server has used both); null if empty. */
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

// Flash call: the code is the trailing digits of the missed call's number,
// typed by the user in any format. Default length 6 (WA_FLASH_CODE_LEN overrides).
const FLASH_CODE_LENGTH = 6;

function flashCodeLength() {
  const raw = parseInt(process.env.WA_FLASH_CODE_LEN, 10);
  return raw > 0 ? raw : FLASH_CODE_LENGTH;
}

// Apply the server's cli_filter regex (e.g. "(.*)373(.*)") and return the last
// group with digits; null if missing, invalid or no match.
function applyFlashFilter(digits, filter) {
  if (!filter) return null;
  let re;
  try { re = new RegExp(String(filter)); } catch (_) { return null; }
  const m = re.exec(digits);
  if (!m) return null;
  // Last group with digits.
  for (let i = m.length - 1; i >= 1; i--) {
    const g = m[i] && m[i].replace(/\D/g, '');
    if (g) return g;
  }
  return null;
}

// `opts`: a length or { length, filter }. Filter picks the digits, length trims them.
function flashCodeFromCallerId(input, opts) {
  const digits = normalizeCodeResult(input);
  const o      = (opts && typeof opts === 'object') ? opts : { length: opts };
  const want   = Number(o.length) > 0 ? Number(o.length) : flashCodeLength();

  const filtered = applyFlashFilter(digits, o.filter);
  const base     = (filtered && filtered.length) ? filtered : digits;

  // Already short enough: leave it.
  return base.length > want ? base.slice(-want) : base;
}

// The code /register receives; flash calls get their digits extracted.
// The method comes from the session (opts.method overrides).
function codeForSubmission(store, code, opts) {
  const pending = String(
    (opts && opts.method) || (store && store.codeMethod) || ''
  ).toLowerCase();
  if (pending !== 'flash') return normalizeCodeResult(code);

  // Length: env, then opts, then the server's value, then the default.
  const envLen = parseInt(process.env.WA_FLASH_CODE_LEN, 10);
  const length = envLen > 0 ? envLen
               : (opts && Number(opts.flashCodeLen) > 0 ? Number(opts.flashCodeLen)
               : (store && Number(store.flashCodeLength) > 0 ? Number(store.flashCodeLength) : 0));
  // Filter: opts.flashFilter or the server's cli_filter.
  const filter = (opts && opts.flashFilter) || (store && store.flashCliFilter) || null;

  return flashCodeFromCallerId(code, { length, filter });
}

// Use the number the server registered (e.g. Brazil's extra ninth digit differs).
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
 * Solve captchas until the server stops asking (a wrong answer brings a new
 * one). Without a solveCaptcha handler it throws with the blobs attached.
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
      const err = new Boom(
        'Registration needs a CAPTCHA solved' +
        (typeof opts.solveCaptcha === 'function'
          ? ', and the solveCaptcha handler returned nothing.'
          : ', and no solveCaptcha handler was given.\n' +
            '  Pass one to verifyCode: verifyCode(store, code, { solveCaptcha: async ({ image, audio }) => "…" }).\n' +
            '  image and audio are Buffers, or null when that variant was not sent.'), { statusCode: 403 }
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

    const err = new Boom('Registration CAPTCHA refused: ' +
      (response.reason || response.status || JSON.stringify(response)), { statusCode: 403 });
    err.raw = response;
    throw err;
  }
}

/** Submit the account's two-step PIN; throws without a twoFactorPin handler. */
async function handle2FA(store, waVersion, opts) {
  await sendFunnelLog(store, waVersion, 'verify_twofac', 'twofac_shown', 'twofac_prompt_shown');

  let pin = null;
  if (typeof opts.twoFactorPin === 'function') pin = await opts.twoFactorPin();
  if (!pin) {
    await sendFunnelLog(store, waVersion, 'verify_twofac', 'twofac_abandoned', 'twofac_abandoned');
    throw new Boom(
      'This number has two-step verification switched on and the registration ' +
      'needs its PIN' +
      (typeof opts.twoFactorPin === 'function'
        ? ', but the twoFactorPin handler returned nothing.'
        : '.\n  Pass one to verifyCode: verifyCode(store, code, { twoFactorPin: async () => "123456" }).\n' +
          '  It is the six-digit PIN set on the phone under Settings → Account → Two-step verification.'), { statusCode: 401 }
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

  const err = new Boom('Two-step verification PIN refused: ' +
    (response.reason || response.status || JSON.stringify(response)), { statusCode: 401 });
  err.raw = response;
  throw err;
}

// ---------- Public API ----------

async function checkIfRegistered(store) {
  const waVersion = await fetchWaVersion(store.device || getDeviceConfig());
  return sendRequest('/exist', store, waVersion, false, null);
}

/**
 * Is a number active on WhatsApp? Uses an ephemeral store.
 *
 *   1. /exist        — 'ok' means registered.
 *   2. /code wa_old  — sent → on WhatsApp; block screen → banned; else step 3.
 *   3. /code sms     — sent → not on WhatsApp; too_recent → cooldown; fail → unknown.
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
  const meta      = getCountryMeta(cc, store);

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
// Up to two /exist attempts. true → keys are fresh; false → already registered.
async function assertRegistrationKeys(store, waVersion) {
  // Session-start event (before the number is known).
  await sendPrePnFunnelLog(store, waVersion, 'session_start', 'registration_session_start');
  // Typing the number.
  await humanPause('enter_number');
  await sendFunnelLog(store, waVersion, 'enter_number', 'exist_check', 'exist_attempt');

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (attempt > 0) await humanPause('retry_code');
      logDeviceIdentity('before /exist', store, waVersion);
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

// Cap for a server that answers with a different reason every time.
const MAX_CODE_REQUEST_ATTEMPTS = 5;

// Save opts.name to the session; it is announced on first connect, not sent here.
function applyRegistrationName(store, opts) {
  if (!store || !opts || opts.name === undefined || opts.name === null) return;
  const { normalizePushName } = require('./Store');
  const clean = normalizePushName(opts.name);
  if (clean) {
    store.name = clean;
    store.pushName = clean;
    store.pendingPushName = clean;
  }
}

async function requestSmsCode(store, method, opts) {
  method = method || 'sms';
  opts   = opts   || {};
  applyRegistrationName(store, opts);
  // Before reading the version: on Android it comes from this APK.
  const _device   = deviceForRegistration(store, opts);
  await ensureAndroidMaterial(opts, _device);
  const waVersion = await fetchWaVersion(_device);
  store.version = waVersion;
  store.device  = _device;

  // Flash is Android-only; refuse early instead of wasting an attempt.
  if (method === 'flash' && !(_device && _device.os === 'android')) {
    throw new Boom(
      'Flash call verification is Android-only — iOS has no API for reading an ' +
      'incoming call\'s number, so WhatsApp does not offer it there.\n' +
      '  Re-run as Android:  WA_OS=android wa registration --request-code ' +
      store.phoneNumber + ' --method flash', { statusCode: 405 }
    );
  }

  // Auto-fallback: if the primary method gets no_routes, try the alternate once.
  // sms → wa_old, wa_old → sms, voice → sms, email_otp → sms.
  const fallbackMethod = method === 'wa_old' ? 'sms'
    : (method === 'sms'       ? 'wa_old'
    : (method === 'email_otp' ? 'sms'
    : 'sms'));
  let autoFallbackDone = false;

  // Derive real MCC/MNC from the phone number being registered.
  const { cc: _regCc } = parsePhone(store.phoneNumber);
  const _regMeta       = getCountryMeta(_regCc, store);

  async function _tryMethod(m) {
    // Retry loop: success → return; too_recent → throw; no_routes → let the
    // caller fall back; block screen → throw; same error twice → throw; else retry.
    let lastReason = null;
    let attemptNum = 1;
    // "Is this your number?" sheet.
    await humanPause('confirm_number');
    while (true) {
      // Rebuilt per attempt (client_metrics attempt count).
      const extra = getRequestVerificationCodeParameters(store, m, _regMeta, _device, attemptNum);

      // Record the method first: later events are named after it.
      store._lastRequestedMethod = m;
      const verifyScreen = currentVerifyScreen(store);
      await sendFunnelLog(store, waVersion, verifyScreen, 'request_code', 'request_code_attempt');

      logDeviceIdentity('before /code', store, waVersion);
      const result = await sendRequest('/code', store, waVersion, true, extra);

      const status = result.status;
      if (status === 'ok' || status === 'sent') {
        // Save the method that actually worked (confirmation runs separately).
        store.codeMethod = m;

        // Save the flash reply's cli_filter / prefix / length / timeout for
        // codeForSubmission and the CLI.
        if (m === 'flash') {
          const srvLen = Number(result.length);
          store.flashCliFilter  = result.cli_filter || null;
          store.flashCliPrefix  = result.cli_prefix || null;
          store.flashCliCc      = result.cli_cc     || null;
          store.flashCodeLength = srvLen > 0 ? srvLen : null;
          store.flashTimeout    = Number(result.flash_timeout) > 0 ? Number(result.flash_timeout) : null;
          _whaDbg('[DBG] REG ← /code flash cli: cc=' + (result.cli_cc || '?')
            + ' prefix=' + (result.cli_prefix || '?')
            + ' filter=' + (result.cli_filter || '?')
            + ' length=' + (srvLen > 0 ? srvLen : '?')
            + ' timeout=' + (result.flash_timeout || '?') + 's');
        }

        await sendFunnelLog(store, waVersion, verifyScreen, 'request_code', 'request_code_success');
        return result;
      }

      const reason = result.reason || status || '';

      // Too recent / too many: no point retrying.
      if (/too_recent|too_many|too_many_guesses|too_many_all_methods/i.test(reason) ||
          /too_recent|too_many|too_many_guesses|too_many_all_methods/i.test(status)) {
        const waitSec = waitHint(result, m);
        const waitMsg = waitSec ? ` (wait ${Math.ceil(waitSec / 60)} min, ${waitSec}s)` : '';
        throw new Boom(`code already sent recently — check your phone or wait a few minutes (${reason})${waitMsg}`, { statusCode: 429 });
      }

      // no_routes: let the caller try another method.
      if (reason === 'no_routes' || status === 'no_routes') {
        return { _noRoutes: true, method: m };
      }

      // Security block (IP or number flagged).
      if (result.custom_block_screen) {
        const body = result.custom_block_screen.body || 'blocked by WhatsApp security';
        throw new Boom(`WhatsApp security block: "${body}" — use a residential IP/proxy`, { statusCode: 403 });
      }

      // Same error twice → give up (empty reasons count too).
      if (reason === lastReason) {
        throw new Boom(`Registration error (${m}): ${reason || 'no status in response'} — raw: ${JSON.stringify(result)}`, { statusCode: 502 });
      }

      // First occurrence of unknown error → retry once
      lastReason = reason;
      attemptNum++;

      // Hard cap on attempts.
      if (attemptNum > MAX_CODE_REQUEST_ATTEMPTS) {
        throw new Boom(`Registration error (${m}): giving up after ${MAX_CODE_REQUEST_ATTEMPTS} attempts — raw: ${JSON.stringify(result)}`, { statusCode: 502 });
      }

      // Human pause before retrying.
      await humanPause('retry_code');
    }
  }

  // Try primary method
  let result = await _tryMethod(method);

  // Auto-fallback on no_routes
  if (result && result._noRoutes && !autoFallbackDone) {
    autoFallbackDone = true;
    process.stderr.write(`[REG] ${method} returned no_routes — auto-trying ${fallbackMethod}\n`);
    // Human pause before switching method.
    await humanPause('switch_method');
    result = await _tryMethod(fallbackMethod);
  }

  // Still no_routes: the server judges the IP, the number and the platform, so
  // the advice points there.
  if (result && result._noRoutes) {
    const tried = autoFallbackDone ? `${method}, then ${fallbackMethod}` : method;
    throw new Boom(
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
      `counts against it`, { statusCode: 403 }
    );
  }

  return result;
}

async function verifyCode(store, code, opts) {
  opts = opts || {};
  applyRegistrationName(store, opts);
  // The confirmation may run from a fresh shell.
  const _device   = deviceForRegistration(store, opts);
  await ensureAndroidMaterial(opts, _device);
  const waVersion = await fetchWaVersion(_device);
  store.version = waVersion;
  store.device  = _device;
  // Codes may arrive as numbers. For flash, the caller types the missed call's
  // number; the pending method is read from the session (opts.method overrides).
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

  // The Android app sends the setup token on /code only; iOS keeps it here.
  const registerMeta = getCountryMeta(parsePhone(store.phoneNumber).cc, store);
  const result = await sendRequest('/register', store, waVersion, _device.os !== 'android', [
    'code',                   normalized,
    'sim_operator_name',      '',
    'passkey_login_status',   'not_attempted',
    'network_operator_name',  '',
    'entered',                '1',
    'has_play_store',         'true',
    'entrypoint',             'suma',
    ...getRegisterDeviceParameters(store, registerMeta, _device)
  ]);

  const status = result.status;
  if (status === 'ok' || status === 'sent' || status === 'verified') {
    await sendFunnelLog(store, waVersion, 'account_verification_complete',
      'submit_code', 'submit_code_success');
    // Adopt the server's canonical number (`login`), or the login fails with 401.
    return adoptCanonicalNumber(store, result);
  }

  // Captcha and 2FA first: neither comes as a reason the checks below match.
  if (hasChallenge(result))  return handleChallenge(store, waVersion, result, opts);
  if (is2FARequired(result)) return handle2FA(store, waVersion, opts);

  const reason = result.reason || '';
  if (reason === 'missing') {
    throw new Boom(
      'Verification failed: code expired or already used.\n' +
      '  Run /reg code <phone> again to get a new code, then immediately confirm it.', { statusCode: 410 }
    );
  }
  if (/bad_code|code_invalid|wrong/.test(reason)) {
    throw new Boom('Verification failed: wrong code entered. Check the SMS and try again.', { statusCode: 401 });
  }
  if (/too_many/.test(reason)) {
    throw new Boom('Verification failed: too many wrong attempts. Wait a few minutes then request a new code.', { statusCode: 429 });
  }
  // Age / consent gate (seen in Brazil): the code was accepted but an age
  // signal is required. Android sends the terms fields iOS lacks, so try Android.
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
    const err = new Boom(lines.join('\n'), { statusCode: 403 });
    err.reason    = reason;
    err.pending   = result.pending || null;
    err.canonicalPhoneNumber = canonical;
    err.raw       = result;
    throw err;
  }
  throw new Boom(`Verification failed: ${reason || JSON.stringify(result)}`, { statusCode: 400 });
}

module.exports = { checkIfRegistered, checkNumberStatus, requestSmsCode, verifyCode, fetchIosVersion, fetchAndroidVersion, fetchPlayVersion, fetchAndroidVersionLive, fetchWaVersion, currentVersionFor, refreshSessionVersion, clearVersionCache, tryLoadAndroidMaterial, compareVersions, parsePhone, getCountryMeta, assertRegistrationKeys, parseSocksProxy, socksProxyUrl };

// The HTTP reader, exposed for tests. Not part of the public API.
module.exports._http = { readHttpResponse, parseHttpResponse, decodeChunkedBody, decodeBody, reorderRegistrationPairs };

// Token computation, exposed for tests. Not part of the public API.
module.exports._token = { computeToken, androidMaterialPath, registrationHeaders, ensureAndroidMaterial, deviceForRegistration, buildVerifiedNameCertificate, buildPayload };

// Challenge / two-factor internals, exposed for tests. Not part of the public API.
module.exports._verify = {
  hasChallenge, is2FARequired, decodeOrNull, isSuccessful,
  normalizeCodeResult, currentVerifyScreen, adoptCanonicalNumber, funnelEnabled, waitHint,
  flashCodeFromCallerId, flashCodeLength, applyFlashFilter, codeForSubmission,
  getRequestVerificationCodeParameters, getRegisterDeviceParameters, getInstallIdentity, deviceAid
};

// Pacing internals, exposed for tests. Not part of the public API.
module.exports._pacing = { pacingEnabled, humanPause, buildClientMetrics, PACING_RANGES_MS };
