'use strict';

// ─── Push clients ─────────────────────────────────────────────────────────────
//
// Every real WhatsApp install can be woken by the server, and which line it is
// woken on follows from the platform it runs on. An Android install holds a
// Firebase token and keeps an MCS stream open to Google. An iOS install holds
// an APNs token and keeps a courier stream open to Apple. The two are not
// interchangeable, and the registration server sees both halves: the push token
// in the body, and the User-Agent that says which platform sent it. An iPhone
// presenting a Firebase token describes a device that does not exist.
//
// This module is the seam. `pushClientFor(device)` returns the client that
// matches the device profile, so no caller has to reach for a transport by
// name. Two implementations exist today:
//
//   android → ./fcm  (checkin → FIS install → register3, then MCS for the code)
//   ios     → NONE   (APNs is not implemented; every push field is omitted)
//
// The NONE client is not a failure path — it is the correct answer for a
// platform we cannot speak push for. It supplies nothing, `buildForm` drops the
// null, and the registration body goes out without a push token rather than
// with somebody else's.

const { dbg: _whaDbg } = require('./logger');

/**
 * The push client for a platform we have no transport for.
 *
 * Supplies nothing and never performs I/O. Registration proceeds without any
 * push field, which is what an install with no push line should send.
 */
const NONE_PUSH_CLIENT = {
  platform: 'none',
  supportsPush: false,

  async getPushToken() {
    return null;
  },

  async receivePushCode() {
    return null;
  }
};

/**
 * The push client backed by Firebase Cloud Messaging, for Android profiles.
 *
 * Delegates to ./fcm, which owns the Google handshake and the MCS stream. The
 * requires are lazy so that loading this module does not pull in the whole FCM
 * stack for a session that never registers.
 */
const FCM_PUSH_CLIENT = {
  platform: 'android',
  supportsPush: true,

  async getPushToken(store, device) {
    return require('./fcm').getPushToken(store, device);
  },

  async receivePushCode(store, device, opts) {
    return require('./fcm').receivePushCode(store, device, opts);
  }
};

/**
 * The push client matching a device profile.
 *
 * Android profiles get the Firebase client; everything else gets NONE. The
 * choice is made on the device rather than on a global setting, because a
 * process can register an Android session and an iOS session in turn and each
 * has to present its own platform's push line — or none at all.
 *
 * @param {object} device  a device config; only `device.os` is read
 * @returns {{platform: string, supportsPush: boolean,
 *            getPushToken: function, receivePushCode: function}}
 */
function pushClientFor(device) {
  if (device && device.os === 'android') return FCM_PUSH_CLIENT;

  if (device && device.os) {
    _whaDbg('[DBG] no push transport for ' + device.os + ' — push fields omitted');
  }
  return NONE_PUSH_CLIENT;
}

/**
 * Whether this device profile can send and receive push at all.
 *
 * Callers that want to offer push verification check this first, so they can
 * say why it is unavailable instead of opening a listener that nothing will
 * ever reach.
 *
 * @param {object} device  a device config; only `device.os` is read
 * @returns {boolean}
 */
function supportsPush(device) {
  return pushClientFor(device).supportsPush;
}

module.exports = {
  pushClientFor,
  supportsPush,
  NONE_PUSH_CLIENT,
  FCM_PUSH_CLIENT
};
