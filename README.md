<div align='center'>whalibmob is a pure JavaScript Node.js library for interacting with the WhatsApp Mobile API.</div>
<div align='center'>v5.1.14</div>

##

> [!IMPORTANT]



CONTACT ME ON TELEGRAM  IF YOU WANT TO WORK WITH ME AND IF YOU HAVE PROBLEM WITH WHALIBMOB : @brtyu545

If you want News about whalibmob enter this whalibmob channel: https://t.me/+sHN4MDCyB7U5OWY0





> [!CAUTION]
> Use a dedicated phone number with this library. Connecting with a number that is already active on a real device will cause WhatsApp to log that device out.

> [!CAUTION] 
> Whalibmob now It needs to be rewritten because WhatsApp mobile and has changed the protocol lately and now whalibmob is in testing and some updates by Me Any pull request is accepted. 

> [!IMPORTANT]
> This project is not affiliated, associated, authorized, endorsed by, or in any way officially connected with WhatsApp or any of its subsidiaries or affiliates. "WhatsApp" and related names are registered trademarks of their respective owners. Use at your own discretion.

- whalibmob does not require a browser, Selenium, or any other external runtime — it communicates directly with WhatsApp using a **TCP socket** and the **Noise Protocol** handshake.
- The library operates as a real **iOS mobile device**, using the Mobile API endpoint, which behaves differently from the Web API.
- It **also speaks WhatsApp Web over a WebSocket**. When a number cannot receive an SMS, or is already in use on a phone, whalibmob can link itself to that existing account with an **8-character pairing code** and run as one of its linked devices — with full message history and the account's address book. See [Linking to an Existing Account](#linking-to-an-existing-account-pairing-code). The API is identical in both modes.
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
  - [Pairing Code](#cli-pairing-code)
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
    - [Sync App State (CLI)](#sync-app-state)
    - [Account Restriction Countdown](#account-restriction-countdown)
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
    - [Personal Invitations (CLI)](#personal-invitations)
    - [Group Settings](#group-settings)
  - [Community Commands](#community-commands-cli)
  - [Newsletter / Channel Commands](#newsletter--channel-commands)
  - [Business Profile Command](#business-profile-command-cli)
  - [Registration Commands (in-shell)](#registration-commands-in-shell)
  - [Connection Commands (in-shell)](#connection-commands-in-shell)
  - [Full Command Reference Table](#full-command-reference-table)
- [Library API](#library-api)
  - [Connecting Account](#connecting-account)
    - [Register a New Number](#register-a-new-number)
    - [Registering as Android](#registering-as-android)
    - [Registering a WhatsApp Business account](#registering-a-whatsapp-business-account)
      - [Why an APK is involved at all](#why-an-apk-is-involved-at-all)
      - [Fetching the APK on its own](#fetching-the-apk-on-its-own)
      - [Reading it out of an APK you already have](#reading-it-out-of-an-apk-you-already-have)
    - [Device Attestation with Frida (optional)](#device-attestation-with-frida-optional)
    - [Connect](#connect)
      - [Client Options](#client-options)
  - [Linking to an Existing Account (Pairing Code)](#linking-to-an-existing-account-pairing-code)
    - [Requesting a Pairing Code](#requesting-a-pairing-code)
    - [Reconnecting a Linked Session](#reconnecting-a-linked-session)
    - [Choosing Your Own Code](#choosing-your-own-code)
    - [Options](#options)
    - [Events Specific to Linking](#events-specific-to-linking)
    - [Getting the History and the Address Book](#getting-the-history-and-the-address-book)
    - [Session Files](#session-files)
    - [Media in Companion Mode](#media-in-companion-mode)
    - [Device Identity](#device-identity)
    - [How the Code Protects the Link](#how-the-code-protects-the-link)
  - [Companion Mode — Node.js API](#companion-mode--nodejs-api)
    - [Complete Working Example](#complete-working-example)
    - [Methods](#methods)
    - [Events](#events)
    - [Reading What the Phone Sent](#reading-what-the-phone-sent)
    - [Sending](#sending)
    - [Handling Reconnects](#handling-reconnects)
    - [Knowing Which Mode You Are In](#knowing-which-mode-you-are-in)
    - [Two Sessions on One Number](#two-sessions-on-one-number)
  - [The Number WhatsApp Files Your Account Under](#the-number-whatsapp-files-your-account-under)
  - [When Registration Is Refused for Consent](#when-registration-is-refused-for-consent)
  - [Routing Registration Through a Proxy](#routing-registration-through-a-proxy)
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
    - [When 463 Means the Account Is Restricted](#when-463-means-the-account-is-restricted)
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
    - [Call Link](#call-link)
    - [Media Messages](#media-messages)
      - [Image Message](#image-message)
      - [Video Message](#video-message)
      - [Audio Message](#audio-message)
      - [Voice Note](#voice-note)
      - [Document Message](#document-message)
      - [Sticker Message](#sticker-message)
    - [Status / Stories](#status--stories)
    - [Status Privacy](#status-privacy)
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
    - [Reading Changes Made Elsewhere](#reading-changes-made-elsewhere)
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
    - [Read Privacy Settings](#read-privacy-settings)
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
    - [Personal Invitations](#personal-invitations)
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
  - [When the server answers 405 on connect](#when-the-server-answers-405-on-connect)
  - [Finding out what a 405 objects to](#finding-out-what-a-405-objects-to)

---

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

**Set the account's display name while registering** with `--name`. This is the
name people who have *not* saved your number see next to it — in group
participant lists, in notifications, and beside your messages. Quote it if it
contains spaces:

```sh
wa registration --request-code 919634847671 --name "Ricardo Trade"
```

The name is stored with the session and announced on every connection from then
on. Registration itself carries no name — the server learns it when the session
connects — so a number registered without `--name` has none until one is set.
It can be given at either registration step, and changed later with `/name`.

**Registering as Android** is the same command with the platform named. Nothing
else to prepare — see [what it does behind that one command](#registering-as-android).

Linux, macOS, Termux:

```sh
WA_OS=android WA_DEVICE=samsung-s24-ultra wa registration --request-code 919634847671 --debug
```

Windows, Command Prompt — `set` on its own line, because `VAR=value` in front of
a command is Unix syntax and Windows refuses it:

```bat
set WA_OS=android
set WA_DEVICE=samsung-s24-ultra
wa registration --request-code 919634847671 --debug
```

Windows, PowerShell:

```powershell
$env:WA_OS = "android"
$env:WA_DEVICE = "samsung-s24-ultra"
wa registration --request-code 919634847671 --debug
```

A `.env` file in the directory you run from works the same everywhere and saves
repeating it — see [Device Quick Start](#device-quick-start). `--debug` prints
every request and reply, which is worth having the first time: its first line
names the platform that actually went out, so you can see whether the variables
arrived.

The variables only matter for the command that *creates* the session. What a
session registered as is written into it, so the confirmation step and every
later connect follow the session, not whatever the shell carries at the time.

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
registered  session saved to /home/user/.waSession/919634847671/919634847671.json
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

Use a different authentication folder with `--session`:

```sh
wa connect 919634847671 --session /data/my-sessions
```

The CLI asks what to call it once, on a first run, and remembers the answer in
`~/.whalibmob.json`. Each number gets its own folder inside — see
[Saving & Restoring Sessions](#saving--restoring-sessions).

> [!IMPORTANT]
> **If this is refused with `405`, do not re-register the number.** The account
> is fine; the server declined the version the connect announced. Check for a
> `WA_VERSION` in your shell or in a `.env` file in the directory you ran the
> command from — it overrides the version the session registered with, and a
> stale one left there refuses every connect from that directory. See
> [When the server answers 405 on connect](#when-the-server-answers-405-on-connect).

### CLI Pairing Code

If the number is already in use on a phone, or the verification SMS never arrives, link to the existing account instead. When it is not obvious which way you mean, `wa connect` asks:

```
  how do you want to connect?
    1) sms           register this number as its own device
    2) pairing code  link to an existing WhatsApp account (8-digit code)
  sms or pairing code?  [1/2] 2
```

The question is skipped when only one kind of session exists on disk, and when stdin is not a terminal. Force either one:

```sh
wa connect 919634847671 --sms
wa connect 919634847671 --pair
```

Or go straight to linking:

```sh
wa pair 919634847671
```

```
linking +919634847671 to an existing WhatsApp account...
────────────────────────────────────────────────────────
  pairing code   K7M2-QX4B
────────────────────────────────────────────────────────
  on the phone that owns +919634847671:
    WhatsApp → Settings → Linked Devices → Link a device
    → Link with phone number instead → enter the code above

  the code is valid for a few minutes; waiting...

  linked as 919634847671:7@s.whatsapp.net  (112713111982325:7@lid)
  device slot 7  ·  primary is android
  finishing handshake...
connected as +919634847671  (web / companion)
  history  INITIAL_BOOTSTRAP  chats=214  contacts=486
wa +919634847671>
```

Once linked, plain `wa connect` reconnects without asking for a new code. To pick your own code, pass it as a second argument — exactly 8 characters:

```sh
wa pair 919634847671 MYCODE12
```

The debug prompt works the same in both modes. Answer `y` at startup, or pass `--debug`, to see every stanza of the pairing exchange:

```sh
wa pair 919634847671 --debug
```

From inside the shell:

```sh
wa> /pair 919634847671
wa> /connect 919634847671 pair
wa> /connect 919634847671 sms
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

`about updated` now means the about was read back from the server and matches
what you typed. When the server accepts the stanza but still reports something
else, it says so instead — and if the about is stored but hidden, it names the
privacy setting that is hiding it.

#### CLI Change Profile Picture

Reads the image from disk, crops it square, scales it to 640×640 and uploads it
as your profile picture. JPEG, PNG, GIF and BMP need nothing installed; WebP and
HEIC need `ffmpeg` or `jimp`.

```sh
wa> /photo ./avatar.jpg
profile picture updated  id=1753912045

wa> /photo remove
profile picture removed
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

On a **linked** (pairing-code) session these write to app state, so a change here
reaches your phone and every other linked device.

On an **SMS** session this device is the primary and there is no app state key
unless you have linked a companion to it. `/mute`, `/unmute` and `/read` still
send the request a primary makes for itself; `/pin`, `/archive` and `/star`
update this session only. The command says which happened:

```sh
wa> /pin 919634847671@s.whatsapp.net
pinned  (this session only — no app state key)
```

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

Add `me` when the message is one you sent — it is part of how the star is filed,
so leaving it off on your own message stars the wrong thing.

```sh
wa> /star   919634847671@s.whatsapp.net 3EB0ABCDEF123456 me
wa> /unstar 919634847671@s.whatsapp.net 3EB0ABCDEF123456
```

<a id="cli-app-state"></a>

#### Sync App State

Pulls in pins, archives, mutes, stars and contact names changed on your phone or
another linked device. This happens on its own whenever the server says
something moved; the command is for pulling on demand.

```sh
wa> /appstate
syncing app state...
  ──────────────────────────────────────────────────
  critical_block        v3   0 change(s)
  critical_unblock_low  v18  2 change(s)
  regular_high          v7   0 change(s)
  regular_low           v41  3 change(s)
  regular               v2   0 change(s)
  total                 5 change(s) applied
  ──────────────────────────────────────────────────

# just one part of it
wa> /appstate regular_low

# throw away what we hold and re-read everything
wa> /appstate --snapshot
```

Changes that arrive on their own are printed as they land:

```sh
  pinned  919634847671@s.whatsapp.net
  muted  120363000000000000@g.us  until 2026-08-01T09:00:00.000Z
  contact  12345678901@s.whatsapp.net  → Ion
```

If your phone has not yet shared a sync key with this session, the command says
so — leave WhatsApp open on the phone for a moment and try again.

<a id="cli-restriction"></a>

#### Account Restriction Countdown

When WhatsApp restricts an account, new chats are refused with error 463 until
it expires — usually about five hours the first time. `/restriction` asks the
server how long is left and then counts it down, once a second, in place:

```sh
wa> /restriction
checking account restriction...
  ──────────────────────────────────────────────────
  status                RESTRICTED
  reason                too many people you messaged blocked or reported you
  type                  BIZ_QUALITY
  ends at               2026-07-28 19:41:12 UTC
  remaining             04:59:22
  ──────────────────────────────────────────────────
  New chats with people you have never messaged are refused with
  error 463 until this expires. Existing conversations keep working,
  and sending more only makes the restriction longer.

  press any key to stop watching
  restricted — 04:59:20 remaining
```

The last line rewrites itself every second — `04:59:20`, `04:59:19`, … — and
stops on its own the moment the restriction lifts. Any key ends the watch; the
restriction is unaffected either way. `/limit` is the same command.

For the numbers without the countdown:

```sh
wa> /restriction --once
```

To check the display without waiting to be restricted, `--demo` counts down a
made-up restriction. Nothing is sent, nothing is asked of the server, and
nothing is left behind when it ends:

```sh
wa> /restriction --demo
  ──────────────────────────────────────────────────
  status                RESTRICTED  (demo — not real)
  reason                too many people you messaged blocked or reported you
  remaining             05:00:00
  ──────────────────────────────────────────────────
  press any key to stop watching
  restricted — 04:59:57 remaining
```

`--demo 90` uses ninety seconds instead of the default five hours, which is
short enough to watch it reach zero and stop on its own.


An account that is fine says so and returns immediately:

```sh
wa> /restriction
checking account restriction...
  ──────────────────────────────────────────────────
  status                not restricted — you can start new chats
  ──────────────────────────────────────────────────
```

You do not have to run it to find out. A refused send checks by itself, and the
shell prints the change as it happens:

```sh
  ACCOUNT RESTRICTED — too many people you messaged blocked or reported you, 04:59:58 remaining
  run /restriction to watch the countdown
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
wa> /group add 120363000000000000@g.us 919634847671@s.whatsapp.net 12345678901@s.whatsapp.net
  added  919634847671@s.whatsapp.net
  failed  12345678901@s.whatsapp.net  — their privacy settings do not allow it (403)  · can be invited instead

# remove participants
wa> /group remove 120363000000000000@g.us 919634847671@s.whatsapp.net
  removed  919634847671@s.whatsapp.net
```

Multiple participants can be listed, separated by spaces. Every participant is
reported on its own line, because the server decides each one separately.

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
group picture updated  id=1705315800
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
  jid                   120363000000000000@g.us
  subject               My Group
  creator               919634847671@s.whatsapp.net
  created               2024-01-15T10:30:00.000Z
  description           Group description here
  ephemeral             off
  only admins send      no
  only admins edit      yes
  join approval         required
  who can add           admins only
  size                  3
  participants          (3)
    112713111982325@lid  (919634847671@s.whatsapp.net)  [admin]
    229063524376784@lid  (12345678901@s.whatsapp.net)
    98765432109@s.whatsapp.net
```

A participant addressed by LID is shown with the phone number behind it when
the server sends one. Two more lines appear only when they apply:

```sh
  suspended             yes — this group has been taken down
  incognito             yes — phone numbers are hidden
```

A suspended group answers every send with a refusal and nothing else, so it is
worth checking here before hunting for the cause elsewhere.

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
  My Group  (3 participants)
    112713111982325@lid  (919634847671@s.whatsapp.net)  [admin]
    229063524376784@lid  (12345678901@s.whatsapp.net)
    98765432109@s.whatsapp.net
```

#### Pending Join Requests

Lists users who have requested to join a group (only visible when `approve_participants` is enabled):

```sh
wa> /group pending 120363000000000000@g.us
  pending (2)
    919634847671@s.whatsapp.net   2026-07-20T09:12:00.000Z
    12345678901@s.whatsapp.net    2026-07-21T14:03:20.000Z
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

Multiple JIDs can be listed, separated by spaces. Anyone the server would not let
through is listed separately with the reason.

<a id="cli-personal-invitations"></a>

#### Personal Invitations

For someone whose privacy settings do not let them be added to a group directly,
`add-invite` adds whoever it can and sends the rest a personal invitation:

```sh
wa> /group add-invite 120363000000000000@g.us 919634847671@s.whatsapp.net 12345678901@s.whatsapp.net
  added  919634847671@s.whatsapp.net
  failed  12345678901@s.whatsapp.net  — their privacy settings do not allow it (403)  · can be invited instead  · invitation sent
```

An invitation that arrives for you shows the command that accepts it:

```sh
  message from      919634847671@s.whatsapp.net
  id                3EB0A1B2C3D4
  type              group invitation  My Group
  accept with       /group accept-invite 120363000000000000@g.us 919634847671@s.whatsapp.net AbCdEfGh 1790000000
```

```sh
# look at the group without joining it
wa> /group preview-invite 120363000000000000@g.us 919634847671@s.whatsapp.net AbCdEfGh 1790000000

# join
wa> /group accept-invite 120363000000000000@g.us 919634847671@s.whatsapp.net AbCdEfGh 1790000000
joined 120363000000000000@g.us

# send one by hand
wa> /group send-invite 120363000000000000@g.us 12345678901@s.whatsapp.net AbCdEfGh 1790000000

# take one back before it is used
wa> /group revoke-invite 120363000000000000@g.us 12345678901@s.whatsapp.net
```

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

# register with a display name — what people who have not saved
# your number see. Quote it if it has spaces.
wa> /reg code 919634847671 --name "Ricardo Trade"

# confirm the code received
wa> /reg confirm 919634847671 123456
registered  session saved to /home/user/.waSession/919634847671/919634847671.json
now run: /connect 919634847671
```

**Registering as Android from the shell** works the same way, but `WA_OS` has to
be set when the shell *starts* — the `wa>` prompt is already inside a running
process, and nothing typed at it can change the environment that process was
launched with:

```sh
WA_OS=android WA_DEVICE=samsung-s24-ultra wa
```
```sh
wa> /reg code 919634847671
no Android token material yet — fetching the WhatsApp APK from Google Play
  ...
  status  sent
wa> /reg confirm 919634847671 123456
```

A `.env` file with `WA_OS=android` in the directory you start from does the same
and saves the typing. Either way it only matters for the command that *creates*
the session: what a session registered as is written into it, and every later
step — the confirmation, a reconnect from a different shell tomorrow — follows
the session rather than the environment.

---

### Connection Commands (in-shell)

```sh
# connect to a number (while already in the shell)
# asks sms or pairing code when both are possible
wa> /connect 919634847671

# force one or the other
wa> /connect 919634847671 sms
wa> /connect 919634847671 pair

# link to an existing account by 8-digit pairing code
wa> /pair 919634847671

# with a code you chose yourself (exactly 8 characters)
wa> /pair 919634847671 MYCODE12

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
| `/star <jid> <msgId> [me]` | Star a message (`me` if you sent it) |
| `/unstar <jid> <msgId> [me]` | Unstar a message |
| `/appstate [collection...]` | Pull pins/archives/mutes/stars from your phone |
| `/appstate --snapshot` | Re-read all app state from scratch |
| `/restriction` | Account restriction status with a live countdown |
| `/restriction --once` | Restriction status without the countdown |
| `/restriction --demo [seconds]` | Fake countdown, to check the display |
| `/limit` | Alias for `/restriction` |
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
| `/reg code <phone> [method] [--name "Name"]` | Request verification code, optionally naming the account |
| `/reg confirm <phone> <code> [--name "Name"]` | Complete registration |
| **Connection** | |
| `/connect <phone> [sms\|pair]` | Connect to WhatsApp — asks which method when unset |
| `/pair <phone> [code]` | Link to an existing account by 8-digit pairing code |
| `/disconnect` | Disconnect current session |
| `/reconnect` | Force reconnection |
| `/session` | Show session info |
| `/help` | Show all commands |
| `/quit` / `/exit` | Disconnect and exit |

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

// `name` is the display name the account registers with — what people who have
// not saved the number see. Omit it and the account has no name until one is
// set later with client.changeName().
const store = createNewStore(phone, { name: 'Ricardo Trade' })
saveStore(store, sessFile)

await requestSmsCode(store, 'sms')   // 'sms' | 'voice' | 'wa_old'
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
const { loadStore, saveStore, verifyCode } = require('whalibmob')

const store  = loadStore(sessFile)
const result = await verifyCode(store, '123456')

if (result.status === 'ok') {
  saveStore(result.store, sessFile)
  console.log('registered')
}
```

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

It happens once. Every later registration reads the file. `WA_NO_APK_DOWNLOAD=1`
turns the fetch off if you would rather it never pulled a hundred megabytes
unasked, and `wa apk-material` below does the same job by hand.

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

It is the route Cobalt takes: an anonymous Play Store token from the Aurora OSS
dispenser, then Google's own `/fdfe` catalogue and delivery endpoints, then the
signed CDN URLs. **No Google account of yours is involved.** Only the density
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
| `sessionDir` | `~/.waSession` | The authentication folder. Each number gets its own subfolder inside it — see [Saving & Restoring Sessions](#saving--restoring-sessions). |
| `autoFixNumber` | `true` | Re-file the session automatically when the server reports the account under a different number. Set `false` to be told instead of fixed — see [The Number WhatsApp Files Your Account Under](#the-number-whatsapp-files-your-account-under). |
| `autoRead` | `true` | Send read receipts for incoming messages. `false` leaves them unread. |
| `pino` | off | Debug logging. `true` turns it on at `debug` level; an object is passed to `pino` as-is. |
| `sentCacheSize` | `2000` | How many sent messages keep their plaintext so a retry receipt naming them can be answered. |
| `maxRetryResends` | `5` | How many times one message may be re-sent in answer to retry receipts before the client gives up. |

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

## Linking to an Existing Account (Pairing Code)

Registering a number over SMS makes whalibmob that number's **own device**. Sometimes that is not what you want — the number is already in use on a phone, or the verification SMS never arrives. For those cases whalibmob can instead connect over a **WebSocket** and link itself to an account that already exists, exactly the way the WhatsApp Web and desktop clients do.

You get an 8-character pairing code, the account owner types it into their phone, and from then on whalibmob is one of the account's linked devices. The whole library works the same afterwards — same client, same methods, same events.

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

A few seconds after the code is accepted you will see `paired`, the server restarts the stream, and `connected` fires on the new connection. From that point on everything else in this document applies unchanged:

```js
await client.sendText('919876543210@s.whatsapp.net', 'sent from a linked device')
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
| `paired` | the owner accepted the code — `{ jid, lid, deviceIndex, platform }` |
| `restart_required` | the server is restarting the stream after pairing (normal; the reconnect is automatic) |
| `pair_device` | the QR path produced reference strings — `{ refs }` |
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
| `<phone>.web.signal.json` | Signal sessions and pre-keys for the linked device |
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
| `client_rejected` | `{ reason, location, message }` | the server refused the client itself, not the session — `405` means the announced version is not accepted. Fires whether the refusal arrives during the handshake or once the stream is open, and the client stops retrying either way. Distinct from `auth_failure`, and there is nothing to re-pair. |

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

Full signatures for each of these are in [Sending Messages](#sending-messages) and [Media Messages](#media-messages); nothing about them changes in companion mode.

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

## Routing Registration Through a Proxy

Registration is the part of the protocol most likely to be refused from a datacenter IP. If you are seeing security blocks or an undeterminable number status, route it through a SOCKS proxy — Tor, or a residential provider.

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

> [!NOTE]
> This covers the registration traffic to `v.whatsapp.net`. The message socket and media transfers are not proxied — if you need those behind a proxy as well, open an issue describing the setup.

If `socks` is not installed, or a proxy is unreachable, you get a message saying so rather than a silent failure. In the rare case the package lives somewhere `require()` cannot find it, `WA_SOCKS_LIB` takes an absolute path to it.

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
│   ├── 919634847671.signal.json         ← Signal sessions
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
| `app_state_sync` | `{ collections, applied }` | An app-state sync finished; see [Reading Changes Made Elsewhere](#reading-changes-made-elsewhere) |
| `app_state_mutation` | `{ collection, index, action, removed }` | An app-state change this library does not model |
| `app_state_key_missing` | `{ collection, keyId }` | App state cannot be read until your phone shares this key |
| `app_state_keys` | `{ keys }` | Your phone shared app-state sync keys; a sync starts automatically |
| `account_restriction` | `{ active, remaining, remainingMs, endsAtDate, enforcementType, reason, source }` | The account was restricted or the restriction was lifted — see [When 463 Means the Account Is Restricted](#when-463-means-the-account-is-restricted) |
| `mex_notification` | `{ opName, data }` | A server push over `w:mex` this library does not model |

`remote: true` on a chat event means the change was made on your phone or another
linked device rather than by this session. Your own calls carry `synced` instead,
saying whether the change reached app state — see
[Modifying Chats](#modifying-chats).
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

Pass `{ verify: true }` to check the download against the message's
`fileEncSha256` before decrypting it. The MAC already proves the plaintext was
not tampered with; this catches a truncated or substituted download earlier, and
names that failure separately from a decryption one.

```js
const bytes = await client.downloadMedia(d, { verify: true })
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
// (also returned as `messageSecret`, which is the name the protocol uses)
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

// with a map image for the bubble — WhatsApp draws a blank card without one
await client.sendLocation('919634847671@s.whatsapp.net', 48.8566, 2.3522, {
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

await client.sendContact('919634847671@s.whatsapp.net', 'Alice Smith', vcard)
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
await client.sendCallLink('919634847671@s.whatsapp.net', 'video', {
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
await client.sendStatus('Hi', { recipients: ['919634847671@s.whatsapp.net'] })
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
const synced = await client.pinChat('919634847671@s.whatsapp.net')
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
await client.archiveChat('919634847671@s.whatsapp.net')
await client.unarchiveChat('919634847671@s.whatsapp.net')
```

### Mute / Unmute a Chat

```js
await client.muteChat('919634847671@s.whatsapp.net', 8 * 60 * 60 * 1000)  // 8 hours
await client.muteChat('919634847671@s.whatsapp.net', 0)                   // until unmuted
await client.unmuteChat('919634847671@s.whatsapp.net')
```

### Mark a Chat Read / Unread

This is the chat's own unread badge. To send read receipts (blue ticks) for
particular messages, use `markRead()` instead.

```js
await client.markChatRead('919634847671@s.whatsapp.net')
await client.markChatUnread('919634847671@s.whatsapp.net')
```

### Pin / Unpin a Chat

```js
await client.pinChat('919634847671@s.whatsapp.net')
await client.unpinChat('919634847671@s.whatsapp.net')
```

### Star / Unstar a Message

The third argument says whether the message being starred is one you sent. It is
part of how the star is filed, so getting it wrong stars a different message.

```js
await client.starMessage('MSGID123', '919634847671@s.whatsapp.net', true)   // yours
await client.unstarMessage('MSGID123', '919634847671@s.whatsapp.net', false) // theirs
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

// your own, asked the same way
console.log(await client.queryOwnAbout())
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

## Privacy

### Block / Unblock User

```js
// both return the updated block list, and throw if the server refuses
const blocked = await client.blockContact('919634847671@s.whatsapp.net')
await client.unblockContact('919634847671@s.whatsapp.net')

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

Each of these returns one result per participant — the ones that went through
and the ones that did not. The server decides every participant separately, so a
call that half worked tells you which half and why.

```js
const groupJid = '120363000000000000@g.us'

const results = await client.addGroupParticipants(groupJid, [
  '919634847671@s.whatsapp.net',
  '12345678901@s.whatsapp.net'
])

for (const r of results) {
  if (r.ok) console.log('added', r.jid)
  else      console.log('failed', r.jid, r.status, r.needsInvite ? '(invite instead)' : '')
}

await client.removeGroupParticipants(groupJid,  ['919634847671@s.whatsapp.net'])
await client.promoteGroupParticipants(groupJid, ['919634847671@s.whatsapp.net'])
await client.demoteGroupParticipants(groupJid,  ['919634847671@s.whatsapp.net'])
```

Each result looks like this:

```js
{
  jid:         '919634847671@s.whatsapp.net',
  status:      '403',        // '200' when the action went through
  error:       403,          // null on success
  ok:          false,        // getter: error == null
  admin:       null,         // 'admin' | 'superadmin' | null
  phoneNumber: '919634847671@s.whatsapp.net',
  lid:         '112713111982325@lid',   // when the server told us one
  displayName: null,
  // Only on a refused add: the code a personal invitation is built from.
  addRequest:  { code: 'AbCdEfGh', expiration: 1790000000 },
  needsInvite: true          // getter: true when addRequest holds a code
}
```

The common error codes are `403` (their privacy settings do not allow it),
`404` (not on WhatsApp), `408` (not a member), `409` (already a member) and
`401` (you are not allowed to do this).

> [!TIP]
> A result object stringifies to its JID, so `results.join(', ')` and
> `String(results[0])` read exactly as they did when these methods returned a
> plain list of JID strings.

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
console.log(meta.subject, meta.participants.length + ' members')
```

```js
{
  jid:             '120363000000000000@g.us',
  subject:         'My Group',
  size:            57,            // the server's own count
  creation:        1705315800,
  creator:         '919634847671@s.whatsapp.net',
  subjectTime:     1705315900,
  subjectBy:       '919634847671@s.whatsapp.net',
  description:     'Group description here',
  descriptionId:   'DESC1',       // echoed back as `prev` on the next edit
  descriptionBy:   '919634847671@s.whatsapp.net',
  descriptionByPn: '919634847671@s.whatsapp.net',
  descriptionTime: 1705315950,
  ephemeral:       86400,         // 0 when disappearing messages are off
  onlyAdminsSend:  false,
  onlyAdminsEdit:  false,
  joinApprovalMode: true,         // new members need an admin's approval
  memberAddMode:   'admin_add',   // 'admin_add' | 'all_member_add' | null
  isCommunity:         false,
  isCommunityAnnounce: false,
  defaultMembershipApprovalMode: null,   // communities only
  linkedParent:    null,          // the community this group belongs to
  isIncognito:     false,         // members' phone numbers hidden from each other
  isSuspended:     false,         // the group has been taken down
  notify:          'My Group',
  creatorPn:       '919634847671@s.whatsapp.net',
  creatorUsername: null,
  creatorCountry:  'IN',
  subjectByPn:     '919634847671@s.whatsapp.net',
  subjectByUsername: null,
  participantVersion: 'PV1',      // bumped when the member list changes
  announceVersion:    'AV1',      // bumped when the announce flag changes
  addressingMode:  'lid',         // 'lid' | 'pn'
  participants: [
    {
      jid:          '112713111982325@lid',
      role:         'admin',      // 'admin' | 'superadmin' | 'member'
      isAdmin:      true,
      isSuperAdmin: false,
      phoneNumber:  '919634847671@s.whatsapp.net',
      lid:          '112713111982325@lid',
      displayName:  null,
      username:     null
    }
  ]
}
```

Both addresses are filled in on every participant whichever way round the server
named them, so you never have to resolve a LID by hand to know who somebody is.

### Get Request Join List

```js
const pending = await client.queryGroupPendingParticipants('120363000000000000@g.us')

for (const r of pending) {
  console.log(r.jid, 'asked at', new Date(r.requestedAt * 1000).toISOString())
}
```

Each entry is `{ jid, requestedAt }` — `requestedAt` is unix seconds, or `0` when
the server did not say. Like the participant results, an entry stringifies to its
JID.

### Approve / Reject Request Join

The second parameter is a boolean: `true` to approve, `false` to reject. The
return value is the same list of per-participant results the add/remove calls
give you.

```js
// approve join requests
const done = await client.approveGroupParticipants('120363000000000000@g.us', true, [
  '919634847671@s.whatsapp.net'
])
console.log(done.filter(r => !r.ok))   // whoever could not be let in, and why

// reject join requests
await client.approveGroupParticipants('120363000000000000@g.us', false, [
  '919634847671@s.whatsapp.net'
])
```

### Personal Invitations

An invite link is public — anyone holding it can join. A personal invitation is
the other kind: minted for one named person, and the only way into a group for
somebody whose privacy settings stop them from being added outright.

The whole flow starts with a refused add. When the server turns a participant
away for that reason it hands back a code, which travels to them as a message
they can tap.

```js
const groupJid = '120363000000000000@g.us'

// add whoever can be added, and invite whoever cannot — in one call
const results = await client.addGroupParticipantsOrInvite(groupJid, [
  '919634847671@s.whatsapp.net',
  '12345678901@s.whatsapp.net'
])

for (const r of results) {
  if (r.ok)              console.log('added', r.jid)
  else if (r.invited)    console.log('invited', r.jid)
  else                   console.log('failed', r.jid, r.status, r.inviteError || '')
}
```

Or drive it yourself, if you want to decide who gets an invitation:

```js
const results = await client.addGroupParticipants(groupJid, [
  '919634847671@s.whatsapp.net'
])

for (const r of results.filter(x => x.needsInvite)) {
  await client.sendGroupInvite(r.jid, groupJid,
    r.addRequest.code, r.addRequest.expiration,
    { caption: 'Come join us' })
}
```

`sendGroupInvite(to, groupJid, code, expiration, opts)` accepts
`{ groupName, caption, jpegThumbnail, isCommunity, id, contextInfo }`. The group
name is filled in from the group's own metadata when you do not supply one.

On the receiving side, an invitation arrives as an ordinary `message` event whose
`decoded.type` is `'groupInvite'`:

```js
client.on('message', async (msg) => {
  const d = msg.decoded
  if (!d || d.type !== 'groupInvite') return

  // look before you leap — this does not join anything
  const info = await client.queryGroupInviteMessageInfo(
    d.groupJid, msg.participant || msg.from, d.inviteCode, d.inviteExpiration)
  console.log(info.subject, info.size + ' members')

  // and accept it
  const jid = await client.acceptGroupInviteMessage(
    d.groupJid, msg.participant || msg.from, d.inviteCode, d.inviteExpiration)
  console.log('joined', jid)
})
```

A decoded invitation carries `{ groupJid, inviteCode, inviteExpiration,
groupName, jpegThumbnail, caption, isCommunity }`.

To withdraw an invitation you sent before it is used:

```js
await client.revokeGroupInviteForParticipant(groupJid, '919634847671@s.whatsapp.net')
```

An expired or already-spent invitation throws rather than resolving to nothing,
so the two cases are easy to tell apart.

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

### Version & Token Overrides

| Variable | Description |
|---|---|
| `WA_VERSION` | Pin the WhatsApp version (e.g. `2.24.13.80`). Skips the live store fetch, and is announced on connect **in place of the version stored in the session**. The CLI also reads it from a `.env` file in the working directory, so one left there is announced by every connect from that directory — which is how a working session starts being refused with [405](#when-the-server-answers-405-on-connect). Pin it deliberately, unset it when done. |
| `WA_STATIC_TOKEN` | Override the static token used in registration token computation. iOS only — Android has no static token. Overrides both the consumer and the Business constant. |
| `WA_BUSINESS` | Register and connect as WhatsApp Business (`1`/`true`/`yes`/`on`). Decides the announced platform, the User-Agent, which APK the token material comes from, and the `vname` certificate. See [Registering a WhatsApp Business account](#registering-a-whatsapp-business-account). |

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
| 2 | the version stored in the session file — what the number was registered with |

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

## License

MIT
