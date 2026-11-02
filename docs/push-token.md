# The Push Token

[← Back to the README](../README.md) · [Documentation index](../README.md#documentation)

---

## The Push Token

Every WhatsApp on a real phone holds a push token. It is the address the push network uses to wake the app, and no install exists without one — so a registration that ships no `push_token` describes a WhatsApp that cannot be notified, which is a device that does not exist.

**Which token you get follows from the profile.** Which push network an install uses follows from its platform: Android holds a *Firebase* token and keeps a stream open to Google, iOS holds an *APNs* token and keeps one open to Apple. They are not interchangeable, and the registration server sees both the token and the User-Agent naming the platform that sent it — an iPhone presenting a Firebase token describes a device nobody ships. Both sides are implemented, and the right one is chosen from `WA_OS` without you asking for it. A profile that is neither sends no `push_token` at all, which is the correct thing for a client with no push line.

The token does two distinct jobs, and it is easy to conflate them:

1. **It makes the registration look real — always.** Every `/code` request now carries the token, whichever delivery method you ask for. The server sees an install that can be reached, not a headless client. This is the reason the token matters, and it applies to `sms`, `voice`, `wa_old` — all of them.
2. **It can carry the code itself — sometimes.** Because you handed WhatsApp a direct line, WhatsApp *may* also push the six-digit code silently down it, so the app fills the code in on its own. This is why the code auto-completes on a real phone before you have read the SMS. It happens *alongside* the method you chose, not instead of it.

The delivery method and the push are not alternatives. You still choose how a human receives the code (`sms`, `voice`, `wa_old`); the push, when it comes, is a second silent copy of that same code sent straight to the app.

```
request a code ─┬─ method you chose  →  reaches a human   (SMS, a call, the existing WhatsApp)
                └─ push_token line   →  reaches the app    (silent, auto-filled — if WhatsApp sends it)
```

### On Android: Firebase

Registration fetches a real token and sends it, in three plain HTTPS calls to Google:

| Step | Endpoint | Yields |
|---|---|---|
| 1 | `android.clients.google.com/checkin` | an android id and security token — the device's identity with Google |
| 2 | `firebaseinstallations.googleapis.com` | a Firebase installation for WhatsApp's project |
| 3 | `android.clients.google.com/c2dm/register3` | the FCM token itself |

No root, no Frida, no phone. This is unrelated to Play Integrity attestation — the two travel in the same request but come from different places, and one works without the other.

It runs once per number. The Firebase identity is cached on the session, because Google issues an android id once and expects it back; fetching a new one per registration step would mint a fresh phantom device each time.

Turn it off with `WA_FCM_PUSH=0`.

### On iOS: APNs

Apple's flow is not Google's, but it lands in the same place:

| Step | Endpoint | Yields |
|---|---|---|
| 1 | `albert.apple.com` | a device certificate Apple signs for a keypair generated here — the activation every Apple device runs on first boot |
| 2 | `init-p01st.push.apple.com/bag` | which courier hosts to dial |
| 3 | `<n>-courier.push.apple.com:443` | the device token, then `GET_TOKEN` for `net.whatsapp.WhatsApp` — the per-topic token that *is* `push_token` |

Step 1 runs once per number and its result is cached on the session: the certificate Apple issues is good for a year, and the identity behind it is what makes the same push token come back on the next run. A token WhatsApp has already recorded stops being deliverable if that identity is thrown away, which is the same reason the Firebase android id is kept.

The courier connection is a TLS stream that offers ALPN `apns-security-v3` — the device proves itself with a signature over a fresh nonce in the first frame rather than with a TLS client certificate. Apple accepts the offer without echoing it back, so a missing echo is normal and is not treated as a failure. A network that terminates TLS in the middle cannot carry the stream; what gives it away is the certificate, since a middlebox has to present one its own CA signed rather than Apple's. The failure names that issuer, instead of looking like a dropped connection.

Turn it off with `WA_APNS_PUSH=0`.

**Failure is silent by design, on both platforms.** A blocked network, a refusal from Google or Apple, a malformed answer — all end with the field omitted and registration proceeding exactly as it did before push tokens were wired up. A push token helps; it is never a prerequisite.

### Receiving the code over push, without typing it

This is the receiving end of job 2 above. When WhatsApp sends the code as a silent push, something has to be listening on the push line to catch it — the same long-lived connection every phone keeps open to its push network. `receivePushCode(store, device)` opens the one that matches the profile:

| Profile | Connection | Where the code is |
|---|---|---|
| `WA_OS=android` | `mtalk.google.com:5228`, the MCS protocol, logged in with the Firebase identity | an `appData` entry keyed `registration_code` |
| `WA_OS=ios` | `<n>-courier.push.apple.com:443`, the APNs courier, authenticated with the activation certificate | the `regcode` field of the notification's JSON payload |

Either way the call resolves with the code the moment a push carrying it arrives. A profile that is neither resolves `null` immediately rather than holding a listener open on a line no push can reach, and `/reg push` says so and stops instead of waiting out its timeout. Check with `supportsPush(store.device)` if you want to branch on it.

The order matters. Open the listener **first**, so the line is live before the code is requested; then request the code by whatever method; then await it.

```js
const { receivePushCode, requestSmsCode, verifyCode } = require('whalibmob')

// 1. open the listener first, so the push has somewhere to land
const codePromise = receivePushCode(store, store.device, { timeoutMs: 180000 })

// 2. request the code — any method. The push, if it comes, is a copy of it.
await requestSmsCode(store, 'sms')          // or 'voice', 'wa_old', …

// 3. if the push arrives, the code is here with nothing typed
const code = await codePromise
if (code) await verifyCode(store, code)
else      { /* no push — read the code from SMS / the existing WhatsApp, then verifyCode */ }
```

From the CLI the whole sequence is one command:

```
/reg push <phone> [sms|voice]
```

It opens the listener, waits until it is logged in, requests the code, and confirms automatically if the push arrives — falling back to `/reg confirm <phone> <code>` when it does not.

Either connection carries a heartbeat and acknowledges what it has read, so a reconnect does not re-read a delivered code, the way the native client does. It resolves `null` on timeout, a refused login, or any failure — at which point you simply read the code the ordinary way and verify it. Like the token, it routes through the configured SOCKS proxy.

> [!IMPORTANT]
> Receiving the push is not the same as making WhatsApp send it. Whether WhatsApp pushes the code for a given request is the server's decision, and on a client shipping empty attestation it will often send the code only by the method you asked for (SMS, `wa_old`, a call) and no silent push. This listener catches the push correctly **when one is sent**; it cannot force that channel, and it never replaces the chosen method — it runs beside it. With a valid Play Integrity attestation in the request (`WA_FRIDA_HOST`), the server is more likely to include the silent push.


---

[← Back to the README](../README.md) · [Documentation index](../README.md#documentation)
