<div align="center">

# whalibmob

**A Node.js library for WhatsApp that can register a phone number of its own.**

Every other JavaScript library links to an account that already exists on someone's phone.
whalibmob does that too — but it can also take a bare phone number, request the SMS or voice
code, and bring the account into being. Both transports, one API.

[![npm](https://img.shields.io/npm/v/whalibmob?style=for-the-badge&color=25D366&label=npm)](https://www.npmjs.com/package/whalibmob)
[![node](https://img.shields.io/node/v/whalibmob?style=for-the-badge&color=339933&label=node)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/whalibmob?style=for-the-badge&color=555555)](LICENSE)
[![types](https://img.shields.io/badge/types-included-3178C6?style=for-the-badge)](index.d.ts)

[![Leia em Português do Brasil](https://img.shields.io/badge/%F0%9F%87%A7%F0%9F%87%B7_Leia_em_Português-Brasil-009C3B?style=for-the-badge)](https://github.com/Kunboruto20/whalibmob/blob/main/Brasil.md)

**🇧🇷 Fala português?** A documentação completa está traduzida em **[Brasil.md](https://github.com/Kunboruto20/whalibmob/blob/main/Brasil.md)** — tudo o que está aqui, na sua língua.

### Start here

[![Register a number](https://img.shields.io/badge/Register_a_number-SMS,_voice_or_email-25D366?style=for-the-badge)](https://github.com/Kunboruto20/whalibmob/blob/main/docs/registration.md#register-a-new-number)
[![Link an account](https://img.shields.io/badge/Link_an_account-QR,_pairing_code_or_passkey-128C7E?style=for-the-badge)](https://github.com/Kunboruto20/whalibmob/blob/main/docs/linking.md#linking-to-an-existing-account-pairing-code-or-qr)
[![Use the CLI](https://img.shields.io/badge/Use_the_CLI-no_code_needed-075E54?style=for-the-badge)](https://github.com/Kunboruto20/whalibmob/blob/main/docs/cli-getting-started.md#cli--getting-started)

[![Library API](https://img.shields.io/badge/Library_API-Node.js-34B7F1?style=for-the-badge)](https://github.com/Kunboruto20/whalibmob/blob/main/docs/registration.md#library-api)
[![Send messages](https://img.shields.io/badge/Send_messages-text_media_polls-34B7F1?style=for-the-badge)](https://github.com/Kunboruto20/whalibmob/blob/main/docs/messaging.md#sending-messages)
[![Handle events](https://img.shields.io/badge/Handle_events-incoming_%26_receipts-34B7F1?style=for-the-badge)](https://github.com/Kunboruto20/whalibmob/blob/main/docs/events-history.md#handling-events)

[![Device attestation](https://img.shields.io/badge/Device_attestation-Play_Integrity_%2B_App_Attest-8E44AD?style=for-the-badge)](https://github.com/Kunboruto20/whalibmob/blob/main/docs/attestation.md#device-attestation--play-integrity-and-app-attest)

[![Why registration can be blocked](https://img.shields.io/badge/Why_registration_can_be_blocked-anti--abuse_%26_unofficial--client_checks-C0392B?style=for-the-badge)](https://github.com/Kunboruto20/whalibmob/blob/main/docs/accounts.md#why-registration-can-be-blocked--the-anti-abuse-landscape)

</div>

> [!TIP]
> **Registration not working on some numbers? Here is the 100% success route.**
>
> On a few numbers the **SMS** or **voice** code simply never arrives. That is WhatsApp's anti-abuse / attestation refusing an unofficial client — **not a bug in whalibmob**. When that happens, you can still register **any** number, first try:
>
> 1. **Register the number once in the official WhatsApp app** (a phone or an emulator). The official app passes attestation natively, so the number becomes a clean, already-attested account.
> 2. **Then run whalibmob with `--method wa_old`.** The code is delivered through that existing WhatsApp account, whalibmob confirms it and takes the number over on the first attempt. This works on any number.
>
> ```bash
> wa registration --request-code <number> --method wa_old
> wa registration --register   <number> --code <code>
> ```
> 
> **This is optional.** Most numbers register fine with `--method sms` or `--method voice` — try those first. Use the `wa_old` route **only if** you want a guaranteed, 100% success rate on numbers where SMS/voice are blocked.

##

<div align="center">

### 💬 Need help? Talk to me on Telegram

[![whalibmob channel](https://img.shields.io/badge/whalibmob_channel-News_%26_updates-229ED9?style=for-the-badge&logo=telegram&logoColor=white)](https://t.me/whalibmob)

[![Contact me on Telegram](https://img.shields.io/badge/Contact_me-%40brtyu545-229ED9?style=for-the-badge&logo=telegram&logoColor=white)](https://t.me/brtyu545)

[![whalibmob support channel](https://img.shields.io/badge/whalibmob_support-Client_support-25D366?style=for-the-badge&logo=telegram&logoColor=white)](https://t.me/+V6aZiZ01u3YxM2U0)

**💼 Need support for whalibmob or for any WhatsApp-related service? Enter here in the whalibmob support channel 👉 [https://t.me/+V6aZiZ01u3YxM2U0](https://t.me/+V6aZiZ01u3YxM2U0) — I offer dedicated support to clients.**

**I'm waiting for you — message me on Telegram at [@brtyu545](https://t.me/brtyu545) if you want help with whalibmob, or if you need anything related to features such as WhatsApp or Instagram. I'm at your disposal.**

</div>

> [!CAUTION]
> Use a dedicated phone number with this library. Connecting with a number that is already active on a real device will cause WhatsApp to log that device out.

> [!NOTE]
> **Actively developed.** WhatsApp changed the mobile protocol recently, and whalibmob is being kept in step with it release by release. Contributions are welcome — pull requests are accepted.

> [!IMPORTANT]
> This project is not affiliated, associated, authorized, endorsed by, or in any way officially connected with WhatsApp or any of its subsidiaries or affiliates. "WhatsApp" and related names are registered trademarks of their respective owners. Use at your own discretion.

- **It registers numbers.** Give it a phone number that has never been on WhatsApp, request the code over SMS, voice call, flash call or an old WhatsApp account, confirm it, and the account exists — as an **Android or iOS device**, on the Mobile API. No phone, no scanning, no existing account to borrow. See [Register a New Number](https://github.com/Kunboruto20/whalibmob/blob/main/docs/registration.md#register-a-new-number).
- **It also speaks WhatsApp Web**, over a WebSocket. When a number cannot receive an SMS, or is already live on a phone, whalibmob links itself to that account by **QR code**, an **8-character pairing code** or, where the account has one, its **passkey**, and runs as one of its linked devices — with the full message history and the account's address book. See [Linking to an Existing Account](https://github.com/Kunboruto20/whalibmob/blob/main/docs/linking.md#linking-to-an-existing-account-pairing-code-or-qr).
- **The API is identical in both modes.** Everything below — sending, media, groups, events — reads the same whichever way the session was created.
- No browser, no Selenium, no external runtime. It talks to WhatsApp directly over a **TCP socket** with the **Noise Protocol** handshake.
- Signal Protocol encryption is **fully inlined** in pure JavaScript — no native binaries, no node-gyp, runs anywhere Node.js runs.
- **It can prove it is a real handset.** The on-device Frida scripts in [`frida/`](https://github.com/Kunboruto20/whalibmob/tree/main/frida) mint the hardware attestation WhatsApp's registration server expects — Play Integrity and Keystore on Android, App Attest on iOS — and whalibmob folds the result into the registration requests. See [Device Attestation](https://github.com/Kunboruto20/whalibmob/blob/main/docs/attestation.md#device-attestation--play-integrity-and-app-attest).


## Install

```sh
npm install whalibmob
```

Install the CLI globally:

```sh
npm install -g whalibmob
```


## Quick Start

One script that registers a number on its first run, then connects and sends a message. Save it as `quick-start.js`, set `PHONE` and `TO`, and run `node quick-start.js`.

```js
const {
  WhalibmobClient, createNewStore, loadStore, saveStore,
  requestSmsCode, verifyCode, storeFileFor
} = require('whalibmob')
const os = require('os')
const path = require('path')
const readline = require('readline/promises')

const PHONE    = '40712345678'                 // your number: country code + number, no '+'
const TO       = '40798765432'                 // who to message
const BASE_DIR = path.join(os.homedir(), '.waSession')

async function register(phone) {
  const store = createNewStore(phone, { name: 'My Bot' })
  await requestSmsCode(store, 'sms')           // or 'voice'; throws when refused

  const rl   = readline.createInterface({ input: process.stdin, output: process.stdout })
  const code = (await rl.question('6-digit code: ')).replace(/\D/g, '')
  rl.close()

  const result = await verifyCode(store, code) // updates `store` in place
  if (!['ok', 'sent', 'verified'].includes(result.status)) {
    throw new Error('registration failed: ' + JSON.stringify(result))
  }
  store.registered  = true
  store.codePending = false
  // Saved only once registered, so a session file always means a live account.
  saveStore(store, storeFileFor(BASE_DIR, store.phoneNumber))
  if (store.phoneNumber !== phone) {
    // WhatsApp can file the account under a slightly different number.
    console.log(`WhatsApp knows this account as +${store.phoneNumber}: set PHONE to '${store.phoneNumber}'`)
  }
  return store.phoneNumber
}

async function main() {
  let phone = PHONE
  // Registering again would replace the account, so any saved session is used as is.
  if (!loadStore(storeFileFor(BASE_DIR, phone))) phone = await register(phone)

  const client = new WhalibmobClient({ sessionDir: BASE_DIR })
  client.on('connected',    () => console.log('connected as +' + phone))
  client.on('reconnecting', ({ attempt }) => console.log('reconnecting, attempt', attempt))
  client.on('auth_failure', ({ reason }) => { console.error('session ended:', reason); process.exit(1) })
  client.on('message', msg => {
    const d = msg.decoded
    if (d && d.type === 'text') console.log('message from', msg.from + ':', d.text)
  })

  await client.init(phone)                     // resolves once logged in
  await client.sendText(TO, 'Hello from whalibmob!')
}

main().catch(err => { console.error(err.message || err); process.exit(1) })
```

The client reconnects by itself after a dropped connection — do not create a new one on `disconnected`. Prefer no code at all? The [CLI](https://github.com/Kunboruto20/whalibmob/blob/main/docs/cli-getting-started.md#cli--getting-started) does the same in a few commands: request the code, register, connect, then `/send`. A brand-new account is watched closely by WhatsApp's anti-abuse checks, so send the first messages to people who have your number saved — see [Accounts](https://github.com/Kunboruto20/whalibmob/blob/main/docs/accounts.md#why-registration-can-be-blocked--the-anti-abuse-landscape).


## Approving a Companion Device

A number registered with whalibmob is the account's **primary device**, and from the CLI it can approve **WhatsApp Web** in the phone's place: Web is linked as a companion and is handed the chat history this program has kept for the number. That is not the whole history the account has ever had; what it covers is spelled out below. Keep the shell open until the chats have loaded.

```sh
wa connect 447949738354 --session ~/whalibmob_auth
```

1. On WhatsApp Web choose **Link with phone number** and enter the same phone number. Web shows an 8-character code, good for about three minutes. The shell announces the request:
   ```
   wa +447949738354>   link request   companion c0ffee01   code window 2:50   id a1a1a1a1
   ```
2. Type the code into the shell (the dash, a space between the halves and the letter case do not matter):
   ```
   wa +447949738354> /link-code ABCD-EFGH
   ```
3. If more than one browser is asking, nothing is approved. The shell lists them; repeat the command with the number or the id of yours, for example `/link-code ABCD-EFGH 2`.
4. If the history is known to be partial, the shell says what is and is not in it, and asks `[y/N]` before approving. Enter means no, and nothing is approved.

When it works, the shell ends with:

```
approval sent. The binding to the browser stays unconfirmed unless you confirm it with /link-confirm FILE|JSON (needs the companion's public proof JSON).
sending the stored history to the companion...
history handed to the companion: 12 chats, 340 messages, 20.0 KB (sent inline), first link
capture period: since registration: the store has been on since this number was registered
The history is handed over; whether Web has finished showing it cannot be seen from here. If Web stays on "Loading chats", run /link-status.
```

`/linked-devices` then shows the companion (the numbers are an example):

```
wa +447949738354> /linked-devices
linked devices  +447949738354
  #0   this phone (primary)
  #12  companion   key index 3   linked 2026-11-02 15:31 by code   binding unconfirmed   history delivered (12 chats, 340 msgs)
```

**What the history covers.** Only what this program stored for the number since its store began: since registration for a number registered here with the CLI, or since the store was first switched on for any other (`--no-message-store` switches it off). The store keeps the newest 100 messages of each chat and 20 000 in all, oldest first out. What it knows it lost (messages it could not decrypt or save, stretches when it was not running or could not write to disk) is reported, and the shell asks before approving unless the store has kept everything since registration and dropped nothing.

**What is never transferred.** The content of revoked, expired and view-once messages (a revoked message goes over as a deleted-message marker, the other two not at all), and reactions and poll votes, which are not stored, so they do not appear on the new device. Status posts and channels are not kept. A message of a type the library does not decode is kept as it was received and handed over unchanged, for Web to read.

**Limits.**
- A second companion while one is still linked is not supported: the shell refuses up front. Log the first one out of Web (Menu → Log out) first.
- The binding stays **unconfirmed** unless a companion's public proof JSON is reconciled with `/link-confirm FILE|JSON`. Standard WhatsApp Web is not known to offer such a proof, so with an ordinary browser expect it to stay unconfirmed; the device list from WhatsApp is what shows the companion is there.

**Linking again.** Log out on Web (Menu → Log out); wait until `/linked-devices` no longer lists it; run `/link-retire` (it works once the approval is 5 minutes old, and clears the hold an unconfirmed approval leaves behind); then `/link-code` again. Web is handed the history again, with the same app-state key.

**When it stops part-way.** `/link-bootstrap --resume` continues a handover after its last accepted step, and never sends blindly: a step whose reply never came is sent once more only with `--resend-uncertain`. `/link-unlock` shows who holds the lock on the link journal and breaks it only when you answer `y`: a lock left by a dead process on the same machine is recovered without it, and any other holder is reported as busy, with who holds it, until you have checked it is gone and unlocked.

The whole walk-through, every command and the library API (`messageStore`, `getPrimaryMessageStore()`, `getPrimaryLinkReadiness()`, `bootstrapPrimaryCompanion()`, `unlockPrimaryLink()`) are in [Approving a Companion Device](https://github.com/Kunboruto20/whalibmob/blob/main/docs/linking.md#approving-a-companion-device-primary-role); the commands alone are in [the CLI reference](https://github.com/Kunboruto20/whalibmob/blob/main/docs/cli-commands.md#companion-commands-approving-whatsapp-web).


## Documentation

The full guide is split by topic so every page loads fast and reads cleanly. Pick a section below.

### [Device Attestation — Play Integrity & App Attest](https://github.com/Kunboruto20/whalibmob/blob/main/docs/attestation.md)

- [Device Attestation — Play Integrity and App Attest](https://github.com/Kunboruto20/whalibmob/blob/main/docs/attestation.md#device-attestation--play-integrity-and-app-attest)

### [CLI — Getting Started](https://github.com/Kunboruto20/whalibmob/blob/main/docs/cli-getting-started.md)

Install the CLI, register a number and connect, all from the terminal.

- [CLI — Getting Started](https://github.com/Kunboruto20/whalibmob/blob/main/docs/cli-getting-started.md#cli--getting-started)

### [CLI — Interactive Shell Commands](https://github.com/Kunboruto20/whalibmob/blob/main/docs/cli-commands.md)

Every command of the interactive shell: messages, presence, profile, chats, groups, channels.

- [CLI — Interactive Shell Commands](https://github.com/Kunboruto20/whalibmob/blob/main/docs/cli-commands.md#cli--interactive-shell-commands)

### [Registering & Connecting an Account](https://github.com/Kunboruto20/whalibmob/blob/main/docs/registration.md)

- [Library API](https://github.com/Kunboruto20/whalibmob/blob/main/docs/registration.md#library-api)
- [Connecting Account](https://github.com/Kunboruto20/whalibmob/blob/main/docs/registration.md#connecting-account)

### [Linking, Companion Mode & Approving Devices](https://github.com/Kunboruto20/whalibmob/blob/main/docs/linking.md)

- [Linking to an Existing Account (Pairing Code or QR)](https://github.com/Kunboruto20/whalibmob/blob/main/docs/linking.md#linking-to-an-existing-account-pairing-code-or-qr)
- [Linking with a Passkey](https://github.com/Kunboruto20/whalibmob/blob/main/docs/linking.md#linking-with-a-passkey)
- [Companion Mode — Node.js API](https://github.com/Kunboruto20/whalibmob/blob/main/docs/linking.md#companion-mode--nodejs-api)
- [Approving a Companion Device (Primary Role)](https://github.com/Kunboruto20/whalibmob/blob/main/docs/linking.md#approving-a-companion-device-primary-role)

### [Accounts — Number, Consent & Registration Blocks](https://github.com/Kunboruto20/whalibmob/blob/main/docs/accounts.md)

Which number WhatsApp files the account under, consent refusals, and why a registration can be blocked.

- [The Number WhatsApp Files Your Account Under](https://github.com/Kunboruto20/whalibmob/blob/main/docs/accounts.md#the-number-whatsapp-files-your-account-under)
- [When Registration Is Refused for Consent](https://github.com/Kunboruto20/whalibmob/blob/main/docs/accounts.md#when-registration-is-refused-for-consent)
- [Why Registration Can Be Blocked — The Anti-Abuse Landscape](https://github.com/Kunboruto20/whalibmob/blob/main/docs/accounts.md#why-registration-can-be-blocked--the-anti-abuse-landscape)

### [The Push Token](https://github.com/Kunboruto20/whalibmob/blob/main/docs/push-token.md)

The Firebase (Android) and APNs (iOS) token a registration sends, and receiving the code over push.

- [The Push Token](https://github.com/Kunboruto20/whalibmob/blob/main/docs/push-token.md#the-push-token)

### [Routing Traffic Through a Proxy](https://github.com/Kunboruto20/whalibmob/blob/main/docs/proxy.md)

Sending everything the library sends out — registration, the message socket, media — through a SOCKS proxy or Tor.

- [Routing Traffic Through a Proxy](https://github.com/Kunboruto20/whalibmob/blob/main/docs/proxy.md#routing-traffic-through-a-proxy)

### [Sessions & Signal Store](https://github.com/Kunboruto20/whalibmob/blob/main/docs/sessions.md)

Where a session is kept, saving and restoring it, database backends, and the Signal store utilities.

- [Saving & Restoring Sessions](https://github.com/Kunboruto20/whalibmob/blob/main/docs/sessions.md#saving--restoring-sessions)
- [Signal Store Utilities](https://github.com/Kunboruto20/whalibmob/blob/main/docs/sessions.md#signal-store-utilities)

### [Handling Events & History Sync](https://github.com/Kunboruto20/whalibmob/blob/main/docs/events-history.md)

- [Handling Events](https://github.com/Kunboruto20/whalibmob/blob/main/docs/events-history.md#handling-events)
- [Connection Health, Sync and Account Events](https://github.com/Kunboruto20/whalibmob/blob/main/docs/events-history.md#connection-health-sync-and-account-events)
- [Handling Errors](https://github.com/Kunboruto20/whalibmob/blob/main/docs/events-history.md#handling-errors)
- [History Sync](https://github.com/Kunboruto20/whalibmob/blob/main/docs/events-history.md#history-sync)

### [Sending & Receiving Messages](https://github.com/Kunboruto20/whalibmob/blob/main/docs/messaging.md)

- [Receiving Media](https://github.com/Kunboruto20/whalibmob/blob/main/docs/messaging.md#receiving-media)
- [Sending Messages](https://github.com/Kunboruto20/whalibmob/blob/main/docs/messaging.md#sending-messages)
- [Media Messages](https://github.com/Kunboruto20/whalibmob/blob/main/docs/messaging.md#media-messages)
- [Status / Stories](https://github.com/Kunboruto20/whalibmob/blob/main/docs/messaging.md#status--stories)
- [Send States in Chat](https://github.com/Kunboruto20/whalibmob/blob/main/docs/messaging.md#send-states-in-chat)
- [Modifying Chats](https://github.com/Kunboruto20/whalibmob/blob/main/docs/messaging.md#modifying-chats)
- [Vote on a Poll](https://github.com/Kunboruto20/whalibmob/blob/main/docs/messaging.md#vote-on-a-poll) · [Pin a Message](https://github.com/Kunboruto20/whalibmob/blob/main/docs/messaging.md#pin-a-message) · [Send a Message You Encoded](https://github.com/Kunboruto20/whalibmob/blob/main/docs/messaging.md#send-a-message-you-encoded)
- [Encrypted Reactions, Comments, Event Responses and Edits](https://github.com/Kunboruto20/whalibmob/blob/main/docs/messaging.md#encrypted-reactions-comments-event-responses-and-edits)
- [Labels](https://github.com/Kunboruto20/whalibmob/blob/main/docs/messaging.md#labels) · [Delete a Message for Me](https://github.com/Kunboruto20/whalibmob/blob/main/docs/messaging.md#delete-a-message-for-me)

### [User Queries, Profile, Privacy & Account State](https://github.com/Kunboruto20/whalibmob/blob/main/docs/profile-privacy.md)

- [User Queries](https://github.com/Kunboruto20/whalibmob/blob/main/docs/profile-privacy.md#user-queries)
- [Change Profile](https://github.com/Kunboruto20/whalibmob/blob/main/docs/profile-privacy.md#change-profile)
- [Privacy](https://github.com/Kunboruto20/whalibmob/blob/main/docs/profile-privacy.md#privacy)
- [Account State](https://github.com/Kunboruto20/whalibmob/blob/main/docs/profile-privacy.md#account-state)

### [Groups, Communities & Channels](https://github.com/Kunboruto20/whalibmob/blob/main/docs/groups-channels.md)

- [Groups](https://github.com/Kunboruto20/whalibmob/blob/main/docs/groups-channels.md#groups)
- [Communities](https://github.com/Kunboruto20/whalibmob/blob/main/docs/groups-channels.md#communities)
- [Newsletters (Channels)](https://github.com/Kunboruto20/whalibmob/blob/main/docs/groups-channels.md#newsletters-channels)
- [Read a Channel's Posts](https://github.com/Kunboruto20/whalibmob/blob/main/docs/groups-channels.md#read-a-channels-posts) · [Live Updates, Views and Reactions](https://github.com/Kunboruto20/whalibmob/blob/main/docs/groups-channels.md#live-updates-views-and-reactions)
- [Business Profile](https://github.com/Kunboruto20/whalibmob/blob/main/docs/groups-channels.md#business-profile)
- [Links, Bots, Sticker Packs and Web Push](https://github.com/Kunboruto20/whalibmob/blob/main/docs/groups-channels.md#links-bots-sticker-packs-and-web-push)
- [WhatsApp IDs](https://github.com/Kunboruto20/whalibmob/blob/main/docs/groups-channels.md#whatsapp-ids)

### [IDs, Transport, Media Encryption & Device Emulation](https://github.com/Kunboruto20/whalibmob/blob/main/docs/internals.md)

- [Transport](https://github.com/Kunboruto20/whalibmob/blob/main/docs/internals.md#transport)
- [Media Encryption](https://github.com/Kunboruto20/whalibmob/blob/main/docs/internals.md#media-encryption)
- [Device Emulation](https://github.com/Kunboruto20/whalibmob/blob/main/docs/internals.md#device-emulation)


---

## Support this project

If whalibmob saves you time, you can support its development.

**USDT — TRC-20 (Tron network only)**

```
TNxxWvAc5m5YS89uz5uSrbXC9EKPuS27aP
```

> [!WARNING]
> This address is **TRC-20 on the Tron network**. Send **only USDT on TRC-20** to
> it. USDT sent on any other network — ERC-20 (Ethereum), BEP-20 (BSC), Polygon,
> or anything else — will be **lost and cannot be recovered**. Always double-check
> the network in your wallet before sending, and copy the address in full.

The **Sponsor** button at the top of the repository leads back here.

## License

MIT

## Star History

<a href="https://star-history.com/#Kunboruto20/whalibmob&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Kunboruto20/whalibmob&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=Kunboruto20/whalibmob&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=Kunboruto20/whalibmob&type=Date" />
  </picture>
</a>
