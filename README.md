<div align='center'>whalibmob is a pure JavaScript Node.js library for interacting with the WhatsApp Mobile API.</div>
<div align='center'>v5.1.14</div>

##

> [!IMPORTANT]



CONTACT ME ON TELEGRAM  IF YOU WANT TO WORK WITH ME AND IF YOU HAVE PROBLEM WITH WHALIBMOB : @brtyu545

TELEGRAM NEW WHALIBMOB CHANNEL JOIN HERE https://t.me/+jWzq-I9o0Xc1Mzc8





> [!CAUTION]
> Use a dedicated phone number with this library. Connecting with a number that is already active on a real device will cause WhatsApp to log that device out.

> [!CAUTION] 
> Whalibmob now It needs to be rewritten because WhatsApp mobile and has changed the protocol lately and now whalibmob is in testing and some updates by Me Any pull request is accepted. 


> [!IMPORTANT] 
> If you like what I do and want to support me I can leave you here my Crypto usdc address for any donation and support any Small donation is accepted because the WhatsApp protocol changes very often : "0x8AD64F47a715eC24DeF193FBb9aC64d4E857f0f3"
 
Usdc ethereum network.






> [!IMPORTANT]
> This project is not affiliated, associated, authorized, endorsed by, or in any way officially connected with WhatsApp or any of its subsidiaries or affiliates. "WhatsApp" and related names are registered trademarks of their respective owners. Use at your own discretion.

- whalibmob does not require a browser, Selenium, or any other external runtime — it communicates directly with WhatsApp using a **TCP socket** and the **Noise Protocol** handshake.
- The library operates as a real **iOS mobile device**, not as WhatsApp Web. It uses the Mobile API endpoint, which behaves differently from the Web API.
- Signal Protocol encryption is **fully inlined** in pure JavaScript — no native binaries, no node-gyp, runs anywhere Node.js runs.

## Install

```sh
npm install whalibmob
```

Install the CLI globally:

```sh
npm install -g whalibmob
```

## Index

- [CLI — Getting Started](#cli--getting-started)
  - [Install the CLI](#install-the-cli)
  - [First-Time Setup: Register a Number](#first-time-setup-register-a-number)
  - [Connect](#cli-connect)
  - [Listen Mode](#listen-mode)
- [CLI — Interactive Shell Commands](#cli--interactive-shell-commands)
  - [Messaging Commands](#messaging-commands)
    - [Send Text](#send-text)
    - [Send Image](#send-image)
    - [Send Video](#send-video)
    - [Send Audio](#send-audio)
    - [Send Voice Note](#send-voice-note)
    - [Send Document](#send-document)
    - [Send Sticker](#send-sticker)
    - [Send Poll](#send-poll-cli)
    - [React to a Message](#react-to-a-message)
    - [Edit a Message](#edit-a-message)
    - [Delete a Message](#delete-a-message)
    - [Post a Status / Story](#post-a-status--story)
    - [Forward a Message](#forward-a-message)
    - [Reply to a Message](#reply-to-a-message-cli)
    - [Send Location](#send-location-cli)
    - [Send Contact / vCard](#send-contact--vcard-cli)
  - [Presence Commands](#presence-commands)
    - [Set Online / Offline](#set-online--offline)
    - [Typing and Recording Indicators](#typing-and-recording-indicators)
    - [Subscribe to a Contact's Presence](#subscribe-to-a-contacts-presence)
  - [Profile Commands](#profile-commands)
    - [Change Display Name](#cli-change-display-name)
    - [Change About Text](#cli-change-about-text)
    - [Change Profile Picture](#cli-change-profile-picture)
    - [Change Privacy Settings](#cli-change-privacy-settings)
  - [Contact Commands](#contact-commands)
    - [Check Who Has WhatsApp](#check-who-has-whatsapp)
    - [Get Profile Picture URL](#get-profile-picture-url)
    - [Get Contact About Text](#get-contact-about-text)
  - [Chat Management Commands](#chat-management-commands)
    - [Mark Read / Unread](#mark-read--unread)
    - [Mute / Unmute](#mute--unmute)
    - [Pin / Unpin](#pin--unpin)
    - [Archive / Unarchive](#archive--unarchive)
    - [Star / Unstar a Message](#star--unstar-a-message-cli)
    - [Disappearing Messages](#cli-disappearing-messages)
    - [Default Disappearing Timer](#default-disappearing-timer)
    - [Block / Unblock](#block--unblock)
    - [Show Block List](#show-block-list)
  - [Group Commands](#group-commands)
    - [Create a Group](#cli-create-a-group)
    - [Leave a Group](#cli-leave-a-group)
    - [Add / Remove Participants](#add--remove-participants)
    - [Promote / Demote Admins](#promote--demote-admins)
    - [Change Group Name](#change-group-name)
    - [Change Group Description](#change-group-description)
    - [Change Group Picture](#change-group-picture)
    - [Get Invite Link](#get-invite-link)
    - [Revoke Invite Link](#revoke-invite-link)
    - [Join a Group by Invite Code](#join-a-group-by-invite-code)
    - [Query Group Invite Info](#query-group-invite-info)
    - [List All Groups](#list-all-groups)
    - [Query Group Metadata](#query-group-metadata)
    - [List Group Participants](#list-group-participants)
    - [Pending Join Requests](#pending-join-requests)
    - [Approve / Reject Join Requests](#approve--reject-join-requests)
    - [Group Settings](#group-settings)
  - [Community Commands](#community-commands-cli)
  - [Newsletter / Channel Commands](#newsletter-channel-commands)
  - [Business Profile Command](#business-profile-command-cli)
  - [Registration Commands (in-shell)](#registration-commands-in-shell)
  - [Connection Commands (in-shell)](#connection-commands-in-shell)
  - [Full Command Reference Table](#full-command-reference-table)
- [Library API](#library-api)
  - [Connecting Account](#connecting-account)
    - [Register a New Number](#register-a-new-number)
    - [Device Attestation with Frida (optional)](#device-attestation-with-frida-optional)
    - [Connect](#connect)
  - [Saving & Restoring Sessions](#saving--restoring-sessions)
  - [Signal Store Utilities](#signal-store-utilities)
    - [makeCacheableSignalKeyStore](#makecacheablesignalkeystore)
    - [addTransactionCapability](#addtransactioncapability)
    - [assertMeId](#assertmeid)
    - [initAuthCreds](#initauthcreds)
  - [Handling Events](#handling-events)
    - [Example to Start](#example-to-start)
    - [All Events](#all-events)
  - [History Sync](#history-sync)
    - [How It Works](#how-history-sync-works)
    - [Listening to History Sync Events](#listening-to-history-sync-events)
    - [Persistent Files Written to Disk](#persistent-files-written-to-disk)
    - [Reading the History Store](#reading-the-history-store)
    - [tcToken — Error 463 Defense](#tctoken--error-463-defense)
    - [What Is Automatic vs What You Need to Do](#what-is-automatic-vs-what-you-need-to-do)
  - [Receiving Media](#receiving-media)
  - [Sending Messages](#sending-messages)
    - [Text Message](#text-message)
    - [Quote Message](#quote-message)
    - [Mention User](#mention-user)
    - [Reaction Message](#reaction-message)
    - [Edit Message](#edit-message)
    - [Delete Message](#delete-message)
    - [Forward Message](#forward-message)
    - [Poll](#poll)
    - [Quoted Reply](#quoted-reply)
    - [Location Message](#location-message)
    - [Contact Message (vCard)](#contact-message-vcard)
    - [Media Messages](#media-messages)
      - [Image Message](#image-message)
      - [Video Message](#video-message)
      - [Audio Message](#audio-message)
      - [Voice Note](#voice-note)
      - [Document Message](#document-message)
      - [Sticker Message](#sticker-message)
    - [Status / Stories](#status--stories)
  - [Send States in Chat](#send-states-in-chat)
    - [Reading Messages](#reading-messages)
    - [Mark Voice Message Played](#mark-voice-message-played)
    - [Update Presence](#update-presence)
  - [Modifying Chats](#modifying-chats)
    - [Archive / Unarchive a Chat](#archive--unarchive-a-chat)
    - [Mute / Unmute a Chat](#mute--unmute-a-chat)
    - [Mark a Chat Read / Unread](#mark-a-chat-read--unread)
    - [Pin / Unpin a Chat](#pin--unpin-a-chat)
    - [Star / Unstar a Message](#star--unstar-a-message)
    - [Disappearing Messages](#disappearing-messages)
  - [User Queries](#user-queries)
    - [Check If a Number Has WhatsApp](#check-if-a-number-has-whatsapp)
    - [Fetch Profile About](#fetch-profile-about)
    - [Fetch Profile Picture](#fetch-profile-picture)
    - [Subscribe to Presence](#subscribe-to-presence)
  - [Change Profile](#change-profile)
    - [Change Display Name](#change-display-name)
    - [Change About Text](#change-about-text)
    - [Change Profile Picture](#change-profile-picture)
  - [Privacy](#privacy)
    - [Block / Unblock User](#block--unblock-user)
    - [Get Block List](#get-block-list)
    - [Update Privacy Settings](#update-privacy-settings)
    - [Update Default Disappearing Mode](#update-default-disappearing-mode)
  - [Communities](#communities)
    - [Create a Community](#create-a-community)
    - [Deactivate / Delete a Community](#deactivate--delete-a-community)
    - [Link Groups into a Community](#link-groups-into-a-community)
    - [Unlink a Group from a Community](#unlink-a-group-from-a-community)
  - [Newsletters (Channels)](#newsletters-channels)
    - [Create a Newsletter](#create-a-newsletter)
    - [Join / Leave a Newsletter](#join--leave-a-newsletter)
    - [Query Newsletter Metadata](#query-newsletter-metadata)
    - [Update Newsletter Description](#update-newsletter-description)
    - [Post a Text Update to Your Newsletter](#post-a-text-update-to-your-newsletter)
  - [Business Profile](#business-profile)
  - [Groups](#groups)
    - [Create a Group](#create-a-group)
    - [Add / Remove or Demote / Promote](#add--remove-or-demote--promote)
    - [Change Subject](#change-subject)
    - [Change Description](#change-description)
    - [Change Settings](#change-settings)
    - [Leave a Group](#leave-a-group)
    - [Get Invite Code](#get-invite-code)
    - [Revoke Invite Code](#revoke-invite-code)
    - [Join Using Invitation Code](#join-using-invitation-code)
    - [Query Invite Info from Link](#query-invite-info-from-link)
    - [Fetch All Groups](#fetch-all-groups)
    - [Query Metadata](#query-metadata)
    - [Get Request Join List](#get-request-join-list)
    - [Approve / Reject Request Join](#approve--reject-request-join)
    - [Toggle Ephemeral in Group](#toggle-ephemeral-in-group)
- [WhatsApp IDs](#whatsapp-ids)
- [Transport](#transport)
- [Media Encryption](#media-encryption)
- [Device Emulation](#device-emulation)
  - [Quick Start](#device-quick-start)
  - [iOS Profiles](#ios-profiles)
  - [Android Profiles](#android-profiles)
  - [Custom Device Fields](#custom-device-fields)
  - [Version & Token Overrides](#version--token-overrides)

---

## Library API

## Connecting Account

### Register a New Number

Registration is a one-time process. You need a phone number that can receive an SMS or voice call.

**Step 1 — request a verification code**

```js
const {
  createNewStore, saveStore, requestSmsCode
} = require('whalibmob')
const path = require('path')
const fs   = require('fs')

const phone    = '919634847671'           // country code + number, no '+'
const sessDir  = path.join(process.env.HOME, '.waSession')
const sessFile = path.join(sessDir, phone + '.json')

fs.mkdirSync(sessDir, { recursive: true })

const store = createNewStore(phone)
saveStore(store, sessFile)

await requestSmsCode(store, 'sms')   // 'sms' | 'voice' | 'wa_old'
```

**Step 2 — verify the code**

```js
const { loadStore, saveStore, verifyCode } = require('whalibmob')

const store  = loadStore(sessFile)
const result = await verifyCode(store, '123456')

if (result.status === 'ok') {
  saveStore(result.store, sessFile)
  console.log('registered')
}
```

### Device Attestation with Frida (optional)

WhatsApp's registration servers score every `/code` and `/register` request on how
much it looks like a genuine phone. A real device proves itself with a hardware
attestation token — **Play Integrity** plus a **Keystore**-signed request on
Android, **App Attest** on iOS. whalibmob sends these fields on every registration
request, but it can only fill them with real values if it can talk to an actual
device.

This repository ships a **`frida/` folder** containing the on-device scripts that
produce those tokens. It is entirely **optional**: with no device attached,
whalibmob sends the same empty attestation fields a real phone sends when its
integrity check fails, and registration still works. Attaching a device raises the
trust score, which helps when you keep hitting `no_routes` or block screens.

> Requires a **rooted Android phone** or a **jailbroken iPhone** with the official
> WhatsApp app installed from the Play Store / App Store. Sideloaded APKs do not
> work — the attestation is bound to the store-signed build.

#### What's in the folder

```
frida/
  android/     Play Integrity + Keystore attestation server  (/integrity, /cert, /info)
  ios/         App Attest attestation server                 (/integrity)
```

Each platform folder has its own `README.md` with the full device prerequisites.

#### 1. Build the script

Install [Frida](https://frida.re) on your computer, then build the bundle for your
platform:

```bash
cd frida/android      # or: cd frida/ios
npm install
npm run build         # produces server_with_dependencies.js
```

#### 2. Run it on the device

Make sure the Frida server is running on the phone, then attach to WhatsApp:

```bash
# Android — open WhatsApp and reach the "register a number" screen FIRST,
# otherwise the integrity components are not loaded yet
frida -U "WhatsApp" -l server_with_dependencies.js

# iOS
frida -U -l server_with_dependencies.js -f "net.whatsapp.WhatsApp"
```

The script starts a small HTTP server **on the phone**, listening on port `1119`
(or `1120` if you attached to WhatsApp Business). Wait for:

```
[*] Server ready on port 1119
```

#### 3. Make the port reachable

whalibmob talks to that server over plain HTTP, so the port has to be reachable
from the machine running your bot. Over USB, forward it with adb:

```bash
adb forward tcp:1119 tcp:1119     # Android
iproxy 1119 1119                  # iOS (libimobiledevice)
```

Alternatively, if the phone is on the same Wi-Fi, use its LAN IP directly.

#### 4. Point whalibmob at it

Set the host — and the port, if it isn't the default `1119`:

```bash
WA_FRIDA_HOST=127.0.0.1
WA_FRIDA_PORT=1119        # optional; use 1120 for WhatsApp Business
```

Or in `.env`:

```
WA_FRIDA_HOST=127.0.0.1
WA_FRIDA_PORT=1119
```

That is the whole integration. On the next `requestSmsCode()` / `verifyCode()`
call, whalibmob queries the device automatically and attaches the attestation to
the request:

| Platform | Fields it fills                                                    |
|----------|--------------------------------------------------------------------|
| Android  | `gpia` (Play Integrity) in the body, plus a Keystore signature and certificate chain on the request |
| iOS      | An App Attest assertion and attestation on the request              |

Keep the Frida session open while you register. When you unset `WA_FRIDA_HOST`,
whalibmob silently goes back to the empty-attestation path — no code changes, and
nothing else in your bot is affected.

> **Troubleshooting.** If the fields come back empty, check in this order: the
> Frida session is still attached, the port is forwarded, and — on Android — that
> you opened WhatsApp's registration screen at least once before attaching, since
> the integrity components are lazy-loaded. whalibmob never fails a registration
> because attestation is unavailable; it just falls back to empty values.

### Connect

```js
const { WhalibmobClient } = require('whalibmob')
const path = require('path')

const client = new WhalibmobClient({
  sessionDir: path.join(process.env.HOME, '.waSession')
})

client.on('connected', () => {
  console.log('connected')
})

await client.init('919634847671')
```

## Saving & Restoring Sessions

Sessions are automatically persisted to disk as JSON files under the `sessionDir` you provide. The file is named `<phone>.json`. On the next `client.init()` call the session is restored and no re-registration is needed.

```js
const client = new WhalibmobClient({
  sessionDir: path.join(process.env.HOME, '.waSession')
})

// no need to register again — just connect
await client.init('919634847671')
```

> [!NOTE]
> Each phone number uses its own session file. The library handles Signal Protocol key persistence automatically.

## Signal Store Utilities

`auth-utils` is a collection of optional helpers for power users who manage their own `SignalStore` instances directly (e.g. custom storage backends, multi-account servers).

```js
const {
  makeCacheableSignalKeyStore,
  addTransactionCapability,
  assertMeId,
  initAuthCreds
} = require('whalibmob')
```

### `makeCacheableSignalKeyStore`

Wraps a `SignalStore` with an in-memory NodeCache layer (5-minute TTL). All `get` calls for `sessions`, `preKeys`, `signedPreKeys`, and `identities` are served from cache on subsequent accesses. Writes invalidate the cache automatically.

`useClones` is set to `false` so that `SessionRecord` objects — which carry internal state and methods — are returned by reference and never deep-cloned.

The wrapper also forwards `transaction()` and `isInTransaction()` calls to the underlying store when present, making it safe to stack with `addTransactionCapability`.

```js
const { SignalStore } = require('whalibmob')
const { makeCacheableSignalKeyStore } = require('whalibmob')

const store  = new SignalStore(/* ... */)
const cached = makeCacheableSignalKeyStore(store)

// reads hit cache after first access
const session = await cached.getSession('919634847671@s.whatsapp.net:0')
```

**When to use:** whenever your `SignalStore` is backed by a remote or disk-based store (database, Redis, file system) and you want to reduce repeated lookups for sessions that haven't changed between sends.

### `addTransactionCapability`

Wraps a `SignalStore` with batched-write (transaction) semantics. During a transaction all writes are buffered in memory; they are flushed to the underlying store atomically when `commit()` is called at the end of the transaction.

Uses `AsyncLocalStorage` to propagate transaction context across async call chains, and a per-key-type `Mutex` with reference-counting to serialize concurrent writers safely.

```js
const { addTransactionCapability, makeCacheableSignalKeyStore } = require('whalibmob')

// recommended: cache first, then transactions on top
const base        = new SignalStore(/* ... */)
const cached      = makeCacheableSignalKeyStore(base)
const txnStore    = addTransactionCapability(cached)

// inside a send flow
await txnStore.transaction(async () => {
  // all writes are buffered
  await txnStore.setSession('919634847671@s.whatsapp.net:0', sessionRecord)
  await txnStore.setPreKey(1, preKeyPair)
  // commit is called automatically at the end of the transaction callback
})
```

Stacking order matters: put `makeCacheableSignalKeyStore` below `addTransactionCapability` so that the cache always sees the committed state.

**When to use:** for high-throughput servers that send to many recipients concurrently and need to batch Signal key writes into a single atomic flush per message.

### `assertMeId`

Validates that a store object has a registered phone number and returns the canonical `@s.whatsapp.net` JID. Throws an `Error` if the store lacks a `phoneNumber` or has `registered !== true`.

```js
const { assertMeId } = require('whalibmob')

const store = loadStore(sessFile)

try {
  const jid = assertMeId(store)
  // jid === '919634847671@s.whatsapp.net'
  console.log('account JID:', jid)
} catch (err) {
  console.error('store is not registered:', err.message)
}
```

**When to use:** as a guard before calling `client.init()` to give a clear error message when a corrupted or unregistered session file is accidentally loaded.

### `initAuthCreds`

Creates a fresh credential store for the given phone number. Functionally equivalent to `createNewStore` but also initialises the Baileys-compatible extra fields that the library expects for account sync: `nextPreKeyId`, `firstUnuploadedPreKeyId`, `accountSyncCounter`, `accountSettings`, and `advSecretKey`.

```js
const { initAuthCreds, saveStore } = require('whalibmob')
const path = require('path')
const fs   = require('fs')

const phone    = '919634847671'
const sessDir  = path.join(process.env.HOME, '.waSession')
const sessFile = path.join(sessDir, phone + '.json')

fs.mkdirSync(sessDir, { recursive: true })

const store = initAuthCreds(phone)
saveStore(store, sessFile)
```

This is the function used internally by the CLI for all new session creation. Prefer it over `createNewStore` for forward compatibility.

> [!NOTE]
> `initAuthCreds` and `createNewStore` produce equivalent stores for all current library operations. The additional fields from `initAuthCreds` are there for future-proofing and interoperability.

### Recommended Stacking Pattern

For a production multi-account server:

```js
const {
  SignalStore,
  makeCacheableSignalKeyStore,
  addTransactionCapability,
  initAuthCreds,
  saveStore,
  loadStore
} = require('whalibmob')

// 1. load or create the credential store
let store = loadStore(sessFile) || initAuthCreds(phone)

// 2. build the layered Signal key store
const signalStore = new SignalStore(store)
const cachedStore = makeCacheableSignalKeyStore(signalStore)
const txnStore    = addTransactionCapability(cachedStore)

// 3. pass to the client (advanced usage — most users should use WhalibmobClient directly)
```

For standard usage, `WhalibmobClient` handles all of this internally. These helpers are for advanced scenarios where you need direct control over Signal key storage.

## Handling Events

whalibmob uses the EventEmitter syntax for events.

### Example to Start

```js
const { WhalibmobClient } = require('whalibmob')
const path = require('path')

async function connect() {
  const client = new WhalibmobClient({
    sessionDir: path.join(process.env.HOME, '.waSession')
  })

  client.on('connected', async () => {
    console.log('connected')
    await client.sendText('919634847671@s.whatsapp.net', 'Hello!')
  })

  client.on('disconnected', () => {
    console.log('disconnected — reconnecting...')
    setTimeout(() => connect(), 3000)
  })

  client.on('message', msg => {
    const d = msg.decoded
    if (d && d.type === 'text') console.log('message from', msg.from, d.text)
  })

  client.on('auth_failure', ({ reason }) => {
    console.error('session revoked:', reason)
    // re-register the number
  })

  await client.init('919634847671')
}

connect()
```

### All Events

| Event | Payload | Description |
|---|---|---|
| `connected` | — | Session authenticated and ready |
| `disconnected` | — | Connection closed |
| `reconnecting` | `{ attempt, delay }` | Lost connection, will retry |
| `reconnected` | — | Connection restored |
| `auth_failure` | `{ reason }` | Session revoked or banned |
| `message` | message object | Incoming message received |
| `receipt` | `{ type, id, from }` | Delivery / read / played receipt |
| `presence` | `{ from, available }` | Contact came online or went offline |
| `group_update` | `{ type, groupJid, actor, participants, subject, timestamp }` | Member added / removed / promoted / demoted, subject or settings changed |
| `notification` | node object | Group or contact update notification |
| `call` | `{ from }` | Incoming call event |
| `chat_read` | `{ jid, read }` | Chat marked read (`read: true`) or unread (`read: false`) |
| `chat_muted` | `{ jid, muted, until }` | Chat muted or unmuted; `until` is epoch ms (−1 = indefinite) |
| `chat_pinned` | `{ jid, pinned }` | Chat pinned or unpinned |
| `chat_archived` | `{ jid, archived }` | Chat archived or unarchived |
| `message_starred` | `{ msgId, chatJid, starred }` | Message starred or unstarred |
| `stream_error` | `{ reason }` | Server sent a fatal stream error |
| `decrypt_error` | `{ id, from, participant, err }` | Failed to decrypt an incoming message |
| `session_refresh` | `{ node }` | Late re-authentication success; Signal session refreshed |
| `close` | — | Underlying TCP socket closed |
| `error` | Error | Unhandled transport error |

The message object contains:

```js
{
  id:          string,   // unique message ID
  from:        string,   // sender JID — may be a LID (e.g. '112345678901234@s.whatsapp.net')
  participant: string,   // group member JID (groups only; equals from for DMs)
  ts:          number,   // Unix timestamp (seconds)
  node:        object,   // raw XML node — node.attrs.sender_pn holds the real phone JID
  decoded:     object,   // structured payload — shape depends on message type (see below)
}
```

> [!NOTE]
> WhatsApp Multi-Device uses **LID JIDs** internally. The `from` field may be a LID like
> `112345678901234@s.whatsapp.net` rather than the real phone number. To get the actual
> phone number JID always read `msg.node.attrs.sender_pn`:
> ```js
> const spn = msg.node.attrs.sender_pn         // { user: '919634847671', server: 's.whatsapp.net' }
> const phoneJid = spn.user + '@s.whatsapp.net' // '919634847671@s.whatsapp.net'
> ```

The `decoded` object shape per message type:

```js
// Text
{ type: 'text', text: string }

// Image
{ type: 'image', caption: string, url: string, mimetype: string, mediaKey: Buffer, directPath: string }

// Video
{ type: 'video', caption: string, url: string, mimetype: string, mediaKey: Buffer, directPath: string }

// Audio (music file)
{ type: 'audio', url: string, mimetype: string, mediaKey: Buffer, directPath: string }

// Voice note (push-to-talk)
{ type: 'voice', url: string, mimetype: string, mediaKey: Buffer, directPath: string }

// Document
{ type: 'document', fileName: string, url: string, mimetype: string, mediaKey: Buffer, directPath: string }

// Sticker
{ type: 'sticker', url: string, mimetype: string, mediaKey: Buffer, directPath: string }

// Reaction
{ type: 'reaction', emoji: string }

// Location
{ type: 'location', latitude: number, longitude: number, name: string, address: string, url: string }

// Contact (vCard)
{ type: 'contact', displayName: string, vcard: string }

// Protocol (revoke, ephemeral, etc.)
{ type: 'protocol', subtype: string }
```

---

## History Sync

### How History Sync Works

When whalibmob connects, WhatsApp automatically sends the account's chat history to the client.
The library handles the entire pipeline **without any code from you** — you only need to listen
to the events if you want to use the data.

The full internal flow:

1. WhatsApp server sends an encrypted `ProtocolMessage` (type 6) containing a `HistorySyncNotification`.
2. The library decrypts it via Signal Protocol.
3. `HistorySyncHandler` downloads the encrypted blob from WhatsApp's CDN (`mmg.whatsapp.net`), or reads the inline payload if the server embedded it directly.
4. The blob is decrypted with **AES-256-CBC** using an HKDF key derived from `"WhatsApp History Keys"`.
5. The result is decompressed with **zlib** and decoded from **protobuf** (WAProto v2.3000.x — field numbers verified against the official proto definition).
6. Chats, contacts, push names, LID↔PN mappings, and **tcTokens** are merged into the disk store.
7. tcTokens from history are seeded into `TcTokenStore` in memory so the first outbound DM after reconnect already carries a valid `<tctoken>` node (prevents error 463 on cold start).
8. The `history_sync` event fires with a summary of what was received.

History arrives in **multiple chunks**. Each chunk fires one `history_sync` event. The first chunk (sync type `INITIAL_BOOTSTRAP`) is usually the largest and carries the most recent conversations.

### Listening to History Sync Events

```js
const { WhalibmobClient } = require('whalibmob')
const path = require('path')

const client = new WhalibmobClient({
  sessionDir: path.join(process.env.HOME, '.waSession')
})

// history_sync fires once per history chunk — may fire multiple times on first connect
client.on('history_sync', result => {
  console.log('History sync chunk received:')
  console.log('  type    :', result.syncTypeName)   // e.g. 'INITIAL_BOOTSTRAP', 'RECENT', 'FULL'
  console.log('  progress:', result.progress)        // 0-100 server-reported
  console.log('  chunk   :', result.chunkOrder)
  console.log('  chats   :', result.chats.length)
  console.log('  contacts:', result.contacts.length)
  console.log('  pushNames:', (result.pushNames || []).length)
})

// history_sync_error fires if a chunk fails to download or decrypt
client.on('history_sync_error', ({ err, notification }) => {
  console.error('History sync failed:', err.message)
  console.error('  syncType:', notification.syncType)
})

await client.init('919634847671')
```

The `result` object shape emitted by `history_sync`:

```js
{
  syncType:      number,   // HistorySyncType enum value
  syncTypeName:  string,   // 'INITIAL_BOOTSTRAP' | 'RECENT' | 'FULL' | 'PUSH_NAME' | 'NON_BLOCKING_DATA' | 'ON_DEMAND'
  progress:      number,   // 0-100, server-reported progress
  chunkOrder:    number,   // chunk sequence number
  chats: [                 // one entry per conversation in this chunk
    {
      id:               string,   // chat JID e.g. '919634847671@s.whatsapp.net' or '120363...@g.us'
      name:             string,   // display name (may be undefined for unknown contacts)
      unreadCount:      number,
      lastMsgTimestamp: number,   // Unix seconds
      messageCount:     number    // number of messages in this chunk for this chat
    }
  ],
  contacts: [              // one entry per contact discovered in this chunk
    {
      id:       string,
      name:     string,
      username: string,    // WhatsApp username if set
      pnJid:    string,    // phone-number JID e.g. '919634847671@s.whatsapp.net'
      lidJid:   string     // LID JID e.g. '112345678901234@lid'
    }
  ],
  pushNames:     Array,    // push-name entries { id, pushname }
  lidPnMappings: Array,    // LID<->PN mapping entries { lidJid, pnJid }
  merged:        object    // raw merged history store (see Reading the History Store below)
}
```

Sync type values:

| `syncTypeName` | When it fires |
|---|---|
| `INITIAL_BOOTSTRAP` | First connect — most recent conversations |
| `RECENT` | Reconnect after a short offline period |
| `FULL` | Full historical sync (older messages) |
| `PUSH_NAME` | Contact name updates only |
| `NON_BLOCKING_DATA` | Background low-priority data |
| `ON_DEMAND` | Explicitly requested by the client |

### Persistent Files Written to Disk

The library automatically writes these files to `sessionDir` per account. You do not need to create or manage them.

| File | Contents |
|---|---|
| `<phone>.history.json` | Chats, contacts, push names, LID↔PN mappings, tcTokens |
| `<phone>.messages.json` | Flat map of `msgId → message metadata` |
| `<phone>.appStateKeys.json` | App-state sync keys (used for app-state patch decryption) |
| `<phone>.tctoken.json` | Trusted-contact token store (tcToken per contact JID) |

### Reading the History Store

After history sync completes you can read the on-disk files directly:

```js
const fs   = require('fs')
const path = require('path')

const sessDir = path.join(process.env.HOME, '.waSession')
const phone   = '919634847671'

// ── Read chats ────────────────────────────────────────────────────────────────
const histPath = path.join(sessDir, phone + '.history.json')
const hist     = JSON.parse(fs.readFileSync(histPath, 'utf8'))

// List all chats sorted by last message time
const chats = Object.values(hist.chats)
  .sort((a, b) => (b.lastMsgTimestamp || 0) - (a.lastMsgTimestamp || 0))

for (const chat of chats.slice(0, 10)) {
  console.log(chat.id, '|', chat.name || '(unknown)', '|', chat.unreadCount, 'unread')
}

// ── LID ↔ PN lookup ───────────────────────────────────────────────────────────
// Look up LID JID from phone number JID
const myLid = hist.pnLidMap['919634847671@s.whatsapp.net']
console.log('LID:', myLid)   // e.g. '112345678901234@lid'

// Reverse: phone number JID from LID
const myPn = hist.lidPnMap[myLid]
console.log('PN:', myPn)

// ── Read message metadata ─────────────────────────────────────────────────────
const msgPath = path.join(sessDir, phone + '.messages.json')
const msgs    = JSON.parse(fs.readFileSync(msgPath, 'utf8'))
const msgList = Object.values(msgs).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
console.log('Total messages indexed:', msgList.length)
console.log('Latest:', msgList[0])
```

`hist.chats` schema per chat entry:

```js
{
  id:                     string,   // JID
  name:                   string,
  displayName:            string,
  unreadCount:            number,
  lastMsgTimestamp:       number,   // Unix seconds
  messageCount:           number,   // total messages indexed from history
  ephemeralExpiry:        number,   // disappearing messages timer in seconds, if set
  archived:               boolean,
  pinned:                 number,   // pin sort order (0 = not pinned)
  tcToken:                string,   // base64 — trusted-contact token (used internally by the library)
  tcTokenTimestamp:       number,   // Unix seconds — when the token was issued by the server
  tcTokenSenderTimestamp: number    // Unix seconds — sender-side issuance timestamp for 7-day bucket dedup
}
```

`msgs` schema per message entry:

```js
{
  id:        string,   // WhatsApp message ID
  chatId:    string,   // JID of the conversation
  fromMe:    boolean,
  fromJid:   string,   // sender JID
  timestamp: number,   // Unix seconds
  pushName:  string,   // display name of sender at send time
  status:    number    // 0=error 1=pending 2=server 3=delivered 4=read 5=played
}
```

### tcToken — Error 463 Defense

> [!IMPORTANT]
> This section is informational. The entire tcToken lifecycle is **fully automatic**.
> You do not need to write any code for it.

WhatsApp counts every outbound DM sent **without** a `<tctoken>` node as an anonymous "reach-out" event. Once enough such events accumulate the server enforces a time-based **Reach-out Time-lock** and returns error `463` (`NackCallerReachoutTimelocked`), blocking all outbound messages and calls for a period.

whalibmob implements the full lifecycle to prevent this:

| Step | What the library does automatically |
|---|---|
| **History seed** | On every history sync chunk, `tcToken` bytes are extracted from each conversation in the protobuf and loaded into `TcTokenStore` in memory. The first send after reconnect already has a valid token ready — no 463 risk on cold start. |
| **Attach on send** | Before dispatching any DM, `MessageSender` looks up the token for the recipient JID, checks it has not expired (28-day rolling window), and pushes a `<tctoken>` child node into the message stanza. |
| **Proactive issuance** | After each successful DM send, the library fires a `<iq type='set' xmlns='privacy'>` requesting a fresh token for that JID from the server — once per 7-day bucket, deduplicated in-flight. |
| **Incoming notification** | When a contact starts a new conversation, WhatsApp pushes a `<notification type='privacy_token'>`. The library catches it in `_handlePrivacyTokenNotification` and stores the token immediately. |
| **Identity change re-issue** | When decrypting a `pkmsg` (new Signal session from peer), the library calls `_reissueTcTokenAfterIdentityChange` to re-issue the token for the new session. |
| **Error 463 recovery** | If a send fails with error 463, the library issues a fresh token, waits for the server response, and automatically retries the same message with the new token attached. |
| **Expiry** | Tokens use a 4-bucket rolling window (4 × 7 days = 28-day TTL). Expired tokens are cleared before the send and a fresh one is requested proactively. |

Token storage uses the **LID JID** of the contact (e.g. `112345678901234@lid`) as the key — never the phone-number JID — matching WhatsApp's internal convention.

### What Is Automatic vs What You Need to Do

**Everything in the "Automatic" column requires zero code from you.**

| Feature | Automatic | Notes |
|---|---|---|
| Download history blob from CDN | ✅ | |
| Decrypt history blob (AES-256-CBC + HKDF) | ✅ | |
| Decompress zlib | ✅ | |
| Decode protobuf (WAProto v2.3000.x) | ✅ | Field numbers verified against official proto |
| Persist chats / contacts / push names | ✅ | Written to `<phone>.history.json` |
| Persist message metadata | ✅ | Written to `<phone>.messages.json` |
| Persist app-state sync keys | ✅ | Written to `<phone>.appStateKeys.json` |
| Seed tcTokens into memory on connect | ✅ | Prevents error 463 on first send after reconnect |
| Attach tcToken to every outbound DM | ✅ | |
| Issue fresh tcTokens after each send | ✅ | Once per 7-day bucket per contact |
| Handle incoming `privacy_token` notifications | ✅ | |
| Re-issue tcToken after peer identity change | ✅ | |
| Recover from error 463 with automatic retry | ✅ | |
| Populate in-memory LID↔PN maps | ✅ | |
| Listen to `history_sync` event | 🔵 Optional | Only if your app needs to react to history data |
| Read `<phone>.history.json` | 🔵 Optional | Only if your app needs chat/contact data at rest |
| Read `<phone>.messages.json` | 🔵 Optional | Only if your app indexes messages |

**Minimum working integration — history sync, tcTokens, and error-463 defense all active with zero extra code:**

```js
const { WhalibmobClient } = require('whalibmob')
const path = require('path')

const client = new WhalibmobClient({
  sessionDir: path.join(process.env.HOME, '.waSession')
})

// History sync, tcToken seeding, error-463 defense, and all disk persistence
// happen automatically. Add the listeners below only if your app needs the data.

client.on('history_sync', result => {
  // Optional — fires once per chunk (multiple times on first connect)
  console.log('[', result.syncTypeName, ']',
    result.chats.length, 'chats,',
    result.contacts.length, 'contacts')
})

client.on('history_sync_error', ({ err }) => {
  // Optional — log failures (library continues working even if a chunk fails)
  console.error('History chunk failed:', err.message)
})

await client.init('919634847671')
```


## Receiving Media

When a media message arrives, `msg.decoded` contains a CDN `url` and a `mediaKey`.
The actual file is stored encrypted on WhatsApp's CDN and must be downloaded and decrypted.

**Decryption uses two steps:**
1. HKDF-SHA256 expands `mediaKey` into IV, cipher key, and MAC key.
2. AES-256-CBC decrypts the ciphertext; a 10-byte HMAC-SHA256 MAC is verified first.

```js
const crypto = require('crypto')
const https  = require('https')
const http   = require('http')
const fs     = require('fs')
const path   = require('path')

// HKDF info strings per media type
const MEDIA_HKDF_INFO = {
  image:    'WhatsApp Image Keys',
  video:    'WhatsApp Video Keys',
  audio:    'WhatsApp Audio Keys',
  voice:    'WhatsApp Audio Keys',
  document: 'WhatsApp Document Keys',
  sticker:  'WhatsApp Image Keys',
}

function deriveMediaKeys(mediaKey, mediaType) {
  const info     = Buffer.from(MEDIA_HKDF_INFO[mediaType] || 'WhatsApp Image Keys', 'utf8')
  const expanded = Buffer.from(crypto.hkdfSync('sha256', mediaKey, Buffer.alloc(0), info, 112))
  return {
    iv:        expanded.slice(0,  16),
    cipherKey: expanded.slice(16, 48),
    macKey:    expanded.slice(48, 80),
  }
}

function decryptMedia(encrypted, mediaKey, mediaType) {
  const { iv, cipherKey, macKey } = deriveMediaKeys(mediaKey, mediaType)
  const ciphertext = encrypted.slice(0, -10)
  const fileMac    = encrypted.slice(-10)

  // Verify MAC
  const hmac     = crypto.createHmac('sha256', macKey)
  hmac.update(iv)
  hmac.update(ciphertext)
  const computed = hmac.digest().slice(0, 10)
  if (!computed.equals(fileMac)) throw new Error('MAC mismatch — corrupt file or wrong key')

  // Decrypt
  const decipher = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http
    const req = lib.get(url, { headers: { 'User-Agent': 'WhatsApp/2.26.7.75 A' } }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)) }
      const chunks = []
      res.on('data',  c => chunks.push(c))
      res.on('end',   () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')) })
  })
}

async function downloadAndDecrypt(msgId, mediaType, url, mediaKey, opts) {
  const extensions = { image: '.jpg', video: '.mp4', audio: '.ogg', voice: '.ogg',
                       document: '', sticker: '.webp' }
  let ext = extensions[mediaType] || ''
  if (mediaType === 'document' && opts && opts.fileName) ext = path.extname(opts.fileName) || '.bin'

  const encrypted = await downloadBuffer(url)
  const decrypted = decryptMedia(encrypted, mediaKey, mediaType)

  const outPath = path.join('./media', msgId + ext)
  fs.mkdirSync('./media', { recursive: true })
  fs.writeFileSync(outPath, decrypted)
  return outPath
}
```

**Using it in the `message` event:**

```js
const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'voice', 'document', 'sticker'])

client.on('message', async msg => {
  const d = msg.decoded
  if (!d) return

  // Resolve the real phone JID (works even with LID from-fields)
  const spn       = msg.node && msg.node.attrs && msg.node.attrs.sender_pn
  const senderJid = spn ? (spn.user + '@s.whatsapp.net') : msg.from

  if (d.type === 'text') {
    console.log('text from', senderJid, ':', d.text)
  }

  if (MEDIA_TYPES.has(d.type) && d.url && d.mediaKey) {
    try {
      const filePath = await downloadAndDecrypt(msg.id, d.type, d.url, d.mediaKey, { fileName: d.fileName })
      console.log('saved', d.type, 'to', filePath)
    } catch (e) {
      console.error('media download failed:', e.message)
    }
  }
})
```

## Sending Messages

### Text Message

```js
await client.sendText('919634847671@s.whatsapp.net', 'Hello!')
```

### Quote Message

For the simplest quoted reply use [`sendReply`](#quoted-reply). If you need low-level control (e.g. quoting a non-text message), pass a `contextInfo` object directly into `sendText`:

```js
// low-level: pass contextInfo manually inside sendText options
await client.sendText(
  '919634847671@s.whatsapp.net',
  'This is a reply',
  {
    contextInfo: {
      quotedMessageId: 'ABCDEF123456',          // ID of the quoted message
      participant:     '919634847671@s.whatsapp.net',  // sender of the quoted message
      remoteJid:       '919634847671@s.whatsapp.net',  // chat JID
    }
  }
)
```

### Mention User

```js
await client.sendText(
  '120363000000000000@g.us',
  '@919634847671 hello!',
  { mentions: ['919634847671@s.whatsapp.net'] }
)
```

### Reaction Message

```js
// react to a message
await client.sendReaction('919634847671@s.whatsapp.net', 'MSGID123', '👍')

// remove a reaction — pass empty string
await client.sendReaction('919634847671@s.whatsapp.net', 'MSGID123', '')
```

### Edit Message

> [!NOTE]
> Editing is only possible within 15 minutes of the original send.

```js
await client.editMessage(
  'MSGID123',                           // original message ID
  '919634847671@s.whatsapp.net',
  'Corrected text here'
)
```

### Delete Message

```js
// delete for yourself only
await client.deleteMessage('MSGID123', '919634847671@s.whatsapp.net', true, false)

// delete for everyone (revoke)
await client.deleteMessage('MSGID123', '919634847671@s.whatsapp.net', true, true)
```

### Forward Message

Forward text or a full media message (image, video, audio, document, sticker) without
re-uploading.  Pass a decoded message object from the `message` event to forward any media type.

```js
// Forward text
await client.forwardMessage('919634847671@s.whatsapp.net', 'text to forward')

// Forward any received message (full media, no re-upload)
client.on('message', async (msg) => {
  if (msg.decoded && msg.decoded.type !== 'text') {
    await client.forwardMessage('919634847671@s.whatsapp.net', msg)
  }
})
```

### Poll

Send a WhatsApp poll.  `selectableCount` is how many options a voter may choose (0 = any).

```js
const { id, encKey } = await client.sendPoll(
  '919634847671@s.whatsapp.net',
  'Best language?',
  ['JavaScript', 'Python', 'Rust'],
  1            // voters may pick 1 option (0 = unlimited)
)
// encKey (32-byte Buffer) is needed to decrypt incoming poll votes
```

### Quoted Reply

Send a text message that quotes (replies to) a specific earlier message. The recipient sees the original message highlighted above your reply.

```js
// DM: senderJid is the same as the chat JID
await client.sendReply(
  '919634847671@s.whatsapp.net',  // chat JID
  '3EB0XXXXXXXX',                 // ID of the quoted message
  '919634847671@s.whatsapp.net',  // sender of the quoted message (same as chat for DMs)
  'Got it, thanks!'               // your reply text
)

// Group: senderJid is the group member who sent the quoted message
await client.sendReply(
  '120363000000000000@g.us',      // group JID
  '3EB0XXXXXXXX',                 // ID of the quoted message
  '919634847671@s.whatsapp.net',  // who sent the original message
  'Agreed!'
)
```

You can get the `id` of a received message from `msg.id` inside the `message` event.

### Location Message

Send a GPS location pin. `name` and `address` are optional labels shown below the map preview.

```js
// minimal — lat/lon only
await client.sendLocation('919634847671@s.whatsapp.net', 48.8566, 2.3522)

// with name and address
await client.sendLocation('919634847671@s.whatsapp.net', 48.8566, 2.3522, {
  name:    'Eiffel Tower',
  address: 'Champ de Mars, 5 Av. Anatole France, Paris'
})

// to a group
await client.sendLocation('120363000000000000@g.us', 51.5074, -0.1278, {
  name: 'London'
})
```

### Contact Message (vCard)

Send a contact card using the standard vCard v3 format. The recipient can save the contact directly from WhatsApp.

```js
const vcard = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'FN:Alice Smith',
  'TEL;TYPE=CELL:+919634847671',
  'EMAIL:alice@example.com',
  'END:VCARD'
].join('\n')

await client.sendContact('919634847671@s.whatsapp.net', 'Alice Smith', vcard)
```

## Media Messages

### Image Message

```js
// from file path
await client.sendImage('919634847671@s.whatsapp.net', './photo.jpg', { caption: 'Look at this' })

// from Buffer
await client.sendImage('919634847671@s.whatsapp.net', buffer, {
  caption: 'Photo',
  mimetype: 'image/jpeg'
})
```

### Video Message

```js
await client.sendVideo('919634847671@s.whatsapp.net', './clip.mp4', { caption: 'Watch this' })
```

### Audio Message

```js
await client.sendAudio('919634847671@s.whatsapp.net', './song.mp3')
```

### Voice Note

```js
// ptt: true renders the audio as a push-to-talk voice note with waveform
await client.sendAudio('919634847671@s.whatsapp.net', './voice.ogg', { ptt: true })
```

### Document Message

```js
await client.sendDocument('919634847671@s.whatsapp.net', './report.pdf', {
  fileName: 'Q1 Report.pdf'
})
```

### Sticker Message

```js
await client.sendSticker('919634847671@s.whatsapp.net', './sticker.webp')
```

## Status / Stories

```js
// post a text Status to status@broadcast
await client.sendStatus('Good morning!')
```

## Send States in Chat

### Reading Messages

```js
// mark all messages in a chat as read (sends IQ to server)
await client.markChatRead('919634847671@s.whatsapp.net')
```

### Mark Voice Message Played

Send a `played` receipt for a received voice note (push-to-talk audio). This tells the sender that you have listened to the message.

```js
// msgId: ID of the audio message, from: JID of the sender
client.markMessagePlayed('3EB0ABCDEF123456', '919634847671@s.whatsapp.net')
```

### Update Presence

```js
// set yourself as online / offline globally
client.setOnline(true)
client.setOnline(false)

// show typing or recording in a specific chat
client.setChatPresence('919634847671@s.whatsapp.net', 'composing')   // typing
client.setChatPresence('919634847671@s.whatsapp.net', 'recording')   // recording audio
client.setChatPresence('919634847671@s.whatsapp.net', 'paused')      // stopped
```

## Modifying Chats

### Archive / Unarchive a Chat

```js
client.archiveChat('919634847671@s.whatsapp.net')
client.unarchiveChat('919634847671@s.whatsapp.net')
```

### Mute / Unmute a Chat

```js
await client.muteChat('919634847671@s.whatsapp.net', 8 * 60 * 60 * 1000)  // mute for 8 hours (ms)
await client.muteChat('919634847671@s.whatsapp.net', 0)                    // mute indefinitely
await client.unmuteChat('919634847671@s.whatsapp.net')
```

### Mark a Chat Read / Unread

```js
await client.markChatRead('919634847671@s.whatsapp.net')   // sends IQ to server
client.markChatUnread('919634847671@s.whatsapp.net')       // local state only
```

### Pin / Unpin a Chat

```js
client.pinChat('919634847671@s.whatsapp.net')
client.unpinChat('919634847671@s.whatsapp.net')
```

### Star / Unstar a Message

```js
client.starMessage('MSGID123', '919634847671@s.whatsapp.net')
client.unstarMessage('MSGID123', '919634847671@s.whatsapp.net')
```

### Disappearing Messages

| Duration | Seconds |
|---|---|
| Off | 0 |
| 24 hours | 86 400 |
| 7 days | 604 800 |
| 90 days | 7 776 000 |

```js
// set disappearing timer for a specific chat (DM or group)
await client.changeEphemeralTimer('919634847671@s.whatsapp.net', 86400)
await client.changeEphemeralTimer('120363000000000000@g.us', 604800)

// remove disappearing messages
await client.changeEphemeralTimer('919634847671@s.whatsapp.net', 0)
```

## User Queries

### Check If a Number Has WhatsApp

```js
const { checkNumberStatus } = require('whalibmob')

const result = await checkNumberStatus('919634847671')
// result.status: 'registered' | 'registered_blocked' | 'not_registered' | 'cooldown' | 'unknown'
console.log(result.status)
```

Check multiple numbers at once while connected:

```js
const results = await client.hasWhatsapp(['919634847671', '12345678901'])
// returns array of JIDs that have WhatsApp
```

### Fetch Profile About

```js
const about = await client.queryAbout('919634847671@s.whatsapp.net')
console.log(about)
```

### Fetch Profile Picture

```js
const url = await client.queryPicture('919634847671@s.whatsapp.net')
// also works for groups
const groupUrl = await client.queryPicture('120363000000000000@g.us')
```

### Subscribe to Presence

```js
// triggers 'presence' events when the contact comes online or goes offline
client.subscribeToPresence('919634847671@s.whatsapp.net')

client.on('presence', ({ from, available }) => {
  console.log(from, available ? 'online' : 'offline')
})
```

## Change Profile

### Change Display Name

```js
client.changeName('My Bot')
```

### Change About Text

```js
await client.changeAbout('Available 24/7')
```

### Change Profile Picture

Both methods accept a **Buffer** (use `fs.readFileSync` to load a file).

```js
const fs = require('fs')

// change your own profile picture
await client.changeProfilePicture(fs.readFileSync('./avatar.jpg'))

// change a group's picture (you must be admin)
await client.changeGroupPicture('120363000000000000@g.us', fs.readFileSync('./group.jpg'))
```

## Privacy

### Block / Unblock User

```js
await client.blockContact('919634847671@s.whatsapp.net')
await client.unblockContact('919634847671@s.whatsapp.net')
```

### Get Block List

```js
const list = await client.queryBlockList()
console.log(list)   // [ '919634847671@s.whatsapp.net', ... ]
```

### Update Privacy Settings

```js
// type:  'last_seen' | 'profile_picture' | 'status' | 'online' | 'read_receipts' | 'groups_add'
// value: 'all' | 'contacts' | 'contact_blacklist' | 'none' | 'match_last_seen'

await client.changePrivacySetting('last_seen',        'contacts')
await client.changePrivacySetting('profile_picture',  'contacts')
await client.changePrivacySetting('status',           'contacts')
await client.changePrivacySetting('online',           'match_last_seen')
await client.changePrivacySetting('read_receipts',    'none')
await client.changePrivacySetting('groups_add',       'contacts')
```

### Update Default Disappearing Mode

```js
// sets the default ephemeral timer for all new chats
await client.changeNewChatsEphemeralTimer(86400)   // 1 day
await client.changeNewChatsEphemeralTimer(0)       // off
```

## Groups

### Create a Group

Returns the same metadata object as `getGroupMetadata` (jid, subject, participants, etc.).

```js
const group = await client.createGroup('My Group', [
  '919634847671@s.whatsapp.net',
  '12345678901@s.whatsapp.net'
])
console.log('created', group.jid)       // '120363000000000000@g.us'
console.log('subject', group.subject)   // 'My Group'
console.log('members', group.participants.map(p => p.jid))
```

### Add / Remove or Demote / Promote

```js
const groupJid = '120363000000000000@g.us'

await client.addGroupParticipants(groupJid,     ['919634847671@s.whatsapp.net'])
await client.removeGroupParticipants(groupJid,  ['919634847671@s.whatsapp.net'])
await client.promoteGroupParticipants(groupJid, ['919634847671@s.whatsapp.net'])
await client.demoteGroupParticipants(groupJid,  ['919634847671@s.whatsapp.net'])
```

### Change Subject

```js
await client.changeGroupSubject('120363000000000000@g.us', 'New Group Name')
```

### Change Description

```js
await client.changeGroupDescription('120363000000000000@g.us', 'This is the group description')
```

### Change Settings

```js
// setting: 'edit_group_info' | 'send_messages' | 'add_participants' | 'approve_participants'
// policy:  'admins' | 'all'

await client.changeGroupSetting('120363000000000000@g.us', 'send_messages',   'admins')
await client.changeGroupSetting('120363000000000000@g.us', 'edit_group_info', 'admins')
await client.changeGroupSetting('120363000000000000@g.us', 'add_participants', 'all')
```

### Leave a Group

```js
await client.leaveGroup('120363000000000000@g.us')
```

### Get Invite Code

```js
const link = await client.queryGroupInviteLink('120363000000000000@g.us')
// e.g. 'https://chat.whatsapp.com/AbCdEfGhIjK'
console.log(link)
```

### Revoke Invite Code

```js
await client.revokeGroupInvite('120363000000000000@g.us')
```

### Join Using Invitation Code

> [!NOTE]
> Pass only the code portion — do not include `https://chat.whatsapp.com/`

```js
const jid = await client.acceptGroupInvite('AbCdEfGhIjK')
console.log('joined', jid)
```

### Query Invite Info from Link

Fetch a group's metadata from an invite code or full URL **without** joining the group. Useful for displaying a preview to the user before they confirm.

```js
// bare code
const info = await client.queryGroupInviteInfo('AbCdEfGhIjKlMnOpQrStUv')

// or pass the full URL — the code is extracted automatically
const info = await client.queryGroupInviteInfo('https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv')

console.log(info)
// {
//   jid:          '120363000000000000@g.us',
//   subject:      'My Group',
//   creator:      '919634847671@s.whatsapp.net',
//   creation:     1705315800,   // Unix timestamp
//   description:  'Group description here',
//   participants: [
//     { jid: '919634847671@s.whatsapp.net', role: 'admin' },
//     { jid: '12345678901@s.whatsapp.net',  role: 'member' }
//   ]
// }
```

### Fetch All Groups

Returns an array of metadata objects for every group you are a member of. Each object has the same shape as `getGroupMetadata`.

```js
const groups = await client.fetchAllGroups()
for (const g of groups) {
  console.log(g.jid, g.subject, g.participants.length + ' members')
}
```

### Query Metadata

```js
const meta = await client.getGroupMetadata('120363000000000000@g.us')
// returns: { jid, subject, creation, creator, subjectTime, subjectBy,
//            description, ephemeral, onlyAdminsSend, onlyAdminsEdit, participants[] }
console.log(meta.subject, meta.participants.length + ' members')
```

### Get Request Join List

```js
const pending = await client.queryGroupPendingParticipants('120363000000000000@g.us')
console.log(pending)
```

### Approve / Reject Request Join

The second parameter is a boolean: `true` to approve, `false` to reject.

```js
// approve join requests
await client.approveGroupParticipants('120363000000000000@g.us', true, [
  '919634847671@s.whatsapp.net'
])

// reject join requests
await client.approveGroupParticipants('120363000000000000@g.us', false, [
  '919634847671@s.whatsapp.net'
])
```

### Toggle Ephemeral in Group

```js
await client.changeEphemeralTimer('120363000000000000@g.us', 86400)  // 1 day
await client.changeEphemeralTimer('120363000000000000@g.us', 0)      // off
```

## Communities

WhatsApp Communities are a superset of groups — a parent container that can hold multiple linked
sub-groups plus an automatic general-chat group.

### Create a Community

```js
const community = await client.createCommunity('My Community', 'A place for discussion')
// community.jid  — e.g. 120363000000000001@g.us
```

### Deactivate / Delete a Community

```js
await client.deactivateCommunity('120363000000000001@g.us')
```

### Link Groups into a Community

```js
const linked = await client.linkGroupsToCommunity(
  '120363000000000001@g.us',          // community JID
  ['120363000000000002@g.us',         // group JIDs to link
   '120363000000000003@g.us']
)
```

### Unlink a Group from a Community

```js
await client.unlinkGroupFromCommunity(
  '120363000000000001@g.us',   // community JID
  '120363000000000002@g.us'    // group JID
)
```

## Newsletters (Channels)

Newsletters are one-to-many broadcast channels.  Only the owner can post; anyone can subscribe.

### Create a Newsletter

```js
const nl = await client.createNewsletter('Tech News', 'Daily updates on tech')
// nl.jid — e.g. 120363000000000004@newsletter
```

### Join / Leave a Newsletter

```js
await client.joinNewsletter('120363000000000004@newsletter')
await client.leaveNewsletter('120363000000000004@newsletter')
```

### Query Newsletter Metadata

```js
const meta = await client.queryNewsletterMetadata('120363000000000004@newsletter')
// { jid, name, description, subscriberCount }
```

### Update Newsletter Description

```js
await client.changeNewsletterDescription('120363000000000004@newsletter', 'New description here')
```

### Post a Text Update to Your Newsletter

```js
await client.sendNewsletterText('120363000000000004@newsletter', 'Breaking: WhatsApp adds polls!')
```

## Business Profile

Query the public business profile of any WhatsApp Business account:

```js
const bp = await client.queryBusinessProfile('919634847671@s.whatsapp.net')
if (bp) {
  console.log(bp.category)     // e.g. "Software & IT Services"
  console.log(bp.email)        // business email (if set)
  console.log(bp.website)      // business website (if set)
  console.log(bp.address)      // physical address (if set)
  console.log(bp.description)  // business description (if set)
}
// Returns null if the number is not a WhatsApp Business account
```

## CLI — Getting Started

### Install the CLI

Install whalibmob globally to get the `wa` command available from anywhere on your system:

```sh
npm install -g whalibmob
```

Verify the installation:

```sh
wa version
```

### First-Time Setup: Register a Number

Registration is a one-time process. You need a phone number that can receive an SMS or voice call. **Use a dedicated number** — do not use a number already active on a real WhatsApp device.

**Step 1 — request a verification code**

```sh
# via SMS (default)
wa registration --request-code 919634847671

# via voice call
wa registration --request-code 919634847671 --method voice

# via an old WhatsApp account
wa registration --request-code 919634847671 --method wa_old
```

The CLI sends the code request, prints the result, and then **stays open** in the interactive shell. You will see:

```
requesting sms code for +919634847671...
  status  sent
  now run: wa registration --register 919634847671 --code <code>

staying in shell — use /reg confirm 919634847671 <code> to complete
wa>
```

**Step 2 — confirm the code you received**

Either run the one-shot command:

```sh
wa registration --register 919634847671 --code 123456
```

Or type it directly in the shell that stayed open:

```sh
wa> /reg confirm 919634847671 123456
```

On success you will see:

```
registered  session saved to /home/user/.waSession/919634847671.json
now run: /connect 919634847671
```

**Check if a number already has WhatsApp**

```sh
wa registration --check 919634847671
```

Output:

```
checking +919634847671...
  status  registered
```

Possible statuses: `registered` · `registered_blocked` · `not_registered` · `cooldown` · `unknown`

### CLI Connect

After registering, connect with:

```sh
wa connect 919634847671
```

The shell opens with a persistent prompt:

```
connecting to +919634847671...
connected as +919634847671
wa +919634847671>
```

> [!TIP]
> **The shell never exits on its own.** It stays open until you type `/quit` or press Ctrl+C. This is true for every command — registration, connection, sending messages — everything.

Use a custom session directory with `--session`:

```sh
wa connect 919634847671 --session /data/my-sessions
```

### Listen Mode

Connect and print all incoming events to the terminal. The process stays alive indefinitely until you press Ctrl+C:

```sh
wa listen 919634847671
```

Output as messages arrive:

```
connected  listening on +919634847671  (Ctrl+C to stop)
  ────────────────────────────────────────────────────────
  time                    2025-03-13 10:00:05
  from                    919634847671@s.whatsapp.net
  id                      3EB0ABCDEF123456
  text                    Hello there!
```

---

## CLI — Interactive Shell Commands

After running `wa connect <phone>`, every feature of the library is available as a `/command`. Type `/help` at any time to see all commands.

> [!NOTE]
> JIDs can be written as plain phone numbers (e.g. `919634847671`) — the shell automatically appends `@s.whatsapp.net`. For groups, use the full `@g.us` JID.

### Messaging Commands

#### Send Text

```sh
wa> /send 919634847671@s.whatsapp.net Hello, how are you?
sent  3EB0ABCDEF123456

# to a group
wa> /send 120363000000000000@g.us Hello everyone!
```

#### Send Image

```sh
wa> /image 919634847671@s.whatsapp.net ./photo.jpg
wa> /image 919634847671@s.whatsapp.net ./photo.jpg Look at this!
```

The second argument is the file path. The optional third argument is the caption.

#### Send Video

```sh
wa> /video 919634847671@s.whatsapp.net ./clip.mp4
wa> /video 919634847671@s.whatsapp.net ./clip.mp4 Watch this
```

#### Send Audio

Sends the file as a regular audio attachment:

```sh
wa> /audio 919634847671@s.whatsapp.net ./song.mp3
```

#### Send Voice Note

Sends the file as a push-to-talk voice note with waveform:

```sh
wa> /ptt 919634847671@s.whatsapp.net ./voice.ogg
```

#### Send Document

```sh
wa> /doc 919634847671@s.whatsapp.net ./report.pdf
wa> /doc 919634847671@s.whatsapp.net ./report.pdf "Q1 Report.pdf"
```

The optional third argument overrides the displayed filename.

#### Send Sticker

The file must be in WebP format:

```sh
wa> /sticker 919634847671@s.whatsapp.net ./sticker.webp
```

#### Send Poll (CLI)

Separate the question from the options using `|`. At least two options are required. Optionally append `selectable=N` to limit how many options a voter may choose (0 = any):

```sh
# single-choice poll (selectable=1)
wa> /poll 919634847671@s.whatsapp.net Best language? | JavaScript | Python | Rust | selectable=1

# unlimited-choice poll (default)
wa> /poll 120363000000000000@g.us Pick your favourites | Red | Green | Blue
```

#### React to a Message

```sh
wa> /react 919634847671@s.whatsapp.net 3EB0ABCDEF123456 👍

# remove a reaction — pass a space or empty string
wa> /react 919634847671@s.whatsapp.net 3EB0ABCDEF123456 " "
```

The message ID is shown in the incoming message display as `id`.

#### Edit a Message

> [!NOTE]
> Editing is only possible within 15 minutes of the original send.

```sh
wa> /edit 919634847671@s.whatsapp.net 3EB0ABCDEF123456 Corrected text here
```

#### Delete a Message

```sh
# delete for yourself only
wa> /delete 919634847671@s.whatsapp.net 3EB0ABCDEF123456

# delete for everyone (revoke)
wa> /delete 919634847671@s.whatsapp.net 3EB0ABCDEF123456 all
```

#### Post a Status / Story

Posts a text Status visible to your contacts:

```sh
wa> /status Good morning everyone!
```

#### Forward a Message

Sends a message with the forwarded flag set:

```sh
wa> /forward 919634847671@s.whatsapp.net This message was forwarded
```

#### Reply to a Message (CLI)

Quote and reply to a specific message. You need the message ID (shown as `id:` in the receive log) and the sender's JID.

```sh
# DM — senderJid is the same as the chat JID
wa> /reply 919634847671@s.whatsapp.net 3EB0XXXXXXXX 919634847671@s.whatsapp.net Got it, thanks!

# Group — senderJid is the member who sent the original message
wa> /reply 120363000000000000@g.us 3EB0XXXXXXXX 919634847671@s.whatsapp.net Agreed!
```

The message ID is printed when a message arrives:
```
  id                    3EB0C5BA7XXXXXXXX
```

#### Send Location (CLI)

Send a GPS location pin. Latitude and longitude are required; name and address (separated by `|`) are optional:

```sh
# lat/lon only
wa> /location 919634847671@s.whatsapp.net 48.8566 2.3522

# with name
wa> /location 919634847671@s.whatsapp.net 48.8566 2.3522 Eiffel Tower

# with name and address (separate with |)
wa> /location 919634847671@s.whatsapp.net 48.8566 2.3522 Eiffel Tower | Champ de Mars, Paris

# to a group
wa> /location 120363000000000000@g.us 51.5074 -0.1278 London
```

#### Send Contact / vCard (CLI)

Send a contact card. The vCard string must follow the vCard v3 format. Wrap it in quotes in the shell:

```sh
wa> /vcard 919634847671@s.whatsapp.net "Alice Smith" "BEGIN:VCARD\nVERSION:3.0\nFN:Alice Smith\nTEL;TYPE=CELL:+919634847671\nEND:VCARD"
```

For multi-line vCards it is easiest to store the string in a shell variable:

```sh
VCARD="BEGIN:VCARD
VERSION:3.0
FN:Alice Smith
TEL;TYPE=CELL:+919634847671
EMAIL:alice@example.com
END:VCARD"

wa> /vcard 919634847671@s.whatsapp.net "Alice Smith" "$VCARD"
```

---

### Presence Commands

#### Set Online / Offline

```sh
wa> /online
wa> /offline
```

#### Typing and Recording Indicators

```sh
# show "typing…" in a chat
wa> /typing 919634847671@s.whatsapp.net

# show "recording audio…" in a chat
wa> /recording 919634847671@s.whatsapp.net

# stop the indicator
wa> /stop 919634847671@s.whatsapp.net
```

#### Subscribe to a Contact's Presence

Subscribes to online/offline events for a contact. The shell will print presence updates as they arrive:

```sh
wa> /subscribe 919634847671@s.whatsapp.net
subscribed to 919634847671@s.whatsapp.net

# when they come online:
  presence  919634847671@s.whatsapp.net  online
```

---

### Profile Commands

#### CLI Change Display Name

```sh
wa> /name My Bot Name
name updated
```

#### CLI Change About Text

```sh
wa> /about Available 24/7 for support
about updated
```

#### CLI Change Profile Picture

Reads the image from disk and uploads it as your profile picture. Supported formats: JPEG, PNG.

```sh
wa> /photo ./avatar.jpg
profile picture updated
```

#### CLI Change Privacy Settings

```sh
wa> /privacy last_seen contacts
wa> /privacy profile_picture contacts
wa> /privacy status contacts
wa> /privacy online match_last_seen
wa> /privacy read_receipts none
wa> /privacy groups_add contacts
```

Available types: `last_seen` · `profile_picture` · `status` · `online` · `read_receipts` · `groups_add`

Available values: `all` · `contacts` · `contact_blacklist` · `none` · `match_last_seen`

---

### Contact Commands

#### Check Who Has WhatsApp

Checks multiple phone numbers (plain digits, no `+`) and lists which ones are registered on WhatsApp:

```sh
wa> /whatsapp 919634847671 12345678901
  has whatsapp (1)
    919634847671@s.whatsapp.net
  not found (1)
    12345678901
```

#### Get Profile Picture URL

Returns the CDN URL for a contact's or group's profile picture:

```sh
wa> /picture 919634847671@s.whatsapp.net
  https://mmg.whatsapp.net/v/...

wa> /picture 120363000000000000@g.us
  https://mmg.whatsapp.net/v/...
```

#### Get Contact About Text

Fetches the bio / about text for a contact:

```sh
wa> /contact about 919634847671@s.whatsapp.net
  Available 24/7
```

---

### Chat Management Commands

#### Mark Read / Unread

```sh
wa> /read   919634847671@s.whatsapp.net
wa> /unread 919634847671@s.whatsapp.net
```

#### Mute / Unmute

```sh
# mute for 60 minutes
wa> /mute 919634847671@s.whatsapp.net 60

# mute indefinitely
wa> /mute 919634847671@s.whatsapp.net

# unmute
wa> /unmute 919634847671@s.whatsapp.net
```

#### Pin / Unpin

```sh
wa> /pin   919634847671@s.whatsapp.net
wa> /unpin 919634847671@s.whatsapp.net
```

#### Archive / Unarchive

```sh
wa> /archive   919634847671@s.whatsapp.net
wa> /unarchive 919634847671@s.whatsapp.net
```

#### Star / Unstar a Message (CLI)

```sh
wa> /star   919634847671@s.whatsapp.net 3EB0ABCDEF123456
wa> /unstar 919634847671@s.whatsapp.net 3EB0ABCDEF123456
```

#### CLI Disappearing Messages

| Duration | Seconds |
|---|---|
| Off | 0 |
| 24 hours | 86400 |
| 7 days | 604800 |
| 90 days | 7776000 |

```sh
# set 1-day timer on a DM
wa> /ephemeral 919634847671@s.whatsapp.net 86400

# set 1-week timer on a group
wa> /ephemeral 120363000000000000@g.us 604800

# turn off
wa> /ephemeral 919634847671@s.whatsapp.net 0
```

#### Default Disappearing Timer

Sets the global default ephemeral timer applied to all **new** chats:

```sh
wa> /ephemeral-default 86400
default ephemeral set  86400

# turn off
wa> /ephemeral-default 0
default ephemeral set  0
```

Accepts the same values as `/ephemeral`: 0, 86400, 604800, 7776000.

#### Block / Unblock

```sh
wa> /block   919634847671@s.whatsapp.net
blocked  919634847671@s.whatsapp.net

wa> /unblock 919634847671@s.whatsapp.net
unblocked  919634847671@s.whatsapp.net
```

#### Show Block List

```sh
wa> /blocklist
  blocked (2)
    919634847671@s.whatsapp.net
    12345678901@s.whatsapp.net
```

---

### Group Commands

#### CLI Create a Group

```sh
wa> /group create MyGroup 919634847671@s.whatsapp.net 12345678901@s.whatsapp.net
creating group...
created  120363000000000000@g.us
  subject  MyGroup
  members  919634847671@s.whatsapp.net, 12345678901@s.whatsapp.net
```

#### CLI Leave a Group

```sh
wa> /group leave 120363000000000000@g.us
left  120363000000000000@g.us
```

#### Add / Remove Participants

```sh
# add participants
wa> /group add 120363000000000000@g.us 919634847671@s.whatsapp.net

# remove participants
wa> /group remove 120363000000000000@g.us 919634847671@s.whatsapp.net
```

Multiple participants can be listed, separated by spaces.

#### Promote / Demote Admins

```sh
# promote to admin
wa> /group promote 120363000000000000@g.us 919634847671@s.whatsapp.net

# demote from admin
wa> /group demote 120363000000000000@g.us 919634847671@s.whatsapp.net
```

#### Change Group Name

```sh
wa> /group subject 120363000000000000@g.us New Group Name
subject updated
```

#### Change Group Description

```sh
wa> /group desc 120363000000000000@g.us This is the group for project updates
description updated
```

#### Change Group Picture

Reads the image from disk and sets it as the group's profile picture. You must be an admin.

```sh
wa> /group photo 120363000000000000@g.us ./group-logo.jpg
group picture updated
```

#### Get Invite Link

```sh
wa> /group invite 120363000000000000@g.us
  https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv
```

#### Revoke Invite Link

Invalidates the current invite link and generates a new one:

```sh
wa> /group revoke 120363000000000000@g.us
invite link revoked
```

#### Join a Group by Invite Code

Pass only the code part — do not include `https://chat.whatsapp.com/`:

```sh
wa> /group join AbCdEfGhIjKlMnOpQrStUv
joined  120363000000000000@g.us
```

#### Query Group Invite Info

Preview a group's metadata from an invite link **before** joining. Accepts the bare code or the full URL:

```sh
wa> /group invite-info AbCdEfGhIjKlMnOpQrStUv
  ────────────────────────────────────────────────────────
  jid                   120363000000000000@g.us
  subject               My Group
  creator               919634847671@s.whatsapp.net
  created               2024-01-15 10:30:00
  description           Group description here
  participants          (3)
    919634847671@s.whatsapp.net  [admin]
    12345678901@s.whatsapp.net
    98765432109@s.whatsapp.net
  ────────────────────────────────────────────────────────
```

You can also pass the full link:

```sh
wa> /group invite-info "https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv"
```

#### Query Group Metadata

```sh
wa> /group meta 120363000000000000@g.us
  jid              120363000000000000@g.us
  subject          My Group
  description      Group description here
  creator          919634847671@s.whatsapp.net
  created          2024-01-15 10:30:00
  participants     3
  onlyAdminsSend   false
  onlyAdminsEdit   true
  ephemeral        0
```

#### List All Groups

Fetches all groups you are a member of and prints a numbered list:

```sh
wa> /groups
  groups (3)
    1  120363000000000000@g.us  My Project Group  (5 members)
    2  120363111111111111@g.us  Family Chat        (12 members)
    3  120363222222222222@g.us  Friends            (8 members)
```

#### List Group Participants

Lists all participants of a group with their roles:

```sh
wa> /group participants 120363000000000000@g.us
  participants (3)
    919634847671@s.whatsapp.net  [admin]
    12345678901@s.whatsapp.net
    98765432109@s.whatsapp.net
```

#### Pending Join Requests

Lists users who have requested to join a group (only visible when `approve_participants` is enabled):

```sh
wa> /group pending 120363000000000000@g.us
  pending (2)
    919634847671@s.whatsapp.net
    12345678901@s.whatsapp.net
```

#### Approve / Reject Join Requests

```sh
# approve one or more pending members
wa> /group approve 120363000000000000@g.us 919634847671@s.whatsapp.net
approved  919634847671@s.whatsapp.net

# reject one or more pending members
wa> /group reject 120363000000000000@g.us 919634847671@s.whatsapp.net
rejected  919634847671@s.whatsapp.net
```

Multiple JIDs can be listed, separated by spaces.

#### Group Settings

Controls who can send messages, edit group info, add participants, or requires approval to join:

```sh
# only admins can send messages
wa> /group settings 120363000000000000@g.us send_messages admins

# everyone can send messages
wa> /group settings 120363000000000000@g.us send_messages all

# only admins can edit group info
wa> /group settings 120363000000000000@g.us edit_group_info admins

# only admins can add participants
wa> /group settings 120363000000000000@g.us add_participants admins

# require admin approval for join requests
wa> /group settings 120363000000000000@g.us approve_participants admins
```

---

### Community Commands (CLI)

Communities group multiple linked groups under one umbrella. Only the community creator can link / unlink groups or deactivate the community.

```sh
# create a community (description is optional)
wa> /community create "Dev Squad" "Our developer community"

# link an existing group into the community
wa> /community link  120363000000000001@g.us 120363000000000002@g.us

# unlink a group from the community
wa> /community unlink 120363000000000001@g.us 120363000000000002@g.us

# permanently deactivate (delete) a community
wa> /community deactivate 120363000000000001@g.us
```

---

### Newsletter / Channel Commands

Newsletters are one-to-many broadcast channels. Only the owner can post; anyone can subscribe.

```sh
# create a new channel
wa> /newsletter create Tech News Daily tips about technology

# subscribe to a channel
wa> /newsletter join 120363000000000004@newsletter

# unsubscribe from a channel
wa> /newsletter leave 120363000000000004@newsletter

# query channel metadata (name, description, subscriber count)
wa> /newsletter info 120363000000000004@newsletter
  ────────────────────────────────────────────────────────
  jid           120363000000000004@newsletter
  name          Tech News
  description   Daily tips about technology
  subscribers   1234
  ────────────────────────────────────────────────────────

# update the channel description (you must be the owner)
wa> /newsletter desc 120363000000000004@newsletter New description here

# post a text update to your channel (you must be the owner)
wa> /newsletter post 120363000000000004@newsletter Breaking: WhatsApp adds polls!
```

---

### Business Profile Command (CLI)

Query the public business profile of any WhatsApp Business account:

```sh
wa> /biz 919634847671@s.whatsapp.net
  ────────────────────────────────────────────────────────
  jid           919634847671@s.whatsapp.net
  category      Software & IT Services
  email         contact@example.com
  website       https://example.com
  address       123 Main St
  description   We build software
  ────────────────────────────────────────────────────────
```

Returns a message if the number is not a WhatsApp Business account.

---

### Registration Commands (in-shell)

These commands work from within the shell — useful when you need to register a second number without closing the current session:

```sh
# check if a phone number has WhatsApp
wa> /reg check 919634847671

# request a verification code
wa> /reg code 919634847671
wa> /reg code 919634847671 voice
wa> /reg code 919634847671 wa_old

# confirm the code received
wa> /reg confirm 919634847671 123456
registered  session saved to /home/user/.waSession/919634847671.json
now run: /connect 919634847671
```

---

### Connection Commands (in-shell)

```sh
# connect to a number (while already in the shell)
wa> /connect 919634847671

# disconnect
wa> /disconnect

# force a reconnection
wa> /reconnect

# show current session info
wa> /session
  phone                   919634847671
  name                    My Bot
  session                 /home/user/.waSession

# show all available commands
wa> /help

# disconnect and exit the shell
wa> /quit
```

---

### Full Command Reference Table

| Command | Description |
|---|---|
| **Messaging** | |
| `/send <jid> <text>` | Send a text message |
| `/image <jid> <file> [caption]` | Send an image |
| `/video <jid> <file> [caption]` | Send a video |
| `/audio <jid> <file>` | Send an audio file |
| `/ptt <jid> <file>` | Send a voice note (push-to-talk) |
| `/doc <jid> <file> [name]` | Send a document |
| `/sticker <jid> <file>` | Send a sticker (.webp) |
| `/poll <jid> <question> \| <opt1> \| <opt2> [selectable=N]` | Send a poll |
| `/react <jid> <msgId> <emoji>` | React to a message |
| `/edit <jid> <msgId> <text>` | Edit a sent message |
| `/delete <jid> <msgId> [all]` | Delete a message (add `all` for everyone) |
| `/status <text>` | Post a Status / Story |
| `/forward <jid> <text>` | Send with forwarded flag |
| `/reply <jid> <msgId> <senderJid> <text>` | Reply quoting a specific message |
| `/location <jid> <lat> <lon> [name] [| address]` | Send a GPS location pin |
| `/vcard <jid> <displayName> <vcard>` | Send a contact card (vCard v3) |
| **Presence** | |
| `/online` | Set yourself as online |
| `/offline` | Set yourself as offline |
| `/typing <jid>` | Show typing indicator in a chat |
| `/recording <jid>` | Show recording audio indicator |
| `/stop <jid>` | Stop typing / recording |
| `/subscribe <jid>` | Subscribe to a contact's presence |
| **Profile** | |
| `/name <text>` | Change your display name |
| `/about <text>` | Change your bio / about text |
| `/photo <file>` | Change your profile picture |
| `/privacy <type> <value>` | Change a privacy setting |
| **Contacts** | |
| `/whatsapp <phone...>` | Check which numbers have WhatsApp |
| `/picture <jid>` | Get profile picture CDN URL |
| `/contact about <jid>` | Get bio / about text of a contact |
| **Chat Management** | |
| `/read <jid>` | Mark chat as read |
| `/unread <jid>` | Mark chat as unread |
| `/mute <jid> [minutes]` | Mute a chat (indefinitely if no minutes given) |
| `/unmute <jid>` | Unmute a chat |
| `/pin <jid>` | Pin a chat |
| `/unpin <jid>` | Unpin a chat |
| `/archive <jid>` | Archive a chat |
| `/unarchive <jid>` | Unarchive a chat |
| `/star <jid> <msgId>` | Star a message |
| `/unstar <jid> <msgId>` | Unstar a message |
| `/ephemeral <jid> <seconds>` | Set disappearing messages timer for a chat |
| `/ephemeral-default <seconds>` | Set global default ephemeral timer for new chats |
| `/block <jid>` | Block a contact |
| `/unblock <jid>` | Unblock a contact |
| `/blocklist` | Show all blocked contacts |
| **Groups** | |
| `/group create <name> <jid...>` | Create a group |
| `/group leave <jid>` | Leave a group |
| `/group add <jid> <member...>` | Add participants |
| `/group remove <jid> <member...>` | Remove participants |
| `/group promote <jid> <member...>` | Promote to admin |
| `/group demote <jid> <member...>` | Demote from admin |
| `/group subject <jid> <name>` | Rename group |
| `/group desc <jid> <text>` | Change group description |
| `/group photo <jid> <file>` | Change group picture |
| `/group invite <jid>` | Get invite link |
| `/group revoke <jid>` | Revoke invite link |
| `/group join <code>` | Join group by invite code |
| `/group invite-info <code\|url>` | Preview group metadata from an invite link (without joining) |
| `/groups` | List all groups you are a member of |
| `/group meta <jid>` | Query group metadata |
| `/group participants <jid>` | List group participants with roles |
| `/group pending <jid>` | List pending join requests |
| `/group approve <jid> <member...>` | Approve pending join requests |
| `/group reject <jid> <member...>` | Reject pending join requests |
| `/group settings <jid> <setting> <policy>` | Change group setting |
| **Community** | |
| `/community create <subject> [description]` | Create a community |
| `/community deactivate <communityJid>` | Permanently delete a community |
| `/community link <communityJid> <groupJid>` | Link a group into a community |
| `/community unlink <communityJid> <groupJid>` | Unlink a group from a community |
| **Newsletter / Channel** | |
| `/newsletter create <name> [description]` | Create a newsletter channel |
| `/newsletter join <jid>` | Subscribe to a channel |
| `/newsletter leave <jid>` | Unsubscribe from a channel |
| `/newsletter info <jid>` | Query channel metadata |
| `/newsletter desc <jid> <text>` | Update channel description |
| `/newsletter post <jid> <text>` | Post a text update to your channel |
| **Business** | |
| `/biz <phone\|jid>` | Query business profile of a WhatsApp Business account |
| **Registration** | |
| `/reg check <phone>` | Check if number has WhatsApp |
| `/reg code <phone> [method]` | Request verification code |
| `/reg confirm <phone> <code>` | Complete registration |
| **Connection** | |
| `/connect <phone>` | Connect to WhatsApp |
| `/disconnect` | Disconnect current session |
| `/reconnect` | Force reconnection |
| `/session` | Show session info |
| `/help` | Show all commands |
| `/quit` / `/exit` | Disconnect and exit |

---

## WhatsApp IDs

- Individual contacts: `[countrycode][number]@s.whatsapp.net`
  - Example: `919634847671@s.whatsapp.net`
- Groups: `[groupid]@g.us`
  - Example: `120363000000000000@g.us`
- Status broadcast: `status@broadcast`
- Broadcast lists: `[timestamp]@broadcast`

> [!NOTE]
> Phone numbers must include the country code without the `+` prefix.

## Transport

whalibmob uses **Noise_XX_25519_AESGCM_SHA256** over TCP to `g.whatsapp.net:443`:

1. Client sends `ClientHello` with an ephemeral X25519 public key.
2. Server replies `ServerHello` (ephemeral + encrypted static + payload).
3. Three DH steps (EE, SE, SS) derive the final session keys.
4. Client sends `ClientFinish` (encrypted static + encrypted payload).
5. The library waits for a `<success>` stanza before emitting `connected`, or `<failure>` for `auth_failure`.

Automatic reconnection uses exponential backoff:

| Attempt | Delay |
|---|---|
| 1 | 1 s |
| 2 | 2 s |
| 3 | 4 s |
| 4 | 8 s |
| 5 | 15 s |
| 6+ | 30 s |

## Media Encryption

### Sending (upload flow)

1. A random 32-byte **media key** is generated.
2. HKDF-SHA256 expands it into IV (16 bytes), cipher key (32 bytes), and MAC key (32 bytes).
3. The file is encrypted with **AES-256-CBC**.
4. A 10-byte **HMAC-SHA256** MAC is appended to the ciphertext.
5. The encrypted blob is uploaded to the WhatsApp CDN.
6. The media key and CDN URL are embedded in the Signal-encrypted message envelope sent to the recipient.

### Receiving (download + decrypt flow)

When you receive a media message, `msg.decoded` contains:
- `url` — the HTTPS CDN link to download the encrypted blob
- `mediaKey` — the 32-byte key (as a `Buffer`) needed to decrypt it
- `directPath` — CDN path (fallback if full URL is unavailable)

The decryption process mirrors the upload:

| Step | Operation |
|---|---|
| 1 | Download encrypted blob from CDN URL |
| 2 | HKDF-SHA256(`mediaKey`, `""`, `"WhatsApp <Type> Keys"`, 112) → expanded key material |
| 3 | Split: `[0:16]` = IV · `[16:48]` = AES cipher key · `[48:80]` = HMAC key |
| 4 | Verify: `HMAC-SHA256(macKey, IV ∥ ciphertext)[:10]` must equal last 10 bytes of blob |
| 5 | Decrypt: `AES-256-CBC(cipherKey, IV, ciphertext)` — strip last 10 bytes first |

HKDF info strings:

| Media type | Info string |
|---|---|
| `image` / `sticker` | `WhatsApp Image Keys` |
| `video` | `WhatsApp Video Keys` |
| `audio` / `voice` | `WhatsApp Audio Keys` |
| `document` | `WhatsApp Document Keys` |

See the [Receiving Media](#receiving-media) section for a complete working code example.

## Device Emulation

whalibmob can emulate any iOS or Android device when communicating with WhatsApp servers.
The device profile controls the User-Agent header, the Noise Protocol `platform` field, and the static token used in registration token computation.

Configuration is done entirely through environment variables — no code changes required.
Copy `.env.example` to `.env` in your project root and set the variables you need.

### Device Quick Start

Emulate an Android Pixel 8 Pro:

```sh
WA_OS=android WA_DEVICE=pixel_8_pro node your-app.js
```

Or put the variables in a `.env` file. When using the **CLI** (`wa` command) the file is loaded automatically. When using the **library directly**, load it before `require('whalibmob')`:

```js
require('dotenv').config()          // must be first
const { WhalibmobClient } = require('whalibmob')
```

```dotenv
WA_OS=android
WA_DEVICE=pixel_8_pro
```

Emulate a custom Samsung device:

```dotenv
WA_OS=android
WA_DEVICE_MODEL=SM-S928B
WA_DEVICE_MANUFACTURER=samsung
WA_DEVICE_OS_VERSION=14
WA_DEVICE_BUILD=UP1A.231005.007
WA_DEVICE_MODEL_ID=samsung-sm-s928b
```

### iOS Profiles

Available values for `WA_DEVICE` when `WA_OS=ios` (default):

| Profile key | Device | iOS version |
|---|---|---|
| `iphone_15_pro` | iPhone 15 Pro | 17.4.1 |
| `iphone_15` | iPhone 15 | 17.4.1 |
| `iphone_14_pro` | iPhone 14 Pro | 16.7.5 |
| `iphone_14` | iPhone 14 | 16.7.5 |
| `iphone_13_pro` | iPhone 13 Pro | 16.7.5 |
| `iphone_13` | iPhone 13 | 16.7.5 |
| `iphone_12_pro` | iPhone 12 Pro | 15.8.2 |
| `iphone_12` | iPhone 12 | 15.8.2 |
| `iphone_11_pro` | iPhone 11 Pro | 15.8.2 |
| `iphone_11` | iPhone 11 | 15.8.2 |
| `iphone_se3` | iPhone SE (3rd gen) | 16.7.5 |
| `iphone_xs` | iPhone Xs | 15.8.2 |

iOS User-Agent format: `WhatsApp/<version> iOS/<osVersion> Device/<model>`

### Android Profiles

Available values for `WA_DEVICE` when `WA_OS=android`:

| Profile key | Device | Android version |
|---|---|---|
| `pixel_8_pro` | Pixel 8 Pro | 14 |
| `pixel_8` | Pixel 8 | 14 |
| `pixel_7` | Pixel 7 | 14 |
| `pixel_7a` | Pixel 7a | 14 |
| `samsung_s24_ultra` | Samsung Galaxy S24 Ultra | 14 |
| `samsung_s24` | Samsung Galaxy S24 | 14 |
| `samsung_s23_ultra` | Samsung Galaxy S23 Ultra | 14 |
| `samsung_s23` | Samsung Galaxy S23 | 14 |
| `samsung_a55` | Samsung Galaxy A55 | 14 |
| `oneplus_12` | OnePlus 12 | 14 |
| `oneplus_11` | OnePlus 11 | 13 |
| `xiaomi_14` | Xiaomi 14 | 14 |
| `xiaomi_13` | Xiaomi 13 | 13 |
| `oppo_find_x7` | OPPO Find X7 | 14 |
| `realme_gt5` | realme GT 5 Pro | 14 |

Android User-Agent format: `WhatsApp/<version> A`

The Android version is fetched automatically from the Google Play Store on first use and cached in memory. If the fetch fails, `ANDROID_VERSION_FALLBACK` is used.

### Custom Device Fields

These variables override individual fields on top of the selected profile:

| Variable | Description |
|---|---|
| `WA_DEVICE_MODEL` | Device model string (e.g. `SM-S928B`) |
| `WA_DEVICE_MANUFACTURER` | Manufacturer name (e.g. `samsung`) |
| `WA_DEVICE_OS_VERSION` | OS version string (e.g. `14`) |
| `WA_DEVICE_BUILD` | Build fingerprint (e.g. `UP1A.231005.007`) |
| `WA_DEVICE_MODEL_ID` | Model ID slug (e.g. `samsung-sm-s928b`) |

### Version & Token Overrides

| Variable | Description |
|---|---|
| `WA_VERSION` | Pin the WhatsApp version (e.g. `2.24.13.80`). Skips the live store fetch. |
| `WA_STATIC_TOKEN` | Override the static token used in registration token computation. |

## License

MIT
