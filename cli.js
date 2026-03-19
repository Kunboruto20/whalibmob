#!/usr/bin/env node
'use strict';

// Load .env from the current working directory (silently — no error if missing).
// This lets users configure WA_OS, WA_DEVICE, WA_VERSION etc. without touching
// their shell environment.  Must happen before any other require() so that
// process.env is fully populated when modules read it at load time.
try { require('dotenv').config(); } catch (_) {}

// Suppress internal [DBG] lines — keep console clean for users
const _origStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = function(chunk, enc, cb) {
  if (typeof chunk === 'string' && chunk.startsWith('[DBG]')) {
    if (typeof enc === 'function') enc(); else if (typeof cb === 'function') cb();
    return true;
  }
  return _origStderrWrite(chunk, enc, cb);
};

const path     = require('path');
const fs       = require('fs');
const readline = require('readline');
const os       = require('os');

const {
  WhalibmobClient,
  checkNumberStatus,
  requestSmsCode,
  verifyCode,
  assertRegistrationKeys,
  fetchWaVersion,
  getDeviceConfig,
  createNewStore,
  saveStore,
  loadStore
} = require('./lib/Client');

const VERSION = '5.1.15';

// ─── output helpers ───────────────────────────────────────────────────────────

const out  = (s) => process.stdout.write(s + '\n');
const warn = (s) => process.stderr.write('warning: ' + s + '\n');
const fail = (s) => { process.stderr.write('error: ' + s + '\n'); };

function kv(label, value) {
  out('  ' + label.padEnd(20) + '  ' + value);
}

function hr() { out('  ' + '─'.repeat(56)); }

// ─── helpers ──────────────────────────────────────────────────────────────────

function defaultSessionDir() {
  return path.join(os.homedir(), '.waSession');
}

function normalizePhone(s) {
  return String(s || '').replace(/^\+/, '').replace(/\D/g, '');
}

function normalizeJid(s) {
  if (!s) return null;
  s = String(s);
  if (s === 'status@broadcast') return s;
  if (s.includes('@')) return s;
  return s.replace(/^\+/, '').replace(/\D/g, '') + '@s.whatsapp.net';
}

function asGroupJid(s) {
  if (!s) return null;
  if (s.endsWith('@g.us')) return s;
  if (s.includes('@')) return s;
  return s + '@g.us';
}

const makeJid = normalizeJid;

function ts() {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

// ─── global state ─────────────────────────────────────────────────────────────

let _client  = null;
let _phone   = null;
let _sessDir = defaultSessionDir();
let _rl      = null;

// ─── shell help ───────────────────────────────────────────────────────────────

const HELP = `
  whalibmob v${VERSION}

  Messaging
    /send     <jid> <text>                    send text message
    /reply    <jid> <msgId> <senderJid> <text>  reply quoting a message
                                                  (senderJid = same as jid for DMs; member JID for groups)
    /image    <jid> <file> [caption]          send image
    /video    <jid> <file> [caption]          send video
    /audio    <jid> <file>                    send audio file
    /ptt      <jid> <file>                    send voice note
    /doc      <jid> <file> [name]             send document
    /sticker  <jid> <file>                    send sticker (.webp)
    /react    <jid> <msgId> <emoji>           react to a message
    /edit     <jid> <msgId> <text>            edit a sent message
    /delete   <jid> <msgId> [all]             delete message (add 'all' for everyone)
    /status   <text>                          post a Status/Story
    /forward  <jid> <text|msgObj>             forward text (or decoded msg) with forwarded flag
    /poll     <jid> <question> | <opt1> | <opt2> [selectable=N]  send a poll
    /location <jid> <lat> <lon> [name] [| address]              send a location pin
    /vcard    <jid> <name> <vcard-string>                        send a contact card (vCard)

  Presence
    /online                                  set yourself as online
    /offline                                 set yourself as offline
    /typing    <jid>                         show typing indicator
    /recording <jid>                         show recording indicator
    /stop      <jid>                         stop typing / recording
    /subscribe <jid>                         subscribe to contact's presence

  Profile
    /name    <text>                          change display name
    /about   <text>                          change own bio / about text
    /photo   <file>                          change own profile picture (JPEG)
    /privacy <type> <value>                  change privacy setting
                                               types:  last_seen profile_picture status
                                                       online read_receipts groups_add
                                               values: all contacts contact_blacklist
                                                       none match_last_seen

  Contacts
    /whatsapp  <phone...>                    check which numbers have WhatsApp
    /picture   <jid>                         get profile picture URL of a contact
    /contact about <jid>                     get bio/status text of a contact

  Chats
    /read      <jid>                         mark chat as read
    /unread    <jid>                         mark chat as unread
    /mute      <jid> [minutes]               mute (no minutes = indefinite)
    /unmute    <jid>                         unmute
    /pin       <jid>                         pin chat
    /unpin     <jid>                         unpin chat
    /archive   <jid>                         archive chat
    /unarchive <jid>                         unarchive chat
    /star      <jid> <msgId>                 star a message
    /unstar    <jid> <msgId>                 unstar a message
    /ephemeral         <jid> <seconds>        set disappearing timer for chat
    /ephemeral-default <seconds>             set default timer for ALL new chats
    /block     <jid>                         block contact
    /unblock   <jid>                         unblock contact
    /blocklist                               show blocked contacts

  Groups
    /group create  <name> <jid...>           create group
    /group leave   <jid>                     leave group
    /group add     <jid> <member...>         add participants
    /group remove  <jid> <member...>         remove participants
    /group promote <jid> <member...>         promote to admin
    /group demote  <jid> <member...>         demote from admin
    /group subject <jid> <name>              rename group
    /group desc    <jid> <text>              change description
    /group invite      <jid>                  get invite link
    /group revoke      <jid>                  revoke invite link
    /group join        <code>                 join by invite code
    /group invite-info <code|url>             preview group metadata from invite link
    /group photo       <jid> <file>           change group picture (JPEG)
    /group meta        <jid>                  query group metadata + participants
    /group participants <jid>                 list participants of a group
    /group pending      <jid>                 list pending join requests
    /group approve      <jid> <member...>     approve pending join requests
    /group reject       <jid> <member...>     reject pending join requests
    /group settings     <jid> <setting> <policy>
                                               settings: edit_group_info send_messages
                                                         add_participants approve_participants
                                               policies: admins all
    /groups                                  list ALL groups you are in (full metadata)

  Community
    /community create     <subject> [desc]           create a community
    /community deactivate <communityJid>             deactivate / delete a community
    /community link       <communityJid> <groupJid>  link a group into a community
    /community unlink     <communityJid> <groupJid>  unlink a group from a community

  Newsletter (Channels)
    /newsletter create  <name> [description]         create a channel
    /newsletter join    <jid>                         subscribe to a channel
    /newsletter leave   <jid>                         unsubscribe from a channel
    /newsletter info    <jid>                         query channel metadata
    /newsletter desc    <jid> <text>                  update channel description
    /newsletter post    <jid> <text>                  post a text update to your channel

  Business
    /biz <phone|jid>                                 query business profile

  Registration
    /reg check   <phone>                     check if number has WhatsApp
    /reg code    <phone> [sms|voice|wa_old]  request verification code
    /reg confirm <phone> <code>              complete registration

  Connection
    /connect    <phone>                      connect to WhatsApp
    /disconnect                              disconnect
    /reconnect                              force reconnection
    /session                                show session info

    /help                                   show this help
    /quit  /exit                            disconnect and exit
`.trim();

// ─── incoming event display ───────────────────────────────────────────────────

function attachEvents(client) {
  client.on('message', (msg) => {
    _rl && _rl.pause();
    out('');
    hr();
    kv('time',   ts());
    // sender_pn gives the real phone JID even when from is a LID
    const spn = msg.node && msg.node.attrs && msg.node.attrs.sender_pn;
    kv('from',   spn && spn.user ? spn.user + '@s.whatsapp.net' : msg.from);
    if (msg.participant && msg.participant !== msg.from) kv('sender', msg.participant);
    kv('id',     msg.id);

    const d = msg.decoded;
    if (d) {
      switch (d.type) {
        case 'text':
          kv('text', d.text);
          break;
        case 'image':
          kv('type', 'image' + (d.caption ? '  caption: ' + d.caption : ''));
          break;
        case 'video':
          kv('type', 'video' + (d.caption ? '  caption: ' + d.caption : ''));
          break;
        case 'audio':
          kv('type', 'audio');
          break;
        case 'voice':
          kv('type', 'voice note');
          break;
        case 'document':
          kv('type', 'document  file: ' + d.fileName);
          break;
        case 'sticker':
          kv('type', 'sticker');
          break;
        case 'reaction':
          kv('type', 'reaction  emoji: ' + d.emoji);
          break;
        case 'location':
          kv('type', 'location  lat: ' + d.latitude + '  lon: ' + d.longitude + (d.name ? '  name: ' + d.name : ''));
          break;
        case 'contact':
          kv('type', 'contact  name: ' + d.displayName);
          break;
        default:
          kv('type', d.type);
      }
    }

    out('');
    _rl && (_rl.resume(), _rl.prompt(true));
  });

  client.on('group_update', (u) => {
    _rl && _rl.pause();
    out('');
    hr();
    kv('group_update', u.groupJid);
    kv('type',         u.type);
    if (u.actor)        kv('by',      u.actor);
    if (u.participants && u.participants.length) kv('members', u.participants.join(', '));
    if (u.subject)      kv('subject', u.subject);
    kv('time',         new Date(u.timestamp * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''));
    out('');
    _rl && (_rl.resume(), _rl.prompt(true));
  });

  client.on('decrypt_error', (e) => {
    _rl && _rl.pause();
    out('  DECRYPT_ERROR  from ' + e.from + '  id ' + e.id + '  : ' + (e.err && e.err.message));
    _rl && (_rl.resume(), _rl.prompt(true));
  });

  client.on('node', (node) => {
    if (!node || !node.description) return;
    const tag = node.description;
    // Only log unexpected incoming nodes (not handled internally)
    _rl && _rl.pause();
    out('  RAW_NODE  <' + tag + '>  ' + JSON.stringify(node.attrs || {}));
    _rl && (_rl.resume(), _rl.prompt(true));
  });

  client.on('receipt', (r) => {
    _rl && _rl.pause();
    const label = r.type === 'read'     ? 'read'
                : r.type === 'delivery' ? 'delivered'
                : r.type === 'played'   ? 'played'
                : r.type;
    out('  receipt  ' + label + '  id: ' + r.id + '  from: ' + r.from);
    _rl && (_rl.resume(), _rl.prompt(true));
  });

  client.on('presence', (p) => {
    _rl && _rl.pause();
    const state = p.type === 'composing'  ? 'typing'
                : p.type === 'recording'  ? 'recording audio'
                : p.type === 'paused'     ? 'stopped typing'
                : p.available             ? 'online'
                : 'offline';
    out('  presence  ' + p.from + '  ' + state);
    _rl && (_rl.resume(), _rl.prompt(true));
  });

  client.on('reconnecting', ({ delay, attempt }) => {
    _rl && _rl.pause();
    out('  reconnecting  attempt=' + attempt + '  delay=' + (delay / 1000) + 's');
    _rl && (_rl.resume(), _rl.prompt(true));
  });

  client.on('reconnected', () => {
    _rl && _rl.pause();
    out('  reconnected');
    _rl && (_rl.resume(), _rl.prompt(true));
  });

  client.on('disconnected', () => {
    _rl && _rl.pause();
    out('  disconnected');
    _rl && (_rl.resume(), _rl.prompt(true));
  });

  client.on('auth_failure', (f) => {
    _rl && _rl.pause();
    fail('session revoked: ' + f.reason + ' — re-register with /reg code');
    _rl && (_rl.resume(), _rl.prompt(true));
  });

  client.on('error', (e) => {
    _rl && _rl.pause();
    fail(e.message || String(e));
    _rl && (_rl.resume(), _rl.prompt(true));
  });
}

// ─── readline setup ───────────────────────────────────────────────────────────

function openShell(prompt) {
  if (_rl) { try { _rl.close(); } catch (_) {} }
  _rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: prompt || 'wa> ' });
  _rl.on('line', (l) => handleLine(l.trim()));
  _rl.on('close', () => {
    if (_client) { try { _client.disconnect(); } catch (_) {} }
    process.exit(0);
  });
  process.removeAllListeners('SIGINT');
  process.on('SIGINT', () => {
    out('\ntype /quit to exit');
    process.removeAllListeners('SIGINT');
    process.on('SIGINT', () => { if (_client) _client.disconnect(); process.exit(0); });
    _rl.prompt();
  });
  return _rl;
}

// ─── connect helper ───────────────────────────────────────────────────────────

async function doConnect(phone) {
  phone = normalizePhone(phone);
  const client = new WhalibmobClient({ sessionDir: _sessDir });
  attachEvents(client);

  client.once('connected', () => {
    _client = client;
    _phone  = phone;
    out('connected as +' + phone);
    _rl.setPrompt('wa +' + phone + '> ');
    _rl.prompt();
  });

  client.once('auth_failure', () => {
    fail('auth failed — session revoked');
    out('use /reg code ' + phone + ' to re-register');
    _rl.prompt();
  });

  try {
    await client.init(phone);
    const keepAlive = setInterval(() => {}, 10000);
    client.once('connected',    () => clearInterval(keepAlive));
    client.once('auth_failure', () => clearInterval(keepAlive));
  } catch (e) {
    fail(e.message);
    out('register first with: /reg code ' + phone);
    _rl.prompt();
  }
}

// ─── guard ────────────────────────────────────────────────────────────────────

function requireConn() {
  if (!_client || !_client.connected) throw new Error('not connected — use /connect <phone>');
}

// ─── tokenizer ────────────────────────────────────────────────────────────────

function tokens(line) {
  const t = []; let b = '', q = false;
  for (const c of line) {
    if (c === '"' || c === "'") { q = !q; continue; }
    if (c === ' ' && !q) { if (b) { t.push(b); b = ''; } } else b += c;
  }
  if (b) t.push(b);
  return t;
}

// ─── command dispatch ─────────────────────────────────────────────────────────

async function handleLine(line) {
  if (!line) { _rl.prompt(); return; }
  const p   = tokens(line);
  const cmd = p[0] && p[0].toLowerCase();

  try {
    switch (cmd) {

      case '/help':
        out('\n' + HELP + '\n');
        break;

      case '/quit': case '/exit':
        out('disconnecting...');
        if (_client) { try { _client.disconnect(); } catch (_) {} }
        process.exit(0);

      case '/session':
        if (!_client || !_client.store) { fail('not connected'); break; }
        hr();
        kv('phone',   _client.store.phoneNumber);
        kv('name',    _client.store.pushName || _client.store.name || '—');
        kv('session', _sessDir);
        hr();
        break;

      case '/connect': {
        const ph = p[1];
        if (!ph) { fail('usage: /connect <phone>'); break; }
        if (_client && _client.connected) { fail('already connected'); break; }
        out('connecting...');
        await doConnect(ph);
        break;
      }

      case '/disconnect':
        if (_client) { _client.disconnect(); _client = null; _phone = null; }
        _rl.setPrompt('wa> ');
        out('disconnected');
        break;

      case '/reconnect':
        if (!_client) { fail('not connected'); break; }
        _client.disconnect();
        await new Promise(r => setTimeout(r, 1200));
        out('reconnecting...');
        await doConnect(_phone);
        break;

      // ── messaging ──────────────────────────────────────────────────────────

      case '/send': {
        requireConn();
        const [, jR, ...rest] = p;
        const jid = normalizeJid(jR);
        if (!jid || !rest.length) { fail('usage: /send <jid> <text>'); break; }
        const _t0 = Date.now();
        out('sending...');
        _client.sendText(jid, rest.join(' '))
          .then(r  => out('sent  ' + (r && r.id ? r.id : r) + '  (' + (Date.now() - _t0) + 'ms)'))
          .catch(e => fail('send error: ' + e.message));
        break;
      }

      case '/image': {
        requireConn();
        const [, jR, file, ...cap] = p;
        const jid = normalizeJid(jR);
        if (!jid || !file) { fail('usage: /image <jid> <file> [caption]'); break; }
        out('uploading...');
        _client.sendImage(jid, file, { caption: cap.join(' ') || undefined })
          .then(r => out('sent  ' + (r && r.id ? r.id : r)))
          .catch(e => fail('image error: ' + e.message));
        break;
      }

      case '/video': {
        requireConn();
        const [, jR, file, ...cap] = p;
        const jid = normalizeJid(jR);
        if (!jid || !file) { fail('usage: /video <jid> <file> [caption]'); break; }
        out('uploading...');
        _client.sendVideo(jid, file, { caption: cap.join(' ') || undefined })
          .then(r => out('sent  ' + (r && r.id ? r.id : r)))
          .catch(e => fail('video error: ' + e.message));
        break;
      }

      case '/audio': {
        requireConn();
        const [, jR, file] = p;
        const jid = normalizeJid(jR);
        if (!jid || !file) { fail('usage: /audio <jid> <file>'); break; }
        out('uploading...');
        _client.sendAudio(jid, file, {})
          .then(r => out('sent  ' + (r && r.id ? r.id : r)))
          .catch(e => fail('audio error: ' + e.message));
        break;
      }

      case '/ptt': {
        requireConn();
        const [, jR, file] = p;
        const jid = normalizeJid(jR);
        if (!jid || !file) { fail('usage: /ptt <jid> <file>'); break; }
        out('uploading...');
        _client.sendAudio(jid, file, { ptt: true })
          .then(r => out('sent  ' + (r && r.id ? r.id : r)))
          .catch(e => fail('ptt error: ' + e.message));
        break;
      }

      case '/doc': {
        requireConn();
        const [, jR, file, fname] = p;
        const jid = normalizeJid(jR);
        if (!jid || !file) { fail('usage: /doc <jid> <file> [name]'); break; }
        out('uploading...');
        _client.sendDocument(jid, file, { fileName: fname || path.basename(file) })
          .then(r => out('sent  ' + (r && r.id ? r.id : r)))
          .catch(e => fail('document error: ' + e.message));
        break;
      }

      case '/sticker': {
        requireConn();
        const [, jR, file] = p;
        const jid = normalizeJid(jR);
        if (!jid || !file) { fail('usage: /sticker <jid> <file>'); break; }
        out('uploading...');
        _client.sendSticker(jid, file, {})
          .then(r => out('sent  ' + (r && r.id ? r.id : r)))
          .catch(e => fail('sticker error: ' + e.message));
        break;
      }

      case '/react': {
        requireConn();
        const [, jR, msgId, emoji] = p;
        const jid = normalizeJid(jR);
        if (!jid || !msgId || !emoji) { fail('usage: /react <jid> <msgId> <emoji>'); break; }
        _client.sendReaction(jid, msgId, emoji)
          .then(r => out('sent  ' + (r && r.id ? r.id : r)))
          .catch(e => fail('react error: ' + e.message));
        break;
      }

      case '/edit': {
        requireConn();
        const [, jR, msgId, ...rest] = p;
        const jid = normalizeJid(jR);
        if (!jid || !msgId || !rest.length) { fail('usage: /edit <jid> <msgId> <text>'); break; }
        _client.editMessage(msgId, jid, rest.join(' '))
          .then(r => out('edited  ' + (r && r.id ? r.id : r)))
          .catch(e => fail('edit error: ' + e.message));
        break;
      }

      case '/delete': {
        requireConn();
        const [, jR, msgId, scope] = p;
        const jid = normalizeJid(jR);
        if (!jid || !msgId) { fail('usage: /delete <jid> <msgId> [all]'); break; }
        _client.deleteMessage(msgId, jid, true, scope === 'all')
          .then(() => out('deleted  ' + (scope === 'all' ? 'for everyone' : 'for me')))
          .catch(e => fail('delete error: ' + e.message));
        break;
      }

      case '/status': {
        requireConn();
        const [, ...rest] = p;
        if (!rest.length) { fail('usage: /status <text>'); break; }
        const r = await _client.sendStatus(rest.join(' '));
        out('status posted  ' + (r && r.id ? r.id : ''));
        break;
      }

      case '/forward': {
        requireConn();
        const [, jR, ...rest] = p;
        const jid = normalizeJid(jR);
        if (!jid || !rest.length) { fail('usage: /forward <jid> <text>'); break; }
        const r = await _client.forwardMessage(jid, rest.join(' '));
        out('forwarded  ' + (r && r.id ? r.id : r));
        break;
      }

      // ── quoted reply ────────────────────────────────────────────────────────
      // /reply <jid> <msgId> <senderJid> <text>
      // senderJid = same as jid for DMs; the group member's JID for groups

      case '/reply': {
        requireConn();
        const [, jR, msgId, senderR, ...rest] = p;
        const jid    = normalizeJid(jR);
        const sender = normalizeJid(senderR);
        if (!jid || !msgId || !sender || !rest.length) {
          fail('usage: /reply <jid> <msgId> <senderJid> <text>');
          out('  DM example:    /reply 491234567890@s.whatsapp.net ABC123 491234567890@s.whatsapp.net Hello!');
          out('  Group example: /reply 120363000@g.us ABC123 491234567890@s.whatsapp.net Hello!');
          break;
        }
        const r = await _client.sendReply(jid, msgId, sender, rest.join(' '));
        out('replied  ' + (r && r.id ? r.id : r));
        break;
      }

      // ── location ───────────────────────────────────────────────────────────
      // /location <jid> <lat> <lon> [name] [| address]

      case '/location': {
        requireConn();
        const [, jR, latStr, lonStr, ...rest] = p;
        const jid = normalizeJid(jR);
        const lat = parseFloat(latStr);
        const lon = parseFloat(lonStr);
        if (!jid || isNaN(lat) || isNaN(lon)) {
          fail('usage: /location <jid> <lat> <lon> [name] [| address]');
          break;
        }
        const combined = rest.join(' ');
        const pipeParts = combined.split('|').map(s => s.trim());
        const name    = pipeParts[0] || undefined;
        const address = pipeParts[1] || undefined;
        const r = await _client.sendLocation(jid, lat, lon, { name, address });
        out('sent  ' + (r && r.id ? r.id : r));
        break;
      }

      // ── contact vcard ──────────────────────────────────────────────────────
      // /vcard <jid> <displayName> <vcard-string>
      // The vCard can be a full multi-line string (wrap in quotes in the shell)

      case '/vcard': {
        requireConn();
        const [, jR, dName, ...vcardParts] = p;
        const jid = normalizeJid(jR);
        if (!jid || !dName || !vcardParts.length) {
          fail('usage: /vcard <jid> <displayName> <vcard-string>');
          break;
        }
        const vcard = vcardParts.join(' ');
        const r = await _client.sendContact(jid, dName, vcard);
        out('sent  ' + (r && r.id ? r.id : r));
        break;
      }

      // ── presence ───────────────────────────────────────────────────────────

      case '/online':   requireConn(); _client.setOnline(true);  out('online'); break;
      case '/offline':  requireConn(); _client.setOnline(false); out('offline'); break;

      case '/typing': {
        requireConn();
        const jid = normalizeJid(p[1]);
        if (!jid) { fail('usage: /typing <jid>'); break; }
        _client.setChatPresence(jid, 'composing');
        out('typing in ' + jid);
        break;
      }

      case '/recording': {
        requireConn();
        const jid = normalizeJid(p[1]);
        if (!jid) { fail('usage: /recording <jid>'); break; }
        _client.setChatPresence(jid, 'recording');
        out('recording in ' + jid);
        break;
      }

      case '/stop': {
        requireConn();
        const jid = normalizeJid(p[1]);
        if (!jid) { fail('usage: /stop <jid>'); break; }
        _client.setChatPresence(jid, 'paused');
        out('stopped in ' + jid);
        break;
      }

      case '/subscribe': {
        requireConn();
        const jid = normalizeJid(p[1]);
        if (!jid) { fail('usage: /subscribe <jid>'); break; }
        _client.subscribeToPresence(jid);
        out('subscribed to ' + jid);
        break;
      }

      // ── profile ────────────────────────────────────────────────────────────

      case '/name': {
        requireConn();
        const name = p.slice(1).join(' ');
        if (!name) { fail('usage: /name <text>'); break; }
        _client.changeName(name);
        out('name updated');
        break;
      }

      case '/about': {
        requireConn();
        const text = p.slice(1).join(' ');
        if (!text) { fail('usage: /about <text>'); break; }
        await _client.changeAbout(text);
        out('about updated');
        break;
      }

      case '/privacy': {
        requireConn();
        const [, type, value] = p;
        if (!type || !value) {
          fail('usage: /privacy <type> <value>');
          out('  types:  last_seen  profile_picture  status  online  read_receipts  groups_add');
          out('  values: all  contacts  contact_blacklist  none  match_last_seen');
          break;
        }
        await _client.changePrivacySetting(type, value);
        out('privacy updated  ' + type + ' = ' + value);
        break;
      }

      case '/photo': {
        requireConn();
        const file = p[1];
        if (!file) { fail('usage: /photo <file>'); break; }
        if (!fs.existsSync(file)) { fail('file not found: ' + file); break; }
        const buf = fs.readFileSync(file);
        await _client.changeProfilePicture(buf);
        out('profile picture updated');
        break;
      }

      // ── contacts ───────────────────────────────────────────────────────────

      case '/whatsapp': {
        requireConn();
        const phones = p.slice(1);
        if (!phones.length) { fail('usage: /whatsapp <phone...>'); break; }
        out('checking...');
        const has = await _client.hasWhatsapp(phones.map(normalizePhone));
        if (!has || !has.length) { out('  none of those numbers have WhatsApp'); break; }
        out('  has WhatsApp (' + has.length + ')');
        has.forEach(j => out('    ' + j));
        break;
      }

      case '/picture': {
        requireConn();
        const jid = normalizeJid(p[1]);
        if (!jid) { fail('usage: /picture <jid>'); break; }
        const url = await _client.queryPicture(jid);
        out('  ' + (url || '(no picture or private)'));
        break;
      }

      case '/contact': {
        requireConn();
        const sub = p[1] && p[1].toLowerCase();
        if (sub === 'about') {
          const jid = normalizeJid(p[2]);
          if (!jid) { fail('usage: /contact about <jid>'); break; }
          const text = await _client.queryAbout(jid);
          out('  ' + (text || '(empty or private)'));
        } else {
          fail('usage: /contact about <jid>');
        }
        break;
      }

      // ── chats ──────────────────────────────────────────────────────────────

      case '/read':
        requireConn();
        if (!p[1]) { fail('usage: /read <jid>'); break; }
        await _client.markChatRead(normalizeJid(p[1]));
        out('marked read');
        break;

      case '/unread':
        requireConn();
        if (!p[1]) { fail('usage: /unread <jid>'); break; }
        _client.markChatUnread(normalizeJid(p[1]));
        out('marked unread');
        break;

      case '/mute': {
        requireConn();
        const jid = normalizeJid(p[1]);
        if (!jid) { fail('usage: /mute <jid> [minutes]'); break; }
        const ms = p[2] ? parseInt(p[2], 10) * 60000 : 0;
        await _client.muteChat(jid, ms);
        out('muted  ' + jid);
        break;
      }

      case '/unmute':
        requireConn();
        if (!p[1]) { fail('usage: /unmute <jid>'); break; }
        await _client.unmuteChat(normalizeJid(p[1]));
        out('unmuted');
        break;

      case '/pin':
        requireConn();
        if (!p[1]) { fail('usage: /pin <jid>'); break; }
        _client.pinChat(normalizeJid(p[1]));
        out('pinned');
        break;

      case '/unpin':
        requireConn();
        if (!p[1]) { fail('usage: /unpin <jid>'); break; }
        _client.unpinChat(normalizeJid(p[1]));
        out('unpinned');
        break;

      case '/archive':
        requireConn();
        if (!p[1]) { fail('usage: /archive <jid>'); break; }
        _client.archiveChat(normalizeJid(p[1]));
        out('archived');
        break;

      case '/unarchive':
        requireConn();
        if (!p[1]) { fail('usage: /unarchive <jid>'); break; }
        _client.unarchiveChat(normalizeJid(p[1]));
        out('unarchived');
        break;

      case '/star': {
        requireConn();
        const [, jR, msgId] = p;
        if (!jR || !msgId) { fail('usage: /star <jid> <msgId>'); break; }
        _client.starMessage(msgId, normalizeJid(jR));
        out('starred');
        break;
      }

      case '/unstar': {
        requireConn();
        const [, jR, msgId] = p;
        if (!jR || !msgId) { fail('usage: /unstar <jid> <msgId>'); break; }
        _client.unstarMessage(msgId, normalizeJid(jR));
        out('unstarred');
        break;
      }

      case '/ephemeral': {
        requireConn();
        const jid = normalizeJid(p[1]) || asGroupJid(p[1]);
        const sec = p[2];
        if (!jid || sec === undefined) {
          fail('usage: /ephemeral <jid> <seconds>  (0=off  86400=1d  604800=1w  7776000=90d)');
          break;
        }
        await _client.changeEphemeralTimer(jid, parseInt(sec, 10) || 0);
        out('ephemeral timer set to ' + sec + 's for ' + jid);
        break;
      }

      case '/ephemeral-default': {
        requireConn();
        const sec = p[1];
        if (sec === undefined) {
          fail('usage: /ephemeral-default <seconds>  (0=off  86400=1d  604800=1w  7776000=90d)');
          break;
        }
        await _client.changeNewChatsEphemeralTimer(parseInt(sec, 10) || 0);
        out('default ephemeral timer set to ' + sec + 's for all new chats');
        break;
      }

      case '/block': {
        requireConn();
        const jid = normalizeJid(p[1]);
        if (!jid) { fail('usage: /block <jid>'); break; }
        await _client.blockContact(jid);
        out('blocked  ' + jid);
        break;
      }

      case '/unblock': {
        requireConn();
        const jid = normalizeJid(p[1]);
        if (!jid) { fail('usage: /unblock <jid>'); break; }
        await _client.unblockContact(jid);
        out('unblocked  ' + jid);
        break;
      }

      case '/blocklist': {
        requireConn();
        const list = await _client.queryBlockList();
        if (!list || !list.length) { out('  no blocked contacts'); break; }
        out('  blocked (' + list.length + ')');
        list.forEach(j => out('    ' + j));
        break;
      }

      // ── groups ─────────────────────────────────────────────────────────────

      case '/group': {
        requireConn();
        const sub = p[1] && p[1].toLowerCase();

        if (sub === 'create') {
          const name = p[2];
          const members = p.slice(3).map(normalizeJid);
          if (!name || !members.length) { fail('usage: /group create <name> <jid...>'); break; }
          out('creating group...');
          const r = await _client.createGroup(name, members);
          if (!r) { out('  no response'); break; }
          out('created  ' + (r.jid || ''));
          if (r.subject) out('  subject  ' + r.subject);
          if (r.participants && r.participants.length) {
            out('  members  ' + r.participants.map(p => p.jid).join(', '));
          }
        }
        else if (sub === 'leave') {
          const gj = asGroupJid(p[2]);
          if (!gj) { fail('usage: /group leave <jid>'); break; }
          await _client.leaveGroup(gj);
          out('left  ' + gj);
        }
        else if (sub === 'add') {
          const gj  = asGroupJid(p[2]);
          const jids = p.slice(3).map(normalizeJid);
          if (!gj || !jids.length) { fail('usage: /group add <jid> <member...>'); break; }
          await _client.addGroupParticipants(gj, jids);
          out('added  ' + jids.join(', '));
        }
        else if (sub === 'remove') {
          const gj  = asGroupJid(p[2]);
          const jids = p.slice(3).map(normalizeJid);
          if (!gj || !jids.length) { fail('usage: /group remove <jid> <member...>'); break; }
          await _client.removeGroupParticipants(gj, jids);
          out('removed  ' + jids.join(', '));
        }
        else if (sub === 'promote') {
          const gj  = asGroupJid(p[2]);
          const jids = p.slice(3).map(normalizeJid);
          if (!gj || !jids.length) { fail('usage: /group promote <jid> <member...>'); break; }
          await _client.promoteGroupParticipants(gj, jids);
          out('promoted');
        }
        else if (sub === 'demote') {
          const gj  = asGroupJid(p[2]);
          const jids = p.slice(3).map(normalizeJid);
          if (!gj || !jids.length) { fail('usage: /group demote <jid> <member...>'); break; }
          await _client.demoteGroupParticipants(gj, jids);
          out('demoted');
        }
        else if (sub === 'subject') {
          const gj   = asGroupJid(p[2]);
          const name = p.slice(3).join(' ');
          if (!gj || !name) { fail('usage: /group subject <jid> <name>'); break; }
          await _client.changeGroupSubject(gj, name);
          out('subject updated');
        }
        else if (sub === 'desc') {
          const gj   = asGroupJid(p[2]);
          const desc = p.slice(3).join(' ');
          if (!gj) { fail('usage: /group desc <jid> [text]'); break; }
          await _client.changeGroupDescription(gj, desc || null);
          out('description updated');
        }
        else if (sub === 'invite') {
          const gj = asGroupJid(p[2]);
          if (!gj) { fail('usage: /group invite <jid>'); break; }
          const link = await _client.queryGroupInviteLink(gj);
          out('  ' + (link || '(none)'));
        }
        else if (sub === 'revoke') {
          const gj = asGroupJid(p[2]);
          if (!gj) { fail('usage: /group revoke <jid>'); break; }
          await _client.revokeGroupInvite(gj);
          out('invite link revoked');
        }
        else if (sub === 'join') {
          const code = p[2];
          if (!code) { fail('usage: /group join <code>'); break; }
          const jid = await _client.acceptGroupInvite(code);
          out('joined  ' + (jid || 'ok'));
        }
        else if (sub === 'invite-info') {
          const code = p[2];
          if (!code) { fail('usage: /group invite-info <code|url>'); break; }
          out('querying group info from invite link...');
          const r = await _client.queryGroupInviteInfo(code);
          if (!r) { out('  no data (invalid code or expired link)'); break; }
          hr();
          kv('jid',         r.jid);
          kv('subject',     r.subject);
          kv('creator',     r.creator || '—');
          kv('created',     r.creation ? new Date(r.creation * 1000).toISOString() : '—');
          kv('description', r.description || '—');
          kv('participants', '(' + r.participants.length + ')');
          for (const pt of r.participants) {
            const role = pt.role !== 'member' ? '  [' + pt.role + ']' : '';
            out('    ' + pt.jid + role);
          }
          hr();
        }
        else if (sub === 'meta') {
          const gj = asGroupJid(p[2]);
          if (!gj) { fail('usage: /group meta <jid>'); break; }
          const r = await _client.getGroupMetadata(gj);
          if (!r) { out('  no data'); break; }
          hr();
          kv('jid',         r.jid);
          kv('subject',     r.subject);
          kv('creator',     r.creator || '—');
          kv('created',     r.creation ? new Date(r.creation * 1000).toISOString() : '—');
          kv('description', r.description || '—');
          kv('ephemeral',   r.ephemeral ? r.ephemeral + 's' : 'off');
          kv('only admins send', r.onlyAdminsSend ? 'yes' : 'no');
          kv('only admins edit', r.onlyAdminsEdit ? 'yes' : 'no');
          kv('participants', '(' + r.participants.length + ')');
          for (const p of r.participants) {
            const role = p.role !== 'member' ? '  [' + p.role + ']' : '';
            out('    ' + p.jid + role);
          }
          hr();
        }
        else if (sub === 'participants') {
          const gj = asGroupJid(p[2]);
          if (!gj) { fail('usage: /group participants <jid>'); break; }
          const r = await _client.getGroupMetadata(gj);
          if (!r) { out('  no data'); break; }
          out('  ' + r.subject + '  (' + r.participants.length + ' participants)');
          for (const pt of r.participants) {
            const role = pt.role !== 'member' ? '  [' + pt.role + ']' : '';
            out('    ' + pt.jid + role);
          }
        }
        else if (sub === 'photo') {
          const gj   = asGroupJid(p[2]);
          const file = p[3];
          if (!gj || !file) { fail('usage: /group photo <jid> <file>'); break; }
          if (!fs.existsSync(file)) { fail('file not found: ' + file); break; }
          const buf = fs.readFileSync(file);
          await _client.changeGroupPicture(gj, buf);
          out('group picture updated');
        }
        else if (sub === 'pending') {
          const gj = asGroupJid(p[2]);
          if (!gj) { fail('usage: /group pending <jid>'); break; }
          const list = await _client.queryGroupPendingParticipants(gj);
          if (!list || !list.length) { out('  no pending requests'); break; }
          out('  pending (' + list.length + ')');
          list.forEach(j => out('    ' + j));
        }
        else if (sub === 'approve') {
          const gj   = asGroupJid(p[2]);
          const jids = p.slice(3).map(normalizeJid);
          if (!gj || !jids.length) { fail('usage: /group approve <jid> <member...>'); break; }
          const ok = await _client.approveGroupParticipants(gj, true, jids);
          out('approved  ' + (ok.length ? ok.join(', ') : jids.join(', ')));
        }
        else if (sub === 'reject') {
          const gj   = asGroupJid(p[2]);
          const jids = p.slice(3).map(normalizeJid);
          if (!gj || !jids.length) { fail('usage: /group reject <jid> <member...>'); break; }
          const ok = await _client.approveGroupParticipants(gj, false, jids);
          out('rejected  ' + (ok.length ? ok.join(', ') : jids.join(', ')));
        }
        else if (sub === 'settings') {
          const gj      = asGroupJid(p[2]);
          const setting = p[3];
          const policy  = p[4];
          if (!gj || !setting || !policy) {
            fail('usage: /group settings <jid> <setting> <admins|all>');
            break;
          }
          await _client.changeGroupSetting(gj, setting, policy);
          out('setting updated  ' + setting + ' = ' + policy);
        }
        else {
          fail('unknown /group subcommand — type /help');
        }
        break;
      }

      // ── fetch all groups ───────────────────────────────────────────────────

      case '/groups': {
        requireConn();
        out('fetching all groups...');
        const groups = await _client.fetchAllGroups();
        if (!groups || !groups.length) { out('  no groups found'); break; }
        out('  total: ' + groups.length + ' group(s)\n');
        for (const g of groups) {
          hr();
          kv('jid',          g.jid);
          kv('subject',      g.subject);
          kv('creator',      g.creator || '—');
          kv('created',      g.creation ? new Date(g.creation * 1000).toISOString() : '—');
          kv('description',  g.description || '—');
          kv('ephemeral',    g.ephemeral ? g.ephemeral + 's' : 'off');
          kv('admins only send', g.onlyAdminsSend ? 'yes' : 'no');
          kv('admins only edit', g.onlyAdminsEdit ? 'yes' : 'no');
          kv('participants', '(' + g.participants.length + ')');
          for (const pt of g.participants) {
            const role = pt.role !== 'member' ? '  [' + pt.role + ']' : '';
            out('    ' + pt.jid + role);
          }
        }
        hr();
        break;
      }

      // ── registration ───────────────────────────────────────────────────────

      case '/reg': {
        const sub = p[1] && p[1].toLowerCase();

        if (sub === 'check') {
          const ph = normalizePhone(p[2]);
          if (!ph) { fail('usage: /reg check <phone>'); break; }
          out('checking...');
          const r = await checkNumberStatus(ph);
          out('  status  ' + r.status);
          if (r.note) out('  note    ' + r.note);
        }
        else if (sub === 'code') {
          const ph     = normalizePhone(p[2]);
          const method = p[3] || 'sms';
          if (!ph) { fail('usage: /reg code <phone> [sms|voice|wa_old]'); break; }
          if (!fs.existsSync(_sessDir)) fs.mkdirSync(_sessDir, { recursive: true });
          const sessFile = path.join(_sessDir, `${ph}.json`);
          let store = loadStore(sessFile);
          if (!store) {
            store = createNewStore(ph);
            saveStore(store, sessFile);
          } else if (!store.codePending && !store.registered) {
            // Only check /exist when keys were never used to request a code.
            out('checking device keys...');
            const waVersion = await fetchWaVersion(getDeviceConfig());
            const fresh = await assertRegistrationKeys(store, waVersion);
            if (!fresh) {
              out('  device keys already registered — generating new keys...');
              store = createNewStore(ph);
              saveStore(store, sessFile);
              out('  new keys saved — proceed with code below');
            }
          }
          out('requesting ' + method + ' code for +' + ph + '...');
          const r = await requestSmsCode(store, method);
          store.codePending = true;
          saveStore(store, sessFile);
          out('  status  ' + (r && r.status));
          out('  important: enter the code within 10 minutes');
          out('  now run: /reg confirm ' + ph + ' <code>');
        }
        else if (sub === 'confirm') {
          const ph   = normalizePhone(p[2]);
          const code = p[3];
          if (!ph || !code) { fail('usage: /reg confirm <phone> <code>'); break; }
          const file  = path.join(_sessDir, `${ph}.json`);
          const store = loadStore(file) || createNewStore(ph);
          out('verifying...');
          const r = await verifyCode(store, code);
          if (r && (r.status === 'ok' || r.status === 'sent' || r.status === 'verified')) {
            if (!fs.existsSync(_sessDir)) fs.mkdirSync(_sessDir, { recursive: true });
            const finalStore = r.store || store;
            finalStore.registered  = true;
            finalStore.codePending = false;
            saveStore(finalStore, file);
            out('registered  session saved to ' + file);
            out('now run: /connect ' + ph);
          } else {
            fail('verification failed  ' + JSON.stringify(r));
          }
        }
        else {
          fail('usage: /reg check|code|confirm ...');
        }
        break;
      }

      // ── poll ───────────────────────────────────────────────────────────────
      // /poll <jid> <question> | <opt1> | <opt2> [| <opt3> ...]
      // Optional last segment: selectable=<N>

      case '/poll': {
        requireConn();
        const jid   = makeJid(p[1]);
        const rest  = p.slice(2).join(' ');
        if (!jid || !rest) { fail('usage: /poll <jid> <question> | <option1> | <option2> ...'); break; }
        const parts = rest.split('|').map(s => s.trim()).filter(Boolean);
        if (parts.length < 3) { fail('/poll needs at least 2 options (separate with |)'); break; }
        const question  = parts[0];
        let   options   = parts.slice(1);
        let   selCount  = 0;
        const lastOpt   = options[options.length - 1];
        const selMatch  = lastOpt && lastOpt.match(/^selectable=(\d+)$/i);
        if (selMatch) { selCount = parseInt(selMatch[1], 10); options = options.slice(0, -1); }
        if (options.length < 2) { fail('/poll needs at least 2 options'); break; }
        out('sending poll "' + question + '" (' + options.length + ' options)...');
        const r = await _client.sendPoll(jid, question, options, selCount);
        out('poll sent  id: ' + (r && r.id ? r.id : r));
        break;
      }

      // ── business profile ───────────────────────────────────────────────────

      case '/biz': {
        requireConn();
        const jid = makeJid(p[1]);
        if (!jid) { fail('usage: /biz <phone|jid>'); break; }
        out('querying business profile for ' + jid + '...');
        const bp = await _client.queryBusinessProfile(jid);
        if (!bp) { out('  not a business account or no data returned'); break; }
        hr();
        kv('jid',         bp.jid);
        kv('category',    bp.category || '—');
        kv('email',       bp.email    || '—');
        kv('website',     bp.website  || '—');
        kv('address',     bp.address  || '—');
        if (bp.description) { kv('description', bp.description); }
        hr();
        break;
      }

      // ── community ──────────────────────────────────────────────────────────
      // /community create   <subject> <description>
      // /community deactivate <communityJid>
      // /community link     <communityJid> <groupJid>
      // /community unlink   <communityJid> <groupJid>

      case '/community': {
        requireConn();
        const sub = p[1] && p[1].toLowerCase();
        if (sub === 'create') {
          const subject     = p[2];
          const description = p.slice(3).join(' ');
          if (!subject) { fail('usage: /community create <subject> [description]'); break; }
          out('creating community "' + subject + '"...');
          const g = await _client.createCommunity(subject, description || '');
          if (!g) { fail('community creation failed'); break; }
          hr();
          kv('jid',     g.jid);
          kv('subject', g.subject);
          hr();
        }
        else if (sub === 'deactivate') {
          const cJid = makeJid(p[2]);
          if (!cJid) { fail('usage: /community deactivate <communityJid>'); break; }
          out('deactivating community ' + cJid + '...');
          await _client.deactivateCommunity(cJid);
          out('community deactivated');
        }
        else if (sub === 'link') {
          const cJid = makeJid(p[2]);
          const gJid = makeJid(p[3]);
          if (!cJid || !gJid) { fail('usage: /community link <communityJid> <groupJid>'); break; }
          out('linking ' + gJid + ' to community ' + cJid + '...');
          const linked = await _client.linkGroupsToCommunity(cJid, gJid);
          out('linked: ' + linked.join(', '));
        }
        else if (sub === 'unlink') {
          const cJid = makeJid(p[2]);
          const gJid = makeJid(p[3]);
          if (!cJid || !gJid) { fail('usage: /community unlink <communityJid> <groupJid>'); break; }
          out('unlinking ' + gJid + ' from community ' + cJid + '...');
          const ok = await _client.unlinkGroupFromCommunity(cJid, gJid);
          out(ok ? 'unlinked' : 'not unlinked (check JIDs)');
        }
        else {
          fail('usage: /community create|deactivate|link|unlink ...');
        }
        break;
      }

      // ── newsletter ─────────────────────────────────────────────────────────
      // /newsletter create  <name> [description]
      // /newsletter join    <jid>
      // /newsletter leave   <jid>
      // /newsletter info    <jid>
      // /newsletter desc    <jid> <new description>
      // /newsletter post    <jid> <text>

      case '/newsletter': {
        requireConn();
        const sub = p[1] && p[1].toLowerCase();
        if (sub === 'create') {
          const name = p[2];
          const desc = p.slice(3).join(' ');
          if (!name) { fail('usage: /newsletter create <name> [description]'); break; }
          out('creating newsletter "' + name + '"...');
          const nl = await _client.createNewsletter(name, desc || '');
          if (!nl) { fail('newsletter creation failed'); break; }
          hr();
          kv('jid',  nl.jid);
          kv('name', nl.name);
          hr();
        }
        else if (sub === 'join') {
          const jid = p[2];
          if (!jid) { fail('usage: /newsletter join <jid>'); break; }
          out('joining newsletter ' + jid + '...');
          await _client.joinNewsletter(jid);
          out('joined');
        }
        else if (sub === 'leave') {
          const jid = p[2];
          if (!jid) { fail('usage: /newsletter leave <jid>'); break; }
          out('leaving newsletter ' + jid + '...');
          await _client.leaveNewsletter(jid);
          out('left');
        }
        else if (sub === 'info') {
          const jid = p[2];
          if (!jid) { fail('usage: /newsletter info <jid>'); break; }
          out('querying newsletter ' + jid + '...');
          const nl = await _client.queryNewsletterMetadata(jid);
          if (!nl) { out('no data'); break; }
          hr();
          kv('jid',         nl.jid);
          kv('name',        nl.name        || '—');
          kv('description', nl.description || '—');
          kv('subscribers', nl.subscriberCount || 0);
          hr();
        }
        else if (sub === 'desc') {
          const jid  = p[2];
          const desc = p.slice(3).join(' ');
          if (!jid || !desc) { fail('usage: /newsletter desc <jid> <new description>'); break; }
          out('updating newsletter description...');
          await _client.changeNewsletterDescription(jid, desc);
          out('description updated');
        }
        else if (sub === 'post') {
          const jid  = p[2];
          const text = p.slice(3).join(' ');
          if (!jid || !text) { fail('usage: /newsletter post <jid> <text>'); break; }
          out('posting to newsletter ' + jid + '...');
          const r = await _client.sendNewsletterText(jid, text);
          out('posted  id: ' + (r && r.id ? r.id : r));
        }
        else {
          fail('usage: /newsletter create|join|leave|info|desc|post ...');
        }
        break;
      }

      // ── unknown ────────────────────────────────────────────────────────────

      default:
        if (line.startsWith('/')) {
          fail('unknown command: ' + cmd + '  — type /help');
        } else {
          fail('use /send <jid> <text> to send a message, or /help for all commands');
        }
    }
  } catch (e) {
    fail(e.message || String(e));
  }

  _rl.prompt();
}

// ─── argument parser ──────────────────────────────────────────────────────────

function parseArgs(argv) {
  const a = argv.slice(2);
  const r = { cmd: null, sub: null, flags: {}, pos: [] };
  if (!a.length) return r;
  r.cmd = a[0];
  let i = 1;
  if (a[i] && !a[i].startsWith('-')) r.sub = a[i++];
  while (i < a.length) {
    if (a[i].startsWith('--')) {
      const k = a[i].slice(2);
      const v = a[i + 1] && !a[i + 1].startsWith('-') ? a[++i] : true;
      r.flags[k] = v;
    } else {
      r.pos.push(a[i]);
    }
    i++;
  }
  return r;
}

// ─── main ─────────────────────────────────────────────────────────────────────

const USAGE = `
whalibmob v${VERSION}

usage:
  wa                                        open interactive shell
  wa connect <phone>                        connect and open interactive shell
  wa listen  <phone>                        connect and listen (stay-alive)
  wa registration --request-code <phone>    request SMS code
  wa registration --register <phone> --code <code>
  wa registration --check <phone>
  wa version

options:
  --session <dir>   session directory  (default: ~/.waSession)
  --method          sms | voice | wa_old  (default: sms)

after connecting, type /help for all available commands.
`.trim();

async function main() {
  const { cmd, sub, flags, pos } = parseArgs(process.argv);

  _sessDir = flags.session || defaultSessionDir();

  if (!cmd) {
    out('whalibmob v' + VERSION + '  —  type /help for commands');
    openShell();
    _rl.prompt();
    return;
  }

  if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
    out(VERSION);
    return;
  }

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    out(USAGE);
    return;
  }

  if (cmd === 'registration' || cmd === 'reg') {
    const rawPhone =
      flags['request-code'] !== undefined && flags['request-code'] !== true ? String(flags['request-code']) :
      flags.register         !== undefined && flags.register         !== true ? String(flags.register) :
      flags.check            !== undefined && flags.check            !== true ? String(flags.check) :
      sub || pos[0] || '';
    const phone = normalizePhone(rawPhone);

    if (flags.check !== undefined) {
      out('checking +' + phone + '...');
      try {
        const r = await checkNumberStatus(phone);
        out('  status  ' + r.status);
        if (r.note) out('  note    ' + r.note);
      } catch (e) { fail(e.message); }
      out('\nstaying in shell — type /help for commands');
      openShell(); _rl.prompt();
      return;
    }

    if (flags['request-code'] !== undefined) {
      const ph     = phone || normalizePhone(pos[0] || '');
      const method = flags.method || 'sms';
      if (!ph) { fail('phone number required'); process.exit(1); }
      if (!fs.existsSync(_sessDir)) fs.mkdirSync(_sessDir, { recursive: true });
      const sessFile = path.join(_sessDir, `${ph}.json`);
      let store = loadStore(sessFile);
      if (!store) {
        // Brand new — generate fresh keys, save immediately, no need to check /exist
        store = createNewStore(ph);
        saveStore(store, sessFile);
      } else if (!store.codePending && !store.registered) {
        // Existing store but code was never sent and not registered — check if
        // keys are already taken (e.g. leftover from a previous failed attempt).
        // FIX: only 1 /exist call now (was 2), and skipped entirely when codePending.
        out('checking device keys...');
        const waVersion = await fetchWaVersion(getDeviceConfig());
        const fresh = await assertRegistrationKeys(store, waVersion);
        if (!fresh) {
          out('  device keys already registered — generating new keys...');
          store = createNewStore(ph);
          saveStore(store, sessFile);
        }
      }
      // If store.codePending === true, keys were already accepted by WhatsApp in a
      // prior /code request — reuse the exact same store without any /exist call.
      out('requesting ' + method + ' code for +' + ph + '...');
      try {
        const r = await requestSmsCode(store, method);
        store.codePending = true;
        saveStore(store, sessFile);
        out('  status  ' + (r && r.status));
        if (r && (r.status === 'sent' || r.status === 'ok')) {
          out('  important: enter the code within 10 minutes');
          out('  run: wa registration --register ' + ph + ' --code <code>');
        }
      } catch (e) {
        out('  ' + (e.message || String(e)));
      }
      out('\nstaying in shell — use /reg confirm ' + ph + ' <code> to complete');
      openShell(); _rl.prompt();
      return;
    }

    if (flags.register !== undefined) {
      const ph   = phone || normalizePhone(pos[0] || '');
      const code = flags.code;
      if (!ph)   { fail('phone number required'); process.exit(1); }
      if (!code) { fail('--code is required');    process.exit(1); }
      const file  = path.join(_sessDir, `${ph}.json`);
      const store = loadStore(file) || createNewStore(ph);
      out('verifying code for +' + ph + '...');
      try {
        const r = await verifyCode(store, code);
        if (r && (r.status === 'ok' || r.status === 'sent' || r.status === 'verified')) {
          if (!fs.existsSync(_sessDir)) fs.mkdirSync(_sessDir, { recursive: true });
          const finalStore = r.store || store;
          finalStore.registered  = true;
          finalStore.codePending = false;
          saveStore(finalStore, file);
          out('registered  session saved to ' + file);
          out('run: wa connect ' + ph);
        } else {
          out('  status  ' + (r && r.status ? r.status : JSON.stringify(r)));
        }
      } catch (e) { fail(e.message); }
      out('\nstaying in shell — type /connect ' + ph + ' to start chatting');
      openShell(); _rl.prompt();
      return;
    }

    fail('specify --check, --request-code, or --register');
    process.exit(1);
    return;
  }

  if (cmd === 'connect') {
    const phone = normalizePhone(sub || pos[0] || flags.phone || '');
    if (!phone) { fail('phone number required'); process.exit(1); }
    openShell('wa +' + phone + '> ');
    out('connecting to +' + phone + '...');
    await doConnect(phone);
    return;
  }

  if (cmd === 'listen') {
    const phone = normalizePhone(sub || pos[0] || flags.phone || '');
    if (!phone) { fail('phone number required'); process.exit(1); }

    const client = new WhalibmobClient({ sessionDir: _sessDir });

    client.on('connected', () => {
      _client = client;
      out('connected  listening on +' + phone + '  (Ctrl+C to stop)');
    });

    client.on('message', (msg) => {
      hr();
      kv('time',    ts());
      // sender_pn gives the real phone JID even when from is a LID
      const spn = msg.node && msg.node.attrs && msg.node.attrs.sender_pn;
      if (spn && spn.user) kv('from', spn.user + '@s.whatsapp.net');
      else kv('from', msg.from);
      if (msg.participant && msg.participant !== msg.from) kv('sender', msg.participant);
      kv('id',      msg.id);
      const d = msg.decoded;
      if (d) {
        switch (d.type) {
          case 'text':     kv('text',    d.text); break;
          case 'image':    kv('type',    'image'    + (d.caption ? '  caption: ' + d.caption : '')); break;
          case 'video':    kv('type',    'video'    + (d.caption ? '  caption: ' + d.caption : '')); break;
          case 'audio':    kv('type',    'audio'); break;
          case 'voice':    kv('type',    'voice note'); break;
          case 'document': kv('type',    'document  file: ' + d.fileName); break;
          case 'sticker':  kv('type',    'sticker'); break;
          case 'reaction': kv('type',    'reaction  emoji: ' + d.emoji); break;
          case 'location': kv('type',    'location  lat: ' + d.latitude + '  lon: ' + d.longitude + (d.name ? '  name: ' + d.name : '')); break;
          case 'contact':  kv('type',    'contact  name: ' + d.displayName); break;
          default:         kv('type',    d.type);
        }
      }
      out('');
    });

    client.on('group_update', (u) => {
      hr();
      kv('group_update', u.groupJid);
      kv('type',         u.type);
      if (u.actor)        kv('by',      u.actor);
      if (u.participants && u.participants.length) kv('members', u.participants.join(', '));
      if (u.subject)      kv('subject', u.subject);
      kv('time',         new Date(u.timestamp * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''));
      out('');
    });

    client.on('receipt', (r) => {
      const label = r.type === 'read'     ? 'read'
                  : r.type === 'delivery' ? 'delivered'
                  : r.type === 'played'   ? 'played'
                  : r.type;
      out('  receipt  ' + label + '  id: ' + r.id + '  from: ' + r.from);
    });

    client.on('presence', (p) => {
      const state = p.type === 'composing'  ? 'typing'
                  : p.type === 'recording'  ? 'recording audio'
                  : p.type === 'paused'     ? 'stopped typing'
                  : p.available             ? 'online'
                  : 'offline';
      out('  presence  ' + p.from + '  ' + state);
    });

    client.on('decrypt_error', (e) => {
      out('  DECRYPT_ERROR  from ' + e.from + '  id ' + e.id + '  : ' + (e.err && e.err.message));
    });

    client.on('node', (node) => {
      if (!node || !node.description) return;
      out('  RAW_NODE  <' + node.description + '>  ' + JSON.stringify(node.attrs || {}));
    });

    client.on('reconnecting', ({ delay }) => out('  reconnecting in ' + delay / 1000 + 's...'));
    client.on('reconnected',  ()   => out('  reconnected'));
    client.on('auth_failure', (f)  => { fail('session revoked: ' + f.reason); process.exit(1); });
    client.on('error',        (e)  => fail(e.message));

    process.on('SIGINT', () => { out('\nstopping...'); client.disconnect(); process.exit(0); });

    const keepAlive = setInterval(() => {}, 60000);
    client.on('auth_failure', () => { clearInterval(keepAlive); });

    try {
      await client.init(phone);
    } catch (e) {
      fail(e.message);
      clearInterval(keepAlive);
      process.exit(1);
    }
    return;
  }

  fail('unknown command: ' + cmd);
  out(USAGE);
  process.exit(1);
}

main().catch(e => { fail(e.message || String(e)); process.exit(1); });
