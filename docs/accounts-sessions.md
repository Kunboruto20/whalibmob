# Accounts, Push, Proxy & Sessions

[← Back to the README](../README.md) · [Documentation index](../README.md#documentation)

---

## The Number WhatsApp Files Your Account Under

WhatsApp does not always keep an account under the number you type. Brazilian mobiles are the standing example: they gained a ninth digit, and WhatsApp keeps older accounts under the eight-digit form. `5596976042705` and `559676042705` are the same account, but only the second is the one the server recognises.

This matters because the number in your session is sent as the username on every connection. Get the form wrong and the server has no registration matching it, so the login is refused with `401` — a code that says "logged out" and gives no hint that the number was the problem.

whalibmob handles this on its own, in both directions:

**When you register**, the canonical form is read from the server's reply and the session is saved under it. Numbers registered through whalibmob cannot end up in this state.

**When you connect** an older session that is in this state, the first login is refused, whalibmob asks the server which form it uses, re-files the session, and connects. You see one line:

```
connecting to +5596976042705...
  this account is registered as +559676042705 (not +5596976042705) — session updated
connected as +559676042705
```

The rename keeps the registration and the Signal keys — it moves the session files, it does not re-register anything.

```js
client.on('number_corrected', ({ from, to }) => {
  console.log('session re-filed:', from, '→', to)
})
```

To be told rather than fixed:

```js
const client = new WhalibmobClient({ sessionDir, autoFixNumber: false })
```

Then the `401` is thrown as-is, and `checkSessionAlive()` tells you what the server calls the account:

```js
const probe = await client.checkSessionAlive()
// { alive: true, status: 'ok', current: '5596976042705',
//   canonical: '559676042705', mismatch: true }

if (probe.mismatch) {
  await client.adoptCanonicalNumber(probe.canonical)
}
```

> [!NOTE]
> The check costs nothing when things work — it runs only after a login has already been refused.

## When Registration Is Refused for Consent

Some numbers come back from `/register` like this:

```json
{ "login": "557176034186", "pending": "app_store_age", "reason": "consent", "status": "fail" }
```

The code was not refused and the account was found — WhatsApp is asking for an age signal that only a real app-store install carries, and will not finish without it. Brazilian numbers are where this turns up in practice.

The first thing to try is the Android device profile. The iOS registration request carries six fields and none of them says anything about consent, terms or age; the Android one carries `tos_version`, `education_screen_displayed` and `clicked_education_link`.

```sh
WA_OS=android wa registration --code 5571976034186
```

If that is refused too, the number has to go through the real app once, on a phone, before it can be registered here.

> [!NOTE]
> The `login` field in that reply is worth reading. Brazilian mobiles gained a ninth digit that WhatsApp never adopted, so `+5571976034186` is filed as `+557176034186`. whalibmob adopts the server's form automatically on a successful registration and saves the session under it — the digit difference is not itself the failure.

## Why Registration Can Be Blocked — The Anti-Abuse Landscape

If registration works on some numbers and fails on others with the same code, the failure is almost never a bug in whalibmob. It is one of two **separate** defences WhatsApp runs, built at different times, for different reasons. Telling them apart is the whole of debugging a block, so this section explains what each one is, where it came from, and what actually moves the needle.

### Two different walls

**Wall 1 — "are you the real app?" (unofficial-client detection).**
This is the wall built against **modified WhatsApp clients** — GB WhatsApp, FM WhatsApp, YoWhatsApp, WhatsApp Plus and the rest of that family, mods that repackage the official APK to add themes, dual accounts and privacy toggles. WhatsApp fought them for years and, from around 2024, banned tens of millions of the accounts using them in a single wave. The detection that came out of that fight checks three things on every connection: the **APK signature** (is it signed by WhatsApp Inc. or by a mod author?), the **integrity attestation** (does Play Integrity / App Attest vouch that this is the genuine app on a real device?), and **behaviour**.

whalibmob is not a mod — but from the server's point of view a whalibmob request with **empty attestation** produces the same answer to those questions as a mod does: *"I can't prove I'm the official app."* WhatsApp does not read your project's name; it reads signals, and on that signal whalibmob and a mod look alike. That is why the same screens a mod triggers can appear here:

- **`"reason":"blocked"` with a `custom_block_screen`** — *"For security reasons, we can't connect you right now."* The request is refused before the code is even routed.
- **"We could not confirm you are using the official WhatsApp app,"** often with a link to download it.
- On a **linked/companion** session, **"Use the official WhatsApp Web to continue"** — the same idea, one layer over, aimed at web-class linked devices.

These tend to appear on numbers that have been **flagged before** (previously banned, or previously seen on an unofficial client). A clean number is usually given the benefit of the doubt and passes with empty attestation; a flagged number has spent that benefit and is asked to *prove* it is the official app — which empty attestation cannot.

**Wall 2 — "are you spamming?" (anti-abuse / IP reputation).**
This wall is **older than the mods** and unrelated to them. WhatsApp scores the **IP address** the request comes from, and if it belongs to a datacenter, a known VPN range or an address already on a spam list, it is refused regardless of how genuine the client looks. This is what fails **many numbers at once from the same server**: the common factor is not the numbers, it is the IP. It is also what a `no_routes` reply (with every `*_wait` at `3600`) usually means — a routing/rate refusal; cool down for an hour and slow down.

The distinction matters because the fixes are different, and because **Wall 2 would exist even if the mods never had**. Even in a world with no GB WhatsApp, WhatsApp would still stop mass account creation — that is a spam problem it has fought since before any mod existed. There is no configuration that turns a headless server into "unlimited numbers": that is precisely the outcome the anti-abuse system is designed to prevent.

### Reading the reply

| What the server sends back | Which wall | What it means |
|---|---|---|
| `"reason":"no_routes"`, every `*_wait: 3600` | Anti-abuse | Can't route the code now; usually the IP or rate. Wait out the cooldown, use a cleaner IP. |
| `"reason":"blocked"` + `custom_block_screen` | Unofficial-client / reputation | Refused for "security"; the IP and/or the number are distrusted. |
| "not using the official app" / download link | Unofficial-client | The number is flagged and is being asked to prove it is the genuine app. |
| `"reason":"consent"`, `"pending":"app_store_age"` | Consent (separate) | See [When Registration Is Refused for Consent](#when-registration-is-refused-for-consent). |

### What actually helps — and what does not

Honest, in order of effect:

- **A clean IP does the most.** A residential or mobile IP, one that is not on a blocklist, clears Wall 2 more than anything else. Datacenter/VPS IPs are the single most common cause of a `blocked` reply across many numbers. Route through a good residential/mobile proxy (see [Routing Traffic Through a Proxy](#routing-traffic-through-a-proxy)), and do not push dozens of numbers through one address.
- **Clean, unused numbers.** A number that has never been flagged passes with empty attestation. A number that already carries the "unofficial app" screen has been marked, and is usually not worth fighting — a fresh clean number is the better use of time.
- **The Android profile** (`WA_OS=android`) carries more of the fields the server wants than the iOS one, and is the first thing to try when a number is refused.
- **Real attestation** answers Wall 1 directly. The Frida scripts in [`frida/`](https://github.com/Kunboruto20/whalibmob/tree/main/frida) mint a genuine Play Integrity / App Attest token **from a real handset with the Play-Store app** and fold it in — this is the honest way to answer "prove you're the official app," because it *is* a real device proving it. It needs a rooted Android or jailbroken iOS phone (see [Device Attestation with Frida](registration.md#device-attestation-with-frida-optional)), so it is not always practical; clean numbers do not need it, and no software-only trick substitutes for it.

### The honest bottom line

This is a moving target, not a solved problem. WhatsApp changes these checks continually — the mods went from surviving *months* to surviving *hours* under the same pressure — and whalibmob is kept in step release by release, but nothing here is permanent and there is no magic bypass. Registration on the mobile protocol is a real capability that works, most reliably on **clean numbers from clean IPs**; the further you get from that, the harder the anti-abuse system pushes back, by design.

## The Push Token

Every WhatsApp on a real phone holds a push token. It is the address the push network uses to wake the app, and no install exists without one — so a registration that ships no `push_token` describes a WhatsApp that cannot be notified, which is a device that does not exist.

**Which token you get follows from the profile.** Which push network an install uses follows from its platform: Android holds a *Firebase* token and keeps a stream open to Google, iOS holds an *APNs* token and keeps one open to Apple. They are not interchangeable, and the registration server sees both the token and the User-Agent naming the platform that sent it — an iPhone presenting a Firebase token describes a device nobody ships. Both sides are implemented, and the right one is chosen from `WA_OS` without you asking for it. A profile that is neither sends no `push_token` at all, which is the correct thing for a client with no push line.

The token does two distinct jobs, and it is easy to conflate them:

1. **It makes the registration look real — always.** Every `/code` request now carries the token, whichever delivery method you ask for. The server sees an install that can be reached, not a headless client. This is the reason the token matters, and it applies to `sms`, `voice`, `wa_old` — all of them.
2. **It can carry the code itself — sometimes.** Because you handed WhatsApp a direct line, WhatsApp *may* also push the six-digit code silently down it, so the app fills the code in on its own. This is why the code auto-completes on a real phone before you have read the SMS. It happens *alongside* the method you chose, not instead of it.

The delivery method and the push are not alternatives. You still choose how a human receives the code (`sms`, `voice`, `wa_old`); the push, when it comes, is a second silent copy of that same code sent straight to the app.

```
request a code ─┬─ method you chose  →  reaches a human   (SMS, a call, the existing WhatsApp)
                └─ push_token line   →  reaches the app    (silent, auto-filled — if WhatsApp sends it)
```

### On Android: Firebase

Registration fetches a real token and sends it, in three plain HTTPS calls to Google:

| Step | Endpoint | Yields |
|---|---|---|
| 1 | `android.clients.google.com/checkin` | an android id and security token — the device's identity with Google |
| 2 | `firebaseinstallations.googleapis.com` | a Firebase installation for WhatsApp's project |
| 3 | `android.clients.google.com/c2dm/register3` | the FCM token itself |

No root, no Frida, no phone. This is unrelated to Play Integrity attestation — the two travel in the same request but come from different places, and one works without the other.

It runs once per number. The Firebase identity is cached on the session, because Google issues an android id once and expects it back; fetching a new one per registration step would mint a fresh phantom device each time.

Turn it off with `WA_FCM_PUSH=0`.

### On iOS: APNs

Apple's flow is not Google's, but it lands in the same place:

| Step | Endpoint | Yields |
|---|---|---|
| 1 | `albert.apple.com` | a device certificate Apple signs for a keypair generated here — the activation every Apple device runs on first boot |
| 2 | `init-p01st.push.apple.com/bag` | which courier hosts to dial |
| 3 | `<n>-courier.push.apple.com:443` | the device token, then `GET_TOKEN` for `net.whatsapp.WhatsApp` — the per-topic token that *is* `push_token` |

Step 1 runs once per number and its result is cached on the session: the certificate Apple issues is good for a year, and the identity behind it is what makes the same push token come back on the next run. A token WhatsApp has already recorded stops being deliverable if that identity is thrown away, which is the same reason the Firebase android id is kept.

The courier connection is a TLS stream that offers ALPN `apns-security-v3` — the device proves itself with a signature over a fresh nonce in the first frame rather than with a TLS client certificate. Apple accepts the offer without echoing it back, so a missing echo is normal and is not treated as a failure. A network that terminates TLS in the middle cannot carry the stream; what gives it away is the certificate, since a middlebox has to present one its own CA signed rather than Apple's. The failure names that issuer, instead of looking like a dropped connection.

Turn it off with `WA_APNS_PUSH=0`.

**Failure is silent by design, on both platforms.** A blocked network, a refusal from Google or Apple, a malformed answer — all end with the field omitted and registration proceeding exactly as it did before push tokens were wired up. A push token helps; it is never a prerequisite.

### Receiving the code over push, without typing it

This is the receiving end of job 2 above. When WhatsApp sends the code as a silent push, something has to be listening on the push line to catch it — the same long-lived connection every phone keeps open to its push network. `receivePushCode(store, device)` opens the one that matches the profile:

| Profile | Connection | Where the code is |
|---|---|---|
| `WA_OS=android` | `mtalk.google.com:5228`, the MCS protocol, logged in with the Firebase identity | an `appData` entry keyed `registration_code` |
| `WA_OS=ios` | `<n>-courier.push.apple.com:443`, the APNs courier, authenticated with the activation certificate | the `regcode` field of the notification's JSON payload |

Either way the call resolves with the code the moment a push carrying it arrives. A profile that is neither resolves `null` immediately rather than holding a listener open on a line no push can reach, and `/reg push` says so and stops instead of waiting out its timeout. Check with `supportsPush(store.device)` if you want to branch on it.

The order matters. Open the listener **first**, so the line is live before the code is requested; then request the code by whatever method; then await it.

```js
const { receivePushCode, requestSmsCode, verifyCode } = require('whalibmob')

// 1. open the listener first, so the push has somewhere to land
const codePromise = receivePushCode(store, store.device, { timeoutMs: 180000 })

// 2. request the code — any method. The push, if it comes, is a copy of it.
await requestSmsCode(store, 'sms')          // or 'voice', 'wa_old', …

// 3. if the push arrives, the code is here with nothing typed
const code = await codePromise
if (code) await verifyCode(store, code)
else      { /* no push — read the code from SMS / the existing WhatsApp, then verifyCode */ }
```

From the CLI the whole sequence is one command:

```
/reg push <phone> [sms|voice]
```

It opens the listener, waits until it is logged in, requests the code, and confirms automatically if the push arrives — falling back to `/reg confirm <phone> <code>` when it does not.

Either connection carries a heartbeat and acknowledges what it has read, so a reconnect does not re-read a delivered code, the way the native client does. It resolves `null` on timeout, a refused login, or any failure — at which point you simply read the code the ordinary way and verify it. Like the token, it routes through the configured SOCKS proxy.

> [!IMPORTANT]
> Receiving the push is not the same as making WhatsApp send it. Whether WhatsApp pushes the code for a given request is the server's decision, and on a client shipping empty attestation it will often send the code only by the method you asked for (SMS, `wa_old`, a call) and no silent push. This listener catches the push correctly **when one is sent**; it cannot force that channel, and it never replaces the chosen method — it runs beside it. With a valid Play Integrity attestation in the request (`WA_FRIDA_HOST`), the server is more likely to include the silent push.

## Routing Traffic Through a Proxy

Two reasons to want this. Registration is the part of the protocol most likely to be refused from a datacenter IP, so a residential exit helps with security blocks and undeterminable number statuses. And on a network that cannot reach WhatsApp at all, nothing works without one.

Install the optional dependency and set one environment variable:

```sh
npm install socks
```

```sh
# Tor
export TOR_PROXY=socks5://127.0.0.1:9050

# a residential proxy that needs credentials
export SOCKS_PROXY=socks5://user:pass@proxy.example.com:1080
```

A bare `host:port` is assumed to be SOCKS5, so `TOR_PROXY=127.0.0.1:9050` works too. `socks5`, `socks5h`, `socks4` and `socks4a` are all accepted, and `TOR_PROXY` wins if both variables are set.

If the password contains an `@` or a `:`, percent-encode it — `p@ss:word` becomes `p%40ss%3Aword`. whalibmob decodes it before handing it to the proxy.

```js
// or from code, before you call any registration function
process.env.SOCKS_PROXY = 'socks5://user:pass@proxy.example.com:1080'

await requestSmsCode(phone, store)
```

### What goes through it

Everything the library sends out:

| Connection | Destination |
|---|---|
| Message socket, mobile | raw TCP to WhatsApp |
| Message socket, web | `wss://web.whatsapp.com/ws/chat` |
| Registration | `v.whatsapp.net` |
| Announced version, iOS | App Store lookup |
| Announced version, Android | Play Store listing |
| Announced version, web | `web.whatsapp.com/sw.js` |
| APK material for registration | Play Store download |
| Media upload | WhatsApp's media hosts |

Node's `http`/`https` modules ignore proxy environment variables entirely — a proxy has to be handed in as an agent, per call site. Only the registration POST used to do that, which produced a confusing failure: `curl -x socks5://…` reached WhatsApp while the library timed out on the same machine, falling back to a pinned version with only a debug line to show for it:

```
[DBG] WEB_VERSION 2.3000.1035194821 (pinned fallback: sw.js fetch timed out)
```

All eight paths now share one agent.

If `socks` is not installed, or a proxy is unreachable, you get a message saying so rather than a silent failure. A proxy URL that cannot be parsed leaves the connection direct rather than throwing — a version lookup with a pinned fallback should not take a process down over its proxy. In the rare case the package lives somewhere `require()` cannot find it, `WA_SOCKS_LIB` takes an absolute path to it.

## Saving & Restoring Sessions

Sessions are persisted to disk under the `sessionDir` you provide — the
authentication folder. Pass any path you like; nothing is hardcoded.

```js
const client = new WhalibmobClient({
  sessionDir: path.join(process.env.HOME, 'whalibmob_auth')
})

// no need to register again — just connect
await client.init('919634847671')
```

**Each number gets a folder of its own inside it**, holding every file that
number owns:

```
whalibmob_auth/
├── android-apk-material.json            ← shared by every Android registration
├── android-apk-material-business.json
├── 919634847671/
│   ├── 919634847671.json                ← the store: keys, device, version
│   ├── 919634847671.signal.json         ← Signal sessions, signed pre-key, identities
│   ├── 919634847671.pre-key-1.json      ← one-time pre-keys, one file each
│   ├── 919634847671.pre-key-2.json
│   ├── …                                  812 of them
│   ├── 919634847671.pre-key-812.json
│   ├── 919634847671.sk.json             ← sender keys
│   ├── 919634847671.tctoken.json
│   ├── 919634847671.device-cache.json
│   ├── 919634847671.lid-mapping.json
│   ├── 919634847671.lid-reverse-mapping.json
│   ├── 919634847671.appState.json
│   ├── 919634847671.appStateKeys.json
│   ├── 919634847671.history.json
│   └── 919634847671.messages.json
└── 5568936182750/
    └── …
```

A companion link for the same number lives beside it as `<phone>.web.json` and
friends, in the same folder.

One account is then one directory: copy it to move a number to another machine,
delete it to be rid of one, archive it to keep it. Nothing has to be picked out
of a pile by prefix.

> [!NOTE]
> **Sessions written by earlier versions keep working where they are.** The
> layout is decided per number: a number whose files sit loose in the base
> directory is left exactly as it is, and only new numbers get a folder. Nothing
> is moved unless you ask — `wa migrate-sessions` does that, one number or all
> of them, and re-running it is safe.

### Keeping the Announced Version Current

Every connection announces the WhatsApp build it claims to be. The server checks
it, and when it stops recognising the number it refuses the handshake with
`405` — a failure that says nothing about the version and has nothing to do with
the account.

A session records the version it registered with. Left alone it announces that
same number forever, so a number registered in spring is still claiming a spring
build in autumn, and one day the connect simply stops working.

**Sessions refresh themselves, on both platforms.** Before every handshake the
client asks the platform's store what the current build is and writes it into
`<phone>.json`. iOS reads the App Store listing, Android the Play Store one.
Nothing to run, nothing to remember:

```js
client.on('version_update', ({ from, to, source }) => {
  console.log('announcing', to, 'instead of', from, '—', source)
})

await client.init('919634847671')
```

**Reconnects are covered too.** The check runs from the socket-connect step
rather than from `init()`, so the library's own reconnect loop passes through it
as well. A bot that stays up for weeks does not go on announcing whatever the
listing said the morning it started. The handshake reads the version out of the
store at the moment it runs, so a version written here is the one that goes out.

Four rules keep this from being the thing that breaks a working session:

- **It never goes backwards.** Both lookups answer with a pinned fallback rather
  than failing when they cannot reach the network, and that fallback can easily
  be older than what the session holds. Moving a session to an older version is
  the one outcome that makes a `405` *more* likely.
- **`WA_VERSION` still wins.** A version pinned on the way out of a `405` is a
  decision, and is never quietly replaced.
- **A failed lookup changes nothing.** The session keeps the version it has and
  the connect carries on.
- **The network is not asked twice for the same answer.** Each lookup is
  memoised for six hours, so a connection that flaps every few seconds reaches
  the store once rather than once per attempt — and a session up for a month
  still picks up a release the day it lands.

Set `{ refreshVersion: false }` on the client to turn it off.

> [!NOTE]
> **Registration still reads the APK.** A number being registered announces the
> `versionName` of the APK its token material came from, because the Android
> registration token is signed over that build. Only the *announced* version on
> an already-registered session follows the Play Store listing — no token
> travels in the handshake, so there is nothing there for it to fall out of step
> with. When the listing moves past the cached material the client emits
> `apk_material_stale`, which is the cue to run `wa apk-material --download`
> before registering the next number.

The manual tool still works on both platforms:

```bash
wa refresh-version 919634847671                    # current build for the platform
wa refresh-version 919634847671 --version 2.25.1.2 # or one you name
```

Companion sessions have never had this problem: `connectWeb()` reads the live
web revision on every connect already.

### One-time Pre-keys

A pre-key is a one-shot Diffie-Hellman key the account leaves with the server so
somebody who wants to message it can open a Signal session without it being
online. Each one is handed out once and then gone. Run out and nobody can start
a conversation with the number at all — the messages are not delayed, they are
never sent, and nothing anywhere reports it.

whalibmob keeps a pool of **812**, generated the moment a session is created and
written one key per file, in whatever authentication folder you gave it:

```
~/.waSession/919634847671/
├── 919634847671.pre-key-1.json
├── 919634847671.pre-key-2.json
└── … 919634847671.pre-key-812.json
```

A companion link for the same number keeps its own pool beside it as
`919634847671.web.pre-key-<id>.json`. The two are never shared: they are
separate devices with separate identity keys, and a key offered under the wrong
one cannot be answered.

The file is the same shape the reference client writes — the raw 32-byte public
key and the private key, both BufferJSON:

```json
{"private":{"type":"Buffer","data":"…"},"public":{"type":"Buffer","data":"…"}}
```

**Keeping the server stocked.** Three things drive it, and all of them ask the
server what it is actually holding rather than guessing from the local pool —
the two drift apart, because the server spends a key on every bundle it hands
out and none of that reaches this side.

| When | What it does |
|---|---|
| on login | asks the server for its count; **0** there means a full 812 goes up, anything low means a top-up of 5 |
| when the server says it is running low | same check, same batch |
| every 30 minutes | same check — for the session that stays up long enough to be drained without a word |

A batch is the next ids the server has not been sent, never the whole pool
again, and only counts as sent once the server has acknowledged it — a rejected
upload is retried four times with backoff and then left for the next check, with
the same keys still queued. Ids are never reused, even after the key under one
has been spent.

After the login upload the account also asks for the server's **key bundle
digest** and compares the identity key and signed pre-key it is being served
against the ones this session holds. A mismatch there is the failure that used
to need the number registering again to clear.

None of this needs calling: `init()` and `connectWeb()` both do it, identically.

> [!NOTE]
> **Sessions written before 5.14.19 keep every key they had.** Pre-keys used to
> live inside `<phone>.signal.json`; on the first start they are moved out into
> files of their own and the aggregate copy is dropped. The keys themselves do
> not change, so the bundles the server has already handed out stay answerable.

### Where the folder comes from

| order | source |
|---|---|
| 1 | `sessionDir` passed to `WhalibmobClient` (library), or `--session <dir>` (CLI) |
| 2 | `WA_SESSION_DIR` in the environment |
| 3 | the answer remembered in `~/.whalibmob.json`, which the CLI asks for once on a first run |
| 4 | `~/.waSession` |

The CLI asks only when none of the above has decided it and the default folder
is empty, so an existing installation is never asked to rename anything, and a
non-interactive run — a script, a cron — never blocks on the question.

```
  where should sessions be kept? each number gets its own folder inside.
  a bare name goes under your home directory; enter for /home/you/.waSession
  authentication folder:  whalibmob_auth
  sessions will be kept in /home/you/whalibmob_auth
```

A bare name is created under your home directory; an absolute path or one
starting with `~` is taken as given.

### Working out the paths yourself

`lib/SessionPaths` is the same resolver the library and the CLI use, so a
caller that wants to read or move a session's files does not have to guess the
layout:

```js
// exported from the package itself, or from lib/SessionPaths directly
const {
  defaultBaseDir, sessionDirFor, storeFileFor, webStoreFileFor,
  listSessions, migrateSession, SessionPaths
} = require('whalibmob')

const { isLegacyLayout, SESSION_SUFFIXES } = SessionPaths

const base = path.join(process.env.HOME, 'whalibmob_auth')

sessionDirFor(base, '919634847671')                  // …/whalibmob_auth/919634847671
sessionDirFor(base, '919634847671', { create: true }) // and makes it
storeFileFor(base, '919634847671')                   // …/919634847671/919634847671.json
webStoreFileFor(base, '919634847671')                // …/919634847671/919634847671.web.json

listSessions(base)
// [ { phone, dir, storeFile, webStoreFile, legacy, hasMobile, hasWeb }, … ]
//   covers both layouts, so it is what to iterate over

migrateSession(base, '919634847671')
// { phone, from, to, moved: [...], skipped: [...] }   moves one number into its folder
```

`SESSION_SUFFIXES` is every per-number file the library writes — the list to
copy or delete against if you are moving an account by hand.

### Where a Session Is Kept

Everything above describes files, because files are what whalibmob writes and
what it will go on writing unless you say otherwise. **Nothing in this section
is something you have to do.** Leave it alone and sessions stay exactly where
they have always been, in the JSON files named above.

What is new is that the place is now a choice. A **backend** is four
synchronous operations over a flat key space:

```js
read(key)          // the stored text, or null when the key was never written
write(key, value)  // put it there, replacing whatever was there before
remove(key)        // take it away; a key that is not there is not an error
list(prefix)       // every key present that starts with prefix
```

The keys are logical names rather than file names — `auth`, `signal`,
`sender-key`, `tc-token`, `device-cache`, `lid-mapping`,
`lid-reverse-mapping`, `history`, `messages`, `app-state`, `app-state-keys`,
and `` `pre-key/${id}` `` for each of the 812 one-time pre-keys.

Three implementations ship with the package:

| Backend | Where the state goes | Needs |
|---|---|---|
| `FileBackend` | JSON files — what the library has always written | nothing; this is the default |
| `SqliteBackend` | one database file | Node 22.5+, or `better-sqlite3` |
| `MemoryBackend` | nowhere; gone when the process ends | nothing |

```js
const { FileBackend } = require('whalibmob')

const backend = new FileBackend({
  dir:   '/home/you/.waSession/919634847671',
  phone: '919634847671'
})

backend.write('auth', JSON.stringify(creds))
backend.read('auth')          // the text, or null
backend.list()                // ['auth', 'pre-key/1', 'signal', …]
backend.list('pre-key/')      // just the pre-keys
backend.remove('pre-key/42')
backend.fileFor('signal')     // …/919634847671.signal.json
```

`FileBackend` writes the same names in the same places as every release before
it, so a session written by whalibmob 5.30 opens through it untouched and one
written through it opens in 5.30. The only change is that writes now go to a
temporary file and are renamed into place, so a process that dies mid-write
leaves the previous state intact instead of half a file.

> [!IMPORTANT]
> **A number has two halves, and they are separate sessions.** The one
> registered over the Mobile API and the companion linked over the Web API
> never share state — in particular they have separate pre-key id spaces, and
> mixing them hands out two different keys under one id and breaks decryption.
> A backend covers **one** half, chosen by `web`:
>
> ```js
> const mobile = new FileBackend({ dir, phone, web: false })  // default
> const web    = new FileBackend({ dir, phone, web: true })
> ```
>
> Both take the same keys and keep entirely separate values.

> [!NOTE]
> **The client does not accept a backend yet.** `new WhalibmobClient({ … })`
> takes `sessionDir` and writes files, as it always has; the modules that hold
> session state still do their own file I/O. The backends are usable on their
> own — for reading, inspecting, copying or moving a session — and wiring them
> through the client is the next step. Nothing here changes how a session is
> created or connected today.

### One Database Instead of 834 Files

A number's state is 22 named files plus a file for each of its 812 one-time
pre-keys. On a laptop nobody notices. On a phone under Termux, on a container
with a small inode budget, or with fifty numbers in one folder, it is 40 000
files whose directory has to be read every time the pre-key pool is counted.

`SqliteBackend` is the same state as a handful of rows:

```js
const { SqliteBackend } = require('whalibmob')

const db = new SqliteBackend({
  path:  '/home/you/.waSession/sessions.sqlite',
  phone: '919634847671'
})

db.write('auth', JSON.stringify(creds))
db.read('auth')
db.list('pre-key/')
db.driver          // 'node:sqlite' or 'better-sqlite3'
db.close()         // let go of the file
```

**What it needs.** Node ships SQLite of its own from **22.5.0** as
`node:sqlite`, and that is what this uses when it is there — nothing to
install, nothing for node-gyp to fail at, and Termux stays a place whalibmob
runs. On older Node it falls back to `better-sqlite3` if that is installed:

```sh
npm install better-sqlite3      # only on Node older than 22.5
```

Neither is a dependency of this package. On a runtime with neither, the
constructor throws and says which of the two to reach for — and `FileBackend`
goes on needing nothing at all.

One file holds as many numbers and halves as you like, while each backend sees
only its own slice:

```js
const mobile = new SqliteBackend({ path: file, phone: '919634847671' })
const web    = new SqliteBackend({ path: file, phone: '919634847671', web: true })
const other  = new SqliteBackend({ path: file, phone: '40712345678' })

SqliteBackend.sessionsIn(file)
// [ { phone: '40712345678',  half: 'mobile', web: false },
//   { phone: '919634847671', half: 'mobile', web: false },
//   { phone: '919634847671', half: 'web',    web: true  } ]
```

The file handle is shared between the backends opened on it and closed once
the last of them calls `close()`, so closing one does not pull the file out
from under the others. Calling `close()` twice is harmless.

The database runs in WAL mode, so a client flushing its Signal store and
another reading the pre-key pool do not block each other. Values are stored as
blobs rather than text: a credential blob carrying a NUL byte is truncated by
a text binding and the session then loads with keys that are wrong from that
byte on, which is the worst way for a bug to present.

### Moving a Session Between Backends

Nothing is removed and the source is never modified, so if the result is not
what you wanted the old files are still there to go back to:

```js
const { FileBackend, SqliteBackend, copySession, compareSessions } = require('whalibmob')

const files = new FileBackend({ dir: '/home/you/.waSession/919634847671',
                                phone: '919634847671' })
const db    = new SqliteBackend({ path: '/home/you/.waSession/sessions.sqlite',
                                  phone: '919634847671' })

const moved = copySession(files, db)
// { copied: ['auth', 'pre-key/1', …], skipped: [], bytes: 1284 }

const check = compareSessions(files, db)
// { ok: true, missing: [], differing: [], extra: [] }

db.close()
```

`compareSessions` reads both sides back rather than trusting that the copy
said so — run it before deleting anything. A key the destination already holds
is left alone, so an interrupted copy is safe to run again; pass
`{ overwrite: true }` when you do mean to replace what is there.

Do both halves of a number separately — `web: false` and `web: true` are two
sessions and a copy of one is not a copy of the other.

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

Wraps a `SignalStore` with an in-memory cache (5-minute TTL). Reads for sessions, pre-keys, signed pre-keys and identity keys are served from cache on subsequent accesses; `store*` calls write through to both, and `remove*` / `delete*` calls drop the entry.

A lookup that finds nothing is **not** cached. Absence is the state most likely to change from underneath — a session about to be built, a pre-key about to be uploaded — so a remembered miss is the one that would hurt.

`useClones` is set to `false` so that `SessionRecord` objects — which carry internal state and methods — are returned by reference and never deep-cloned.

Every method the underlying store has is forwarded, including `transaction()` and `isInTransaction()` when present, so the wrapper is a drop-in replacement and safe to stack with `addTransactionCapability`.

```js
const { SignalStore, makeCacheableSignalKeyStore } = require('whalibmob')

const store  = new SignalStore()
const cached = makeCacheableSignalKeyStore(store)

// reads hit cache after first access
const session = await cached.loadSession('919634847671.0')
```

Call `await cached.flushCache()` to drop everything — after a key rotation, or when another process may have written to the same session file.

**When to use:** whenever your `SignalStore` is backed by a remote or disk-based store (database, Redis, file system) and you want to reduce repeated lookups for sessions that haven't changed between sends.

### `addTransactionCapability`

Wraps a `SignalStore` with batched-write (transaction) semantics. During a transaction all writes are buffered in memory and flushed to the underlying store in one shot when the callback returns — there is no `commit()` to call. Reads check the buffer first, so a transaction sees its own writes. If the callback throws, nothing is written at all and the error reaches the caller.

Uses `AsyncLocalStorage` to propagate transaction context across async call chains, and a `Mutex` with reference-counting per transaction key.

```js
const { SignalStore, addTransactionCapability, makeCacheableSignalKeyStore } = require('whalibmob')

// recommended: cache first, then transactions on top
const base     = new SignalStore()
const cached   = makeCacheableSignalKeyStore(base)
const txnStore = addTransactionCapability(cached)

// inside a send flow
await txnStore.transaction(async () => {
  // all writes are buffered until this callback returns
  await txnStore.storeSession('919634847671.0', sessionRecord)
  await txnStore.storePreKey(1, preKeyPair)
}, 'send')
```

The second argument is a scope: two transactions with different keys run concurrently, two with the same key run one after the other. It defaults to `'default'`. Any key is safe — the transaction locks are kept separate from the locks reads take, so no choice of key can make a transaction wait on itself.

Nested `transaction()` calls reuse the enclosing context instead of opening a second one, so an inner transaction does not commit on its own.

Stacking order matters: put `makeCacheableSignalKeyStore` below `addTransactionCapability`, so that a transaction which rolls back never reaches the cache. The other order works too — a failed transaction flushes the cache rather than leave it holding writes the store never took — but it throws away good entries to do it.

**When to use:** for high-throughput servers that send to many recipients concurrently and need to batch Signal key writes into a single atomic flush per message.

### `assertMeId`

Returns the account's JID, or throws an `Error` describing what is missing.

Works with both kinds of store — the SMS store from `initAuthCreds` / `createNewStore`, and the companion store from `createNewWebStore`. Only the wording of the error differs, since the way out of "not registered yet" is SMS verification in one case and pairing in the other.

Once registered, the JID the server assigned is preferred (`store.me.id`) — on a companion it carries the device suffix, and rebuilding it from the phone number drops that silently. Before registration it throws, including during the pairing window: requesting a pairing code writes a placeholder `me` with no suffix, and that is not treated as being linked.

```js
const { assertMeId } = require('whalibmob')

const store = loadStore(sessFile)

try {
  const jid = assertMeId(store)
  // '919634847671:12@s.whatsapp.net' once connected,
  // '919634847671@s.whatsapp.net' before that
  console.log('account JID:', jid)
} catch (err) {
  console.error('store is not registered:', err.message)
}
```

**When to use:** as a guard before calling `client.init()` to give a clear error message when a corrupted or unregistered session file is accidentally loaded.

### `initAuthCreds`

Creates a fresh credential store for the given phone number — the key pairs, registration ID and device identifiers a number needs before it can even ask for an SMS code. This is what `/reg code` calls.

It returns everything `createNewStore` does, plus a few fields kept for application code that expects them: `nextPreKeyId`, `firstUnuploadedPreKeyId`, `accountSyncCounter`, `accountSettings`, `processedHistoryMessages` and `advSecretKey`. Those extras live on the object only — `saveStore` does not write them, so they are not there again after a reload. Nothing in the library reads them; treat them as a convenience, not as state.

> [!NOTE]
> The two pre-key counters the library actually runs on are the ones in the
> `SignalStore` — `nextPreKeyId()` and `firstUnuploadedPreKeyId()`, persisted in
> `<phone>.signal.json`. They live there rather than in the store because a
> number's mobile half and its companion half have a `SignalStore` each and must
> never share a pre-key id space. The fields above are the same names on a
> different object and do not drive anything.

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

This is the function the CLI uses for every new SMS session. Prefer it over `createNewStore` for forward compatibility.

> [!NOTE]
> `initAuthCreds` and `createNewStore` produce equivalent stores for every current library operation, and identical files on disk. Use `createNewWebStore` instead when the device will be linked as a companion rather than registered by SMS — that one adds the pairing fields, and its own serialiser persists them.

The file it writes has exactly these 16 keys:

```json
{
  "phoneNumber": "40712345678",
  "noiseKeyPair":    { "private": "…", "public": "…" },
  "identityKeyPair": { "private": "…", "public": "…" },
  "signedPreKey":    { "id": 3649616, "private": "…", "public": "…", "signature": "…" },
  "registrationId": 2183,
  "fdid": "2f701f8b-d693-4728-…",
  "deviceId": "CBIyyJRAokOdYoTYEjTbng==",
  "identityId": "SE8Q785oful7dGdBgNpwjg==",
  "advertisingId": "5c97eea9-783f-4fcc-…",
  "backupToken": "…",
  "registered": true,
  "codePending": false,
  "name": "Boss",
  "version": "2.26.9.75",
  "device": { "os": "ios", "platform": 1, "model": "iPhone 15 Pro", "…": "…" },
  "advIdentity": "…"
}
```

`registered` and `codePending` are the two that move: both `false` when the store is created, `codePending` flips to `true` once a code has been requested, and `verifyCode` sets `registered` to `true` and `codePending` back to `false`. `advIdentity` stays `null` until the server sends the signed device identity in `<success>`.

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
const signalStore = new SignalStore()
signalStore.attachFile(sessFile)
const cachedStore = makeCacheableSignalKeyStore(signalStore)
const txnStore    = addTransactionCapability(cachedStore)

// 3. pass to the client (advanced usage — most users should use WhalibmobClient directly)
```

For standard usage, `WhalibmobClient` handles all of this internally. These helpers are for advanced scenarios where you need direct control over Signal key storage.


---

[← Back to the README](../README.md) · [Documentation index](../README.md#documentation)
