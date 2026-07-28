'use strict';

/**
 * GYOVANNY WHATSAPP SCRIPT v3.2
 * MULTI-DEST + AUTO-RESPONDER ASINCRON + TYPING INDICATOR
 *
 * Ce face:
 *   - Bulk sender: loop infinit, asincron, per destinatar (TXT / mod / delay propriu)
 *   - Auto-responder: raspunde automat la mesajele primite (linie cu linie sau text intreg)
 *   - TYPING INDICATOR: la ABSOLUT ORICE mesaj primit trimite imediat "tasteaza..."
 *     (chatstate composing), il tine viu pana raspunde, apoi trimite "paused".
 *
 * De ce se reimprospateaza: WhatsApp sterge singur starea "composing" dupa ~10s,
 * asa ca trebuie retrimisa la fiecare 5s cat timp vrem sa se vada "tasteaza...".
 *
 * Rulare:  node gyovanny-bulk-typing.js
 */

const { WhalibmobClient } = require('whalibmob');
const readline = require('readline');
const path     = require('path');
const fs       = require('fs');

// chalk v5 este ESM-only si crapa la require(). Fallback pe coduri ANSI simple,
// ca scriptul sa mearga cu orice versiune de chalk — sau chiar fara chalk.
let chalk;
try {
  chalk = require('chalk');
  if (!chalk || typeof chalk.red !== 'function') throw new Error('chalk ESM');
} catch (_) {
  const wrap = code => s => `\x1b[${code}m${s}\x1b[0m`;
  chalk = { red: wrap(31), green: wrap(32), yellow: wrap(33), gray: wrap(90) };
}

const rl = readline.createInterface({
  input:  process.stdin,
  output: process.stdout
});

function ask(question) {
  return new Promise(resolve => rl.question(question, ans => resolve(ans.trim())));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadLines(txtPath) {
  return fs
    .readFileSync(txtPath, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);
}

function loadFullText(txtPath) {
  return fs.readFileSync(txtPath, 'utf8').trim();
}

function shortJid(jid) {
  return String(jid).replace('@s.whatsapp.net', '').replace('@g.us', ' (grup)');
}

function banner() {
  console.log(chalk.red('\n╔══════════════════════════════════════════════╗'));
  console.log(chalk.red('║                                              ║'));
  console.log(chalk.red('║       GYOVANNY WHATSAPP SCRIPT v3.2          ║'));
  console.log(chalk.red('║   MULTI-DEST + AUTO-RESPONDER + TYPING       ║'));
  console.log(chalk.red('║                                              ║'));
  console.log(chalk.red('╚══════════════════════════════════════════════╝\n'));
}

// =============================================================================
//  TYPING INDICATOR MANAGER
//  WhatsApp expira starea "composing" dupa ~10 secunde. Ca sa ramana afisat
//  "tasteaza..." cat timp avem nevoie, retrimitem chatstate la fiecare 5s.
//  Fiecare pornire primeste un token; un stop vechi (programat inainte) nu mai
//  poate opri un typing pornit ulterior de un alt mesaj.
// =============================================================================
const TYPING_REFRESH_MS = 5000;

const typing = {
  sessions: new Map(),   // jid -> { timer, token }
  seq: 0,
  getClient: null,       // setat in main()

  _send(jid, state) {
    try {
      const c = this.getClient && this.getClient();
      if (c) c.setChatPresence(jid, state);
    } catch (_) { /* deconectat — typing nu e critic, nu oprim nimic */ }
  },

  // Porneste (sau reporneste) "tasteaza..." pentru un chat. Returneaza token-ul.
  start(jid) {
    const existing = this.sessions.get(jid);
    if (existing) clearInterval(existing.timer);

    const token = ++this.seq;
    this._send(jid, 'composing');

    const timer = setInterval(() => this._send(jid, 'composing'), TYPING_REFRESH_MS);
    if (timer.unref) timer.unref();

    this.sessions.set(jid, { timer, token });
    return token;
  },

  // Opreste typing. Cu token: opreste doar daca sesiunea curenta e aceeasi.
  stop(jid, token) {
    const s = this.sessions.get(jid);
    if (!s) return;
    if (token !== undefined && s.token !== token) return;  // a pornit alt typing intre timp
    clearInterval(s.timer);
    this.sessions.delete(jid);
    this._send(jid, 'paused');
  },

  stopAll() {
    for (const jid of Array.from(this.sessions.keys())) this.stop(jid);
  },

  // Durata "umana" de tastare pentru un text (folosita la bulk sender).
  humanDuration(text, cfg) {
    const est = String(text || '').length * 55;
    return Math.min(cfg.bulkMaxMs, Math.max(cfg.bulkMinMs, est));
  }
};

const typingCfg = {
  // cat tine "tasteaza..." la un mesaj primit la care NU raspundem
  holdMs:    4000,
  // typing si inainte de mesajele din bulk sender
  onBulk:    true,
  bulkMinMs: 1200,
  bulkMaxMs: 6000
};

// =============================================================================
//  AUTO-RESPONDER STATE
// =============================================================================
const autoResponder = {
  enabled:     false,
  txtPath:     null,
  sendMode:    1,       // 1 = linie cu linie, 2 = text intreg
  delayMs:     3000,
  senderState: {}       // { jid: { lineIndex } } — index propriu per expeditor
};

// Referinta mutabila pentru client (se schimba la reconectare)
const clientRef = { current: null };
const getClient = () => clientRef.current;

// Numerele noastre — ca sa nu raspundem/tastam la propriile mesaje ecou
let myNumbers = [];
// Mesaje deja procesate (WhatsApp poate retrimite acelasi id la retry)
const seenMessages = new Set();

function isSelfJid(jid) {
  const user = String(jid).split('@')[0].split(':')[0].replace(/\D/g, '');
  return myNumbers.includes(user);
}

function isChattableJid(jid) {
  // status@broadcast si canalele (@newsletter) nu accepta chatstate
  if (!jid) return false;
  if (jid === 'status@broadcast') return false;
  if (jid.endsWith('@newsletter')) return false;
  if (jid.endsWith('@broadcast'))  return false;
  return true;
}

// =============================================================================
//  CONNECT / RECONNECT
// =============================================================================
async function createClient(myPhone, sessionDir) {
  const client = new WhalibmobClient({ sessionDir });

  await new Promise((resolve, reject) => {
    client.on('connected', () => {
      console.log(chalk.red('✅ Conectat cu succes!\n'));
      resolve();
    });
    client.on('auth_failure', ({ reason }) => {
      reject(new Error('Auth failure: ' + reason));
    });
    client.on('error', (err) => {
      console.error(chalk.red('⚠️  Eroare client: ' + (err.message || err)));
    });
    client.on('disconnected', () => {
      console.log(chalk.red('⚠️  Conexiune pierdută. Se încearcă reconectare automată...'));
    });
    client.init(myPhone).catch(reject);
  });

  // Ne marcam online — fara asta serverul nu propaga prezenta catre contacte.
  try { client.setOnline(true); } catch (_) {}

  return client;
}

// Ataseaza TOATE listener-ele pe un client (typing + auto-responder).
// Se apeleaza intr-un singur loc, ca sa nu se dubleze listener-ele dupa reconectare.
function attachHandlers(client) {
  client.on('message', (msg) => {
    handleIncoming(msg).catch(err =>
      console.error(chalk.red('⚠️  [HANDLER] ' + (err.message || err))));
  });
  console.log(chalk.red('🖊️  [TYPING] Listener activ — trimit "tastează..." la orice mesaj primit.'));
  if (autoResponder.enabled) {
    console.log(chalk.red('🤖 [AUTO-RESPONDER] Listener activ — ascult mesaje incoming.'));
  }
  console.log('');
}

async function reconnect(myPhone, sessionDir) {
  let attempts = 0;
  // Typing-ul vechi apartine unei conexiuni moarte — il curatam.
  typing.sessions.forEach(s => clearInterval(s.timer));
  typing.sessions.clear();

  while (true) {
    attempts++;
    console.log(chalk.red(`🔄 Tentativa de reconectare #${attempts}...`));
    try {
      try { getClient().disconnect(); } catch (_) {}
      const newClient = await createClient(myPhone, sessionDir);
      clientRef.current = newClient;
      attachHandlers(newClient);
      console.log(chalk.red('✅ Reconectat cu succes!'));
      return newClient;
    } catch (err) {
      console.error(chalk.red(`❌ Reconectare eșuată: ${err.message}. Retry în 10s...`));
      await sleep(10000);
    }
  }
}

// =============================================================================
//  HANDLER MESAJE PRIMITE
//  1) TYPING la ABSOLUT ORICE mesaj primit (DM sau grup, text sau media)
//  2) AUTO-RESPONDER, daca e activat
// =============================================================================
async function handleIncoming(msg) {
  const jid = msg.from || msg.jid || (msg.key && msg.key.remoteJid);
  if (!isChattableJid(jid)) return;
  if (isSelfJid(jid)) return;                 // ecou de la propriile noastre device-uri

  // Deduplicare: acelasi mesaj poate sosi de mai multe ori (retry-uri).
  if (msg.id) {
    if (seenMessages.has(msg.id)) return;
    seenMessages.add(msg.id);
    if (seenMessages.size > 5000) {
      seenMessages.clear();
      seenMessages.add(msg.id);
    }
  }

  const isGroup = String(jid).endsWith('@g.us');
  const kind    = (msg.decoded && msg.decoded.type) || 'text';

  // ── 1. TYPING — imediat, la orice mesaj, indiferent de auto-responder ──────
  const token = typing.start(jid);
  console.log(chalk.red(`\n📩 ${shortJid(jid)} → mesaj primit (${kind}) — 🖊️  trimit "tastează..."`));

  // ── 2. AUTO-RESPONDER ─────────────────────────────────────────────────────
  const willReply = autoResponder.enabled && autoResponder.txtPath && !isGroup;

  if (!willReply) {
    // Nu raspundem: tinem "tasteaza..." cat s-a configurat, apoi paused.
    await sleep(typingCfg.holdMs);
    typing.stop(jid, token);
    return;
  }

  // Typing ramane activ tot delay-ul (se reimprospateaza singur la 5s).
  await sleep(autoResponder.delayMs);

  let text = null;
  try {
    if (autoResponder.sendMode === 2) {
      text = loadFullText(autoResponder.txtPath);
    } else {
      const lines = loadLines(autoResponder.txtPath);
      if (lines.length) {
        if (!autoResponder.senderState[jid]) autoResponder.senderState[jid] = { lineIndex: 0 };
        const state = autoResponder.senderState[jid];
        text = lines[state.lineIndex];
        state.lineIndex = (state.lineIndex + 1) % lines.length;
      }
    }
  } catch (e) {
    console.error(chalk.red(`⚠️  [AUTO-RESPONDER] Nu pot citi TXT: ${e.message}`));
  }

  if (!text) {
    typing.stop(jid, token);
    return;
  }

  try {
    await safeSend(jid, text, chalk.red('[AUTO-RESPONDER]'), { countTotal: false, typingToken: token });
  } finally {
    typing.stop(jid, token);   // "paused" imediat dupa ce mesajul a plecat
  }
}

// =============================================================================
//  SAFE SEND cu reconectare automata
// =============================================================================
let totalSent = 0;
let running   = true;
let myPhoneG, sessionDirG;

async function safeSend(jid, msg, label, opts) {
  opts = opts || {};
  let retries = 0;

  while (running) {
    try {
      await getClient().sendText(jid, msg);
      if (opts.countTotal !== false) totalSent++;
      const preview = msg.length > 60 ? msg.substring(0, 60) + '...' : msg;
      console.log(chalk.red(`✅ ${label} → ${shortJid(jid)} : ${preview.replace(/\n/g, ' ⏎ ')}`));
      return true;
    } catch (err) {
      retries++;
      console.error(chalk.red(`❌ ${label} Eroare (attempt ${retries}): ${err.message}`));
      if (retries >= 3) {
        console.log(chalk.red('🔄 Reconectare automată...'));
        await reconnect(myPhoneG, sessionDirG);
        // Dupa reconectare, typing-ul acestui chat trebuie repornit daca il tineam.
        if (opts.typingToken !== undefined && typing.sessions.get(jid) === undefined) {
          typing.start(jid);
        }
        retries = 0;
      } else {
        await sleep(3000);
      }
    }
  }
  return false;
}

// =============================================================================
//  BULK SENDER — worker asincron per destinatar, cu typing inainte de fiecare mesaj
// =============================================================================
async function sendWithTyping(jid, text, label) {
  if (typingCfg.onBulk) {
    const token = typing.start(jid);
    await sleep(typing.humanDuration(text, typingCfg));
    try {
      await safeSend(jid, text, label);
    } finally {
      typing.stop(jid, token);
    }
  } else {
    await safeSend(jid, text, label);
  }
}

function startRecipientWorker(recipient) {
  let round = 0;

  (async function loop() {
    while (running) {
      round++;

      if (recipient.sendMode === 1) {
        let lines;
        try {
          lines = loadLines(recipient.txtPath);
        } catch (e) {
          console.error(chalk.red(`⚠️  [${recipient.number}] Nu pot reciti TXT: ${e.message}`));
          await sleep(2000);
          continue;
        }

        if (!lines.length) {
          console.error(chalk.red(`❌ [${recipient.number}] TXT gol.`));
          return;
        }

        console.log(chalk.red(`\n🔄 [${recipient.number}] Runda ${round} — ${lines.length} linii\n`));

        for (let i = 0; i < lines.length && running; i++) {
          const label = chalk.red(`[${recipient.number} R${round} ${i + 1}/${lines.length}]`);
          await sendWithTyping(recipient.jid, lines[i], label);
          await sleep(recipient.delayMs);
        }

      } else {
        let fullText;
        try {
          fullText = loadFullText(recipient.txtPath);
        } catch (e) {
          console.error(chalk.red(`⚠️  [${recipient.number}] Nu pot reciti TXT: ${e.message}`));
          await sleep(2000);
          continue;
        }

        if (!fullText) {
          console.error(chalk.red(`❌ [${recipient.number}] TXT gol.`));
          return;
        }

        console.log(chalk.red(`\n🔄 [${recipient.number}] Runda ${round} — text complet\n`));

        const label = chalk.red(`[${recipient.number} R${round} TEXT]`);
        await sendWithTyping(recipient.jid, fullText, label);
        await sleep(recipient.delayMs);
      }
    }
  })();
}

// =============================================================================
//  MAIN
// =============================================================================
async function main() {
  banner();

  console.log(chalk.red('📱 Introdu numerele tale de telefon separate prin virgulă:'));
  console.log(chalk.red('   Exemplu: 40742394169, 40731384494, 49123456789\n'));
  const myPhonesRaw = await ask(chalk.red('📱 Numerele tale: '));
  const myPhones = myPhonesRaw
    .split(',')
    .map(p => p.trim().replace(/\D/g, ''))
    .filter(p => /^\d{8,15}$/.test(p));

  if (myPhones.length === 0) {
    console.error(chalk.red('❌ Niciun număr valid introdus.'));
    process.exit(1);
  }
  myNumbers = myPhones;
  console.log(chalk.red(`✅ Numere expeditori detectate: ${myPhones.join(', ')}\n`));

  const sessionDir = path.join(__dirname, '.waSession');
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }
  console.log(chalk.red(`📂 Session dir: ${sessionDir}\n`));

  const myPhone = myPhones[0];
  myPhoneG    = myPhone;
  sessionDirG = sessionDir;

  console.log(chalk.red(`🔌 Conectare cu numărul principal: ${myPhone}...\n`));
  const client = await createClient(myPhone, sessionDir);
  clientRef.current = client;
  typing.getClient = getClient;

  // Fara push name serverul refuza sa ne treaca "online", iar prezenta (deci si
  // typing-ul) poate sa nu ajunga la contacte. Il setam daca lipseste.
  const currentName = (client.store && (client.store.pushName || client.store.name)) || '';
  if (!currentName || currentName === 'User') {
    console.log(chalk.red('⚠️  Contul nu are un nume afișat (push name). Fără el, WhatsApp'));
    console.log(chalk.red('    nu propagă prezența — indicatorul "tastează..." poate să nu apară.'));
    const nm = await ask(chalk.red('👤 Nume afișat (Enter pentru a sări peste): '));
    if (nm) {
      try {
        client.changeName(nm);
        console.log(chalk.red(`✅ Nume setat: ${nm}\n`));
      } catch (e) {
        console.error(chalk.red(`⚠️  Nu am putut seta numele: ${e.message}\n`));
      }
    } else {
      console.log('');
    }
  }

  console.log(chalk.red('📨 Introdu numerele destinatare separate prin virgulă:'));
  console.log(chalk.red('   Exemplu: 40731384494, 49987654321, 447911123456\n'));
  const toRaw = await ask(chalk.red('📨 Destinatari: '));
  const toNumbers = toRaw
    .split(',')
    .map(p => p.trim().replace(/\D/g, ''))
    .filter(p => /^\d{8,15}$/.test(p));

  if (toNumbers.length === 0) {
    console.error(chalk.red('❌ Niciun număr destinatar valid.'));
    process.exit(1);
  }

  const recipients = toNumbers.map(n => ({
    number:   n,
    jid:      n + '@s.whatsapp.net',
    txtPath:  null,
    sendMode: 1,
    delayMs:  3000
  }));

  console.log(chalk.red(`✅ Destinatari valizi: ${toNumbers.join(', ')}\n`));
  console.log(chalk.red('⚙️  Acum configurăm FIECARE destinatar cu TXT, mod și delay propriu.\n'));

  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    console.log(chalk.red('────────────────────────────────────────────'));
    console.log(chalk.red(`👤 Destinatar ${i + 1}/${recipients.length}: ${r.number}`));

    const txtPath = await ask(chalk.red(`📄 Introdu calea fișierului TXT pentru ${r.number}: `));
    if (!fs.existsSync(txtPath)) {
      console.error(chalk.red(`❌ Fișierul pentru ${r.number} nu există.`));
      process.exit(1);
    }

    console.log(chalk.red('\n📬 Mod trimitere:'));
    console.log(chalk.red('   1 — Linie cu linie'));
    console.log(chalk.red('   2 — Text întreg\n'));
    const modeRaw  = await ask(chalk.red(`Selectează modul (1 sau 2) pentru ${r.number}: `));
    const sendMode = modeRaw.trim() === '2' ? 2 : 1;

    const delayRaw = await ask(chalk.red(`⏱️  Delay între mesaje în secunde pentru ${r.number}: `));
    const delayMs  = (parseFloat(delayRaw) || 3) * 1000;

    r.txtPath  = txtPath;
    r.sendMode = sendMode;
    r.delayMs  = delayMs;

    console.log(chalk.red('\n✅ Config pentru ' + r.number + ':'));
    console.log(chalk.red(`   📝 TXT   : ${txtPath}`));
    console.log(chalk.red(`   📬 Mod   : ${sendMode === 1 ? 'Linie cu linie' : 'Text întreg'}`));
    console.log(chalk.red(`   ⏱️  Delay : ${delayMs / 1000}s\n`));
  }

  console.log(chalk.red('────────────────────────────────────────────'));
  console.log(chalk.red('✍️  Scrie "gata" când ai terminat TOT.\n'));

  while (true) {
    const ready = await ask(chalk.red('👉 Tastează aici: '));
    if (ready.toLowerCase() === 'gata') break;
  }

  // ── AUTO-RESPONDER ────────────────────────────────────────────────────────
  console.log(chalk.red('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.red('🤖 Vrei auto-responder în acest script?'));
  console.log(chalk.red('   1 — Da'));
  console.log(chalk.red('   2 — Nu'));
  console.log(chalk.red('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

  const arChoice = await ask(chalk.red('👉 Alegerea ta (1 sau 2): '));

  if (arChoice.trim() === '1') {
    console.log(chalk.red('\n⚙️  Configurare AUTO-RESPONDER:\n'));

    const arTxtPath = await ask(chalk.red('📄 Introdu calea fișierului TXT pentru auto-responder: '));
    if (!fs.existsSync(arTxtPath)) {
      console.error(chalk.red('❌ Fișierul auto-responder nu există. Continuăm fără auto-responder.'));
    } else {
      console.log(chalk.red('\n📬 Mod trimitere auto-responder:'));
      console.log(chalk.red('   1 — Linie cu linie (fiecare sender primește următoarea linie la fiecare mesaj)'));
      console.log(chalk.red('   2 — Text întreg (trimite tot fișierul la fiecare mesaj primit)\n'));
      const arModeRaw  = await ask(chalk.red('Selectează modul (1 sau 2): '));
      const arSendMode = arModeRaw.trim() === '2' ? 2 : 1;

      const arDelayRaw = await ask(chalk.red('⏱️  Delay înainte de răspuns în secunde (ex: 2): '));
      const arDelayMs  = (parseFloat(arDelayRaw) || 2) * 1000;

      autoResponder.enabled  = true;
      autoResponder.txtPath  = arTxtPath;
      autoResponder.sendMode = arSendMode;
      autoResponder.delayMs  = arDelayMs;

      console.log(chalk.red('\n✅ Auto-responder configurat:'));
      console.log(chalk.red(`   📝 TXT   : ${arTxtPath}`));
      console.log(chalk.red(`   📬 Mod   : ${arSendMode === 1 ? 'Linie cu linie' : 'Text întreg'}`));
      console.log(chalk.red(`   ⏱️  Delay : ${arDelayMs / 1000}s`));
      console.log(chalk.red('   🖊️  Cât aștepți răspunsul, contactul vede "tastează..." tot timpul.\n'));
    }
  } else {
    console.log(chalk.red('\n⏭️  Auto-responder dezactivat (typing-ul rămâne activ).\n'));
  }

  // ── TYPING INDICATOR ──────────────────────────────────────────────────────
  console.log(chalk.red('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.red('🖊️  TYPING INDICATOR — mereu ACTIV la orice mesaj primit'));
  console.log(chalk.red('    (DM sau grup, text sau media — orice mesaj primit)'));
  console.log(chalk.red('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

  const holdRaw = await ask(chalk.red('⏱️  Câte secunde ține "tastează..." când NU răspunzi (default 4): '));
  typingCfg.holdMs = (parseFloat(holdRaw) || 4) * 1000;

  console.log(chalk.red('\n🖊️  Vrei "tastează..." și înainte de mesajele din bulk sender?'));
  console.log(chalk.red('   1 — Da (recomandat, arată natural)'));
  console.log(chalk.red('   2 — Nu\n'));
  const bulkTypingRaw = await ask(chalk.red('👉 Alegerea ta (1 sau 2): '));
  typingCfg.onBulk = bulkTypingRaw.trim() !== '2';

  if (typingCfg.onBulk) {
    const maxRaw = await ask(chalk.red('⏱️  Durata MAXIMĂ de tastare per mesaj în secunde (default 6): '));
    typingCfg.bulkMaxMs = (parseFloat(maxRaw) || 6) * 1000;
    if (typingCfg.bulkMaxMs < typingCfg.bulkMinMs) typingCfg.bulkMinMs = typingCfg.bulkMaxMs;
    console.log(chalk.red('   ℹ️  Durata reală se calculează din lungimea textului, plafonată la maxim.\n'));
  } else {
    console.log('');
  }

  rl.close();

  // Acum atasam listener-ele — typing + auto-responder — inainte de bulk sender.
  attachHandlers(getClient());

  // ── SUMMARY ───────────────────────────────────────────────────────────────
  console.log(chalk.red('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.red(`📤 Destinatari configurați: ${recipients.length}`));
  recipients.forEach((r, idx) => {
    console.log(chalk.red(`\n[${idx + 1}] ${r.number}`));
    console.log(chalk.red(`   📝 TXT   : ${r.txtPath}`));
    console.log(chalk.red(`   📬 Mod   : ${r.sendMode === 1 ? 'Linie cu linie' : 'Text întreg'}`));
    console.log(chalk.red(`   ⏱️  Delay : ${r.delayMs / 1000}s`));
  });
  if (autoResponder.enabled) {
    console.log(chalk.red('\n🤖 AUTO-RESPONDER: ACTIV'));
    console.log(chalk.red(`   📝 TXT   : ${autoResponder.txtPath}`));
    console.log(chalk.red(`   📬 Mod   : ${autoResponder.sendMode === 1 ? 'Linie cu linie' : 'Text întreg'}`));
    console.log(chalk.red(`   ⏱️  Delay : ${autoResponder.delayMs / 1000}s`));
  } else {
    console.log(chalk.red('\n🤖 AUTO-RESPONDER: INACTIV'));
  }
  console.log(chalk.red('\n🖊️  TYPING INDICATOR: ACTIV'));
  console.log(chalk.red(`   📩 La orice mesaj primit : "tastează..." instant`));
  console.log(chalk.red(`   ⏱️  Ținut fără răspuns    : ${typingCfg.holdMs / 1000}s`));
  console.log(chalk.red(`   🔁 Reîmprospătat la      : ${TYPING_REFRESH_MS / 1000}s (WhatsApp îl expiră la ~10s)`));
  console.log(chalk.red(`   📤 La bulk sender        : ${typingCfg.onBulk ? 'DA (max ' + typingCfg.bulkMaxMs / 1000 + 's/mesaj)' : 'NU'}`));

  console.log(chalk.red('\n🔁 Fiecare destinatar are LOOP INFINIT PROPRIU, ASINCRON.'));
  console.log(chalk.red('🤖 Auto-responder + typing ascultă SIMULTAN, complet asincron.'));
  console.log(chalk.red('🛑 CTRL+C pentru oprire.'));
  console.log(chalk.red('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

  process.on('SIGINT', () => {
    running = false;
    console.log(chalk.red(`\n\n🛑 Script oprit. Total mesaje trimise: ${totalSent}\n`));
    try { typing.stopAll(); } catch (_) {}          // curatam "tastează..." din toate chat-urile
    try { getClient().setOnline(false); } catch (_) {}
    try { getClient().disconnect(); } catch (_) {}
    process.exit(0);
  });

  // Pornim toti workerii asincron simultan
  recipients.forEach(r => startRecipientWorker(r));

  // Tinem procesul viu
  while (running) {
    await sleep(1000);
  }

  try { typing.stopAll(); } catch (_) {}
  try { getClient().disconnect(); } catch (_) {}
  console.log(chalk.red('✅ Script încheiat.'));
}

main().catch(err => {
  console.error(chalk.red('💥 Eroare fatală: ' + (err && err.message)));
  process.exit(1);
});
