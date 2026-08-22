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

export { media, decode, poll, retry, internals, sameThing };
