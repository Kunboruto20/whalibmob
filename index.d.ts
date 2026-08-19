// Type definitions for whalibmob
// Project: https://github.com/Kunboruto20/whalibmob
//
// These declarations are derived from the implementation in lib/, not from the
// documentation. Where a shape was verified against the code it is described
// precisely; the Signal, WAM and protobuf internals are exported as `any`
// rather than guessed at, because a wrong type is worse than no type.

/// <reference types="node" />

import { EventEmitter } from 'events';

// ────────────────────────────────────────────────────────────────────────────
// Core aliases
// ────────────────────────────────────────────────────────────────────────────

/**
 * A WhatsApp address. Accepted anywhere a recipient is expected:
 *  - bare digits, country code first, no `+`  — `'919634847671'`
 *  - a contact JID   — `'919634847671@s.whatsapp.net'`
 *  - a group JID     — `'120363000000000000@g.us'`
 *  - a LID           — `'112713111982325@lid'`
 *  - a newsletter    — `'120363000000000004@newsletter'`
 *  - status          — `'status@broadcast'`
 */
export type Jid = string;

/** Anything the media senders accept: a file path, or the bytes themselves. */
export type MediaSource = string | Buffer | Uint8Array;

/** Delivery method for a verification code. */
export type CodeMethod = 'sms' | 'voice' | 'wa_old' | 'flash';

/** Result of a number-status lookup. */
export type NumberStatus =
  | 'registered'
  | 'registered_blocked'
  | 'not_registered'
  | 'cooldown'
  | 'unknown';

// ────────────────────────────────────────────────────────────────────────────
// Store / device
// ────────────────────────────────────────────────────────────────────────────

export interface KeyPair {
  private: Buffer;
  public: Buffer;
}

export interface SignedPreKey extends KeyPair {
  id: number;
  signature: Buffer;
}

/** The device profile a session announces. Built by `getDeviceConfig()`. */
export interface DeviceConfig {
  os: 'ios' | 'android';
  platform: number;
  model: string;
  manufacturer: string;
  osVersion?: string;
  build?: string;
  modelId?: string;
  business?: boolean;
  [key: string]: any;
}

/**
 * A registered (SMS / mobile) session. This is what `createNewStore`,
 * `initAuthCreds` and `loadStore` hand back and `saveStore` writes.
 */
export interface WhalibmobStore {
  phoneNumber: string;
  noiseKeyPair: KeyPair;
  identityKeyPair: KeyPair;
  signedPreKey: SignedPreKey;
  registrationId: number;
  fdid: string;
  deviceId: string;
  identityId: string;
  advertisingId: string;
  backupToken: string;
  /** `true` once `verifyCode` has succeeded. */
  registered: boolean;
  /** `true` between requesting a code and confirming it. */
  codePending: boolean;
  /** Display name announced on connect; `null` until one is set. */
  name: string | null;
  version: string;
  device: DeviceConfig;
  /** Signed device identity, `null` until the server sends it in `<success>`. */
  advIdentity: string | null;
  [key: string]: any;
}

/** A companion (pairing-code / QR) session. */
export interface WhalibmobWebStore {
  phoneNumber: string;
  registered: boolean;
  me?: { id: string; lid?: string; name?: string } | null;
  advSecretKey?: string;
  deviceIndex?: number;
  platform?: string;
  [key: string]: any;
}

// ────────────────────────────────────────────────────────────────────────────
// Client options
// ────────────────────────────────────────────────────────────────────────────

export interface WhalibmobClientOptions {
  /** Authentication folder. Each number gets its own subfolder. Default `~/.waSession`. */
  sessionDir?: string;
  /** Re-file the session when the server reports the account under a different number. Default `true`. */
  autoFixNumber?: boolean;
  /** Send read receipts for incoming messages. Default `true`. */
  autoRead?: boolean;
  /** Refresh the announced build from the platform's store before every handshake. Default `true`. */
  refreshVersion?: boolean;
  /** `true` enables debug logging; an object is handed to `pino` as-is. */
  pino?: boolean | object;
  /** How many sent messages keep their plaintext for retry receipts. Default `2000`. */
  sentCacheSize?: number;
  /** How many times one message may be re-sent for retry receipts. Default `5`. */
  maxRetryResends?: number;
  /** How long a first message waits for its trusted-contact token, in ms. Default `5000`. */
  tcTokenPresendTimeoutMs?: number;
}

export interface ConnectWebOptions {
  /** Ask the phone for the full archive. Default `true`. */
  syncFullHistory?: boolean;
  /** `[os, client, version]` — shown to the owner under Linked Devices. */
  browser?: [string, string, string];
  /** Web client revision to announce, e.g. `[2, 3000, 1035194821]`. */
  version?: [number, number, number];
  /** Set `false` to skip the live revision lookup. Default `true`. */
  fetchVersion?: boolean;
  /** Emit the QR as a `wa.me/settings/linked_devices#…` link instead of the bare fields. */
  qrWrapUrl?: boolean;
}

export interface DisconnectOptions {
  /** Allow the reconnect loop to run afterwards. */
  reconnect?: boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// Messages
// ────────────────────────────────────────────────────────────────────────────

export interface ContextInfo {
  quotedMessageId?: string;
  participant?: Jid;
  remoteJid?: Jid;
  mentionedJid?: Jid[];
  [key: string]: any;
}

export interface SendOptions {
  /** Use a message id you generated yourself instead of a fresh one. */
  id?: string;
  contextInfo?: ContextInfo;
  /** JIDs to mention; also written into `contextInfo.mentionedJid`. */
  mentions?: Jid[];
  [key: string]: any;
}

export interface MediaSendOptions extends SendOptions {
  caption?: string;
  mimetype?: string;
  width?: number;
  height?: number;
  seconds?: number;
  /** JPEG bytes for the inline preview. */
  thumbnail?: Buffer;
}

export interface DocumentSendOptions extends SendOptions {
  fileName?: string;
  title?: string;
  mimetype?: string;
}

export interface AudioSendOptions extends SendOptions {
  /** Render as a push-to-talk voice note with a waveform. */
  ptt?: boolean;
  mimetype?: string;
  seconds?: number;
}

export interface VideoSendOptions extends MediaSendOptions {
  /** Send as a GIF — labelled mediatype `gif` rather than `video`. */
  gifPlayback?: boolean;
}

export interface LocationSendOptions extends SendOptions {
  name?: string;
  address?: string;
  url?: string;
  isLive?: boolean;
  accuracyInMeters?: number;
  /** Map image for the bubble; WhatsApp draws a blank card without one. */
  thumbnail?: Buffer;
  jpegThumbnail?: Buffer;
}

/** What every `send*` call resolves to once the server has acked the stanza. */
export interface SendResult {
  id: string;
  /** `'sent'` on a normal send; `'deleted_locally'` from a local-only delete. */
  status: string;
}

export interface PollSendResult extends SendResult {
  /** 32-byte secret needed to decrypt incoming votes. */
  encKey: Buffer;
  /** The same value under the name the protocol uses. */
  messageSecret: Buffer;
}

export interface DecodedBase {
  type: string;
  [key: string]: any;
}

export interface DecodedText extends DecodedBase {
  type: 'text';
  text: string;
}

export interface DecodedMedia extends DecodedBase {
  type: 'image' | 'video' | 'audio' | 'voice' | 'document' | 'sticker';
  url: string;
  mimetype: string;
  mediaKey: Buffer;
  directPath: string;
  caption?: string;
  fileName?: string;
}

export interface DecodedReaction extends DecodedBase {
  type: 'reaction';
  emoji: string;
}

export interface DecodedLocation extends DecodedBase {
  type: 'location';
  latitude: number;
  longitude: number;
  name: string;
  address: string;
  url: string;
}

export interface DecodedContact extends DecodedBase {
  type: 'contact';
  displayName: string;
  vcard: string;
}

export interface DecodedGroupInvite extends DecodedBase {
  type: 'groupInvite';
  groupJid: Jid;
  inviteCode: string;
  inviteExpiration: number;
  groupName: string;
  jpegThumbnail: Buffer | null;
  caption: string;
  isCommunity: boolean;
}

export interface DecodedProtocol extends DecodedBase {
  type: 'protocol';
  subtype: string;
}

export type DecodedMessage =
  | DecodedText
  | DecodedMedia
  | DecodedReaction
  | DecodedLocation
  | DecodedContact
  | DecodedGroupInvite
  | DecodedProtocol
  | DecodedBase;

/**
 * The payload of the `message` event.
 *
 * It arrives in one of three shapes, so `decoded` and `text` are each optional
 * and you should check before reading either:
 *
 *  - a plaintext body that was never Signal-encoded — carries `text`, no `decoded`
 *  - a decoded direct message                       — carries `decoded`
 *  - a decoded group message                        — carries `decoded` and `isGroup`
 */
export interface IncomingMessage {
  id: string;
  /** Sender JID — may be a LID. Read `node.attrs.sender_pn` for the phone JID. */
  from: Jid;
  /** Group member JID; equals `from` in DMs. */
  participant: Jid;
  /** Unix timestamp, seconds. */
  ts: number;
  /** Raw binary node. `node.attrs.sender_pn` holds the real phone JID. */
  node: any;
  /** The structured payload. Absent on the plaintext-body variant. */
  decoded?: DecodedMessage | null;
  /** Raw body text. Present only on the plaintext-body variant. */
  text?: string | null;
  /** `true` on a group message. */
  isGroup?: boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// Groups
// ────────────────────────────────────────────────────────────────────────────

export interface GroupAddRequest {
  code: string;
  expiration: number;
}

/** One participant's outcome. Stringifies to its JID. */
export declare class GroupParticipantResult {
  jid: Jid;
  /** `'200'` when the action went through. */
  status: string;
  /** `null` on success. */
  error: number | null;
  admin: 'admin' | 'superadmin' | null;
  phoneNumber: Jid | null;
  lid: Jid | null;
  displayName: string | null;
  /** Present only on an add refused for privacy: the code an invitation is built from. */
  addRequest: GroupAddRequest | null;
  /** `true` when this add was refused but a personal invitation could be sent. */
  invited?: boolean;
  inviteError?: string;
  readonly ok: boolean;
  readonly needsInvite: boolean;
  toString(): string;
}

/** A pending join request. Stringifies to its JID. */
export declare class GroupJoinRequest {
  jid: Jid;
  /** Unix seconds, or `0` when the server did not say. */
  requestedAt: number;
  toString(): string;
}

export interface GroupParticipant {
  jid: Jid;
  role: 'admin' | 'superadmin' | 'member';
  isAdmin: boolean;
  isSuperAdmin: boolean;
  phoneNumber: Jid | null;
  lid: Jid | null;
  displayName: string | null;
  username: string | null;
}

export interface GroupMetadata {
  jid: Jid;
  subject: string;
  size: number;
  creation: number;
  creator: Jid | null;
  subjectTime?: number;
  subjectBy?: Jid;
  description?: string;
  descriptionId?: string;
  descriptionBy?: Jid;
  descriptionTime?: number;
  /** Disappearing-message timer in seconds; `0` when off. */
  ephemeral: number;
  onlyAdminsSend: boolean;
  onlyAdminsEdit: boolean;
  joinApprovalMode: boolean;
  memberAddMode: 'admin_add' | 'all_member_add' | null;
  isCommunity: boolean;
  isCommunityAnnounce: boolean;
  linkedParent: Jid | null;
  /** Members' phone numbers hidden from each other. */
  isIncognito: boolean;
  /** The group has been taken down; every send is refused. */
  isSuspended: boolean;
  addressingMode: 'lid' | 'pn';
  participants: GroupParticipant[];
  [key: string]: any;
}

export interface GroupInviteInfo {
  jid: Jid;
  subject: string;
  creator: Jid;
  creation: number;
  description: string;
  participants: Array<{ jid: Jid; role: string }>;
  [key: string]: any;
}

export type GroupSetting =
  | 'edit_group_info'
  | 'send_messages'
  | 'add_participants'
  | 'approve_participants';

export type GroupPolicy = 'admins' | 'all';

// ────────────────────────────────────────────────────────────────────────────
// Privacy / profile / account
// ────────────────────────────────────────────────────────────────────────────

export type PrivacyType =
  | 'last_seen'
  | 'profile_picture'
  | 'status'
  | 'online'
  | 'read_receipts'
  | 'groups_add'
  | 'call_add'
  | 'messages'
  | 'defense'
  | 'stickers';

export type PrivacyValue =
  | 'all'
  | 'contacts'
  | 'contact_blacklist'
  | 'contact_allowlist'
  | 'none'
  | 'match_last_seen'
  | 'known'
  | 'on_standard'
  | 'off';

export interface PrivacySettings {
  lastSeen: string | null;
  profile: string | null;
  status: string | null;
  online: string | null;
  readReceipts: string | null;
  groupAdd: string | null;
  callAdd: string | null;
  messages: string | null;
  defense: string | null;
  stickers: string | null;
}

export interface StatusPrivacyEntry {
  type: 'contacts' | 'blacklist' | 'whitelist';
  isDefault: boolean;
  list: Jid[];
}

export interface BusinessProfile {
  jid: Jid;
  description: string | null;
  email: string | null;
  website: string | null;
  address: string | null;
  category: string | null;
}

export interface SessionAliveProbe {
  alive: boolean;
  status: string | null;
  /** The number this session is filed under locally. */
  current?: string;
  /** The number WhatsApp files the account under. */
  canonical?: string;
  /** `true` when the two differ — see `adoptCanonicalNumber`. */
  mismatch?: boolean;
  raw: any;
  error?: string;
}

/** Account restriction state — see `fetchReachoutTimelock`. */
export interface ReachoutTimelockState {
  active: boolean;
  endsAt: number | null;
  endsAtDate: Date | null;
  remainingMs: number;
  /** `HH:MM:SS`; hours are not wrapped at 24. */
  remaining: string;
  enforcementType: string;
  reason: string;
  /** `true` when the server said there is a restriction but withheld the end time. */
  expiryUnknown: boolean;
  checkedAt: number | null;
}

export interface CallLink {
  token: string;
  link: string;
  type: 'audio' | 'video';
}

export interface AppStateSyncResult {
  applied: number;
  collections: Record<string, {
    version: number;
    applied: number;
    skipped: number;
    snapshot: boolean;
    macOk: boolean;
  }>;
  /** Present when the phone has not shared an app-state key yet. */
  waitingForKeys?: boolean;
}

export interface StatusContent {
  image?: MediaSource;
  video?: MediaSource;
  audio?: MediaSource;
  caption?: string;
}

export interface StatusOptions extends SendOptions {
  /** ARGB background for a styled text status. */
  backgroundArgb?: number;
  font?: number;
  /** Post to an explicit list instead of the privacy-derived one. */
  recipients?: Jid[];
}

// ────────────────────────────────────────────────────────────────────────────
// History sync
// ────────────────────────────────────────────────────────────────────────────

export interface HistoryChat {
  id: Jid;
  name?: string;
  unreadCount: number;
  lastMsgTimestamp: number;
  messageCount: number;
}

export interface HistoryContact {
  id: Jid;
  name?: string;
  username?: string;
  pnJid?: Jid;
  lidJid?: Jid;
}

export interface HistorySyncResult {
  syncType: number;
  syncTypeName:
    | 'INITIAL_BOOTSTRAP'
    | 'RECENT'
    | 'FULL'
    | 'PUSH_NAME'
    | 'NON_BLOCKING_DATA'
    | 'ON_DEMAND'
    | string;
  progress: number;
  chunkOrder: number;
  chats: HistoryChat[];
  contacts: HistoryContact[];
  pushNames: Array<{ id: Jid; pushname: string }>;
  lidPnMappings: Array<{ lidJid: Jid; pnJid: Jid }>;
  merged: any;
}

export interface MediaRetryNotification {
  messageId: string;
  chatJid: Jid;
  fromMe: boolean;
  participant?: Jid;
  ciphertext?: Buffer;
  iv?: Buffer;
  /** Set instead of a payload when the phone no longer has the file either. */
  error?: any;
}

export interface MediaRetryResult {
  ok: boolean;
  directPath?: string;
  url?: string;
  [key: string]: any;
}

// ────────────────────────────────────────────────────────────────────────────
// Events
// ────────────────────────────────────────────────────────────────────────────

export interface WhalibmobEvents {
  connected: () => void;
  disconnected: () => void;
  reconnecting: (info: { attempt: number; delay: number }) => void;
  reconnected: () => void;
  close: () => void;
  error: (err: Error) => void;
  auth_failure: (info: { reason: string }) => void;
  stream_error: (info: { reason: string }) => void;
  connection_replaced: () => void;

  message: (msg: IncomingMessage) => void;
  receipt: (r: { type: string; id: string; from: Jid }) => void;
  presence: (p: { from: Jid; available: boolean }) => void;
  call: (c: { from: Jid }) => void;
  notification: (node: any) => void;
  decrypt_error: (e: { id: string; from: Jid; participant?: Jid; err: Error }) => void;
  session_refresh: (e: { node: any }) => void;

  group_update: (u: {
    type: string;
    groupJid: Jid;
    actor?: Jid;
    participants?: Jid[];
    subject?: string;
    timestamp?: number;
  }) => void;

  chat_read: (u: { jid: Jid; read: boolean; remote?: boolean; synced?: boolean }) => void;
  chat_muted: (u: { jid: Jid; muted: boolean; until: number; remote?: boolean; synced?: boolean }) => void;
  chat_pinned: (u: { jid: Jid; pinned: boolean; remote?: boolean; synced?: boolean }) => void;
  chat_archived: (u: { jid: Jid; archived: boolean; remote?: boolean; synced?: boolean }) => void;
  chat_removed: (u: { jid: Jid; kind: string; remote: boolean }) => void;
  message_starred: (u: {
    msgId: string; chatJid: Jid; starred: boolean;
    fromMe?: boolean; remote?: boolean; synced?: boolean;
  }) => void;
  contact_update: (u: {
    jid: Jid; name?: string; firstName?: string; lid?: Jid;
    username?: string; removed?: boolean; remote?: boolean;
  }) => void;
  push_name_update: (u: { name: string; remote?: boolean }) => void;

  blocklist: (b: { action?: string; dhash?: string; prevDhash?: string; changes: Array<{ jid: Jid; action: string }> }) => void;
  privacy_settings: (p: { changes: any; settings: PrivacySettings }) => void;

  app_state_sync: (r: AppStateSyncResult) => void;
  app_state_mutation: (m: { collection: string; index: any; action: any; removed: boolean }) => void;
  app_state_key_missing: (m: { collection: string; keyId: string }) => void;
  app_state_keys: (m: { keys: any[] }) => void;

  account_restriction: (r: ReachoutTimelockState & { source: 'notification' | 'query' }) => void;

  history_sync: (r: HistorySyncResult) => void;
  history_sync_error: (e: { err: Error; notification: any }) => void;
  media_retry: (n: MediaRetryNotification) => void;

  /** Companion mode: a pairing code was requested. */
  pairing_code: (p: { code: string; phoneNumber: string }) => void;
  /** Companion mode: a QR is ready to render; fires again on each rotation. */
  qr: (q: { qr: string; ref: string; ttlMs: number; remaining: number }) => void;
  qr_timeout: () => void;
  pair_device: (p: { refs: string[] }) => void;
  paired: (p: { jid: Jid; lid: Jid; deviceIndex: number; platform: string }) => void;
  restart_required: (r: { reason?: string }) => void;
  web_ready_for_pairing: () => void;

  /** The server refused the client itself — `405` means the announced version is not accepted. */
  client_rejected: (r: { reason: string; location?: string; message?: string }) => void;
  version_update: (v: { from: string; to: string; source: string }) => void;
  apk_material_stale: (m: { materialVersion: string; liveVersion: string; hint?: string }) => void;
  number_corrected: (n: { from: string; to: string }) => void;

  mex_notification: (m: { opName: string; data: any }) => void;
  identity_change: (i: any) => void;
  media_conn: (m: any) => void;
  media_conn_error: (e: any) => void;
  node: (n: any) => void;
  node_error: (e: any) => void;
  iq: (n: any) => void;
  ib: (n: any) => void;
  md_msg_hist: (n: any) => void;
  skdm_error: (e: any) => void;
}

// ────────────────────────────────────────────────────────────────────────────
// Client
// ────────────────────────────────────────────────────────────────────────────

export declare class WhalibmobClient extends EventEmitter {
  constructor(opts?: WhalibmobClientOptions);

  on<E extends keyof WhalibmobEvents>(event: E, listener: WhalibmobEvents[E]): this;
  once<E extends keyof WhalibmobEvents>(event: E, listener: WhalibmobEvents[E]): this;
  off<E extends keyof WhalibmobEvents>(event: E, listener: WhalibmobEvents[E]): this;
  addListener<E extends keyof WhalibmobEvents>(event: E, listener: WhalibmobEvents[E]): this;
  removeListener<E extends keyof WhalibmobEvents>(event: E, listener: WhalibmobEvents[E]): this;
  emit<E extends keyof WhalibmobEvents>(event: E, ...args: Parameters<WhalibmobEvents[E]>): boolean;

  /** `'mobile'` for an SMS-registered primary, `'web'` for a linked companion. */
  readonly _mode: 'mobile' | 'web';
  readonly store: WhalibmobStore | WhalibmobWebStore;

  // ─── Connection ──────────────────────────────────────────────────────────
  /** Connect an SMS-registered session over TCP. Resolves with the client. */
  init(phoneNumber: string): Promise<this>;
  /** Alias of `init`. */
  connect(phoneNumber: string): Promise<this>;
  /** Connect as a companion over WebSocket. */
  connectWeb(phoneNumber: string, opts?: ConnectWebOptions): Promise<this>;
  /** Alias of `connectWeb`. */
  initWeb(phoneNumber: string, opts?: ConnectWebOptions): Promise<this>;
  /** Ask for an 8-character pairing code. Throws if the session is already linked. */
  requestPairingCode(phoneNumber?: string, customCode?: string): Promise<string>;
  disconnect(opts?: DisconnectOptions): void;

  /** Ask the server whether this session still logs in, and under which number. */
  checkSessionAlive(): Promise<SessionAliveProbe>;
  /** Re-file the session under the number WhatsApp uses. Keeps keys and registration. */
  adoptCanonicalNumber(canonical: string): Promise<any>;

  // ─── Sending ─────────────────────────────────────────────────────────────
  sendText(to: Jid, text: string, opts?: SendOptions): Promise<SendResult>;
  sendImage(to: Jid, data: MediaSource, opts?: MediaSendOptions): Promise<SendResult>;
  sendVideo(to: Jid, data: MediaSource, opts?: VideoSendOptions): Promise<SendResult>;
  sendAudio(to: Jid, data: MediaSource, opts?: AudioSendOptions): Promise<SendResult>;
  sendDocument(to: Jid, data: MediaSource, opts?: DocumentSendOptions): Promise<SendResult>;
  sendSticker(to: Jid, data: MediaSource, opts?: SendOptions): Promise<SendResult>;
  sendReaction(to: Jid, messageId: string, emoji: string, opts?: SendOptions): Promise<SendResult>;
  sendPoll(to: Jid, question: string, options: string[], selectableCount?: number, opts?: SendOptions): Promise<PollSendResult>;
  sendLocation(to: Jid, latitude: number, longitude: number, opts?: LocationSendOptions): Promise<SendResult>;
  sendContact(to: Jid, displayName: string, vcard: string, opts?: SendOptions): Promise<SendResult>;
  sendReply(to: Jid, quotedMsgId: string, senderJid: Jid, text: string, opts?: SendOptions): Promise<SendResult>;
  forwardMessage(to: Jid, msg: IncomingMessage | string, contextInfo?: ContextInfo): Promise<SendResult>;
  editMessage(origMsgId: string, chatJid: Jid, newText: string, opts?: SendOptions): Promise<SendResult>;
  deleteMessage(origMsgId: string, chatJid: Jid, fromMe: boolean, forEveryone: boolean, opts?: SendOptions): Promise<SendResult>;
  sendStatus(content: string | StatusContent, opts?: StatusOptions): Promise<SendResult>;
  sendCallLink(to: Jid, type?: 'audio' | 'video', opts?: SendOptions & { text?: string }): Promise<SendResult & { link: string }>;
  createCallLink(type?: 'audio' | 'video', opts?: { startTime?: number }): Promise<CallLink>;

  // ─── Receiving ───────────────────────────────────────────────────────────
  /** Download and decrypt a media message. Accepts `msg` or `msg.decoded`. */
  downloadMedia(decoded: DecodedMessage | IncomingMessage, opts?: { verify?: boolean }): Promise<Buffer>;
  /** Ask the sender's phone to re-upload a file the CDN no longer has. */
  requestMediaRetry(info: { id: string; chatJid: Jid; fromMe: boolean; participant?: Jid }, mediaKey: Buffer): Promise<void>;
  decryptMediaRetry(notification: MediaRetryNotification, mediaKey: Buffer): MediaRetryResult;

  // ─── Presence / receipts ─────────────────────────────────────────────────
  markRead(jid: Jid, messageIds: string | string[], opts?: object): void;
  markMessagePlayed(msgId: string, from: Jid): void;
  setOnline(available: boolean): boolean;
  setPresence(available: boolean): boolean;
  setChatPresence(chatJid: Jid, presence: 'composing' | 'recording' | 'paused' | 'available' | 'unavailable'): void;
  subscribeToPresence(jids: Jid | Jid[]): void;

  // ─── Queries ─────────────────────────────────────────────────────────────
  /** Returns the JIDs, out of those given, that are on WhatsApp. */
  hasWhatsapp(jids: Jid[]): Promise<Jid[]>;
  queryAbout(jid: Jid): Promise<string | null>;
  queryOwnAbout(): Promise<string | null>;
  queryPicture(jid: Jid, opts?: object): Promise<string | null>;
  queryPictureInfo(jid: Jid, opts?: object): Promise<any>;
  downloadProfilePicture(jid: Jid, opts?: object): Promise<Buffer | null>;
  queryBusinessProfile(jid: Jid): Promise<BusinessProfile | null>;

  // ─── Profile ─────────────────────────────────────────────────────────────
  changeName(name: string): Promise<boolean>;
  changeAbout(text: string): Promise<any>;
  /**
   * Pass `null` to remove. Resolves to the new picture id, `'remove'` when the
   * picture was taken down, or `null` when the server's reply carried no id.
   */
  changeProfilePicture(buf: Buffer | null, opts?: { raw?: boolean; size?: number; quality?: number }): Promise<string | null>;

  // ─── Privacy ─────────────────────────────────────────────────────────────
  queryPrivacySettings(opts?: { force?: boolean }): Promise<PrivacySettings>;
  changePrivacySetting(type: PrivacyType, value: PrivacyValue, excluded?: Jid[]): Promise<PrivacySettings>;
  queryStatusPrivacy(): Promise<StatusPrivacyEntry[]>;
  blockContact(jid: Jid): Promise<Jid[]>;
  unblockContact(jid: Jid): Promise<Jid[]>;
  queryBlockList(): Promise<Jid[]>;

  // ─── Chat state (app state) ──────────────────────────────────────────────
  /** Each returns whether the change reached app state, and so whether other devices will see it. */
  markChatRead(jid: Jid): Promise<boolean>;
  markChatUnread(jid: Jid): Promise<boolean>;
  muteChat(jid: Jid, durationMs?: number): Promise<boolean>;
  unmuteChat(jid: Jid): Promise<boolean>;
  pinChat(jid: Jid): Promise<boolean>;
  unpinChat(jid: Jid): Promise<boolean>;
  archiveChat(jid: Jid): Promise<boolean>;
  unarchiveChat(jid: Jid): Promise<boolean>;
  starMessage(msgId: string, chatJid: Jid, fromMe: boolean): Promise<boolean>;
  unstarMessage(msgId: string, chatJid: Jid, fromMe: boolean): Promise<boolean>;
  changeEphemeralTimer(jid: Jid, seconds: number): Promise<any>;
  changeNewChatsEphemeralTimer(seconds: number): Promise<any>;

  /** Pull pins/archives/mutes/stars/contact names changed elsewhere. */
  syncAppState(names?: string[] | null, opts?: { snapshot?: boolean }): Promise<AppStateSyncResult>;
  /** Whether an app-state key is available — `false` on an SMS session with no companion. */
  canSyncAppState(): boolean;

  // ─── Account restriction ─────────────────────────────────────────────────
  fetchReachoutTimelock(): Promise<ReachoutTimelockState>;
  /** The last known state, recomputed; does not ask the server again. */
  getReachoutTimelock(): ReachoutTimelockState;

  // ─── Groups ──────────────────────────────────────────────────────────────
  createGroup(subject: string, participants: Jid[], opts?: object): Promise<GroupMetadata>;
  leaveGroup(groupJid: Jid): Promise<any>;
  /** `null` when the server did not answer the query. */
  getGroupMetadata(groupJid: Jid, opts?: object): Promise<GroupMetadata | null>;
  invalidateGroupMetadata(groupJid: Jid): void;
  fetchAllGroups(): Promise<GroupMetadata[]>;
  refreshGroupMembers(groupJid: Jid): Promise<any>;

  addGroupParticipants(groupJid: Jid, jids: Jid[]): Promise<GroupParticipantResult[]>;
  removeGroupParticipants(groupJid: Jid, jids: Jid[]): Promise<GroupParticipantResult[]>;
  promoteGroupParticipants(groupJid: Jid, jids: Jid[]): Promise<GroupParticipantResult[]>;
  demoteGroupParticipants(groupJid: Jid, jids: Jid[]): Promise<GroupParticipantResult[]>;
  addGroupParticipantsOrInvite(groupJid: Jid, jids: Jid[], opts?: object): Promise<GroupParticipantResult[]>;

  changeGroupSubject(groupJid: Jid, subject: string): Promise<any>;
  changeGroupDescription(groupJid: Jid, description: string, opts?: object): Promise<any>;
  /** Resolves to the new picture id, `'remove'`, or `null` when the reply carried no id. */
  changeGroupPicture(groupJid: Jid, buf: Buffer | null, opts?: object): Promise<string | null>;
  changeGroupSetting(groupJid: Jid, setting: GroupSetting, policy: GroupPolicy): Promise<any>;
  setGroupAnnounce(groupJid: Jid, announce: boolean): Promise<any>;
  setGroupLocked(groupJid: Jid, locked: boolean): Promise<any>;
  setGroupJoinApprovalMode(groupJid: Jid, mode: boolean): Promise<any>;
  setGroupMemberAddMode(groupJid: Jid, mode: string): Promise<any>;

  /** Returns the full `https://chat.whatsapp.com/…` link, or `null`. */
  queryGroupInviteLink(groupJid: Jid, reset?: boolean): Promise<string | null>;
  revokeGroupInviteLink(groupJid: Jid): Promise<string | null>;
  revokeGroupInvite(groupJid: Jid): Promise<string | null>;
  /** Accepts a bare code or a full URL. */
  joinGroupWithLink(inviteCodeOrUrl: string): Promise<{ jid: Jid; pendingApproval: boolean }>;
  acceptGroupInvite(inviteCodeOrUrl: string): Promise<Jid | null>;
  /** `null` when the invite could not be resolved. */
  queryGroupInviteInfo(inviteCodeOrUrl: string): Promise<GroupInviteInfo | null>;

  queryGroupPendingParticipants(groupJid: Jid): Promise<GroupJoinRequest[]>;
  approveGroupParticipants(groupJid: Jid, approve: boolean, jids: Jid[]): Promise<GroupParticipantResult[]>;

  sendGroupInvite(to: Jid, groupJid: Jid, inviteCode: string, inviteExpiration: number, opts?: {
    groupName?: string; caption?: string; jpegThumbnail?: Buffer;
    isCommunity?: boolean; id?: string; contextInfo?: ContextInfo;
  }): Promise<SendResult>;
  queryGroupInviteMessageInfo(groupJid: Jid, inviterJid: Jid, code: string, expiration: number): Promise<GroupMetadata>;
  acceptGroupInviteMessage(groupJid: Jid, inviterJid: Jid, code: string, expiration: number): Promise<Jid>;
  revokeGroupInviteForParticipant(groupJid: Jid, invitedJid: Jid): Promise<any>;

  // ─── Communities ─────────────────────────────────────────────────────────
  createCommunity(subject: string, description?: string, opts?: object): Promise<GroupMetadata>;
  deactivateCommunity(communityJid: Jid): Promise<any>;
  linkGroupsToCommunity(communityJid: Jid, groupJids: Jid[]): Promise<any>;
  unlinkGroupFromCommunity(communityJid: Jid, groupJid: Jid): Promise<any>;

  // ─── Newsletters ─────────────────────────────────────────────────────────
  createNewsletter(name: string, description?: string): Promise<any>;
  joinNewsletter(newsletterJid: Jid): Promise<any>;
  leaveNewsletter(newsletterJid: Jid): Promise<any>;
  queryNewsletterMetadata(newsletterJid: Jid): Promise<any>;
  changeNewsletterDescription(newsletterJid: Jid, description: string): Promise<any>;
  sendNewsletterText(newsletterJid: Jid, text: string): Promise<any>;

  // ─── Stores on disk ──────────────────────────────────────────────────────
  getHistoryStore(): any;
  getMessagesStore(): any;
  getPNForLID(lid: Jid): Jid | null;
  getLIDForPN(pn: Jid): Jid | null;

  // ─── Lower level ─────────────────────────────────────────────────────────
  ensureTcTokenBeforeSend(tcJid: Jid, routingToJid: Jid): Promise<any>;
  sendPeerDataOperationMessage(pdo: any): Promise<any>;
  requestPlaceholderResend(messageKey: any, msgData?: any): Promise<any>;
  fetchMessageHistory(count: number, oldestMsgKey: any, oldestMsgTimestampMs: number): Promise<any>;
  sendWAMBuffer(wamBuffer: Buffer): Promise<any>;
}

// ────────────────────────────────────────────────────────────────────────────
// Registration
// ────────────────────────────────────────────────────────────────────────────

/** The raw server reply. Extra keys vary by outcome, so it is left open. */
export interface RegistrationResult {
  status?: string;
  reason?: string;
  /** The number WhatsApp filed the account under; may differ from the one typed. */
  login?: string;
  pending?: string;
  /**
   * Set only when the server's number differs from the one typed. Callers
   * should use `result.store || store` — the CLI does — because a plain
   * success carries no store of its own.
   */
  store?: WhalibmobStore;
  canonicalPhoneNumber?: string;
  typedPhoneNumber?: string;
  [key: string]: any;
}

export interface RegistrationOptions {
  /** Display name the account announces. Trimmed and capped at 25 characters. */
  name?: string;
  /** Called when the server answers with a CAPTCHA. Return the answer, or `null` to give up. */
  solveCaptcha?: (challenge: { image: Buffer | null; audio: Buffer | null }) => Promise<string | null>;
  /** Called when the account has two-step verification on. Return the six-digit PIN. */
  twoFactorPin?: () => Promise<string | null>;
  onProgress?: (line: string) => void;
  [key: string]: any;
}

export declare function requestSmsCode(store: WhalibmobStore, method?: CodeMethod, opts?: RegistrationOptions): Promise<RegistrationResult>;
export declare function verifyCode(store: WhalibmobStore, code: string, opts?: RegistrationOptions): Promise<RegistrationResult>;
export declare function checkIfRegistered(store: WhalibmobStore): Promise<RegistrationResult>;

export interface NumberStatusResult {
  active: boolean | null;
  usable: boolean | null;
  status: NumberStatus;
  note: string;
}
export declare function checkNumberStatus(phoneNumber: string): Promise<NumberStatusResult>;

/** Firebase push listener. Resolves `null` on timeout, or immediately on iOS. */
export declare function receivePushCode(store: WhalibmobStore, device?: DeviceConfig, opts?: { timeoutMs?: number }): Promise<string | null>;
/** Whether this device profile can do push verification at all. */
export declare function supportsPush(device: DeviceConfig): boolean;

export declare function assertRegistrationKeys(store: WhalibmobStore): void;

// ─── Version ────────────────────────────────────────────────────────────────
export declare function fetchWaVersion(device?: DeviceConfig): Promise<string>;
export declare function fetchIosVersion(business?: boolean): Promise<string>;
export declare function fetchAndroidVersion(business?: boolean): Promise<string>;
export declare function currentVersionFor(device: Partial<DeviceConfig>): Promise<{ version: string; source: string }>;
export declare function refreshSessionVersion(sessionFile: string, opts?: { version?: string }): Promise<any>;
/** The live WhatsApp Web revision, read from the service worker. */
export declare function fetchWaWebVersion(): Promise<{ version: [number, number, number]; isLatest: boolean }>;

// ────────────────────────────────────────────────────────────────────────────
// Stores
// ────────────────────────────────────────────────────────────────────────────

export declare function createNewStore(phoneNumber: string, opts?: { name?: string }): WhalibmobStore;
/** What the CLI uses for every new SMS session; prefer it over `createNewStore`. */
export declare function initAuthCreds(phoneNumber: string, opts?: { name?: string }): WhalibmobStore;
export declare function saveStore(store: WhalibmobStore, filePath: string): void;
export declare function loadStore(filePath: string): WhalibmobStore | null;
export declare function storeToJson(store: WhalibmobStore): string;
export declare function storeFromJson(json: string): WhalibmobStore;
export declare function toSixParts(store: WhalibmobStore): any;
export declare function fromSixParts(parts: any): WhalibmobStore;

export declare function createNewWebStore(phoneNumber: string, opts?: object): WhalibmobWebStore;
export declare function saveWebStore(store: WhalibmobWebStore, filePath: string): void;
export declare function loadWebStore(filePath: string): WhalibmobWebStore | null;
export declare function webSessionPath(baseDir: string, phone: string): string;

// ────────────────────────────────────────────────────────────────────────────
// Session paths
// ────────────────────────────────────────────────────────────────────────────

export interface SessionEntry {
  phone: string;
  dir: string;
  storeFile: string;
  webStoreFile: string;
  /** `true` for a session whose files sit loose in the base directory. */
  legacy: boolean;
  hasMobile: boolean;
  hasWeb: boolean;
}

export interface MigrateResult {
  phone: string;
  from: string;
  to: string;
  moved: string[];
  skipped: string[];
}

export declare function defaultBaseDir(): string;
export declare function sessionDirFor(baseDir: string, phone: string, opts?: { create?: boolean }): string;
export declare function storeFileFor(baseDir: string, phone: string): string;
export declare function webStoreFileFor(baseDir: string, phone: string): string;
export declare function listSessions(baseDir: string): SessionEntry[];
export declare function migrateSession(baseDir: string, phone: string): MigrateResult;

export declare const SessionPaths: {
  defaultBaseDir: typeof defaultBaseDir;
  isLegacyLayout: (baseDir: string, phone: string) => boolean;
  sessionDirFor: typeof sessionDirFor;
  storeFileFor: typeof storeFileFor;
  webStoreFileFor: typeof webStoreFileFor;
  listSessions: typeof listSessions;
  migrateSession: typeof migrateSession;
  preKeyFilesFor: (baseDir: string, phone: string) => string[];
  /** Every per-number file the library writes. */
  SESSION_SUFFIXES: string[];
  SHARED_FILES: string[];
};

// ────────────────────────────────────────────────────────────────────────────
// Device
// ────────────────────────────────────────────────────────────────────────────

/** Reads `WA_OS`, `WA_DEVICE` and the `WA_DEVICE_*` overrides from `process.env`. */
export declare function getDeviceConfig(): DeviceConfig;

// ────────────────────────────────────────────────────────────────────────────
// Media
// ────────────────────────────────────────────────────────────────────────────

export declare function encryptMedia(buffer: Buffer, mediaType: string): any;
export declare function decryptMedia(buffer: Buffer, mediaKey: Buffer, mediaType: string): Buffer;
export declare function uploadMedia(...args: any[]): Promise<any>;
export declare function downloadMedia(url: string, mediaKey: Buffer, keyName: string, opts?: object): Promise<Buffer>;

// ────────────────────────────────────────────────────────────────────────────
// Message helpers
// ────────────────────────────────────────────────────────────────────────────

/** Normalises bare digits or a partial JID into a full one. */
export declare function makeJid(input: string): Jid;
export declare function generateMessageId(): string;
export declare const MessageSender: any;

// ────────────────────────────────────────────────────────────────────────────
// Signal key store utilities
// ────────────────────────────────────────────────────────────────────────────

/** Wraps a `SignalStore` with a 5-minute in-memory cache. */
export declare function makeCacheableSignalKeyStore<T>(store: T): T & { flushCache(): Promise<void> };
/** Wraps a `SignalStore` with batched-write (transaction) semantics. */
export declare function addTransactionCapability<T>(store: T): T & {
  transaction<R>(fn: () => Promise<R>, key?: string): Promise<R>;
  isInTransaction(): boolean;
};
/** The account's JID, or throws describing what is missing. */
export declare function assertMeId(store: WhalibmobStore | WhalibmobWebStore): Jid;

// ────────────────────────────────────────────────────────────────────────────
// History sync
// ────────────────────────────────────────────────────────────────────────────

export declare const HistorySyncType: Record<string, number>;
export declare const HistorySyncTypeName: Record<number, string>;
export declare function processHistorySyncNotification(...args: any[]): Promise<any>;
export declare function decodeHistorySyncNotification(buf: Buffer): any;
export declare function decodeHistorySync(buf: Buffer): any;
export declare function decodeAppStateSyncKeyShare(buf: Buffer): any;
export declare function saveAppStateSyncKeys(...args: any[]): any;
export declare function loadAppStateSyncKeys(...args: any[]): any;
export declare function mergeHistoryToStore(...args: any[]): any;
export declare function decryptHistoryBlob(blob: Buffer, key: Buffer): Buffer;
export declare function deriveHistoryKeys(key: Buffer): any;

// ────────────────────────────────────────────────────────────────────────────
// Companion pairing internals
// ────────────────────────────────────────────────────────────────────────────

export declare function generatePairingCode(): string;
export declare function derivePairingCodeKey(...args: any[]): any;
export declare function buildWrappedEphemeralPub(...args: any[]): any;
export declare function decipherLinkPublicKey(...args: any[]): any;
export declare function buildCompanionFinishBundle(...args: any[]): any;
export declare function configureSuccessfulPairing(...args: any[]): any;
export declare function encodeCompanionRegisterPayload(...args: any[]): Buffer;
export declare function encodeCompanionLoginPayload(...args: any[]): Buffer;

// ────────────────────────────────────────────────────────────────────────────
// Internals exported for advanced use.
//
// These are typed loosely on purpose: their surfaces are large and mostly
// internal, and a plausible-looking wrong signature would be worse than `any`.
// ────────────────────────────────────────────────────────────────────────────

export declare const SignalProtocol: any;
export declare const SignalStore: any;
export declare const SenderKeyStore: any;
export declare const SenderKeyCrypto: any;
export declare const DeviceManager: any;
export declare const AppStateStore: any;
export declare const AppStateSync: any;
export declare const APP_STATE_COLLECTIONS: string[];
export declare const LT_HASH: any;
export declare const ReachoutTimelock: any;
export declare const WAM: any;
export declare const encodeWAM: any;
export declare const BinaryInfo: any;
export declare const WEB_EVENTS: any;
export declare const WEB_GLOBALS: any;
export declare function decodeArgo(buf: Buffer): any;
export declare function tryDecodeArgo(buf: Buffer): any;
