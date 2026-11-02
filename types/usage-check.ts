// Does the typed half of the namespaces hold up when it is actually used?
//
// `tsc --noEmit index.d.ts` proves the declarations parse. It does not prove
// they are usable: a signature can be well formed and still wrong about what it
// takes or hands back. This file is compiled under the same --strict as the
// declarations, so anything below that does not typecheck is a declaration that
// would have failed a caller.
//
// It is never run. Nothing here should have a side effect.

import * as wa from '../index';
import type { DecodedMessage, MediaRetryResult } from '../index';

// ─── MediaService ────────────────────────────────────────────────────────────

async function media(mediaKey: Buffer, plaintext: Buffer): Promise<void> {
  const keyName: string | null = wa.MediaService.getMediaKeyName('image');
  if (!keyName) return;

  const enc = wa.MediaService.encryptMedia(plaintext, mediaKey, keyName);
  const back: Buffer = wa.MediaService.decryptMedia(enc.encrypted, mediaKey, keyName);
  void back.length;

  // sha256Enc is what a message carries as fileEncSha256, so the download
  // should take it without a cast.
  const url: string | null = wa.MediaService.resolveMediaUrl(null, '/d/f/x.enc');
  if (url) {
    await wa.MediaService.downloadMedia(url, mediaKey, keyName, {
      web: true,
      fileEncSha256: enc.sha256Enc
    });
    await wa.MediaService.httpGetBuffer(url);
  }

  const expanded: Buffer = wa.MediaService.deriveMediaKeyData(mediaKey, keyName);
  void expanded;
  void wa.MediaService.MEDIA_PATH.image.keyName;
}

// ─── MessageProto, and the envelopes ─────────────────────────────────────────

function decode(buf: Buffer): string {
  const d: DecodedMessage = wa.MessageProto.decodeMessageContainer(buf);

  // The three flags the envelopes leave behind.
  if (d.viewOnce && d.ephemeral) return 'view-once, in a disappearing chat';
  if (d.edited) return 'an edit';
  return d.type;
}

function poll(): Buffer {
  const p = wa.MessageProto.encodePollCreationMessage({
    question: 'lunch?', options: ['yes', 'no']
  });
  void p.messageSecret.length;
  return p.payload;
}

// ─── Media retry ─────────────────────────────────────────────────────────────

function retry(mediaKey: Buffer, msgId: string): MediaRetryResult | null {
  const key: Buffer = wa.Messages.MediaRetry.mediaRetryKey(mediaKey);
  void key;

  const receipt = wa.Messages.MediaRetry.encryptRetryReceipt(msgId, mediaKey);
  void receipt.ciphertext;
  void receipt.iv;

  const parsed = wa.Messages.MediaRetry.parseRetryNotification(null, {
    findChild:  (_node: any, _tag: string) => null,
    getContent: (_node: any) => null
  });
  if (!parsed) return null;
  return wa.Messages.MediaRetry.decryptRetryNotification(parsed, mediaKey);
}

// directPath comes back null, not undefined, when the phone declines. The
// declaration said `directPath?: string`, so this narrowing — the one a caller
// under --strict would reach for — compiled while being wrong at run time.
// It only typechecks now because the declaration admits null.
function freshLocation(r: MediaRetryResult): string | null {
  if (r.directPath === null) return null;
  const path: string = r.directPath;      // fails if directPath can be undefined
  return path;
}

function retryOutcome(r: MediaRetryResult): string {
  if (r.ok) return 're-uploaded at ' + (r.directPath ?? '?');
  // result is nullable too: null when the phone answered with an error.
  return r.result === null ? 'the phone errored' : 'declined with ' + r.result;
}

// ─── The untyped half is still reachable ─────────────────────────────────────

function internals(): void {
  // These are `any` by design — the declarations have never described the
  // internals. What matters is that reaching them is not an error.
  void wa.Signal.libsignal.crypto;
  void wa.Signal.WaSignalGroup.GroupCipher;
  void wa.AppState.SyncdProto;
  void wa.AppState.COLLECTIONS.length;
  void wa.Image.Jpeg;
  void wa.Image.canDecode(Buffer.alloc(0));
  void wa.Devices.makeDeviceJid;
  void wa.Constants;
  void wa.Argo;
  void wa.Proto;
  void wa.HistorySyncHandler;
}

// A namespace is the module a deep require returns, so the two are the same
// type as far as a caller is concerned.
function sameThing(): void {
  const viaNamespace = wa.MediaService.downloadMedia;
  void viaNamespace;
}

export { media, decode, poll, retry, internals, sameThing, freshLocation, retryOutcome };

async function checkPrimaryLinkedApi(client: wa.WhalibmobClient, code: string, proof: wa.PrimaryCompanionProof) {
  const invitations = client.getPrimaryLinkInvitations();
  if (!invitations.length) return;
  const companion: string | null = invitations[0].companion;
  client.on('primary_link_invitation', (event: wa.PrimaryLinkInvitation) => { const same: string | null = event.companion; void same; });
  void companion;
  const result: wa.PrimaryLinkResult = await client.approveCompanionCode(code, {
    invitationId: invitations[0].id,
    getCompanionProof: async () => proof
  });
  if (result.status === 'awaiting_confirmation') await client.reconcilePrimaryLink(proof);
  const devices: Array<{ deviceId: number; keyIndex: number }> = await client.listLinkedDevices();
  void devices;
}
void checkPrimaryLinkedApi;

async function checkPrimaryQrApi(client: wa.WhalibmobClient, qr: string, code: string, proof: wa.PrimaryCompanionProof) {
  const options: wa.PrimaryLinkCommonOptions = { getCompanionProof: async () => proof };
  const result: wa.PrimaryLinkResult = await client.linkCompanionWithQr(qr, options);
  if (result.status === 'awaiting_confirmation') await client.reconcilePrimaryLink(proof);
  await client.approveCompanionQr(qr);
  await client.linkCompanionWithCode(code, { ...options, waitMs: 45000, timeoutMs: 90000 });
  await client.linkCompanionWithCode(code);
  // @ts-expect-error The strict API still requires an explicit invitation.
  await client.approveCompanionCode(code, {});
  // @ts-expect-error QR input is text, never an unchecked object.
  await client.approveCompanionQr({ qr });
}
void checkPrimaryQrApi;

async function checkPrimaryReadinessApi(client: wa.WhalibmobClient, signal: AbortSignal) {
  const verdict: wa.PrimaryLinkReadiness = await client.getPrimaryLinkReadiness({ timeoutMs: 30000, signal });
  await client.getPrimaryLinkReadiness();
  const mode: 'first' | 'relink' | null = verdict.mode;
  void mode;
  // @ts-expect-error A blocker's detail depends on its code; narrow on the code first.
  void verdict.blockers[0].detail.retirable;
  for (const blocker of verdict.blockers) {
    // A blocker's detail is typed by its code.
    if (blocker.code === 'PRIMARY_LINK_RECONCILIATION_REQUIRED') {
      const retirable: boolean = blocker.detail.retirable;
      if (retirable) await client.retireAbsentPrimaryLink();
    } else if (blocker.code === 'PRIMARY_BOOTSTRAP_FOREIGN_STATE') {
      const reasons: string[] = blocker.detail.reasons;
      void reasons;
    } else if (blocker.code === 'PRIMARY_MESSAGE_STORE_DISABLED') {
      const reason: 'disabled' | 'unreadable' = blocker.detail.reason;
      void reason;
    }
  }
  if (verdict.ready && verdict.needsConfirmation && verdict.history) {
    const coverage: wa.PrimaryHistoryCoverage = verdict.history;
    const origin: string | null = coverage.capture.origin;
    const since: number | null = coverage.capture.since;
    const records: number | null = coverage.records;
    const range: { evicted: number | null; from: number | null; to: number | null } = coverage.retained;
    const lostIds: string[] | undefined = coverage.losses[0]?.ids;
    void origin; void since; void records; void range; void lostIds;
  }
  const evaluated: wa.PrimaryLinkReadiness = wa.Primary.Readiness.evaluateReadiness({});
  void evaluated;
}
void checkPrimaryReadinessApi;

// The link commands take a real client, and answer in the shapes they declare.
async function checkLinkCommands(client: wa.WhalibmobClient, readiness: wa.PrimaryLinkReadiness) {
  const L = wa.Cli.LinkCommands;
  const groups: wa.LinkInvitationGroup[] = L.groupInvitations(client.getPrimaryLinkInvitations());
  const choice: wa.LinkInvitationChoice = L.chooseInvitation(client.getPrimaryLinkInvitations(), '1');
  if ('id' in choice) { const id: string = choice.id; void id; }
  const explained: wa.LinkExplanation = L.explainError('PRIMARY_LINK_STORE_BUSY');
  const lines: string[] = L.formatReadiness(readiness).concat(L.formatLinkStatus(await client.getPrimaryLinkStatus()), explained.title, explained.next);
  const result: wa.LinkCodeResult = await L.runLinkCode({ client, code: 'ABCD1234', selector: '2', confirm: async () => true, print: line => void line.length });
  if (result.status === 'sent') { const op: string = result.approval.operationId; const chats: number = result.bootstrap.history.chats; void op; void chats; }
  if (result.status === 'choose') { const n: number = result.groups.length; void n; }
  const qr: wa.LinkQrResult = await L.runLinkQr({ client, payload: 'https://wa.me/settings/linked_devices#x' });
  // The question names the browser the request was chosen for.
  await L.runLinkCode({ client, code: 'ABCD1234', confirm: async (ready: wa.PrimaryLinkReadiness, ask: wa.LinkConfirmPrompt) => ready.ready && ask.question.length > 0 && ask.companion !== undefined });
  try { await L.runLinkQr({ client, payload: 'x' }); } catch (error) { L.describeError(error); }
  try { await client.bootstrapPrimaryCompanion({ history: 'store', resume: true }); } catch (error) { L.describeError(error, 'bootstrap'); }
  const status: wa.PrimaryLinkStatus = await client.getPrimaryLinkStatus();
  const how: 'code' | 'qr' | null = status.method;
  const when: number | null = status.linkedAt;
  const device: number | null = status.deviceId;
  const delivered: number | undefined = status.delivered?.records;
  void how; void when; void device; void delivered;
  L.formatLinkedDevices({ phone: '447949738354', devices: status.devices, journal: status });
  const resumable: boolean | undefined = status.bootstrap?.resumable;
  const onStatus: wa.LinkExplanation = L.explainError(status.bootstrap?.errorCode, { resumable, bootstrapPhase: status.bootstrapPhase }, 'status');
  void onStatus;
  L.formatLinkedDevices({ phone: '447949738354', devices: await client.listLinkedDevices(), journal: await client.getPrimaryLinkStatus(), history: { chats: 1, records: 2 } });
  const notice: string = L.formatInvitationNotice(client.getPrimaryLinkInvitations()[0], Date.now());
  const later: wa.LinkInvitationChoice = L.chooseInvitation(client.getPrimaryLinkInvitations(), 1, () => Date.now());
  const busy: wa.LinkExplanation = L.explainError('PRIMARY_LINK_STORE_BUSY', { holder: null }, 'unlock');
  void notice; void later; void busy;
  void groups; void lines; void qr;
  // @ts-expect-error A pairing code is text.
  await L.runLinkCode({ client, code: 12345678 });
}
void checkLinkCommands;

// ─── The primary message store, and the history handed to a companion ────────

async function checkPrimaryMessageStore(sessionDir: string, phone: string) {
  // Off unless asked for. `true` keeps 100 messages a chat and 20 000 in all;
  // an object bounds them.
  const defaults = new wa.WhalibmobClient({ sessionDir, messageStore: true });
  const bounded = new wa.WhalibmobClient({ sessionDir, messageStore: { perChat: 200, maxMessages: 50000 } });
  const perChatOnly = new wa.WhalibmobClient({ sessionDir, messageStore: { perChat: 50 } });
  const reset = new wa.WhalibmobClient({ sessionDir, messageStore: { setAsideCorrupt: true } });
  void bounded; void perChatOnly; void reset;
  // @ts-expect-error A bound is a number.
  void new wa.WhalibmobClient({ messageStore: { perChat: '100' } });
  // @ts-expect-error setAsideCorrupt is a yes or a no.
  void new wa.WhalibmobClient({ messageStore: { setAsideCorrupt: 'yes' } });

  defaults.on('primary_message_store_error', e => { const code: string = e.code; const op: string = e.op; void code; void op; });
  await defaults.init(phone);

  const kept: wa.PrimaryMessageSnapshot | null = defaults.getPrimaryMessageStore();
  if (!kept) return;
  const origin: string = kept.capture.origin;
  const since: number = kept.capture.since;
  const evicted: number = kept.retained.evicted;
  const chats: number = kept.counts.chats;
  void origin; void since; void evicted; void chats;
  for (const chat of kept.chats) {
    const name: string | undefined = chat.name;
    const lid: string | undefined = chat.lidJid;
    for (const record of kept.records[chat.id]) {
      const gone: 'revoked' | 'expired' | 'view-once' | undefined = record.tombstone;
      const raw: Buffer | undefined = record.raw;
      const timer: number | undefined = record.expiration;
      void gone; void raw; void timer;
    }
    void name; void lid;
  }
  const reason: string | undefined = kept.losses[0]?.reason;
  void reason;
  // @ts-expect-error The snapshot is null when the store is off, not undefined.
  const nope: wa.PrimaryMessageSnapshot = defaults.getPrimaryMessageStore();
  void nope;
}
void checkPrimaryMessageStore;

async function checkPrimaryBootstrap(client: wa.WhalibmobClient) {
  const sent: wa.PrimaryBootstrapResult = await client.bootstrapPrimaryCompanion({ history: 'store' });
  const mode: 'first' | 'relink' = sent.mode;
  const chats: number = sent.history.chats;
  const records: number = sent.history.records;
  const losses: number | null = sent.history.losses;
  const origin: string | null = sent.history.captureOrigin;
  void mode; void chats; void records; void losses; void origin;

  // Recovery: continue the recorded attempt; send again only a step whose reply never came.
  await client.bootstrapPrimaryCompanion({ history: 'store', resume: true });
  await client.bootstrapPrimaryCompanion({ history: 'store', resume: true, resendUncertain: true });
  // Its own time, and a large history's upload on a clock of its own.
  await client.bootstrapPrimaryCompanion({ history: 'store', timeoutMs: 90000, uploadTimeoutMs: 600000 });
  // @ts-expect-error A time is a number of milliseconds.
  await client.bootstrapPrimaryCompanion({ history: 'store', uploadTimeoutMs: '10m' });
  // Experimental, and not verified on real WhatsApp Web.
  const withDelta = await client.bootstrapPrimaryCompanion({ history: 'store', delta: true });
  const newer: number | undefined = withDelta.delta?.records;
  void newer;

  // A history of your own, in the store's snapshot shape.
  await client.bootstrapPrimaryCompanion({
    history: async () => ({ seq: 0, chats: [], records: {}, pushNames: [] }),
    upload: async () => { throw new Error('not needed below 64 KiB'); }
  });
  // @ts-expect-error The history is required: there is nothing to default to.
  await client.bootstrapPrimaryCompanion({});
  // @ts-expect-error 'store' is the one name; anything else is a function.
  await client.bootstrapPrimaryCompanion({ history: 'file' });
}
void checkPrimaryBootstrap;

function checkPrimaryUnlock(client: wa.WhalibmobClient) {
  // Breaks a lock only when the caller says so. Null when none was held.
  const { holder } = client.unlockPrimaryLink();
  if (!holder) return;
  const pid: number | null = holder.pid;
  const host: string | null = holder.host;
  const since: number | null = holder.at;
  const legacy: boolean = holder.legacy;
  const mutex: true | undefined = holder.mutex;
  void pid; void host; void since; void legacy; void mutex;
}
void checkPrimaryUnlock;

function checkPrimaryInvitationFingerprint(client: wa.WhalibmobClient) {
  for (const invitation of client.getPrimaryLinkInvitations()) {
    // A short fingerprint of the browser's key; null when the request has none.
    const label: string | null = invitation.companion;
    // @ts-expect-error The fingerprint can be null, so it is not a string as it stands.
    const asText: string = invitation.companion;
    void label; void asText;
  }
  const groups = wa.Cli.LinkCommands.groupInvitations(client.getPrimaryLinkInvitations());
  const browser: string | null = groups[0].companion;
  void browser;
}
void checkPrimaryInvitationFingerprint;

// The modules behind the store, the encoder and the readiness check.
function checkPrimaryNamespace() {
  void wa.Primary.MessageStore.PrimaryMessageStore;
  void wa.Primary.HistoryExport.buildHistorySync;
  void wa.Primary.HistoryExport.exportedCounts;
  void wa.Primary.Readiness.evaluateReadiness;
  void wa.Primary.Readiness.gatherFacts;
}
void checkPrimaryNamespace;

// ─── What the decoder keeps for a store that holds a message verbatim ────────

function checkDecodedForCapture(buf: Buffer) {
  const decoded: DecodedMessage = wa.MessageProto.decodeMessageContainer(buf);

  // The disappearing-messages timer in force when a message was sent, in seconds.
  const timer: number | undefined = decoded.contextInfo?.expiration;
  void timer;

  // The message a device-sent envelope wrapped, as the bytes it came in.
  if (decoded.deviceSentMeta) {
    const inner: Buffer | undefined = decoded.deviceSentMeta.messageRaw;
    const chat: string | undefined = decoded.deviceSentMeta.destinationJid;
    void inner; void chat;
  }
}
void checkDecodedForCapture;

function checkDecodedProtocol(protocol: wa.DecodedProtocol) {
  // The type as the number it arrived as; `subtype` is only its name.
  const type: number | undefined = protocol.protocolType;
  // The message a revoke or an edit acts on.
  const target = protocol.key;
  if (target) {
    const id: string = target.id;
    const fromMe: boolean = target.fromMe;
    const remote: string = target.remoteJid;
    const sender: string | undefined = target.participant;
    void id; void fromMe; void remote; void sender;
  }
  // Seconds, and zero means messages no longer disappear.
  const seconds: number | undefined = protocol.ephemeralExpiration;
  // An edit's new content, as the bytes it came in.
  const edited: Buffer | undefined = protocol.editedMessageRaw;
  void type; void seconds; void edited;
  // @ts-expect-error The protocol type is a number, never its name.
  const asName: string = protocol.protocolType;
  // @ts-expect-error An edit's content is bytes.
  const asText: string = protocol.editedMessageRaw;
  void asName; void asText;
}
void checkDecodedProtocol;

function checkMediaPaths() {
  // Message media, and the one upload type that is not a message.
  const paths = wa.MediaService.MEDIA_PATH;
  const history: { path: string; keyName: string } = paths['md-msg-hist'];
  void history;
}
void checkMediaPaths;
