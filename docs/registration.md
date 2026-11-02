# Registering & Connecting an Account

[← Back to the README](../README.md) · [Documentation index](../README.md#documentation)

---

## Library API

Everything the CLI does is available as a Node.js library. The sections below
cover connecting an account, sending and receiving every message type, groups,
communities, channels, presence, privacy, history sync, and device emulation.

> [!NOTE]
> Most snippets in these pages are fragments that use `await` at the top level.
> Put them inside an `async function`, or run them from an ES module (an `.mjs`
> file using `import`), where top-level `await` is allowed. A CommonJS file that
> mixes `require()` with top-level `await` is rejected by Node before it runs.
> The complete programs — the [Quick Start](https://github.com/Kunboruto20/whalibmob/blob/main/README.md#quick-start),
> the two registration steps below and the
> [events example](events-history.md#example-to-start) — run as they are.

### What the package exports

Two layers. The first is the flat one the rest of this document uses — the
eighty-two names the common paths are built from:

```js
const { WhalibmobClient, createNewStore, requestSmsCode } = require('whalibmob')
```

The second is everything else. The library is ninety-five modules and close to
five hundred exported names, and the flat layer picks out under a fifth of
them. The rest are reachable as **namespaces**, each one a module of `lib/`
under a name of its own:

```js
const wa = require('whalibmob')

wa.MediaService.getMediaKeyName('ptt')        // → 'WhatsApp Audio Keys'
wa.MessageProto.decodeMessageContainer(buf)   // raw bytes → a decoded message
wa.Messages.MediaRetry.mediaRetryKey(key)     // the retry-receipt key
wa.Signal.libsignal.SessionCipher             // the vendored libsignal
wa.AppState.SyncdProto                        // app-state mutation records
wa.Image.Jpeg                                 // the JPEG header reader
```

A namespace is named after the module it comes from, and a directory in `lib/`
becomes one namespace rather than several — so `Signal` is all of
`lib/signal/`, `AppState` all of `lib/appstate/`, `Messages` all of
`lib/messages/`. Two names could not be had: **`Devices`** is
`lib/DeviceManager.js`, because the flat `DeviceManager` is the class rather
than the module, and **`Proto`** is `lib/proto.js` while the message protobufs
in `lib/proto/` are **`MessageProto`**.

Deep requires work as well, and always have — the package declares no `exports`
map, so nothing is sealed off:

```js
const MediaService = require('whalibmob/lib/MediaService')
// the same object, by a longer name
require('whalibmob').MediaService === MediaService   // true
```

Adding the namespaces renamed and removed nothing: every name the library
exported before is still exported, still holding what it held.

> [!NOTE]
> The namespaces are typed as far as the rest of this document goes — media,
> the message protobufs, media retry. Past that they are `any`, which is what
> the internals have always been in `index.d.ts`. They are reachable, not
> described.

### ES modules

The package is CommonJS, and every one of its names can be imported from an ES
module — a bot written with `"type": "module"` needs no interop dance:

```js
import { WhalibmobClient, createNewStore, requestSmsCode } from 'whalibmob'
import { MediaService, MessageProto } from 'whalibmob'

// the default import is the whole export object, if you prefer it
import wa from 'whalibmob'

// deep imports work too — ESM wants the extension, CommonJS does not
import { downloadMedia } from 'whalibmob/lib/MediaService.js'
```

> [!NOTE]
> `import { … }` used to fail for all but five names. Node reads a CommonJS
> module's names statically, and the reader gives up at the first property of
> `module.exports` whose value is not a plain identifier — an inline arrow
> function five entries in cost the other 116. `require()` and the default
> import were unaffected, which is why it went unnoticed. Everything is now
> bound to a name before it is exported, and a test fails if that stops being
> true.

## Connecting Account

### Register a New Number

Registration is a one-time process. You need a phone number that can receive an SMS or voice call.

**Step 1 — request a verification code**

```js
const {
  createNewStore, saveStore, requestSmsCode, storeFileFor
} = require('whalibmob')
const os   = require('os')
const path = require('path')

const phone    = '919634847671'           // country code + number, no '+'
const sessDir  = path.join(os.homedir(), '.waSession')
const sessFile = storeFileFor(sessDir, phone)   // ~/.waSession/<phone>/<phone>.json

async function main() {
  // `name` is the display name the account registers with — what people who have
  // not saved the number see. Omit it and the account has no name until one is
  // set later with client.changeName().
  const store = createNewStore(phone, { name: 'Ricardo Trade' })
  saveStore(store, sessFile)

  await requestSmsCode(store, 'sms')   // 'sms' | 'voice' | 'wa_old'
  saveStore(store, sessFile)
}

main().catch(err => { console.error(err.message || err); process.exit(1) })
```

The name is written to the session, not sent to the registration endpoint — the
server learns it from the first connection, and from every one after. It can
also be passed as an option at either step, which is the way to name a session
that already exists:

```js
await requestSmsCode(store, 'sms', { name: 'Ricardo Trade' })
await verifyCode(store, '123456',  { name: 'Ricardo Trade' })
```

Names are trimmed, collapsed to single spaces and capped at 25 characters.

**Step 2 — verify the code**

```js
const { loadStore, saveStore, verifyCode, storeFileFor } = require('whalibmob')
const os   = require('os')
const path = require('path')

const phone   = '919634847671'
const sessDir = path.join(os.homedir(), '.waSession')

async function main() {
  const store  = loadStore(storeFileFor(sessDir, phone))
  if (!store) throw new Error('no session for +' + phone + ' — run step 1 first')
  const result = await verifyCode(store, '123456')   // updates `store` in place

  if (['ok', 'sent', 'verified'].includes(result.status)) {
    store.registered  = true
    store.codePending = false
    // Save under the number WhatsApp filed the account as — it can differ from
    // the one typed (result.canonicalPhoneNumber says so when it does).
    saveStore(store, storeFileFor(sessDir, store.phoneNumber))
    console.log('registered as +' + store.phoneNumber)
  } else {
    console.error('not registered:', result)
  }
}

main().catch(err => { console.error(err.message || err); process.exit(1) })
```

`verifyCode` returns the server's answer, not a new store: the session you
passed in is the one that is now registered, so that is the one to save.

**Optional — let the code arrive by itself.** The two steps above are the whole flow, and nothing about them changes if you do nothing else. But because a registration sends a push token (see [The Push Token](push-token.md#the-push-token)), WhatsApp *may* also deliver the six-digit code as a silent push. Open a listener for it before requesting the code, and the code can come back with nothing typed — on an Android profile over Firebase, on an iOS one over APNs:

```js
const { receivePushCode } = require('whalibmob')

// open the listener FIRST, so the push has somewhere to land
const codePromise = receivePushCode(store, store.device, { timeoutMs: 180000 })

await requestSmsCode(store, 'sms')        // any method; the push is a copy of the code
const code = await codePromise            // the six digits, or null if no push came

if (code) {
  const result = await verifyCode(store, code)
  if (result.status === 'ok') saveStore(store, storeFileFor(sessDir, store.phoneNumber))
} else {
  // no push this time — read the code the ordinary way and call verifyCode(store, code)
}
```

This is purely additive: `receivePushCode` resolves `null` on a timeout or any failure, so the plain `requestSmsCode` / `verifyCode` path always stands behind it. Whether WhatsApp sends the silent push is the server's decision — see [Receiving the code over push](push-token.md#receiving-the-code-over-push-without-typing-it) for what governs it. From the CLI the same thing is one command, `/reg push <phone>`.

**When the code is not the end of it.** The server can answer a submitted code with a CAPTCHA, or with a demand for the account's two-step verification PIN. Neither is something the library can work out on its own, so both come back to you through optional handlers:

```js
const result = await verifyCode(store, '123456', {
  // image and audio are Buffers, or null when that variant was not sent.
  // Return the answer, or null to give up.
  async solveCaptcha({ image, audio }) {
    fs.writeFileSync('captcha.png', image)
    return await askTheUser()
  },

  // The six-digit PIN set on the phone under
  // Settings → Account → Two-step verification.
  async twoFactorPin() {
    return await askTheUser()
  }
})
```

Both are optional and both keep working when omitted — you get an error naming what was asked for instead of a silent failure, with the CAPTCHA blobs attached as `err.captcha`. A wrong CAPTCHA answer is replied to with another one, so `solveCaptcha` may be called several times. The CLI prompts for both, writing the image to a temp file first.

> [!NOTE]
> Registration reports the screens it passes through to WhatsApp's `/client_log`, the way the phone clients do — a client that registers in total silence does something no real installation does. It is fire-and-forget and every failure is swallowed, so it can never take a registration down. Set `WA_FUNNEL_LOG=0` to send none of it.

> [!NOTE]
> Those events carry timestamps, and registration waits between them the way a person would: a few seconds to type the number in, a moment on the confirmation sheet, longer before asking again after a refusal. Without the waits the whole funnel leaves inside one millisecond, which no handset does. It adds a handful of seconds to a registration. Set `WA_REG_PACING=0` to remove them.

### Registering as Android

**There is nothing to do first.** Name the platform and register:

```sh
WA_OS=android WA_DEVICE=samsung-s24-ultra wa registration --request-code 919634847671 --debug
```

The first Android registration finds no token material, fetches the WhatsApp APK
from Google Play, reads what it needs out of it, checks that WhatsApp really
signed it, and carries on to the code request — one command, no APK to find:

```
no Android token material yet — fetching the WhatsApp APK from Google Play
    version 2.26.30.3 (code 263000302)
    downloading base.apk and 1 density split (of 24 the server offered): config.xxxhdpi
    token material written to /home/you/.waSession/android-apk-material.json
requesting sms code for +919634847671...
  status  sent
```

It happens once. Every later registration reads the file — from the session
directory you are using, wherever that is. `WA_NO_APK_DOWNLOAD=1` turns the
fetch off if you would rather it never pulled a hundred megabytes unasked, and
`wa apk-material` below does the same job by hand.

> [!NOTE]
> The download goes through the Aurora OSS token dispenser, a free third-party
> service that mints an anonymous Play account. It refuses with **HTTP 403**
> when it is rate limiting and **5xx** when it is having a bad minute, so the
> request is retried a few times with a growing wait before giving up.
> `WA_PLAY_RETRY_DELAY_MS` sets that wait (default `2000`, doubling each time).
> If it still refuses, nothing is wrong with your setup — pass an APK path to
> `wa apk-material` instead, which is the same thing without the middleman.

The rest of this section is what happens behind that one command, and how to
drive each part yourself.

### Registering a WhatsApp Business account

Set `WA_BUSINESS`, or pass `--business`, and the whole registration switches to
the Business build:

```sh
WA_OS=android WA_BUSINESS=1 wa registration --request-code 919634847671
wa registration --register 919634847671 --code 123456
wa connect 919634847671
```

Everything that names the app follows from that one variable:

| | consumer | Business |
|---|---|---|
| announced platform | `ANDROID` / `IOS` | `ANDROID_BUSINESS` / `IOS_BUSINESS` |
| User-Agent | `Android/…` · `iOS/…` | `SMBA/…` · `SMB iOS/…` |
| Android token material | `com.whatsapp` | `com.whatsapp.w4b` |
| iOS token constant | consumer | Business |
| version lookup | consumer listing | Business listing |
| `vname` field | not sent | a self-signed verified-name certificate |
| Frida attestation port | 1119 | 1120 |

The Android token material lives in its own file
(`android-apk-material-business.json`), so the two builds never overwrite each
other and `wa apk-material --download --business` can sit beside the consumer
one.

`vname` is a `VerifiedNameCertificate` the client signs itself, carrying an
empty name, the issuer `smb:wa` and a random serial. The name is empty because
nothing is verified yet — WhatsApp issues the real one after it reviews the
business. What the server checks is that the signature over those details was
made with the identity key the same request registers.

> [!IMPORTANT]
> **Decide before the code goes out.** An account is created as Business or as
> consumer, and the token, the User-Agent and the certificate all have to keep
> saying which. A session that is already part-way through registering keeps
> what it started as and says so rather than flipping halfway; delete the
> session file to start it over as the other one.

#### Why an APK is involved at all

The registration token is computed differently on each platform, and only iOS
derives it from a constant. The Android client signs it with material out of its
own APK:

```
key   = PBKDF2-HMAC-SHA1(password = "com.whatsapp" + about_logo.png,
                         salt = fixed, iterations = 128, length = 64)
token = urlencode(base64(HMAC-SHA1(key, signing certificates
                                      + MD5(classes.dex)
                                      + national number)))
```

None of that can be derived, so it has to be read out of a real APK once. Sending
the iOS-shaped token as Android is answered with `{"reason":"bad_token"}`, and no
value in `WA_STATIC_TOKEN` changes that — the constant is not what is wrong, the
formula is. `WA_STATIC_TOKEN` applies to iOS only.

#### Fetching the APK on its own

This runs by itself on a registration that finds no material. To do it separately
— to refresh after a WhatsApp release, or just to see what it picks up:

```sh
wa apk-material --download
```

The route is an anonymous Play Store token from the Aurora OSS dispenser, then
Google's own `/fdfe` catalogue and delivery endpoints, then the signed CDN URLs.
**No Google account of yours is involved.** Only the density
splits are downloaded — the token's key comes from `about_logo.png`, which lives
in one of those, and the architecture and language splits would be a hundred
megabytes nothing here reads.

Two caveats. The dispenser is a free third-party service: when it is down or rate
limiting, this fails and an APK from a phone still works. And downloading from
Play this way is against Play's terms of service, which is your call to make.

Play serves the splits that suit the device profile it is asked as, not the full
set a bundle holds, so the density this yields can differ from the one in a
complete bundle — and a different density is a different key. The `about_logo`
line in the output names which one was used.

#### Reading it out of an APK you already have

Pull one off any phone or emulator that has WhatsApp installed:

```sh
adb shell pm path com.whatsapp
# package:/data/app/~~xyz==/com.whatsapp-abc==/base.apk
# package:/data/app/~~xyz==/com.whatsapp-abc==/split_config.xxhdpi.apk
adb pull /data/app/~~xyz==/com.whatsapp-abc==/base.apk
adb pull /data/app/~~xyz==/com.whatsapp-abc==/split_config.xxhdpi.apk
```

Recent releases ship as an App Bundle, so `about_logo.png` often lives in a
density split rather than in `base.apk`. Pull the `split_config.*dpi.apk` files
too and pass them along — only splits whose name ends in `dpi` are searched.

**Read the material out of it:**

```sh
wa apk-material base.apk split_config.xxhdpi.apk
```

```
reading base.apk...
  package               com.whatsapp
  version               2.26.25.80  (code 260908001)
  certificates          1
  signed by             C=US, ST=California, L=Santa Clara, O=WhatsApp Inc., …
  sha256                AD:AD:64:31:29:8F:64:2B:…
  classes.dex md5       5c71f02aaad331e16e436bfa83ea3c5b
  written to            /home/you/.waSession/android-apk-material.json
```

**Watch the `signed by` line.** The token is an HMAC over the signing
certificates, so it is only the token the server expects when those certificates
are WhatsApp's own. Mirrors re-sign the APKs they host, commonly with the AOSP
test key whose private half ships in the Android sources — a re-signed APK yields
a token that is well-formed and belongs to nobody. Anything other than WhatsApp
in that subject is called out here as a warning, and registration refuses to
start on it rather than spending code requests against your number on something
that cannot succeed. `WA_ALLOW_FOREIGN_APK=1` sends it anyway.

Only the derived pieces are kept — the APK is never needed again. Registration
picks the file up on its own from then on. `--out <file>` writes it elsewhere,
and `WA_ANDROID_APK_MATERIAL` points at it if you keep it somewhere else.

**The version comes from the APK too.** It is read out of the binary
`AndroidManifest.xml` and announced from then on, instead of the version the Play
Store currently lists. The token is signed over *this* build's `classes.dex`, so
announcing any other version describes a build the token does not belong to.
`WA_VERSION` still overrides everything if you need it to; on a manifest with no
`versionName`, pass `--version <x.y.z.w>`.

**Refresh it on a new WhatsApp release.** `classes.dex` changes every release and
its MD5 is signed into the token, so material from an older build stops matching
the version being announced. `wa apk-material --download` re-reads the current
one; deleting the file and registering again does the same thing on its own.

Programmatically:

```js
const { extractMaterial, computeToken, materialToJson } = require('whalibmob/lib/AndroidApk')

const material = extractMaterial(
  fs.readFileSync('base.apk'),
  [{ name: 'split_config.xxhdpi.apk', data: fs.readFileSync('split_config.xxhdpi.apk') }]
)
fs.writeFileSync('android-apk-material.json', JSON.stringify(materialToJson(material)))
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

#### Client Options

Every option is optional; `sessionDir` is the only one most senders ever set.

| Option | Default | What it does |
|---|---|---|
| `sessionDir` | `~/.waSession` | The authentication folder. Each number gets its own subfolder inside it — see [Saving & Restoring Sessions](sessions.md#saving--restoring-sessions). |
| `autoFixNumber` | `true` | Re-file the session automatically when the server reports the account under a different number. Set `false` to be told instead of fixed — see [The Number WhatsApp Files Your Account Under](accounts.md#the-number-whatsapp-files-your-account-under). |
| `autoRead` | `true` | Send read receipts for incoming messages. `false` leaves them unread. |
| `refreshVersion` | `true` | Check the platform's store for the current build on every connect and reconnect, and write it into the session file. Both iOS and Android. Set `false` to keep announcing whatever the session registered with — see [Keeping the Announced Version Current](sessions.md#keeping-the-announced-version-current). |
| `pino` | off | Debug logging. `true` turns it on at `debug` level; an object is passed to `pino` as-is. |
| `sentCacheSize` | `2000` | How many sent messages keep their plaintext so a retry receipt naming them can be answered. |
| `maxRetryResends` | `5` | How many times one message may be re-sent in answer to retry receipts before the client gives up. |
| `tcTokenPresendTimeoutMs` | `5000` | How long the first message to a new contact waits for its trusted-contact token before going out without one — see [tcToken — Error 463 Defense](events-history.md#tctoken--error-463-defense). `0` sends immediately and lets the token arrive for the next message. |

```js
const client = new WhalibmobClient({
  sessionDir:      path.join(process.env.HOME, '.waSession'),
  sentCacheSize:   10000,
  maxRetryResends: 8
})
```

**When to raise the last two.** A recipient's device that cannot decrypt a message asks for it again, and whalibmob answers by rebuilding the Signal session and re-sending. Answering requires the original text, which is why sent messages are held: a receipt naming a message no longer in the cache cannot be answered at all, and that message — already acked by the server — silently never arrives.

The defaults cover an ordinary sender. Raise `sentCacheSize` if you push messages faster than replies come back, which is easy to do when several recipients are being worked through at once: your own replies age out of the cache while the recipient is still asking for them. The symptom is this line in the debug log:

```
[DBG] RETRY_RECV msgId=... — no cached plaintext, skipping resend
```

If you see it, the cache is smaller than your in-flight window. An entry holds the encoded message, not the media it points at, so entries are small and raising the bound costs little memory.


---

[← Back to the README](../README.md) · [Documentation index](../README.md#documentation)
