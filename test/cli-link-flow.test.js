'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { PrimaryMessageStore } = require('../lib/primary/MessageStore');

// The link commands as the owner types them, through the real shell.
//
// The owner's live run of /link-code failed in ways no unit test of the logic
// could see: the shell never ran the bootstrap after the approval, so WhatsApp
// Web sat on "Loading chats" and logged out. Here cli.js runs in a subprocess,
// in a throwaway home, with a stand-in client (test/helpers/fake-cli-client.js)
// that answers from a script and records every call. What is checked is what
// the shell parses, which client calls that turns into, and what it prints,
// including on every failure.

const CLI = path.join(__dirname, '..', 'cli.js');
const FAKE = path.join(__dirname, 'helpers', 'fake-cli-client.js');
const PHONE = '447911123456';
const PROMPT = 'wa +' + PHONE + '> ';
const ESC = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const AT_PROMPT = new RegExp(ESC(PROMPT) + '$');
const ASKING = /\[y\/N\] $/;

const A = 'a1'.repeat(32);            // the request from browser c0ffee01
const B = 'b2'.repeat(32);            // the request from browser deadbe02, newer
const OP = '0f0e0d0c-0b0a-4908-8706-050403020100';
const STARTED = new Date(2026, 10, 2, 15, 31).getTime();

const PARTIAL = {
  ready: true, mode: 'first', blockers: [], needsConfirmation: true,
  history: {
    enabled: true, chats: 3, records: 42, losses: [],
    capture: { origin: 'enabled', since: new Date(2026, 10, 1, 9, 0).getTime() },
    retained: { from: 1761987600, to: 1762077600, evicted: 0 }
  }
};
const COMPLETE = { ...PARTIAL, needsConfirmation: false,
  history: { ...PARTIAL.history, capture: { origin: 'registration', since: new Date(2026, 9, 1, 9, 0).getTime() } } };
// bootstrapPrimaryCompanion() as it resolves (PrimaryBootstrapResult).
const SENT = { status: 'sent', mode: 'first', operationId: OP, delta: null,
  history: { chats: 3, records: 42, bytes: 2048, inline: true, losses: 1, evicted: 0, captureOrigin: 'enabled' } };
const DEVICES = [{ deviceId: 0, keyIndex: 0 }, { deviceId: 3, keyIndex: 1 }];
// getPrimaryLinkStatus() as the library returns it, the journal's link facts included.
const AWAITING = {
  phase: 'awaiting_confirmation', confirmed: false, startedAt: STARTED - 60000, method: 'code', linkedAt: STARTED, expectedDeviceId: 3, deviceId: 3,
  bootstrapPhase: 'sent', bootstrap: { phase: 'sent', errorCode: null, iq: null, resumable: false }, delivered: { chats: 3, records: 42 }, devices: DEVICES, hasADV: false
};
const HOLDER = { v: 2, pid: 4242, host: 'old-box', bootId: 'boot', procStart: null, token: 'f00d', gen: 2, at: STARTED, pidNs: null, legacy: false };
const COMMITTED = { ...AWAITING, phase: 'committed', confirmed: true, bootstrapPhase: null, bootstrap: undefined, delivered: null };

// A companion's public proof, in the shape lib/WhatsAppWebProof.js accepts.
const b64 = (n, fill) => Buffer.alloc(n, fill).toString('base64');
const PROOF = {
  format_version: 1,
  kind: 'whatsapp_web_public_binding',
  proof: {
    jid: PHONE + ':3@s.whatsapp.net', lid: '123456789:3@lid',
    details: b64(40, 1), accountSignatureKey: b64(32, 2), accountSignature: b64(64, 3), deviceSignature: b64(64, 4)
  },
  bootstrap: {}
};

function home(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-link-flow-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The session files that tell the CLI how to connect the number.
function sessions(dir, kinds) {
  const at = path.join(dir, 'sessions', PHONE);
  fs.mkdirSync(at, { recursive: true });
  if (kinds.includes('mobile')) fs.writeFileSync(path.join(at, PHONE + '.json'), JSON.stringify({ registered: true, phoneNumber: PHONE }));
  if (kinds.includes('web')) fs.writeFileSync(path.join(at, PHONE + '.web.json'), JSON.stringify({ registered: true, me: { id: PHONE + ':5@s.whatsapp.net' } }));
}

function scenarioFile(dir, scenario) {
  const file = path.join(dir, 'scenario.json');
  fs.writeFileSync(file, JSON.stringify({ log: path.join(dir, 'calls.jsonl'), ...scenario }));
  return file;
}

function env(dir, scenario) {
  return { PATH: process.env.PATH, HOME: dir, USERPROFILE: dir, WA_SESSION_DIR: dir, WA_NO_DONATE: '1',
    WA_FAKE_CLIENT: scenarioFile(dir, scenario) };
}

function calls(dir, method) {
  const file = path.join(dir, 'calls.jsonl');
  const all = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  return method ? all.filter(c => c.method === method).map(c => c.args) : all;
}

// The shell, typed into a line at a time, the way a person does.
function shell(t, dir, args, scenario) {
  const child = spawn(process.execPath, ['-r', FAKE, CLI, ...args], { cwd: dir, env: env(dir, scenario), stdio: 'pipe' });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let text = '';
  const waiting = new Set();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', d => { text += d; for (const check of waiting) check(); });
  child.stderr.on('data', d => { text += d; });
  const exited = new Promise(resolve => child.on('exit', code => resolve(code)));

  const until = (pattern, from = 0) => new Promise((resolve, reject) => {
    const check = () => {
      if (!pattern.test(text.slice(from))) return;
      waiting.delete(check);
      clearTimeout(timer);
      resolve(text.slice(from));
    };
    const timer = setTimeout(() => {
      waiting.delete(check);
      reject(new Error('no ' + pattern + ' in the output:\n' + text));
    }, 15000);
    waiting.add(check);
    check();
  });

  return {
    until,
    // Types a line; resolves with what was printed after it, once the shell
    // is back at its prompt (or at whatever `pattern` names).
    type(line, pattern = AT_PROMPT) {
      const from = text.length;
      child.stdin.write(line + '\n');
      return until(pattern, from);
    },
    async quit() {
      child.stdin.write('/quit\n');
      assert.equal(await exited, 0, text);
    }
  };
}

// Whether `line` was printed. stdout here is a pipe, not a terminal, so a line
// printed by an event (rather than by a command) follows the prompt that was
// already on the screen; that prompt is not part of what was printed.
const printedLines = text => text.split('\n').map(l => l.replace(/^(?:wa(?: \+\d+)?> )+/, ''));
const has = (text, line) => printedLines(text).includes(line);

test('the owner\'s flow: connect, requests, choose, confirm, approve, hand over, inspect, recover', async (t) => {
  const dir = home(t);
  sessions(dir, ['mobile']);
  const wa = shell(t, dir, ['connect', PHONE, '--session', './sessions'], {
    invitations: [{ id: A, companion: 'c0ffee01', expiresIn: 170000 }, { id: B, companion: 'deadbe02', expiresIn: 175000 }],
    answers: {
      getPrimaryLinkReadiness: [{ result: PARTIAL }],
      approveCompanionCode: [{
        emit: [['primary_link_progress', { phase: 'awaiting_confirmation', operationId: OP }]],
        result: { status: 'awaiting_confirmation', operationId: OP }
      }],
      bootstrapPrimaryCompanion: [
        { result: SENT },
        { error: { code: 'PRIMARY_BOOTSTRAP_HISTORY_UNCERTAIN', message: 'PRIMARY_BOOTSTRAP_HISTORY_UNCERTAIN' } },
        { result: { ...SENT, mode: 'first' } }
      ],
      getPrimaryLinkStatus: [{ result: AWAITING }, { result: AWAITING }, { result: COMMITTED }],
      getPrimaryLinkLockHolder: [{ result: { holder: HOLDER } }],
      unlockPrimaryLink: [
        { error: { code: 'PRIMARY_LINK_STORE_BUSY', holder: { pid: 4242, host: 'old-box', at: STARTED, mutex: true } } },
        { result: { holder: HOLDER } }
      ],
      retireAbsentPrimaryLink: [{ error: { code: 'PRIMARY_LINK_RETIRE_TOO_EARLY' } }],
      reconcilePrimaryLink: [{
        emit: [['primary_linked', { operationId: OP, deviceId: 3, keyIndex: 1 }]],
        result: { status: 'linked', operationId: OP, deviceId: 3, keyIndex: 1 }
      }]
    }
  });

  // wa connect <phone> --session ./sessions: connected, with the store on, in
  // an absolute folder, and each request announced as it arrives.
  const start = await wa.until(new RegExp('id b2b2b2b2\\n' + ESC(PROMPT) + '$'));
  assert.ok(has(start, 'connected as +' + PHONE), start);
  const notice = printedLines(start).join('\n');
  assert.match(notice, /^ {2}link request {3}companion c0ffee01 {3}code window [23]:\d\d {3}id a1a1a1a1$/m);
  assert.match(notice, /^ {2}link request {3}companion deadbe02 {3}code window [23]:\d\d {3}id b2b2b2b2$/m);
  const [[opts]] = calls(dir, 'constructor');
  assert.deepEqual(opts, { sessionDir: path.join(dir, 'sessions'), messageStore: true });

  // /link-invitations: one line per browser, newest first.
  let seen = await wa.type('/link-invitations');
  assert.ok(has(seen, 'pairing requests waiting, newest first:'), seen);
  assert.match(seen, /^ {2}1 {2}browser deadbe02 {3}1 request {3}newest id b2b2b2b2b2b2 {3}expires in 2m \d\ds$/m);
  assert.match(seen, /^ {2}2 {2}browser c0ffee01 {3}1 request {3}newest id a1a1a1a1a1a1 {3}expires in 2m \d\ds$/m);

  // /link-code CODE with two browsers asking: the choice comes first, so
  // nothing is asked yet and nothing is approved.
  seen = await wa.type('/link-code ABCD1234');
  assert.ok(has(seen, 'more than one browser is asking to link, so nothing was approved. Choose the one this code belongs to.'), seen);
  assert.match(seen, /^ {2}or by its number \(numbers shift as requests expire\): {2}\/link-code CODE <number>$/m);
  assert.ok(!seen.includes('[y/N]'), 'asked before the choice was made\n' + seen);
  assert.equal(calls(dir, 'approveCompanionCode').length, 0);

  // /link-code CODE 2: the coverage is shown, and the one question names that browser; Enter is no.
  seen = await wa.type('/link-code ABCD1234 2', ASKING);
  assert.ok(has(seen, 'ready to link (first link)'), seen);
  assert.ok(has(seen, 'history to send: 3 chats, 42 messages'), seen);
  assert.match(seen, /^ {2}capture period +since 2026-11-01 09:00 - the store was switched on then/m);
  assert.ok(seen.endsWith('approve the link with browser c0ffee01 (request a1a1a1a1) and send it this history?  [y/N] '), seen);
  seen = await wa.type('');
  assert.ok(has(seen, 'cancelled: nothing was approved'), seen);
  assert.equal(calls(dir, 'approveCompanionCode').length, 0);

  // The code typed as Web shows it, in two halves, then the choice: one
  // question, then the approval and the handover in one go.
  seen = await wa.type('/link-code ABCD EFGH 2', ASKING);
  assert.equal((seen.match(/\[y\/N\]/g) || []).length, 1, seen);
  seen = await wa.type('yes');
  const order = [
    'approving with the request a1a1a1a1a1a1...',
    '  link       approval sent, not confirmed with a companion proof',
    'approval sent. The binding to the browser stays unconfirmed unless you confirm it with /link-confirm FILE|JSON (needs the companion\'s public proof JSON).',
    'sending the stored history to the companion...',
    'history handed to the companion: 3 chats, 42 messages, 2.0 KB (sent inline), first link',
    'capture period: since the store was switched on, after registration, so anything earlier was never captured',
    'known or possible losses: 1 recorded by the store (messages it saw and could not keep, or a time it was not capturing), so this history is partial'
  ];
  const printed = seen.split('\n');
  assert.deepEqual(order.map(l => printed.indexOf(l)).map((at, n, all) => at >= 0 && (n === 0 || at > all[n - 1])), order.map(() => true), seen);
  assert.ok(!seen.slice(0, seen.lastIndexOf('first link')).includes(PROMPT), 'the prompt was redrawn in the middle of the command\n' + seen);
  assert.deepEqual(calls(dir, 'approveCompanionCode'), [['ABCDEFGH', { invitationId: A }]]);
  assert.deepEqual(calls(dir, 'bootstrapPrimaryCompanion'), [[{ history: 'store' }]]);

  // /linked-devices and /link-status.
  seen = await wa.type('/linked-devices');
  assert.ok(has(seen, 'linked devices  +' + PHONE), seen);
  assert.ok(has(seen, '  #0   this phone (primary)'), seen);
  assert.ok(has(seen, '  #3   companion   key index 1   linked 2026-11-02 15:31 by code   binding unconfirmed   history delivered (3 chats, 42 msgs)'), seen);
  seen = await wa.type('/link-status');
  assert.ok(has(seen, 'link       approval sent, not confirmed with a companion proof, started 2026-11-02 15:30'), seen);
  assert.ok(has(seen, 'bootstrap  sent'), seen);
  assert.ok(has(seen, 'companions #3 key index 1'), seen);

  // /link-bootstrap: a mistyped option is refused; an unanswered step points at the resend; the resend goes.
  seen = await wa.type('/link-bootstrap --resum');
  assert.ok(has(seen, 'error: usage: /link-bootstrap [--resume] [--resend-uncertain]'), seen);
  seen = await wa.type('/link-bootstrap --resume');
  assert.ok(has(seen, 'error: The history was sent but no reply came, so it is not known whether the companion got it.'), seen);
  assert.ok(has(seen, '  next: Do not approve again. Run /link-bootstrap --resume --resend-uncertain to send that step once more under the same message id.'), seen);
  assert.ok(has(seen, '  (PRIMARY_BOOTSTRAP_HISTORY_UNCERTAIN)'), seen);
  seen = await wa.type('/link-bootstrap --resume --resend-uncertain');
  assert.ok(has(seen, 'history handed to the companion: 3 chats, 42 messages, 2.0 KB (sent inline), first link'), seen);
  assert.ok(!/^note:/m.test(seen), seen);
  // --resend-uncertain only counts on a resume, so on its own it is one, and says so.
  seen = await wa.type('/link-bootstrap --resend-uncertain');
  assert.ok(has(seen, 'note: --resend-uncertain only counts on a resume, so this runs as /link-bootstrap --resume --resend-uncertain'), seen);
  assert.deepEqual(calls(dir, 'bootstrapPrimaryCompanion').slice(1), [
    [{ history: 'store', resume: true, resendUncertain: false }],
    [{ history: 'store', resume: true, resendUncertain: true }],
    [{ history: 'store', resume: true, resendUncertain: true }]
  ]);

  // /link-unlock: who holds it, then the question; Enter is no, and nothing is broken.
  seen = await wa.type('/link-unlock', ASKING);
  assert.ok(has(seen, 'the link journal is locked by pid 4242 on old-box, since 2026-11-02 15:31'), seen);
  assert.ok(seen.endsWith('break the lock held by pid 4242 on old-box?  [y/N] '), seen);
  seen = await wa.type('');
  assert.ok(has(seen, 'the lock was left as it is'), seen);
  assert.equal(calls(dir, 'unlockPrimaryLink').length, 0);
  // y: a takeover still running is told to wait and run it again; then the lock goes, the one that was shown.
  await wa.type('/link-unlock', ASKING);
  seen = await wa.type('y');
  assert.match(seen, /^error: A takeover of the link journal's lock is in progress \(pid 4242 on old-box, since 2026-11-02 15:31\), or died part-way\.$/m);
  assert.ok(has(seen, '  next: A recovery is still running on this machine: wait a minute, then run /link-unlock again.'), seen);
  await wa.type('/link-unlock', ASKING);
  seen = await wa.type('yes');
  assert.ok(has(seen, 'broke the link journal lock held by pid 4242 on old-box'), seen);
  assert.deepEqual(calls(dir, 'unlockPrimaryLink'), [[{ holder: HOLDER }], [{ holder: HOLDER }]]);

  // /link-retire, too early.
  seen = await wa.type('/link-retire');
  assert.ok(has(seen, 'error: The unfinished approval is less than 5 minutes old, so it cannot be retired yet.'), seen);
  assert.ok(has(seen, '  (PRIMARY_LINK_RETIRE_TOO_EARLY)'), seen);

  // /link-confirm: from a file (a relative path, as typed), not from JSON that is not a proof, not from a missing file.
  fs.writeFileSync(path.join(dir, 'proof.json'), JSON.stringify(PROOF, null, 2) + '\n');
  seen = await wa.type('/link-confirm proof.json');
  assert.ok(has(seen, '  link       linked and verified   companion #3, key index 1'), seen);
  assert.ok(has(seen, "confirmed: the companion's proof was verified (companion #3)"), seen);
  assert.ok(has(seen, 'next       the history has not been sent, so Web will sit on "Loading chats": run /link-bootstrap --resume'), seen);
  const [[proof]] = calls(dir, 'reconcilePrimaryLink');
  assert.deepEqual(proof, { jid: PROOF.proof.jid, lid: PROOF.proof.lid, details: PROOF.proof.details,
    accountSignatureKey: PROOF.proof.accountSignatureKey, accountSignature: PROOF.proof.accountSignature,
    deviceSignature: PROOF.proof.deviceSignature });

  seen = await wa.type('/link-confirm {"format_version": 1, "kind": "whatsapp_web_public_binding"}');
  assert.ok(has(seen, 'error: That is not a WhatsApp Web public binding proof.'), seen);
  assert.ok(has(seen, '  (PRIMARY_LINK_WEB_PROOF_INVALID)'), seen);
  seen = await wa.type('/link-confirm nowhere.json');
  assert.ok(has(seen, 'error: could not read ' + path.join(dir, 'nowhere.json') + ' (ENOENT)'), seen);
  assert.match(seen, /^ {2}next: Confirming a link needs the companion's public proof JSON/m);
  // The same proof, typed inline, quotes and all.
  seen = await wa.type('/link-confirm ' + JSON.stringify(PROOF));
  assert.ok(has(seen, "confirmed: the companion's proof was verified (companion #3)"), seen);
  assert.equal(calls(dir, 'reconcilePrimaryLink').length, 2);

  await wa.quit();
});

test('a QR link, a link refused before approval, a failure after it, and the events', async (t) => {
  const dir = home(t);
  sessions(dir, ['mobile']);
  // The options before the command, and the store switched off.
  const wa = shell(t, dir, ['--session=./sessions', '--no-message-store', 'connect', PHONE], {
    onConnect: [
      ['primary_link_error', { code: 'PRIMARY_LINK_NOTIFICATION_REJECTED', scope: 'notification', operationId: null }],
      // On a full disk every message fails to be recorded: one report a minute, not one per message.
      ['primary_message_store_error', { code: 'PRIMARY_MESSAGE_STORE_WRITE_FAILED', op: 'append' }],
      ['primary_message_store_error', { code: 'PRIMARY_MESSAGE_STORE_WRITE_FAILED', op: 'append' }],
      ['primary_message_store_error', { code: 'PRIMARY_MESSAGE_STORE_WRITE_FAILED', op: 'append' }]
    ],
    answers: {
      getPrimaryLinkReadiness: [
        { result: COMPLETE },
        { result: { ready: false, mode: null, needsConfirmation: false, history: null,
          blockers: [{ code: 'PRIMARY_LINK_RECONCILIATION_REQUIRED', detail: { phase: 'awaiting_confirmation', ageMs: 120000, retirable: false } }] } }
      ],
      approveCompanionQr: [{ result: { status: 'awaiting_confirmation', operationId: OP } }],
      bootstrapPrimaryCompanion: [{ error: { code: 'PRIMARY_BOOTSTRAP_DEVICE_UNCONFIRMED' } }, { error: { code: 'PRIMARY_LINK_TIMEOUT', resumable: true } }]
    }
  });
  const start = await wa.until(new RegExp(ESC('then run /reconnect.') + '\\n' + ESC(PROMPT) + '$'));
  // Each with the step to take, not just what went wrong.
  const events = printedLines(start);
  const at = (line) => events.indexOf(line);
  const linkError = at('error: link request: A link message from WhatsApp could not be processed.  (PRIMARY_LINK_NOTIFICATION_REJECTED)');
  assert.ok(linkError >= 0, start);
  assert.equal(events[linkError + 1], '  next: Ask Web for a new code and try again; if it repeats, run /link-status and report the code shown.', start);
  const storeError = at('error: message store: The message store could not write to disk.  (PRIMARY_MESSAGE_STORE_WRITE_FAILED, append)');
  assert.ok(storeError >= 0, start);
  assert.equal(events[storeError + 1], '  next: Free disk space or fix permissions on the session folder, then run /reconnect.', start);
  assert.equal(events.filter(line => line.includes('message store:')).length, 1, start);
  const [[opts]] = calls(dir, 'constructor');
  assert.deepEqual(opts, { sessionDir: path.join(dir, 'sessions'), messageStore: false });

  // Complete history: no question, straight to the approval; the bootstrap fails after it.
  let seen = await wa.type('/link-qr 2@ref,noise,identity,adv');
  assert.ok(has(seen, 'ready to link (first link): 3 chats, 42 messages to send'), seen);
  assert.ok(!seen.includes('[y/N]'), seen);
  assert.ok(has(seen, 'approving the QR...'), seen);
  assert.ok(has(seen, "error: WhatsApp's device list does not show exactly one new companion yet."), seen);
  assert.ok(has(seen, '  next: Wait a few seconds and run /link-bootstrap --resume again; if it never appears, check /linked-devices.'), seen);
  assert.ok(has(seen, '  (PRIMARY_BOOTSTRAP_DEVICE_UNCONFIRMED)'), seen);
  assert.ok(has(seen, 'The approval was already sent and stands, so do not repeat it; follow the next step above for the history.'), seen);
  assert.deepEqual(calls(dir, 'approveCompanionQr'), [['2@ref,noise,identity,adv', null]]);

  // The handover, continued by hand, stops at its time limit: the way on is the resume, not a proof or a new code.
  seen = await wa.type('/link-bootstrap --resume');
  assert.ok(has(seen, 'error: The handover to the companion did not finish within 90 seconds (an upload of the history has time of its own).'), seen);
  assert.ok(has(seen, '  next: The approval stands and every step already accepted is kept: continue with /link-bootstrap --resume.'), seen);
  assert.ok(has(seen, '  (PRIMARY_LINK_TIMEOUT)'), seen);

  // Blocked by the readiness check: nothing is approved, and the blocker says what to do.
  seen = await wa.type('/link-code ABCD1234');
  assert.ok(has(seen, 'error: An earlier approval (awaiting_confirmation, 2 min old) has not been finished, so a new one is refused.'), seen);
  assert.match(seen, /^ {2}next: If the companion appeared, finish it with \/link-confirm FILE\|JSON/m);
  assert.ok(has(seen, '  (PRIMARY_LINK_RECONCILIATION_REQUIRED)'), seen);
  assert.equal(calls(dir, 'approveCompanionCode').length, 0);

  // Usage, before anything is asked of the client.
  const before = calls(dir).length;
  for (const [line, usage] of [
    ['/link-code', 'error: usage: /link-code CODE [n|id]'],
    ['/link-code A B C', 'error: usage: /link-code CODE [n|id]'],
    ['/link-code ABCD EFGH 1 2', 'error: usage: /link-code CODE [n|id]'],
    ['/link-qr', 'error: usage: /link-qr PAYLOAD'],
    ['/link-qr a b', 'error: usage: /link-qr PAYLOAD'],
    ['/link-confirm', 'error: usage: /link-confirm FILE|JSON'],
    ['/link-status now', 'error: usage: /link-status'],
    ['/linked-devices all', 'error: usage: /linked-devices'],
    ['/link-invitations x', 'error: usage: /link-invitations'],
    ['/link-retire x', 'error: usage: /link-retire'],
    ['/link-unlock x', 'error: usage: /link-unlock']
  ]) {
    seen = await wa.type(line);
    assert.ok(has(seen, usage), line + '\n' + seen);
  }
  assert.equal(calls(dir).length, before);

  await wa.quit();
});

test('without a connection, and on a companion session, the link commands say what to do', async (t) => {
  const dir = home(t);
  sessions(dir, ['web']);
  const wa = shell(t, dir, ['--session', './sessions'], {});
  await wa.until(/type \/help for commands\nwa> $/);
  for (const line of ['/link-status', '/link-code ABCD1234', '/linked-devices', '/link-unlock', '/link-bootstrap --resume']) {
    const seen = await wa.type(line, /\nwa> $/);
    assert.ok(has(seen, 'error: not connected — use /connect <phone>'), line + '\n' + seen);
  }
  await wa.type('/connect ' + PHONE + ' pair', AT_PROMPT);
  const seen = await wa.type('/link-code ABCD1234');
  assert.ok(has(seen, 'error: Only a number registered through this tool can approve companions, and this session is a companion.'), seen);
  assert.ok(has(seen, '  (PRIMARY_LINK_PRIMARY_REQUIRED)'), seen);
  await wa.quit();
});

// wa listen has no shell: a store failure says to restart wa, never a
// command it cannot take, and a flood of them is one line a minute.
test('wa listen reports store failures once a minute, in words that need no shell', async (t) => {
  const dir = home(t);
  sessions(dir, ['mobile']);
  const write = ['primary_message_store_error', { code: 'PRIMARY_MESSAGE_STORE_WRITE_FAILED', op: 'append' }];
  const child = spawn(process.execPath, ['-r', FAKE, CLI, 'listen', PHONE, '--session', './sessions'], {
    cwd: dir, env: env(dir, { onConnect: [write, write, write, ['primary_message_store_error', { code: 'PRIMARY_MESSAGE_STORE_BUSY', op: 'open' }]] }), stdio: 'pipe'
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let text = '';
  child.stdout.setEncoding('utf8');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no store errors in the output:\n' + text)), 15000);
    child.stdout.on('data', d => {
      text += d;
      if (/PRIMARY_MESSAGE_STORE_BUSY[\s\S]*next: .*\n/.test(text)) { clearTimeout(timer); resolve(); }
    });
  });
  child.kill();
  const lines = printedLines(text);
  assert.ok(has(text, 'connected  listening on +' + PHONE + '  (Ctrl+C to stop)'), text);
  assert.equal(lines.filter(l => l.includes('PRIMARY_MESSAGE_STORE_WRITE_FAILED')).length, 1, text);
  assert.ok(has(text, '  next: Free disk space or fix permissions on the session folder, then restart wa.'), text);
  assert.ok(has(text, '  next: Close the other wa using this session, or wait until it has finished, then restart wa.'), text);
  assert.ok(!/\/reconnect/.test(text), text);
});

test('--reset-message-store starts a damaged store again, and needs the store on', (t) => {
  const dir = home(t);
  sessions(dir, ['mobile']);
  const r = spawnSync(process.execPath, ['-r', FAKE, CLI, 'connect', PHONE, '--reset-message-store', '--session', './sessions'], {
    cwd: dir, env: env(dir, {}), input: '/quit\n', encoding: 'utf8', timeout: 20000
  });
  assert.equal(r.status, 0, r.stdout);
  const [[opts]] = calls(dir, 'constructor');
  assert.deepEqual(opts, { sessionDir: path.join(dir, 'sessions'), messageStore: { setAsideCorrupt: true } });

  const off = spawnSync(process.execPath, ['-r', FAKE, CLI, 'connect', PHONE, '--no-message-store', '--reset-message-store'], {
    cwd: dir, env: env(dir, {}), input: '/quit\n', encoding: 'utf8', timeout: 20000
  });
  assert.equal(off.status, 1, off.stdout);
  assert.match(off.stdout, /--reset-message-store starts the message store again, and --no-message-store keeps none: use one of them/);
  assert.equal(calls(dir, 'constructor').length, 1, 'nothing connected');
});

// ─── the message store starts at registration ────────────────────────────────

function register(dir, args, input, scenario) {
  const r = spawnSync(process.execPath, ['-r', FAKE, CLI, ...args], {
    cwd: dir, env: env(dir, { verify: { status: 'ok' }, ...scenario }), input, encoding: 'utf8', timeout: 20000
  });
  if (r.error) throw r.error;
  return r;
}

function origin(dir, phone) {
  const store = PrimaryMessageStore.open({ dir: path.join(dir, 'sessions', phone), phone });
  try { return store.capture.origin; } finally { store.close(); }
}

const storeFiles = (dir, phone) => fs.existsSync(path.join(dir, 'sessions', phone))
  ? fs.readdirSync(path.join(dir, 'sessions', phone)).filter(f => f.includes('primary-messages')) : [];

test('wa registration --register starts the number\'s message store, marked as since registration', (t) => {
  const dir = home(t);
  const r = register(dir, ['registration', '--register', PHONE, '--code', '123456', '--session', './sessions'], '/quit\n');
  assert.equal(r.status, 0, r.stdout);
  assert.ok(r.stdout.includes('registered  session saved to'), r.stdout);
  assert.doesNotMatch(r.stdout, /warning/, r.stdout);
  assert.equal(origin(dir, PHONE), 'registration');
});

test('/reg confirm in the shell starts the store as well', async (t) => {
  const dir = home(t);
  const wa = shell(t, dir, ['--session', './sessions'], { verify: { status: 'ok' } });
  await wa.until(/type \/help for commands\nwa> $/);
  const seen = await wa.type('/reg confirm ' + PHONE + ' 123456', /\nwa> $/);
  assert.ok(seen.includes('registered  session saved to'), seen);
  assert.doesNotMatch(seen, /warning/, seen);
  await wa.quit();
  assert.equal(origin(dir, PHONE), 'registration');
});

test('--no-message-store registers without a store', (t) => {
  const dir = home(t);
  const r = register(dir, ['registration', '--register', PHONE, '--code', '123456', '--session', './sessions', '--no-message-store'], '/quit\n');
  assert.equal(r.status, 0, r.stdout);
  assert.ok(r.stdout.includes('registered  session saved to'), r.stdout);
  assert.deepEqual(storeFiles(dir, PHONE), []);
});

test('a store that will not open is a warning, and the registration stands', (t) => {
  const dir = home(t);
  const r = register(dir, ['registration', '--register', PHONE, '--code', '123456', '--session', './sessions'], '/quit\n',
    { storeOpenError: 'PRIMARY_MESSAGE_STORE_WRITE_FAILED' });
  assert.equal(r.status, 0, r.stdout);
  assert.ok(r.stdout.split('\n').includes('warning: the message store did not start: The message store could not write to disk. (PRIMARY_MESSAGE_STORE_WRITE_FAILED)'), r.stdout);
  assert.ok(r.stdout.includes('the registration itself is fine'), r.stdout);
  assert.ok(r.stdout.includes('registered  session saved to'), r.stdout);
  assert.ok(fs.existsSync(path.join(dir, 'sessions', PHONE, PHONE + '.json')));
  assert.doesNotMatch(r.stdout, /^\s+at /m, r.stdout);
});

// A number registered again keeps nothing of its earlier store in what it
// hands over: that store began before this registration, and nothing in it
// records the time between. It is renamed aside, not deleted.

const ASIDE = /\.primary-messages\.(log|json)\.before-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/;

function earlierStore(dir) {
  const at = path.join(dir, 'sessions', PHONE);
  fs.mkdirSync(at, { recursive: true });
  const monthAgo = Date.now() - 30 * 86400000;
  const store = PrimaryMessageStore.open({ dir: at, phone: PHONE, lc: 5, now: () => monthAgo });
  store.noteLogin(6);
  store.close();
  return storeFiles(dir, PHONE).sort();
}

test('re-registering a number moves its earlier store aside and starts again from registration', (t) => {
  const dir = home(t);
  const before = earlierStore(dir);
  assert.deepEqual(before, [PHONE + '.primary-messages.json', PHONE + '.primary-messages.log']);
  const started = Date.now();
  const r = register(dir, ['registration', '--register', PHONE, '--code', '123456', '--session', './sessions'], '/quit\n');
  assert.equal(r.status, 0, r.stdout);
  assert.ok(r.stdout.includes('registered  session saved to'), r.stdout);

  // Both files kept, under a name that says when they were set aside.
  const files = storeFiles(dir, PHONE);
  const aside = files.filter(f => ASIDE.test(f));
  assert.deepEqual(aside.map(f => f.replace(/\.before-.*$/, '')).sort(), before, files.join('\n'));
  const stamp = aside[0].replace(/^.*\.before-/, '');
  assert.ok(aside.every(f => f.endsWith(stamp)), 'one stamp for the pair');
  // One line says where.
  const where = path.join(dir, 'sessions', PHONE, PHONE + '.primary-messages.*.before-' + stamp);
  assert.equal(r.stdout.split('\n').filter(l => l.includes(where)).length, 1, r.stdout);

  // The store now begins at this registration, at this moment.
  const store = PrimaryMessageStore.open({ dir: path.join(dir, 'sessions', PHONE), phone: PHONE });
  try {
    assert.equal(store.capture.origin, 'registration');
    assert.ok(store.capture.since >= started && store.capture.since <= Date.now(), JSON.stringify(store.capture));
  } finally { store.close(); }
});

test('re-registering with --no-message-store still sets the earlier store aside, and starts none', (t) => {
  const dir = home(t);
  const before = earlierStore(dir);
  const r = register(dir, ['registration', '--register', PHONE, '--code', '123456', '--session', './sessions', '--no-message-store'], '/quit\n');
  assert.equal(r.status, 0, r.stdout);
  const files = storeFiles(dir, PHONE);
  assert.deepEqual(files.filter(f => !ASIDE.test(f)), [], files.join('\n'));
  assert.deepEqual(files.map(f => f.replace(/\.before-.*$/, '')).sort(), before);
});
