# Registration parameter tracer (Android)

> **IMPORTANT**: Reference material, not maintained. It's here so people
> curious about the registration flow can see the exact parameters the native
> WhatsApp client sends — on their own device, with their own number.

WhatsApp seals the `/code` and `/register` request bodies in an AES-256-GCM
`ENC` envelope before they leave the phone, so a network proxy only ever sees
ciphertext. This agent attaches one layer below the encryption — to the GCM
layer inside `libwhatsapp.so` — and reconstructs the **plaintext** parameter
string right before it is sealed.

It follows **both** encryption entry points the native client can take, so no
registration run slips past it:

- the one-shot `mbedtls_gcm_crypt_and_tag` (whole body in a single call), and
- the streaming `mbedtls_gcm_starts` / `update` / `finish` (body fed in
  chunks), reassembled per context pointer into the full payload.

It prints which symbol fired and at what module offset, the IV / AAD / tag, and
breaks the body out field by field (`cc`, `in`, `id`, `token`, backup token,
the ephemeral key material, Play Integrity `gpia`, …) followed by the raw
query string.

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
[+] hooked libwhatsapp.so+0x3f1a20 @ 0x7b2c1f1a20  (mbedtls_gcm_crypt_and_tag)
[*] waiting for a registration run — request the code with method=voice …

╔══════════════ ENC registration payload ══════════════
  via           mbedtls_gcm_crypt_and_tag (one-shot)
  site          libwhatsapp.so+0x3f1a20 @ 0x7b2c1f1a20
  length        412 bytes
  iv            000000000000000000000000
  tag           9f1c…(32 hex)
  ---- parameters ----
    cc                  40
    in                  1512345678
    method              voice
    id                  %ab%cd…
    token               3f8a1c…
    backup_token        …
    e_regid             …
    e_keytype           05
    e_ident             …
  ---- raw body ----
  cc=40&in=1512345678&method=voice&id=…&token=…&backup_token=…&e_regid=…
╚═══════════════════════════════════════════════════════
```

The agent only follows the AES-GCM **encrypt** direction and only emits when
the reconstructed plaintext carries registration markers (`cc=`, `&in=`,
`token=`, `backup_token`, `authkey=`, `ENC`), so ordinary message/media
encryption is filtered out and the log stays focused on the registration run.
