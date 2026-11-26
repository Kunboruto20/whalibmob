# Interactive buttons ("card" messages)

Send a message with up to **three tappable buttons**: a link button, a call
button, a copy button, or a quick-reply. Optionally put an image on top for the
"card" look.

Works the same on a **mobile-registered** number and a **linked web/companion**
session — a WhatsApp message is encoded identically on both, so the same call
delivers buttons either way.

## Works on both mobile API and web API

`sendInteractive` is routed through whalibmob's normal message pipeline, exactly
like `sendText`. It does **not** matter how the session came to exist:

| Session type | How you got it | Buttons work? |
|--------------|----------------|---------------|
| **Mobile API** | registered a number over SMS / voice / `wa_old` | ✅ yes |
| **Web / companion API** | linked by QR, pairing code or passkey | ✅ yes |

The reason: a WhatsApp message — text, image, or interactive — is encrypted and
encoded the same way regardless of how the account was created. The interactive
message is Signal-encrypted and fanned out to **every device** of the recipient
(phone + web + any linked companion), just like a normal text message. The only
extra is one `<biz>` native-flow node added to the stanza so clients render the
buttons.

So you write the call once and it behaves identically on a bot that registered
its own number and on a bot linked to an existing phone.

> **Deliverability / risk.** Sending interactive buttons is something only
> official and Business-API clients normally do. WhatsApp can flag an account
> that sends them. Use a warmed, trusted account, send to people who expect the
> message, and never blast strangers — that is the quickest route to a ban.
> `quick_reply` and `cta_url` are the most widely rendered; exotic flows may be
> silently ignored by some clients.

## Node API

```js
const { WhalibmobClient } = require('whalibmob');
const client = new WhalibmobClient();
await client.connect();

await client.sendInteractive('40712345678', {
  body:   'Check this out!',
  footer: 'whalibmob',
  image:  './banner.jpg',           // optional header image (path, Buffer, or URL)
  buttons: [
    { text: 'Open site',  url: 'https://example.com' },   // link button
    { text: 'Call us',    phone: '15551234567' },         // call button
    { text: 'Copy code',  copy: 'PROMO2026' },            // copy button
    // { text: 'Yes',     id: 'yes' }                     // quick reply (no url/phone/copy)
  ]
});
```

### Button types

| Button | Fields | Effect when tapped |
|--------|--------|--------------------|
| Link    | `{ text, url }`   | opens the URL (`cta_url`) |
| Call    | `{ text, phone }` | dials the number (`cta_call`) |
| Copy    | `{ text, copy }`  | copies the code (`cta_copy`) |
| Reply   | `{ text, id }`    | sends the text back as a reply (`quick_reply`) |

At most **3** buttons per message.

### Options

| Option | Meaning |
|--------|---------|
| `body` / `text` | main text of the card |
| `footer` | small grey text under the buttons |
| `title` / `subtitle` | bold title / subtitle above the body |
| `image` | header image on top of the card |
| `buttons` | 1–3 buttons (see above) |
| `contextInfo` | quote/mention info, like any message |

Need an exotic native-flow button? Pass it raw and it is sent untouched:

```js
buttons: [
  { name: 'single_select', buttonParamsJson: JSON.stringify({ title: 'Pick', sections: [/* ... */] }) }
]
```

## CLI

```
/button <jid> <body> | <Label>=<target> | <Label2> | ...
```

Each button is `Label=target`, separated by `|`:

| Target form | Button |
|-------------|--------|
| `https://site.com` | link button |
| `call:15551234567` | call button |
| `copy:CODE123` | copy button |
| *(no `=target`)* | quick reply |

Example:

```
/button 40712345678 Check our offer! | Open=https://example.com | Call=call:15551234567 | Yes
```

## How it works

An interactive message is `Message.interactiveMessage` (protobuf field 45) with
a `nativeFlowMessage` carrying the buttons. whalibmob also attaches the
`<biz><interactive type="native_flow" v="1"><native_flow v="9" name="mixed"/></interactive></biz>`
stanza node — without it the server accepts the message but clients do not draw
the buttons.
