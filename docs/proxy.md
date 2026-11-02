# Routing Traffic Through a Proxy

[← Back to the README](../README.md) · [Documentation index](../README.md#documentation)

---

## Routing Traffic Through a Proxy

Two reasons to want this. Registration is the part of the protocol most likely to be refused from a datacenter IP, so a residential exit helps with security blocks and undeterminable number statuses. And on a network that cannot reach WhatsApp at all, nothing works without one.

Install the optional dependency and set one environment variable:

```sh
npm install socks
```

```sh
# Tor
export TOR_PROXY=socks5://127.0.0.1:9050

# a residential proxy that needs credentials
export SOCKS_PROXY=socks5://user:pass@proxy.example.com:1080
```

A bare `host:port` is assumed to be SOCKS5, so `TOR_PROXY=127.0.0.1:9050` works too. `socks5`, `socks5h`, `socks4` and `socks4a` are all accepted, and `TOR_PROXY` wins if both variables are set.

If the password contains an `@` or a `:`, percent-encode it — `p@ss:word` becomes `p%40ss%3Aword`. whalibmob decodes it before handing it to the proxy.

```js
// or from code, before you call any registration function
process.env.SOCKS_PROXY = 'socks5://user:pass@proxy.example.com:1080'

await requestSmsCode(phone, store)
```

### What goes through it

Everything the library sends out:

| Connection | Destination |
|---|---|
| Message socket, mobile | raw TCP to WhatsApp |
| Message socket, web | `wss://web.whatsapp.com/ws/chat` |
| Registration | `v.whatsapp.net` |
| Announced version, iOS | App Store lookup |
| Announced version, Android | Play Store listing |
| Announced version, web | `web.whatsapp.com/sw.js` |
| APK material for registration | Play Store download |
| Media upload | WhatsApp's media hosts |

Node's `http`/`https` modules ignore proxy environment variables entirely — a proxy has to be handed in as an agent, per call site. Only the registration POST used to do that, which produced a confusing failure: `curl -x socks5://…` reached WhatsApp while the library timed out on the same machine, falling back to a pinned version with only a debug line to show for it:

```
[DBG] WEB_VERSION 2.3000.1035194821 (pinned fallback: sw.js fetch timed out)
```

All eight paths now share one agent.

If `socks` is not installed, or a proxy is unreachable, you get a message saying so rather than a silent failure. A proxy URL that cannot be parsed leaves the connection direct rather than throwing — a version lookup with a pinned fallback should not take a process down over its proxy. In the rare case the package lives somewhere `require()` cannot find it, `WA_SOCKS_LIB` takes an absolute path to it.


---

[← Back to the README](../README.md) · [Documentation index](../README.md#documentation)
