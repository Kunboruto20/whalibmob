# Registration parameter tracer (Android)

> **IMPORTANT**: Reference material, not maintained. It's here so people
> curious about the registration flow can see the exact parameters the native
> WhatsApp client sends — on their own device, with their own number.

WhatsApp seals the `/code` and `/register` request bodies in an AES-256-GCM
`ENC` envelope before they leave the phone, so a network proxy only ever sees
ciphertext. This hook attaches one layer below the encryption — to
`mbedtls_gcm_crypt_and_tag` inside `libwhatsapp.so` — and prints the
**plaintext** parameter string right before it is sealed.

Run a real `method=voice` registration in the app while this is attached and
you'll see the full body: `cc`, `in`, `id`, `token`, backup token, Play
Integrity fields, the ephemeral public key, and the rest. That's the same
shape `lib/Registration.js` builds, so you can diff whalibmob's output against
the native client's byte for byte.

This is the Android counterpart of `frida/ios/exchange/index.js` (which hooks
`mbedtls_gcm_update` on iOS).

### Requirements

1. Rooted Android phone with Play Services
2. [Frida server installed](https://frida.re/docs/android/)
3. WhatsApp and/or WhatsApp Business installed **from the Play Store**
   (APKs don't load the gpia components)

### How to run

1. Open WhatsApp / WhatsApp Business and begin registering a number (this
   loads `libwhatsapp.so` and the integrity components).
2. Attach the hook:
   - `frida -U "WhatsApp" -l registration.js` (WhatsApp)
   - `frida -U "WhatsApp Business" -l registration.js` (WhatsApp Business)
3. Request the code with the **voice** method in the app. The parameter string
   prints to the console as it is encrypted.

### Stripped builds

Recent WhatsApp builds strip the mbedTLS symbols, so the script may not find
`mbedtls_gcm_crypt_and_tag` automatically. Locate the function offset in
Ghidra (look for the GCM encrypt routine — the one taking an 11-argument
signature and an `MBEDTLS_GCM_ENCRYPT` mode) and re-run with the offset
relative to the `libwhatsapp.so` base:

```
WA_GCM_ADDR=0x<offset> frida -U "WhatsApp" -l registration.js
```

### What you'll see

```
==================== ENC (registration) ====================
[plaintext len] 412
[iv]            000000000000000000000000
[params]
cc=40&in=1512345678&Rc=0&lg=en&lc=US&mistyped=6&...&token=...&backup_token=...
============================================================
```

The hook only prints the AES-GCM **encrypt** direction and only when the
plaintext carries registration markers (`cc=`, `token=`, `&in=`, `ENC`), so
ordinary message/media encryption is filtered out and the log stays focused on
the registration run.
