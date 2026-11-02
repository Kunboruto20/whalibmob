# Accounts — Number, Consent & Registration Blocks

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

- **A clean IP does the most.** A residential or mobile IP, one that is not on a blocklist, clears Wall 2 more than anything else. Datacenter/VPS IPs are the single most common cause of a `blocked` reply across many numbers. Route through a good residential/mobile proxy (see [Routing Traffic Through a Proxy](proxy.md#routing-traffic-through-a-proxy)), and do not push dozens of numbers through one address.
- **Clean, unused numbers.** A number that has never been flagged passes with empty attestation. A number that already carries the "unofficial app" screen has been marked, and is usually not worth fighting — a fresh clean number is the better use of time.
- **The Android profile** (`WA_OS=android`) carries more of the fields the server wants than the iOS one, and is the first thing to try when a number is refused.
- **Real attestation** answers Wall 1 directly. The Frida scripts in [`frida/`](https://github.com/Kunboruto20/whalibmob/tree/main/frida) mint a genuine Play Integrity / App Attest token **from a real handset with the Play-Store app** and fold it in — this is the honest way to answer "prove you're the official app," because it *is* a real device proving it. It needs a rooted Android or jailbroken iOS phone (see [Device Attestation with Frida](registration.md#device-attestation-with-frida-optional)), so it is not always practical; clean numbers do not need it, and no software-only trick substitutes for it.

### The honest bottom line

This is a moving target, not a solved problem. WhatsApp changes these checks continually — the mods went from surviving *months* to surviving *hours* under the same pressure — and whalibmob is kept in step release by release, but nothing here is permanent and there is no magic bypass. Registration on the mobile protocol is a real capability that works, most reliably on **clean numbers from clean IPs**; the further you get from that, the harder the anti-abuse system pushes back, by design.


---

[← Back to the README](../README.md) · [Documentation index](../README.md#documentation)
