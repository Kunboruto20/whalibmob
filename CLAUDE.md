# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A from-scratch WhatsApp client library in plain CommonJS Node — no transpiler, no
framework. It speaks WhatsApp's real protocol: Noise handshake, WhatsApp's binary
node dictionary, Signal Protocol end-to-end encryption. It talks to the **mobile**
endpoint (`g.whatsapp.net` over raw TLS) as a *primary* device registered over SMS,
and to the **web** endpoint (`web.whatsapp.com` over a WebSocket) as a *companion*
linked with a pairing code. `lib/Client.js` (~6.5k lines) is the whole client.

## Commands

There is **no build, no lint config, no test suite, and no `scripts` in
package.json** — `npm test` fails. Do not invent commands for them, and do not add
a test framework unless asked.

```sh
npm install                       # deps are required to load lib/Client.js

node --check lib/Client.js        # syntax check — the closest thing to a linter
node -e "require('./index.js')"   # catches broken requires and top-level errors

node cli.js help                  # run the CLI from the checkout (installed name: wa)
node cli.js connect <phone>       # SMS-registered primary session
node cli.js pair <phone>          # companion session via 8-digit pairing code
node cli.js listen <phone>        # connect and print incoming traffic only
node cli.js registration --request-code <phone>
node cli.js registration --register <phone> --code 123456

node cli.js connect <phone> --debug         # print every stanza sent and received
node cli.js connect <phone> --trace-bytes   # also dump raw encoded frame bytes
node cli.js connect <phone> --session <dir> # default: ~/.waSession
```

Inside the interactive shell, `/help` lists every command. Verifying protocol work
requires a real registered number — most changes cannot be tested locally, which is
why the wire-level checks below matter.

## Architecture

Layers, bottom up. Each one only knows about the one below it:

- **`lib/noise.js`** — `NoiseSocket`: TCP+TLS or WebSocket, the Noise XX handshake,
  frame encryption. Emits `'node'` for each decoded stanza; `sendNode(node)` is the
  only way out. Mobile and web differ by a prologue byte and the ClientPayload.
- **`lib/BinaryNode.js` + `lib/tokens.js`** — the wire codec. `BinaryNode` is
  `{description, attrs, content}`. `tokens.js` holds WhatsApp's string dictionary;
  its indices must stay aligned with the server's or every tag decodes as something
  else.
- **`lib/Client.js`** — `WhalibmobClient extends EventEmitter`. Connection lifecycle
  (`connect` / `connectWeb` / `requestPairingCode`), the stanza router (`_onNode`),
  the IQ request/response map (`_sendIq`), and the entire public API surface.
  `this._mode` is `'mobile'` or `'web'` and gates behaviour throughout.
- **Feature modules** — `messages/MessageSender.js` (message building and fan-out),
  `signal/` (libsignal port, sender keys, session store), `DeviceManager.js` (device
  lists, JID↔object conversion, LID↔PN mapping), `appstate/` (syncd patches, LTHash),
  `MediaService.js`, `HistorySyncHandler.js`, `Registration.js` (HTTPS, not the
  socket), `image/` (dependency-free JPEG/PNG/GIF/BMP decode for thumbnails).
- **`index.js`** — flat re-export of everything public.
- **`cli.js`** — a self-contained shell over the library. It also monkey-patches
  `NoiseSocket.prototype.sendNode`/`emit` for the `--debug` stanza trace.

Two session shapes, kept strictly separate on disk: `Store.js` writes
`<phone>.json` for a primary, `WebStore.js` writes `<phone>.web*.json` for a
companion. The same number can hold both. A primary has no history sync and no
`device-identity` record; a companion has both. Media endpoints also differ by mode
(a companion uploads stickers to `/mms/image`).

`frida/` holds optional on-device Frida scripts that produce real Play Integrity /
App Attest tokens for registration. Nothing in `lib/` depends on it.

## Protocol work: how things actually fail here

The server almost never argues. A stanza it does not understand is **accepted,
answered `<iq type="result"/>` or not answered at all, and dropped** — a malformed
request looks exactly like a successful one. Several of the comments in
`lib/Client.js` exist because of exactly this. Consequences for any change:

- **The `--debug` trace prints the node before it is encoded**, so two spellings
  that differ on the wire look identical on screen (`to="s.whatsapp.net"` as a
  string vs as a JID). Use `--trace-bytes`, or encode the node with
  `encodeNode()` and compare hex.
- **Ground-truth check**: `npm pack @whiskeysockets/baileys` and
  `git clone https://github.com/tulir/whatsmeow` into a scratch dir, then encode the
  same stanza with their encoder and this one and diff the bytes. That is the only
  reliable way to confirm "we send what they send".
- **`_sendIq` resolves `null` on timeout and hands back error stanzas unread.**
  Every caller must check both, or it will report success for a change that never
  happened. `changePrivacySetting` and `changeAbout` show the expected shape.
- **JID encoding shape matters.** `jidStrToObj` picks JID_PAIR vs AD_JID; a JID
  written as a plain string goes out as a dictionary token, not an address. Use
  `jidStrToObj('@s.whatsapp.net')` for "the server itself", the way Baileys and
  whatsmeow do.
- Where the server's answer cannot be trusted as proof, **read the state back**
  (see `queryOwnAbout`) rather than reporting what was sent.
- Registration (`Registration.js`, HTTPS not the socket) has the same trap in its
  own form: the server reads the calling platform out of the **User-Agent**, not
  out of any form field, and the Android envelope carries three headers the iOS
  one does not. `registrationHeaders` is the single place both the direct and the
  SOCKS path build that from — keep it that way, they drifted once already.

## Conventions

- Comments explain *why*, and frequently name what was wrong before and what the
  wrong version did — they are the repository's bug history. Match that register:
  prose, lower-case, no decoration. Do not add comments that restate the code.
- Public API changes belong in `README.md` as well; it is the only documentation and
  has a hand-maintained index near the top.
- A new client method usually wants a matching CLI command, its row in the CLI
  command table in the README, and the README section for the library call.
- Node >= 14, CommonJS, semicolons, 2-space indent, aligned `const` blocks and
  aligned object keys where the surrounding code already does it.
