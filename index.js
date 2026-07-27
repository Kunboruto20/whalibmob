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
const {
  makeCacheableSignalKeyStore,
  addTransactionCapability,
  assertMeId,
  initAuthCreds
} = require('./lib/auth-utils');
const {
  createNewWebStore, saveWebStore, loadWebStore, webSessionPath
} = require('./lib/WebStore');
const {
  generatePairingCode,
  derivePairingCodeKey,
  buildWrappedEphemeralPub,
  decipherLinkPublicKey,
  buildCompanionFinishBundle
} = require('./lib/PairingCode');
const { configureSuccessfulPairing } = require('./lib/CompanionPairing');
const { fetchWaWebVersion } = require('./lib/WebVersion');
const {
  encodeCompanionRegisterPayload,
  encodeCompanionLoginPayload
} = require('./lib/webproto');
const {
  processHistorySyncNotification,
  decodeHistorySyncNotification,
  decodeHistorySync,
  decodeAppStateSyncKeyShare,
  saveAppStateSyncKeys,
  loadAppStateSyncKeys,
  mergeHistoryToStore,
  decryptHistoryBlob,
  deriveHistoryKeys,
  HistorySyncType,
  HistorySyncTypeName
} = require('./lib/HistorySyncHandler');

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
  // WhatsApp Web (companion) mode — pairing-code linking to an existing account
  createNewWebStore,
  saveWebStore,
  loadWebStore,
  webSessionPath,
  generatePairingCode,
  derivePairingCodeKey,
  buildWrappedEphemeralPub,
  decipherLinkPublicKey,
  buildCompanionFinishBundle,
  configureSuccessfulPairing,
  encodeCompanionRegisterPayload,
  encodeCompanionLoginPayload,
  fetchWaWebVersion,
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
  // Auth utilities (mirrors Baileys' auth-utils)
  makeCacheableSignalKeyStore,
  addTransactionCapability,
  assertMeId,
  initAuthCreds,
  // History sync
  processHistorySyncNotification,
  decodeHistorySyncNotification,
  decodeHistorySync,
  decodeAppStateSyncKeyShare,
  saveAppStateSyncKeys,
  loadAppStateSyncKeys,
  mergeHistoryToStore,
  decryptHistoryBlob,
  deriveHistoryKeys,
  HistorySyncType,
  HistorySyncTypeName
};
