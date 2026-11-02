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
    const origin: string | null = coverage.origin;
    const lost: number | undefined = coverage.losses[0]?.count;
    void origin; void lost;
  }
  const evaluated: wa.PrimaryLinkReadiness = wa.Primary.Readiness.evaluateReadiness({});
  void evaluated;
}
void checkPrimaryReadinessApi;
