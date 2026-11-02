# Sending & Receiving Messages

[← Back to the README](../README.md) · [Documentation index](../README.md#documentation)

---

## Receiving Media

When a media message arrives, `msg.decoded` carries the CDN location and the
`mediaKey` the file is encrypted under. `client.downloadMedia()` fetches it and
hands back the plaintext bytes:

```js
const fs = require('fs')

const EXT = { image: '.jpg', video: '.mp4', audio: '.ogg', voice: '.ogg',
              sticker: '.webp', document: '' }

client.on('message', async (msg) => {
  const d = msg.decoded
  if (!d || !d.mediaKey) return

  try {
    const bytes = await client.downloadMedia(d)
    const name  = d.fileName || (msg.id + (EXT[d.type] || ''))
    fs.writeFileSync(name, bytes)
    console.log('saved', d.type, 'to', name)
  } catch (e) {
    console.error('media download failed:', e.message)
  }
})
```

It works the same in both modes, and that is the point: the CDN applies a
browser check on the way **down** as well as on the way up, so a companion has to
identify itself as one here too. Doing this by hand means knowing that, and
knowing which HKDF key name each media type derives from — a voice note derives
from the PTT keys and a GIF from the video ones, not from their own. Get either
wrong and the download is refused or the decryption yields garbage.

The whole message object is accepted as well as its `decoded` half, so
`client.downloadMedia(msg)` does the same thing.

**Verifying the file**

Three things are checked, and all three by default — the message says what the
file should be, so there is no reason to take the CDN's word for it:

| check | what it covers |
|---|---|
| `fileEncSha256` | the blob as it arrived, before any work is spent decrypting it |
| the MAC | the ciphertext, under a key derived from `mediaKey` — this is the one that authenticates |
| `fileSha256` | the decrypted file |

```js
const bytes = await client.downloadMedia(d)                    // all three
const raw   = await client.downloadMedia(d, { verify: false }) // MAC only
```

`verify: false` skips the two digests for a caller that wants the bytes whatever
they are. The MAC is checked either way and is never optional.

**Link preview thumbnails**

A text message that quoted a link carries the preview the sender's client built.
The small inline image is already on the message as `jpegThumbnail` and needs no
download. The full-size one is a media file of its own — its own `directPath`,
its own `mediaKey`, encrypted under a key name of its own — so `downloadMedia`
cannot reach it:

```js
if (d.thumbnail) {
  const preview = await client.downloadThumbnail(d)
  // d.title, d.description and d.matchedText are the rest of the preview
}
```

**What happens underneath**

1. The encrypted blob is fetched from `url`, or from `directPath` when the
   message carries no absolute URL.
2. HKDF-SHA256 expands `mediaKey` into an IV, a cipher key and a MAC key, using
   the info string for that media type.
3. The trailing 10-byte HMAC-SHA256 is verified, then AES-256-CBC decrypts the
   rest.

`downloadMedia` throws with the reason rather than returning empty: a message
with no media, no CDN location, an unsupported type, or a file that does not
match the message all say so.

### View-once and disappearing messages

Some messages arrive inside an envelope. A photo sent as **view-once** is an
ordinary `ImageMessage` wrapped in a `ViewOnceMessage`; the same photo in a
chat with **disappearing messages** turned on is one wrapped in an
`EphemeralMessage`. Nothing about the photo changes — the envelope only records
how it was sent.

The decoder opens them, so nothing special is needed on your side. `msg.decoded`
is the photo, and `downloadMedia()` works on it exactly as it does on any other:

```js
client.on('message', async (msg) => {
  const d = msg.decoded
  if (!d || !d.mediaKey) return

  if (d.viewOnce)  console.log('sent as view-once')
  if (d.ephemeral) console.log('from a disappearing chat')

  const bytes = await client.downloadMedia(d)   // same call, wrapped or not
})
```

Three flags say how the message was sent, and are absent otherwise:

| flag | meaning |
|---|---|
| `d.viewOnce` | sent as view-once — `ViewOnceMessage`, `ViewOnceMessageV2` or the V2 extension a voice note uses |
| `d.ephemeral` | from a chat with disappearing messages on |
| `d.edited` | the new text of an edited message — the payload is the `protocol` message carrying it |

They stack. A view-once photo in a disappearing chat carries both:

```js
if (d.viewOnce && d.ephemeral) { /* … */ }
```

Documents sent with a caption (`DocumentWithCaptionMessage`) are unwrapped the
same way and decode as a plain `document`, with no flag of their own.

> [!NOTE]
> Opening the envelope is what makes this media reachable at all. Before it, a
> view-once photo decoded as `{ type: 'unknown' }` — no `mediaKey`, no
> `directPath` — and there was nothing for `downloadMedia()` to fetch.

Nothing here changes when the message came through history sync, or when it is
one of your own echoed back to this device from another: those envelopes nest,
and are unwrapped down to the message inside.

### When the file is gone from the CDN

Media is not carried inside the message — the message carries a URL, a hash and
the key, and the bytes sit on WhatsApp's CDN for a limited time. A download that
answers **404** or **410** has nothing left to fetch. This is most common for
messages that arrive through history sync long after they were sent.

The sender's phone still has the original, and can be asked to upload it again:

```js
client.on('media_retry', (notification) => {
  const result = client.decryptMediaRetry(notification, mediaKey)
  if (result.ok) {
    // fresh location — download it the usual way
    console.log('re-uploaded at', result.directPath)
  } else {
    // the phone no longer has it either; nothing further to try
  }
})

try {
  await client.downloadMedia(msg)
} catch (err) {
  if (/404|410/.test(err.message)) {
    await client.requestMediaRetry({
      id:          msg.key.id,
      chatJid:     msg.key.remoteJid,
      fromMe:      msg.key.fromMe,
      // groups only — the member who sent it
      participant: msg.key.participant
    }, mediaKey)
  }
}
```

`requestMediaRetry` resolves as soon as the request is on the wire; the answer
arrives later on the `media_retry` event, which is why the two halves are
written separately. Keep the `mediaKey` — the reply is encrypted under a key
derived from it, and without it the fresh location cannot be read.

That derivation is also what makes the request safe to send: it proves the
asker was a recipient of the message rather than someone who merely knows a
message id, so no phone can be made to re-upload a file on request.

## Sending Messages

### Text Message

```js
await client.sendText('919634847671', 'Hello!')
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
await client.sendReaction('919634847671', 'MSGID123', '👍')

// remove a reaction — pass empty string
await client.sendReaction('919634847671', 'MSGID123', '')
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
await client.deleteMessage('MSGID123', '919634847671', true, false)

// delete for everyone (revoke)
await client.deleteMessage('MSGID123', '919634847671', true, true)
```

### Forward Message

Forward text or a full media message (image, video, audio, document, sticker) without
re-uploading.  Pass a decoded message object from the `message` event to forward any media type.

```js
// Forward text
await client.forwardMessage('919634847671', 'text to forward')

// Forward any received message (full media, no re-upload)
client.on('message', async (msg) => {
  if (msg.decoded && msg.decoded.type !== 'text') {
    await client.forwardMessage('919634847671', msg)
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
// encKey (32-byte Buffer) is what reads the votes — keep it
// (also returned as `messageSecret`, which is the name the protocol uses)
```

**Reading the votes**

A vote arrives as its own message and the ballot inside it is encrypted, so
nothing about who chose what is visible in the stanza. `decryptPollVote()` opens
it with the poll's `encKey`:

```js
const options = ['JavaScript', 'Python', 'Rust']

client.on('message', (msg) => {
  if (msg.decoded?.type !== 'pollVote') return
  if (msg.decoded.pollKey.id !== id) return      // a vote on some other poll

  const { selected, votedAt } = client.decryptPollVote(msg, { encKey, options })
  console.log(msg.participant, 'voted for', selected)   // [ 'Rust' ]
})
```

Pass `options` and the choices come back as text. Without them you get
`selectedHashes` — the SHA-256 of each chosen option, which is how the ballot
names them on the wire — and match them yourself.

The key is derived from the poll id, the poll's sender and the voter, so a vote
on someone else's poll needs their `encKey`, which only arrives if they sent the
poll to you: read it off `msg.decoded.encKey` on the poll message itself.

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
await client.sendLocation('919634847671', 48.8566, 2.3522)

// with name and address
await client.sendLocation('919634847671', 48.8566, 2.3522, {
  name:    'Eiffel Tower',
  address: 'Champ de Mars, 5 Av. Anatole France, Paris'
})

// to a group
await client.sendLocation('120363000000000000@g.us', 51.5074, -0.1278, {
  name: 'London'
})

// with a map image for the bubble — WhatsApp draws a blank card without one
await client.sendLocation('919634847671', 48.8566, 2.3522, {
  name: 'Eiffel Tower',
  thumbnail: jpegBuffer
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

await client.sendContact('919634847671', 'Alice Smith', vcard)
```

### Call Link

Ask WhatsApp for a link that lets someone join a call by tapping it, instead of
being rung. Returns the token, the shareable link and the media type.

```js
const { link } = await client.createCallLink('video')
// https://call.whatsapp.com/video/XXXXXXXX

// audio is the default
const audio = await client.createCallLink()

// schedule it — startTime is seconds since the epoch
await client.createCallLink('video', { startTime: 1800000000 })

// create it and send it in one step
await client.sendCallLink('919634847671', 'video', {
  text: 'Join me here:'
})
```

## Media Messages

Photos and videos are sent with an inline preview so they show up in the chat
directly, rather than as a placeholder the recipient has to tap. The dimensions
are read out of the file header with no dependency at all. The preview itself
uses `jimp` (installed automatically as an optional dependency) or `sharp` if
you have it; failing both, a photo that carries an EXIF thumbnail gets one for
free, and anything else is scaled in process — JPEG, PNG, GIF and BMP all work
with nothing installed. Video previews need `ffmpeg` on PATH — on Termux,
`pkg install ffmpeg`. Without any of these the media still sends, just without
the preview.

### Image Message

```js
// from file path
await client.sendImage('919634847671', './photo.jpg', { caption: 'Look at this' })

// from Buffer
await client.sendImage('919634847671', buffer, {
  caption: 'Photo',
  mimetype: 'image/jpeg'
})
```

### Video Message

```js
await client.sendVideo('919634847671', './clip.mp4', { caption: 'Watch this' })
```

### Audio Message

```js
await client.sendAudio('919634847671', './song.mp3')
```

### Voice Note

```js
// ptt: true renders the audio as a push-to-talk voice note with waveform
await client.sendAudio('919634847671', './voice.ogg', { ptt: true })
```

### Document Message

```js
await client.sendDocument('919634847671', './report.pdf', {
  fileName: 'Q1 Report.pdf'
})
```

### Sticker Message

```js
await client.sendSticker('919634847671', './sticker.webp')
```

## Status / Stories

A Status is posted to `status@broadcast` and travels the SenderKey path a group
message does — one encrypted body plus a key distribution to every recipient.
Who those recipients are comes from your status privacy settings, resolved
against the contacts in the synced history store.

```js
// text
await client.sendStatus('Good morning!')

// photo, video, voice — same arguments as the matching send* methods
await client.sendStatus({ image: './photo.jpg', caption: 'Look at this' })
await client.sendStatus({ video: './clip.mp4' })
await client.sendStatus({ audio: './voice.ogg' })

// styled text status
await client.sendStatus('Colorful', { backgroundArgb: 0xFF25D366, font: 3 })

// post to an explicit list instead of the privacy-derived one
await client.sendStatus('Hi', { recipients: ['919634847671'] })
```

### Status Privacy

```js
const [def, ...rest] = await client.queryStatusPrivacy()
// def = { type: 'contacts' | 'blacklist' | 'whitelist', isDefault, list }
```

`contacts` sends to everyone in your address book, `blacklist` to everyone
except `list`, `whitelist` to `list` only. Your own JID is always included so
the post reaches your other devices.

Recipients are taken from the named contacts history sync brought; when there
are none, the people you have chats with stand in. If neither is known,
`sendStatus` says so rather than posting a message no one holds the key for —
pass `recipients` in that case.

## Send States in Chat

### Reading Messages

```js
// mark all messages in a chat as read (sends IQ to server)
await client.markChatRead('919634847671')
```

### Mark Voice Message Played

Send a `played` receipt for a received voice note (push-to-talk audio). This tells the sender that you have listened to the message.

```js
// msgId: ID of the audio message, from: JID of the sender
client.markMessagePlayed('3EB0ABCDEF123456', '919634847671')
```

### Update Presence

```js
// set yourself as online / offline globally
client.setOnline(true)
client.setOnline(false)

// show typing or recording in a specific chat
client.setChatPresence('919634847671', 'composing')   // typing
client.setChatPresence('919634847671', 'recording')   // recording audio
client.setChatPresence('919634847671', 'paused')      // stopped
```

## Modifying Chats

Pinning, archiving, muting, marking read and starring are **app state**. That is
WhatsApp's own synchronised settings store — the same one your phone writes to —
so a change made here shows up on the phone and on every other linked device,
and survives reinstalling.

Each of these is `async`, sends a patch, and waits for the server to accept it.
The local view only moves once the change is actually stored, and they throw if
the server refuses.

They return a boolean: **whether the change reached app state**, and so whether
other devices will see it.

```js
const synced = await client.pinChat('919634847671')
if (!synced) console.log('pinned here, but your phone will not know')
```

> [!IMPORTANT]
> **App state needs a key, and where that key comes from depends on how you
> connected.**
>
> A **linked session** (pairing code) is a companion. Your phone shares an app
> state key with it automatically, shortly after linking — so everything on this
> page works, in both directions.
>
> An **SMS session** *is* the primary device. Nobody shares a key with it,
> because it is the device that would create one. Unless you have linked a
> companion to it, there is no app state to read or write.
>
> Check with `client.canSyncAppState()`.
>
> When there is no key, these calls **do not throw**. `muteChat`, `unmuteChat`
> and `markChatRead` fall back to the request a primary device sends for itself,
> which is what this library did before app state existed. `pinChat`,
> `archiveChat` and `starMessage` have no such request, so they update this
> session only. Either way the return value is `false`, which is how you tell.

### Archive / Unarchive a Chat

```js
await client.archiveChat('919634847671')
await client.unarchiveChat('919634847671')
```

### Mute / Unmute a Chat

```js
await client.muteChat('919634847671', 8 * 60 * 60 * 1000)  // 8 hours
await client.muteChat('919634847671', 0)                   // until unmuted
await client.unmuteChat('919634847671')
```

### Mark a Chat Read / Unread

This is the chat's own unread badge. To send read receipts (blue ticks) for
particular messages, use `markRead()` instead.

```js
await client.markChatRead('919634847671')
await client.markChatUnread('919634847671')
```

### Pin / Unpin a Chat

```js
await client.pinChat('919634847671')
await client.unpinChat('919634847671')
```

### Star / Unstar a Message

The third argument says whether the message being starred is one you sent. It is
part of how the star is filed, so getting it wrong stars a different message.

```js
await client.starMessage('MSGID123', '919634847671', true)   // yours
await client.unstarMessage('MSGID123', '919634847671', false) // theirs
```

<a id="app-state-sync"></a>

### Reading Changes Made Elsewhere

The traffic runs both ways. When you pin a chat on your phone, mute a group from
another linked device, or rename a contact, that change is waiting in app state
for this session to pick up.

`syncAppState()` fetches it. It is called for you whenever the server says
something has moved — so with a listener attached you generally never need to
call it by hand. On an SMS session with no companions linked there is nothing to
fetch, and it reports `waitingForKeys` instead.

```js
client.on('chat_pinned',     (u) => u.remote && console.log('pinned elsewhere:', u.jid))
client.on('chat_archived',   (u) => u.remote && console.log('archived elsewhere:', u.jid))
client.on('chat_muted',      (u) => u.remote && console.log('muted elsewhere:', u.jid, u.until))
client.on('chat_read',       (u) => u.remote && console.log('read elsewhere:', u.jid))
client.on('message_starred', (u) => u.remote && console.log('starred elsewhere:', u.msgId))
client.on('contact_update',  (u) => console.log('contact renamed:', u.jid, u.name))
client.on('push_name_update',(u) => console.log('your display name is now', u.name))
```

`remote: true` marks a change as somebody else's doing. Your own calls emit the
same events without it — they carry `synced` instead — so a listener can tell the
two apart and avoid echoing a change back where it came from.

To pull on demand:

```js
// everything
const r = await client.syncAppState()
console.log(r.applied, 'change(s)')

// or just one part of it
await client.syncAppState(['regular_low'])

// re-read everything from scratch, discarding what we hold
await client.syncAppState(null, { snapshot: true })
```

The result reports each collection separately:

```js
{
  applied: 3,
  collections: {
    regular_low: { version: 41, applied: 3, skipped: 0, snapshot: false, macOk: true }
  }
}
```

The five collections are `critical_block`, `critical_unblock_low`,
`regular_high`, `regular_low` and `regular`. Which one a setting lives in is
WhatsApp's choice, not yours — the methods above already file each change where
it belongs.

**When it repairs itself.** Each collection carries a running hash that has to
keep agreeing with the server's. If it stops — a patch went missing, or one
could not be decrypted — the incremental history is no longer trustworthy, so
that collection is thrown away and re-read whole. This happens on its own, once
per sync, and shows up as `snapshot: true` in the result.

**Events for anything not modelled here.** WhatsApp tracks more in app state than
this library turns into methods. Rather than dropping those, they are emitted
raw, so it is at least visible that something happened:

```js
client.on('app_state_mutation', ({ collection, index, action, removed }) => {
  console.log('unhandled app state change', index)
})
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
await client.changeEphemeralTimer('919634847671', 86400)
await client.changeEphemeralTimer('120363000000000000@g.us', 604800)

// remove disappearing messages
await client.changeEphemeralTimer('919634847671', 0)
```


---

[← Back to the README](../README.md) · [Documentation index](../README.md#documentation)
