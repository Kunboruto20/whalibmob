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
  // Receive the verification code as a silent push, without an SMS — opens the
  // listener the native client of that platform keeps open. See "Receiving the
  // code over push" in the README.
  //
  // Routed through the push client for the device's platform: Android opens the
  // Firebase MCS stream, iOS resolves null because APNs is not implemented and
  // an iOS session holds no Firebase identity to listen with.
  receivePushCode: (store, device, opts) => {
    const dev = device || (store && store.device);
    return require('./lib/PushClient')
      .pushClientFor(dev)
      .receivePushCode(store, dev, opts);
  },
  // Whether the device profile can do push verification at all.
  supportsPush: (device) => require('./lib/PushClient').supportsPush(device),
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
  // could not be had and say so where they appear: DeviceManager, because the
  // flat export of that name is the class rather than the module, and Proto,
  // because lib/proto.js and lib/proto/ would both want it.
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
  Client:           require('./lib/Client'),
  Registration:     require('./lib/Registration'),
  Store:            require('./lib/Store'),
  WebStore:         require('./lib/WebStore'),
  DeviceConfig:     require('./lib/DeviceConfig'),
  // The flat DeviceManager is the class. This is the module it comes from, so
  // the JID helpers beside it — makeDeviceJid, phoneFromJid, jidStrToObj —
  // have somewhere to be reached from.
  Devices:          require('./lib/DeviceManager'),
  PlayStore:        require('./lib/PlayStore'),
  PlayStoreDevice:  require('./lib/playstore-device'),
  AndroidApk:       require('./lib/AndroidApk'),
  Attestation:      require('./lib/Attestation'),
  Tokens:           require('./lib/tokens'),
  PushClient:       require('./lib/PushClient'),
  Fcm:              require('./lib/fcm'),
  FcmMcs:           require('./lib/fcm-mcs'),

  // Linking to an account that already exists
  PairingCode:      require('./lib/PairingCode'),
  CompanionPairing: require('./lib/CompanionPairing'),
  QrPairing:        require('./lib/QrPairing'),
  WebVersion:       require('./lib/WebVersion'),
  WebProto:         require('./lib/webproto'),

  // The wire
  BinaryNode:           require('./lib/BinaryNode'),
  Noise:                require('./lib/noise'),
  WebSocketStream:      require('./lib/WebSocketStream'),
  Socks:                require('./lib/socks'),
  OfflineNodeProcessor: require('./lib/OfflineNodeProcessor'),
  Constants:            require('./lib/constants'),
  Logger:               require('./lib/logger'),
  // lib/proto.js — the handshake payloads. The message protobufs are the
  // directory of the same name, and are MessageProto below.
  Proto:                require('./lib/proto.js'),

  // Messages and media
  MessageProto:   require('./lib/proto/MessageProto'),
  Messages: {
    MessageSender:  require('./lib/messages/MessageSender'),
    MediaRetry:     require('./lib/messages/MediaRetry'),
    ReportingToken: require('./lib/messages/ReportingToken'),
    TcTokenStore:   require('./lib/messages/TcTokenStore')
  },
  MediaService:     require('./lib/MediaService'),
  MediaThumbnail:   require('./lib/MediaThumbnail'),
  GroupParticipant: require('./lib/GroupParticipant'),

  // The decoders behind the inline thumbnails, and the encoder that makes them.
  // lib/image/index.js is the whole story for most callers; the per-format
  // modules are here for the rest.
  Image: Object.assign({}, require('./lib/image'), {
    Jpeg:        require('./lib/image/Jpeg'),
    JpegEncoder: require('./lib/image/JpegEncoder'),
    Png:         require('./lib/image/Png'),
    Gif:         require('./lib/image/Gif'),
    Bmp:         require('./lib/image/Bmp')
  }),

  HistorySyncHandler: require('./lib/HistorySyncHandler'),
  AuthUtils:          require('./lib/auth-utils'),
  Argo:               require('./lib/argo/ArgoDecoder'),
  WAUSync:            require('./lib/WAUSync'),

  // Signal — lib/signal/. SignalProtocol.js, SignalStore.js and SenderKey.js
  // have no name in common, so the three are one namespace. The two vendored
  // libraries keep theirs, being libraries.
  Signal: Object.assign({},
    require('./lib/signal/SignalProtocol'),
    require('./lib/signal/SignalStore'),
    require('./lib/signal/SenderKey'),
    {
      WaSignalGroup: require('./lib/signal/WaSignalGroup'),
      // libsignal's own barrel leaves six of its modules out. They are added
      // to a copy of it here rather than written into it, so
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
    }),

  // App state — lib/appstate/. AppStateStore.js is spread because the flat
  // AppStateStore is its class; the other three are whole.
  AppState: Object.assign({}, require('./lib/appstate/AppStateStore'), {
    AppStateSync: require('./lib/appstate/AppStateSync'),
    LTHash:       require('./lib/appstate/LTHash'),
    Mutations:    require('./lib/appstate/Mutations'),
    SyncdProto:   require('./lib/appstate/SyncdProto')
  })
};
