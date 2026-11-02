# Linking, Companion Mode & Approving Devices

[← Back to the README](../README.md) · [Documentation index](../README.md#documentation)

---

## Linking to an Existing Account (Pairing Code or QR)

Registering a number over SMS makes whalibmob that number's **own device**. Sometimes that is not what you want — the number is already in use on a phone, or the verification SMS never arrives. For those cases whalibmob can instead connect over a **WebSocket** and link itself to an account that already exists, exactly the way the WhatsApp Web and desktop clients do.

There are two ways to link, and they reach the same place:

- **Pairing code** — whalibmob gives you an 8-character code, the owner types it into their phone.
- **QR code** — whalibmob draws a QR, the owner scans it with the phone's camera.

Both link the number as a companion device, both leave the whole library working the same afterwards — same client, same methods, same events. The only difference is what the owner does: type a code, or scan a square.

> [!IMPORTANT]
> The two modes are independent. SMS registration is unchanged and still the default; nothing about it is affected by linking. A single number can even have both a registered session and a linked session — they are stored in separate files and never share state.

### Requesting a Pairing Code

Connect first, then ask for the code: the request travels over the encrypted channel, so the channel has to exist before there can be a code.

```js
const { WhalibmobClient } = require('whalibmob')
const path = require('path')

const client = new WhalibmobClient({
  sessionDir: path.join(process.env.HOME, '.waSession')
})

client.on('paired', (p) => {
  console.log('linked as', p.jid)          // 919634847671:7@s.whatsapp.net
  console.log('lid      ', p.lid)          // 112713111982325:7@lid
  console.log('slot     ', p.deviceIndex)  // 7
})

client.on('connected', () => {
  console.log('ready')
})

// open the WebSocket connection as a companion
await client.connectWeb('919634847671', { syncFullHistory: true })

// ask for the code — returns immediately, the link completes later
const code = await client.requestPairingCode('919634847671')
console.log('enter this on the phone:', code)   // e.g. "K7M2QX4B"
```

On the phone that owns the number:

**WhatsApp → Settings → Linked Devices → Link a device → Link with phone number instead**, then type the code.

### Linking by QR Code

The QR path is the scan-to-connect alternative. You **do not** request a pairing code — you just connect and listen for the `qr` event. Because no code is asked for, the server volunteers a QR instead, and whalibmob turns it into a ready-to-render string:

```js
const { WhalibmobClient } = require('whalibmob')
const qrcode = require('qrcode-terminal')          // npm install qrcode-terminal
const path = require('path')

const client = new WhalibmobClient({
  sessionDir: path.join(process.env.HOME, '.waSession')
})

// a fresh QR string arrives here, and again each time the previous one expires
client.on('qr', ({ qr, remaining }) => {
  qrcode.generate(qr, { small: true })             // draw it in the terminal
  console.log('scan it — refreshes on its own,', remaining, 'left before it expires')
})

client.on('qr_timeout', () => console.log('QR set expired — reconnect for a fresh one'))

client.on('paired',    (p)  => console.log('scanned — linked as', p.jid))
client.on('connected', ()   => console.log('ready'))

// connect as a companion — and DO NOT request a pairing code
await client.connectWeb('919634847671', { syncFullHistory: true })
```

On the phone that owns the number:

**WhatsApp → Settings → Linked Devices → Link a device**, then point the camera at the QR.

The `qr` string is what a WhatsApp camera reads: `ref,noise,identity,advSecret,platformId` — a one-time ref plus this client's public keys, comma-joined, the same fields WhatsApp Web itself renders. It rotates on its own (about a minute for the first, then shorter) until the account is scanned or the refs run out. `qrcode-terminal` is optional — without it you get the raw string on `qr` and can render it however you like (a PNG, a web page, an image in a chat). To emit the QR as a `wa.me/settings/linked_devices#…` link instead of the bare fields, pass `{ qrWrapUrl: true }` to `connectWeb`.

Everything after the scan is identical to the pairing-code path: `paired`, a stream restart, then `connected`.

### After the link — same for both paths

A few seconds after the code is accepted (or the QR is scanned) you will see `paired`, the server restarts the stream, and `connected` fires on the new connection. From that point on everything else in this document applies unchanged:

```js
await client.sendText('919876543210', 'sent from a linked device')
```

### Reconnecting a Linked Session

The link is persisted. On every later run, `connectWeb()` alone is enough — do **not** request a new code:

```js
const client = new WhalibmobClient({ sessionDir })

client.on('connected', () => console.log('reconnected'))

await client.connectWeb('919634847671')
```

`requestPairingCode()` throws if the session is already linked, so it is safe to guard on that.

### Choosing Your Own Code

If you would rather show the user a code you picked, pass it as the second argument. It must be exactly 8 characters:

```js
const code = await client.requestPairingCode('919634847671', 'MYCODE12')
```

### Options

```js
await client.connectWeb(phone, {
  syncFullHistory: true,                       // ask the phone for full history (default true)
  browser: ['Ubuntu', 'Chrome', '120.0.0.0']   // what the owner sees in Linked Devices
})
```

`browser` is `[os, client, version]`. The second element decides the device icon shown on the phone — `Chrome`, `Firefox`, `Safari`, `Edge`, `Opera`, `Desktop` are all recognised.

### Events Specific to Linking

| Event | Fires when |
|---|---|
| `pairing_code` | a code has been requested — `{ code, phoneNumber }` |
| `qr` | a QR is ready to render — `{ qr, ref, ttlMs, remaining }`; fires again on each rotation |
| `qr_timeout` | the QR refs ran out — reconnect for a fresh set |
| `paired` | the owner accepted the code or scanned the QR — `{ jid, lid, deviceIndex, platform }` |
| `restart_required` | the server is restarting the stream after pairing (normal; the reconnect is automatic) |
| `pair_device` | the raw QR reference strings, before they are turned into `qr` — `{ refs }` |
| `history_sync` | a chunk of history arrived from the phone |

### Getting the History and the Address Book

This is the part a registered number can never do. A device registered over SMS **is** the account's primary, and a primary has nobody to receive history from — it starts with an empty contact list and an empty chat list, and only learns about people who message it.

A linked device is different: the account's phone ships its chats, its contacts and its push names over as soon as the link is established. whalibmob decrypts and stores those automatically, and emits them as they arrive:

```js
client.on('history_sync', (r) => {
  console.log(r.syncTypeName)          // INITIAL_BOOTSTRAP, RECENT, FULL, PUSH_NAME
  console.log('chats   ', r.chats.length)
  console.log('contacts', r.contacts.length)

  for (const c of r.contacts.slice(0, 5)) {
    console.log(c.jid, c.name || c.notify)
  }
})

await client.connectWeb(phone, { syncFullHistory: true })
```

History arrives in chunks over the first minute or so after linking, largest first. Everything is merged into `<phone>.web.history.json` in your session directory, so it survives restarts and you can read it directly.

> [!NOTE]
> `syncFullHistory: false` asks only for recent messages, which links noticeably faster on accounts with years of history.

### Session Files

| File | Holds |
|---|---|
| `<phone>.web.json` | link state — keys, `advSecretKey`, the device slot you were given |
| `<phone>.web.signal.json` | Signal sessions, signed pre-key, identities, LID map, pre-key counters |
| `<phone>.web.pre-key-<id>.json` | one one-time pre-key — 812 of them |
| `<phone>.web.sk.json` | group SenderKeys |
| `<phone>.web.tctoken.json` | privacy tokens |
| `<phone>.web.appState.json` | app-state version and hash per collection |
| `<phone>.appStateKeys.json` | app-state sync keys shared by the phone |
| `<phone>.web.history.json` | synced chats, contacts, push names, LID↔PN mappings |
| `<phone>.web.messages.json` | flat map of message id → message metadata |

The `.web.` prefix keeps a linked session entirely separate from an SMS-registered one for the same number.

### Media in Companion Mode

Uploads and downloads go to the CDN endpoints the web client uses, not the mobile ones. This is handled for you — `sendImage`, `sendVideo`, `sendSticker` and the rest take the same arguments in both modes — but it is worth knowing why the distinction exists.

The web client has no endpoint per media type. A sticker is uploaded to the image endpoint and a GIF to the video one; what makes them a sticker or a GIF lives in the message itself, not in the URL. Uploading a sticker to `/mms/sticker` as a companion gets a 404. The CDN also expects a browser `Origin` on both the upload and the download, and a mobile WhatsApp user agent against a web-issued auth token is a mismatch it can reject.

| Media | Primary endpoint | Companion endpoint |
|---|---|---|
| image | `/mms/image` | `/mms/image` |
| video | `/mms/video` | `/mms/video` |
| audio | `/mms/audio` | `/mms/audio` |
| document | `/mms/document` | `/mms/document` |
| sticker | `/mms/sticker` | `/mms/image` |
| gif | `/mms/gif` | `/mms/video` |
| voice note | `/mms/ptt` | `/mms/audio` |

The same applies to history sync blobs and profile pictures.

### Device Identity

Every message a companion sends that opens a new Signal session carries a `device-identity` node: the signed record the account's primary device issued during pairing, including the account signature key. That is how the recipient's client knows a message from device 7 of an account genuinely belongs to that account rather than to someone who merely knows the number.

whalibmob attaches it automatically whenever a `pkmsg` is in the stanza, in direct messages and in groups alike. A device registered over SMS has no such record — nothing issued one to it — and correctly sends nothing.

### How the Code Protects the Link

The pairing code is a password, not an identifier. It is never sent to the server in the clear. Both sides run it through PBKDF2-SHA256 (131,072 iterations) to derive a key that wraps the ephemeral public keys they exchange, then combine two Diffie-Hellman results into `adv_secret` — the key every later proof of account membership is authenticated under.

whalibmob verifies three things before accepting a link, and refuses it outright if any fails: the HMAC over the signed device identity, the account signature over its own identity key, and the device slot it was issued. A wrong code cannot produce a working link, and a tampered response cannot either.

## Companion Mode — Node.js API

Everything below is the full surface for running whalibmob as a linked device. If you have used the SMS primary API, none of it will surprise you: the client is the same class, the methods take the same arguments, and the events carry the same shapes. Only the way in differs.

### Complete Working Example

A bot that links itself on first run, reconnects silently on every run after that, and replies to messages.

```js
const { WhalibmobClient } = require('whalibmob')
const path = require('path')
const fs   = require('fs')

const PHONE    = '919634847671'                              // no '+', no spaces
const SESS_DIR = path.join(process.env.HOME, '.waSession')

// A session is already linked when this file exists and carries a device JID.
function isLinked() {
  const f = path.join(SESS_DIR, PHONE + '.web.json')
  if (!fs.existsSync(f)) return false
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'))
    return !!(j.registered && j.me && j.me.id)
  } catch { return false }
}

async function start() {
  const client = new WhalibmobClient({ sessionDir: SESS_DIR })

  client.on('pairing_code', ({ code }) => {
    console.log('\n  pairing code:', code.slice(0, 4) + '-' + code.slice(4))
    console.log('  phone → Settings → Linked Devices → Link a device')
    console.log('        → Link with phone number instead\n')
  })

  client.on('paired', ({ jid, lid, deviceIndex, platform }) => {
    console.log('linked as', jid, '· slot', deviceIndex, '· primary is', platform)
  })

  // The server restarts the stream right after pairing. This is normal and the
  // reconnect is automatic — there is nothing to do but log it.
  client.on('restart_required', () => console.log('restarting stream...'))

  client.on('connected', () => console.log('connected'))

  client.on('history_sync', (r) => {
    console.log(`history ${r.syncTypeName}: ${r.chats.length} chats, ${r.contacts.length} contacts`)
  })

  client.on('message', async (msg) => {
    const d = msg.decoded
    if (!d) return
    console.log(msg.from, d.type, d.text || '')

    if (d.type === 'text' && d.text === 'ping') {
      await client.sendText(msg.from, 'pong')
    }
  })

  client.on('error', (e) => console.error('error:', e.message))

  await client.connectWeb(PHONE, { syncFullHistory: true })

  if (!isLinked()) {
    await client.requestPairingCode(PHONE)
  }
}

start()
```

Run it once, type the code into the phone, and it is linked. Run it again and it connects straight away.

### Methods

| Method | Description |
|---|---|
| `client.connectWeb(phone, opts?)` | Open the companion connection. Resolves as soon as the encrypted channel is up when unlinked, or after `<success>` when already linked. |
| `client.requestPairingCode(phone?, customCode?)` | Ask for an 8-character code. Returns it immediately; the link completes later. Throws if the session is already linked. |
| `client.disconnect()` | Close the connection. The link survives — reconnect with `connectWeb()`. |
| `client.logout()` | Unlink this device from the account, the way the Linked Devices screen does, then disconnect. The link does **not** survive — the next `connectWeb()` pairs afresh. Nothing on disk is deleted; remove the session directory yourself if you want the keys gone. |

`connectWeb(phone, opts)` options:

| Option | Default | Description |
|---|---|---|
| `syncFullHistory` | `true` | Ask the phone for the full archive. `false` requests recent messages only and links noticeably faster. |
| `browser` | `['Ubuntu', 'Chrome', '120.0.0.0']` | `[os, client, version]`. The second element picks the icon shown under Linked Devices: `Chrome`, `Firefox`, `Safari`, `Edge`, `Opera`, `Desktop`. |
| `version` | fetched live | Web client revision to announce, e.g. `[2, 3000, 1035194821]`. Set it to pin one. |
| `fetchVersion` | `true` | Set `false` to skip the live lookup and use the pinned fallback. |

#### The Announced Version

The web endpoint checks the client revision during the handshake and refuses an unrecognised one with `<failure reason="405">` — before any stanza is exchanged, and with nothing in the failure to say the version was the problem. The mobile endpoint is far more forgiving; this one is not.

whalibmob therefore reads the live revision from WhatsApp Web's own service worker on each `connectWeb()`, and falls back to a pinned value if that lookup fails. You should not have to think about it, but you can:

```js
const { fetchWaWebVersion } = require('whalibmob')

const { version, isLatest } = await fetchWaWebVersion()
console.log(version, isLatest)   // [2, 3000, 1035194821] true

// pin it yourself
await client.connectWeb(phone, { version: [2, 3000, 1035194821] })

// or skip the lookup entirely
await client.connectWeb(phone, { fetchVersion: false })
```

If you ever see `405`, this is what it means. It is not a revoked session and there is nothing to re-pair — reconnect to pick up the current revision.

`requestPairingCode(phone, customCode)`:

- `phone` — optional; defaults to the number given to `connectWeb`.
- `customCode` — optional; must be **exactly 8 characters** or it throws. Use it to show a code you generated yourself.

### Events

Every event from the SMS primary API fires here too — `message`, `receipt`, `presence`, `group_update`, `call`, `blocklist`, `privacy_settings`, and the rest. These are the ones only companion mode produces:

| Event | Payload | Fires when |
|---|---|---|
| `pairing_code` | `{ code, phoneNumber }` | a code was requested |
| `paired` | `{ jid, lid, deviceIndex, platform }` | the owner accepted the code |
| `restart_required` | `{ reason }` | the server is restarting the stream after pairing — the reconnect is automatic |
| `pair_device` | `{ refs }` | the QR path produced reference strings |
| `history_sync` | `{ syncTypeName, chats, contacts, pushNames, merged }` | a chunk of history arrived |
| `history_sync_error` | `{ err, notification }` | a chunk could not be fetched or decrypted |
| `media_retry` | `{ messageId, chatJid, fromMe, participant, ciphertext, iv, error }` | the sender's phone answered a `requestMediaRetry()`. Read it with `decryptMediaRetry()` and the original media key; an `error` instead of a payload means the phone no longer has the file either |
| `client_rejected` | `{ reason, location, message }` | the server refused the client itself, not the session — `405` means the announced version is not accepted. Fires whether the refusal arrives during the handshake or once the stream is open, and the client stops retrying either way. Distinct from `auth_failure`, and there is nothing to re-pair. |
| `version_update` | `{ from, to, source }` | the announced version was refreshed from the platform's store before a handshake. Fires on reconnects as well as the first connect |
| `apk_material_stale` | `{ materialVersion, liveVersion, hint }` | Android only: the Play Store listing has moved past the APK the cached token material came from. Nothing is broken — registration is what reads that material — but the next number registered from this install would go out under an older build |

### Reading What the Phone Sent

```js
client.on('history_sync', (r) => {
  // r.syncTypeName — INITIAL_BOOTSTRAP | RECENT | FULL | PUSH_NAME | ...
  for (const chat of r.chats) {
    // { id, name, unreadCount, lastMsgTimestamp, messageCount }
    console.log(chat.id, chat.name, chat.unreadCount, chat.messageCount)
  }
  for (const contact of r.contacts) {
    // { id, name, username, pnJid, lidJid }
    console.log(contact.id, contact.name, contact.pnJid, contact.lidJid)
  }
  for (const p of r.pushNames || []) {
    console.log(p.id, p.pushname)
  }
})
```

Chunks arrive over the first minute or so after linking, largest first. Everything is merged into `<phone>.web.history.json`, so you can also read it straight off disk once and skip the event:

```js
const hist = JSON.parse(
  fs.readFileSync(path.join(SESS_DIR, PHONE + '.web.history.json'), 'utf8')
)
console.log(Object.keys(hist.chats || {}).length, 'chats on disk')
```

### Sending

Identical to primary mode — same methods, same arguments, same return shapes:

```js
await client.sendText(jid, 'hello')
await client.sendImage(jid, './photo.jpg', 'a caption')
await client.sendVideo(jid, './clip.mp4', 'watch this')
await client.sendAudio(jid, './voice.ogg', { ptt: true })
await client.sendDocument(jid, './report.pdf', 'report.pdf')
await client.sendSticker(jid, './sticker.webp')
await client.sendLocation(jid, 44.4268, 26.1025, 'Bucharest')
await client.sendContact(jid, 'Ana', vcard)
await client.sendPoll(jid, 'Lunch?', ['Pizza', 'Sushi'], 1)
await client.sendReaction(jid, msgId, '👍')
await client.sendStatus({ image: './photo.jpg', caption: 'hi' })
```

Full signatures for each of these are in [Sending Messages](messaging.md#sending-messages) and [Media Messages](messaging.md#media-messages); nothing about them changes in companion mode.

Groups, blocking, privacy settings and profile changes work the same way too.

> [!NOTE]
> Media uploads go to the endpoints the web client uses, which are not the same as the mobile ones for stickers, GIFs and voice notes. whalibmob switches automatically — see [Media in Companion Mode](#media-in-companion-mode).

### Handling Reconnects

The library reconnects on its own with backoff. What you should handle is the difference between a transient drop and a revoked link:

```js
client.on('disconnected',  ()      => console.log('dropped'))
client.on('reconnecting',  ({ delay }) => console.log('retry in', delay / 1000, 's'))
client.on('reconnected',   ()      => console.log('back'))

// The owner removed this device under Linked Devices. The session is dead —
// delete it and pair again.
client.on('auth_failure', ({ reason }) => {
  console.error('link revoked:', reason)
  fs.rmSync(path.join(SESS_DIR, PHONE + '.web.json'), { force: true })
  process.exit(1)
})
```

### Knowing Which Mode You Are In

```js
console.log(client._mode)              // 'web' or 'mobile'
console.log(client.store.me.id)        // 919634847671:7@s.whatsapp.net
console.log(client.store.me.lid)       // 112713111982325:7@lid
console.log(client.store.deviceIndex)  // 7 — which linked-device slot
console.log(client.store.platform)     // 'android' — what the primary runs
```

`deviceIndex` is what makes a companion a companion. A primary is device 0 and its JID is the bare number; a companion occupies a numbered slot, and the account's own phone becomes a peer it encrypts to like any other device.

### Two Sessions on One Number

A number may be SMS-registered and separately linked as a companion. They never share state — separate files, separate Signal sessions, separate history. Which one you get is decided by the method you call:

```js
await client.init(PHONE)        // mobile / primary, over TCP
await client.connectWeb(PHONE)  // web / companion, over WebSocket
```

Use two `WhalibmobClient` instances if you want both at once.

## Approving a Companion Device (Primary Role)

*Primary-role companion linking contributed by BayLinux.*

The sections above cover this client acting as the **companion** — the device that joins an existing account. This section is the other role: an account you already hold as a **primary** (a mobile session opened with `init`) approving a *separate* companion that presents an 8-digit pairing code or a linked-devices QR. It is the programmatic equivalent of opening **Linked Devices** on the phone and authorising a new device. It runs entirely on the current primary socket and never requests SMS or calls `connectWeb` on this client.

The defining property is restraint: **the client never reports a device as `linked` on the pairing IQ response alone.** A server acknowledgement — including a `retry-ts` nudge or a response that arrives after a timeout — is not treated as success. Approval first reaches `awaiting_confirmation`, and the device only becomes `linked` once an independent companion proof is supplied *and* a freshly fetched server device list confirms the new device and key index. Along the way the approval validates the key binding (optionally against an `expectedNoiseKey` / `expectedIdentityKey` you pass), refuses a replayed code or QR (each is remembered as a salted hash), parses a QR only when it is a well-formed `wa.me/settings/linked_devices` payload, and zeroes the one-time secret as soon as it is used.

### Approve by pairing code

```js
const invitations = client.getPrimaryLinkInvitations(); // bounded, cached pending alerts
const result = await client.approveCompanionCode(code, {
  invitationId: invitations[0].id,          // explicit when more than one is pending
  getCompanionProof: async () => proof       // independent SDK proof; see below
});
// result.status === 'linked'  → result.deviceId / result.keyIndex are set
```

When exactly one unexpired invitation is on the socket you can skip the lookup and let the client wait for it:

```js
const result = await client.linkCompanionWithCode(code, { waitMs: 45000, timeoutMs: 90000 });
```

### Approve by QR

```js
const result = await client.linkCompanionWithQr(qrPayloadOrWaMeUrl, {
  getCompanionProof: async () => proof
});
```

Both QR calls (`linkCompanionWithQr` and its explicit sibling `approveCompanionQr`) run the same proof-and-commit checks as the pairing-code path.

### The `awaiting_confirmation` → reconcile flow

If you do not pass `getCompanionProof`, the call returns as soon as the approval is durably sent:

```js
const result = await client.linkCompanionWithCode(code); // { status: 'awaiting_confirmation', operationId }
// ...obtain the companion's public binding proof out of band...
const confirmed = await client.reconcilePrimaryLink(proof); // verifies signatures + a fresh server list
// confirmed.status === 'linked'
```

`reconcilePrimaryLink` re-verifies the already-sent reservation, both SDK signatures and a fresh server list before confirming — it never replays the pairing request. Progress is observable through the `primary_link_invitation`, `primary_link_progress`, `primary_linked` and `primary_link_error` events, and `getPrimaryLinkStatus()` returns the non-secret durable state at any time.


---

[← Back to the README](../README.md) · [Documentation index](../README.md#documentation)
