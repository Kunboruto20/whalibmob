'use strict';

const { WhalibmobClient, checkNumberStatus, fetchIosVersion, fetchWaVersion, assertRegistrationKeys } = require('./lib/Client');
const { getDeviceConfig } = require('./lib/DeviceConfig');
const { fetchAndroidVersion, currentVersionFor, refreshSessionVersion } = require('./lib/Registration');
const SessionPaths = require('./lib/SessionPaths');
const { createNewStore, saveStore, loadStore, toSixParts, fromSixParts, storeToJson, storeFromJson } = require('./lib/Store');
const { checkIfRegistered, requestSmsCode, verifyCode } = require('./lib/Registration');
const { SignalProtocol } = require('./lib/signal/SignalProtocol');
const WAM = require('./lib/WAM');
const { SignalStore } = require('./lib/signal/SignalStore');
const { SenderKeyStore, SenderKeyCrypto } = require('./lib/signal/SenderKey');
const { DeviceManager } = require('./lib/DeviceManager');
const { encryptMedia, decryptMedia, uploadMedia, downloadMedia } = require('./lib/MediaService');
const { MessageSender, makeJid, generateMessageId } = require('./lib/messages/MessageSender');
const { GroupParticipantResult, GroupJoinRequest } = require('./lib/GroupParticipant');
const { AppStateStore, COLLECTIONS: APP_STATE_COLLECTIONS } = require('./lib/appstate/AppStateStore');
const ReachoutTimelock = require('./lib/ReachoutTimelock');
const { decodeArgo, tryDecodeArgo } = require('./lib/argo/ArgoDecoder');
const AppStateSync = require('./lib/appstate/AppStateSync');
const { PATCH_INTEGRITY: LT_HASH } = require('./lib/appstate/LTHash');
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
  // What a device profile should be announcing now, and writing it into a
  // session that registered long enough ago to have gone stale.
  currentVersionFor,
  refreshSessionVersion,
  // Where a session's files live: one folder per number inside the
  // authentication folder. The same resolver the CLI uses.
  SessionPaths,
  defaultBaseDir:  SessionPaths.defaultBaseDir,
  sessionDirFor:   SessionPaths.sessionDirFor,
  storeFileFor:    SessionPaths.storeFileFor,
  webStoreFileFor: SessionPaths.webStoreFileFor,
  listSessions:    SessionPaths.listSessions,
  migrateSession:  SessionPaths.migrateSession,
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
  // WAM — the web client's stats channel: the event/global tables, the binary
  // encoder and the BinaryInfo holder, all as the reference client defines
  // them. See client.wamBuffer / client.sendWAMBuffer().
  WAM,
  encodeWAM:  WAM.encodeWAM,
  BinaryInfo: WAM.BinaryInfo,
  WEB_EVENTS: WAM.WEB_EVENTS,
  WEB_GLOBALS: WAM.WEB_GLOBALS,
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
  // Group results
  GroupParticipantResult,
  GroupJoinRequest,
  // App state
  AppStateStore,
  AppStateSync,
  APP_STATE_COLLECTIONS,
  LT_HASH,
  // Account restriction
  ReachoutTimelock,
  // Argo (the binary encoding the GraphQL transport may answer in)
  decodeArgo,
  tryDecodeArgo,
  // Auth utilities
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
