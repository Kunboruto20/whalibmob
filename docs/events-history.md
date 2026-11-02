# Handling Events & History Sync

[← Back to the README](../README.md) · [Documentation index](../README.md#documentation)

---

## Handling Events

whalibmob uses the EventEmitter syntax for events.

### Example to Start

```js
const { WhalibmobClient } = require('whalibmob')
const os   = require('os')
const path = require('path')

async function main() {
  const client = new WhalibmobClient({
    sessionDir: path.join(os.homedir(), '.waSession')
  })

  client.on('connected', () => console.log('connected'))

  // The client reconnects on its own after a dropped connection. Only log here:
  // building a second client in this handler would put two connections on the
  // same account, and one more after every drop.
  client.on('disconnected', () => console.log('disconnected'))
  client.on('reconnecting', ({ attempt, delay }) =>
    console.log('reconnecting in', delay, 'ms, attempt', attempt))
  client.on('reconnected', () => console.log('reconnected'))

  client.on('message', msg => {
    const d = msg.decoded
    if (d && d.type === 'text') console.log('message from', msg.from, d.text)
  })

  // The one case the client will not retry: the session itself is gone.
  client.on('auth_failure', ({ reason }) => {
    console.error('session revoked:', reason)
    process.exit(1)   // re-register the number, or link it again
  })

  await client.init('919634847671')            // resolves once logged in
  await client.sendText('919876543210', 'Hello!')
}

main().catch(err => { console.error(err.message || err); process.exit(1) })
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
| `call` | `{ from, id, status, tag, creator, creatorAlt, groupJid, platform, version, reason, ts, node }` | A call stanza. `id` is what `rejectCall()` needs, `creator` is who placed the call (it differs from `from` in a group), and `status` is the stage: `offer`, `offer_notice`, `ringing`, `accept`, `preaccept`, `transport`, `terminate`, `reject` or `unknown` |
| `chat_read` | `{ jid, read, remote?, synced? }` | Chat marked read (`read: true`) or unread (`read: false`) |
| `chat_muted` | `{ jid, muted, until, remote?, synced? }` | Chat muted or unmuted; `until` is epoch ms (−1 = indefinite) |
| `chat_pinned` | `{ jid, pinned, remote?, synced? }` | Chat pinned or unpinned |
| `blocklist` | `{ action, dhash, prevDhash, changes }` | Block list changed on another device; `changes` is `[{ jid, action }]` |
| `privacy_settings` | `{ changes, settings }` | Privacy settings changed on another device |
| `chat_archived` | `{ jid, archived, remote?, synced? }` | Chat archived or unarchived |
| `message_starred` | `{ msgId, chatJid, starred, fromMe?, remote?, synced? }` | Message starred or unstarred |
| `chat_removed` | `{ jid, kind, remote }` | A chat was cleared or deleted on another device |
| `contact_update` | `{ jid, name, firstName, lid, username, removed, remote }` | A contact was renamed or removed elsewhere |
| `push_name_update` | `{ name, remote }` | Your own display name changed on another device |
| `app_state_sync` | `{ collections, applied }` | An app-state sync finished; see [Reading Changes Made Elsewhere](messaging.md#reading-changes-made-elsewhere) |
| `app_state_mutation` | `{ collection, index, action, removed }` | An app-state change this library does not model |
| `app_state_key_missing` | `{ collection, keyId }` | App state cannot be read until your phone shares this key |
| `app_state_keys` | `{ keys }` | Your phone shared app-state sync keys; a sync starts automatically |
| `account_restriction` | `{ active, remaining, remainingMs, endsAtDate, enforcementType, reason, source }` | The account was restricted or the restriction was lifted — see [When 463 Means the Account Is Restricted](#when-463-means-the-account-is-restricted) |
| `mex_notification` | `{ opName, data }` | A server push over `w:mex` this library does not model |

`remote: true` on a chat event means the change was made on your phone or another
linked device rather than by this session. Your own calls carry `synced` instead,
saying whether the change reached app state — see
[Modifying Chats](messaging.md#modifying-chats).
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
  fromMe:      boolean,  // you sent this from another of your own devices
  chat:        string,   // the conversation — equals from unless fromMe is true
}
```

> [!NOTE]
> When you send a message from your phone, WhatsApp echoes a copy of it to every
> other device on the account, wrapped in a `DeviceSentMessage`. On that copy
> `from` is **your own JID** — it names the sender, not the chat. Use `chat`,
> which is the conversation whichever direction the message went, and `fromMe`
> to tell the two apart. The envelope's own fields are on
> `decoded.deviceSentMeta` (`destinationJid`, `phash`) if you need them raw.
> These messages are not answered with a read receipt: nothing was read by
> receiving your own message back.

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

// Personal invitation into a group — see Personal Invitations
{ type: 'groupInvite', groupJid: string, inviteCode: string, inviteExpiration: number,
  groupName: string, jpegThumbnail: Buffer|null, caption: string, isCommunity: boolean }

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
| `<phone>.appStateKeys.json` | App-state sync keys, shared by your primary device |
| `<phone>.appState.json` | Per-collection app-state version, hash and index map |
| `<phone>.tctoken.json` | Trusted-contact token store (tcToken per contact JID) |

### Reading the History Store

After history sync completes, the client hands both files back parsed. On a
companion they are the `.web.` files; either call returns `null` until the first
history sync has written one:

```js
// ── Read chats ────────────────────────────────────────────────────────────────
const hist = client.getHistoryStore()     // <phone>.history.json, parsed
const msgs = client.getMessagesStore()    // <phone>.messages.json, parsed
if (!hist || !msgs) throw new Error('no history synced yet')

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
const msgList = Object.values(msgs).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
console.log('Total messages indexed:', msgList.length)
console.log('Latest:', msgList[0])
```

Without a client, read the files themselves. They sit in the number's own
folder, which `sessionDirFor()` resolves (it also finds a session kept in the
older layout, loose in the base folder):

```js
const fs   = require('fs')
const os   = require('os')
const path = require('path')
const { sessionDirFor } = require('whalibmob')

const phone = '919634847671'
const dir   = sessionDirFor(path.join(os.homedir(), '.waSession'), phone)
const hist  = JSON.parse(fs.readFileSync(path.join(dir, phone + '.history.json'), 'utf8'))
```

### LID ↔ Phone Number on a Live Client

Messages more and more often arrive from a LID (`…@lid`) rather than a phone
number. The client keeps the pairs it has learned — from history sync, from
message senders and from earlier sessions — and answers from memory, without a
request to the server:

```js
client.getLIDForPN('919634847671@s.whatsapp.net')   // '112345678901234@lid', or null
client.getPNForLID('112345678901234@lid')           // '919634847671@s.whatsapp.net', or null
```

Both accept a bare number or a full JID, device suffix included, and return
`null` for a pair the client has not seen yet.

### Asking for Older Messages

On a companion, `fetchMessageHistory()` asks the phone for messages older than
one you already have. The answer arrives later, as an ordinary `history_sync`:

```js
// key and timestamp of the oldest message you hold in that chat
const oldest = { remoteJid: '919634847671@s.whatsapp.net', id: '3EB0A1B2C3D4E5F6', fromMe: false }
await client.fetchMessageHistory(50, oldest, 1730000000000)   // count, key, timestamp in ms
```

The phone decides how much it sends, and sends nothing for a chat it no longer
holds.

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
| **First contact** | The very first DM to a contact has no token on file yet. Before the stanza is built, the library issues one and waits for it, so that message carries a `<tctoken>` like every later one instead of counting as an anonymous reach-out. The wait is bounded by `tcTokenPresendTimeoutMs` (default 5 s) — past it the message goes out regardless and the token lands in time for the next one. |
| **Attach on send** | Before dispatching any DM, `MessageSender` looks up the token for the recipient JID, checks it has not expired (28-day rolling window), and pushes a `<tctoken>` child node into the message stanza. |
| **Renewal** | After a successful DM send, the library fires a `<iq type='set' xmlns='privacy'>` requesting a fresh token for that JID from the server — once per 7-day bucket, deduplicated in-flight. This one is fire-and-forget: the token being attached right now is still valid, so nothing waits for it. |
| **Incoming notification** | When a contact starts a new conversation, WhatsApp pushes a `<notification type='privacy_token'>`. The library catches it in `_handlePrivacyTokenNotification` and stores the token immediately. |
| **Identity change re-issue** | When decrypting a `pkmsg` (new Signal session from peer), the library calls `_reissueTcTokenAfterIdentityChange` to re-issue the token for the new session. |
| **Error 463 recovery** | If a send fails with error 463, the library issues a fresh token, waits for the server response, and automatically retries the same message with the new token attached. |
| **Expiry** | Tokens use a 4-bucket rolling window (4 × 7 days = 28-day TTL). Expired tokens are cleared before the send and a fresh one is requested proactively. |

Token storage uses the **LID JID** of the contact (e.g. `112345678901234@lid`) as the key — never the phone-number JID — matching WhatsApp's internal convention.

**cstoken — the companion fallback.** When there is no `<tctoken>` for a recipient, the genuine client attaches a `<cstoken>` instead. Unlike a tctoken it is not granted per contact; it is computed locally:

```
cstoken = HMAC-SHA256(nctSalt, recipient-LID)
```

The `nctSalt` is an account-wide secret the server distributes over app state, so only a **companion (QR / pairing-code) session** ever holds one — a primary (SMS) session has none and sends no cstoken, exactly as the real primary does until it has minted its own. When a companion session receives the salt it fires a `nct_salt` event and persists it; from then on, any first DM without a tctoken carries a `<cstoken>` derived for that recipient's LID. Like the rest of this section it is fully automatic — there is nothing to call.

<a id="account-restriction"></a>

### When 463 Means the Account Is Restricted

A `463` has two causes that look identical on the wire, and telling them apart matters because only one of them is worth retrying.

- **No privacy token for that one contact.** The library issues one and re-sends. This is the common case and it resolves itself.
- **The account is restricted.** WhatsApp has decided you are starting too many chats with people who never reply, and refuses *all* new conversations until the restriction expires. Existing chats keep working, which is why the account otherwise looks healthy. No retry helps — and sending more counts as further reach-outs, which makes it longer.

The expiry is never pushed to a client that has not asked. `fetchReachoutTimelock()` is the only way to learn it:

```js
const r = await client.fetchReachoutTimelock()

if (r.active) {
  console.log('restricted:', r.reason)
  console.log('ends at:   ', r.endsAtDate.toISOString())
  console.log('remaining: ', r.remaining)      // '04:59:20'
} else {
  console.log('not restricted')
}
```

```js
{
  active:          true,
  remaining:       '04:59:20',   // HH:MM:SS, hours not wrapped at 24
  remainingMs:     17960000,
  endsAt:          1800018000000,
  endsAtDate:      Date,
  enforcementType: 'BIZ_QUALITY',
  reason:          'too many people you messaged blocked or reported you',
  expiryUnknown:   false,        // true when the server withheld the end time
  checkedAt:       1800000040000
}
```

`getReachoutTimelock()` returns the same shape from what was last learned, without asking again — the countdown is recomputed on every call, so it is what a once-a-second display reads.

**You rarely need to call either.** A send refused with 463 triggers a check on its own (rate-limited to once a minute), and the server pushes an update both when a restriction starts and when it is lifted:

```js
client.on('account_restriction', (r) => {
  if (r.active) console.log('restricted for', r.remaining, '—', r.reason)
  else          console.log('restriction lifted')
})
```

`r.source` is `'notification'` when the server announced it and `'query'` when we asked.

> [!NOTE]
> A first restriction is usually around five hours. Repeats get longer. Nothing
> client-side shortens it; the only thing that helps is not sending more
> unanswered first messages while it is on.

> [!NOTE]
> **This transport answers in one of two encodings**, and the reply says which:
> JSON, or Argo — Meta's compact binary encoding for GraphQL. Both are read.
> WhatsApp sends Argo with its self-describing flag set, so it carries its own
> field names and decodes without the GraphQL schema the query was written
> against.
>
> Do not add a `format` attribute to the query in the hope of steering this — it
> was tried against a live server, which responded by dropping the stanza
> entirely and answering nothing.
>
> Some servers answer tersely — a bare `false` or `true` rather than the object
> with the expiry in it. `false` is taken as "no restriction", because it is a
> definite answer rather than a missing one. `true` sets `active` with
> `expiryUnknown: true`, since it says there is a restriction but not when it
> ends; the countdown then comes from the announcement.
>
> An answer that is neither — `null`, or anything that says nothing either way —
> throws with the decoded value on `err.mexDecoded`, rather than being reported
> as "not restricted". An all-clear invented from an answer that never gave one
> would have you send more messages and lengthen the very restriction you were
> asking about.
>
> The `account_restriction` event does not depend on any of this. The server
> *announces* a restriction starting and lifting, and those announcements carry
> the countdown. Keep a listener attached and you are told either way.

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
| Sync app state when the server says it changed | ✅ | Pins, archives, mutes, stars, contact names |
| Verify app-state MACs and LT hash | ✅ | A collection that drifts is re-read from a snapshot |
| Persist app-state versions across restarts | ✅ | Written to `<phone>.appState.json` |
| Seed tcTokens into memory on connect | ✅ | Prevents error 463 on first send after reconnect |
| Attach tcToken to every outbound DM | ✅ | |
| Issue fresh tcTokens after each send | ✅ | Once per 7-day bucket per contact |
| Handle incoming `privacy_token` notifications | ✅ | |
| Re-issue tcToken after peer identity change | ✅ | |
| Recover from error 463 with automatic retry | ✅ | |
| Check for an account restriction after a 463 | ✅ | Rate-limited to once a minute |
| Track restriction start / lift pushed by the server | ✅ | Raised as `account_restriction` |
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



---

[← Back to the README](../README.md) · [Documentation index](../README.md#documentation)
