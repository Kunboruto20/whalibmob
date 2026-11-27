'use strict';

// ─── Interactive "card" messages (link / call / copy / quick-reply buttons) ──
//
// Shows how to send a message with tappable buttons from the whalibmob Node API.
// Works the same whether the session was registered over SMS (mobile) or linked
// as a companion (web) — a message is encoded identically on both.
//
//   node examples/interactive-buttons.js <phone-number>
//
// NOTE on deliverability: sending interactive buttons is something only official
// clients normally do, so WhatsApp can flag the sending account. Use a warmed,
// trusted account, send to people who expect it, and do not blast strangers —
// that is the fastest way to get an account banned.

const { WhalibmobClient } = require('..');     // require('whalibmob') in your project

async function main() {
  const to = process.argv[2];
  if (!to) {
    console.error('usage: node examples/interactive-buttons.js <phone-number>');
    process.exit(1);
  }

  // Load an existing registered/linked session (adjust to your setup).
  const client = new WhalibmobClient();
  await client.connect();                       // or connectWeb() for a companion session

  client.on('ready', async () => {
    // 1) A plain card: body + footer + one link button.
    await client.sendInteractive(to, {
      body:   'Welcome! Tap below to visit our site.',
      footer: 'Sent with whalibmob',
      buttons: [
        { text: 'Open website', url: 'https://example.com' }
      ]
    });

    // 2) A "card" with an image header and three mixed buttons.
    await client.sendInteractive(to, {
      image:  './banner.jpg',                   // header image (path, Buffer, or URL)
      title:  'VIP Offer',
      body:   'Here is your personal bonus 🎁',
      footer: 'whalibmob',
      buttons: [
        { text: 'Claim now',  url: 'https://example.com/claim' },
        { text: 'Call us',    phone: '15551234567' },
        { text: 'Copy code',  copy: 'PROMO2026' }
      ]
    });

    // 3) Quick-reply buttons (no url/phone/copy → the text comes back as a reply).
    await client.sendInteractive(to, {
      body: 'Do you confirm your order?',
      buttons: [
        { text: 'Yes', id: 'confirm_yes' },
        { text: 'No',  id: 'confirm_no'  }
      ]
    });

    console.log('All three interactive messages sent.');
  });

  // When the recipient taps a quick-reply button, it arrives as a normal message
  // whose interactiveResponseMessage carries the button id.
  client.on('message', (m) => {
    console.log('incoming:', JSON.stringify(m).slice(0, 200));
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
