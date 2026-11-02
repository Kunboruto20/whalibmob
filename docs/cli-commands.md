# CLI — Interactive Shell Commands

[← Back to the README](../README.md) · [Documentation index](../README.md#documentation)

---

## CLI — Interactive Shell Commands

After running `wa connect <phone>`, every feature of the library is available as a `/command`. Type `/help` at any time to see all commands.

> [!NOTE]
> JIDs can be written as plain phone numbers (e.g. `919634847671`) — the shell automatically appends `@s.whatsapp.net`. For groups, use the full `@g.us` JID.

### Messaging Commands

#### Send Text

```sh
wa> /send 919634847671 Hello, how are you?
sent  3EB0ABCDEF123456

# to a group
wa> /send 120363000000000000@g.us Hello everyone!
```

#### Send Image

```sh
wa> /image 919634847671 ./photo.jpg
wa> /image 919634847671 ./photo.jpg Look at this!
```

The second argument is the file path. The optional third argument is the caption.

#### Send Video

```sh
wa> /video 919634847671 ./clip.mp4
wa> /video 919634847671 ./clip.mp4 Watch this
```

#### Send Audio

Sends the file as a regular audio attachment:

```sh
wa> /audio 919634847671 ./song.mp3
```

#### Send Voice Note

Sends the file as a push-to-talk voice note with waveform:

```sh
wa> /ptt 919634847671 ./voice.ogg
```

#### Send Document

```sh
wa> /doc 919634847671 ./report.pdf
wa> /doc 919634847671 ./report.pdf "Q1 Report.pdf"
```

The optional third argument overrides the displayed filename.

#### Send Sticker

The file must be in WebP format:

```sh
wa> /sticker 919634847671 ./sticker.webp
```

#### Send Poll (CLI)

Separate the question from the options using `|`. At least two options are required. Optionally append `selectable=N` to limit how many options a voter may choose (0 = any):

```sh
# single-choice poll (selectable=1)
wa> /poll 919634847671 Best language? | JavaScript | Python | Rust | selectable=1

# unlimited-choice poll (default)
wa> /poll 120363000000000000@g.us Pick your favourites | Red | Green | Blue
```

#### React to a Message

```sh
wa> /react 919634847671 3EB0ABCDEF123456 👍

# remove a reaction — pass a space or empty string
wa> /react 919634847671 3EB0ABCDEF123456 " "
```

The message ID is shown in the incoming message display as `id`.

#### Edit a Message

> [!NOTE]
> Editing is only possible within 15 minutes of the original send.

```sh
wa> /edit 919634847671 3EB0ABCDEF123456 Corrected text here
```

#### Delete a Message

```sh
# delete for yourself only
wa> /delete 919634847671 3EB0ABCDEF123456

# delete for everyone (revoke)
wa> /delete 919634847671 3EB0ABCDEF123456 all
```

#### Post a Status / Story

Posts a text Status visible to your contacts:

```sh
wa> /status Good morning everyone!
```

#### Forward a Message

Sends a message with the forwarded flag set:

```sh
wa> /forward 919634847671 This message was forwarded
```

#### Reply to a Message (CLI)

Quote and reply to a specific message. You need the message ID (shown as `id:` in the receive log) and the sender's JID.

```sh
# DM — senderJid is the same as the chat JID
wa> /reply 919634847671 3EB0XXXXXXXX 919634847671 Got it, thanks!

# Group — senderJid is the member who sent the original message
wa> /reply 120363000000000000@g.us 3EB0XXXXXXXX 919634847671 Agreed!
```

The message ID is printed when a message arrives:
```
  id                    3EB0C5BA7XXXXXXXX
```

#### Send Location (CLI)

Send a GPS location pin. Latitude and longitude are required; name and address (separated by `|`) are optional:

```sh
# lat/lon only
wa> /location 919634847671 48.8566 2.3522

# with name
wa> /location 919634847671 48.8566 2.3522 Eiffel Tower

# with name and address (separate with |)
wa> /location 919634847671 48.8566 2.3522 Eiffel Tower | Champ de Mars, Paris

# to a group
wa> /location 120363000000000000@g.us 51.5074 -0.1278 London
```

#### Send Contact / vCard (CLI)

Send a contact card. The vCard string must follow the vCard v3 format. Wrap it in quotes in the shell:

```sh
wa> /vcard 919634847671 "Alice Smith" "BEGIN:VCARD\nVERSION:3.0\nFN:Alice Smith\nTEL;TYPE=CELL:+919634847671\nEND:VCARD"
```

For multi-line vCards it is easiest to store the string in a shell variable:

```sh
VCARD="BEGIN:VCARD
VERSION:3.0
FN:Alice Smith
TEL;TYPE=CELL:+919634847671
EMAIL:alice@example.com
END:VCARD"

wa> /vcard 919634847671 "Alice Smith" "$VCARD"
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
wa> /typing 919634847671

# show "recording audio…" in a chat
wa> /recording 919634847671

# stop the indicator
wa> /stop 919634847671
```

#### Subscribe to a Contact's Presence

Subscribes to online/offline events for a contact. The shell will print presence updates as they arrive:

```sh
wa> /subscribe 919634847671
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

#### CLI Account Email (recovery address)

An account can carry an email address, used to get back in if the number is lost
or the two-step PIN is forgotten.

> [!NOTE]
> This is **not** a way to receive the registration code. There is no email
> delivery at the code-request step — register the number first (`--method sms`,
> `voice`, `wa_old` or `flash`), connect, and only then bind an email. It works
> on a **primary** account; a companion (QR/pairing) link cannot use it.

Bind the address, ask for a code, read it from your inbox, submit it, confirm:

```sh
wa> /email set name@example.com
  email bound: name@example.com
  next:  /email request    then  /email verify <code>

wa> /email request
  code sent — check the inbox, then:  /email verify <code>

wa> /email verify 123456
  code accepted for name@example.com
  finishing:  /email confirm

wa> /email confirm
  email confirmed

wa> /email status
  email      name@example.com
  verified   yes
  confirmed  yes
```

`/email request` takes an optional language and country (e.g. `/email request pt BR`)
that only pick which language the email is written in — the code is the same.

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
wa> /picture 919634847671
  https://mmg.whatsapp.net/v/...

wa> /picture 120363000000000000@g.us
  https://mmg.whatsapp.net/v/...
```

#### Get Contact About Text

Fetches the bio / about text for a contact:

```sh
wa> /contact about 919634847671
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
wa> /pin 919634847671
pinned  (this session only — no app state key)
```

#### Mark Read / Unread

```sh
wa> /read   919634847671
wa> /unread 919634847671
```

#### Mute / Unmute

```sh
# mute for 60 minutes
wa> /mute 919634847671 60

# mute indefinitely
wa> /mute 919634847671

# unmute
wa> /unmute 919634847671
```

#### Pin / Unpin

```sh
wa> /pin   919634847671
wa> /unpin 919634847671
```

#### Archive / Unarchive

```sh
wa> /archive   919634847671
wa> /unarchive 919634847671
```

#### Star / Unstar a Message (CLI)

Add `me` when the message is one you sent — it is part of how the star is filed,
so leaving it off on your own message stars the wrong thing.

```sh
wa> /star   919634847671 3EB0ABCDEF123456 me
wa> /unstar 919634847671 3EB0ABCDEF123456
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
wa> /ephemeral 919634847671 86400

# set 1-week timer on a group
wa> /ephemeral 120363000000000000@g.us 604800

# turn off
wa> /ephemeral 919634847671 0
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
wa> /block   919634847671
blocked  919634847671@s.whatsapp.net

wa> /unblock 919634847671
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
wa> /group create MyGroup 919634847671 12345678901
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
wa> /group add 120363000000000000@g.us 919634847671 12345678901
  added  919634847671@s.whatsapp.net
  failed  12345678901@s.whatsapp.net  — their privacy settings do not allow it (403)  · can be invited instead

# remove participants
wa> /group remove 120363000000000000@g.us 919634847671
  removed  919634847671@s.whatsapp.net
```

Multiple participants can be listed, separated by spaces. Every participant is
reported on its own line, because the server decides each one separately.

#### Promote / Demote Admins

```sh
# promote to admin
wa> /group promote 120363000000000000@g.us 919634847671

# demote from admin
wa> /group demote 120363000000000000@g.us 919634847671
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
wa> /group approve 120363000000000000@g.us 919634847671
  approved  919634847671@s.whatsapp.net

# reject one or more pending members
wa> /group reject 120363000000000000@g.us 919634847671
  rejected  919634847671@s.whatsapp.net
```

Multiple JIDs can be listed, separated by spaces. Anyone the server would not let
through is listed separately with the reason.

<a id="cli-personal-invitations"></a>

#### Personal Invitations

For someone whose privacy settings do not let them be added to a group directly,
`add-invite` adds whoever it can and sends the rest a personal invitation:

```sh
wa> /group add-invite 120363000000000000@g.us 919634847671 12345678901
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
wa> /group preview-invite 120363000000000000@g.us 919634847671 AbCdEfGh 1790000000

# join
wa> /group accept-invite 120363000000000000@g.us 919634847671 AbCdEfGh 1790000000
joined 120363000000000000@g.us

# send one by hand
wa> /group send-invite 120363000000000000@g.us 12345678901 AbCdEfGh 1790000000

# take one back before it is used
wa> /group revoke-invite 120363000000000000@g.us 12345678901
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
wa> /biz 919634847671
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
# picks sms or pairing from the session files on disk
wa> /connect 919634847671

# force one or the other
wa> /connect 919634847671 sms
wa> /connect 919634847671 pair

# link to an existing account by 8-digit pairing code
wa> /pair 919634847671

# or link by scanning a QR drawn in the terminal
wa> /qrcode 919634847671

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

### Companion Commands (Approving WhatsApp Web)

A number registered through whalibmob is the account's primary device. These commands let it approve **WhatsApp Web** as a companion and hand it the chat history the program has kept for the number. They need the number connected as the primary (`wa connect <phone>`, with `--sms` if the number also holds a companion session); a companion session gets `PRIMARY_LINK_PRIMARY_REQUIRED`.

The whole flow, every command typed as shown:

```sh
wa connect 447949738354 --session ~/whalibmob_auth
```

1. On WhatsApp Web choose **Link with phone number** and enter `447949738354`. Web shows an 8-character code, good for about three minutes. The shell prints `link request   companion c0ffee01   code window 2:50   id a1a1a1a1`.
2. `wa> /link-code ABCD-EFGH` — the dash, the case and a space between the halves do not matter.
3. With more than one browser asking, nothing is approved and the shell lists them. Repeat with the number or the id of yours: `/link-code ABCD-EFGH 2`.
4. If the history is known to be partial, the shell prints the coverage and asks `[y/N]`; Enter is no.
5. Success says `history handed to the companion: 12 chats, 340 messages, 20.0 KB (sent inline), first link`, then where capture began and, for a partial history, what was dropped and lost. A history over 64 KiB deflated goes up as a blob first, announced as `uploading history (2.0 MB)... this can take a few minutes`; wait for it. Check it:

```
wa +447949738354> /linked-devices
linked devices  +447949738354
  #0   this phone (primary)
  #12  companion   key index 3   linked 2026-11-02 15:31 by code   binding unconfirmed   history delivered (12 chats, 340 msgs)
```

Each step, with its output in full, is in [Linking WhatsApp Web from the CLI](linking.md#linking-whatsapp-web-from-the-cli).

| Command | What it does |
|---|---|
| `/link-invitations` | List the pairing requests waiting, one line per browser, newest first. |
| `/link-code CODE [n\|id]` | Approve Web's 8-character code, then send the chats. `n\|id` picks the request when more than one browser is asking: its number in the list, or 6 or more characters of its id. Order: readiness check, choice of request, the `[y/N]` when the history is partial, the approval, the history. A refusal at any point before the approval approves nothing. |
| `/link-qr PAYLOAD` | The same for a QR: `PAYLOAD` is the text the QR encodes, or its `https://wa.me/settings/linked_devices#...` link. |
| `/link-status` | Where the link and the handover stand: the phase, the binding, the bootstrap, the companions, and the next step. |
| `/linked-devices` | This number's companions: slot, key index, when and how (by code or by QR) it was linked, whether the binding is confirmed, and the chats and messages of the history it was handed. |
| `/link-bootstrap [--resume] [--resend-uncertain]` | Send the chats to an approved companion, or continue a handover that stopped. `--resume` continues after the last accepted step (harmless when there is none). `--resend-uncertain` also sends once more a step whose reply never came; on its own it counts as a resume. There is no blind resend. |
| `/link-confirm FILE\|JSON` | Confirm an approval with the companion's public proof JSON: a file, or the JSON itself on the line. |
| `/link-retire` | Clear an approval whose companion never appeared or has been logged out. Works once the approval is 5 minutes old and the companion is gone from the device list. |
| `/link-unlock` | Show who holds the link journal's lock and ask `[y/N]` before breaking it; Enter is no. For a lock left by a program that is gone, which cannot be proven gone from here (another machine or container, an older lock format). |

**What the history covers.** Only what the store kept since it began: since registration for a number registered here, or since the store was first switched on for any other. It keeps 100 messages per chat and 20 000 in all, oldest first out. Losses are reported, and the shell asks `[y/N]` unless the store has kept everything since registration and dropped nothing.

**What is never transferred.** The content of revoked, expired and view-once messages, and reactions and poll votes (they are skipped, so they do not appear on the new device). A message of a type the library does not decode is kept as received and handed over unchanged.

**Limits.** A second companion while one is still linked is not supported; the shell refuses up front. The binding stays `unconfirmed` unless the companion's public proof JSON is reconciled with `/link-confirm`; standard WhatsApp Web is not known to offer such a proof. The reasons are in [What the History Covers](linking.md#what-the-history-covers).

**Linking again.** Log out on Web (Menu → Log out); wait until `/linked-devices` no longer lists it; run `/link-retire` (5 minutes after the approval, if a hold is left over); run `/link-code` again. Web gets the history again, with the same app-state key. See [Linking Again](linking.md#linking-again).

**When it stops part-way.** `/link-status` says what to do. `/link-bootstrap --resume` continues; `/link-bootstrap --resume --resend-uncertain` resends only a step whose reply never came; a step WhatsApp refused is never resent. `/link-unlock` breaks the lock on the link journal only when you run it: a lock left by a dead process on the same machine is recovered without it, and any other holder is reported as busy, with who holds it. See [When Something Stops Part-Way](linking.md#when-something-stops-part-way).

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
| **Companions (primary only)** | |
| `/link-invitations` | List the pairing requests waiting from WhatsApp Web |
| `/link-code CODE [n\|id]` | Approve Web's 8-character code, then send the chats |
| `/link-qr PAYLOAD` | Approve Web's QR (its text or `wa.me` link), then send the chats |
| `/link-status` | Where the link and the chat handover stand |
| `/linked-devices` | This number's companions |
| `/link-bootstrap [--resume] [--resend-uncertain]` | Send the chats, or continue a handover that stopped |
| `/link-confirm FILE\|JSON` | Confirm an approval with the companion's public proof |
| `/link-retire` | Clear an approval whose companion never appeared |
| `/link-unlock` | Break a link-journal lock left by a program that is gone |
| **Connection** | |
| `/connect <phone> [sms\|pair]` | Connect to WhatsApp — picks the method from the session files when unset |
| `/pair <phone> [code]` | Link to an existing account by 8-digit pairing code |
| `/qrcode <phone>` | Link to an existing account by scanning a QR drawn in the terminal |
| `/disconnect` | Disconnect current session |
| `/reconnect` | Force reconnection |
| `/session` | Show session info |
| `/help` | Show all commands |
| `/quit` / `/exit` | Disconnect and exit |

---


---

[← Back to the README](../README.md) · [Documentation index](../README.md#documentation)
