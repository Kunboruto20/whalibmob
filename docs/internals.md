# IDs, Transport, Media Encryption & Device Emulation

[← Back to the README](../README.md) · [Documentation index](../README.md#documentation)

---

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

See the [Receiving Media](messaging.md#receiving-media) section for a complete working code example.

## Device Emulation

whalibmob can emulate any iOS or Android device when communicating with WhatsApp servers.
The device profile controls the User-Agent header, the Noise Protocol `platform` field, and the static token used in registration token computation.

Configuration is done entirely through environment variables — no code changes required.
Copy `.env.example` to `.env` in your project root and set the variables you need.

### Device Quick Start

Emulate an Android Pixel 8 Pro. **The syntax for setting a variable differs per
shell**, and getting it wrong is the most common reason a device profile appears
to be ignored:

**Linux, macOS, Termux** — set them for the one command:

```sh
WA_OS=android WA_DEVICE=pixel_8_pro node your-app.js
WA_OS=android WA_DEVICE=pixel_8_pro wa registration --request-code 919634847671
```

**Windows, Command Prompt** — `set` first, one per line. `VAR=value` in front of
a command is Unix syntax and Windows answers it with
`'WA_OS' is not recognized as an internal or external command`:

```bat
set WA_OS=android
set WA_DEVICE=pixel_8_pro
wa registration --request-code 919634847671
```

Keep them on separate lines. Chaining with `&&` puts the space before the `&&`
inside the value.

**Windows, PowerShell**:

```powershell
$env:WA_OS = "android"
$env:WA_DEVICE = "pixel_8_pro"
wa registration --request-code 919634847671
```

**Anywhere, and the one worth preferring** — a `.env` file in the directory you
run from, which behaves identically on every platform:

```dotenv
WA_OS=android
WA_DEVICE=pixel_8_pro
```

```sh
wa registration --request-code 919634847671
```

The CLI reads `.env` from the **current directory**, not from where whalibmob is
installed, so `cd` to the directory holding it before running. Whichever way you
choose, the first line of `--debug` output tells you whether it took:
`User-Agent: WhatsApp/… Android/14 Device/Google-Pixel 8 Pro`. An `iOS/…` there
means the variables never arrived.

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
| `WA_DEVICE_RAM` | Usable RAM in GiB, as Android reports it (e.g. `7.53`). Each named profile carries its own; set this only for a different memory variant of the same model. |
| `WA_DEVICE_BOARD` | Android only: the board name, as the phone reports it in `Build.BOARD`, announced in the user agent. Unset by default, and then left out, as the app does when the board is empty. Set it only to the real board of the model you announce. |

### Declaring your SIM

Registration sends `sim_mcc` / `sim_mnc` to say which network the SIM belongs
to. The built-in table can only name **one operator per country** — Romania is
always Orange, Brazil always Vivo — and it cannot do better, because number
portability broke the prefix→operator link years ago. Guessing from the number
would be wrong more often than the table is.

So say which SIM is in the phone:

```js
const store = createNewStore('40712345678', { simMcc: '226', simMnc: '01' })
```

| Variable | Description |
|---|---|
| `WA_SIM_MCC` | Mobile country code of the SIM (e.g. `226`) |
| `WA_SIM_MNC` | Mobile network code. **Width matters** — `10` and `010` are different networks to the server, so write it exactly as your operator does. |

Either half can be given on its own; the other keeps the table's value, and the
country's language and locale are unaffected either way. Leave both unset and
nothing changes from before.

### Version & Token Overrides

| Variable | Description |
|---|---|
| `WA_VERSION` | Pin the WhatsApp version (e.g. `2.24.13.80`). Skips the live store fetch, and is announced on connect **in place of the version stored in the session**. The CLI also reads it from a `.env` file in the working directory, so one left there is announced by every connect from that directory — which is how a working session starts being refused with [405](#when-the-server-answers-405-on-connect). Pin it deliberately, unset it when done. |
| `WA_STATIC_TOKEN` | Override the static token used in registration token computation. iOS only — Android has no static token. Overrides both the consumer and the Business constant. |
| `WA_GP_HASH` | Android only: the `_gp` value (base64) registration sends, the hash of the app's declared permissions. Used only when no APK material supplies it (see [Device Attestation](attestation.md#device-attestation--play-integrity-and-app-attest)); otherwise a value observed from a current client is sent. Set it when a new WhatsApp version changes the permission list. |
| `WA_BUSINESS` | Register and connect as WhatsApp Business (`1`/`true`/`yes`/`on`). Decides the announced platform, the User-Agent, which APK the token material comes from, and the `vname` certificate. See [Registering a WhatsApp Business account](registration.md#registering-a-whatsapp-business-account). |

### When the server answers 405 on connect

```
WhatsApp auth failure 405 — client outdated. The server refused the version
this connect announced, which was 2.24.10.75. That value came from WA_VERSION
in the environment — the CLI also reads it out of a .env file in the directory
it runs from — while the session itself holds 2.26.29.73.
```

**The session is fine and the number is still registered.** 405 is the server
declining the *client*, not the account: the version being announced is not one
it accepts. Registering the number again is the one move that cannot help — the
same version would go out and be refused identically, at the cost of a real
phone number and a code request.

Connecting announces exactly one version, and there are only two places it can
come from:

| order | where the announced version comes from |
|---|---|
| 1 | `WA_VERSION`, from the shell **or from a `.env` file in the directory the command runs in** |
| 2 | the version stored in the session file — refreshed from the platform's store before every handshake, unless `{ refreshVersion: false }` |

Almost every 405 is the first line winning when nobody meant it to.

#### Check `WA_VERSION` before anything else

The CLI loads `.env` from the working directory before it does anything else, so
a `WA_VERSION` left in that file is announced by *every* connect started from
that directory — in place of the version the session registered with, which the
server would have accepted. Nothing about the session changes, so the failure
looks like a dead account and is not one.

```sh
grep -i wa_version .env ~/.env
env | grep WA_VERSION
```

Remove or comment the line, then connect again. Since 5.12.17 you do not have to
go looking: the CLI says so before it connects,

```
warning: WA_VERSION=2.24.10.75 is pinned (shell or .env in /home/you) —
connecting announces it instead of the version stored in the session.
```

and a 405 names the version that went out and which of the two places it came
from, because that decides the remedy — unset the override, or pin a newer one.

Pin `WA_VERSION` deliberately and temporarily, to force one specific build:

```sh
WA_VERSION=2.26.30.3 wa connect 919634847671
```

Leaving it in `.env` means every session on that machine announces it until the
day it goes stale, wherever those sessions came from.

#### Keeping the session's own version current

With no override, the session announces the version it was registered with, and
each platform learns that differently:

| | how the version is found | what happens when that fails |
|---|---|---|
| iOS | looked up on the App Store | falls back to a version compiled into the library, which goes stale |
| Android | read from the APK the registration token material came from | `wa apk-material --download` fetches the current one |

**That version is written once, at registration, and nothing else ever touches
it.** A number registered today announces today's version next year too, and one
day the server stops accepting it — a 405 with nothing wrong with the account.
Refreshing the APK material does not reach the sessions already on disk.

`wa refresh-version` is the part that does:

```sh
wa apk-material --download        # Android: pick up the current APK first
wa refresh-version 5568936182750  # then write its version into the session
```

```
+5568936182750  android       2.24.10.75  →  2.26.30.5

  1 session(s) updated
  read from the APK the token material came from.
  reconnect for it to be announced.
```

It touches `version` and nothing else — the keys, the device profile and the
registration are left exactly as they were — and it never moves a session
backwards. The store it reads from can be behind what a session already holds,
since Play serves the build matching the device profile it was asked with rather
than the newest on the listing, and announcing an older version is the one
outcome that makes a 405 more likely:

```
+40756218532  android       2.26.30.3  (kept — newer than the 2.26.29.73 available)
``` `--all` does every session in the
session directory, which is what belongs in a monthly cron for a bot that is
meant to stay up:

```sh
wa apk-material --download && wa refresh-version --all
```

`--version 2.26.30.5` writes one you name instead of looking one up. And if
`WA_VERSION` is set, the command says so — the override would mask whatever it
writes.

From Node, the same thing:

```js
const { refreshSessionVersion, currentVersionFor, storeFileFor } = require('whalibmob')

const base = path.join(process.env.HOME, '.waSession')
await refreshSessionVersion(storeFileFor(base, '5568936182750'))
await currentVersionFor({ os: 'android' })   // { version, source }
```

#### If every Android session is refused, whatever the version

Then it is the library, not the version — update it. Until 5.12.15 the Android
device profiles announced platform `3`, which is BlackBerry, a client WhatsApp
stopped building in 2017. The server validates the announced app version
*against the platform it was announced with*, so a current Android build arrived
looking like an impossible BlackBerry one, and nothing in the failure named the
platform. iOS announced `1` and was never affected.

Sessions written before the fix repair themselves the next time they are loaded
— the platform is derived from the profile's `os` rather than trusted from the
file — so nothing has to be registered again.

One other field in the same payload was wrong rather than merely unusual:
`connectType` sent `3` on every reconnect, and the enum has no `3` — the legal
values are `0` (cellular, unknown radio), `1` (wifi) and `100`–`112` for the
named cellular radios. It now sends `1`.

Nothing else in the payload changed. Other clients announce no carrier
(`mcc`/`mnc` as `000`) and `en`/`US` regardless of the number; this library
announces the carrier and locale the number actually belongs to, and a live
session was tried against the server both ways — neither is refused. `000/000`
is what a handset with no SIM reports, so a number with a carrier behind it
saying so is the more ordinary thing to be.

### Finding out what a 405 objects to

When the version is right and the connect is still refused, stop guessing:
`tools/diagnose-405.js` runs the login once per payload variation and prints
what the server answered each time.

```sh
node tools/diagnose-405.js 5568936182750

# installed globally:
node $(npm root -g)/whalibmob/tools/diagnose-405.js 5568936182750
```

```
what this library sends           ok — LOGIN ACCEPTED
  without the carrier (000/000)   ok — LOGIN ACCEPTED
  without the locale (en/US)      ok — LOGIN ACCEPTED
```

`405` means that row was refused, `401` means the client was accepted and only
the credentials failed, `ok` means the login went through. The first row is what
a real connect puts on the wire, and each row after it changes exactly one
field, so a row that behaves differently from the first names the field the
server objected to. Every row uses the session already on disk: nothing is
registered, no code is requested, and the session is never written to.
`--dry-run` prints the payload sizes without opening a socket.

**If the first row is accepted while `wa connect` is refused, the payload is not
the problem.** The difference is then in what the CLI reads and this tool does
not — `WA_VERSION`, from `.env`. Go back to the top of this section.


---

[← Back to the README](../README.md) · [Documentation index](../README.md#documentation)
