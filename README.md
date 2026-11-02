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
[![Link an account](https://img.shields.io/badge/Link_an_account-QR_or_pairing_code-128C7E?style=for-the-badge)](https://github.com/Kunboruto20/whalibmob/blob/main/docs/linking.md#linking-to-an-existing-account-pairing-code-or-qr)
[![Use the CLI](https://img.shields.io/badge/Use_the_CLI-no_code_needed-075E54?style=for-the-badge)](https://github.com/Kunboruto20/whalibmob/blob/main/docs/cli.md#cli--getting-started)

[![Library API](https://img.shields.io/badge/Library_API-Node.js-34B7F1?style=for-the-badge)](https://github.com/Kunboruto20/whalibmob/blob/main/docs/registration.md#library-api)
[![Send messages](https://img.shields.io/badge/Send_messages-text_media_polls-34B7F1?style=for-the-badge)](https://github.com/Kunboruto20/whalibmob/blob/main/docs/messaging.md#sending-messages)
[![Handle events](https://img.shields.io/badge/Handle_events-incoming_%26_receipts-34B7F1?style=for-the-badge)](https://github.com/Kunboruto20/whalibmob/blob/main/docs/events-history.md#handling-events)

[![Device attestation](https://img.shields.io/badge/Device_attestation-Play_Integrity_%2B_App_Attest-8E44AD?style=for-the-badge)](https://github.com/Kunboruto20/whalibmob/blob/main/docs/attestation.md#device-attestation--play-integrity-and-app-attest)

[![Why registration can be blocked](https://img.shields.io/badge/Why_registration_can_be_blocked-anti--abuse_%26_unofficial--client_checks-C0392B?style=for-the-badge)](https://github.com/Kunboruto20/whalibmob/blob/main/docs/accounts-sessions.md#why-registration-can-be-blocked--the-anti-abuse-landscape)

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
- **It also speaks WhatsApp Web**, over a WebSocket. When a number cannot receive an SMS, or is already live on a phone, whalibmob links itself to that account by **QR code** or an **8-character pairing code** and runs as one of its linked devices — with the full message history and the account's address book. See [Linking to an Existing Account](https://github.com/Kunboruto20/whalibmob/blob/main/docs/linking.md#linking-to-an-existing-account-pairing-code-or-qr).
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


## Documentation

The full guide is split by topic so every page loads fast and reads cleanly. Pick a section below.

### [Device Attestation — Play Integrity & App Attest](https://github.com/Kunboruto20/whalibmob/blob/main/docs/attestation.md)

- [Device Attestation — Play Integrity and App Attest](https://github.com/Kunboruto20/whalibmob/blob/main/docs/attestation.md#device-attestation--play-integrity-and-app-attest)

### [Command-Line Interface (CLI)](https://github.com/Kunboruto20/whalibmob/blob/main/docs/cli.md)

- [CLI — Getting Started](https://github.com/Kunboruto20/whalibmob/blob/main/docs/cli.md#cli--getting-started)
- [CLI — Interactive Shell Commands](https://github.com/Kunboruto20/whalibmob/blob/main/docs/cli.md#cli--interactive-shell-commands)

### [Registering & Connecting an Account](https://github.com/Kunboruto20/whalibmob/blob/main/docs/registration.md)

- [Library API](https://github.com/Kunboruto20/whalibmob/blob/main/docs/registration.md#library-api)
- [Connecting Account](https://github.com/Kunboruto20/whalibmob/blob/main/docs/registration.md#connecting-account)

### [Linking, Companion Mode & Approving Devices](https://github.com/Kunboruto20/whalibmob/blob/main/docs/linking.md)

- [Linking to an Existing Account (Pairing Code or QR)](https://github.com/Kunboruto20/whalibmob/blob/main/docs/linking.md#linking-to-an-existing-account-pairing-code-or-qr)
- [Companion Mode — Node.js API](https://github.com/Kunboruto20/whalibmob/blob/main/docs/linking.md#companion-mode--nodejs-api)
- [Approving a Companion Device (Primary Role)](https://github.com/Kunboruto20/whalibmob/blob/main/docs/linking.md#approving-a-companion-device-primary-role)

### [Accounts, Push, Proxy & Sessions](https://github.com/Kunboruto20/whalibmob/blob/main/docs/accounts-sessions.md)

- [The Number WhatsApp Files Your Account Under](https://github.com/Kunboruto20/whalibmob/blob/main/docs/accounts-sessions.md#the-number-whatsapp-files-your-account-under)
- [When Registration Is Refused for Consent](https://github.com/Kunboruto20/whalibmob/blob/main/docs/accounts-sessions.md#when-registration-is-refused-for-consent)
- [Why Registration Can Be Blocked — The Anti-Abuse Landscape](https://github.com/Kunboruto20/whalibmob/blob/main/docs/accounts-sessions.md#why-registration-can-be-blocked--the-anti-abuse-landscape)
- [The Push Token](https://github.com/Kunboruto20/whalibmob/blob/main/docs/accounts-sessions.md#the-push-token)
- [Routing Traffic Through a Proxy](https://github.com/Kunboruto20/whalibmob/blob/main/docs/accounts-sessions.md#routing-traffic-through-a-proxy)
- [Saving & Restoring Sessions](https://github.com/Kunboruto20/whalibmob/blob/main/docs/accounts-sessions.md#saving--restoring-sessions)
- [Signal Store Utilities](https://github.com/Kunboruto20/whalibmob/blob/main/docs/accounts-sessions.md#signal-store-utilities)

### [Handling Events & History Sync](https://github.com/Kunboruto20/whalibmob/blob/main/docs/events-history.md)

- [Handling Events](https://github.com/Kunboruto20/whalibmob/blob/main/docs/events-history.md#handling-events)
- [History Sync](https://github.com/Kunboruto20/whalibmob/blob/main/docs/events-history.md#history-sync)

### [Sending & Receiving Messages](https://github.com/Kunboruto20/whalibmob/blob/main/docs/messaging.md)

- [Receiving Media](https://github.com/Kunboruto20/whalibmob/blob/main/docs/messaging.md#receiving-media)
- [Sending Messages](https://github.com/Kunboruto20/whalibmob/blob/main/docs/messaging.md#sending-messages)
- [Media Messages](https://github.com/Kunboruto20/whalibmob/blob/main/docs/messaging.md#media-messages)
- [Status / Stories](https://github.com/Kunboruto20/whalibmob/blob/main/docs/messaging.md#status--stories)
- [Send States in Chat](https://github.com/Kunboruto20/whalibmob/blob/main/docs/messaging.md#send-states-in-chat)
- [Modifying Chats](https://github.com/Kunboruto20/whalibmob/blob/main/docs/messaging.md#modifying-chats)

### [User Queries, Profile, Privacy & Account State](https://github.com/Kunboruto20/whalibmob/blob/main/docs/profile-privacy.md)

- [User Queries](https://github.com/Kunboruto20/whalibmob/blob/main/docs/profile-privacy.md#user-queries)
- [Change Profile](https://github.com/Kunboruto20/whalibmob/blob/main/docs/profile-privacy.md#change-profile)
- [Privacy](https://github.com/Kunboruto20/whalibmob/blob/main/docs/profile-privacy.md#privacy)
- [Account State](https://github.com/Kunboruto20/whalibmob/blob/main/docs/profile-privacy.md#account-state)

### [Groups, Communities & Channels](https://github.com/Kunboruto20/whalibmob/blob/main/docs/groups-channels.md)

- [Groups](https://github.com/Kunboruto20/whalibmob/blob/main/docs/groups-channels.md#groups)
- [Communities](https://github.com/Kunboruto20/whalibmob/blob/main/docs/groups-channels.md#communities)
- [Newsletters (Channels)](https://github.com/Kunboruto20/whalibmob/blob/main/docs/groups-channels.md#newsletters-channels)
- [Business Profile](https://github.com/Kunboruto20/whalibmob/blob/main/docs/groups-channels.md#business-profile)
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
