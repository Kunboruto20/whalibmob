'use strict';

// ─── Apple Push Notification service — the push_token an iPhone carries ───────
//
// The Android half of this has existed here for a while: lib/fcm.js walks
// Google's checkin → FIS → register3 and comes back with the Firebase token a
// real WhatsApp install sends as push_token. The iOS half was missing, and
// because iOS is this library's default device profile, every iPhone
// registration went out with no push_token at all — a WhatsApp that cannot be
// woken, which is not a device that exists.
//
// This is that half. Apple's flow is not Google's, but it lands in the same
// place:
//
//   1. activation   albert.apple.com signs a device certificate for a keypair
//                   we generate, given a FairPlay-signed request. This is what
//                   a Mac or an iPhone does on first boot, and what every
//                   desktop iMessage/APNs client has done since. The
//                   certificate is good for about three years, so it is
//                   persisted with the account and the handshake runs once.
//   2. courier      one TLS connection to Apple carrying the device token, and
//                   over it GET_TOKEN for net.whatsapp.WhatsApp — the per-topic
//                   token. That is push_token. See ./apns-courier.
//   3. the push     after /code, WhatsApp emits a silent push whose JSON
//                   carries "regcode". Reading it is how a number is verified
//                   without an SMS, exactly as MCS does on Android.
//
// The failure contract is the one lib/fcm.js established, because registration
// depends on it: nothing here throws. A blocked network, a refusal from Apple, a
// malformed answer — all of them end as null, Attestation drops the field, and
// the body goes out exactly as it did before this file existed. A push token is
// a signal that helps; it is never the reason a registration cannot be tried.

const https = require('https');
const crypto = require('crypto');

const { dbg: _whaDbg } = require('./logger');
const { proxyAgent } = require('./socks');
const plist = require('./plist');
const { ApnsCourierConnection, extractRegCode } = require('./apns-courier');

// The two iOS bundle ids WhatsApp ships under. The first is the messaging topic
// and the one push_token names; the .voip sibling is subscribed too because the
// verification push is the VoIP-flavoured silent kind.
const APNS_CONFIG = {
  personal: {
    topics: ['net.whatsapp.WhatsApp', 'net.whatsapp.WhatsApp.voip']
  },
  business: {
    topics: ['net.whatsapp.WhatsAppSMB', 'net.whatsapp.WhatsAppSMB.voip']
  }
};

const ACTIVATION_URL =
  'https://albert.apple.com/WebObjects/ALUnbrick.woa/wa/deviceActivation';

const HTTP_TIMEOUT_MS = 30000;
const RSA_KEY_BITS = 2048;

// ─── FairPlay credentials ─────────────────────────────────────────────────────
//
// albert only answers a request signed by a FairPlay key whose certificate
// chain it recognises. This is the chain and key every open APNs client has
// used for years — extracted from Apple's own desktop software, and the reason
// the activation below claims to be a Windows install of iTunes rather than a
// handset: that is the device class this credential belongs to, and a
// credential presenting itself as something else is the one thing albert does
// check.
//
// The private key is a PKCS#1 RSAPrivateKey, DER, base64. It is 1024-bit, which
// is not a choice — it is the key that matches the leaf of the chain.

const FAIRPLAY_PRIVATE_KEY_PKCS1 = Buffer.from([
  'MIICWwIBAAKBgQC3BKrLPIBabhpr+4SvuQHnbF0ssqRIQ67/1bTfArVuUF6p9sdcv70N+r8y',
  'FxesDmpTmKitLP06szKNAO1k5JVk9/P1ejz08BMe9eAb4juAhVWdfAIyaJ7sGFjeSL015mAv',
  'rxTFcOM10F/qSlARBiccxHjPXtuWVr0fLGrhM+/AMQIDAQABAoGACGW3bHHPNdb9cVzt/p4P',
  'f03SjJ15ujMY0XY9wUm/h1s6rLO8+/10MDMEGMlEdcmHiWRkwOVijRHxzNRxEAMI87Aruofh',
  'jddbNVLt6ppW2nLCK7cEDQJFahTW9GQFzpVRQXXfxr4cs1X3kutlB6uY2VGltxQFYsj5djv7',
  'D+A72A0CQQDZj1RGdxbeOo4XzxfA6n42GpZavTlM3QzGFoBJgCqqVu1JQOzooAMRT+NPfgoE',
  '8+usIVVB4Io0bCUTWLpkEytTAkEA11rzIpGIhFkPtNc/33fvBFgwUbsjTs1V5G6z5ly/XnG9',
  'ENfLblgEobLmSmz3irvBRWADiwUx5zY6FN/Dmti56wJAdiScakufcnyvzwQZ7Rwp/61+erYJ',
  'GNFtb2Cmt8NO6AOehcopHMZQBCWy1ecm/7uJ/oZ3avfJdWBI3fGv/kpemwJAGMXyoDBjpu3j',
  '26bDRz6xtSs767r+VctTLSL6+O4EaaXl3PEmCrx/U+aTjU45r7Dni8Z+wdhIJFPdnJcdFkwG',
  'HwJAPQ+wVqRjc4h3Hwu8I6llk9whpK9O70FLo1FMVdaytElMyqzQ2/05fMb7F6yaWhu+Q2GG',
  'XvdlURiA3tY0CsfM0w=='
].join(''), 'base64');

const FAIRPLAY_CERT_CHAIN = Buffer.from([
  'MIIC8zCCAlygAwIBAgIKAlKu1qgdFrqsmzANBgkqhkiG9w0BAQUFADBaMQswCQYDVQQGEwJV',
  'UzETMBEGA1UEChMKQXBwbGUgSW5jLjEVMBMGA1UECxMMQXBwbGUgaVBob25lMR8wHQYDVQQD',
  'ExZBcHBsZSBpUGhvbmUgRGV2aWNlIENBMB4XDTIxMTAxMTE4NDczMVoXDTI0MTAxMTE4NDcz',
  'MVowgYMxLTArBgNVBAMWJDE2MEQzRkExLUM3RDUtNEY4NS04NDQ4LUM1Q0EzQzgxMTE1NTEL',
  'MAkGA1UEBhMCVVMxCzAJBgNVBAgTAkNBMRIwEAYDVQQHEwlDdXBlcnRpbm8xEzARBgNVBAoT',
  'CkFwcGxlIEluYy4xDzANBgNVBAsTBmlQaG9uZTCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkC',
  'gYEAtwSqyzyAWm4aa/uEr7kB52xdLLKkSEOu/9W03wK1blBeqfbHXL+9Dfq/MhcXrA5qU5io',
  'rSz9OrMyjQDtZOSVZPfz9Xo89PATHvXgG+I7gIVVnXwCMmie7BhY3ki9NeZgL68UxXDjNdBf',
  '6kpQEQYnHMR4z17blla9Hyxq4TPvwDECAwEAAaOBlTCBkjAfBgNVHSMEGDAWgBSy/iEjRIaV',
  'annVgSaOcxDYp0yOdDAdBgNVHQ4EFgQURyh+oArXlcLvCzG4m5/QxwUFzzMwDAYDVR0TAQH/',
  'BAIwADAOBgNVHQ8BAf8EBAMCBaAwIAYDVR0lAQH/BBYwFAYIKwYBBQUHAwEGCCsGAQUFBwMC',
  'MBAGCiqGSIb3Y2QGCgIEAgUAMA0GCSqGSIb3DQEBBQUAA4GBAKwB9DGwHsinZu78lk6kx7zv',
  'wH5d0/qqV1+4Hz8EG3QMkAOkMruSRkh8QphF+tNhP7y93A2kDHeBSFWk/3Zy/7riB/dwl94W',
  '7vCox/0EJDJ+L2SXvtB2VEv8klzQ0swHYRV9+rUCBWSglGYlTNxfAsgBCIsm8O1Qr5SnIhwf',
  'utc4MIIDaTCCAlGgAwIBAgIBATANBgkqhkiG9w0BAQUFADB5MQswCQYDVQQGEwJVUzETMBEG',
  'A1UEChMKQXBwbGUgSW5jLjEmMCQGA1UECxMdQXBwbGUgQ2VydGlmaWNhdGlvbiBBdXRob3Jp',
  'dHkxLTArBgNVBAMTJEFwcGxlIGlQaG9uZSBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTAeFw0w',
  'NzA0MTYyMjU0NDZaFw0xNDA0MTYyMjU0NDZaMFoxCzAJBgNVBAYTAlVTMRMwEQYDVQQKEwpB',
  'cHBsZSBJbmMuMRUwEwYDVQQLEwxBcHBsZSBpUGhvbmUxHzAdBgNVBAMTFkFwcGxlIGlQaG9u',
  'ZSBEZXZpY2UgQ0EwgZ8wDQYJKoZIhvcNAQEBBQADgY0AMIGJAoGBAPGUSsnquloYYK3Lok1N',
  'TlQZaRdZB2bLl+hmmkdfRq5nerVKc1SxywT2vTa4DFU4ioSDMVJl+TPhl3ecK0wmsCU/6TKq',
  'ewh0lOzBSzgdZ04IUpRai1mjXNeT9KD+VYW7TEaXXm6yd0UvZ1y8Cxi/WblshvcqdXbSGXH0',
  'KWO5JQuvAgMBAAGjgZ4wgZswDgYDVR0PAQH/BAQDAgGGMA8GA1UdEwEB/wQFMAMBAf8wHQYD',
  'VR0OBBYEFLL+ISNEhpVqedWBJo5zENinTI50MB8GA1UdIwQYMBaAFOc0Ki4i3jlga7SUzneD',
  'YS8xoHw1MDgGA1UdHwQxMC8wLaAroCmGJ2h0dHA6Ly93d3cuYXBwbGUuY29tL2FwcGxlY2Ev',
  'aXBob25lLmNybDANBgkqhkiG9w0BAQUFAAOCAQEAd13PZ3pMViukVHe9WUg8Hum+0I/0kHKv',
  'jhwVd/IMwGlXyU7DhUYWdja2X/zqj7W24Aq57dEKm3fqqxK5XCFVGY5HI0cRsdENyTP7lxSi',
  'iTRYj2mlPedheCn+k6T5y0U4Xr40FXwWb2nWqCF1AgIudhgvVbxlvqcxUm8Zz7yDeJ0JFovX',
  'QhyO5fLUHRLCQFssAbf8B4i8rYYsBUhYTspVJcxVpIIltkYpdIRSIARA49HNvKK4hzjzMS/O',
  'hKQpVKw+OCEZxptCVeN2pjbdt9uzi175oVo/u6B2ArKAW17u6XEHIdDMOe7cb33peVI6TD15',
  'W4MIpyQPbp8orlXe+tA8JDCCA/MwggLboAMCAQICARcwDQYJKoZIhvcNAQEFBQAwYjELMAkG',
  'A1UEBhMCVVMxEzARBgNVBAoTCkFwcGxlIEluYy4xJjAkBgNVBAsTHUFwcGxlIENlcnRpZmlj',
  'YXRpb24gQXV0aG9yaXR5MRYwFAYDVQQDEw1BcHBsZSBSb290IENBMB4XDTA3MDQxMjE3NDMy',
  'OFoXDTIyMDQxMjE3NDMyOFoweTELMAkGA1UEBhMCVVMxEzARBgNVBAoTCkFwcGxlIEluYy4x',
  'JjAkBgNVBAsTHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MS0wKwYDVQQDEyRBcHBs',
  'ZSBpUGhvbmUgQ2VydGlmaWNhdGlvbiBBdXRob3JpdHkwggEiMA0GCSqGSIb3DQEBAQUAA4IB',
  'DwAwggEKAoIBAQCjHr7wR8C0nhBbRqS4IbhPhiFwKEVgXBzDyApkY4j7/Gnu+FT86Vu3Bk4E',
  'L8NrM69ETOpLgAm0h/ZbtP1k3bNy4BOz/RfZvOeo7cKMYcIq+ezOpV7WaetkC40Ij7igUEYJ',
  '3Bnk5bCUbbv3mZjE6JtBTtTxZeMbUnrc6APZbh3aEFWGpClYSQzqR9cVNDP2wKBESnC+LLUq',
  'MDeMLhXr0eRslzhVVrE1K1jqRKMmhe7IZkrkz4nwPWOtKd6tulqz3KWjmqcJToAWNWWkhQ1j',
  'ez5jitp9SkbsozkYNLnGKGUYvBNgnH9XrBTJie2htodoUraETrjIg+z5nhmrs8ELhsefAgMB',
  'AAGjgZwwgZkwDgYDVR0PAQH/BAQDAgGGMA8GA1UdEwEB/wQFMAMBAf8wHQYDVR0OBBYEFOc0',
  'Ki4i3jlga7SUzneDYS8xoHw1MB8GA1UdIwQYMBaAFCvQaUeUdgn+9GuNLkCm90dNfwheMDYG',
  'A1UdHwQvMC0wK6ApoCeGJWh0dHA6Ly93d3cuYXBwbGUuY29tL2FwcGxlY2Evcm9vdC5jcmww',
  'DQYJKoZIhvcNAQEFBQADggEBAB3R1XvddE7XF/yCLQyZm15CcvJp3NVrXg0Ma0s+exQl3rOU',
  '6KD6D4CJ8hc9AAKikZG+dFfcr5qfoQp9ML4AKswhWev9SaxudRnomnoD0Yb25/awDktJ+qO3',
  'QbrX0eNWoX2Dq5eu+FFKJsGFQhMmjQNUZhBeYIQFEjEra1TAoMhBvFQe51StEwDSSse7wYqv',
  'gQiO8EYKvyemvtzPOTqAcBkjMqNrZl2eTahHSbJ7RbVRM6d0ZwlOtmxvSPcsuTMFRGtFvnRL',
  'b7KGkbQ+JSglnrPCUYb8T+WvO6q7RCwBSeJ0szT6RO8UwhHyLRkaUYnTCEpBbFhW3ps64QVX',
  '5WLP0g8wggS7MIIDo6ADAgECAgECMA0GCSqGSIb3DQEBBQUAMGIxCzAJBgNVBAYTAlVTMRMw',
  'EQYDVQQKEwpBcHBsZSBJbmMuMSYwJAYDVQQLEx1BcHBsZSBDZXJ0aWZpY2F0aW9uIEF1dGhv',
  'cml0eTEWMBQGA1UEAxMNQXBwbGUgUm9vdCBDQTAeFw0wNjA0MjUyMTQwMzZaFw0zNTAyMDky',
  'MTQwMzZaMGIxCzAJBgNVBAYTAlVTMRMwEQYDVQQKEwpBcHBsZSBJbmMuMSYwJAYDVQQLEx1B',
  'cHBsZSBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTEWMBQGA1UEAxMNQXBwbGUgUm9vdCBDQTCC',
  'ASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAOSRqQkfkdseR1DrBe1eeYQt6zaiV0xV',
  '7IsZid75S2z1B6siMALoGD74UAnTf0GomPnRymacJGsR0KO75Bsqwx+VnnoMpEeLW9QWNzPL',
  'xA9NzhRp0ckZcvVdDtV/X5vyJQO6VY9NXQ3xZDUjFUsVWR2zlPf2nJ7PULrBWFBnjwi0IPfL',
  'rCwgb3C2PwEwjLdDzw+dPfMrSSgayP7OtbkO2V4c1ss9tTqt9A8OAJILsSEWLnTVPA3bYhar',
  'o3GSR1NVwa8vQbP4++NwzeajTEV+H0xrUJZBicR0YgsQg0GHM4qBsTBY7FoEMoxos48d3mVz',
  '/2deZbxJ2HafMxRloXeUyS0CAwEAAaOCAXowggF2MA4GA1UdDwEB/wQEAwIBBjAPBgNVHRMB',
  'Af8EBTADAQH/MB0GA1UdDgQWBBQr0GlHlHYJ/vRrjS5ApvdHTX8IXjAfBgNVHSMEGDAWgBQr',
  '0GlHlHYJ/vRrjS5ApvdHTX8IXjCCAREGA1UdIASCAQgwggEEMIIBAAYJKoZIhvdjZAUBMIHy',
  'MCoGCCsGAQUFBwIBFh5odHRwczovL3d3dy5hcHBsZS5jb20vYXBwbGVjYS8wgcMGCCsGAQUF',
  'BwICMIG2GoGzUmVsaWFuY2Ugb24gdGhpcyBjZXJ0aWZpY2F0ZSBieSBhbnkgcGFydHkgYXNz',
  'dW1lcyBhY2NlcHRhbmNlIG9mIHRoZSB0aGVuIGFwcGxpY2FibGUgc3RhbmRhcmQgdGVybXMg',
  'YW5kIGNvbmRpdGlvbnMgb2YgdXNlLCBjZXJ0aWZpY2F0ZSBwb2xpY3kgYW5kIGNlcnRpZmlj',
  'YXRpb24gcHJhY3RpY2Ugc3RhdGVtZW50cy4wDQYJKoZIhvcNAQEFBQADggEBAFw2mUwteLft',
  'jJvc83eb8nbSdzBPwR+Fg4UbmT1HN/Kpm0COLNSxkBLYvvRzm+7SZA/LeU802KI++Xj/a8gH',
  '7H05g4tTINM4xLG/mk8Ka/8r/FmnBQl8F0BWER5007eLIztHo9VvJOLr0bdw3w9F4SfK8W14',
  '7ee1Fxeo3H4iNcol1dkP1mvUoiQjEfehrI9zgWDGG1sJL5Ky+ERI8GA4nhX1PSZnIIozavcN',
  'gs/e66Mv+VNqW2TAYzN39zoHLFbr2g8hDtq6cxlPtdk2f8GHVdmnmbkyQvvY1XGefqFStxu9',
  'k0IkEirHDx22TZxeY8hLgBdQqorV2uT80AkHN7B1dSE='
].join(''), 'base64');

// ─── DER ──────────────────────────────────────────────────────────────────────
//
// Node can generate an RSA keypair and sign with it, but it cannot produce a
// certificate signing request, and albert wants one. A CSR is four DER pieces,
// so they are built here rather than pulling in an ASN.1 library for one call.

function derLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v >>>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag, payload) {
  return Buffer.concat([Buffer.from([tag]), derLength(payload.length), payload]);
}

const DER_SEQUENCE = 0x30;
const DER_SET = 0x31;
const DER_INTEGER = 0x02;
const DER_BIT_STRING = 0x03;
const DER_OID = 0x06;
const DER_PRINTABLE_STRING = 0x13;

// AlgorithmIdentifier for sha256WithRSAEncryption, with the NULL parameters
// RFC 3279 requires. Constant bytes, because that is all it ever is.
const ALGORITHM_SHA256_WITH_RSA = Buffer.from([
  0x30, 0x0d,
  0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b,
  0x05, 0x00
]);

// An empty [0] attributes block. CertificationRequestInfo requires the field to
// be present even when there is nothing in it.
const EMPTY_ATTRIBUTES = Buffer.from([0xa0, 0x00]);

// Relative distinguished names, innermost first — the order a DER Name is
// written in, which is the reverse of how a DN reads as text.
const SUBJECT_OIDS = {
  CN: Buffer.from([0x55, 0x04, 0x03]),
  OU: Buffer.from([0x55, 0x04, 0x0b]),
  O:  Buffer.from([0x55, 0x04, 0x0a]),
  L:  Buffer.from([0x55, 0x04, 0x07]),
  ST: Buffer.from([0x55, 0x04, 0x08]),
  C:  Buffer.from([0x55, 0x04, 0x06])
};

function encodeName(pairs) {
  const rdns = pairs.map(([type, value]) => der(DER_SET, der(DER_SEQUENCE, Buffer.concat([
    der(DER_OID, SUBJECT_OIDS[type]),
    der(DER_PRINTABLE_STRING, Buffer.from(value, 'ascii'))
  ]))));
  return der(DER_SEQUENCE, Buffer.concat(rdns));
}

function toPem(label, body) {
  const base64 = body.toString('base64');
  const lines = base64.match(/.{1,64}/g) || [''];
  return Buffer.from(
    '-----BEGIN ' + label + '-----\n' + lines.join('\n') + '\n-----END ' + label + '-----\n',
    'utf8'
  );
}

/**
 * A PKCS#10 certificate signing request, PEM-encoded.
 *
 * The subject is the throwaway one every activation uses: Apple replaces it
 * with its own in the certificate it signs, and only the public key inside is
 * actually carried over.
 *
 * @param {{publicKeyDer: Buffer, privateKey: crypto.KeyObject}} keyPair
 * @returns {Buffer} the PEM request
 */
function generateCsr(keyPair) {
  const subject = encodeName([
    ['CN', crypto.randomUUID().toUpperCase()],
    ['OU', 'iPhone'],
    ['O',  'Apple Inc.'],
    ['L',  'Cupertino'],
    ['ST', 'CA'],
    ['C',  'US']
  ]);

  const requestInfo = der(DER_SEQUENCE, Buffer.concat([
    der(DER_INTEGER, Buffer.from([0x00])),
    subject,
    keyPair.publicKeyDer,
    EMPTY_ATTRIBUTES
  ]));

  const signature = crypto.sign('sha256', requestInfo, keyPair.privateKey);
  const request = der(DER_SEQUENCE, Buffer.concat([
    requestInfo,
    ALGORITHM_SHA256_WITH_RSA,
    // A BIT STRING's first content byte counts the unused trailing bits, which
    // for a signature is always zero.
    der(DER_BIT_STRING, Buffer.concat([Buffer.from([0x00]), signature]))
  ]));

  return toPem('CERTIFICATE REQUEST', request);
}

// ─── Activation ───────────────────────────────────────────────────────────────

function newKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: RSA_KEY_BITS
  });
  return {
    privateKey,
    publicKey,
    privateKeyDer: privateKey.export({ type: 'pkcs8', format: 'der' }),
    publicKeyDer:  publicKey.export({ type: 'spki', format: 'der' })
  };
}

// The inner plist: what this device claims to be, plus the CSR. ProductType and
// DeviceClass have to agree with the FairPlay credential above, so they say
// Windows — a desktop activation, which is what that credential is for.
function buildActivationInfo(csr) {
  return plist.writeXml({
    ActivationRandomness: crypto.randomUUID(),
    ActivationState:      'Unactivated',
    BuildVersion:         '10.6.4',
    DeviceCertRequest:    csr,
    DeviceClass:          'Windows',
    ProductType:          'windows1,1',
    ProductVersion:       '10.6.4',
    SerialNumber:         'WindowSerial',
    UniqueDeviceID:       crypto.randomUUID()
  });
}

// The outer plist: the inner one verbatim, the FairPlay chain, and a SHA-1
// signature over the inner bytes. The signature covers the bytes as sent, which
// is why the inner plist is embedded rather than rebuilt.
function buildActivationBody(activationInfo) {
  const key = crypto.createPrivateKey({
    key: FAIRPLAY_PRIVATE_KEY_PKCS1,
    format: 'der',
    type: 'pkcs1'
  });
  return plist.writeXml({
    ActivationInfoComplete: true,
    ActivationInfoXML:      activationInfo,
    FairPlayCertChain:      FAIRPLAY_CERT_CHAIN,
    FairPlaySignature:      crypto.sign('sha1', activationInfo, key)
  });
}

function httpPost(url, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const agent = proxyAgent();
    const req = https.request({
      hostname: u.hostname,
      port:     u.port || 443,
      path:     u.pathname + u.search,
      method:   'POST',
      headers:  Object.assign({ 'Content-Length': body.length }, headers),
      agent:    agent || undefined
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(HTTP_TIMEOUT_MS, () => req.destroy(new Error('timed out')));
    req.write(body);
    req.end();
  });
}

// albert answers with an HTML page that carries the plist in a <Protocol>
// element. Nothing else in the page is of any use, and the element is the only
// part with a stable shape.
const PROTOCOL_BLOCK = /<Protocol>([\s\S]+?)<\/Protocol>/;

/**
 * Pull the signed device certificate out of an activation response.
 *
 * @param {Buffer|string} responseBody  the albert response
 * @returns {Buffer} the certificate, in whatever encoding Apple used
 */
function parseActivationResponse(responseBody) {
  const text = Buffer.isBuffer(responseBody) ? responseBody.toString('utf8') : String(responseBody);
  const match = PROTOCOL_BLOCK.exec(text);
  if (!match) throw new Error('activation response carried no <Protocol> block');

  const record = plist.parse(Buffer.from(match[1], 'utf8'));
  const certificate = record
    && record['device-activation']
    && record['device-activation']['activation-record']
    && record['device-activation']['activation-record'].DeviceCertificate;

  if (!Buffer.isBuffer(certificate) || certificate.length === 0) {
    throw new Error('activation record carried no DeviceCertificate');
  }
  return certificate;
}

/**
 * Run the activation handshake and return the credentials it produces.
 *
 * Throws on failure; the fail-soft boundary is getPushToken, so that the two
 * callers below can tell an activation refusal from a courier one in the log.
 *
 * @returns {Promise<{privateKeyDer: Buffer, publicKeyDer: Buffer, deviceCertificate: Buffer}>}
 */
async function activate() {
  const keyPair = newKeyPair();
  const activationInfo = buildActivationInfo(generateCsr(keyPair));
  const body = Buffer.from(
    'device=Windows&activation-info=' + encodeURIComponent(buildActivationBody(activationInfo).toString('utf8')),
    'utf8'
  );

  const res = await httpPost(ACTIVATION_URL, body, {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent':   'iTunes/10.6.4 (Windows; Microsoft Windows 7 x64 Business Edition (Build 7601)) AppleWebKit/534.54.16',
    'Accept':       '*/*'
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error('activation HTTP ' + res.status + ': ' + res.body.toString('utf8').slice(0, 200));
  }

  return {
    privateKeyDer:     keyPair.privateKeyDer,
    publicKeyDer:      keyPair.publicKeyDer,
    deviceCertificate: parseActivationResponse(res.body)
  };
}

// ─── Session, as it lives on the store ────────────────────────────────────────
//
// The store is JSON on disk, so everything here is base64 or hex text. The
// device identity — keypair and certificate — is the valuable part: it is what
// makes the same push token come back on the next run, and losing it means a
// token WhatsApp already recorded stops being deliverable.

function encodeSession(session) {
  return {
    privateKeyDer:     session.privateKeyDer.toString('base64'),
    publicKeyDer:      session.publicKeyDer.toString('base64'),
    deviceCertificate: session.deviceCertificate.toString('base64'),
    deviceToken:       session.deviceToken ? session.deviceToken.toString('hex') : null
  };
}

function decodeSession(saved) {
  if (!saved || !saved.privateKeyDer || !saved.publicKeyDer || !saved.deviceCertificate) return null;
  try {
    return {
      privateKeyDer:     Buffer.from(saved.privateKeyDer, 'base64'),
      publicKeyDer:      Buffer.from(saved.publicKeyDer, 'base64'),
      deviceCertificate: Buffer.from(saved.deviceCertificate, 'base64'),
      deviceToken:       saved.deviceToken ? Buffer.from(saved.deviceToken, 'hex') : null
    };
  } catch (_) {
    return null;
  }
}

/** The bundle ids for this device profile. Business ships under its own. */
function configFor(device) {
  return (device && device.business) ? APNS_CONFIG.business : APNS_CONFIG.personal;
}

/**
 * The stored push token, but only if it belongs to the topic being asked for.
 *
 * A token is issued per bundle id, so the one cached for the consumer app does
 * not address the Business one. Returning it anyway would send WhatsApp a token
 * for an install that is not the one registering.
 *
 * @param {object} store
 * @param {string} topic
 * @returns {string|null}
 */
function cachedToken(store, topic) {
  const saved = store && store.apns;
  return saved && saved.token && saved.topic === topic ? saved.token : null;
}

/**
 * The activation credentials for this account, running the handshake only if
 * none are stored yet.
 *
 * @param {object} store   the account store; the session lives on store.apns
 * @returns {Promise<object>} the decoded session
 */
async function ensureSession(store) {
  const existing = decodeSession(store.apns);
  if (existing) {
    _whaDbg('[DBG] APNs activation restored from the store');
    return existing;
  }

  _whaDbg('[DBG] APNs activating with Apple (once per account)');
  const session = await activate();
  store.apns = Object.assign({}, store.apns, encodeSession(session));
  _whaDbg('[DBG] APNs activation complete, certificate ' + session.deviceCertificate.length + ' B');
  return session;
}

/** Whether push over APNs is switched on. Opt out with WA_APNS_PUSH=0. */
function enabled() {
  const v = process.env.WA_APNS_PUSH;
  return v === undefined || !(v === '0' || v.toLowerCase() === 'false' || v === 'off');
}

// ─── Public entry points ──────────────────────────────────────────────────────

/**
 * The APNs push token for this account, or null.
 *
 * Mirrors lib/fcm.getPushToken in every way that matters: cached on the store,
 * never throws, and null means "send no push_token" rather than "registration
 * failed".
 *
 * @param {object} store   the account store; the session is cached on store.apns
 * @param {object} device  device config; device.business picks the SMB bundle
 * @returns {Promise<string|null>}
 */
async function getPushToken(store, device) {
  if (!enabled()) return null;
  if (!store) return null;

  const config = configFor(device);
  const topic = config.topics[0];

  const cached = cachedToken(store, topic);
  if (cached) {
    _whaDbg('[DBG] APNs push token from cache, length=' + cached.length);
    return cached;
  }

  let connection = null;
  try {
    const session = await ensureSession(store);
    connection = new ApnsCourierConnection(session, { topics: config.topics });
    await connection.connect();

    const token = await connection.requestToken(topic);
    store.apns = Object.assign({}, store.apns, {
      deviceToken: connection.deviceToken ? connection.deviceToken.toString('hex') : null,
      token,
      topic
    });
    _whaDbg('[DBG] APNs push token acquired, length=' + token.length);
    return token;
  } catch (err) {
    _whaDbg('[DBG] APNs push token unavailable: ' + (err && err.message) +
      ' — registering without one');
    return null;
  } finally {
    if (connection) connection.close();
  }
}

/**
 * Open the courier and resolve with the verification code the moment its silent
 * push arrives — or null on timeout or any failure. Never throws.
 *
 * The connection has to exist before /code is sent, or the push arrives with
 * nowhere to land; callers open this first and request the code once `onReady`
 * has fired. Same contract as lib/fcm.receivePushCode, so the CLI and the
 * public API drive either platform the same way.
 *
 * @param {object} store    the account store; the session is on store.apns
 * @param {object} device   device config
 * @param {object} [opts]   { timeoutMs=180000, onReady, signal }
 * @returns {Promise<string|null>}
 */
async function receivePushCode(store, device, opts) {
  opts = opts || {};
  if (!enabled() || !store) return null;

  const timeoutMs = opts.timeoutMs > 0 ? opts.timeoutMs : 180000;
  const config = configFor(device);

  // The token has to exist first: it is what WhatsApp addresses the push to, so
  // listening without having handed one over waits for a push nobody will send.
  if (!store.apns || !store.apns.token) {
    await getPushToken(store, device);
  }

  let session;
  try {
    session = await ensureSession(store);
  } catch (err) {
    _whaDbg('[DBG] APNs no activation for the courier: ' + (err && err.message));
    return null;
  }
  if (store.apns && store.apns.deviceToken) {
    session.deviceToken = Buffer.from(store.apns.deviceToken, 'hex');
  }

  return new Promise((resolve) => {
    let settled = false;
    let connection = null;
    let deadline = null;

    const finish = (code) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      if (connection) connection.close();
      resolve(code);
    };

    deadline = setTimeout(() => {
      _whaDbg('[DBG] APNs timed out after ' + timeoutMs + 'ms');
      finish(null);
    }, timeoutMs);
    if (deadline.unref) deadline.unref();

    if (opts.signal) {
      if (opts.signal.aborted) return finish(null);
      opts.signal.addEventListener('abort', () => finish(null), { once: true });
    }

    connection = new ApnsCourierConnection(session, {
      topics: config.topics,
      onNotification: (packet) => {
        const code = extractRegCode(packet);
        if (code) {
          _whaDbg('[DBG] APNs push code received');
          finish(code);
        }
      },
      // The line going down is an answer, and a faster one than the timeout:
      // the caller can stop waiting and read the code the ordinary way.
      onLost: () => finish(null)
    });

    connection.connect().then(() => {
      // The device token can be reissued; whatever this connection ended up
      // with is the one the next run has to present. When it did change, the
      // cached push_token was derived from the old one and addresses nothing —
      // dropping it makes the next registration fetch a token that works.
      store.apns = Object.assign({}, store.apns, {
        deviceToken: connection.deviceToken ? connection.deviceToken.toString('hex') : null
      });
      if (connection.tokenReissued) {
        store.apns = Object.assign({}, store.apns, { token: null, topic: null });
      }
      _whaDbg('[DBG] APNs courier listening for the verification push');
      if (typeof opts.onReady === 'function') {
        try { opts.onReady(); } catch (_) {}
      }
    }).catch(err => {
      _whaDbg('[DBG] APNs courier unavailable: ' + (err && err.message));
      finish(null);
    });
  });
}

module.exports = {
  getPushToken,
  receivePushCode,
  enabled,
  APNS_CONFIG,
  // exported for tests
  activate,
  ensureSession,
  configFor,
  cachedToken,
  generateCsr,
  newKeyPair,
  buildActivationInfo,
  buildActivationBody,
  parseActivationResponse,
  encodeSession,
  decodeSession,
  FAIRPLAY_CERT_CHAIN,
  FAIRPLAY_PRIVATE_KEY_PKCS1
};
