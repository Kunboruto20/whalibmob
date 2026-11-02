# CLI — Getting Started

[← Back to the README](../README.md) · [Documentation index](../README.md#documentation)

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

# via flash call — WhatsApp rings the number and hangs up (Android only)
WA_OS=android wa registration --request-code 919634847671 --method flash

# via email — WhatsApp sends a 6-digit code to the email address linked to the number
wa registration --request-code 919634847671 --method email_otp
```

**Flash call** sends no code anywhere. WhatsApp rings the number from a
one-time number and drops the call before it can be answered, and the
verification code *is* that number — its last 6 digits. The official Android app
reads them out of the call log; here the person holding the phone reads the
missed call instead and types them:

```sh
# phone shows a missed call from +40 21 555 123456
wa registration --register 919634847671 --code 123456
```

Pasting the whole number works too — only its last six digits are sent. Do not
answer the call; it hangs up on its own, and answering it does not verify
anything.

Three things to know before choosing it:

- **Android only.** iOS has no API for reading an incoming call's number, so
  WhatsApp never offers flash there. Asking for it as iOS is refused before any
  request goes out, so the number spends no attempt learning that.
- **The server decides.** Flash is not offered for every number or country. When
  it declines, the request falls back to SMS automatically and the session
  records that, so the SMS code is confirmed as an SMS code rather than being
  trimmed like a caller ID.
- **The caller ID has to be visible.** A carrier that withholds the calling
  number leaves nothing to read.

Set `WA_FLASH_CODE_LEN` if a number's server expects a different length than the
six digits the app defaults to.

**Email OTP** sends a 6-digit verification code to the email address that the
phone number's WhatsApp account has associated. This method only works when the
number already has an email linked to its WhatsApp account — if there is no email
on file, the server returns an error and you should fall back to `sms` or `voice`.

```sh
# request via email
wa registration --request-code 919634847671 --method email_otp

# then confirm with the 6-digit code WhatsApp emailed
wa registration --register 919634847671 --code 123456
```

Two things to know before choosing it:

- **Email must be linked.** If the number has never had an email associated in
  WhatsApp Settings → Account → Email address, the server rejects the request.
  Use `sms` or `voice` instead.
- **Falls back to SMS.** When `email_otp` fails (no email on file or email
  delivery issue), whalibmob automatically retries with `sms` so the attempt is
  not wasted.

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
else to prepare — see [what it does behind that one command](registration.md#registering-as-android).

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
repeating it — see [Device Quick Start](internals.md#device-quick-start). `--debug` prints
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
[Saving & Restoring Sessions](sessions.md#saving--restoring-sessions).

Options may come before the command as well as after it, and `--name=value` is the
same as `--name value`: `wa --session /data/my-sessions connect 919634847671`.

**A registered number keeps a record of its messages.** The CLI writes what the
number sends and receives into the session folder, from registration on (for a
number registered earlier, from the first connect with the record on), so that
a companion linked later (WhatsApp Web, see
[Companion Commands](cli-commands.md#companion-commands-approving-whatsapp-web)) can be handed
it as chat history. Pass `--no-message-store` to keep none:

```sh
wa connect 919634847671 --no-message-store
```

Without a record there is nothing to hand over, and `/link-code` says so. The
library does the opposite and keeps nothing unless asked
([`messageStore`](linking.md#library-api-for-the-chat-history)).

If the record's files are damaged, the store refuses to open
(`PRIMARY_MESSAGE_STORE_LOG_CORRUPT` or `PRIMARY_MESSAGE_STORE_SNAPSHOT_CORRUPT`)
and messaging goes on without it. `--reset-message-store` starts it again: the
damaged files are kept, renamed to `<file>.corrupt-<time>`, and the record starts
from now, counted as switched on then. It cannot be combined with
`--no-message-store`.

```sh
wa connect 919634847671 --reset-message-store
```

One number's record is open in one program at a time. A second `wa` on the same
session folder, here or in another process, is refused it
(`PRIMARY_MESSAGE_STORE_BUSY`) and runs without it; the error names the holder
(pid, host, since when). Close the other one, or wait until it has finished,
then `/reconnect`.

A `wa` that crashed where its end cannot be proven from here (it ran on another
machine or in another container, its pid has since gone to another program, or
it died before writing its name into the lock) leaves the record refused for
good. `--unlock-message-store` is the way out: before the record opens, it shows
who holds the lock and asks `[y/N]`; Enter is no, and only `y` breaks it. Answer
`y` only when no other `wa` is using the number. A `wa` that was in fact still
running stops keeping messages at its next write
(`PRIMARY_MESSAGE_STORE_LOST`), and what it kept stays.

```sh
wa connect 919634847671 --unlock-message-store
the message store of +919634847671 is locked by pid 4242 on old-box, since 2026-11-02 15:31
  Break it only if no other wa is using this number: one that stopped, or ran on a machine or in a container that no longer runs it.
  A wa that is in fact still running stops keeping messages at its next write; what it already kept stays in the store.
break the lock held by pid 4242 on old-box?  [y/N] y
broke the message store lock held by pid 4242 on old-box
```

It acts once, on the first number the run opens a record for: `wa connect`,
the shell's `/connect` when `wa` was started with it, or a registration
(`/reg confirm`, `wa registration --register` in a terminal). `wa listen` cannot
ask: with the flag and a lock held, it names the holder and exits instead.
Re-registering a number sets its earlier record aside under the same lock, so a
record another `wa` holds is not moved: the warning names the holder.

> [!IMPORTANT]
> **If this is refused with `405`, do not re-register the number.** The account
> is fine; the server declined the version the connect announced. Check for a
> `WA_VERSION` in your shell or in a `.env` file in the directory you ran the
> command from — it overrides the version the session registered with, and a
> stale one left there refuses every connect from that directory. See
> [When the server answers 405 on connect](internals.md#when-the-server-answers-405-on-connect).

### CLI Pairing Code

If the number is already in use on a phone, or the verification SMS never arrives, link to the existing account instead.

`wa connect` works out which of the two a number is set up for by reading its session files, and says which one it chose:

```
connecting as companion (pairing code)...
```

A number can hold both — registered over SMS as its own device, and linked as a companion to another account. When it holds both, the one used most recently wins. A half-finished registration does not count as a session either way. When there is nothing to connect with, it says so and names the two commands that would create one, rather than picking a side.

Force either one:

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


---

[← Back to the README](../README.md) · [Documentation index](../README.md#documentation)
