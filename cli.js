#!/usr/bin/env node
'use strict';

// Load .env from the current working directory (silently — no error if missing).
// This lets users configure WA_OS, WA_DEVICE, WA_VERSION etc. without touching
// their shell environment.  Must happen before any other require() so that
// process.env is fully populated when modules read it at load time.
try { require('dotenv').config(); } catch (_) {}

// ─── Wire trace ───────────────────────────────────────────────────────────────
// Full protocol tracing prints every stanza this client sends and receives.
// It is opt-in: an interactive session asks once at startup. `--debug` turns it
// on without asking (for scripts and pipes), `--no-debug` / `--quiet` / `-q` /
// WA_DEBUG=0 turn it off without asking.
const TRACE_FORCE_ON = process.argv.includes('--debug') || process.env.WA_DEBUG === '1';
const TRACE_FORCE_OFF = (
  process.argv.includes('--no-debug') ||
  process.argv.includes('--quiet') ||
  process.argv.includes('-q') ||
  process.env.WA_DEBUG === '0'
);
// `--trace-bytes` additionally dumps the raw encoded bytes of every stanza.
const TRACE_BYTES = process.argv.includes('--trace-bytes');

// Consume the trace flags so the command parser below never sees them and
// reports e.g. `--no-debug` as an unknown command.
const _TRACE_FLAGS = ['--debug', '--no-debug', '--quiet', '-q', '--trace-bytes'];
process.argv = process.argv.filter(a => !_TRACE_FLAGS.includes(a));

// Console starts clean: internal [DBG] lines are swallowed unless tracing is
// switched on, which restores this stream.
const _origStderrWrite = process.stderr.write.bind(process.stderr);
function installDbgSuppression() {
  process.stderr.write = function(chunk, enc, cb) {
    if (typeof chunk === 'string' && chunk.startsWith('[DBG]')) {
      if (typeof enc === 'function') enc(); else if (typeof cb === 'function') cb();
      return true;
    }
    return _origStderrWrite(chunk, enc, cb);
  };
}
installDbgSuppression();

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

const { assertMeId, initAuthCreds } = require('./lib/auth-utils');

// ─── Wire trace implementation ────────────────────────────────────────────────
// Everything below is CLI-only instrumentation; the library is untouched.
//
// Two hooks cover the whole protocol surface:
//   * NoiseSocket.prototype.sendNode  — every stanza leaving this client
//   * NoiseSocket.prototype.emit      — the 'node' event, every stanza arriving
// They are patched on the prototype rather than on an instance so the trace
// survives reconnects and covers frames sent during the handshake, before any
// client-level event has fired. https.request is wrapped as well, because SMS
// registration runs over HTTP and never touches the socket.
let _wireTraceOn = false;
function enableWireTrace() {
  if (_wireTraceOn) return;
  _wireTraceOn = true;
  // Tracing is the point now — let [DBG] through again.
  process.stderr.write = _origStderrWrite;
  const { NoiseSocket } = require('./lib/noise');
  const { configureLogger } = require('./lib/logger');
  const https = require('https');

  const C = process.stdout.isTTY
    ? { out:'\x1b[36m', in:'\x1b[32m', http:'\x1b[35m', dim:'\x1b[2m', tag:'\x1b[33m', off:'\x1b[0m' }
    : { out:'', in:'', http:'', dim:'', tag:'', off:'' };

  // pino writes newline-delimited JSON to stdout. That is the right shape for a
  // log collector and the wrong one for someone watching a live session, so
  // reformat its lines on the way out. Anything that is not a pino record is
  // passed through byte-for-byte.
  const stamp = () => new Date().toISOString().slice(11, 23);
  // Traffic arrives while readline owns the bottom line, so writing straight
  // out overwrites the prompt and leaves the two interleaved. Clear the line
  // first and redraw the prompt after, the same way the CLI's own event
  // handlers do.
  const trace = (s) => {
    const live = _rl && process.stdout.isTTY;
    if (live) {
      readline.cursorTo(process.stdout, 0);
      readline.clearLine(process.stdout, 0);
    }
    _origStderrWrite(s + '\n');
    if (live) _rl.prompt(true);
  };

  // Route the library's internal [DBG] stream through pino at full verbosity.
  // pino writes newline-delimited JSON straight to fd 1 via sonic-boom, which
  // bypasses process.stdout — so rather than trying to reformat its output we
  // intercept at pino's own logMethod hook, render the record ourselves and let
  // pino emit nothing. The library still logs through pino; only the rendering
  // is ours.
  const LEVEL_NAME = { 10: 'TRACE', 20: 'DEBUG', 30: 'INFO ', 40: 'WARN ', 50: 'ERROR', 60: 'FATAL' };
  configureLogger({
    level: 'trace',
    hooks: {
      logMethod(args, _method, level) {
        const msg = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
        trace(`${C.dim}${stamp()} ${LEVEL_NAME[level] || level}${C.off} ${msg}`);
      }
    }
  });

  const isPrintable = (buf) => buf.length > 0 && buf.every(b => b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127));

  // JIDs decode to objects, byte fields to Buffers — render both readably.
  function attrValue(v) {
    if (v === null || v === undefined) return '';
    if (Buffer.isBuffer(v)) return isPrintable(v) ? v.toString('utf8') : '0x' + v.toString('hex');
    if (typeof v === 'object') {
      if (v.user !== undefined) {
        const dev = v.device ? ':' + v.device : '';
        return `${v.user || ''}${dev}@${v.server || ''}`;
      }
      return JSON.stringify(v);
    }
    return String(v);
  }

  function renderContent(content, pad) {
    if (content === null || content === undefined) return null;
    if (Array.isArray(content)) return content.map(n => nodeToXml(n, pad)).join('\n');
    if (Buffer.isBuffer(content)) {
      if (isPrintable(content)) return pad + content.toString('utf8');
      const hex = content.toString('hex');
      const shown = hex.length > 512 ? hex.slice(0, 512) + '…' : hex;
      return `${pad}${C.dim}[${content.length} bytes] ${shown}${C.off}`;
    }
    return pad + String(content);
  }

  function nodeToXml(node, pad) {
    pad = pad || '';
    if (!node || !node.description) return pad + String(node);
    const attrs = Object.entries(node.attrs || {})
      .map(([k, v]) => ` ${C.tag}${k}${C.off}="${attrValue(v)}"`).join('');
    const tag = node.description;
    const body = renderContent(node.content, pad + '  ');
    if (body === null) return `${pad}<${tag}${attrs}/>`;
    return `${pad}<${tag}${attrs}>\n${body}\n${pad}</${tag}>`;
  }

  function logStanza(dir, node) {
    const colour = dir === 'OUT' ? C.out : C.in;
    const arrow  = dir === 'OUT' ? '──▶ SENT' : '◀── RECV';
    trace(`\n${colour}${stamp()} ${arrow}${C.off}`);
    trace(nodeToXml(node, '  '));
    if (TRACE_BYTES) {
      try {
        const { encodeNode } = require('./lib/BinaryNode');
        const raw = encodeNode(node);
        trace(`  ${C.dim}raw ${raw.length}B: ${raw.toString('hex')}${C.off}`);
      } catch (_) {}
    }
  }

  // The Noise handshake never goes through sendNode — sendNode refuses to run
  // until the channel is secured, and the ClientHello/ClientFinish frames are
  // written straight to the TCP socket. Wrap that socket as soon as connect()
  // creates it so the handshake is visible too, then step aside once the
  // channel is up and the stanza-level hooks take over.
  const HS_OUT = ['ClientHello', 'ClientFinish'];
  const HS_IN  = ['ServerHello'];
  const origConnect = NoiseSocket.prototype.connect;
  NoiseSocket.prototype.connect = function (...args) {
    const result = origConnect.apply(this, args);
    const sock = this.socket;
    if (sock && !sock.__waTraced) {
      sock.__waTraced = true;
      let outN = 0, inN = 0;
      trace(`\n${C.out}${stamp()} ──▶ TCP CONNECT ${sock.remoteAddress || ''}${C.off}`);

      const origWrite = sock.write.bind(sock);
      sock.write = (chunk, ...rest) => {
        if (!this.secured && Buffer.isBuffer(chunk)) {
          const name = HS_OUT[outN++] || 'handshake frame';
          trace(`\n${C.out}${stamp()} ──▶ NOISE ${name}  (${chunk.length} bytes)${C.off}`);
          trace(`  ${C.dim}${chunk.toString('hex')}${C.off}`);
        }
        return origWrite(chunk, ...rest);
      };

      sock.on('data', (d) => {
        if (this.secured) return;
        // Label positionally, but say so when the reply is plainly not a Noise
        // frame — a proxy or captive portal answering in ASCII is worth reading
        // as text rather than staring at its hex.
        const ascii = isPrintable(d);
        const name  = ascii ? 'unexpected plaintext reply' : (HS_IN[inN++] || 'handshake frame');
        trace(`\n${C.in}${stamp()} ◀── NOISE ${name}  (${d.length} bytes)${C.off}`);
        trace(`  ${C.dim}${d.toString('hex').slice(0, 1024)}${C.off}`);
        if (ascii) trace(`  ${C.dim}as text: ${JSON.stringify(d.toString('utf8').slice(0, 400))}${C.off}`);
      });
    }
    return result;
  };

  const origSendNode = NoiseSocket.prototype.sendNode;
  NoiseSocket.prototype.sendNode = function (node) {
    try { logStanza('OUT', node); } catch (_) {}
    return origSendNode.call(this, node);
  };

  const origEmit = NoiseSocket.prototype.emit;
  NoiseSocket.prototype.emit = function (event, ...args) {
    try {
      if (event === 'node')       logStanza('IN', args[0]);
      else if (event === 'open')  trace(`\n${C.in}${stamp()} ◀── HANDSHAKE COMPLETE — channel secured${C.off}`);
      else if (event === 'error') trace(`\n${C.in}${stamp()} ◀── SOCKET ERROR: ${args[0] && args[0].message}${C.off}`);
      else if (event === 'close') trace(`\n${C.in}${stamp()} ◀── SOCKET CLOSED${C.off}`);
    } catch (_) {}
    return origEmit.apply(this, [event, ...args]);
  };

  // Registration (SMS request / code verify) goes over HTTPS, not the socket.
  const origRequest = https.request;
  https.request = function (...args) {
    const opts = typeof args[0] === 'string' ? { href: args[0] } : (args[0] || {});
    const host = opts.hostname || opts.host || opts.href || '?';
    const target = `${opts.method || 'GET'} ${host}${opts.path || ''}`;
    trace(`\n${C.http}${stamp()} ──▶ HTTP ${target}${C.off}`);
    if (opts.headers) {
      for (const [k, v] of Object.entries(opts.headers)) {
        trace(`  ${C.tag}${k}${C.off}: ${v}`);
      }
    }
    const req = origRequest.apply(this, args);
    const origWrite = req.write.bind(req);
    req.write = function (chunk, ...rest) {
      try { trace(`  ${C.dim}body: ${Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk}${C.off}`); } catch (_) {}
      return origWrite(chunk, ...rest);
    };
    req.on('response', (res) => {
      trace(`\n${C.http}${stamp()} ◀── HTTP ${res.statusCode} from ${host}${C.off}`);
      let body = '';
      res.on('data', d => { if (body.length < 8192) body += d.toString('utf8'); });
      res.on('end', () => { if (body) trace(`  ${C.dim}${body}${C.off}`); });
    });
    return req;
  };

}

// Read the version straight from package.json so it can never drift out of sync
// with the published package.  npm always ships package.json in the tarball,
// regardless of the "files" list, so this resolves for installed users too.
const VERSION = (() => {
  try { return require('./package.json').version; } catch (_) { return 'unknown'; }
})();

// ─── output helpers ───────────────────────────────────────────────────────────

const out  = (s) => process.stdout.write(s + '\n');
const warn = (s) => process.stderr.write('warning: ' + s + '\n');
const fail = (s) => { process.stderr.write('error: ' + s + '\n'); };

function kv(label, value) {
  out('  ' + label.padEnd(20) + '  ' + value);
}

function hr() { out('  ' + '─'.repeat(56)); }

// Why a group action did or did not go through, per participant. The server
// decides each one separately, so a run that half worked has to say which half.
const PARTICIPANT_ERRORS = {
  400: 'bad request',
  401: 'not authorised',
  403: 'their privacy settings do not allow it',
  404: 'not on WhatsApp',
  408: 'not a member',
  409: 'already a member',
  500: 'server error'
};

// A participant, with the phone number behind their LID when the server told
// us one — a bare LID says nothing about who the person is.
function participantLine(p) {
  const role = p.role && p.role !== 'member' ? '  [' + p.role + ']' : '';
  const pn   = (p.phoneNumber && p.phoneNumber !== p.jid) ? '  (' + p.phoneNumber + ')' : '';
  return p.jid + pn + role;
}

// A chat setting either reached app state — and so every other device — or it
// did not, and stayed here. Saying which costs one word and saves the user
// wondering why their phone did not follow.
// A live HH:MM:SS countdown, redrawn in place once a second.
//
// The restriction's end is a fixed moment, so every tick recomputes from it
// rather than decrementing a counter — a tick that arrives late, or a laptop
// that slept, then shows the truth instead of drifting further behind.
//
// Returns a promise that settles when the time runs out or the user stops it.
function countdown(client, initial) {
  return new Promise((resolve) => {
    const tty = process.stdout.isTTY;
    let done  = false;

    const finish = (why) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      process.stdin.removeListener('data', onKey);
      if (tty) process.stdout.write('\n');
      resolve(why);
    };

    const draw = () => {
      const s = client.getReachoutTimelock();
      if (!s.active) { 
        if (tty) process.stdout.write('\r\x1b[2K');
        out('  the restriction has been lifted — you can start new chats again');
        return finish('lifted');
      }
      const line = '  restricted — ' + s.remaining + ' remaining' +
        (s.expiryUnknown ? '  (server did not give an end time; re-checking)' : '');
      if (tty) process.stdout.write('\r\x1b[2K' + line);
      else     out(line);
    };

    // Any keypress stops the countdown; the restriction is unaffected either
    // way, so there is nothing to confirm.
    const onKey = () => finish('stopped');
    if (tty && process.stdin.isTTY) {
      process.stdin.resume();
      process.stdin.once('data', onKey);
    }

    if (tty) out('  press any key to stop watching');
    void initial;
    draw();
    const timer = setInterval(draw, 1000);
  });
}

function chatResult(label, synced) {
  return label + (synced ? '' : '  (this session only — no app state key)');
}

function printParticipantResults(verb, results) {
  const okList  = results.filter(r => r.ok);
  const badList = results.filter(r => !r.ok);
  if (okList.length) out('  ' + verb + '  ' + okList.map(String).join(', '));
  for (const r of badList) {
    const why = PARTICIPANT_ERRORS[r.error] || 'error ' + r.error;
    out('  failed  ' + r.jid + '  — ' + why + ' (' + r.status + ')' +
        (r.needsInvite ? '  · can be invited instead' : '') +
        (r.invited === true  ? '  · invitation sent' : '') +
        (r.invited === false ? '  · invitation failed: ' + r.inviteError : ''));
  }
  if (!okList.length && !badList.length) out('  the server answered about nobody');
}

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
// Set when a failed connect turned out to be a number-form mismatch, so
// /fixnumber knows what it is fixing without probing the server again.
let _pendingFix = null;
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
    /status   <text>                          post a text Status/Story
    /status   image|video|audio <file> [caption]  post a media Status/Story
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
    /photo   <file>|remove                   change or remove own profile picture (any image)
    /privacy [<type> <value>]                show or change privacy settings
                                               types:  last_seen profile_picture status
                                                       online read_receipts groups_add
                                                       call_add messages defense stickers
                                               values: all contacts contact_blacklist
                                                       contact_allowlist none known
                                                       match_last_seen on_standard off

  Contacts
    /whatsapp  <phone...>                    check which numbers have WhatsApp
    /picture   <jid> [file]                  profile picture URL; downloads it when a file is given
    /read      <jid> <msgId...>              mark messages as read (blue ticks)
    /autoread  on|off                        auto-send read receipts for incoming messages
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
    /star      <jid> <msgId> [me]            star a message ("me" if you sent it)
    /unstar    <jid> <msgId> [me]            unstar a message
    /appstate  [collection...]               pull pins/archives/mutes/stars from your phone
    /appstate  --snapshot                    re-read all of it from scratch
    /restriction                             account restriction + live countdown
    /restriction --once                      just the numbers, no countdown
    /restriction --demo [seconds]            fake countdown to check the display
    /ephemeral         <jid> <seconds>        set disappearing timer for chat
    /ephemeral-default <seconds>             set default timer for ALL new chats
    /block     <jid>                         block contact
    /unblock   <jid>                         unblock contact
    /blocklist                               show blocked contacts

  Groups
    /group create  <name> <jid...>           create group
    /group leave   <jid>                     leave group
    /group add     <jid> <member...>         add participants
    /group add-invite <jid> <member...>      add, and invite whoever cannot be added
    /group remove  <jid> <member...>         remove participants
    /group promote <jid> <member...>         promote to admin
    /group demote  <jid> <member...>         demote from admin
    /group subject <jid> <name>              rename group
    /group desc    <jid> <text>              change description
    /group invite      <jid>                  get invite link
    /group revoke      <jid>                  revoke invite link
    /group join        <code|link>            join by invite code or full link
    /group invite-info <code|url>             preview group metadata from invite link
    /group photo       <jid> <file>           change group picture (JPEG)
    /group meta        <jid>                  query group metadata + participants
    /group participants <jid>                 list participants of a group
    /group pending      <jid>                 list pending join requests
    /group approve      <jid> <member...>     approve pending join requests
    /group reject       <jid> <member...>     reject pending join requests
    /group send-invite  <jid> <member> <code> <expiration>
                                              send a personal invitation
    /group accept-invite <jid> <inviter> <code> [expiration]
                                              accept a personal invitation
    /group preview-invite <jid> <inviter> <code> [expiration]
                                              preview a group from a personal invitation
    /group revoke-invite <jid> <member>       withdraw a personal invitation
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
    /reg check   <phone>                              check if number has WhatsApp
    /reg code    <phone> [sms|voice|wa_old]           request verification code
    /reg code    <phone> email <address>              request code via email
    /reg confirm <phone> <code>                       complete registration

  Connection
    /connect    <phone> [sms|pair]           connect to WhatsApp (asks which if unset)
    /pair       <phone> [code]               link to an existing account by 8-digit code
    /fixnumber                               re-file a session under the number WhatsApp uses
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
        case 'groupInvite':
          kv('type', 'group invitation  ' + (d.groupName || d.groupJid));
          kv('accept with', '/group accept-invite ' + d.groupJid + ' ' +
             (msg.participant || msg.from) + ' ' + d.inviteCode + ' ' + d.inviteExpiration);
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

  // Changes made on the phone or another linked device. `remote` marks them as
  // somebody else's doing — our own calls emit the same events without it.
  const chatChange = (label) => (u) => {
    if (!u || !u.remote) return;
    _rl && _rl.pause();
    out('  ' + label(u));
    _rl && (_rl.resume(), _rl.prompt(true));
  };
  client.on('chat_pinned',    chatChange(u => (u.pinned ? 'pinned' : 'unpinned') + '  ' + u.jid));
  client.on('chat_archived',  chatChange(u => (u.archived ? 'archived' : 'unarchived') + '  ' + u.jid));
  client.on('chat_read',      chatChange(u => 'marked ' + (u.read ? 'read' : 'unread') + '  ' + u.jid));
  client.on('chat_muted',     chatChange(u => (u.muted ? 'muted' : 'unmuted') + '  ' + u.jid +
    (u.muted && u.until > 0 ? '  until ' + new Date(u.until).toISOString() : '')));
  client.on('message_starred', chatChange(u =>
    (u.starred ? 'starred' : 'unstarred') + '  ' + u.msgId + '  in ' + u.chatJid));
  client.on('contact_update',  chatChange(u => 'contact  ' + u.jid + (u.name ? '  → ' + u.name : '')));
  client.on('push_name_update', chatChange(u => 'your name is now  ' + u.name));

  client.on('app_state_key_missing', (e) => {
    _rl && _rl.pause();
    out('  app state: waiting for a sync key from your phone (' + e.collection + ')');
    _rl && (_rl.resume(), _rl.prompt(true));
  });

  // The server announces a restriction starting and being lifted, so a session
  // that is just sitting there still finds out.
  client.on('account_restriction', (r) => {
    if (r.source !== 'notification') return;
    _rl && _rl.pause();
    if (r.active) {
      out('  ACCOUNT RESTRICTED — ' + r.reason + ', ' + r.remaining + ' remaining');
      out('  run /restriction to watch the countdown');
    } else {
      out('  account restriction lifted — you can start new chats again');
    }
    _rl && (_rl.resume(), _rl.prompt(true));
  });

  client.on('app_state_keys', (e) => {
    _rl && _rl.pause();
    out('  app state: received ' + e.keys.length + ' sync key(s) from your phone —' +
        ' pins, archives, mutes and stars will sync from now on');
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
    const how = client._mode === 'web'
      ? 'link again with /pair'
      : 're-register with /reg code';
    fail('session revoked: ' + f.reason + ' — ' + how);
    _rl && _rl.resume();
    notConnected();
  });

  // Someone else opened a session for this number. Reconnecting would fight
  // them for it, so the client stands down and says so.
  client.on('connection_replaced', (r) => {
    _rl && _rl.pause();
    fail('connection replaced');
    out('  ' + r.message);
    _rl && _rl.resume();
    notConnected();
  });

  // A stanza whose shape we mishandled. Not fatal — the connection kept going.
  client.on('node_error', (e) => {
    _rl && _rl.pause();
    fail('could not handle a <' + e.tag + '>: ' + (e.err && e.err.message));
    _rl && (_rl.resume(), _rl.prompt(true));
  });

  // The server declined the client, not the session. Nothing to re-register.
  client.on('client_rejected', (r) => {
    _rl && _rl.pause();
    fail('rejected by WhatsApp (' + r.reason +
         (r.location ? ', edge ' + r.location : '') + ')');
    out('  ' + r.message);
    _rl && _rl.resume();
    notConnected();
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

// Which way in: register this number over SMS as the account's own device, or
// link to an account that already exists the way WhatsApp Web does.
//
// Asked only when it is genuinely ambiguous. If exactly one kind of session is
// already on disk that one wins, and a non-interactive stdin never blocks on a
// question nobody is there to answer.
function hasMobileSession(phone) {
  return fs.existsSync(path.join(_sessDir, phone + '.json'));
}

function hasWebSession(phone) {
  const f = path.join(_sessDir, phone + '.web.json');
  if (!fs.existsSync(f)) return false;
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return !!(j.registered && j.me && j.me.id);
  } catch (_) { return false; }
}

function askLoginMethod(phone) {
  const mob = hasMobileSession(phone);
  const web = hasWebSession(phone);
  if (web && !mob) return Promise.resolve('pairing');
  if (mob && !web) return Promise.resolve('sms');
  if (!process.stdin.isTTY) return Promise.resolve(mob ? 'sms' : 'pairing');

  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    out('');
    out('  how do you want to connect?');
    out('    1) sms           register this number as its own device');
    out('    2) pairing code  link to an existing WhatsApp account (8-digit code)');
    rl.question('  sms or pairing code?  [1/2] ', (answer) => {
      rl.close();
      const a = String(answer).trim().toLowerCase();
      resolve((a === '2' || a.startsWith('p')) ? 'pairing' : 'sms');
    });
  });
}

// Handlers for the two things a registration can stop and ask for.
//
// The server can answer a submitted code with a captcha, or with a demand for
// the account's two-step PIN. Neither is something the library can work out, so
// both come back to whoever is driving it — here, the person at the terminal.
function registrationPrompts() {
  const prompt = (question) => new Promise((resolve) => {
    if (!process.stdin.isTTY) return resolve(null);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(String(answer).trim()); });
  });

  return {
    async solveCaptcha({ image, audio }) {
      out('');
      hr();
      out('  WhatsApp is asking for a CAPTCHA before it will finish this registration.');
      // Written out rather than described: it is a picture, and there is
      // nothing useful to say about it in a terminal.
      for (const [what, buf, ext] of [['image', image, 'png'], ['audio', audio, 'mp3']]) {
        if (!buf || !buf.length) continue;
        const file = path.join(os.tmpdir(), 'whalibmob-captcha-' + Date.now() + '.' + ext);
        try {
          fs.writeFileSync(file, buf);
          out('  ' + what + ' saved to  ' + file + '  (' + buf.length + ' bytes)');
        } catch (e) {
          out('  could not save the ' + what + ': ' + e.message);
        }
      }
      hr();
      const answer = await prompt('  what does it say?  ');
      return answer || null;
    },

    async twoFactorPin() {
      out('');
      out('  this number has two-step verification switched on');
      const pin = await prompt('  six-digit PIN:  ');
      return pin || null;
    }
  };
}

// Link as a companion device.
//
// Connect first, then ask for the code: the request rides on the encrypted
// channel, so there has to be one before there can be a code.
async function doConnectWeb(phone, opts) {
  opts  = opts || {};
  phone = normalizePhone(phone);
  const client = new WhalibmobClient({ sessionDir: _sessDir });
  attachEvents(client);

  client.on('pair_device', () => { /* QR path — nothing to draw in a terminal */ });

  client.once('paired', (p) => {
    out('');
    out('  linked as ' + p.jid + (p.lid ? '  (' + p.lid + ')' : ''));
    out('  device slot ' + p.deviceIndex + (p.platform ? '  ·  primary is ' + p.platform : ''));
    out('  finishing handshake...');
  });

  client.on('history_sync', (r) => {
    out('  history  ' + r.syncTypeName +
        '  chats=' + r.chats.length +
        '  contacts=' + r.contacts.length);
  });

  client.once('connected', () => {
    _client = client;
    _phone  = phone;
    out('connected as +' + phone + '  (web / companion)');
    _rl.setPrompt('wa +' + phone + '> ');
    _rl.prompt();
  });

  const alreadyLinked = hasWebSession(phone);

  try {
    await client.connectWeb(phone, { syncFullHistory: true });

    if (!alreadyLinked) {
      const code = await client.requestPairingCode(phone, opts.customCode);
      out('');
      hr();
      out('  pairing code   ' + code.slice(0, 4) + '-' + code.slice(4));
      hr();
      out('  on the phone that owns +' + phone + ':');
      out('    WhatsApp → Settings → Linked Devices → Link a device');
      out('    → Link with phone number instead → enter the code above');
      out('');
      out('  the code is valid for a few minutes; waiting...');
    } else {
      out('session already linked — reconnecting');
    }

    const keepAlive = setInterval(() => {}, 10000);
    client.once('connected',    () => clearInterval(keepAlive));
    client.once('auth_failure', () => clearInterval(keepAlive));
  } catch (e) {
    fail(e.message);
    notConnected();
  }
}

async function doConnect(phone) {
  phone = normalizePhone(phone);
  const client = new WhalibmobClient({ sessionDir: _sessDir });
  attachEvents(client);

  // The session may be re-filed mid-connect when WhatsApp turns out to keep the
  // account under a different form of the number. Everything from here on has
  // to use the corrected one, including the prompt.
  client.on('number_corrected', ({ from, to }) => {
    phone = to;
    out('  this account is registered as +' + to + ' (not +' + from + ') — session updated');
  });

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
    notConnected();
  });

  try {
    await client.init(phone);
    const keepAlive = setInterval(() => {}, 10000);
    client.once('connected',    () => clearInterval(keepAlive));
    client.once('auth_failure', () => clearInterval(keepAlive));
  } catch (e) {
    fail(e.message);
    if (/No (primary )?session for/i.test(e.message)) {
      if (hasWebSession(phone)) {
        out('  this number is linked as a companion — use:  /pair ' + phone);
      } else {
        out('  register it:  /reg code ' + phone + '   then  /reg confirm ' + phone + ' <code>');
        out('  or link it to an account already on a phone:  /pair ' + phone);
      }
    } else if (e.code === '401' || /auth failure 401/i.test(e.message)) {
      // 401 says the credentials were refused; it does not say whether the
      // number itself is still registered. Ask, so the next step is obvious.
      out('  checking whether the number is still registered...');
      try {
        const probe = await client.checkSessionAlive();

        if (probe.mismatch) {
          // Reached only when the automatic correction inside init() could not
          // run — a session already exists under the canonical number, or the
          // rename failed. Say what it would have done.
          hr();
          out('  the session is filed under a number WhatsApp does not use');
          out('    session : +' + probe.current);
          out('    server  : +' + probe.canonical);
          hr();
          out('  this is normally corrected automatically; it could not be here.');
          out('  check whether a session for +' + probe.canonical + ' already exists,');
          out('  then:  /fixnumber');
        } else if (probe.alive) {
          out('  the number IS still registered, but this device was logged out.');
          out('  register it again:  /reg code ' + phone);
        } else if (probe.error) {
          out('  could not reach the registration endpoint: ' + probe.error);
        } else {
          out('  the registration is gone server-side (' + (probe.status || 'no status') + ').');
          out('  register it again:  /reg code ' + phone);
        }
        // keep the client around so /fixnumber has a store to work from
        _pendingFix = probe.mismatch ? { client, probe } : null;
      } catch (probeErr) {
        out('  status check failed: ' + probeErr.message);
      }
    }
    notConnected();
  }
}

// Put the shell back in its disconnected state.
//
// The prompt is the only standing indication of whether there is a session, so
// it has to be right after a failure: a prompt reading "wa +<number>>" under an
// error saying there is no session for that number is the shell contradicting
// itself.
function notConnected() {
  _client = null;
  _phone  = null;
  if (_rl) { _rl.setPrompt('wa> '); _rl.prompt(); }
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

      case '/session': {
        if (!_client || !_client.store) { fail('not connected'); break; }
        let _meJid = '—';
        try { _meJid = assertMeId(_client.store); } catch (_) {}
        const web = _client._mode === 'web';
        hr();
        kv('phone',   _client.store.phoneNumber);
        kv('mode',    web ? 'web / companion' : 'mobile / primary');
        kv('jid',     web && _client.store.me ? _client.store.me.id : _meJid);
        if (web) {
          kv('lid',    (_client.store.me && _client.store.me.lid) || '—');
          kv('device', String(_client.store.deviceIndex || 0));
          kv('primary', _client.store.platform || '—');
        }
        kv('name',    _client.store.pushName || _client.store.name || '—');
        kv('session', _sessDir);
        hr();
        break;
      }

      case '/connect': {
        const ph = p[1];
        if (!ph) { fail('usage: /connect <phone> [sms|pair]'); break; }
        if (_client && _client.connected) { fail('already connected'); break; }
        const phn = normalizePhone(ph);
        const forced = (p[2] || '').toLowerCase();
        const method = forced === 'pair' || forced === 'pairing' ? 'pairing'
                     : forced === 'sms'                          ? 'sms'
                     : await askLoginMethod(phn);
        out('connecting...');
        if (method === 'pairing') await doConnectWeb(phn);
        else                      await doConnect(phn);
        break;
      }

      case '/fixnumber': {
        if (!_pendingFix) {
          fail('nothing to fix — run /connect <phone> first and let it report a mismatch');
          break;
        }
        const { client, probe } = _pendingFix;
        out('renaming session +' + probe.current + ' → +' + probe.canonical + '...');
        const r = await client.adoptCanonicalNumber(probe.canonical);
        out('  moved ' + r.files.length + ' file(s)');
        _pendingFix = null;
        out('now connect with the number WhatsApp uses:');
        out('  /connect ' + r.phoneNumber);
        break;
      }

      case '/pair': {
        const ph = p[1] || _phone;
        if (!ph) {
          fail('usage: /pair <phone> [8-char-code]');
          out('  the phone number is the account you want to link to, digits only');
          out('  example: /pair 40756469325');
          break;
        }
        if (_client && _client.connected) { fail('already connected — /disconnect first'); break; }
        out('connecting...');
        await doConnectWeb(ph, { customCode: p[2] });
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
        if (!rest.length) {
          fail('usage: /status <text>   |   /status image|video|audio <file> [caption]');
          break;
        }
        const kind = rest[0] && rest[0].toLowerCase();
        let r;
        if ((kind === 'image' || kind === 'video' || kind === 'audio') && rest[1]) {
          const opts = { [kind]: rest[1] };
          if (rest.length > 2) opts.caption = rest.slice(2).join(' ');
          r = await _client.sendStatus(opts);
        } else {
          r = await _client.sendStatus(rest.join(' '));
        }
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

        // The server answers the set IQ before the new about has to be visible
        // anywhere, so "result" is not the same as "changed" — this used to
        // report success on the strength of that empty reply alone. Read it
        // back and say what is actually stored.
        let stored = null;
        try { stored = await _client.queryOwnAbout(); } catch (_) {}
        if (stored === text)  out('about updated');
        else if (stored)      out('sent, but the server still reports: ' + stored);
        else                  out('sent, and the server accepted it — it reports no about for this number yet');

        // An about that is stored and still nowhere to be seen is a privacy
        // setting rather than a failed write: on the wire the category that
        // governs who may read it is "status".
        try {
          const priv = await _client.queryPrivacySettings({ force: true });
          if (priv && priv.status && priv.status !== 'all') {
            out('  about visibility is "' + priv.status + '" — /privacy status all shows it to everyone');
          }
        } catch (_) {}
        break;
      }

      case '/privacy': {
        requireConn();
        const [, type, value] = p;
        // with no arguments, show what the settings currently are
        if (!type) {
          const s = await _client.queryPrivacySettings({ force: true });
          out('  privacy settings');
          for (const k of Object.keys(s)) out('    ' + k.padEnd(14) + (s[k] || '(unset)'));
          break;
        }
        if (!value) {
          fail('usage: /privacy [<type> <value>]');
          out('  types:  last_seen  profile_picture  status  online  read_receipts');
          out('          groups_add  call_add  messages  defense  stickers');
          out('  values: all  contacts  contact_blacklist  contact_allowlist  none');
          out('          not every setting takes every value — read_receipts is');
          out('          all/none, online is all/match_last_seen. on and off are');
          out('          accepted and translated.');
          out('          match_last_seen  known  on_standard  off');
          break;
        }
        await _client.changePrivacySetting(type, value);
        out('privacy updated  ' + type + ' = ' + value);
        break;
      }

      case '/photo': {
        requireConn();
        const file = p[1];
        if (!file) { fail('usage: /photo <file>   (or /photo remove)'); break; }
        if (file !== 'remove' && !fs.existsSync(file)) { fail('file not found: ' + file); break; }
        const buf = file === 'remove' ? null : fs.readFileSync(file);
        const picId = await _client.changeProfilePicture(buf);
        out(picId === 'remove' ? 'profile picture removed'
                               : 'profile picture updated' + (picId ? '  id=' + picId : ''));
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
        const jid  = normalizeJid(p[1]);
        const dest = p[2];
        if (!jid) { fail('usage: /picture <jid> [file]'); break; }
        const info = await _client.queryPictureInfo(jid);
        if (!info || !info.url) { out('  (no picture or private)'); break; }
        out('  ' + info.url);
        if (info.id) out('  id  ' + info.id);
        if (!dest) break;
        const buf = await _client.downloadProfilePicture(jid);
        if (!buf) { fail('download returned nothing'); break; }
        require('fs').writeFileSync(dest, buf);
        out('  saved  ' + dest + '  (' + buf.length + ' bytes)');
        break;
      }

      case '/read': {
        requireConn();
        const jid = normalizeJid(p[1]);
        const ids = p.slice(2);
        if (!jid || !ids.length) { fail('usage: /read <jid> <msgId...>'); break; }
        _client.markRead(jid, ids);
        out('marked read  ' + ids.length + ' message(s) in ' + jid);
        break;
      }

      case '/autoread': {
        const val = (p[1] || '').toLowerCase();
        if (val !== 'on' && val !== 'off') { fail('usage: /autoread on|off'); break; }
        if (_client) _client.autoRead = (val === 'on');
        out('auto read receipts  ' + val);
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

      case '/restriction':
      case '/limit': {
        // --demo feeds a made-up restriction into this session and counts it
        // down, so the display can be checked without waiting to be restricted.
        // Nothing is sent and nothing is asked of the server.
        const demoAt = p.indexOf('--demo');
        if (demoAt !== -1) {
          const secs = parseInt(p[demoAt + 1], 10) || 5 * 3600;
          const { parseTimelockPayload } = require('./lib/ReachoutTimelock');
          if (!_client) { fail('/restriction --demo needs a client; use /connect first'); break; }
          const fake = parseTimelockPayload({
            is_active: true,
            time_enforcement_ends: String(Math.floor(Date.now() / 1000) + secs),
            enforcement_type: 'BIZ_QUALITY'
          });
          const shown = _client._setReachoutTimelock(fake, 'demo');
          hr();
          kv('status',    'RESTRICTED  (demo — not real)');
          kv('reason',    shown.reason);
          kv('remaining', shown.remaining);
          hr();
          _rl && _rl.pause();
          await countdown(_client, shown);
          _rl && _rl.resume();
          // Leave nothing behind that a later check could mistake for real.
          _client._reachoutTimelock = null;
          out('  demo over — nothing was recorded');
          break;
        }

        requireConn();
        const watch = !p.includes('--once');
        out('checking account restriction...');
        let st;
        try {
          st = await _client.fetchReachoutTimelock();
        } catch (e) {
          fail(e.message);
          if (e.mexDecoded !== undefined) {
            out('');
            out('  The reply was read, but it says nothing about a restriction either');
            out('  way — so it is not being reported as an all-clear.');
            out('');
            out('  You will still be told if one starts: the server announces that, and');
            out('  the announcement carries the countdown.');
          } else if (e.mexFormat) {
            out('');
            out('  The query worked, but the reply is in an encoding that could not be');
            out('  decoded. Paste the bytes above when reporting this.');
          } else {
            out('');
            out('  If the reply is sketched above, paste that line when reporting this —');
            out('  it is the server\'s actual answer. Run with --debug for the raw stanza.');
          }
          break;
        }
        hr();
        if (!st.active) {
          kv('status', 'not restricted — you can start new chats');
          hr();
          break;
        }
        kv('status',    'RESTRICTED');
        kv('reason',    st.reason);
        kv('type',      st.enforcementType);
        kv('ends at',   st.endsAtDate ? st.endsAtDate.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : 'unknown');
        kv('remaining', st.remaining);
        hr();
        out('  New chats with people you have never messaged are refused with');
        out('  error 463 until this expires. Existing conversations keep working,');
        out('  and sending more only makes the restriction longer.');
        out('');
        if (watch) {
          _rl && _rl.pause();
          await countdown(_client, st);
          _rl && _rl.resume();
        }
        break;
      }

      case '/appstate': {
        requireConn();
        const snapshot = p.includes('--snapshot');
        const names    = p.slice(1).filter(a => a !== '--snapshot');
        out('syncing app state' + (snapshot ? ' from scratch' : '') + '...');
        const r = await _client.syncAppState(names.length ? names : null, { snapshot });
        if (r.waitingForKeys) {
          out('  no app state key for this session.');
          out('  On a linked (pairing-code) session the key comes from your phone —');
          out('  open WhatsApp there and leave it connected for a moment.');
          out('  On an SMS session this device IS the primary, so there is no app');
          out('  state to read unless you have linked a companion to it.');
          break;
        }
        hr();
        for (const [name, info] of Object.entries(r.collections)) {
          if (info.waitingForKey) { kv(name, 'waiting for key ' + info.waitingForKey); continue; }
          kv(name, 'v' + info.version + '  ' + info.applied + ' change(s)' +
            (info.snapshot ? '  (full re-read)' : '') +
            (info.skipped ? '  ' + info.skipped + ' unreadable' : '') +
            (info.macOk === false ? '  — partial' : ''));
        }
        kv('total', r.applied + ' change(s) applied');
        hr();
        break;
      }

      case '/unread':
        requireConn();
        if (!p[1]) { fail('usage: /unread <jid>'); break; }
        out(chatResult('marked unread', await _client.markChatUnread(normalizeJid(p[1]))));
        break;

      case '/mute': {
        requireConn();
        const jid = normalizeJid(p[1]);
        if (!jid) { fail('usage: /mute <jid> [minutes]'); break; }
        const ms = p[2] ? parseInt(p[2], 10) * 60000 : 0;
        out(chatResult('muted  ' + jid, await _client.muteChat(jid, ms)));
        break;
      }

      case '/unmute':
        requireConn();
        if (!p[1]) { fail('usage: /unmute <jid>'); break; }
        out(chatResult('unmuted', await _client.unmuteChat(normalizeJid(p[1]))));
        break;

      case '/pin':
        requireConn();
        if (!p[1]) { fail('usage: /pin <jid>'); break; }
        out(chatResult('pinned', await _client.pinChat(normalizeJid(p[1]))));
        break;

      case '/unpin':
        requireConn();
        if (!p[1]) { fail('usage: /unpin <jid>'); break; }
        out(chatResult('unpinned', await _client.unpinChat(normalizeJid(p[1]))));
        break;

      case '/archive':
        requireConn();
        if (!p[1]) { fail('usage: /archive <jid>'); break; }
        out(chatResult('archived', await _client.archiveChat(normalizeJid(p[1]))));
        break;

      case '/unarchive':
        requireConn();
        if (!p[1]) { fail('usage: /unarchive <jid>'); break; }
        out(chatResult('unarchived', await _client.unarchiveChat(normalizeJid(p[1]))));
        break;

      case '/star': {
        requireConn();
        const [, jR, msgId, mine] = p;
        if (!jR || !msgId) { fail('usage: /star <jid> <msgId> [me]'); break; }
        out(chatResult('starred', await _client.starMessage(msgId, normalizeJid(jR), mine === 'me')));
        break;
      }

      case '/unstar': {
        requireConn();
        const [, jR, msgId, mine] = p;
        if (!jR || !msgId) { fail('usage: /unstar <jid> <msgId> [me]'); break; }
        out(chatResult('unstarred', await _client.unstarMessage(msgId, normalizeJid(jR), mine === 'me')));
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
        const after = await _client.blockContact(jid);
        out('blocked  ' + jid + '  (' + after.length + ' blocked in total)');
        break;
      }

      case '/unblock': {
        requireConn();
        const jid = normalizeJid(p[1]);
        if (!jid) { fail('usage: /unblock <jid>'); break; }
        const left = await _client.unblockContact(jid);
        out('unblocked  ' + jid + '  (' + left.length + ' blocked in total)');
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
          printParticipantResults('added', await _client.addGroupParticipants(gj, jids));
        }
        else if (sub === 'remove') {
          const gj  = asGroupJid(p[2]);
          const jids = p.slice(3).map(normalizeJid);
          if (!gj || !jids.length) { fail('usage: /group remove <jid> <member...>'); break; }
          printParticipantResults('removed', await _client.removeGroupParticipants(gj, jids));
        }
        else if (sub === 'promote') {
          const gj  = asGroupJid(p[2]);
          const jids = p.slice(3).map(normalizeJid);
          if (!gj || !jids.length) { fail('usage: /group promote <jid> <member...>'); break; }
          printParticipantResults('promoted', await _client.promoteGroupParticipants(gj, jids));
        }
        else if (sub === 'demote') {
          const gj  = asGroupJid(p[2]);
          const jids = p.slice(3).map(normalizeJid);
          if (!gj || !jids.length) { fail('usage: /group demote <jid> <member...>'); break; }
          printParticipantResults('demoted', await _client.demoteGroupParticipants(gj, jids));
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
          const fresh = await _client.revokeGroupInvite(gj);
          out('invite link revoked');
          if (fresh) out('  new link  ' + fresh);
        }
        else if (sub === 'join') {
          const code = p[2];
          if (!code) { fail('usage: /group join <code|link>'); break; }
          const r = await _client.joinGroupWithLink(code);
          out((r.pendingApproval ? 'join request sent  ' : 'joined  ') + r.jid);
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
          for (const pt of r.participants) out('    ' + participantLine(pt));
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
          kv('join approval',    r.joinApprovalMode ? 'required' : 'not required');
          kv('who can add',      r.memberAddMode === 'admin_add' ? 'admins only'
                               : r.memberAddMode === 'all_member_add' ? 'any member' : '—');
          if (r.isCommunity)   kv('community', 'yes');
          if (r.linkedParent)  kv('part of',   r.linkedParent);
          // A suspended group answers every send with a refusal and nothing
          // else, so it has to be said out loud rather than left to be guessed.
          if (r.isSuspended)   kv('suspended',  'yes — this group has been taken down');
          if (r.isIncognito)   kv('incognito',  'yes — phone numbers are hidden');
          kv('size',          String(r.size));
          kv('participants', '(' + r.participants.length + ')');
          for (const p of r.participants) out('    ' + participantLine(p));
          hr();
        }
        else if (sub === 'participants') {
          const gj = asGroupJid(p[2]);
          if (!gj) { fail('usage: /group participants <jid>'); break; }
          const r = await _client.getGroupMetadata(gj);
          if (!r) { out('  no data'); break; }
          out('  ' + r.subject + '  (' + r.participants.length + ' participants)');
          for (const pt of r.participants) out('    ' + participantLine(pt));
        }
        else if (sub === 'photo') {
          const gj   = asGroupJid(p[2]);
          const file = p[3];
          if (!gj || !file) { fail('usage: /group photo <jid> <file>'); break; }
          if (!fs.existsSync(file)) { fail('file not found: ' + file); break; }
          const buf = fs.readFileSync(file);
          const picId = await _client.changeGroupPicture(gj, buf);
          out('group picture updated' + (picId ? '  id=' + picId : ''));
        }
        else if (sub === 'pending') {
          const gj = asGroupJid(p[2]);
          if (!gj) { fail('usage: /group pending <jid>'); break; }
          const list = await _client.queryGroupPendingParticipants(gj);
          if (!list || !list.length) { out('  no pending requests'); break; }
          out('  pending (' + list.length + ')');
          list.forEach(r => out('    ' + r.jid +
            (r.requestedAt ? '   ' + new Date(r.requestedAt * 1000).toISOString() : '')));
        }
        else if (sub === 'approve') {
          const gj   = asGroupJid(p[2]);
          const jids = p.slice(3).map(normalizeJid);
          if (!gj || !jids.length) { fail('usage: /group approve <jid> <member...>'); break; }
          printParticipantResults('approved',
            await _client.approveGroupParticipants(gj, true, jids));
        }
        else if (sub === 'reject') {
          const gj   = asGroupJid(p[2]);
          const jids = p.slice(3).map(normalizeJid);
          if (!gj || !jids.length) { fail('usage: /group reject <jid> <member...>'); break; }
          printParticipantResults('rejected',
            await _client.approveGroupParticipants(gj, false, jids));
        }
        else if (sub === 'add-invite') {
          const gj   = asGroupJid(p[2]);
          const jids = p.slice(3).map(normalizeJid);
          if (!gj || !jids.length) { fail('usage: /group add-invite <jid> <member...>'); break; }
          printParticipantResults('added', await _client.addGroupParticipantsOrInvite(gj, jids));
        }
        else if (sub === 'send-invite') {
          const gj     = asGroupJid(p[2]);
          const member = normalizeJid(p[3]);
          const code   = p[4];
          const exp    = parseInt(p[5], 10) || 0;
          if (!gj || !member || !code) {
            fail('usage: /group send-invite <jid> <member> <code> <expiration>');
            break;
          }
          const r = await _client.sendGroupInvite(member, gj, code, exp);
          out('invitation sent to ' + member + '  id=' + (r && r.id));
        }
        else if (sub === 'accept-invite') {
          const gj      = asGroupJid(p[2]);
          const inviter = normalizeJid(p[3]);
          const code    = p[4];
          const exp     = parseInt(p[5], 10) || 0;
          if (!gj || !inviter || !code) {
            fail('usage: /group accept-invite <jid> <inviter> <code> [expiration]');
            break;
          }
          out('joined ' + await _client.acceptGroupInviteMessage(gj, inviter, code, exp));
        }
        else if (sub === 'preview-invite') {
          const gj      = asGroupJid(p[2]);
          const inviter = normalizeJid(p[3]);
          const code    = p[4];
          const exp     = parseInt(p[5], 10) || 0;
          if (!gj || !inviter || !code) {
            fail('usage: /group preview-invite <jid> <inviter> <code> [expiration]');
            break;
          }
          const r = await _client.queryGroupInviteMessageInfo(gj, inviter, code, exp);
          hr();
          kv('jid',          r.jid);
          kv('subject',      r.subject);
          kv('participants', String(r.size));
          kv('description',  r.description || '—');
          hr();
        }
        else if (sub === 'revoke-invite') {
          const gj     = asGroupJid(p[2]);
          const member = normalizeJid(p[3]);
          if (!gj || !member) { fail('usage: /group revoke-invite <jid> <member>'); break; }
          await _client.revokeGroupInviteForParticipant(gj, member);
          out('invitation to ' + member + ' withdrawn');
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
          for (const pt of g.participants) out('    ' + participantLine(pt));
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
          const method = (p[3] || 'sms').toLowerCase();
          // email method: /reg code <phone> email <address>
          const emailAddr = method === 'email' ? (p[4] || '') : '';
          if (!ph) { fail('usage: /reg code <phone> [sms|voice|wa_old|email <address>]'); break; }
          if (method === 'email' && !emailAddr) {
            fail('email method requires an address — usage: /reg code <phone> email <address>');
            break;
          }
          if (!fs.existsSync(_sessDir)) fs.mkdirSync(_sessDir, { recursive: true });
          const sessFile = path.join(_sessDir, `${ph}.json`);
          let store = loadStore(sessFile);
          if (!store) {
            store = initAuthCreds(ph);
            saveStore(store, sessFile);
          } else if (!store.codePending && !store.registered) {
            // Only check /exist when keys were never used to request a code.
            out('checking device keys...');
            const waVersion = await fetchWaVersion(getDeviceConfig());
            const fresh = await assertRegistrationKeys(store, waVersion);
            if (!fresh) {
              out('  device keys already registered — generating new keys...');
              store = initAuthCreds(ph);
              saveStore(store, sessFile);
              out('  new keys saved — proceed with code below');
            }
          }
          const methodLabel = method === 'email' ? ('email → ' + emailAddr) : method;
          out('requesting ' + methodLabel + ' code for +' + ph + '...');
          const codeOpts = method === 'email' ? { email: emailAddr } : {};
          const r = await requestSmsCode(store, method, codeOpts);
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
          const store = loadStore(file) || initAuthCreds(ph);
          out('verifying...');
          const r = await verifyCode(store, code, registrationPrompts());
          if (r && (r.status === 'ok' || r.status === 'sent' || r.status === 'verified')) {
            if (!fs.existsSync(_sessDir)) fs.mkdirSync(_sessDir, { recursive: true });
            const finalStore = r.store || store;
            finalStore.registered  = true;
            finalStore.codePending = false;
            // Save under the number WhatsApp filed the account as, not the one
            // that was typed — they differ often enough to matter.
            const savedPhone = String(finalStore.phoneNumber || ph);
            const savedFile  = path.join(_sessDir, `${savedPhone}.json`);
            saveStore(finalStore, savedFile);
            if (r.canonicalPhoneNumber) {
              out('note: WhatsApp knows this account as +' + r.canonicalPhoneNumber +
                  ', not +' + r.typedPhoneNumber);
              out('      the session is saved under that number');
            }
            out('registered  session saved to ' + savedFile);
            out('now run: /connect ' + savedPhone);
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
  wa pair    <phone> [code]                 link to an existing account (8-digit code)
  wa listen  <phone>                        connect and listen (stay-alive)
  wa registration --request-code <phone>    request SMS code
  wa registration --register <phone> --code <code>
  wa registration --check <phone>
  wa apk-material <base.apk> [split.apk ...]  read the Android token material
  wa version

options:
  --session <dir>   session directory  (default: ~/.waSession)
  --out <file>      where apk-material writes  (default: <session dir>/android-apk-material.json)
  --sms             connect by registering this number over SMS
  --pair            connect by linking to an existing account (8-digit code)
  --method          sms | voice | wa_old | email  (default: sms)
  --email <address> email address (required when --method email)

debug:
  an interactive session asks once whether to trace the protocol.
  answer y to print every stanza sent and received, n to keep it quiet.

  --debug           trace without asking  (same as WA_DEBUG=1)
  --no-debug, -q    stay quiet without asking  (same as WA_DEBUG=0)
  --trace-bytes     also dump the raw encoded bytes of every stanza

after connecting, type /help for all available commands.
`.trim();

function announceTrace() {
  out('debug full ON — every stanza sent and received will be printed' +
      (TRACE_BYTES ? ', with raw frame bytes' : '') + '.\n');
}

// Ask once, at startup, whether to trace the protocol. Commands that never
// touch the network skip the question entirely. A non-interactive stdin (a
// pipe, a script) is treated as "no" rather than hanging on a prompt that
// nobody is there to answer.
function askDebugMode(cmd) {
  if (TRACE_FORCE_ON)  { enableWireTrace(); announceTrace(); return Promise.resolve(); }
  if (TRACE_FORCE_OFF) return Promise.resolve();
  const OFFLINE = ['version', '--version', '-v', 'help', '--help', '-h'];
  if (cmd && OFFLINE.includes(cmd)) return Promise.resolve();
  if (!process.stdin.isTTY) return Promise.resolve();

  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('do you want debug full?  [y/N] ', (answer) => {
      rl.close();
      if (/^y(es)?$/i.test(String(answer).trim())) {
        enableWireTrace();
        announceTrace();
      }
      resolve();
    });
  });
}

// Donation prompt — asked at startup, right after the debug question. Purely
// optional and interactive-only: a piped/non-TTY run, the offline commands, and
// WA_NO_DONATE=1 all skip it in silence, so nothing about it can get in the way
// of a script or a real command.
function askDonation(cmd) {
  const OFFLINE = ['version', '--version', '-v', 'help', '--help', '-h'];
  if (cmd && OFFLINE.includes(cmd)) return Promise.resolve();
  if (!process.stdin.isTTY) return Promise.resolve();
  if (process.env.WA_NO_DONATE === '1') return Promise.resolve();

  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('do you want to donate USDC to support whalibmob?  [y/N] ', (answer) => {
      rl.close();
      if (/^y(es)?$/i.test(String(answer).trim())) {
        out('');
        hr();
        out('  Kunboruto20 — USDC address (Ethereum · ERC-20)');
        out('  To send crypto, copy the address below:');
        out('');
        out('  0x8AD64F47a715eC24DeF193FBb9aC64d4E857f0f3');
        out('');
        out('  Send ONLY USDC on the Ethereum (ERC-20) network to this address.');
        out('  Every donation keeps whalibmob maintained — thank you!');
        hr();
        out('');
      }
      resolve();
    });
  });
}

async function main() {
  const { cmd, sub, flags, pos } = parseArgs(process.argv);

  await askDebugMode(cmd);
  await askDonation(cmd);

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

  // Read the Android registration token material out of a WhatsApp APK.
  //
  // Registering as Android signs its token with the APK's own signing
  // certificates, the MD5 of its classes.dex, and a key derived from
  // about_logo.png — none of which can be derived, so they are read out of a
  // real APK once and kept. Registering as iOS needs none of it.
  if (cmd === 'apk-material') {
    // parseArgs puts the first non-flag argument in sub, the rest in pos.
    const apks = [sub, ...pos].filter(Boolean);
    if (!apks.length) {
      fail('usage: wa apk-material <base.apk> [split.apk ...]');
      process.exit(1);
    }
    const outFile = flags.out ||
      process.env.WA_ANDROID_APK_MATERIAL ||
      path.join(_sessDir, 'android-apk-material.json');
    try {
      const AndroidApk = require('./lib/AndroidApk');
      const [basePath, ...splitPaths] = apks;
      out('reading ' + basePath + '...');
      const material = AndroidApk.extractMaterial(
        fs.readFileSync(basePath),
        splitPaths.map(p => ({ name: path.basename(p), data: fs.readFileSync(p) }))
      );
      if (flags.version) material.apkVersion = String(flags.version);
      if (!fs.existsSync(_sessDir)) fs.mkdirSync(_sessDir, { recursive: true });
      fs.writeFileSync(outFile, JSON.stringify(AndroidApk.materialToJson(material), null, 2));
      kv('package', material.packageName);
      kv('version', material.apkVersion
        ? material.apkVersion + (material.apkVersionCode ? '  (code ' + material.apkVersionCode + ')' : '')
        : '(not in the manifest — pass --version <x.y.z.w>)');
      kv('certificates', String(material.certificates.length));
      const signer = AndroidApk.describeCertificate(material.certificates[0]);
      if (signer) {
        kv('signed by', signer.subject);
        kv('sha256', signer.fingerprint256);
      }
      kv('classes.dex md5', material.classesDexMd5.toString('hex'));
      kv('written to', outFile);
      out('');
      if (signer && !AndroidApk.looksLikeWhatsAppCertificate(signer)) {
        warn('this APK is not signed by WhatsApp — the subject above is somebody else.');
        out('  Mirrors re-sign the APKs they host, and re-signing replaces the certificate');
        out('  the token is built from. The token will come out well-formed and belong to');
        out('  nobody, which the server answers with bad_token. Use the APK installed on a');
        out('  phone instead: pm path com.whatsapp');
        out('');
      }
      if (material.apkVersion) {
        out('  Registration will announce ' + material.apkVersion + ' from now on, because the');
        out('  token is signed over this APK — the live Play Store version would name a');
        out('  different build. WA_VERSION still overrides it.');
      } else {
        out('  The manifest carries no versionName, so the live Play Store version will be');
        out('  announced. If that does not match this APK, pass --version or set WA_VERSION.');
      }
      out('  Re-run this when you update the APK — classes.dex changes every release.');
    } catch (e) {
      fail(e.message);
      process.exit(1);
    }
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
      const ph        = phone || normalizePhone(pos[0] || '');
      const method    = (flags.method || 'sms').toLowerCase();
      const emailAddr = flags.email || '';
      if (!ph) { fail('phone number required'); process.exit(1); }
      if (method === 'email' && !emailAddr) {
        fail('--method email requires --email <address>');
        process.exit(1);
      }
      if (!fs.existsSync(_sessDir)) fs.mkdirSync(_sessDir, { recursive: true });
      const sessFile = path.join(_sessDir, `${ph}.json`);
      let store = loadStore(sessFile);
      if (!store) {
        // Brand new — generate fresh keys, save immediately, no need to check /exist
        store = initAuthCreds(ph);
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
          store = initAuthCreds(ph);
          saveStore(store, sessFile);
        }
      }
      // If store.codePending === true, keys were already accepted by WhatsApp in a
      // prior /code request — reuse the exact same store without any /exist call.
      const methodLabel = method === 'email' ? ('email → ' + emailAddr) : method;
      out('requesting ' + methodLabel + ' code for +' + ph + '...');
      try {
        const codeOpts = method === 'email' ? { email: emailAddr } : {};
        const r = await requestSmsCode(store, method, codeOpts);
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
      let   ph   = phone || normalizePhone(pos[0] || '');
      const code = flags.code;
      if (!ph)   { fail('phone number required'); process.exit(1); }
      if (!code) { fail('--code is required');    process.exit(1); }
      const file  = path.join(_sessDir, `${ph}.json`);
      const store = loadStore(file) || initAuthCreds(ph);
      out('verifying code for +' + ph + '...');
      try {
        const r = await verifyCode(store, code, registrationPrompts());
        if (r && (r.status === 'ok' || r.status === 'sent' || r.status === 'verified')) {
          if (!fs.existsSync(_sessDir)) fs.mkdirSync(_sessDir, { recursive: true });
          const finalStore = r.store || store;
          finalStore.registered  = true;
          finalStore.codePending = false;
          const savedPhone = String(finalStore.phoneNumber || ph);
          const savedFile  = path.join(_sessDir, `${savedPhone}.json`);
          saveStore(finalStore, savedFile);
          if (r.canonicalPhoneNumber) {
            out('note: WhatsApp knows this account as +' + r.canonicalPhoneNumber +
                ', not +' + r.typedPhoneNumber);
          }
          out('registered  session saved to ' + savedFile);
          out('run: wa connect ' + savedPhone);
          ph = savedPhone;
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
    const forced = String(flags.method || '').toLowerCase();
    const method = flags.pair || forced === 'pair' || forced === 'pairing' ? 'pairing'
                 : flags.sms  || forced === 'sms'                          ? 'sms'
                 : await askLoginMethod(phone);
    // Plain `wa>` until the connection actually opens. Naming the number in the
    // prompt before that says "connected as this number" while the line above
    // it says there is no session, which is the opposite of what happened —
    // doConnect sets the real prompt from the 'connected' event.
    openShell();
    out('connecting to +' + phone + '...');
    if (method === 'pairing') await doConnectWeb(phone);
    else                      await doConnect(phone);
    return;
  }

  if (cmd === 'pair') {
    // `wa pair <phone> [code]` — parseArgs puts the phone in sub, so the
    // optional code is the first positional that remains.
    const phone = normalizePhone(sub || pos[0] || flags.phone || '');
    if (!phone) { fail('phone number required'); process.exit(1); }
    const custom = (sub ? pos[0] : pos[1]) ||
                   (typeof flags.code === 'string' ? flags.code : undefined);
    openShell();
    out('linking +' + phone + ' to an existing WhatsApp account...');
    await doConnectWeb(phone, { customCode: custom });
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
          case 'groupInvite':
            kv('type', 'group invitation  ' + (d.groupName || d.groupJid));
            kv('accept with', '/group accept-invite ' + d.groupJid + ' ' +
               (msg.participant || msg.from) + ' ' + d.inviteCode + ' ' + d.inviteExpiration);
            break;
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
