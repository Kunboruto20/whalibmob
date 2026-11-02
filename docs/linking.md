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

### Linking WhatsApp Web from the CLI

The CLI runs all of the above for you and then hands the new companion the chat history this program has kept for the number. It works on a number registered through whalibmob, connected as the **primary**. A number connected as a companion cannot approve one (`PRIMARY_LINK_PRIMARY_REQUIRED`); if a number holds both kinds of session and `wa connect` picks the wrong one, add `--sms`. Keep the shell open until the chats have loaded in Web.

```sh
wa connect 447949738354 --session ~/whalibmob_auth
```

**1. Ask for a code on WhatsApp Web.** On Web choose **Link with phone number** and enter the same phone number. Web shows an 8-character code. The shell announces the request as it arrives; the code is good for about three minutes from then (the `code window` counts it down):

```
wa +447949738354>   link request   companion c0ffee01   code window 2:50   id a1a1a1a1
```

**2. Type the code into the shell.** These are all the same code. The dash, the case and a space between the two halves do not matter; a code never contains the letters I, O or U, or the digit 0:

```
wa +447949738354> /link-code ABCD-EFGH
wa +447949738354> /link-code ABCD EFGH
wa +447949738354> /link-code abcdefgh
```

**3. Choose a browser, if asked.** Web sends each request more than once, and every open Web tab adds its own. The shell folds the requests of one browser into one line. With a single browser it goes straight on. With more than one it approves nothing and lists them, newest first (`/link-invitations` shows the same list at any time):

```
more than one browser is asking to link, so nothing was approved. Choose the one this code belongs to.
pairing requests waiting, newest first:
  1  browser deadbe02   1 request   newest id b2b2b2b2b2b2   expires in 2m 53s
  2  browser c0ffee01   1 request   newest id a1a1a1a1a1a1   expires in 2m 48s
  Requests with the same browser label come from one browser (Web sends each more than once).
  The label is a short fingerprint, not proof of who is behind it.
  Choose one by its id (it does not move; 6 or more characters):  /link-code CODE <id>
  or by its number (numbers shift as requests expire):  /link-code CODE <number>
  or close the other Web tabs and wait 3 minutes.
```

Run the command again with the number or the id of the request that belongs to your Web page: `/link-code ABCD-EFGH 2`, or `/link-code ABCD-EFGH a1a1a1`. The browser label is the first 8 hex characters of a hash of the browser's key (`companion` on a `PrimaryLinkInvitation`). It tells requests apart; it does not authorise anything.

**4. Confirm the coverage, if asked.** Before it approves anything, the shell checks that the link can be finished, and what history it would send. If that history is known to be partial (see [What the History Covers](#what-the-history-covers)) it prints what is and is not in it and asks once, naming the browser. Enter, or anything but `y` or `yes`, is no, and nothing is approved:

```
wa +447949738354> /link-code ABCD-EFGH 2
ready to link (first link)
history to send: 12 chats, 340 messages
  capture period             since 2026-09-14 10:00 - the store was switched on then, so anything earlier was never captured
  retained range             2026-09-14 10:05 to 2026-11-02 15:20; 25 older messages were dropped to stay within the store's limits
  known or possible losses   2 received messages could not be decrypted
This is only what this program captured, not everything the account has ever sent or received.
approve the link with browser c0ffee01 (request a1a1a1a1) and send it this history?  [y/N] y
```

When the store has kept everything since registration and dropped nothing, there is no question; it prints one line, `ready to link (first link): 12 chats, 340 messages to send`, and carries on.

**5. What success looks like.**

```
approving with the request a1a1a1a1a1a1...
  link       approval sent, not confirmed with a companion proof
approval sent. The binding to the browser stays unconfirmed unless you confirm it with /link-confirm FILE|JSON (needs the companion's public proof JSON).
sending the stored history to the companion...
history handed to the companion: 12 chats, 340 messages, 20.0 KB (sent inline), first link
capture period: since the store was switched on, after registration, so anything earlier was never captured
25 older messages had been dropped from the store before this
known or possible losses: 1 recorded by the store (messages it saw and could not keep, or a time it was not capturing), so this history is partial
The history is handed over; whether Web has finished showing it cannot be seen from here. If Web stays on "Loading chats", run /link-status.
```

The lines after the first say again, for the record, what the check before the approval found in the history that went: where capture began, how many older messages had been dropped, and how many losses the store had recorded (a run of messages it could not keep counts as one). A history kept whole since registration says `capture period: since registration: the store has been on since this number was registered` and nothing more.

A history over 64 KiB deflated is uploaded rather than sent inline, and the line then reads `(uploaded as a blob)`. The upload has time of its own, outside the 90 seconds the rest of the handover gets: a minute, and a second more for each 16 KiB of history (so an upload slower than about 128 kbit/s), at most 20 minutes. Web should now show the chats. The shell cannot see Web's screen, so "handed over" is all it can claim. Then:

```
wa +447949738354> /linked-devices
linked devices  +447949738354
  #0   this phone (primary)
  #12  companion   key index 3   linked 2026-11-02 15:31 by code   binding unconfirmed   history delivered (12 chats, 340 msgs)
```

`#12` is the companion's device slot, `key index` its place in the account's device list, `linked` the time the approval went through (your local time) and `by code` or `by qr` how. `binding unconfirmed` is normal for a Web link, see [Limits](#limits). `history delivered` gives the chats and messages of the history that was handed over. All of it is kept in the link journal, so it reads the same after a restart. The example numbers are made up.

`/link-status` says where the link stands and what to do next:

```
wa +447949738354> /link-status
link       approval sent, not confirmed with a companion proof, started 2026-11-02 15:31
binding    unconfirmed (no companion proof has been reconciled)
bootstrap  sent
companions #12 key index 3
next       if you have the companion's public proof JSON, run /link-confirm FILE|JSON; if the companion never appeared, /link-retire works once the approval is 5 minutes old
```

`/link-qr PAYLOAD` takes the text a Web QR encodes (or its `https://wa.me/settings/linked_devices#...` link) in place of a code, and the steps after it are the same. Every command is in the [CLI reference](cli.md#companion-commands-approving-whatsapp-web); a link that fails prints what happened, the step to take, and a stable error code to report.

### What the History Covers

The history is the **primary message store**: a record, kept on disk beside the session, of the messages this program sent and received for the number. It is not a copy of everything the account has ever had.

- **Since when.** Only what the store kept since it began. For a number registered here with the CLI, the store starts at registration, and the shell says `since registration`. For any other number it starts the first time the number is connected with the store on, and the shell says `the store was switched on then, so anything earlier was never captured`. The CLI keeps the store unless you pass `--no-message-store`; the library does not (see [the library API](#library-api-for-the-chat-history)). Registering a number again starts a new store; the earlier one is set aside, kept and never handed over (see [Sessions](accounts-sessions.md#files-the-primary-keeps-for-linked-companions)).
- **How much.** Retention defaults to **100 messages per chat and 20 000 in all**. Past a limit the oldest go first: within a chat, its oldest message; for the 20 000 in all, from the chat that has been quiet longest. The shell reports how many were dropped.
- **What it knows it lost** is reported, not hidden: a received message that could not be decrypted, one that was seen and never saved (the program stopped in between), and a stretch during which the store was not open (a run with `--no-message-store`, or a client that did not have `messageStore` on).
- **When it asks.** `getPrimaryLinkReadiness()` sets `needsConfirmation`, and the shell asks `[y/N]`, unless the store has kept everything since registration with no known loss and nothing dropped. A store switched on later, an origin it cannot tell, any loss, or any dropped message all ask. In practice a chat past 100 messages makes every link ask.
- **Whole contacts.** A contact the store saw both by phone number and by LID goes over as one conversation, as the phone shows it. Edits are applied to the message they edit, a message deleted for everyone is buried as described below, and one you delete for yourself with this program is dropped.
- **Media.** The files are not stored. A media message goes over as the message, with the keys it carries; whether Web can still fetch the file depends on WhatsApp's servers still holding it.

The store holds message content on disk, unencrypted, in files only you can read (mode `0600`) in the session folder. Treat that folder the way you already treat its keys.

#### Never transferred

- **Revoked, expired and view-once content.** It is dropped from the store the moment it is known and is never handed to a companion. A message deleted for everyone goes over as a deleted-message marker (its id and time, none of what it said). An expired disappearing message and a view-once message are left out entirely. View-once bytes are never written to the store's files at all. A message's bytes as first received can stay in the store's append-only log (`<phone>.primary-messages.log`) until its next compaction, which happens when the store is closed on disconnect or when the log passes about 1 MiB or 5 000 lines; after that they are gone from the files.
- **Reactions and poll votes.** They are skipped: not stored, so they do not appear on the new device.
- **Status posts and channels.** Not kept.

#### Limits

- **A message of a type the library does not decode** is kept exactly as it was received and handed over unchanged. Web reads it itself; what Web then shows is Web's doing.
- **A second companion while one is still linked is not supported.** The history can only be handed to the first and only companion. `/link-code` and `/link-qr` check this first and refuse (`PRIMARY_BOOTSTRAP_EXISTING_COMPANIONS_UNSUPPORTED`) before anything is approved; log the first one out of Web (Menu → Log out), wait until `/linked-devices` no longer lists it, then link again.
- **The binding stays "unconfirmed" unless a companion's public proof JSON is reconciled** with `/link-confirm FILE|JSON`. The proof is the companion's own signed binding between its device and your account; the JSON carries its public parts only, and `/link-confirm` checks both signatures and a fresh device list before it reports `confirmed`. Standard WhatsApp Web is not known to offer such a proof, so with an ordinary browser expect the binding to stay unconfirmed. That is not a failed link: `/linked-devices` shows the companion WhatsApp's device list reports. It means this program has not independently tied that device to the browser you approved.
- **What Web does with it cannot be seen from here.** "Handed over" is the shell's claim, not "Web finished loading".
- **The `delta` option is experimental.** It would send what reached the store after the history was cut, as a second chunk. It has not been verified on real WhatsApp Web, and the CLI never uses it.

### Linking Again

Web can be linked again after it has been logged out, and gets the history again. The shell calls it a re-link, and it reuses the app-state key it shared the first time.

1. Log out on Web (Menu → Log out).
2. Wait until `/linked-devices` no longer lists the companion (`no companion linked`).
3. Run `/link-retire`. An approval that was never confirmed leaves a hold behind, which refuses any new approval (`PRIMARY_LINK_RECONCILIATION_REQUIRED`); `/link-retire` clears it. It works 5 minutes after the approval, and only when the companion is gone from the device list; sooner it says `The unfinished approval is less than 5 minutes old`, and while the companion is still listed it refuses. It never removes a device. An approval that was confirmed leaves no hold, and this step is not needed.
4. Run `/link-code` again, with a new code from Web. Each code works once.

```
wa +447949738354> /linked-devices
linked devices  +447949738354
  #0   this phone (primary)
  no companion linked
wa +447949738354> /link-retire
retired the unfinished approval (operation 0f0e0d0c); nothing was linked
link       retired; nothing was linked, started 2026-11-02 15:31
binding    unconfirmed (no companion proof has been reconciled)
bootstrap  sent
companions none
```

The shell then says `re-link` where it said `first link`. The history is whatever the store holds now, so it includes what was kept since the first link.

### When Something Stops Part-Way

An approval and the handover of the history are two steps. If the second one stops, the approval stands and Web waits on "Loading chats" until the history is sent. `/link-status` says how far it got and what to do. Do not approve again for a handover that stopped.

```
/link-bootstrap                          send the history for an approved companion, once
/link-bootstrap --resume                 continue the last attempt after its last accepted step
/link-bootstrap --resume --resend-uncertain
                                         also send once more a step whose reply never came
```

There is no blind resend. A plain `/link-bootstrap` after an attempt is refused as already attempted (`PRIMARY_BOOTSTRAP_ALREADY_ATTEMPTED`); `--resume` continues the recorded attempt instead, and is harmless when none was recorded. A step that was sent and never answered stops the attempt with `PRIMARY_BOOTSTRAP_KEY_SHARE_UNCERTAIN` or `PRIMARY_BOOTSTRAP_HISTORY_UNCERTAIN`; only `--resend-uncertain` sends it again, under the same message id. A step the other side **refused** is never sent again; the shell then tells you to start over (log out on Web, `/linked-devices`, `/link-retire`, `/link-code` with a new code). A dropped connection mid-handover leaves the link uncertain and `--resume` continues it. `--resend-uncertain` on its own counts as a resume, and the shell says so.

#### Testing an interrupted handover

To check a resume by hand, the bootstrap can be made to stop at a phase of your choosing. Set `WA_DEBUG_BOOTSTRAP_STOP_AFTER` to the phase, and the program kills itself the moment that phase is written to the link journal: the same as `kill -9`, with no cleanup, so what is left on disk is what a real crash leaves.

```sh
WA_DEBUG_BOOTSTRAP_STOP_AFTER=history_uploaded wa connect 447949738354
# /link-code ...   the program dies right after the history blob is uploaded and recorded
wa connect 447949738354
# /link-bootstrap --resume   sends the same pinned bytes
```

The phases, in order: `prepared`, `key_share_sending`, `key_share_accepted`, `critical_patch_sending`, `critical_patch_accepted`, `history_prepared`, `history_uploaded` (a blob only), `history_sending`, `history_accepted`, then `delta_prepared`, `delta_uploaded`, `delta_sending` and `delta_accepted` (the experimental delta only), and `sent`. A re-link has no `critical_patch_*` phases. Only one of these names turns it on; anything else, or the variable unset, does nothing. A stop at `key_share_sending`, `history_sending` or `delta_sending` comes before that message goes out, and the resume then stops with `..._UNCERTAIN` and asks for `--resend-uncertain`; a stop at `critical_patch_sending` is settled on resume by reading the server's copy back. The restarted program takes the journal's lock over by itself, as after any crash on the same machine. It is a testing aid: never leave it set.

The link journal (`<phone>.primary-linking.json`) is guarded by a lock file beside it, so that two programs cannot write it at once. When a program dies holding it:

- **A dead holder on the same machine is recovered automatically.** The lock names its holder's process, machine, boot and process namespace; when all of those match this machine and the process is gone, the next program takes the lock over without being asked.
- **Anything else is reported as busy, with the holder, and left alone.** A holder on another machine or in another container, a lock from an older version, and a process that is merely paused cannot be proven dead from here:

  ```
  error: Another process (pid 4242 on old-box, since 2026-11-02 15:31) holds the link journal for this number.
    next: Close that program; if it is gone for good (another machine or container, or an old lock), run /link-unlock to break the lock.
    (PRIMARY_LINK_STORE_BUSY)
  ```

- **`/link-unlock` shows the holder and breaks the lock only when you say yes.** Check that the holder is really gone: a holder that is in fact still running finds its lock gone at its next write and stops there (`PRIMARY_LINK_STORE_LOST`), with the journal intact. Enter, or anything but `y` or `yes`, leaves the lock as it is. What is broken is the holder you were shown: if another program has taken the lock by the time you answer, nothing is broken and that one is reported instead. It refuses while this very program holds the journal (`PRIMARY_LINK_BUSY`), and a recovery that is still running on this machine is told to wait a minute and unlock again.

  ```
  wa +447949738354> /link-unlock
  the link journal is locked by pid 4242 on old-box, since 2026-11-02 15:31
    Break it only if that program is gone: stopped, or on a machine or in a container that no longer runs it.
    A program that is in fact still running stops at its next write to the journal, which is left intact.
  break the lock held by pid 4242 on old-box?  [y/N] y
  broke the link journal lock held by pid 4242 on old-box
    next: retry the command that reported the journal busy
  ```

### Library API for the Chat History

The CLI is a thin layer over these. The store is **off by default in the library**; the CLI turns it on.

```js
const { WhalibmobClient } = require('whalibmob')

// true keeps the defaults (100 messages a chat, 20 000 in all); an object bounds them
const client = new WhalibmobClient({
  sessionDir,
  messageStore: { perChat: 200, maxMessages: 50000 }
})
client.on('primary_message_store_error', ({ code, op }) => console.warn('store:', code, op))
await client.init('447949738354')   // primary sessions only; a companion never opens one

const kept = client.getPrimaryMessageStore()
// null when the store is off, before the first login, after disconnect(), or if it could not be read;
// otherwise { seq, capture: { since, origin, lc }, chats, records, losses, retained: { evicted }, pushNames, counts }
// `records` holds the message bytes, so treat it like the files it is read from.

const verdict = await client.getPrimaryLinkReadiness()
// { ready, mode: 'first' | 'relink' | null, blockers: [{ code, detail }], history, needsConfirmation }
// Read-only: it approves nothing, sends nothing and writes no link state.
if (!verdict.ready) throw new Error(verdict.blockers.map(b => b.code).join(', '))
if (verdict.needsConfirmation) { /* show verdict.history and ask before going on */ }

const [invitation] = client.getPrimaryLinkInvitations()   // { id, expiresAt, companion }
await client.approveCompanionCode(code, { invitationId: invitation.id })
const sent = await client.bootstrapPrimaryCompanion({ history: 'store' })
// { status: 'sent', mode, operationId, delta, history: { chats, records, bytes, inline, losses, evicted, captureOrigin } }
```

| Call | What it does |
|---|---|
| `messageStore` (client option) | Off unless `true` or `{ perChat, maxMessages }`. Without it `bootstrapPrimaryCompanion({ history: 'store' })` throws `PRIMARY_MESSAGE_STORE_DISABLED` and readiness reports a blocker. |
| `getPrimaryMessageStore()` | The store's snapshot, or `null`. Never throws; a failure is said on `primary_message_store_error`. |
| `getPrimaryLinkReadiness({ timeoutMs, signal })` | Whether a link can be finished, found out before anything is approved. Each blocker has a stable `code` and a `detail`. |
| `bootstrapPrimaryCompanion({ history, upload, resume, resendUncertain, delta, timeoutMs, uploadTimeoutMs })` | The key share, the app-state patch and the history. `history: 'store'` reads this client's store; a function returning a snapshot sends a history of your own. `upload` is used only above 64 KiB deflated and defaults to the `md-msg-hist` media upload. `resume` and `resendUncertain` are as above. `delta` is experimental and not verified on real Web. `timeoutMs` (1 000 to 90 000, default 90 000) is the time for everything but the upload (`PRIMARY_LINK_TIMEOUT`); the upload runs on a clock of its own, `uploadTimeoutMs` (1 000 to 3 600 000), by default a minute plus a second for each 16 KiB, at most 20 minutes (`PRIMARY_BOOTSTRAP_UPLOAD_TIMEOUT`). An error from a bootstrap that had started carries `resumable`: whether `resume: true` can go on from where it stopped; `getPrimaryLinkStatus().bootstrap.resumable` says the same. |
| `getPrimaryLinkLockHolder()` | Who holds the link journal lock, read without breaking it: `{ holder }`, `null` when none is held. Throws `PRIMARY_LINK_BUSY` while this process holds the journal. |
| `unlockPrimaryLink({ holder })` | Breaks the link journal lock, as `/link-unlock` does after its yes. With `holder` (as `getPrimaryLinkLockHolder()` returned it), only that holder: a lock that names another one by then is left alone, with `PRIMARY_LINK_STORE_BUSY` and `err.holder`. Returns `{ holder }` (`null` when none was held) and throws `PRIMARY_LINK_BUSY` while this process holds the journal. |
| `getPrimaryLinkInvitations()` | Each pending request carries `companion`, the browser's short fingerprint (`null` when the request has none). A label, never authorisation. |

A store started by `init()` counts as switched on at that moment (`origin: 'enabled'`). To have the store count as kept "since registration", as the CLI does, open it once at registration time:

```js
const { sessionDirFor, Primary } = require('whalibmob')
const { PrimaryMessageStore } = Primary.MessageStore
PrimaryMessageStore.open({ dir: sessionDirFor(base, phone), phone, origin: 'registration', lc: store.connectionLc || 0 }).close()
```

The package also exports the pieces: `Primary.MessageStore` (`PrimaryMessageStore`, `STATUS`), `Primary.HistoryExport` (`buildHistorySync`, `buildNotification`, `recordsAfter`, `exportedCounts`) and `Primary.Readiness` (`evaluateReadiness`, `gatherFacts`), and `Cli.LinkCommands`, the logic behind the CLI's link commands with no terminal in it, for a front end of your own:

```js
const { Cli } = require('whalibmob')
const result = await Cli.LinkCommands.runLinkCode({
  client, code: 'ABCD-EFGH',
  selector: undefined,                                   // a group number or an id prefix, when more than one browser is asking
  confirm: async (readiness, ask) => askTheUser(ask.question),  // called only when the history is partial; no function is a no
  print: line => console.log(line)
})
// result.status: 'sent' | 'choose' (several browsers, nothing approved) | 'aborted'
```


---

[← Back to the README](../README.md) · [Documentation index](../README.md#documentation)
