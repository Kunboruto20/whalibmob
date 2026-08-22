# Frida attestation middleware

This folder holds the on-device [Frida](https://frida.re) scripts whalibmob
uses to obtain the hardware attestation tokens WhatsApp's registration server
expects from a genuine mobile client (Android Play Integrity / Keystore
attestation and iOS App Attest).

> **Attribution**: these reverse-engineering scripts are derived from
> [Auties00/cobalt](https://github.com/Auties00/cobalt)'s `tools/mobile`
> folder. They are reference material — kept here so whalibmob users who own a
> rooted Android phone or a jailbroken iPhone can reproduce the same
> device-bound attestation the native app produces. They are **not** required
> for basic registration: without them whalibmob ships the same empty
> low-trust attestation fields the native client sends when integrity minting
> fails, which the server tolerates.

## Layout

```
frida/
  android/                Android Play Integrity + Keystore attestation server
    server.js               HTTP server exposing /integrity, /cert, /info
    package.json            frida-compile build config
    README.md               how to run it on a rooted device
  ios/                    iOS DeviceCheck App Attest server
    server.js               HTTP server exposing /integrity
    package.json            frida-compile build config
    README.md               how to run it on a jailbroken device
    registration/
      registration.js       hook that prints the registration public key
    exchange/
      index.js              hook on mbedtls_gcm_update (payload inspection)
```

## How whalibmob uses it

`lib/Attestation.js` is an HTTP client for the local server these scripts
start on the phone. When `WA_FRIDA_HOST` (and optionally `WA_FRIDA_PORT`) is
set in the environment, whalibmob's registration flow (`lib/Registration.js`)
calls the endpoints below and folds their output into the `/code`,
`/register` and `/exist` request bodies — exactly the way Cobalt does:

| Platform | Endpoint      | Feeds registration field(s)                        |
|----------|---------------|----------------------------------------------------|
| Android  | `/info`       | apk hashes / signature / secret key (device info)  |
| Android  | `/integrity`  | `gpia` (+ `_gg _gi _gp _ge _ga`) Play Integrity     |
| Android  | `/cert`       | `&H=` body signature + `Authorization` cert chain  |
| iOS      | `/integrity`  | `&H=` App Attest assertion + `Authorization` header |

The default port matches the native app's WhatsApp consumer build: `1119`
(WhatsApp) / `1120` (WhatsApp Business).

When `WA_FRIDA_HOST` is unset, `lib/Attestation.js` returns empty tokens and
whalibmob emits the same fields with empty values — no device required.

## Requirements & run instructions

See `android/README.md` and `ios/README.md` for the per-platform setup
(rooted/jailbroken device, Frida server, building `server_with_dependencies.js`
with `frida-compile`, and attaching to the WhatsApp process).
