# Frida device-attestation middleware

This folder ports the Frida instrumentation scripts from
[Auties00/Cobalt](https://github.com/Auties00/Cobalt) (`tools/mobile/*/frida-scripts`,
MIT licensed, Copyright (c) 2021 Alessandro Autiero) so that **whalibmob can obtain
the same device-attestation data the native WhatsApp app produces** during phone-number
registration.

WhatsApp's registration endpoints (`/v2/exist`, `/v2/code`, `/v2/register`) are
gated by device attestation:

- **Android** — a Google **Play Integrity** verdict token (`gpia`) plus an Android
  **Keystore** hardware-attested signature over the request body (`H=` + the
  `Authorization` certificate chain).
- **iOS** — an Apple **App Attest** attestation/assertion pair.

These tokens can only be minted by real Google Play Services / Apple Secure Enclave
on a genuine device. The scripts here run **on a rooted Android / jailbroken iOS
device** under [Frida](https://frida.re) and expose a tiny local **HTTP server** that
mints those tokens on demand. whalibmob then connects to that server and injects the
results into the registration payload — exactly the mechanism Cobalt documents.

> **Reference-only, unmaintained.** Like the upstream scripts, these are provided
> for research/reverse-engineering. They require a rooted/jailbroken device and are
> not part of whalibmob's runtime dependencies.

## Layout

```
frida/
├── android/
│   └── integrity/          # Play Integrity + Keystore attestation server
│       ├── server.js       #   GET /info, /integrity, /cert  (port 1119 / 1120)
│       └── package.json
└── ios/
    ├── registration/
    │   └── registration.js # prints the Curve25519 registration public key
    ├── integrity/          # App Attest server
    │   ├── server.js       #   GET /integrity  (port 1119 / 1120)
    │   └── package.json
    └── exchange/
        └── index.js        # mbedtls_gcm_update tracer (RE aid)
```

Port convention (matches the native bundle id):
`1119` = WhatsApp, `1120` = WhatsApp Business.

## HTTP contract consumed by whalibmob

`lib/AttestationClient.js` speaks exactly these endpoints:

| Method / path                              | Returns                              | Registration use                          |
|--------------------------------------------|--------------------------------------|-------------------------------------------|
| `GET /info`                                | `{ packageName, version, signature, ... }` | device descriptor (optional diagnostics)  |
| `GET /integrity?authKey=<base64url>`       | Android `{ token }` / iOS `{ attestation, assertion }` | `gpia` form field (inside the ENC body)   |
| `GET /cert?authKey=<base64>&enc=<base64url>` | `{ signature, certificate }` (Android only) | `H=` body suffix + `Authorization` header |

## Running the device middleware

### Android

1. Rooted phone with Play Services, Magisk + Zygisk, and the
   [PlayIntegrityFix](https://github.com/chiteroman/PlayIntegrityFix) module.
2. [Frida server](https://frida.re/docs/android/) installed on the device.
3. WhatsApp / WhatsApp Business installed **from the Play Store** (sideloaded APKs
   do not load the Play Integrity components).
4. Open WhatsApp and start a registration once (loads the gpia components).
5. Build and run:

   ```sh
   cd frida/android/integrity
   npm install
   npm run build            # -> server_with_dependencies.js
   frida -U "WhatsApp"          -l server_with_dependencies.js
   # or:
   frida -U "WhatsApp Business" -l server_with_dependencies.js
   ```

The script prints `Server ready on port 1119` (or `1120`) once it is listening.

### iOS

1. Jailbroken iPhone with [Frida server](https://frida.re/docs/ios/).
2. WhatsApp / WhatsApp Business installed from the App Store.
3. Build and run:

   ```sh
   cd frida/ios/integrity
   npm install
   npm run build
   frida -U -l server_with_dependencies.js -f "net.whatsapp.WhatsApp"
   # or:
   frida -U -l server_with_dependencies.js -f "net.whatsapp.WhatsAppSMB"
   ```

## Wiring whalibmob to the running server

Forward the device port to the host running whalibmob (USB: `adb forward tcp:1119 tcp:1119`,
or run whalibmob on the device's network), then enable attestation via env:

```sh
# .env
WA_FRIDA_ATTESTATION=1                 # turn the attestor on (off by default)
WA_FRIDA_HOST=127.0.0.1                # host of the Frida HTTP server
WA_FRIDA_PORT=1119                     # 1119 WhatsApp, 1120 Business (auto from WA_OS if unset)
# WA_FRIDA_OPTIONAL=1                   # don't fail the request if the server is unreachable
```

With this set, `requestSmsCode()` / `verifyCode()` / `checkIfRegistered()` transparently
call the Frida server and attach `gpia` / `H=` / `Authorization` to every attested
request — the same shape a genuine device sends. When the flag is unset (default),
whalibmob behaves exactly as before and never contacts the device.

## Attribution

Scripts adapted from **Auties00/Cobalt** (`tools/mobile`), MIT License,
Copyright (c) 2021 Alessandro Autiero. whalibmob is also MIT licensed; the upstream
copyright notice is retained in each script header and in `NOTICE`.
