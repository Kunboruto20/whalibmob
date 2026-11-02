# User Queries, Profile, Privacy & Account State

[← Back to the README](../README.md) · [Documentation index](../README.md#documentation)

---

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
const about = await client.queryAbout('919634847671')
console.log(about)

// your own, asked the same way
console.log(await client.queryOwnAbout())
```

### Fetch Profile Picture

```js
const url = await client.queryPicture('919634847671')
// also works for groups
const groupUrl = await client.queryPicture('120363000000000000@g.us')
```

### Subscribe to Presence

```js
// triggers 'presence' events when the contact comes online or goes offline
client.subscribeToPresence('919634847671')

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

// what the server actually has now — the set IQ is answered before the new
// text has to be visible anywhere, so this is the part worth reading
const stored = await client.queryOwnAbout()
```

`changeAbout` throws when the server refuses the change or never answers; it
used to hand back the reply unread, so a refusal looked exactly like a success.
An about is limited to 139 characters — a longer one is dropped rather than
refused, and that too is now a thrown error instead of silence.

An about the server stores and nobody can see is a privacy setting rather than a
failed write. The category that governs who may read it is `status`:

```js
await client.changePrivacySetting('status', 'all')
```

### Change Profile Picture

Both methods accept a **Buffer** (use `fs.readFileSync` to load a file).

```js
const fs = require('fs')

// change your own profile picture — any image, any shape, any size
// returns the new picture id, or 'remove' when it was taken down
const picId = await client.changeProfilePicture(fs.readFileSync('./avatar.jpg'))

// pass null to remove it
await client.changeProfilePicture(null)

// change a group's picture (you must be admin)
// returns the new picture id, or 'remove' when the picture was taken down
const picId = await client.changeGroupPicture('120363000000000000@g.us',
  fs.readFileSync('./group.jpg'))

// pass null to remove the current picture
await client.changeGroupPicture('120363000000000000@g.us', null)
```

`changeGroupPicture` throws when the server refuses — `406` for an image it will
not take, `403` when you are not an admin of that group.

> [!NOTE]
> The two are addressed differently, and it matters. A group picture names the
> group in the IQ's `target`; your own picture names nobody — the server takes
> that from the session. Your own JID in `target` is not an error the server
> reports, it is a stanza it drops without answering.

**Both calls re-encode the image before sending it.** WhatsApp wants a square
640×640 JPEG, and a picture that is not one is *dropped without an answer*
rather than refused — so an unprepared file fails as a timeout that looks like a
network fault. The image is cropped square, scaled and written out as a fresh
JPEG, which also strips EXIF and any progressive encoding the file was carrying.

**No image library is required.** JPEG, PNG, GIF and BMP are decoded, cropped
and re-encoded in process, so a bare `npm install` on a phone or a container
built without a compiler converts a picture just as well as a full desktop.
Whatever is installed is preferred, and the fallbacks run in this order:

| | Handles | Needs |
|---|---|---|
| `sharp` or `jimp` | everything, best quality | either installed |
| built in | JPEG, PNG, GIF, BMP | nothing |
| `ffmpeg` | WebP, HEIC, progressive JPEG | `ffmpeg` on PATH |
| metadata strip | an already-square JPEG | nothing |

The built-in converter also reads the EXIF orientation tag, so a photo taken in
portrait is turned upright instead of arriving on its side, and flattens
transparency onto white, since a JPEG has no alpha channel.

Only an exotic format with nothing installed — a WebP or a HEIC on a machine
with no `ffmpeg` — still fails, and the error says so rather than reporting a
bare `406`.

```js
// skip the re-encode if you have prepared the image yourself
await client.changeProfilePicture(buf, { raw: true })

// or choose the size
await client.changeProfilePicture(buf, { size: 640, quality: 50 })
```

### Account Email (recovery address)

An account can carry an email address, used to recover access when the number is
lost or the two-step PIN is forgotten.

> [!NOTE]
> This is **not** a registration-code channel — there is no email delivery at the
> `/code` step. Register the number first (SMS, voice, `wa_old` or flash) and
> connect; the email is bound on the live account and verified with a code the
> server sends to the inbox. Primary (mobile) sessions only — a companion link is
> refused.

```js
// 1. bind the address (not verified yet)
await client.setEmail('name@example.com')

// 2. ask the server to email a six-digit code
//    lg/lc only choose the language the email is written in
await client.requestEmailCode({ lg: 'en', lc: 'US' })

// 3. submit the code the user read from their inbox
const r = await client.verifyEmailCode('123456')
// r → { verified: true, autoVerifyFailed: false, email: null, waitTimeSeconds: 0 }

// 4. confirm ownership
if (!r.verified) throw new Error('The email code was not accepted')
await client.confirmEmail()

// read the current binding any time
const status = await client.getEmailStatus()
// status → { email: 'name@example.com', verified: true, confirmed: true }
```

Each call throws with the server's reason when it is refused — `535` the code
expired, `536` the code is wrong, `537` too many wrong tries, `534` locked out,
`403` not allowed for this account.

`confirmEmail()` defaults to the `settings` context. OTP verification
uses the account GET operation and its `code_match` reply; status reads the
`verified` child element. Email IQs have a 32-second deadline. `EMAIL_IQ_TIMEOUT`,
`EMAIL_IQ_DISCONNECTED` and `EMAIL_IQ_UNCERTAIN` mean the outcome is unknown:
read status before repeating a change or asking for another code.

## Privacy

### Block / Unblock User

```js
// both return the updated block list, and throw if the server refuses
const blocked = await client.blockContact('919634847671')
await client.unblockContact('919634847671')

// the block list is addressed by LID; a phone number is resolved to one first,
// looking it up if it is not already known

// blocking done from the phone arrives as an event
client.on('blocklist', ({ changes }) => console.log(changes))
```

### Get Block List

```js
const list = await client.queryBlockList()
console.log(list)   // [ '919634847671@s.whatsapp.net', ... ]
```

### Update Privacy Settings

```js
// type:  'last_seen' | 'profile_picture' | 'status' | 'online' | 'read_receipts'
//        'groups_add' | 'call_add' | 'messages' | 'defense' | 'stickers'
// value: 'all' | 'contacts' | 'contact_blacklist' | 'contact_allowlist' | 'none'
//        'match_last_seen' | 'known' | 'on_standard' | 'off'

// returns the settings as they now stand; throws if the server refuses
await client.changePrivacySetting('last_seen',        'contacts')
await client.changePrivacySetting('profile_picture',  'contacts')
await client.changePrivacySetting('status',           'contacts')
await client.changePrivacySetting('online',           'match_last_seen')
await client.changePrivacySetting('read_receipts',    'none')
await client.changePrivacySetting('groups_add',       'contacts')
await client.changePrivacySetting('call_add',         'known')
```

**Each setting takes its own values**, and they are not interchangeable:

| setting | accepts |
|---|---|
| `last_seen`, `profile_picture`, `status`, `groups_add` | `all` · `contacts` · `contact_blacklist` · `none` |
| `read_receipts` | `all` · `none` |
| `online` | `all` · `match_last_seen` |
| `call_add` | `all` · `known` |
| `messages` | `all` · `contacts` |
| `defense` | `on_standard` · `off` |
| `stickers` | `contacts` · `contact_allowlist` · `none` |

Friendlier words are translated: `on`, `off`, `everyone`, `nobody`,
`my_contacts`, `contacts_except`, `contact_whitelist`. `on` becomes `all` — or
`on_standard` for `defense`, which spells its on-state differently.

```js
await client.changePrivacySetting('read_receipts', 'on')    // sent as 'all'
await client.changePrivacySetting('read_receipts', 'off')   // sent as 'none'
```

A value the setting does not take throws before anything is sent. This matters
more than it looks: the server does not refuse an unknown value, it drops the
stanza and never answers, so the mistake would otherwise surface as a timeout
that looks like a network problem.

### Read Privacy Settings

```js
const s = await client.queryPrivacySettings()
// { lastSeen, profile, status, online, readReceipts,
//   groupAdd, callAdd, messages, defense, stickers }
// anything the server did not report is null

await client.queryPrivacySettings({ force: true })   // skip the cache

// a change made on the phone arrives as an event
client.on('privacy_settings', ({ changes, settings }) => console.log(changes))
```

Turning `read_receipts` off changes what read receipts go out: they become
`read-self`, which syncs the read state across your own devices without telling
the sender. The settings are fetched once after connect so this holds from the
first message.

### Update Default Disappearing Mode

```js
// sets the default ephemeral timer for all new chats
await client.changeNewChatsEphemeralTimer(86400)   // 1 day
await client.changeNewChatsEphemeralTimer(0)       // off
```

## Account State

Three things the app speaks on every account and whalibmob did not: the
server's own feature flags, the address book, and the legal notices an account
is asked to accept. Each is one IQ family; together they are part of what makes
a session look like an app rather than a script.

### AB Props

Every WhatsApp client asks the server which experiments and configuration
values apply to *this* account, then gates behaviour on the answer — how many
bytes an identity hash is truncated to, whether the LID migration has started
here, what sampling weight each telemetry event carries. A client that never
asks runs on guessed defaults wherever the server has an opinion.

This is synced automatically on every connect. You do not have to call it.

```js
const client = new WhalibmobClient({ sessionDir: './auth' })
await client.connect()

// Already synced by the time 'connected' fires. Read a value:
client.abProp(4405)              // '16'   — always a string on the wire
client.abPropInt(4405, 8)        // 16     — parsed, or 8 if unset/unparseable
client.abPropBool(5010, false)   // true   — understands "1"/"0" and "true"/"false"
```

Reading a prop before the first sync gives the fallback rather than throwing,
so gating on a flag never needs a guard:

```js
// Safe even on a client that has not connected yet.
const hashLen = client.abPropInt(4405, 8)
```

To re-sync by hand, or to look at the whole set:

```js
const props = await client.queryAbProps({ force: true })

console.log(props.hash)      // 'A1B2…' — rides on the next sync, asking for a delta
console.log(props.refresh)   // 86400 — seconds the server suggests waiting
console.log(props.delta)     // false — this reply was the whole table
console.log(props.props)     // { '4405': '16', '5010': 'true', … }
console.log(props.sampling)  // { '1200': 100, … }  telemetry weights
```

The hash is what turns the next request into a delta. A delta is **merged**
onto what is already held rather than replacing it — otherwise every prop the
server saw no reason to repeat would be dropped. The hash lives for the session
only: a fresh process asks for the full set again, which is what a fresh
install does.

Turn the automatic sync off if you do not want the extra IQ on a short session:

```js
new WhalibmobClient({ sessionDir: './auth', syncAbPropsOnConnect: false })
```

Being straight about the scope: nothing inside the library consumes these
values yet. What you get today is the ability to see what the server thinks
about an account — useful when one number behaves differently from another and
you would otherwise be guessing — plus one more request a real client makes.

### Contact Sync

The address-book upload a phone does on first launch, and the delta syncs after
it. It answers the question worth asking before a first message: **is this
number on WhatsApp at all?**

```js
const out = await client.syncContacts([
  '40712345678',
  '+55 11 91234-5678',
  '40799999999'
])

out.registered    // ['40712345678', '+55 11 91234-5678']  — on WhatsApp
out.unregistered  // ['40799999999']                       — not on WhatsApp
out.jids          // { '40712345678': '40712345678@s.whatsapp.net', … }
```

Numbers come back in the spelling you passed in, however they were written —
spaces, dashes and a leading `+` are all normalised before sending and restored
in the answer.

**A number the server did not answer about appears in neither list.** That is
deliberate. Reporting a timeout as "not on WhatsApp" is the one wrong answer
available here, because a caller acts on it — skipping the number, or deleting
it. Silence is not a verdict:

```js
const asked = phones.length
const known = out.registered.length + out.unregistered.length
if (known < asked) {
  console.log(`${asked - known} numbers went unanswered — try them again later`)
}
```

Large books are chunked automatically, and one unanswered chunk does not cost
the others their answers:

```js
await client.syncContacts(bigList, { chunkSize: 200 })   // default is 500
```

The mode says what the sync claims about your address book. `full` is the
whole book — what the app sends on first launch — and carries the
`registration` context by default. `delta` is what changed since. `query` is a
plain lookup that claims nothing:

```js
await client.syncContacts(phones)                      // mode 'full',  context 'registration'
await client.syncContacts(phones, { mode: 'delta' })   // mode 'delta', context 'interactive'
await client.syncContacts(phones, { mode: 'query' })   // a lookup, nothing claimed
```

This is **not** called automatically on connect. Uploading an address book is
your decision, not a side effect of connecting.

Where it earns its place is in front of a batch of first messages, together
with the token path described under
[tcToken](events-history.md#tctoken--error-463-defense):

```js
// 1. Which of these actually exist?
const { registered } = await client.syncContacts(numbers)

// 2. Warm a trusted-contact token for each, so the first message carries one.
for (const n of registered) {
  const jid = `${n.replace(/\D/g, '')}@s.whatsapp.net`
  await client.ensureTcTokenBeforeSend(jid, jid)
  await new Promise(r => setTimeout(r, 300))
}

// 3. Send. No wasted sends to dead numbers, and no anonymous reach-outs.
for (const n of registered) {
  await client.sendText(`${n.replace(/\D/g, '')}@s.whatsapp.net`, 'Hello')
  await new Promise(r => setTimeout(r, 1000))
}
```

### Terms-of-Service Notices

WhatsApp gates some surfaces on the account having accepted a given legal
notice — a Terms update, a privacy-policy change, a regional disclosure. The
app pulls the acceptance state, shows what is outstanding, and posts back what
the user accepted.

```js
const out = await client.queryTosNotices(['20230324', '20240101'])

out.refresh   // 86400 — seconds the server suggests waiting before asking again
out.notices   // [ { id: '20230324', accepted: true },
              //   { id: '20240101', accepted: false } ]

// Anything still outstanding:
const pending = out.notices.filter(n => !n.accepted).map(n => n.id)
if (pending.length) await client.acceptTosNotices(pending)
```

Reading one back without asking again:

```js
client.isTosAccepted('20230324')   // true
client.isTosAccepted('20240101')   // false
client.isTosAccepted('unknown-id') // null — this session has not asked
```

`null` matters: it means *unknown*, not *not accepted*. Code deciding whether
to accept something needs to be able to tell those apart.

Clearing an acceptance, so the server asks for it again:

```js
await client.clearTosNotice('20230324')
```

An acceptance made on another device arrives on its own, inside the same
`account_sync` notification that carries device and privacy changes:

```js
client.on('tos_notices', ({ notices }) => {
  for (const n of notices) {
    console.log(n.id, n.accepted ? 'accepted' : 'outstanding')
  }
})
```

A note on the wire, because it reads backwards from how it looks: the `state`
attribute is present and `"false"` for a notice that has **not** been accepted,
and **absent** for one that has. whalibmob reads it that way. If you parse these
stanzas yourself, treating a missing attribute as "unknown" would report every
accepted notice as outstanding.

Scope, honestly: no specific feature has been shown to be blocked by an
unaccepted notice on a headless account. What this gives you is something to
check rather than guess at — if a freshly registered number will not do
something, you can now ask whether it has a notice pending.


---

[← Back to the README](../README.md) · [Documentation index](../README.md#documentation)
