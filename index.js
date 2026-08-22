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

// ─── Everything below is bound to a name before it is exported ───────────────
//
// Not for tidiness. Node reads a CommonJS module's names statically when
// something imports it as ESM, and the reader it uses gives up at the first
// property of module.exports whose value is not a plain identifier. There used
// to be an arrow function five entries in, and everything after it — a hundred
// and sixteen of the hundred and twenty-one names — could not be imported by
// name at all:
//
//   import { createNewStore } from 'whalibmob'
//   SyntaxError: Named export 'createNewStore' not found.
//
// The default import always worked and still does, so this broke no CommonJS
// caller and no `import wa from 'whalibmob'`. It broke `import { … }`, which is
// how a bot written as an ES module reaches for anything.
//
// So: functions defined here get a name first, member accesses get a name
// first, and the modules below get a name first. The object at the bottom is
// nothing but identifiers, and test/public-surface.test.js fails if any name
// stops being importable that way.

// Receive the verification code as a silent push, without an SMS — opens the
// listener the native client of that platform keeps open. See "Receiving the
// code over push" in the README.
//
// Routed through the push client for the device's platform: Android opens the
// Firebase MCS stream, iOS resolves null because APNs is not implemented and
// an iOS session holds no Firebase identity to listen with.
const receivePushCode = (store, device, opts) => {
  const dev = device || (store && store.device);
  return require('./lib/PushClient')
    .pushClientFor(dev)
    .receivePushCode(store, dev, opts);
};

// Whether the device profile can do push verification at all.
const supportsPush = (device) => require('./lib/PushClient').supportsPush(device);

// Where a session's files live: one folder per number inside the
// authentication folder. The same resolver the CLI uses.
const {
  defaultBaseDir, sessionDirFor, storeFileFor, webStoreFileFor,
  listSessions, migrateSession
} = SessionPaths;

const { encodeWAM, BinaryInfo, WEB_EVENTS, WEB_GLOBALS } = WAM;

// ─── The namespaces ──────────────────────────────────────────────────────────
//
// Every module of lib/, whole, under a name of its own — see the note at the
// foot of module.exports for what the names mean and why they are these.

const Client           = require('./lib/Client');
const Registration     = require('./lib/Registration');
const Store            = require('./lib/Store');
const WebStore         = require('./lib/WebStore');
const DeviceConfig     = require('./lib/DeviceConfig');
const Devices          = require('./lib/DeviceManager');
const PlayStore        = require('./lib/PlayStore');
const PlayStoreDevice  = require('./lib/playstore-device');
const AndroidApk       = require('./lib/AndroidApk');
const Attestation      = require('./lib/Attestation');
const Tokens           = require('./lib/tokens');
const PushClient       = require('./lib/PushClient');
const Fcm              = require('./lib/fcm');
const FcmMcs           = require('./lib/fcm-mcs');

const PairingCode      = require('./lib/PairingCode');
const CompanionPairing = require('./lib/CompanionPairing');
const QrPairing        = require('./lib/QrPairing');
const WebVersion       = require('./lib/WebVersion');
const WebProto         = require('./lib/webproto');

const BinaryNode           = require('./lib/BinaryNode');
const Noise                = require('./lib/noise');
const WebSocketStream      = require('./lib/WebSocketStream');
const Socks                = require('./lib/socks');
const OfflineNodeProcessor = require('./lib/OfflineNodeProcessor');
const Constants            = require('./lib/constants');
const Logger               = require('./lib/logger');
// lib/proto.js — the handshake payloads. The message protobufs are the
// directory of the same name, and are MessageProto.
const Proto                = require('./lib/proto.js');

const MessageProto     = require('./lib/proto/MessageProto');
const MediaService     = require('./lib/MediaService');
const MediaThumbnail   = require('./lib/MediaThumbnail');
const GroupParticipant = require('./lib/GroupParticipant');

const Messages = {
  MessageSender:  require('./lib/messages/MessageSender'),
  MediaRetry:     require('./lib/messages/MediaRetry'),
  ReportingToken: require('./lib/messages/ReportingToken'),
  TcTokenStore:   require('./lib/messages/TcTokenStore')
};

// The decoders behind the inline thumbnails, and the encoder that makes them.
// lib/image/index.js is the whole story for most callers; the per-format
// modules are here for the rest.
const Image = Object.assign({}, require('./lib/image'), {
  Jpeg:        require('./lib/image/Jpeg'),
  JpegEncoder: require('./lib/image/JpegEncoder'),
  Png:         require('./lib/image/Png'),
  Gif:         require('./lib/image/Gif'),
  Bmp:         require('./lib/image/Bmp')
});

const HistorySyncHandler = require('./lib/HistorySyncHandler');
const AuthUtils          = require('./lib/auth-utils');
const Argo               = require('./lib/argo/ArgoDecoder');
const WAUSync            = require('./lib/WAUSync');

// Signal — lib/signal/. SignalProtocol.js, SignalStore.js and SenderKey.js have
// no name in common, so the three are one namespace. The two vendored libraries
// keep theirs, being libraries.
const Signal = Object.assign({},
  require('./lib/signal/SignalProtocol'),
  require('./lib/signal/SignalStore'),
  require('./lib/signal/SenderKey'),
  {
    WaSignalGroup: require('./lib/signal/WaSignalGroup'),
    // libsignal's own barrel leaves six of its modules out. They are added to a
    // copy of it here rather than written into it, so
    // require('whalibmob/lib/signal/libsignal') stays exactly what it was.
    libsignal: Object.assign({}, require('./lib/signal/libsignal'), {
      BaseKeyType: require('./lib/signal/libsignal/base_key_type'),
      ChainType:   require('./lib/signal/libsignal/chain_type'),
      protobufs:   require('./lib/signal/libsignal/protobufs'),
      queueJob:    require('./lib/signal/libsignal/queue_job'),
      FingerprintGenerator:
        require('./lib/signal/libsignal/numeric_fingerprint').FingerprintGenerator,
      textsecure:
        require('./lib/signal/libsignal/WhisperTextProtocol').textsecure
    })
  });

// App state — lib/appstate/. AppStateStore.js is spread because the flat
// AppStateStore is its class; the other three are whole.
const AppState = Object.assign({}, require('./lib/appstate/AppStateStore'), {
  AppStateSync: require('./lib/appstate/AppStateSync'),
  LTHash:       require('./lib/appstate/LTHash'),
  Mutations:    require('./lib/appstate/Mutations'),
  SyncdProto:   require('./lib/appstate/SyncdProto')
});

module.exports = {
  WhalibmobClient,
  checkNumberStatus,
  checkIfRegistered,
  requestSmsCode,
  verifyCode,
  receivePushCode,
  supportsPush,
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
  defaultBaseDir,
  sessionDirFor,
  storeFileFor,
  webStoreFileFor,
  listSessions,
  migrateSession,
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
  encodeWAM,
  BinaryInfo,
  WEB_EVENTS,
  WEB_GLOBALS,
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
  HistorySyncTypeName,

  // ─── Namespaces ────────────────────────────────────────────────────────────
  //
  // Everything above is a name picked out of a module by hand — eighty-two of
  // the four hundred and ninety-five the library actually has. What follows is
  // the rest: every module, whole, under a name of its own. Nothing above is
  // renamed, moved or removed by any of it.
  //
  // The rule is that a namespace is named after the module it comes from, and a
  // directory in lib/ becomes one namespace rather than several. Two names
  // could not be had: Devices is lib/DeviceManager.js, because the flat export
  // of that name is the class rather than the module, and Proto is lib/proto.js,
  // because lib/proto/ would want the same name and is MessageProto.
  //
  // Most are the very object a deep require returns —
  // wa.MediaService === require('whalibmob/lib/MediaService') — which is worth
  // knowing because deep requires work and always have: the package declares no
  // `exports` map, so nothing here is the only way in. The four built with
  // Object.assign (Signal, AppState, Image, Signal.libsignal) are new objects
  // holding the same functions, gathered from the several modules of a
  // directory. Nothing is copied out of a module and nothing is written back
  // into one.
  //
  // test/public-surface.test.js walks lib/ and fails if any module has an
  // export that none of this reaches, so the coverage is checked rather than
  // claimed.

  // Registration, sessions and the device a session presents itself as
  Client,
  Registration,
  Store,
  WebStore,
  DeviceConfig,
  Devices,
  PlayStore,
  PlayStoreDevice,
  AndroidApk,
  Attestation,
  Tokens,
  PushClient,
  Fcm,
  FcmMcs,

  // Linking to an account that already exists
  PairingCode,
  CompanionPairing,
  QrPairing,
  WebVersion,
  WebProto,

  // The wire
  BinaryNode,
  Noise,
  WebSocketStream,
  Socks,
  OfflineNodeProcessor,
  Constants,
  Logger,
  Proto,

  // Messages and media
  MessageProto,
  Messages,
  MediaService,
  MediaThumbnail,
  GroupParticipant,
  Image,

  HistorySyncHandler,
  AuthUtils,
  Argo,
  WAUSync,
  Signal,
  AppState
};
