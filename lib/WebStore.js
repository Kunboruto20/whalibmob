'use strict';

// Session state for a WhatsApp Web (companion) link.
//
// Deliberately the same shape as the mobile store: SignalProtocol,
// DeviceManager and MessageSender all read `noiseKeyPair`, `identityKeyPair`,
// `signedPreKey`, `registrationId` and `advIdentity` off it, and none of them
// should have to care which way the session was established. What web mode adds
// on top is the pairing material and the identity the server hands back:
//
//   advSecretKey            derived during pairing; every later proof that this
//                           device belongs to the account is an HMAC under it
//   pairingEphemeralKeyPair one half of the code-authenticated exchange
//   pairingCode             the eight characters shown to the human
//   me                      { id, lid, name } — the JID we were issued
//   deviceIndex             which linked-device slot we occupy; 0 is the phone
//
// Stored beside the mobile session as `<phone>.web.json`, so registering a
// number over SMS and linking it as a companion never overwrite each other.

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');

const { createNewStore, storeToJson, storeFromJson } = require('./Store');
const { WEB_VERSION_FALLBACK, WEB_BROWSER } = require('./constants');
const { generateEphemeralKeyPair } = require('./PairingCode');

function webSessionPath(sessionDir, phoneNumber) {
  return path.join(sessionDir, `${String(phoneNumber).replace(/\D/g, '')}.web.json`);
}

function createNewWebStore(phoneNumber) {
  const store = createNewStore(phoneNumber);

  store.mode                    = 'web';
  store.registered              = false;
  store.advSecretKey            = null;
  store.pairingCode             = null;
  store.pairingEphemeralKeyPair = generateEphemeralKeyPair();
  store.me                      = null;
  store.deviceIndex             = 0;
  store.platform                = null;
  store.webVersion              = WEB_VERSION_FALLBACK.slice();
  store.browser                 = WEB_BROWSER.slice();
  store.syncFullHistory         = true;

  return store;
}

function webStoreToJson(store) {
  const base = storeToJson(store);
  return Object.assign(base, {
    mode:        'web',
    advSecretKey: store.advSecretKey || null,
    pairingCode:  store.pairingCode  || null,
    pairingEphemeralKeyPair: store.pairingEphemeralKeyPair ? {
      private: store.pairingEphemeralKeyPair.private.toString('base64'),
      public:  store.pairingEphemeralKeyPair.public.toString('base64')
    } : null,
    me:          store.me          || null,
    deviceIndex: store.deviceIndex || 0,
    platform:    store.platform    || null,
    webVersion:  store.webVersion  || WEB_VERSION_FALLBACK.slice(),
    browser:     store.browser     || WEB_BROWSER.slice(),
    syncFullHistory: store.syncFullHistory !== false,
    // The NCT salt (base64) a cstoken is derived from, received over app state.
    nctSalt:     store.nctSalt     || null
  });
}

function webStoreFromJson(obj) {
  const store = storeFromJson(obj);

  store.mode         = 'web';
  store.advSecretKey = obj.advSecretKey || null;
  store.pairingCode  = obj.pairingCode  || null;
  store.pairingEphemeralKeyPair = obj.pairingEphemeralKeyPair
    ? {
        private: Buffer.from(obj.pairingEphemeralKeyPair.private, 'base64'),
        public:  Buffer.from(obj.pairingEphemeralKeyPair.public, 'base64')
      }
    // A store written before this field existed still needs a usable key pair;
    // it is only ever consumed inside a single pairing attempt.
    : generateEphemeralKeyPair();
  store.me          = obj.me          || null;
  store.deviceIndex = obj.deviceIndex || 0;
  store.platform    = obj.platform    || null;
  store.webVersion  = obj.webVersion  || WEB_VERSION_FALLBACK.slice();
  store.browser     = obj.browser     || WEB_BROWSER.slice();
  store.syncFullHistory = obj.syncFullHistory !== false;
  store.nctSalt     = obj.nctSalt     || null;

  return store;
}

function saveWebStore(store, filePath) {
  if (!store) return;
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(webStoreToJson(store), null, 2), 'utf8');
}

function loadWebStore(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return webStoreFromJson(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (_) {
    return null;
  }
}

module.exports = {
  createNewWebStore,
  saveWebStore,
  loadWebStore,
  webStoreToJson,
  webStoreFromJson,
  webSessionPath
};
