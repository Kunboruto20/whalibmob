'use strict';

const { WhalibmobClient, checkNumberStatus, fetchIosVersion, fetchWaVersion, assertRegistrationKeys } = require('./lib/Client');
const { getDeviceConfig } = require('./lib/DeviceConfig');
const { fetchAndroidVersion } = require('./lib/Registration');
const { createNewStore, saveStore, loadStore, toSixParts, fromSixParts, storeToJson, storeFromJson } = require('./lib/Store');
const { checkIfRegistered, requestSmsCode, verifyCode } = require('./lib/Registration');
const { SignalProtocol } = require('./lib/signal/SignalProtocol');
const { SignalStore } = require('./lib/signal/SignalStore');
const { SenderKeyStore, SenderKeyCrypto } = require('./lib/signal/SenderKey');
const { DeviceManager } = require('./lib/DeviceManager');
const { encryptMedia, decryptMedia, uploadMedia, downloadMedia } = require('./lib/MediaService');
const { MessageSender, makeJid, generateMessageId } = require('./lib/messages/MessageSender');
const { FridaAttestor, getAttestorFromEnv } = require('./lib/AttestationClient');

module.exports = {
  WhalibmobClient,
  checkNumberStatus,
  checkIfRegistered,
  requestSmsCode,
  verifyCode,
  assertRegistrationKeys,
  // Version fetch — use fetchWaVersion for device-aware (iOS or Android) fetching.
  // fetchIosVersion is kept for backward compatibility.
  fetchWaVersion,
  fetchIosVersion,
  fetchAndroidVersion,
  // Device config — reads WA_OS / WA_DEVICE / WA_DEVICE_* from process.env
  getDeviceConfig,
  // Store helpers
  createNewStore,
  saveStore,
  loadStore,
  storeToJson,
  storeFromJson,
  toSixParts,
  fromSixParts,
  // Signal / encryption internals
  SignalProtocol,
  SignalStore,
  SenderKeyStore,
  SenderKeyCrypto,
  DeviceManager,
  // Media
  encryptMedia,
  decryptMedia,
  uploadMedia,
  downloadMedia,
  // Message helpers
  MessageSender,
  makeJid,
  generateMessageId,
  // Device attestation (Frida middleware in ./frida) — see frida/README.md.
  // Enable with WA_FRIDA_ATTESTATION=1 to attach Play Integrity / App Attest
  // tokens to registration requests, matching a genuine device.
  FridaAttestor,
  getAttestorFromEnv
};
