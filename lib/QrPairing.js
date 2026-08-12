'use strict';

// QR-code companion login, the scan-to-connect alternative to the pairing code.
//
// Both paths link the same way — as a companion device on the web transport —
// and diverge only in how the primary phone is told to trust this client:
//
//   pairing code   the client asks for an 8-character code, the user types it
//                  into WhatsApp → Linked devices → Link with phone number
//   QR code        the server volunteers a set of refs, the client renders one
//                  as a QR, the user points the phone's camera at it
//
// The QR is a short string the WhatsApp camera reads. It carries everything the
// phone needs to authorise this device: a one-time ref, this client's public
// noise and identity keys, and the adv secret it will sign the account proof
// with. The phone does the linking; the client only has to present the string.
//
// The wire format is the one the native web client and every maintained web
// library produce:
//
//   ref,<noise pub b64>,<identity pub b64>,<adv secret b64>,<platform id>
//
// The platform id is the companion "web client type": Chrome is 1, Edge 2,
// Firefox 3, and so on. WhatsApp Web itself renders exactly these comma-joined
// fields, so that is the default; some clients wrap them in a
// wa.me/settings/linked_devices# link, which is offered as an option.

// Companion web-client type, keyed by browser name. Matches the ids the phone
// expects; anything unknown is "other web client".
const COMPANION_WEB_CLIENT = {
  CHROME: 1, EDGE: 2, FIREFOX: 3, IE: 4, OPERA: 5, SAFARI: 6,
  ELECTRON: 7, UWP: 8, OTHER: 9
};

// A [os, browserName] description → the numeric platform id in the QR.
function companionPlatformId(browser) {
  const os   = browser && browser[0];
  const name = String((browser && browser[1]) || 'Chrome');
  if (name === 'Desktop') return os === 'Windows' ? COMPANION_WEB_CLIENT.UWP : COMPANION_WEB_CLIENT.ELECTRON;
  const key = name.toUpperCase();
  return COMPANION_WEB_CLIENT[key] !== undefined ? COMPANION_WEB_CLIENT[key] : COMPANION_WEB_CLIENT.OTHER;
}

/**
 * Build the string a WhatsApp camera scans to link this device.
 *
 * @param {string} ref            one ref from the server's pair-device node
 * @param {string} noisePubB64    base64 of the 32-byte noise public key
 * @param {string} identityPubB64 base64 of the 32-byte signed-identity public key
 * @param {string} advB64         base64 of the 32-byte adv secret
 * @param {Array}  browser        [os, browserName, version]
 * @param {object} [opts]         { wrap } — prefix the wa.me linked-devices URL
 * @returns {string}
 */
function buildQrData(ref, noisePubB64, identityPubB64, advB64, browser, opts) {
  const fields = [ref, noisePubB64, identityPubB64, advB64, String(companionPlatformId(browser))].join(',');
  return (opts && opts.wrap) ? 'https://wa.me/settings/linked_devices#' + fields : fields;
}

module.exports = { buildQrData, companionPlatformId, COMPANION_WEB_CLIENT };
