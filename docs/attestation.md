# Device Attestation — Play Integrity & App Attest

[← Back to the README](../README.md) · [Documentation index](../README.md#documentation)

---

## Device Attestation — Play Integrity and App Attest

This is the part most projects stop at, so it is worth saying up front what is
here and what it does.

When the real WhatsApp app registers a number, it does not just send the number
and the code. It also proves to the server that it is running on a genuine
handset, by minting a hardware-backed attestation token — **Play Integrity plus
a Keystore certificate chain** on Android, **DeviceCheck App Attest** on iOS.
Those tokens cannot be forged off-device: they are signed by a key that lives in
the phone's secure hardware.

whalibmob ships the on-device scripts that obtain them. They run under
[Frida](https://frida.re) on a **rooted Android phone** or a **jailbroken
iPhone**, start a small HTTP server on the device, and whalibmob calls it while
registering:

| Platform | Endpoint | What it feeds into the registration request |
|----------|-------------|----------------------------------------------|
| Android | `/info` | APK hashes, signature and secret key — the device fingerprint |
| Android | `/integrity` | `gpia` and its `_gg _gi _gp _ge _ga` companions — the Play Integrity verdict |
| Android | `/cert` | the `&H=` body signature and the `Authorization` certificate chain |
| iOS | `/integrity` | the App Attest assertion and its `Authorization` header |

```sh
# on your computer — build the bundle
cd frida/android                                  # or: cd frida/ios
npm install && npm run build                      # → server_with_dependencies.js

# attach it to WhatsApp on the device, with the Frida server running there
frida -U "WhatsApp" -l server_with_dependencies.js

# on the machine running whalibmob — it listens on 1119 (WhatsApp) / 1120 (Business)
export WA_FRIDA_HOST=192.168.1.50
wa registration --request-code 919634847671
```

The code, and the per-platform setup:

- **[`frida/android/server.js`](https://github.com/Kunboruto20/whalibmob/blob/main/frida/android/server.js)** — Play Integrity + Keystore attestation · [setup](https://github.com/Kunboruto20/whalibmob/blob/main/frida/android/README.md)
- **[`frida/android/registration/registration.js`](https://github.com/Kunboruto20/whalibmob/blob/main/frida/android/registration/registration.js)** — hooks `mbedtls_gcm_crypt_and_tag` in `libwhatsapp.so` to print the `/code` and `/register` parameters in plaintext, before they are sealed in the `ENC` envelope · [how to use](https://github.com/Kunboruto20/whalibmob/blob/main/frida/android/registration/README.md)
- **[`frida/ios/server.js`](https://github.com/Kunboruto20/whalibmob/blob/main/frida/ios/server.js)** — DeviceCheck App Attest · [setup](https://github.com/Kunboruto20/whalibmob/blob/main/frida/ios/README.md)
- **[`frida/ios/registration/registration.js`](https://github.com/Kunboruto20/whalibmob/blob/main/frida/ios/registration/registration.js)** — prints the registration public key
- **[`frida/ios/exchange/index.js`](https://github.com/Kunboruto20/whalibmob/blob/main/frida/ios/exchange/index.js)** — hooks `mbedtls_gcm_update` to read the payload
- **[`lib/Attestation.js`](https://github.com/Kunboruto20/whalibmob/blob/main/lib/Attestation.js)** — the client that talks to the device

> [!NOTE]
> **None of this is required.** Leave `WA_FRIDA_HOST` unset and whalibmob sends
> the same empty low-trust attestation fields the native client sends when its
> own integrity minting fails — which the server tolerates. Registration works
> without a rooted phone anywhere in sight. Attaching a device raises the trust
> score, which is what helps when a number keeps hitting `no_routes` or a block
> screen.

> [!IMPORTANT]
> **The Frida scripts themselves are reference material, not a maintained
> feature.** They are published so that anyone with a rooted or jailbroken
> device can reproduce what the native app does, and so that the method is on
> the record. They also need the official app installed **from the Play Store /
> App Store** — a sideloaded APK will not attest, because the token is bound to
> the store-signed build. `lib/Attestation.js`, the client side inside
> whalibmob, is maintained as part of the library.

Full walkthrough, with the device prerequisites: [Device Attestation with Frida](registration.md#device-attestation-with-frida-optional).


---

[← Back to the README](../README.md) · [Documentation index](../README.md#documentation)
