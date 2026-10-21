'use strict';

const wa = require('whalibmob');

const {
  WhalibmobClient,
  makeCacheableSignalKeyStore,
  addTransactionCapability,
  assertMeId,
  loadStore,
  SignalStore
} = wa;

const storeFileFor = wa.storeFileFor ||
  ((base, phone) => require('path').join(base, phone + '.json'));
const webStoreFileFor = wa.webStoreFileFor ||
  ((base, phone) => require('path').join(base, phone + '.web.json'));

const readline = require('readline');
const path     = require('path');
const fs       = require('fs');
const chalk    = require('chalk');

const rl = readline.createInterface({
  input:  process.stdin,
  output: process.stdout
});

function ask(question) {
  return new Promise(resolve =>
    rl.question(question, ans => resolve(ans.replace(/[\x00-\x1F\x7F ﻿]/g, '').trim()))
  );
}

function parseDelay(raw, fallbackSec) {
  const clean = String(raw).replace(/[^\d.]/g, '');
  if (clean === '') return fallbackSec * 1000;
  const n = parseFloat(clean);
  return isNaN(n) ? fallbackSec * 1000 : n * 1000;
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

function banner() {
  console.log(chalk.red('\n╔══════════════════════════════════════════════╗'));
  console.log(chalk.red('║                                              ║'));
  console.log(chalk.red('║       GYOVANNY WHATSAPP SCRIPT v3.5          ║'));
  console.log(chalk.red('║   MULTI-DEST + AUTO-RESPONDER ASINCRON       ║'));
  console.log(chalk.red('║   RASPUNDE PESTE TOT: DM + TOATE GRUPURILE   ║'));
  console.log(chalk.red('║   + TCTOKEN PRE-WARM LA CONECTARE            ║'));
  console.log(chalk.red('║                                              ║'));
  console.log(chalk.red('╚══════════════════════════════════════════════╝\n'));
}

// =============================================================================
//  HELPERE JID
// =============================================================================
function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

function userOf(jid) {
  if (!jid) return '';
  return String(jid).split('@')[0].split(':')[0];
}

function shortJid(jid) {
  return String(jid || '')
    .replace('@s.whatsapp.net', '')
    .replace('@lid', ' (lid)')
    .replace('@g.us', ' (grup)');
}

function pnToJid(spn) {
  if (!spn) return null;
  if (typeof spn === 'string') return spn;
  if (spn.user && spn.server) return spn.user + '@' + spn.server;
  return null;
}

function senderJidOf(msg) {
  const spn = pnToJid(msg && msg.node && msg.node.attrs && msg.node.attrs.sender_pn);
  if (spn) return spn;
  if (msg.isGroup) return msg.participant || null;
  return msg.from || msg.participant || (msg.key && msg.key.remoteJid) || null;
}

function replyTargetOf(msg) {
  if (msg.isGroup || isGroupJid(msg.from)) return msg.from;
  return senderJidOf(msg) || msg.from || null;
}

function textOf(msg) {
  if (typeof msg.text === 'string') return msg.text;
  const d = msg.decoded;
  if (!d) return '';
  if (typeof d.text === 'string') return d.text;
  if (typeof d.caption === 'string') return d.caption;
  return '';
}

// =============================================================================
//  VERIFICARE SESIUNE
// =============================================================================
function verifySession(sessFile) {
  if (!fs.existsSync(sessFile)) {
    console.log(chalk.red(`⚠️  Fișierul de sesiune nu există: ${sessFile}`));
    console.log(chalk.red('   Prima conectare va crea sesiunea automat.'));
    return false;
  }
  try {
    const store = loadStore(sessFile);
    const jid   = assertMeId(store);
    console.log(chalk.red(`✅ Sesiune validă detectată pentru: ${jid}`));
    return true;
  } catch (err) {
    console.log(chalk.red(`⚠️  Sesiunea există dar nu e validă: ${err.message}`));
    console.log(chalk.red('   Se va recrea la prima conectare.'));
    return false;
  }
}

// =============================================================================
//  BUILD SIGNAL STORE STACK
// =============================================================================
function buildSignalStoreStack(sessFile) {
  try {
    const signalStore = new SignalStore();
    signalStore.attachFile(sessFile);
    const cachedStore = makeCacheableSignalKeyStore(signalStore);
    const txnStore    = addTransactionCapability(cachedStore);
    console.log(chalk.red('✅ Signal store stack construit: SignalStore → Cache(5min TTL) → TransactionCapability'));
    return { signalStore, cachedStore, txnStore };
  } catch (err) {
    console.log(chalk.red(`⚠️  Signal store stack nu a putut fi construit: ${err.message}`));
    console.log(chalk.red('   WhalibmobClient va folosi store-ul intern (comportament normal).'));
    return null;
  }
}

// =============================================================================
//  REFERINTA MUTABILA CLIENT
// =============================================================================
const clientRef = { current: null };
const getClient = () => clientRef.current;

// =============================================================================
//  TCTOKEN — evidenta + PRE-WARM
//
//  Whalibmob incarca automat {phone}.tctoken.json din sessionDir la init().
//  ensureTcTokenBeforeSend() este apelat SI de sendText() intern, dar noi il
//  apelam explicit inainte sa logam, ca log-ul sa reflecte realitatea.
//  Pre-warm la conectare: emitem tokenuri pentru toti destinatarii din timp,
//  astfel primul mesaj pleaca garantat cu tcToken atasat.
// =============================================================================
const tcTokens  = new Map();
let   tcLogFile = null;

function tcTokenBytes(tokenNode) {
  const c = tokenNode && tokenNode.content;
  if (Buffer.isBuffer(c))                    return c;
  if (ArrayBuffer.isView(c))                 return Buffer.from(c);
  if (typeof c === 'string' && c.length)     return Buffer.from(c, 'base64');
  return null;
}

function persistTcTokens() {
  if (!tcLogFile) return;
  try {
    const out = {};
    for (const [jid, e] of tcTokens) {
      out[jid] = { bytes: e.bytes, primite: e.count, ultima: new Date(e.at).toISOString() };
    }
    fs.writeFileSync(tcLogFile, JSON.stringify(out, null, 2));
  } catch (e) {
    console.error(chalk.red('⚠️  [TCTOKEN] Nu pot salva evidenta: ' + e.message));
  }
}

function recordTcToken(jid, bytes) {
  const prev  = tcTokens.get(jid);
  const entry = { bytes: bytes.length, at: Date.now(), count: (prev ? prev.count : 0) + 1 };
  tcTokens.set(jid, entry);
  console.log(chalk.red(
    `🔑 [TCTOKEN] Primit de la ${shortJid(jid)} — salvat, ${bytes.length} bytes` +
    (entry.count > 1 ? `  (al ${entry.count}-lea de la el)` : '')
  ));
  persistTcTokens();
  return entry;
}

const TC_FLAG = Symbol.for('gyovanny.tcTokenWatcher');

function attachTcTokenWatcher(client) {
  if (!client || client[TC_FLAG]) return;
  client[TC_FLAG] = true;

  client.on('notification', (n) => {
    try {
      if (!n || n.type !== 'privacy_token') return;
      const attrs = n.attrs || {};
      const node  = n.node  || {};

      const rawFrom = String(attrs.from || '');
      const rawLid  = attrs.sender_lid ? String(attrs.sender_lid) : null;
      let jid = (rawLid && rawLid.endsWith('@lid')) ? rawLid : rawFrom;
      try {
        const c = getClient();
        if (c && typeof c._resolveTcTokenJid === 'function') jid = c._resolveTcTokenJid(jid) || jid;
      } catch (_) {}

      const content    = Array.isArray(node.content) ? node.content : [];
      const tokensNode = content.find(x => x && x.description === 'tokens');
      const entries    = tokensNode && Array.isArray(tokensNode.content) ? tokensNode.content : [];

      let gasit = 0;
      for (const t of entries) {
        if (!t || t.description !== 'token') continue;
        if ((t.attrs || {}).type !== 'trusted_contact') continue;
        const bytes = tcTokenBytes(t);
        if (bytes && bytes.length) { recordTcToken(jid, bytes); gasit++; }
      }
      if (!gasit) {
        console.log(chalk.red(`🔑 [TCTOKEN] Notificare de la ${shortJid(jid)} fara bytes de token.`));
      }
    } catch (e) {
      console.error(chalk.red('⚠️  [TCTOKEN] handler: ' + e.message));
    }
  });

  console.log(chalk.red('🔑 [TCTOKEN] Urmaresc token-urile primite...'));
}

// Returneaza tokenul live din store (dupa rezolvare JID).
function tcTokenPentru(jid) {
  try {
    const c = getClient();
    if (c && typeof c._tcTokenFor === 'function') return c._tcTokenFor(jid);
  } catch (_) {}
  return null;
}

// Rezolva JID-ul de tcToken (LID vs phone, fara device suffix).
function resolveTcJid(jid) {
  try {
    const c = getClient();
    if (c && typeof c._resolveTcTokenJid === 'function') return c._resolveTcTokenJid(jid) || jid;
  } catch (_) {}
  return jid;
}

// =============================================================================
//  ENSURE + LOG TCTOKEN (async)
//
//  Apeleaza ensureTcTokenBeforeSend() pentru a garanta ca tokenul e emis
//  (sau incarcat din fisier) INAINTE de trimitere, apoi logheaza statusul real.
//  Grupurile nu au tcToken (sunt multi-participant, nu contact de incredere).
// =============================================================================
async function ensureAndLogTcToken(eticheta, jid) {
  if (isGroupJid(jid)) {
    console.log(chalk.red(`📎 ${eticheta} grup — fără tcToken (normal pentru grupuri)`));
    return;
  }
  const c = getClient();
  if (c && typeof c.ensureTcTokenBeforeSend === 'function') {
    try {
      const tcJid = resolveTcJid(jid);
      await c.ensureTcTokenBeforeSend(tcJid, jid);
    } catch (_) {}
  }
  const t = tcTokenPentru(jid);
  if (t && t.length) {
    console.log(chalk.red(`📎 ${eticheta} tcToken ATAȘAT pentru ${shortJid(jid)} (${t.length} bytes)`));
  } else {
    console.log(chalk.red(`📭 ${eticheta} FĂRĂ tcToken pentru ${shortJid(jid)} — mesajul pleacă fără`));
  }
}

// =============================================================================
//  PRE-WARM TCTOKEN pentru toti destinatarii
//
//  Apelat imediat dupa conectare, inainte de bulk/auto-responder.
//  Whalibmob incarca automat {phone}.tctoken.json — daca tokenul e acolo si
//  live, ensureTcTokenBeforeSend returneaza instant (fara round-trip la server).
//  Daca nu e, emite IQ-ul acum si asteapta raspunsul, astfel primul mesaj
//  bulk pleaca cu token garantat.
// =============================================================================
async function preWarmTcTokens(jids) {
  const c = getClient();
  if (!c || typeof c.ensureTcTokenBeforeSend !== 'function') return;

  console.log(chalk.red('\n🔑 [TCTOKEN PRE-WARM] Pregătesc tokenurile pentru toți destinatarii...\n'));

  const tasks = jids
    .filter(jid => !isGroupJid(jid))
    .map(async (jid) => {
      try {
        const tcJid = resolveTcJid(jid);
        const ok = await c.ensureTcTokenBeforeSend(tcJid, jid);
        if (ok) {
          const t = tcTokenPentru(jid);
          const src = t ? `${t.length} bytes` : '?';
          console.log(chalk.red(`   ✅ ${shortJid(jid)} — tcToken READY (${src})`));
        } else {
          console.log(chalk.red(`   ⚠️  ${shortJid(jid)} — tcToken nu a putut fi obținut (primul mesaj merge fără)`));
        }
      } catch (err) {
        console.log(chalk.red(`   ❌ ${shortJid(jid)} — eroare pre-warm: ${err.message}`));
      }
    });

  await Promise.all(tasks);
  console.log(chalk.red('\n🔑 [TCTOKEN PRE-WARM] Gata. Primul mesaj va pleca cu tcToken.\n'));
}

// =============================================================================
//  CREARE CLIENT
// =============================================================================
async function createClient(myPhone, sessionDir) {
  const sessFile = storeFileFor(sessionDir, myPhone);

  verifySession(sessFile);
  buildSignalStoreStack(sessFile);

  const client = new WhalibmobClient({ sessionDir });
  attachTcTokenWatcher(client);

  await new Promise((resolve, reject) => {

    client.on('connected', () => {
      console.log(chalk.red('✅ Conectat cu succes!\n'));
      resolve();
    });

    client.on('auth_failure', ({ reason }) => {
      console.error(chalk.red(`❌ AUTH FAILURE: ${reason}`));
      const webJson = webStoreFileFor(sessionDir, myPhone);
      if (fs.existsSync(webJson)) {
        try { fs.rmSync(webJson, { force: true }); } catch (_) {}
        console.log(chalk.red('🗑️  Sesiunea web coruptă a fost ștearsă.'));
      }
      reject(new Error('Auth failure: ' + reason));
    });

    client.on('client_rejected', (info) => {
      console.error(chalk.red('⛔ CLIENT REJECTED: ' + (info && (info.reason || info.code) || '')));
      console.error(chalk.red('   Rulează:  wa refresh-version --all   apoi reporneste scriptul.'));
    });

    client.on('identity_change', ({ user }) => {
      console.log(chalk.red(`🔐 Contact re-înregistrat: ${user} — sesiunile lui au fost curățate.`));
    });

    client.on('reconnecting', ({ attempt, delay }) => {
      const delaySec = delay ? (delay / 1000).toFixed(1) : '?';
      console.log(chalk.red(`🔄 Reconectare automată (tentativa #${attempt || '?'}, delay: ${delaySec}s)...`));
    });

    client.on('reconnected', () => {
      console.log(chalk.red('✅ Reconectat automat de library cu succes!'));
    });

    client.on('error', (err) => {
      console.error(chalk.red('⚠️  Eroare client: ' + (err.message || err)));
    });

    client.on('disconnected', () => {
      console.log(chalk.red('⚠️  Conexiune pierdută. Library-ul încearcă reconectare automată cu backoff...'));
    });

    client.on('decrypt_error', ({ id, from, participant, err }) => {
      console.error(chalk.red(`🔐 Eroare decriptare mesaj [id:${id}] de la ${from}${participant ? ' / ' + participant : ''}: ${err?.message || err}`));
    });

    client.on('stream_error', ({ reason }) => {
      console.error(chalk.red(`🌊 STREAM ERROR: ${reason}`));
    });

    client.on('session_refresh', () => {
      console.log(chalk.red('🔄 Session Signal refresh primit — chei re-sincronizate.'));
    });

    client.on('number_corrected', ({ from, to }) => {
      console.log(chalk.red(`📞 Număr corectat automat: ${from} → ${to} (sesiunea a fost actualizată)`));
    });

    client.init(myPhone).catch(reject);
  });

  return client;
}

// =============================================================================
//  RECONECTARE MANUALA
// =============================================================================
async function reconnect(currentClient, myPhone, sessionDir) {
  let attempts = 0;
  while (true) {
    attempts++;
    console.log(chalk.red(`🔄 Reconectare manuală #${attempts}...`));
    try {
      try { currentClient && currentClient.disconnect(); } catch (_) {}
      const newClient = await createClient(myPhone, sessionDir);
      clientRef.current = newClient;
      applyPushName(newClient);
      if (autoResponder.enabled) attachAutoResponder(newClient, myPhone, sessionDir);
      console.log(chalk.red('✅ Reconectat manual cu succes!'));
      return newClient;
    } catch (err) {
      console.error(chalk.red(`❌ Reconectare manuală eșuată: ${err.message}. Retry în 10s...`));
      await sleep(10000);
    }
  }
}

// =============================================================================
//  PUSH NAME + PREZENTA
// =============================================================================
const account = {
  pushName:      null,
  presenceTimer: null
};

function applyPushName(client, quiet) {
  if (!client || !account.pushName) return false;
  try {
    client.changeName(account.pushName);
    if (!quiet) {
      console.log(chalk.red(`👤 Nume cont setat pe WhatsApp: "${account.pushName}"`));
    }
    return true;
  } catch (err) {
    console.error(chalk.red(`⚠️  Nu am putut seta numele contului: ${err.message}`));
    return false;
  }
}

const PRESENCE_REFRESH_MS = 5 * 60 * 1000;

function startPresenceKeepAlive() {
  if (account.presenceTimer) clearInterval(account.presenceTimer);
  account.presenceTimer = setInterval(() => {
    const c = getClient();
    if (!c) return;
    applyPushName(c, true);
  }, PRESENCE_REFRESH_MS);
  console.log(chalk.red(`🔁 Prezenta se reanunta automat la fiecare ${PRESENCE_REFRESH_MS / 60000} minute.`));
}

// =============================================================================
//  AUTO-RESPONDER STATE
// =============================================================================
const autoResponder = {
  enabled:    false,
  txtPath:    null,
  sendMode:   1,
  delayMs:    3000,
  chatState:  {},
  replied:    0
};

const chatQueues = new Map();

function enqueue(chatJid, task) {
  const prev = chatQueues.get(chatJid) || Promise.resolve();
  const next = prev.then(task).catch(err => {
    console.error(chalk.red(`⚠️  [AUTO-RESPONDER] ${shortJid(chatJid)}: ${err.message}`));
  });
  chatQueues.set(chatJid, next);
  return next;
}

function isOwnMessage(msg, myPhone, client) {
  const candidates = [
    senderJidOf(msg),
    msg.participant,
    pnToJid(msg.node && msg.node.attrs && msg.node.attrs.participant_pn)
  ].filter(Boolean).map(userOf);

  if (!candidates.length) return false;

  const mine = new Set([String(myPhone)]);
  try {
    if (client && client._myLid)               mine.add(userOf(client._myLid));
    if (client && client._store && client._store.me) {
      if (client._store.me.id)  mine.add(userOf(client._store.me.id));
      if (client._store.me.lid) mine.add(userOf(client._store.me.lid));
    }
  } catch (_) {}

  return candidates.some(u => mine.has(u));
}

// =============================================================================
//  TRIMITERE CU RETRY — auto-responder
//  ensureAndLogTcToken apelat INAINTE de sendText (garanteaza token la primul mesaj)
// =============================================================================
async function autoSend(targetJid, text, myPhone, sessionDir) {
  let retries = 0;
  while (true) {
    try {
      await ensureAndLogTcToken('[AUTO-RESPONDER]', targetJid);
      await getClient().sendText(targetJid, text);
      autoResponder.replied++;
      const preview = text.length > 60 ? text.substring(0, 60) + '...' : text;
      console.log(chalk.red(`✅ [AUTO-RESPONDER] Răspuns → ${shortJid(targetJid)} : ${preview}`));
      return;
    } catch (err) {
      retries++;
      console.error(chalk.red(`❌ [AUTO-RESPONDER] Eroare trimitere (attempt ${retries}): ${err.message}`));
      if (retries >= 3) {
        await reconnect(getClient(), myPhone, sessionDir);
        retries = 0;
      } else {
        await sleep(3000);
      }
    }
  }
}

// =============================================================================
//  ATASARE LISTENER AUTO-RESPONDER
// =============================================================================
const AR_FLAG = Symbol.for('gyovanny.autoResponderAttached');

function attachAutoResponder(client, myPhone, sessionDir) {
  if (!client || client[AR_FLAG]) return;
  client[AR_FLAG] = true;

  client.on('message', (msg) => {
    try {
      if (!autoResponder.enabled) return;

      const inGroup = !!(msg.isGroup || isGroupJid(msg.from));

      if (isOwnMessage(msg, myPhone, client)) return;

      const target = replyTargetOf(msg);
      if (!target) return;

      if (String(target).startsWith('status@')) return;

      const who  = shortJid(senderJidOf(msg) || target);
      const body = textOf(msg);
      const kind = inGroup ? 'GRUP' : 'DM';
      const snip = body ? ' « ' + (body.length > 40 ? body.slice(0, 40) + '…' : body) + ' »' : '';
      console.log(chalk.red(`\n📩 [AUTO-RESPONDER][${kind}] ${who} în ${shortJid(target)}${snip} — pregătesc răspuns...`));

      enqueue(target, async () => {
        await sleep(autoResponder.delayMs);
        if (!autoResponder.enabled || !autoResponder.txtPath) return;

        if (autoResponder.sendMode === 2) {
          let fullText;
          try { fullText = loadFullText(autoResponder.txtPath); }
          catch (e) {
            console.error(chalk.red(`⚠️  [AUTO-RESPONDER] Nu pot citi TXT: ${e.message}`));
            return;
          }
          if (!fullText) return;
          await autoSend(target, fullText, myPhone, sessionDir);
          return;
        }

        let lines;
        try { lines = loadLines(autoResponder.txtPath); }
        catch (e) {
          console.error(chalk.red(`⚠️  [AUTO-RESPONDER] Nu pot citi TXT: ${e.message}`));
          return;
        }
        if (!lines.length) return;

        if (!autoResponder.chatState[target]) autoResponder.chatState[target] = { lineIndex: 0 };
        const state = autoResponder.chatState[target];
        if (state.lineIndex >= lines.length) state.lineIndex = 0;
        const line = lines[state.lineIndex];
        state.lineIndex = (state.lineIndex + 1) % lines.length;

        await autoSend(target, line, myPhone, sessionDir);
      });
    } catch (e) {
      console.error(chalk.red('⚠️  [AUTO-RESPONDER] handler: ' + e.message));
    }
  });

  console.log(chalk.red('🤖 [AUTO-RESPONDER] Listener activ — răspund PESTE TOT (DM + toate grupurile)...\n'));
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
  console.log(chalk.red(`✅ Numere expeditori detectate: ${myPhones.join(', ')}\n`));

  const authAnswer = await ask(chalk.red('📂 Folder de autentificare [Enter = .waSession]: '));
  const sessionDir = authAnswer
    ? path.resolve(authAnswer.startsWith('/') || authAnswer.startsWith('.')
        ? authAnswer
        : path.join(__dirname, authAnswer))
    : path.join(__dirname, '.waSession');

  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
  tcLogFile = path.join(sessionDir, 'tctokens-primite.json');
  console.log(chalk.red(`📂 Session dir: ${sessionDir}`));
  console.log(chalk.red(`🔑 Evidență tcToken: ${tcLogFile}`));

  // Afiseaza fisierele tctoken.json existente din sessionDir
  try {
    const existingTcFiles = fs.readdirSync(sessionDir)
      .filter(f => f.endsWith('.tctoken.json'));
    if (existingTcFiles.length > 0) {
      console.log(chalk.red(`🔑 Fișiere tcToken existente în sesiune: ${existingTcFiles.join(', ')}`));
      console.log(chalk.red('   → Whalibmob le va încărca automat la init(). Primul mesaj va fi cu token.\n'));
    } else {
      console.log(chalk.red('   → Niciun fișier tcToken existent. Se emit tokenuri noi după conectare.\n'));
    }
  } catch (_) {}

  const myPhone = myPhones[0];
  console.log(chalk.red(`🔌 Conectare cu numărul principal: ${myPhone}...\n`));

  const client = await createClient(myPhone, sessionDir);
  clientRef.current = client;

  // ===========================================================================
  //  PUSH NAME
  // ===========================================================================
  console.log(chalk.red('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.red('👤 Numele contului pe WhatsApp (push name)'));
  console.log(chalk.red('   Acesta e numele pe care il vad ceilalti cand le scrii.'));
  console.log(chalk.red('   Lasat gol, contul ramane anuntat ca "User".'));
  console.log(chalk.red('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

  while (true) {
    const nameAnswer = await ask(chalk.red('👤 Numele contului: '));
    const wanted = nameAnswer.trim();

    if (!wanted) {
      const skip = await ask(chalk.red('⚠️  Nume gol. Continui fara sa-l schimbi? (da/nu): '));
      if (/^d(a)?$/i.test(skip.trim())) {
        console.log(chalk.red('⏭️  Numele contului ramane neschimbat.\n'));
        break;
      }
      continue;
    }

    if (wanted.length > 25) {
      console.log(chalk.red('❌ Numele e prea lung (maxim 25 de caractere). Incearca din nou.'));
      continue;
    }

    account.pushName = wanted;
    if (applyPushName(client)) {
      console.log(chalk.red('✅ Numele a fost anuntat serverului impreuna cu prezenta.\n'));
      startPresenceKeepAlive();
    } else {
      account.pushName = null;
      console.log(chalk.red('⚠️  Continui fara schimbarea numelui.\n'));
    }
    break;
  }

  console.log(chalk.red('📨 Introdu destinatarii pentru bulk separați prin virgulă:'));
  console.log(chalk.red('   Numere: 40731384494, 49987654321'));
  console.log(chalk.red('   Grupuri: 120363123456789012@g.us'));
  console.log(chalk.red('   (Enter = fără bulk, doar auto-responder)\n'));
  const toRaw = await ask(chalk.red('📨 Destinatari: '));

  const recipients = toRaw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(entry => {
      if (isGroupJid(entry)) {
        return { number: entry, jid: entry, isGroup: true, txtPath: null, sendMode: 1, delayMs: 3000 };
      }
      const digits = entry.replace(/\D/g, '');
      if (!/^\d{8,15}$/.test(digits)) return null;
      return { number: digits, jid: digits + '@s.whatsapp.net', isGroup: false, txtPath: null, sendMode: 1, delayMs: 3000 };
    })
    .filter(Boolean);

  if (recipients.length) {
    console.log(chalk.red(`✅ Destinatari valizi: ${recipients.map(r => r.number).join(', ')}\n`));
    console.log(chalk.red('⚙️  Acum configurăm FIECARE destinatar cu TXT, mod și delay propriu.\n'));

    for (let i = 0; i < recipients.length; i++) {
      const r = recipients[i];
      console.log(chalk.red('────────────────────────────────────────────'));
      console.log(chalk.red(`👤 Destinatar ${i + 1}/${recipients.length}: ${r.number}${r.isGroup ? ' (grup)' : ''}`));

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
      const delayMs  = parseDelay(delayRaw, 3);

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
  } else {
    console.log(chalk.red('⏭️  Fără bulk — rulăm doar auto-responderul.\n'));
  }

  // ===========================================================================
  //  AUTO-RESPONDER
  // ===========================================================================
  console.log(chalk.red('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.red('🤖 Vrei auto-responder în acest script?'));
  console.log(chalk.red('   (răspunde automat PESTE TOT: DM-uri + toate grupurile)'));
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
      console.log(chalk.red('   1 — Linie cu linie (fiecare chat primește următoarea linie la fiecare mesaj)'));
      console.log(chalk.red('   2 — Text întreg (trimite tot fișierul la fiecare mesaj primit)\n'));
      const arModeRaw  = await ask(chalk.red('Selectează modul (1 sau 2): '));
      const arSendMode = arModeRaw.trim() === '2' ? 2 : 1;

      const arDelayRaw = await ask(chalk.red('⏱️  Delay înainte de răspuns în secunde (ex: 2): '));
      const arDelayMs  = parseDelay(arDelayRaw, 2);

      autoResponder.enabled  = true;
      autoResponder.txtPath  = arTxtPath;
      autoResponder.sendMode = arSendMode;
      autoResponder.delayMs  = arDelayMs;

      console.log(chalk.red('\n✅ Auto-responder configurat:'));
      console.log(chalk.red(`   📝 TXT      : ${arTxtPath}`));
      console.log(chalk.red('   💬 Unde     : PESTE TOT — toate DM-urile și toate grupurile'));
      console.log(chalk.red(`   📬 Mod      : ${arSendMode === 1 ? 'Linie cu linie (per chat)' : 'Text întreg'}`));
      console.log(chalk.red(`   ⏱️  Delay    : ${arDelayMs / 1000}s\n`));

      attachAutoResponder(client, myPhone, sessionDir);
    }
  } else {
    console.log(chalk.red('\n⏭️  Auto-responder dezactivat.\n'));
  }

  rl.close();

  // ===========================================================================
  //  PRE-WARM TCTOKEN pentru toti destinatarii bulk (inainte de a incepe)
  //  Whalibmob incarca {phone}.tctoken.json automat — daca tokenul e acolo
  //  si live, ensureTcTokenBeforeSend returneaza instant, fara round-trip.
  //  Daca nu e, emite IQ acum, asteapta, si primul mesaj pleaca cu token.
  // ===========================================================================
  if (recipients.length > 0) {
    const bulkJids = recipients.map(r => r.jid);
    await preWarmTcTokens(bulkJids);
  }

  // ===========================================================================
  //  SUMMARY
  // ===========================================================================
  console.log(chalk.red('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.red(`📤 Destinatari configurați: ${recipients.length}`));
  recipients.forEach((r, idx) => {
    console.log(chalk.red(`\n[${idx + 1}] ${r.number}${r.isGroup ? ' (grup)' : ''}`));
    console.log(chalk.red(`   📝 TXT   : ${r.txtPath}`));
    console.log(chalk.red(`   📬 Mod   : ${r.sendMode === 1 ? 'Linie cu linie' : 'Text întreg'}`));
    console.log(chalk.red(`   ⏱️  Delay : ${r.delayMs / 1000}s`));
  });
  if (autoResponder.enabled) {
    console.log(chalk.red('\n🤖 AUTO-RESPONDER: ACTIV'));
    console.log(chalk.red('   💬 Unde     : PESTE TOT — toate DM-urile și toate grupurile'));
    console.log(chalk.red(`   📝 TXT      : ${autoResponder.txtPath}`));
    console.log(chalk.red(`   📬 Mod      : ${autoResponder.sendMode === 1 ? 'Linie cu linie (per chat)' : 'Text întreg'}`));
    console.log(chalk.red(`   ⏱️  Delay    : ${autoResponder.delayMs / 1000}s`));
  }
  if (account.pushName) {
    console.log(chalk.red(`\n👤 NUME CONT: "${account.pushName}" (anuntat + reanuntat la ${PRESENCE_REFRESH_MS / 60000} min)`));
  } else {
    console.log(chalk.red('\n👤 NUME CONT: neschimbat'));
  }
  console.log(chalk.red('\n🔐 Signal Store: Cache(5min TTL) + TransactionCapability ACTIVE'));
  console.log(chalk.red('🔑 TCTOKEN: pre-warm activ — primul mesaj pleacă CU token'));
  console.log(chalk.red('🔁 Fiecare destinatar are LOOP INFINIT PROPRIU, ASINCRON.'));
  console.log(chalk.red('🤖 Auto-responder ascultă SIMULTAN — DM + grupuri, coadă separată per chat.'));
  console.log(chalk.red('🔄 Reconectare automată cu exponential backoff (1s→2s→4s→8s→15s→30s)'));
  console.log(chalk.red('🛑 CTRL+C pentru oprire.'));
  console.log(chalk.red('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

  let totalSent = 0;
  let running   = true;

  process.on('SIGINT', () => {
    running = false;
    if (account.presenceTimer) clearInterval(account.presenceTimer);
    console.log(chalk.red(`\n\n🛑 Script oprit. Bulk trimise: ${totalSent} | Auto-replies: ${autoResponder.replied}`));
    console.log(chalk.red(`🔑 tcToken-uri primite de la ${tcTokens.size} contact(e):`));
    for (const [jid, e] of tcTokens) {
      console.log(chalk.red(`   ${shortJid(jid)} — ${e.bytes} bytes, ${e.count} primite`));
    }
    console.log('');
    try { getClient().disconnect(); } catch (_) {}
    process.exit(0);
  });

  // ===========================================================================
  //  SAFE SEND (bulk)
  //  ensureAndLogTcToken apelat INAINTE de sendText — garanteaza token
  // ===========================================================================
  async function safeSend(jid, msg, label) {
    let retries = 0;
    while (true) {
      try {
        await ensureAndLogTcToken('[BULK]', jid);
        await getClient().sendText(jid, msg);
        totalSent++;
        const preview = msg.length > 60 ? msg.substring(0, 60) + '...' : msg;
        console.log(chalk.red(`✅ ${label} → ${shortJid(jid)} : ${preview}`));
        return;
      } catch (err) {
        retries++;
        console.error(chalk.red(`❌ ${label} Eroare (attempt ${retries}): ${err.message}`));
        if (retries >= 3) {
          console.log(chalk.red('🔄 Reconectare manuală din safeSend...'));
          await reconnect(getClient(), myPhone, sessionDir);
          retries = 0;
        } else {
          await sleep(3000);
        }
      }
    }
  }

  // ===========================================================================
  //  BULK SENDER — worker asincron per destinatar
  // ===========================================================================
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
            const msg   = lines[i];
            const label = chalk.red(`[${recipient.number} R${round} ${i + 1}/${lines.length}]`);
            await safeSend(recipient.jid, msg, label);
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
          await safeSend(recipient.jid, fullText, label);
          await sleep(recipient.delayMs);
        }
      }
    })();
  }

  recipients.forEach(r => startRecipientWorker(r));

  while (running) {
    await sleep(1000);
  }

  try { getClient().disconnect(); } catch (_) {}
  console.log(chalk.red('✅ Script încheiat.'));
}

main().catch(err => {
  console.error(chalk.red('💥 Eroare fatală: ' + err.message));
  process.exit(1);
});
