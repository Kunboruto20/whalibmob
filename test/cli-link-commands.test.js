'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// The logic behind the CLI's link commands, tested without a terminal.
//
// The owner ran /link-code against real WhatsApp Web and it failed three ways:
// the journal had nowhere to live, Web's duplicate requests from one browser
// looked like several browsers, and after the approval nothing bootstrapped the
// companion, so Web sat on "Loading chats" until it logged out. Every one of
// those is a sequence of calls and a message to a person, so both are checked
// here against a client that records what it was asked to do.

const fs = require('node:fs');
const path = require('node:path');

const L = require('../lib/cli/linkCommands');
const wa = require('../index');

const LIB = path.join(__dirname, '..', 'lib');
const MIN = 60000;
const NOW = new Date(2026, 10, 2, 15, 40).getTime();       // local time: the output is local time too
const LINKED_AT = new Date(2026, 10, 2, 15, 31).getTime();
const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime();

// Requests are judged against a clock, so these hand them the one their expiries were made from.
const grp = (list, now = NOW) => L.groupInvitations(list, now);
const pick = (list, selector, now = NOW) => L.chooseInvitation(list, selector, now);
const id = ch => ch.repeat(64);                           // an invitation id is a 64-hex sha256
const inv = (ch, companion, expiresAt) => ({ id: id(ch), expiresAt, companion });

// ─── grouping and choosing ──────────────────────────────────────────────────

test('same-companion duplicates collapse to the newest', () => {
    // Web sends the same request about 200 ms apart from one browser.
    const groups = grp([
        inv('a', '1a2b3c4d', NOW + 100),
        inv('b', '1a2b3c4d', NOW + 300),
        inv('c', '1a2b3c4d', NOW + 200)
    ]);
    assert.deepEqual(groups, [{ companion: '1a2b3c4d', newest: { id: id('b'), expiresAt: NOW + 300 }, count: 3 }]);

    // A tie goes to the later arrival, which is the later entry in the journal.
    const tie = grp([inv('a', '1a2b3c4d', NOW + 5), inv('b', '1a2b3c4d', NOW + 5)]);
    assert.equal(tie[0].newest.id, id('b'));

    // Only a unique choice is made on its own.
    assert.deepEqual(pick([inv('a', '1a2b3c4d', NOW + 1), inv('b', '1a2b3c4d', NOW + 2)]), { id: id('b') });
});

test('two companions require an explicit choice', () => {
    const list = [inv('a', '1a2b3c4d', NOW + 100), inv('b', '99887766', NOW + 200), inv('c', '1a2b3c4d', NOW + 300)];
    const groups = grp(list);
    // Newest first: the browser that asked last is listed first.
    assert.deepEqual(groups.map(g => [g.companion, g.count, g.newest.id]), [['1a2b3c4d', 2, id('c')], ['99887766', 1, id('b')]]);
    const choice = pick(list);
    assert.deepEqual(Object.keys(choice), ['ambiguous']);
    assert.deepEqual(choice.ambiguous, groups);
});

test('invitations with no fingerprint are never grouped with each other', () => {
    // A 32-bit label is not proof, and an entry without one is not a duplicate of anything.
    const groups = grp([inv('a', null, NOW + 1), inv('b', null, NOW + 2)]);
    assert.equal(groups.length, 2);
    assert.deepEqual(groups.map(g => [g.companion, g.count]), [[null, 1], [null, 1]]);
    assert.ok('ambiguous' in pick([inv('a', null, NOW + 1), inv('b', null, NOW + 2)]));

    // Not with a fingerprinted one either.
    assert.ok('ambiguous' in pick([inv('a', null, NOW + 1), inv('b', '1a2b3c4d', NOW + 2)]));

    // A lone one is a lone choice.
    assert.deepEqual(pick([inv('a', null, NOW + 1)]), { id: id('a') });
});

test('no invitation is none, and so is a selector that matches nothing', () => {
    assert.deepEqual(pick([]), { none: true });
    assert.deepEqual(pick([], '1'), { none: true });
    assert.deepEqual(pick(undefined), { none: true });
    const list = [inv('a', '1a2b3c4d', NOW + 1), inv('b', '99887766', NOW + 2)];
    assert.deepEqual(pick(list, '3'), { none: true });
    assert.deepEqual(pick(list, '0'), { none: true });
    assert.deepEqual(pick(list, 'zzzzzz'), { none: true });
    assert.deepEqual(pick(list, 'ab12'), { none: true });     // too short to be a prefix, not a number
    assert.deepEqual(pick(list, 'cccccc'), { none: true });   // a prefix nothing has
});

test('numeric and prefix selectors pick the right invitation', () => {
    const list = [inv('a', '1a2b3c4d', NOW + 100), inv('b', '99887766', NOW + 200), inv('a', '1a2b3c4d', NOW + 50)];
    // The first two are two browsers; the third repeats the first. List order after grouping: b, then a (newest of its two).
    const [first, second] = grp(list);
    assert.equal(first.newest.id, id('b'));

    assert.deepEqual(pick(list, '1'), { id: first.newest.id });
    assert.deepEqual(pick(list, '2'), { id: second.newest.id });
    assert.deepEqual(pick(list, 2), { id: second.newest.id });   // a number is accepted as a number too

    // An id prefix of six or more hex characters names that invitation, not its group's newest.
    const two = [inv('a', '1a2b3c4d', NOW + 100), inv('b', '1a2b3c4d', NOW + 200)];
    assert.deepEqual(pick(two, 'aaaaaa'), { id: id('a') });
    assert.deepEqual(pick(two, id('a').slice(0, 20).toUpperCase()), { id: id('a') });
    assert.deepEqual(pick(two, id('b')), { id: id('b') });

    // Six digits is a prefix, not group 123456.
    const digits = [{ id: '123456' + 'a'.repeat(58), expiresAt: NOW + 1, companion: 'aaaaaaaa' }, inv('b', 'bbbbbbbb', NOW + 1)];
    assert.deepEqual(pick(digits, '123456'), { id: digits[0].id });

    // A prefix two invitations share is not a choice.
    const shared = [{ id: 'abcdef' + '1'.repeat(58), expiresAt: NOW + 1, companion: 'aaaaaaaa' }, { id: 'abcdef' + '2'.repeat(58), expiresAt: NOW + 2, companion: 'bbbbbbbb' }];
    assert.ok('ambiguous' in pick(shared, 'abcdef'));
});

// ─── error messages ─────────────────────────────────────────────────────────

function sources(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) sources(p, out);
        else if (entry.name.endsWith('.js')) out.push(p);
    }
    return out;
}

test('explainError covers every error code the library can throw', () => {
    const found = new Set();
    for (const file of sources(LIB)) {
        for (const m of fs.readFileSync(file, 'utf8').matchAll(/['"](PRIMARY_(?:LINK|BOOTSTRAP|MESSAGE_STORE)_[A-Z0-9_]+)['"]/g)) found.add(m[1]);
    }
    // The scan has to be finding the library's codes, or an empty set would pass.
    assert.ok(found.size > 60, 'found only ' + found.size + ' codes');
    for (const code of ['PRIMARY_LINK_STORE_REQUIRED', 'PRIMARY_LINK_INVITATION_AMBIGUOUS', 'PRIMARY_BOOTSTRAP_NAME_REQUIRED', 'PRIMARY_MESSAGE_STORE_DISABLED']) assert.ok(found.has(code), code);

    const generic = L.explainError('PRIMARY_LINK_SOMETHING_NEW').title;
    const bare = [];
    for (const code of [...found].sort()) {
        const e = L.explainError(code);
        assert.equal(typeof e.title, 'string', code);
        assert.equal(typeof e.next, 'string', code);
        if (e.title === generic) bare.push(code);
    }
    assert.deepEqual(bare, [], 'codes with no message of their own');
});

// The bootstrap reads the store and encodes it before anything goes out; when
// the encoder refuses (PRIMARY_HISTORY_EXPORT_*), that comes out of it as one
// code, with the encoder's error as its cause.
test('a history the encoder refused is told as such, and pointed at a command this CLI has', () => {
    const e = L.explainError('PRIMARY_BOOTSTRAP_HISTORY_INVALID');
    assert.notEqual(e.title, L.explainError('PRIMARY_LINK_SOMETHING_NEW').title);
    assert.match(e.title, /history could not be encoded/);
    assert.ok(Object.values(L.COMMANDS).some(command => e.next.includes(command)), e.next);
    assert.match(e.next, /\/link-bootstrap --resume/);
    assert.match(e.next, /report the code shown/);
    for (const text of [e.title, e.next]) {
        assert.ok(text.length > 20 && text.length < 260, text);
        assert.ok(!/PRIMARY_[A-Z]+_[A-Z_]+/.test(text), text);
    }
});

// The stores build their codes from a prefix and a short name, so the scan above
// cannot see them. They are read here the way they are written.
function composed(file, prefix) {
    const out = new Set();
    for (const m of fs.readFileSync(path.join(LIB, file), 'utf8').matchAll(/(?:requireValue\([^;]*?,\s*|failure\()\s*'([A-Z][A-Z0-9_]+)'/g)) out.add(prefix + m[1]);
    return out;
}

test('explainError covers the codes the stores compose from a prefix', () => {
    const codes = new Set([...composed('primary/MessageStore.js', 'PRIMARY_MESSAGE_STORE_'), ...composed('primary/HistoryExport.js', 'PRIMARY_HISTORY_EXPORT_')]);
    for (const code of ['PRIMARY_MESSAGE_STORE_WRITE_FAILED', 'PRIMARY_MESSAGE_STORE_LOG_CORRUPT', 'PRIMARY_HISTORY_EXPORT_SNAPSHOT_INVALID', 'PRIMARY_HISTORY_EXPORT_CUTOFF_INVALID']) assert.ok(codes.has(code), code + ' not found by the scan');
    const generic = L.explainError('PRIMARY_LINK_SOMETHING_NEW').title;
    for (const code of codes) assert.notEqual(L.explainError(code).title, generic, code);
});

test('explainError gives each message a plain title and a next step', () => {
    for (const code of ['PRIMARY_LINK_STORE_REQUIRED', 'PRIMARY_LINK_INVITATION_AMBIGUOUS', 'PRIMARY_LINK_RECONCILIATION_REQUIRED',
        'PRIMARY_LINK_STORE_BUSY', 'PRIMARY_LINK_RETIRE_TOO_EARLY', 'PRIMARY_BOOTSTRAP_NAME_REQUIRED', 'PRIMARY_MESSAGE_STORE_DISABLED']) {
        const e = L.explainError(code);
        assert.deepEqual(Object.keys(e), ['title', 'next'], code);
        for (const text of [e.title, e.next]) {
            assert.ok(text.length > 20 && text.length < 260, code + ': ' + text);
            assert.ok(!text.includes('\n'), code + ' is one line');
            assert.ok(!/PRIMARY_[A-Z]+_[A-Z_]+/.test(text), code + ' leaks a code into the text');
        }
    }
    // The next step is the command that does it.
    assert.match(L.explainError('PRIMARY_LINK_INVITATION_AMBIGUOUS').next, /\/link-invitations/);
    assert.match(L.explainError('PRIMARY_LINK_STORE_BUSY').next, /\/link-unlock/);
    assert.match(L.explainError('PRIMARY_LINK_RETIRE_TOO_EARLY').next, /\/link-retire/);
    assert.match(L.explainError('PRIMARY_LINK_RECONCILIATION_REQUIRED').next, /\/link-confirm/);
    assert.match(L.explainError('PRIMARY_LINK_RECONCILIATION_REQUIRED').next, /\/link-retire/);
});

test('an unknown code gets one generic message that still names the code', () => {
    const a = L.explainError('PRIMARY_LINK_SOMETHING_NEW'), b = L.explainError('PRIMARY_LINK_SOMETHING_ELSE');
    assert.equal(a.title, b.title);
    assert.match(a.next, /PRIMARY_LINK_SOMETHING_NEW/);
    assert.match(b.next, /PRIMARY_LINK_SOMETHING_ELSE/);
    for (const odd of [undefined, null, '', 42, {}]) {
        const e = L.explainError(odd);
        assert.equal(e.title, a.title);
        assert.equal(typeof e.next, 'string');
    }
});

test('a numbered acknowledgement refusal says which number', () => {
    const e = L.explainError('PRIMARY_BOOTSTRAP_ACK_479');
    assert.match(e.title, /479/);
    assert.notEqual(e.title, L.explainError('PRIMARY_LINK_SOMETHING_NEW').title);
    assert.notEqual(e.title, L.explainError('PRIMARY_BOOTSTRAP_ACK_401').title);
    assert.match(L.explainError('PRIMARY_BOOTSTRAP_ACK_401').title, /401/);
});

test('a busy journal names who holds it, and a takeover in progress is told apart', () => {
    const plain = L.explainError('PRIMARY_LINK_STORE_BUSY');
    const holder = L.explainError('PRIMARY_LINK_STORE_BUSY', { holder: { pid: 4242, host: 'box', at: at(2026, 11, 2, 15, 0), legacy: false } });
    assert.match(holder.title, /4242/);
    assert.match(holder.title, /box/);
    assert.match(holder.next, /\/link-unlock/);
    assert.notEqual(holder.title, plain.title);

    const mutex = L.explainError('PRIMARY_LINK_STORE_BUSY', { holder: { pid: 77, host: 'box', at: null, legacy: false, mutex: true } });
    assert.match(mutex.title, /recover|takeover/i);
    assert.match(mutex.next, /\/link-unlock/);
    assert.notEqual(mutex.title, holder.title);

    // A lock in the old bare-pid format has nothing but a pid, perhaps not even that.
    assert.doesNotThrow(() => L.explainError('PRIMARY_LINK_STORE_BUSY', { holder: { legacy: true, pid: null, at: null } }));
    assert.doesNotThrow(() => L.explainError('PRIMARY_LINK_STORE_BUSY', { holder: null }));
});

test('describeError says what happened, what to do, and keeps the code visible', () => {
    const error = Object.assign(new Error('PRIMARY_LINK_INVITATION_AMBIGUOUS'), { code: 'PRIMARY_LINK_INVITATION_AMBIGUOUS' });
    const lines = L.describeError(error);
    assert.equal(lines[0], L.explainError('PRIMARY_LINK_INVITATION_AMBIGUOUS').title);
    assert.ok(lines.some(l => l.includes(L.explainError('PRIMARY_LINK_INVITATION_AMBIGUOUS').next)));
    assert.ok(lines.some(l => l.includes('PRIMARY_LINK_INVITATION_AMBIGUOUS')), 'the stable code is shown');

    // Detail the library puts after the code is kept.
    const detailed = Object.assign(new Error('PRIMARY_MESSAGE_STORE_WRITE_FAILED: disk full'), { code: 'PRIMARY_MESSAGE_STORE_WRITE_FAILED' });
    assert.ok(L.describeError(detailed).some(l => l.includes('disk full')));

    // Not one of ours: its own text, nothing invented.
    assert.deepEqual(L.describeError(new Error('socket hang up')), ['socket hang up']);
    assert.deepEqual(L.describeError('plain text'), ['plain text']);

    // A bootstrap that failed after the approval must not be answered by approving again.
    const after = Object.assign(new Error('PRIMARY_BOOTSTRAP_ACK_UNCERTAIN'), { code: 'PRIMARY_BOOTSTRAP_ACK_UNCERTAIN', afterApproval: true });
    assert.ok(L.describeError(after).some(l => /already (sent|approved)/i.test(l) && /do not/i.test(l)));
    // And the line does not promise a resume the library would refuse.
    const refused = Object.assign(new Error('PRIMARY_BOOTSTRAP_ACK_REJECTED'), { code: 'PRIMARY_BOOTSTRAP_ACK_REJECTED', afterApproval: true });
    assert.ok(!L.describeError(refused).join('\n').includes('/link-bootstrap'));
});

// ─── readiness ──────────────────────────────────────────────────────────────

// The readiness history in its final shape (spec 6.4): capture, retained and losses are three separate
// objects, and the retained range is in seconds, as message timestamps are. The knobs here are flat; the
// result is not.
const sec = ms => Math.floor(ms / 1000);
const coverage = ({ enabled = true, origin = 'registration', since = at(2026, 6, 1, 9, 12), lc = 1, chats = 12, records = 340,
    evicted = 0, from = sec(at(2026, 6, 1, 10, 0)), to = sec(at(2026, 11, 2, 14, 58)), losses = [] } = {}) =>
    ({ enabled, capture: { since, origin, lc }, chats, records, retained: { evicted, from, to }, losses });
const READY = (over = {}) => ({ ready: true, mode: 'first', blockers: [], history: coverage(), needsConfirmation: false, ...over });
const PARTIAL = (history, over = {}) => READY({ history: coverage(history), needsConfirmation: true, ...over });
const ids = n => Array.from({ length: n }, (_, i) => 'MSG' + i);
const BLOCKED = blockers => ({ ready: false, mode: null, blockers, history: null, needsConfirmation: false });

test('formatReadiness states capture, retention and losses as three separate facts', () => {
    const lines = L.formatReadiness(PARTIAL({
        origin: 'enabled', since: at(2026, 6, 1, 9, 12), evicted: 25,
        from: sec(at(2026, 6, 20, 13, 5)), to: sec(at(2026, 11, 2, 14, 58)),
        losses: [{ reason: 'undecryptable', ids: ids(3) }, { reason: 'store-disabled', from: at(2026, 7, 1, 8, 0), to: at(2026, 7, 2, 8, 0) }]
    }));
    const text = lines.join('\n');
    assert.match(text, /12 chats/);
    assert.match(text, /340 messages/);
    const row = label => { const l = lines.filter(x => x.includes(label)); assert.equal(l.length, 1, label + ' appears on one line'); return l[0]; };

    const capture = row('capture period');
    assert.match(capture, /2026-06-01 09:12/);
    assert.match(capture, /store was (switched on|enabled)/i);          // why it begins there
    assert.ok(!/since registration/i.test(capture));
    assert.ok(!/evict|dropped|decrypt|2026-06-20/i.test(capture), 'the capture line says nothing of the other facts');

    const retained = row('retained range');
    assert.match(retained, /2026-06-20 13:05/);                         // the oldest kept, from seconds
    assert.match(retained, /2026-11-02 14:58/);                         // the newest kept
    assert.match(retained, /25 older messages? (was|were) dropped/i);
    assert.ok(!/decrypt|switched on|2026-06-01/i.test(retained));

    const losses = row('known or possible losses');
    assert.match(losses, /3 .*decrypt/i);
    assert.match(losses, /2026-07-01 08:00/);
    assert.match(losses, /2026-07-02 08:00/);
    assert.ok(!/\b25\b|dropped/i.test(losses));
    assert.ok(!/MSG\d/.test(text), 'message ids are never printed');

    // Never one flag.
    assert.ok(!/\bcomplete\b/i.test(text), 'no "complete"');
});

test('formatReadiness counts each reason once and tells the reasons apart', () => {
    const losses = L.formatReadiness(PARTIAL({
        losses: [{ reason: 'undecryptable', ids: ids(2) }, { reason: 'received-not-stored', ids: ids(4) }, { reason: 'undecryptable', ids: ids(1) },
            { reason: 'store-disabled', from: at(2026, 7, 1, 8, 0), to: at(2026, 7, 1, 9, 30) }, { reason: 'store-disabled', from: at(2026, 8, 1, 8, 0), to: at(2026, 8, 1, 8, 5) },
            { reason: 'something-new', ids: ids(2) }]
    })).find(l => l.includes('known or possible losses'));
    assert.match(losses, /3 received messages could not be decrypted/);
    assert.match(losses, /4 received messages were not saved/);
    assert.match(losses, /2026-07-01 08:00 to 2026-07-01 09:30/);
    assert.match(losses, /2026-08-01 08:00 to 2026-08-01 08:05/);
    assert.match(losses, /2 messages lost \(something-new\)/);
    // Singular reads as singular.
    assert.match(L.formatReadiness(PARTIAL({ losses: [{ reason: 'undecryptable', ids: ids(1) }] })).find(l => l.includes('known or possible losses')), /1 received message could not be decrypted/);
});

test('formatReadiness says so when nothing is missing, and never calls it complete', () => {
    const lines = L.formatReadiness(READY());
    const text = lines.join('\n');
    assert.match(text, /since registration/i);
    assert.match(text, /retained range.*2026-06-01 10:00 to 2026-11-02 14:58/);
    assert.match(text, /retained range.*nothing (older )?(was )?dropped/i);
    assert.match(text, /known or possible losses.*none/i);
    assert.ok(!/\bcomplete\b/i.test(text));

    // An unknown start is unknown, not a date.
    const unknown = L.formatReadiness(READY({ history: coverage({ since: null, origin: null }) })).join('\n');
    assert.match(unknown, /capture period.*unknown/i);
    // Nothing kept has no range; a store that could not say how many is not a crash.
    assert.match(L.formatReadiness(READY({ history: coverage({ from: null, to: null, chats: 0, records: 0 }) })).join('\n'), /retained range.*no messages kept/i);
    assert.doesNotThrow(() => L.formatReadiness(READY({ history: coverage({ chats: null, records: null }) })));
    assert.doesNotThrow(() => L.formatReadiness(READY({ history: { enabled: true } })));
    // What a history does not say is unknown, never "nothing": no range is not an empty range, no list of losses is not no losses.
    const silent = L.formatReadiness(READY({ history: { enabled: true, capture: null, retained: null, losses: null } }));
    assert.match(silent.find(l => l.includes('retained range')), /unknown/);
    assert.match(silent.find(l => l.includes('known or possible losses')), /unknown/);
    assert.match(silent.find(l => l.includes('capture period')), /unknown/);
    assert.ok(!silent.some(l => /nothing older|none recorded|no messages kept/.test(l)));
    // No store: nothing to send, and it says so.
    assert.match(L.formatReadiness(READY({ history: null })).join('\n'), /no history|no message store/i);
    assert.match(L.formatReadiness(READY({ history: coverage({ enabled: false }) })).join('\n'), /no history|no message store/i);
});

test('formatReadiness lists every blocker with what to do about it', () => {
    const lines = L.formatReadiness(BLOCKED([
        { code: 'PRIMARY_BOOTSTRAP_NAME_REQUIRED', detail: { maxLength: 25 } },
        { code: 'PRIMARY_LINK_RECONCILIATION_REQUIRED', detail: { phase: 'awaiting_confirmation', startedAt: NOW - 9 * MIN, ageMs: 9 * MIN, retirable: true } },
        { code: 'PRIMARY_BOOTSTRAP_EXISTING_COMPANIONS_UNSUPPORTED', detail: { companions: 2 } }
    ]));
    const text = lines.join('\n');
    assert.match(text, /not ready/i);
    assert.match(text, /\/name/);
    assert.match(text, /\/link-retire/);                    // retirable: the hold is old enough
    assert.match(text, /2 companions?/);
    assert.ok(!/PRIMARY_/.test(text), 'codes stay out of the text');
});

test('a hold that is not yet retirable is pointed at reconcile, not retire', () => {
    const young = L.explainBlocker({ code: 'PRIMARY_LINK_RECONCILIATION_REQUIRED', detail: { phase: 'awaiting_confirmation', startedAt: NOW - MIN, ageMs: MIN, retirable: false } });
    assert.match(young.next, /\/link-confirm/);
    assert.match(young.next, /5 minutes/);
    const old = L.explainBlocker({ code: 'PRIMARY_LINK_RECONCILIATION_REQUIRED', detail: { phase: 'uncertain', startedAt: NOW - 9 * MIN, ageMs: 9 * MIN, retirable: true } });
    assert.match(old.next, /\/link-retire/);
    // A blocker it knows nothing extra about still explains itself.
    assert.deepEqual(L.explainBlocker({ code: 'PRIMARY_BOOTSTRAP_NAME_REQUIRED' }), L.explainError('PRIMARY_BOOTSTRAP_NAME_REQUIRED'));
    assert.match(L.explainBlocker({ code: 'PRIMARY_BOOTSTRAP_FOREIGN_STATE', detail: { reasons: ['local_history', 'server_foreign'], serverVersion: 4 } }).title, /history files/);
    assert.match(L.explainBlocker({ code: 'PRIMARY_MESSAGE_STORE_DISABLED', detail: { reason: 'unreadable', code: 'PRIMARY_MESSAGE_STORE_LOG_CORRUPT' } }).title, /read/i);
});

// ─── runLinkCode ────────────────────────────────────────────────────────────

// A client that records every call it is asked to make and nothing else.
function fake(over = {}) {
    const calls = [];
    const log = (name, ...args) => calls.push([name, ...args]);
    const client = {
        calls,
        names: () => calls.map(c => c[0]),
        async getPrimaryLinkReadiness() { log('getPrimaryLinkReadiness'); return over.readiness || READY(); },
        getPrimaryLinkInvitations() { log('getPrimaryLinkInvitations'); return over.invitations || [inv('a', '1a2b3c4d', NOW + 100)]; },
        async approveCompanionCode(code, options) {
            log('approveCompanionCode', code, options);
            if (over.approveError) throw over.approveError;
            return over.approval || { status: 'awaiting_confirmation', operationId: 'op-1' };
        },
        async approveCompanionQr(payload, options) {
            log('approveCompanionQr', payload, options);
            if (over.approveError) throw over.approveError;
            return over.approval || { status: 'awaiting_confirmation', operationId: 'op-2' };
        },
        async bootstrapPrimaryCompanion(options) {
            log('bootstrapPrimaryCompanion', options);
            if (over.bootstrapError) throw over.bootstrapError;
            return over.bootstrap || { status: 'sent', mode: 'first', operationId: 'op-1', history: { chats: 12, records: 340, bytes: 20480, inline: true }, delta: null };
        },
        confirm: async (readiness, ask) => { log('confirm', ask); return over.confirm === undefined ? true : over.confirm; },
        printed: [],
        print(line) { client.printed.push(line); }
    };
    return client;
}
const run = (client, extra = {}) => L.runLinkCode({ client, code: 'ABCD1234', confirm: client.confirm, print: client.print, now: () => NOW, ...extra });

test('runLinkCode stops on a blocker without approving', async () => {
    const client = fake({ readiness: BLOCKED([{ code: 'PRIMARY_BOOTSTRAP_NAME_REQUIRED', detail: { maxLength: 25 } }, { code: 'PRIMARY_MESSAGE_STORE_DISABLED', detail: { reason: 'disabled' } }]) });
    await assert.rejects(run(client), error => {
        assert.ok(error instanceof Error);
        assert.equal(error.code, 'PRIMARY_BOOTSTRAP_NAME_REQUIRED');                     // the first blocker
        assert.deepEqual(error.blockers.map(b => b.code), ['PRIMARY_BOOTSTRAP_NAME_REQUIRED', 'PRIMARY_MESSAGE_STORE_DISABLED']);
        return true;
    });
    assert.deepEqual(client.names(), ['getPrimaryLinkReadiness']);                     // nothing approved, no invitation even read
    assert.ok(!client.names().includes('approveCompanionCode'));
    assert.ok(!client.names().includes('bootstrapPrimaryCompanion'));

    // The caller can say all of it, from the error alone.
    const described = L.describeError(await run(fake({ readiness: BLOCKED([{ code: 'PRIMARY_BOOTSTRAP_NAME_REQUIRED', detail: { maxLength: 25 } }, { code: 'PRIMARY_MESSAGE_STORE_DISABLED', detail: { reason: 'disabled' } }]) })).catch(e => e)).join('\n');
    assert.match(described, /\/name/);
    assert.match(described, /message store/i);
});

test('runLinkCode asks before a partial-history link and aborts on no', async () => {
    const client = fake({ readiness: PARTIAL({ origin: 'enabled', since: at(2026, 6, 1, 9, 12), evicted: 4 }), confirm: false });
    const result = await run(client);
    assert.deepEqual(result, { status: 'aborted' });
    // The request is chosen first, so the question is about one browser.
    assert.deepEqual(client.names(), ['getPrimaryLinkReadiness', 'getPrimaryLinkInvitations', 'confirm']);
    const text = client.printed.join('\n');
    assert.match(text, /capture period/);
    assert.match(text, /retained range/);
    assert.match(text, /known or possible losses/);

    // Not asked, and not assumed: a caller with no way to ask is a no.
    const mute = fake({ readiness: PARTIAL({ origin: 'enabled' }) });
    assert.deepEqual(await L.runLinkCode({ client: mute, code: 'ABCD1234', print: mute.print, now: () => NOW }), { status: 'aborted' });
    assert.deepEqual(mute.names(), ['getPrimaryLinkReadiness', 'getPrimaryLinkInvitations']);
});

test('runLinkCode names the chosen browser in its question', async () => {
    const client = fake({ readiness: PARTIAL({ origin: 'enabled' }), invitations: [inv('a', '1a2b3c4d', NOW + 100), inv('b', '99887766', NOW + 200)] });
    await run(client, { selector: '2' });
    const [, ask] = client.calls.find(c => c[0] === 'confirm');
    assert.equal(ask.invitationId, id('a'));
    assert.equal(ask.companion, '1a2b3c4d');
    assert.match(ask.question, /browser 1a2b3c4d/);
    assert.match(ask.question, /aaaaaaaa/);                       // the id, as the arrival notice shows it
    assert.ok(!ask.question.includes(id('a')), 'not the whole id');
    assert.ok(!/\[y\/N\]/i.test(ask.question), 'how to answer is the front end\'s');
    // A request with no fingerprint is still named by its id.
    const bare = fake({ readiness: PARTIAL({ origin: 'enabled' }), invitations: [inv('c', null, NOW + 100)] });
    await run(bare);
    const [, bareAsk] = bare.calls.find(c => c[0] === 'confirm');
    assert.match(bareAsk.question, /cccccccc/);
    assert.ok(!/null|undefined/.test(bareAsk.question), bareAsk.question);
});

test('runLinkCode asks nothing while it still needs a choice between browsers', async () => {
    // The owner was asked y/N, then told to choose, then asked again on the re-run.
    const client = fake({ readiness: PARTIAL({ origin: 'enabled' }), invitations: [inv('a', '1a2b3c4d', NOW + 100), inv('b', '99887766', NOW + 200)] });
    const result = await run(client);
    assert.equal(result.status, 'choose');
    assert.deepEqual(client.names(), ['getPrimaryLinkReadiness', 'getPrimaryLinkInvitations']);
    assert.ok(!/capture period/.test(client.printed.join('\n')), 'the coverage waits for the run that asks');
    // Nor when the selector matches nothing, nor when nothing is waiting.
    const none = fake({ readiness: PARTIAL({ origin: 'enabled' }), invitations: [inv('a', '1a2b3c4d', NOW + 100)] });
    assert.equal((await run(none, { selector: '7' })).status, 'choose');
    assert.ok(!none.names().includes('confirm'));
    const empty = fake({ readiness: PARTIAL({ origin: 'enabled' }), invitations: [] });
    await assert.rejects(run(empty), error => error.code === 'PRIMARY_LINK_INVITATION_REQUIRED');
    assert.ok(!empty.names().includes('confirm'));
});

test('runLinkCode does not ask when the history is not known to be partial', async () => {
    const client = fake();
    const result = await run(client);
    assert.equal(result.status, 'sent');
    assert.ok(!client.names().includes('confirm'));
});

test('runLinkCode approves then bootstraps with the chosen invitation', async () => {
    const client = fake({
        readiness: PARTIAL({ origin: 'enabled' }),
        invitations: [inv('a', '1a2b3c4d', NOW + 100), inv('b', '1a2b3c4d', NOW + 300), inv('c', '1a2b3c4d', NOW + 200)]
    });
    const result = await run(client);
    assert.deepEqual(client.names(), ['getPrimaryLinkReadiness', 'getPrimaryLinkInvitations', 'confirm', 'approveCompanionCode', 'bootstrapPrimaryCompanion']);
    assert.deepEqual(client.calls[3], ['approveCompanionCode', 'ABCD1234', { invitationId: id('b') }]);   // the newest of the three duplicates
    assert.deepEqual(client.calls[4], ['bootstrapPrimaryCompanion', { history: 'store' }]);
    assert.equal(result.status, 'sent');
    assert.equal(result.invitationId, id('b'));
    assert.equal(result.approval.operationId, 'op-1');
    assert.equal(result.bootstrap.history.chats, 12);

    // The person sees the history go, and is not told Web is ready.
    const text = client.printed.join('\n');
    assert.match(text, /12 chats/);
    assert.match(text, /340 messages/);
    assert.ok(!/web is ready|loaded/i.test(text), 'nothing here proves Web is ready');
});

test('runLinkCode asks for a choice between companions and approves nothing', async () => {
    const client = fake({ invitations: [inv('a', '1a2b3c4d', NOW + 100), inv('b', '99887766', NOW + 200)] });
    const result = await run(client);
    assert.equal(result.status, 'choose');
    assert.equal(result.groups.length, 2);
    assert.deepEqual(client.names(), ['getPrimaryLinkReadiness', 'getPrimaryLinkInvitations']);
    const text = client.printed.join('\n');
    assert.match(text, /^\s*1\b/m);
    assert.match(text, /^\s*2\b/m);
    assert.match(text, /\/link-code/);
    assert.match(text, /1a2b3c4d/);
    assert.match(text, /99887766/);

    // And with the choice made it goes through, with the other left alone.
    const again = fake({ invitations: [inv('a', '1a2b3c4d', NOW + 100), inv('b', '99887766', NOW + 200)] });
    const chosen = await run(again, { selector: '2' });
    assert.equal(chosen.status, 'sent');
    assert.deepEqual(again.calls.find(c => c[0] === 'approveCompanionCode')[2], { invitationId: id('a') });
});

test('runLinkCode lists the choices again when the selector matches none', async () => {
    const client = fake({ invitations: [inv('a', '1a2b3c4d', NOW + 100)] });
    const result = await run(client, { selector: '7' });
    assert.equal(result.status, 'choose');
    assert.ok(!client.names().includes('approveCompanionCode'));
    assert.match(client.printed.join('\n'), /no (pairing )?request matches/i);
});

test('runLinkCode with no request waiting says to start one on Web', async () => {
    const client = fake({ invitations: [] });
    await assert.rejects(run(client), error => error.code === 'PRIMARY_LINK_INVITATION_REQUIRED');
    assert.deepEqual(client.names(), ['getPrimaryLinkReadiness', 'getPrimaryLinkInvitations']);
});

test('runLinkCode does not hide an approval that failed, and does not bootstrap after it', async () => {
    const failure = Object.assign(new Error('PRIMARY_LINK_CODE_INVALID'), { code: 'PRIMARY_LINK_CODE_INVALID' });
    const client = fake({ approveError: failure });
    await assert.rejects(run(client), error => error === failure && !error.afterApproval);
    assert.ok(!client.names().includes('bootstrapPrimaryCompanion'));
});

test('runLinkCode marks a bootstrap that failed after the approval went through', async () => {
    const failure = Object.assign(new Error('PRIMARY_BOOTSTRAP_ACK_UNCERTAIN'), { code: 'PRIMARY_BOOTSTRAP_ACK_UNCERTAIN' });
    const client = fake({ bootstrapError: failure });
    await assert.rejects(run(client), error => {
        assert.equal(error, failure);                       // the same error, so its code is the library's
        assert.equal(error.afterApproval, true);
        assert.equal(error.invitationId, id('a'));
        assert.equal(error.operationId, 'op-1');
        return true;
    });
    assert.deepEqual(client.names().slice(-2), ['approveCompanionCode', 'bootstrapPrimaryCompanion']);
});

test('runLinkCode does not claim the binding is confirmed when the approval was only sent', async () => {
    const client = fake();
    await run(client);
    const text = client.printed.join('\n');
    assert.match(text, /unconfirmed|not (yet )?confirmed|not verified/i);
    assert.ok(!/binding confirmed/i.test(text));
});

test('formatBootstrapResult reports history, the newer messages and whatever else the bootstrap says', () => {
    const plain = L.formatBootstrapResult({ status: 'sent', mode: 'first', operationId: 'op', history: { chats: 12, records: 340, bytes: 20480, inline: true }, delta: null }).join('\n');
    assert.match(plain, /12 chats/);
    assert.match(plain, /340 messages/);
    assert.match(plain, /20 KB|20\.0 KB/);
    assert.match(plain, /first link/i);

    const blob = L.formatBootstrapResult({ status: 'sent', mode: 'relink', operationId: 'op', history: { chats: 1, records: 1, bytes: 300000, inline: false }, delta: { records: 5 } }).join('\n');
    assert.match(blob, /1 chat\b/);
    assert.match(blob, /1 message\b/);
    assert.match(blob, /upload/i);
    assert.match(blob, /5 newer/i);
    assert.match(blob, /re-link|relink/i);

    const extra = L.formatBootstrapResult({
        status: 'sent', mode: 'first', operationId: 'op', history: { chats: 2, records: 9, bytes: 10, inline: true }, delta: null,
        losses: [{ reason: 'undecryptable', ids: ids(3) }], evicted: 7, captureOrigin: 'enabled'
    }).join('\n');
    assert.match(extra, /3 .*decrypt/i);
    assert.match(extra, /7/);
    assert.match(extra, /switched on|enabled/i);

    // A bootstrap that says none of that is not made to.
    assert.ok(!/decrypt|dropped/i.test(plain));
    assert.doesNotThrow(() => L.formatBootstrapResult({ status: 'sent' }));
    assert.doesNotThrow(() => L.formatBootstrapResult(undefined));
});

// ─── runLinkQr ──────────────────────────────────────────────────────────────

test('runLinkQr checks readiness, asks if partial, approves the QR, then bootstraps', async () => {
    const client = fake({ readiness: PARTIAL({ origin: 'enabled' }) });
    const result = await L.runLinkQr({ client, payload: 'https://wa.me/settings/linked_devices#x', confirm: client.confirm, print: client.print });
    assert.deepEqual(client.names(), ['getPrimaryLinkReadiness', 'confirm', 'approveCompanionQr', 'bootstrapPrimaryCompanion']);
    // The QR names its own browser; the question says it is the one behind the QR.
    const [, ask] = client.calls.find(c => c[0] === 'confirm');
    assert.match(ask.question, /QR/);
    assert.ok(!/\[y\/N\]/i.test(ask.question));
    assert.equal(client.calls[2][1], 'https://wa.me/settings/linked_devices#x');
    assert.deepEqual(client.calls[3], ['bootstrapPrimaryCompanion', { history: 'store' }]);
    assert.equal(result.status, 'sent');
    assert.equal(result.bootstrap.history.records, 340);
    assert.ok(!client.names().includes('getPrimaryLinkInvitations'), 'a QR names its own browser');
});

test('runLinkQr stops on a blocker and aborts on no, approving nothing', async () => {
    const blocked = fake({ readiness: BLOCKED([{ code: 'PRIMARY_LINK_ACCOUNT_REQUIRED', detail: {} }]) });
    await assert.rejects(L.runLinkQr({ client: blocked, payload: 'x', print: blocked.print }), error => error.code === 'PRIMARY_LINK_ACCOUNT_REQUIRED');
    assert.deepEqual(blocked.names(), ['getPrimaryLinkReadiness']);

    const no = fake({ readiness: PARTIAL({ evicted: 2 }), confirm: false });
    assert.deepEqual(await L.runLinkQr({ client: no, payload: 'x', confirm: no.confirm, print: no.print }), { status: 'aborted' });
    assert.deepEqual(no.names(), ['getPrimaryLinkReadiness', 'confirm']);
});

test('runLinkQr marks a bootstrap that failed after the approval', async () => {
    const failure = Object.assign(new Error('PRIMARY_BOOTSTRAP_PATCH_REJECTED'), { code: 'PRIMARY_BOOTSTRAP_PATCH_REJECTED' });
    const client = fake({ bootstrapError: failure });
    await assert.rejects(L.runLinkQr({ client, payload: 'x', print: client.print }), error => error === failure && error.afterApproval === true && error.operationId === 'op-2');
});

// ─── /linked-devices ────────────────────────────────────────────────────────

test('formatLinkedDevices shows the primary, each companion, binding and history', () => {
    const lines = L.formatLinkedDevices({
        phone: '447949738354',
        devices: [{ deviceId: 12, keyIndex: 3 }],
        journal: { phase: 'awaiting_confirmation', confirmed: false, startedAt: LINKED_AT, expectedDeviceId: 12, method: 'code', bootstrapPhase: 'sent' },
        history: { chats: 12, records: 340 }
    });
    assert.deepEqual(lines, [
        'linked devices  +447949738354',
        '  #0   this phone (primary)',
        '  #12  companion   key index 3   linked 2026-11-02 15:31 by code   binding unconfirmed   history delivered (12 chats, 340 msgs)'
    ]);
});

// The spec 6.9 row from getPrimaryLinkStatus() alone: how and when it was
// linked, and what history it was handed, are in the journal.
test('formatLinkedDevices reads the method, the time, the device and the delivered history from the status', () => {
    const status = { hasADV: false, confirmed: false, phase: 'awaiting_confirmation', startedAt: LINKED_AT - 2 * MIN, method: 'code', linkedAt: LINKED_AT,
        expectedDeviceId: null, deviceId: 12, bootstrapPhase: 'sent', bootstrap: { phase: 'sent', errorCode: null, iq: null, resumable: false },
        delivered: { chats: 12, records: 340 }, devices: [PRIMARY, { deviceId: 12, keyIndex: 3 }, { deviceId: 15, keyIndex: 4 }] };
    assert.deepEqual(L.formatLinkedDevices({ phone: '447949738354', devices: status.devices, journal: status }), [
        'linked devices  +447949738354',
        '  #0   this phone (primary)',
        '  #12  companion   key index 3   linked 2026-11-02 15:31 by code   binding unconfirmed   history delivered (12 chats, 340 msgs)',
        '  #15  companion   key index 4   binding unconfirmed   history unknown'
    ]);
    // By QR, and not sent yet: no counts.
    const qr = L.formatLinkedDevices({ phone: '1', devices: [{ deviceId: 12, keyIndex: 3 }], journal: { ...status, method: 'qr', bootstrapPhase: 'history_sending', delivered: null } })[2];
    assert.match(qr, /linked 2026-11-02 15:31 by qr/);
    assert.match(qr, /history stopped at history_sending$/);
    // A journal from before linkedAt was kept: the approval's start stands in for it.
    const older = L.formatLinkedDevices({ phone: '1', devices: [{ deviceId: 12, keyIndex: 3 }], journal: { ...status, linkedAt: null, startedAt: LINKED_AT } })[2];
    assert.match(older, /linked 2026-11-02 15:31 by code/);
});

test('formatLinkedDevices claims a confirmed binding only for a reconciled proof', () => {
    const base = { phone: '+447949738354', devices: [{ deviceId: 12, keyIndex: 3 }], history: { chats: 1, records: 2 } };
    const row = journal => L.formatLinkedDevices({ ...base, journal })[2];
    const sent = { startedAt: LINKED_AT, expectedDeviceId: 12, method: 'qr', bootstrapPhase: 'sent' };

    assert.match(row({ ...sent, phase: 'committed', confirmed: true }), /binding confirmed/);
    assert.match(row({ ...sent, phase: 'committed', confirmed: true }), /by qr/);
    // Anything less is unconfirmed: the approval alone, a commit the device list did not back, a flag with no commit.
    assert.match(row({ ...sent, phase: 'awaiting_confirmation', confirmed: false }), /binding unconfirmed/);
    assert.match(row({ ...sent, phase: 'committed', confirmed: false }), /binding unconfirmed/);
    assert.match(row({ ...sent, phase: 'awaiting_confirmation', confirmed: true }), /binding unconfirmed/);
    assert.match(row({ ...sent, phase: 'uncertain' }), /binding unconfirmed/);
    assert.match(row(null), /binding unconfirmed/);
    assert.match(row(undefined), /binding unconfirmed/);
    for (const j of [null, { ...sent, phase: 'awaiting_confirmation' }]) assert.ok(!/binding confirmed/.test(row(j)));

    // A confirmed link says nothing for a companion it is not about.
    const other = L.formatLinkedDevices({ ...base, devices: [{ deviceId: 12, keyIndex: 3 }, { deviceId: 15, keyIndex: 4 }], journal: { ...sent, phase: 'committed', confirmed: true } });
    assert.match(other[2], /^  #12 .*binding confirmed/);
    assert.match(other[3], /^  #15 .*binding unconfirmed/);
    assert.ok(!/linked 2026|history delivered/.test(other[3]));
});

test('formatLinkedDevices ties the journal to a device only when it can', () => {
    const j = { phase: 'committed', confirmed: true, startedAt: LINKED_AT, method: 'code', bootstrapPhase: 'sent' };
    const base = { phone: '1', history: { chats: 1, records: 1 } };

    // One companion and a link in the journal: it is that one.
    assert.match(L.formatLinkedDevices({ ...base, devices: [{ deviceId: 12, keyIndex: 3 }], journal: j })[2], /linked 2026-11-02 15:31 by code/);
    // Two, and nothing says which: neither is claimed.
    const two = L.formatLinkedDevices({ ...base, devices: [{ deviceId: 12, keyIndex: 3 }, { deviceId: 15, keyIndex: 4 }], journal: j });
    for (const line of two.slice(2)) assert.ok(/binding unconfirmed/.test(line) && !/linked 2026|delivered/.test(line), line);
    // Two, and the journal names one by device id or by key index.
    const byId = L.formatLinkedDevices({ ...base, devices: [{ deviceId: 12, keyIndex: 3 }, { deviceId: 15, keyIndex: 4 }], journal: { ...j, deviceId: 15 } });
    assert.match(byId[3], /#15 .*linked 2026-11-02 15:31/);
    assert.ok(!/linked 2026/.test(byId[2]));
    const byIndex = L.formatLinkedDevices({ ...base, devices: [{ deviceId: 12, keyIndex: 3 }, { deviceId: 15, keyIndex: 4 }], journal: { ...j, keyIndex: 3 } });
    assert.match(byIndex[2], /#12 .*linked 2026-11-02 15:31/);
    // A link that never got as far as an approval describes no device.
    for (const phase of ['idle', 'exchange', 'exchange_failed', 'abandoned', 'verification_required']) {
        const line = L.formatLinkedDevices({ ...base, devices: [{ deviceId: 12, keyIndex: 3 }], journal: { ...j, phase, confirmed: false } })[2];
        assert.ok(!/linked 2026|delivered/.test(line), phase + ': ' + line);
    }
});

test('formatLinkedDevices reports how far the history got', () => {
    const base = { phone: '1', devices: [{ deviceId: 12, keyIndex: 3 }] };
    const row = (bootstrapPhase, extra = {}, history) => L.formatLinkedDevices({ ...base, history, journal: { phase: 'awaiting_confirmation', startedAt: LINKED_AT, method: 'code', bootstrapPhase, ...extra } })[2];

    assert.match(row('sent', {}, { chats: 1, records: 1 }), /history delivered \(1 chat, 1 msg\)/);
    assert.match(row('sent'), /history delivered$/);                                         // sent, but nobody told it the numbers
    assert.match(row(null), /history not sent/);
    assert.match(row('key_share_sending', { bootstrap: { phase: 'key_share_sending', errorCode: 'PRIMARY_BOOTSTRAP_ACK_UNCERTAIN' } }), /history stopped at key_share_sending/);
    assert.ok(!/delivered/.test(row('history_sending', {}, { chats: 9, records: 9 })), 'numbers are shown only for a delivery');

    // No companions at all.
    assert.deepEqual(L.formatLinkedDevices({ phone: '447949738354', devices: [], journal: null }), [
        'linked devices  +447949738354',
        '  #0   this phone (primary)',
        '  no companion linked'
    ]);
    // Not a phone number it was given, not a crash.
    assert.doesNotThrow(() => L.formatLinkedDevices({}));
});

// ─── /link-status ───────────────────────────────────────────────────────────

// getPrimaryLinkStatus().devices always lists the primary, device 0, with the companions.
const PRIMARY = { deviceId: 0, keyIndex: 0 };

test('formatLinkStatus names the binding, the bootstrap and the companions', () => {
    const idle = L.formatLinkStatus({ hasADV: false, confirmed: false, phase: 'idle', startedAt: null, expectedDeviceId: null, bootstrapPhase: null, devices: [{ deviceId: 0, keyIndex: 0 }] }).join('\n');
    assert.match(idle, /link\s+idle/i);
    assert.match(idle, /binding\s+unconfirmed/i);
    assert.match(idle, /bootstrap\s+not started/i);
    assert.match(idle, /companions\s+none/i);

    const sent = L.formatLinkStatus({
        hasADV: true, confirmed: true, phase: 'committed', startedAt: LINKED_AT, expectedDeviceId: 12, bootstrapPhase: 'sent',
        bootstrap: { phase: 'sent', errorCode: null, iq: null }, devices: [PRIMARY, { deviceId: 12, keyIndex: 3 }]
    }).join('\n');
    assert.match(sent, /binding\s+confirmed/i);
    assert.match(sent, /bootstrap\s+sent/i);
    assert.match(sent, /#12/);
    assert.match(sent, /key index 3/);

    // Awaiting the browser's proof: the binding is not confirmed, and the way forward is given.
    const waiting = L.formatLinkStatus({ hasADV: true, confirmed: false, phase: 'awaiting_confirmation', startedAt: LINKED_AT, expectedDeviceId: 12, bootstrapPhase: null, devices: [PRIMARY, { deviceId: 12, keyIndex: 3 }] }).join('\n');
    assert.match(waiting, /binding\s+unconfirmed/i);
    assert.ok(!/binding\s+confirmed/i.test(waiting));
    assert.match(waiting, /\/link-confirm/);

    // A bootstrap that stopped says why and what to do.
    const stopped = L.formatLinkStatus({
        hasADV: true, confirmed: false, phase: 'awaiting_confirmation', startedAt: LINKED_AT, expectedDeviceId: 12, bootstrapPhase: 'history_sending',
        bootstrap: { phase: 'history_sending', errorCode: 'PRIMARY_BOOTSTRAP_HISTORY_UNCERTAIN', iq: null }, devices: [PRIMARY, { deviceId: 12, keyIndex: 3 }]
    }).join('\n');
    assert.match(stopped, /history_sending/);
    assert.match(stopped, new RegExp(L.explainError('PRIMARY_BOOTSTRAP_HISTORY_UNCERTAIN').next.slice(0, 30).replace(/[/.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotThrow(() => L.formatLinkStatus(undefined));
});

// ─── invitations listing ────────────────────────────────────────────────────

test('formatInvitations numbers the browsers, newest first, with how long each has left', () => {
    const groups = grp([inv('a', '1a2b3c4d', NOW + 100000), inv('b', '1a2b3c4d', NOW + 120000), inv('c', null, NOW + 30000)]);
    const lines = L.formatInvitations(groups, NOW);
    const text = lines.join('\n');
    assert.match(lines.find(l => /^\s*1\b/.test(l)), /1a2b3c4d.*2 requests.*2m 00s/);
    assert.match(lines.find(l => /^\s*2\b/.test(l)), /unidentified.*1 request\b.*30s/);
    assert.match(text, /\/link-code/);
    assert.ok(text.includes(id('b').slice(0, 12)), 'the newest request is named by a prefix the person can paste');
    assert.deepEqual(L.formatInvitations([], NOW).join('\n').match(/no pairing request/i)?.length, 1);
});

// ─── every instruction is a command, and a flag, that exists ────────────────

function libCodes() {
    const found = new Set();
    for (const file of sources(LIB)) {
        for (const m of fs.readFileSync(file, 'utf8').matchAll(/['"](PRIMARY_(?:LINK|BOOTSTRAP|MESSAGE_STORE)_[A-Z0-9_]+)['"]/g)) found.add(m[1]);
    }
    for (const code of [...composed('primary/MessageStore.js', 'PRIMARY_MESSAGE_STORE_'), ...composed('primary/HistoryExport.js', 'PRIMARY_HISTORY_EXPORT_')]) found.add(code);
    return [...found].sort();
}

// Everything the module can say to a person, from every state it can describe.
function corpus() {
    const out = [];
    const take = (...parts) => { for (const part of parts.flat(Infinity)) out.push(String(part)); };
    for (const code of [...libCodes(), 'PRIMARY_BOOTSTRAP_ACK_401', 'PRIMARY_BOOTSTRAP_ACK_479', 'PRIMARY_LINK_SOMETHING_NEW']) {
        const e = L.explainError(code);
        take(e.title, e.next);
    }
    for (const holder of [null, { pid: 1, host: 'h', at: NOW, legacy: false }, { pid: 2, host: 'h', at: null, legacy: false, mutex: true }, { legacy: true, pid: null, at: null }]) {
        for (const context of [undefined, 'unlock']) {
            const e = L.explainError('PRIMARY_LINK_STORE_BUSY', { holder }, context);
            take(e.title, e.next);
        }
    }
    const detail = {
        PRIMARY_LINK_RECONCILIATION_REQUIRED: [{ phase: 'uncertain', ageMs: 9 * MIN, retirable: true }, { phase: 'awaiting_confirmation', ageMs: MIN, retirable: false }, {}],
        PRIMARY_BOOTSTRAP_EXISTING_COMPANIONS_UNSUPPORTED: [{ companions: 2 }, { companions: null }],
        PRIMARY_BOOTSTRAP_FOREIGN_STATE: [{ reasons: ['local_keys', 'server_unknown', 'server_foreign', 'server_unverified', 'local_state', 'local_history'] }, {}],
        PRIMARY_MESSAGE_STORE_DISABLED: [{ reason: 'disabled' }, { reason: 'unreadable', code: 'PRIMARY_MESSAGE_STORE_LOG_CORRUPT' }]
    };
    for (const [code, details] of Object.entries(detail)) for (const d of details) { const e = L.explainBlocker({ code, detail: d }); take(e.title, e.next); }
    for (const code of libCodes()) {
        const error = Object.assign(new Error(code), { code, afterApproval: true, blockers: [{ code, detail: {} }, { code: 'PRIMARY_BOOTSTRAP_NAME_REQUIRED', detail: {} }] });
        take(L.describeError(error), L.describeError(error, 'unlock'));
    }
    const phases = ['idle', 'exchange', 'finish_verified', 'pair_device_sending', 'awaiting_confirmation', 'uncertain', 'verification_required', 'exchange_failed', 'committed', 'abandoned'];
    const steps = [null, 'prepared', 'key_share_sending', 'critical_patch_sending', 'history_sending', 'delta_sending', 'sent'];
    for (const phase of phases) for (const bootstrapPhase of steps) for (const companions of [[], [{ deviceId: 12, keyIndex: 3 }]]) for (const confirmed of [false, true]) {
        for (const errorCode of [null, 'PRIMARY_BOOTSTRAP_HISTORY_UNCERTAIN', 'PRIMARY_BOOTSTRAP_ACK_REJECTED', 'PRIMARY_BOOTSTRAP_PATCH_REJECTED']) {
            take(L.formatLinkStatus({ hasADV: true, confirmed, phase, startedAt: LINKED_AT, expectedDeviceId: null, bootstrapPhase,
                bootstrap: bootstrapPhase ? { phase: bootstrapPhase, errorCode, iq: null } : undefined, devices: [PRIMARY, ...companions] }));
        }
    }
    take(L.formatReadiness(BLOCKED(Object.keys(detail).map(code => ({ code, detail: detail[code][0] })))));
    take(L.formatReadiness(PARTIAL({ origin: 'enabled', evicted: 3, losses: [{ reason: 'undecryptable', ids: ids(2) }] })), L.formatReadiness(READY()));
    take(L.formatInvitations(grp([inv('a', '1a2b3c4d', NOW + 1000), inv('b', null, NOW + 2000)]), NOW), L.formatInvitations([], NOW));
    take(L.formatInvitationNotice(inv('a', '1a2b3c4d', NOW + 180000), NOW), L.formatInvitationNotice(inv('b', null, NOW + 180000), NOW));
    take(L.formatBootstrapResult({ status: 'sent', mode: 'first', history: { chats: 1, records: 1, bytes: 1, inline: true }, delta: { records: 2 } }));
    take(L.formatLinkedDevices({ phone: '1', devices: [{ deviceId: 12, keyIndex: 3 }], journal: { phase: 'awaiting_confirmation', method: 'code', bootstrapPhase: null, startedAt: LINKED_AT } }));
    return out;
}

test('no message sends anyone to a command the CLI does not have', () => {
    const text = corpus().join('\n');
    assert.ok(text.length > 20000, 'the corpus is the whole vocabulary, not a sample');
    assert.ok(!text.includes('/link-reconcile'), 'the command that confirms a link is /link-confirm');
    // The commands of spec 6.9, plus the ones the CLI already has that the messages lean on.
    const known = new Set(['/link-code', '/link-qr', '/link-invitations', '/link-status', '/linked-devices', '/link-retire', '/link-confirm', '/link-bootstrap', '/link-unlock',
        '/connect', '/disconnect', '/reconnect', '/name', '/reg']);
    const named = new Set([...text.matchAll(/(?:^|[\s(])(\/[a-z][a-z-]*)/gm)].map(m => m[1]));
    assert.deepEqual([...named].filter(c => !known.has(c)), [], 'a command that does not exist');
    for (const c of ['/link-code', '/link-status', '/link-bootstrap', '/link-confirm', '/link-retire', '/link-unlock', '/linked-devices', '/link-invitations']) assert.ok(named.has(c), c + ' is never named');
    assert.match(L.COMMANDS.reconcile, /^\/link-confirm FILE\|JSON$/);
});

test('the bootstrap is always named with --resume, and the resend flag is the one the library honours', () => {
    const text = corpus().join('\n');
    assert.ok(text.includes('/link-bootstrap --resume'));
    // A bare /link-bootstrap after an attempt is refused as already attempted, whose own message must not send anyone back to it.
    assert.deepEqual(text.match(/\/link-bootstrap(?! --resume)/g), null, 'a /link-bootstrap with no --resume');
    assert.ok(!/--resend(\s|$)/m.test(text), '--resend is not a flag');
    assert.deepEqual(text.match(/(?<!--resume )--resend-uncertain/g), null, 'resendUncertain only counts on a resume');
    for (const code of ['PRIMARY_BOOTSTRAP_KEY_SHARE_UNCERTAIN', 'PRIMARY_BOOTSTRAP_HISTORY_UNCERTAIN', 'PRIMARY_BOOTSTRAP_ACK_UNCERTAIN']) {
        assert.match(L.explainError(code).next, /\/link-bootstrap --resume --resend-uncertain/, code);
    }
    assert.match(L.COMMANDS.bootstrap, /^\/link-bootstrap --resume$/);
    assert.match(L.COMMANDS.resend, /^\/link-bootstrap --resume --resend-uncertain$/);
});

test('a refused bootstrap step is not sent back to a resume the library would refuse', () => {
    // Any ACK that refuses a step stops the attempt at that step: resuming it is ALREADY_ATTEMPTED, so a message that
    // says "continue" would loop. The approval stands; the way out is to start over.
    for (const code of ['PRIMARY_BOOTSTRAP_ACK_REJECTED', 'PRIMARY_BOOTSTRAP_ACK_', 'PRIMARY_BOOTSTRAP_ACK_401', 'PRIMARY_BOOTSTRAP_ACK_479']) {
        const { title, next } = L.explainError(code);
        assert.ok(title.length > 20, code);
        assert.ok(!next.includes('/link-bootstrap'), code + ' must not send anyone to a resume that cannot work');
        assert.ok(!/do not approve again/i.test(next), code + ' must not forbid and recommend approving in one breath');
        assert.match(next, /cannot be resumed/, code);
        assert.match(next, /Log out/, code);
        assert.match(next, /\/linked-devices/, code);
        assert.match(next, /\/link-retire/, code);
        assert.match(next, /\/link-code/, code);
    }
    // Already attempted points at the status, then at the right way on, and says which is which.
    const attempted = L.explainError('PRIMARY_BOOTSTRAP_ALREADY_ATTEMPTED').next;
    assert.match(attempted, /\/link-status/);
    assert.match(attempted, /\/link-bootstrap --resume/);
    assert.match(attempted, /refus/i);
    // A refusal recorded in the journal is shown with its own way on, never with a resume.
    const status = L.formatLinkStatus({ hasADV: true, confirmed: false, phase: 'awaiting_confirmation', startedAt: LINKED_AT, expectedDeviceId: 12, bootstrapPhase: 'key_share_sending',
        bootstrap: { phase: 'key_share_sending', errorCode: 'PRIMARY_BOOTSTRAP_ACK_REJECTED', iq: null }, devices: [PRIMARY, { deviceId: 12, keyIndex: 3 }] }).join('\n');
    assert.match(status, /cannot be resumed/);
});

// A bootstrap stopped by the link's own limits (its time, a cancel, a dropped
// connection, a disk that refused the journal, an upload that did not go
// through) has every step it got through recorded: the approval stands, and
// the way on is the resume, never a proof or a new approval.
const HANDOVER_STOPS = ['PRIMARY_LINK_TIMEOUT', 'PRIMARY_LINK_ABORTED', 'PRIMARY_LINK_STOPPED', 'PRIMARY_LINK_CONNECTION_CLOSED', 'PRIMARY_LINK_CONNECTION_REQUIRED',
    'PRIMARY_LINK_IQ_UNCONFIRMED', 'PRIMARY_LINK_STORE_WRITE_FAILED', 'PRIMARY_BOOTSTRAP_UPLOAD_TIMEOUT', 'PRIMARY_BOOTSTRAP_UPLOAD_FAILED'];
const coded = (code, extra) => Object.assign(new Error(code), { code }, extra);
const DEVICE = { deviceId: 12, keyIndex: 3 };
const stoppedAt = (bootstrapPhase, errorCode, extra = {}) => L.formatLinkStatus({ hasADV: true, confirmed: false, phase: 'awaiting_confirmation', startedAt: LINKED_AT, expectedDeviceId: 12,
    bootstrapPhase, bootstrap: { phase: bootstrapPhase, errorCode, iq: null, ...extra }, devices: [PRIMARY, DEVICE] });
// The line /link-status gives for the bootstrap: the last `next`.
const handoverNext = lines => lines.filter(l => l.startsWith('next')).pop();

test('a handover stopped by a timeout, a cancel or a dropped connection is pointed at the resume', () => {
    for (const code of HANDOVER_STOPS) {
        // From /link-bootstrap, and after the approval in /link-code or /link-qr.
        for (const lines of [L.describeError(coded(code), 'bootstrap'), L.describeError(coded(code, { afterApproval: true }))]) {
            const text = lines.join('\n');
            assert.match(text, /\/link-bootstrap --resume/, code + '\n' + text);
            assert.ok(!/\/link-confirm|try again|\/link-code|\/link-status/i.test(text), code + '\n' + text);
        }
        // Recorded on the attempt, as /link-status shows it.
        for (const phase of ['prepared', 'key_share_accepted', 'critical_patch_accepted', 'history_prepared', 'history_uploaded']) {
            const next = handoverNext(stoppedAt(phase, code, { resumable: true }));
            assert.match(next, /\/link-bootstrap --resume\b(?! --resend)/, code + ' at ' + phase + ': ' + next);
            assert.ok(!/\/link-confirm|try again/i.test(next), code + ' at ' + phase + ': ' + next);
        }
        // Stopped with a step sent and not answered: that resume needs the resend. (An upload comes before its step is sent.)
        if (/UPLOAD/.test(code)) continue;
        for (const phase of ['key_share_sending', 'history_sending', 'delta_sending']) {
            assert.match(handoverNext(stoppedAt(phase, code, { resumable: true })), /\/link-bootstrap --resume --resend-uncertain/, code + ' at ' + phase);
        }
        // An unanswered patch write is settled by reading it back: no resend.
        assert.match(handoverNext(stoppedAt('critical_patch_sending', code, { resumable: true })), /\/link-bootstrap --resume\b(?! --resend)/, code);
    }
    // The same codes from the approval itself keep their own advice.
    assert.match(L.describeError(coded('PRIMARY_LINK_TIMEOUT')).join('\n'), /\/link-confirm/);
    // A dropped connection is reconnected first.
    assert.match(L.describeError(coded('PRIMARY_LINK_CONNECTION_CLOSED'), 'bootstrap').join('\n'), /\/reconnect.*\/link-bootstrap --resume/);
    // An upload that ran out of time or failed is uploaded again from the saved copy.
    for (const code of ['PRIMARY_BOOTSTRAP_UPLOAD_TIMEOUT', 'PRIMARY_BOOTSTRAP_UPLOAD_FAILED']) assert.match(L.explainError(code).next, /upload/i);
});

test('/link-status never tells anyone to run /link-status', () => {
    const codes = [...libCodes(), 'PRIMARY_BOOTSTRAP_ACK_401', 'PRIMARY_LINK_SOMETHING_NEW', null];
    const steps = [null, 'prepared', 'key_share_sending', 'critical_patch_sending', 'critical_patch_accepted', 'history_prepared', 'history_uploaded', 'history_sending', 'delta_sending', 'sent'];
    const phases = ['idle', 'exchange', 'finish_verified', 'pair_device_sending', 'awaiting_confirmation', 'uncertain', 'verification_required', 'exchange_failed', 'committed', 'abandoned'];
    let seen = 0;
    for (const phase of phases) for (const devices of [[PRIMARY], [PRIMARY, DEVICE]]) for (const bootstrapPhase of steps) {
        for (const errorCode of bootstrapPhase ? codes : [null]) for (const resumable of bootstrapPhase ? [undefined, true, false] : [undefined]) {
            const text = L.formatLinkStatus({ hasADV: true, confirmed: false, phase, startedAt: LINKED_AT, expectedDeviceId: 12, bootstrapPhase,
                bootstrap: bootstrapPhase ? { phase: bootstrapPhase, errorCode, iq: null, resumable } : undefined, devices }).join('\n');
            assert.ok(!text.includes('/link-status'), phase + ' / ' + bootstrapPhase + ' / ' + errorCode + '\n' + text);
            seen++;
        }
    }
    assert.ok(seen > 5000, 'only ' + seen + ' states');
});

test('an attempt that can never continue is shown with the way to start over, whatever its code', () => {
    // A refused patch write answers with an IQ error: final, and a resume would be refused as already attempted.
    const refused = handoverNext(stoppedAt('critical_patch_sending', 'PRIMARY_LINK_IQ_REJECTED', { resumable: false }));
    assert.match(refused, /cannot be resumed/);
    assert.ok(!refused.includes('/link-bootstrap'), refused);
    // The same code on a read that may simply be tried again is a resume.
    assert.match(handoverNext(stoppedAt('critical_patch_sending', 'PRIMARY_LINK_IQ_REJECTED', { resumable: true })), /\/link-bootstrap --resume/);
    // A patch WhatsApp refused is never written again.
    const patch = L.explainError('PRIMARY_BOOTSTRAP_PATCH_REJECTED').next;
    assert.match(patch, /cannot be resumed/);
    assert.ok(!patch.includes('/link-bootstrap'), patch);
});

test('the steps people are told to take are ones this CLI can do', () => {
    assert.match(L.explainError('PRIMARY_MESSAGE_STORE_DISABLED').next, /without --no-message-store/);
    // This tool cannot unlink a companion from the primary: it is logged out where it runs.
    for (const e of [L.explainError('PRIMARY_BOOTSTRAP_EXISTING_COMPANIONS_UNSUPPORTED'), L.explainBlocker({ code: 'PRIMARY_BOOTSTRAP_EXISTING_COMPANIONS_UNSUPPORTED', detail: { companions: 2 } })]) {
        assert.match(e.next, /log out on that device/i);
        assert.match(e.next, /WhatsApp Web: Menu → Log out/);
        assert.match(e.next, /\/linked-devices/);
        assert.ok(!/unlink/i.test(e.next), e.next);
    }
    const stranger = L.explainError('PRIMARY_BOOTSTRAP_PEER_UNMATCHED').next;
    assert.match(stranger, /Log out/);
    assert.match(stranger, /\/linked-devices/);
    assert.ok(!/unlink/i.test(stranger), stranger);
    // /connect refuses while connected, and a number that is not registered is /reg's business.
    const account = L.explainError('PRIMARY_LINK_ACCOUNT_REQUIRED').next;
    assert.ok(account.indexOf('/disconnect') !== -1 && account.indexOf('/disconnect') < account.indexOf('/connect <phone>'), account);
    assert.match(account, /\/reg/);
    // Anywhere /connect is named, /disconnect (or /reconnect) comes first.
    for (const text of corpus()) {
        const at = text.indexOf('/connect');
        if (at !== -1) assert.ok(/\/disconnect|\/reconnect/.test(text.slice(0, at)) || /\/disconnect/.test(text), text);
    }
});

// ─── status, with the real shape ────────────────────────────────────────────

test('formatLinkStatus lists companions only: the primary is device 0 and is always on the list', () => {
    const none = L.formatLinkStatus({ hasADV: false, confirmed: false, phase: 'idle', startedAt: null, expectedDeviceId: null, bootstrapPhase: null, devices: [PRIMARY] }).join('\n');
    assert.match(none, /companions\s+none/);
    assert.ok(!/#0\b/.test(none));
    const one = L.formatLinkStatus({ hasADV: true, confirmed: false, phase: 'awaiting_confirmation', startedAt: LINKED_AT, expectedDeviceId: 12, bootstrapPhase: null, devices: [PRIMARY, { deviceId: 12, keyIndex: 3 }] }).join('\n');
    assert.match(one, /companions\s+#12 key index 3$/m);
    assert.ok(!/#0\b/.test(one));
});

test('formatLinkStatus does not suggest the bootstrap before a companion has appeared', () => {
    const state = (phase, devices) => L.formatLinkStatus({ hasADV: true, confirmed: false, phase, startedAt: LINKED_AT, expectedDeviceId: 12, bootstrapPhase: null, devices }).join('\n');
    for (const phase of ['awaiting_confirmation', 'committed', 'uncertain']) {
        const text = state(phase, [PRIMARY]);
        assert.ok(!text.includes('/link-bootstrap'), phase + ': ' + text);
    }
    assert.match(state('awaiting_confirmation', [PRIMARY]), /companion has not appeared/);
    assert.match(state('awaiting_confirmation', [PRIMARY]), /\/link-retire/);
    // Once it has, the history is the next thing, and Web will wait on it.
    assert.match(state('awaiting_confirmation', [PRIMARY, { deviceId: 12, keyIndex: 3 }]), /\/link-bootstrap --resume/);
    assert.ok(!/has not appeared/.test(state('awaiting_confirmation', [PRIMARY, { deviceId: 12, keyIndex: 3 }])));
});

test('formatLinkedDevices does not show the primary as a companion', () => {
    const lines = L.formatLinkedDevices({ phone: '1', devices: [PRIMARY, { deviceId: 12, keyIndex: 3 }], journal: null });
    assert.equal(lines.filter(l => /#0\b/.test(l)).length, 1);
    assert.equal(lines.filter(l => l.includes('companion')).length, 1);
    assert.deepEqual(L.formatLinkedDevices({ phone: '1', devices: [PRIMARY], journal: null }), ['linked devices  +1', '  #0   this phone (primary)', '  no companion linked']);
});

test('a commit whose device has left the list is not reported as having no proof', () => {
    const gone = L.formatLinkStatus({ hasADV: true, confirmed: false, phase: 'committed', startedAt: LINKED_AT, expectedDeviceId: 12, bootstrapPhase: 'sent', devices: [PRIMARY] }).join('\n');
    assert.match(gone, /binding\s+unconfirmed/);
    assert.match(gone, /proof was reconciled/);
    assert.match(gone, /no longer listed/);
    assert.ok(!/no companion proof/i.test(gone));
    // Never reconciled is still said plainly.
    const never = L.formatLinkStatus({ hasADV: true, confirmed: false, phase: 'awaiting_confirmation', startedAt: LINKED_AT, expectedDeviceId: 12, bootstrapPhase: null, devices: [PRIMARY, { deviceId: 12, keyIndex: 3 }] }).join('\n');
    assert.match(never, /no companion proof has been reconciled/);
    // The device row for the same commit says the same, and never "confirmed".
    const row = L.formatLinkedDevices({ phone: '1', devices: [{ deviceId: 12, keyIndex: 3 }], journal: { phase: 'committed', confirmed: false, expectedDeviceId: 12, bootstrapPhase: 'sent' } })[2];
    assert.match(row, /binding unconfirmed/);
    assert.match(row, /proof was reconciled/);
    assert.ok(!/binding confirmed/.test(row));
});

test('a companion proof is something the person has, never something Web is said to show', () => {
    const text = corpus().join('\n');
    // (Web does show the pairing code; it is the proof that nothing here says it shows.)
    assert.ok(!/web shows (its |the |a )?proof|shows its proof|as the page gives it|page gives/i.test(text));
    assert.match(L.explainError('PRIMARY_LINK_WEB_PROOF_INVALID').next, /companion's public proof JSON/);
    assert.match(L.explainError('PRIMARY_LINK_WEB_PROOF_INVALID').next, /\/link-confirm FILE\|JSON/);
    assert.match(L.explainError('PRIMARY_LINK_RECONCILIATION_REQUIRED').next, /public proof JSON/);
    assert.match(L.explainBlocker({ code: 'PRIMARY_LINK_RECONCILIATION_REQUIRED', detail: { phase: 'uncertain', retirable: false } }).next, /public proof JSON/);
    const waiting = L.formatLinkStatus({ hasADV: true, confirmed: false, phase: 'awaiting_confirmation', startedAt: LINKED_AT, expectedDeviceId: 12, bootstrapPhase: null, devices: [PRIMARY, { deviceId: 12, keyIndex: 3 }] }).join('\n');
    assert.match(waiting, /if you have the companion's public proof JSON/);
});

// ─── no guessing at the retained range ──────────────────────────────────────

test('a retained range with a part missing says unknown, never nothing', () => {
    const row = retained => L.formatReadiness(READY({ history: { ...coverage(), retained } })).find(l => l.includes('retained range'));
    const t0 = sec(at(2026, 6, 1, 10, 0)), t1 = sec(at(2026, 11, 2, 14, 58));

    // How many were dropped is not said.
    const noCount = row({ from: t0, to: t1 });
    assert.match(noCount, /2026-06-01 10:00 to 2026-11-02 14:58/);
    assert.match(noCount, /dropped is unknown/);
    assert.ok(!/nothing older/.test(noCount));
    // The range is not said.
    const noRange = row({ evicted: 5 });
    assert.match(noRange, /range unknown/);
    assert.match(noRange, /5 older messages were dropped/);
    assert.ok(!/no messages kept/.test(noRange));
    // Half a range is not a range, and not an empty one.
    for (const half of [{ evicted: 0, from: t0 }, { evicted: 0, to: t1 }, { evicted: 0, from: null, to: t1 }, { evicted: 0, from: t0, to: null }]) {
        assert.match(row(half), /range unknown/, JSON.stringify(half));
        assert.ok(!/no messages kept/.test(row(half)));
    }
    assert.ok(!/nothing older/.test(row({ evicted: 'x', from: t0, to: t1 })));
    assert.match(row({ evicted: 'x', from: t0, to: t1 }), /dropped is unknown/);
    // Both null is the store saying it holds nothing.
    assert.match(row({ evicted: 0, from: null, to: null }), /no messages kept; nothing older was dropped/);
    assert.match(row({}), /unknown/);
});

// ─── expired pairing requests ───────────────────────────────────────────────

test('expired pairing requests are not grouped, offered or chosen', () => {
    const list = [inv('a', '1a2b3c4d', NOW - 1), inv('b', '1a2b3c4d', NOW), inv('c', '99887766', NOW + 1000)];
    // The first two ran out (at or before now); only the third is live.
    assert.deepEqual(grp(list).map(g => [g.companion, g.count]), [['99887766', 1]]);
    assert.deepEqual(pick(list), { id: id('c') });
    assert.deepEqual(pick(list, id('a').slice(0, 8)), { none: true });
    assert.deepEqual(pick(list, '2'), { none: true });
    assert.deepEqual(pick([inv('a', '1a2b3c4d', NOW - 1)]), { none: true });
    // An earlier clock brings them back: it is the clock that decides, and they count with their browser.
    assert.deepEqual(grp(list, NOW - 10).map(g => g.count).sort(), [1, 2]);
    assert.deepEqual(grp(list, NOW - 10).map(g => g.companion).sort(), ['1a2b3c4d', '99887766']);
    // The clock defaults to now.
    const live = { id: id('d'), expiresAt: Date.now() + 60000, companion: 'aaaaaaaa' }, dead = { id: id('e'), expiresAt: Date.now() - 1, companion: 'bbbbbbbb' };
    assert.deepEqual(L.groupInvitations([live, dead]).map(g => g.companion), ['aaaaaaaa']);
    assert.deepEqual(L.chooseInvitation([live, dead]), { id: id('d') });
    // A listing drops them too, and numbers what is left from 1.
    const groups = [{ companion: 'aaaaaaaa', newest: { id: id('a'), expiresAt: NOW - 1 }, count: 1 }, { companion: 'bbbbbbbb', newest: { id: id('b'), expiresAt: NOW + 60000 }, count: 1 }];
    const lines = L.formatInvitations(groups, NOW);
    assert.ok(!lines.join('\n').includes('aaaaaaaa'));
    assert.match(lines.find(l => /^\s*1\b/.test(l)), /bbbbbbbb/);
    assert.match(L.formatInvitations([groups[0]], NOW).join('\n'), /no pairing request/i);
});

test('runLinkCode with only expired requests says they expired', async () => {
    const client = fake({ invitations: [inv('a', '1a2b3c4d', NOW - 5)] });
    await assert.rejects(run(client), error => error.code === 'PRIMARY_LINK_INVITATION_EXPIRED');
    assert.ok(!client.names().includes('approveCompanionCode'));
    // A group that expired between the listing and the choice is not chosen: the clock is the caller's.
    const live = fake({ invitations: [inv('a', '1a2b3c4d', NOW + 5), inv('b', '99887766', NOW - 5)] });
    const result = await run(live);
    assert.equal(result.invitationId, id('a'));
});

test('the invitation listing recommends the id, which does not move, alongside the number', () => {
    const text = L.formatInvitations(grp([inv('a', '1a2b3c4d', NOW + 100000), inv('b', '99887766', NOW + 90000)]), NOW).join('\n');
    assert.match(text, /\/link-code CODE <id>/);
    assert.match(text, /\/link-code CODE <number>/);
    assert.match(text, /numbers? (shift|change)/i);
    assert.ok(text.includes(id('a').slice(0, 12)));
});

test('a takeover in progress is told differently before and after an unlock', () => {
    const busy = { holder: { pid: 77, host: 'box', at: null, legacy: false, mutex: true } };
    const first = L.explainError('PRIMARY_LINK_STORE_BUSY', busy);
    assert.match(first.next, /^Run \/link-unlock/);
    assert.ok(!/again/i.test(first.next), first.next);
    const after = L.explainError('PRIMARY_LINK_STORE_BUSY', busy, 'unlock');
    assert.match(after.next, /wait/i);
    assert.match(after.next, /\/link-unlock again/);
    assert.equal(after.title, first.title);
    // The same through describeError, which is what a front end calls.
    const error = Object.assign(new Error('PRIMARY_LINK_STORE_BUSY'), { code: 'PRIMARY_LINK_STORE_BUSY', ...busy });
    assert.ok(!L.describeError(error).join('\n').includes('/link-unlock again'));
    assert.ok(L.describeError(error, 'unlock').join('\n').includes('/link-unlock again'));
    // A holder that is not a takeover reads the same either way.
    const plain = { holder: { pid: 4242, host: 'box', at: null, legacy: false } };
    assert.deepEqual(L.explainError('PRIMARY_LINK_STORE_BUSY', plain, 'unlock'), L.explainError('PRIMARY_LINK_STORE_BUSY', plain));
});

test('formatInvitationNotice is one line in the plan layout', () => {
    const request = { id: 'abcdef123456' + '0'.repeat(52), expiresAt: NOW + 180000, companion: '1a2b3c4d' };
    assert.equal(L.formatInvitationNotice(request, NOW), '  link request   companion 1a2b3c4d   code window 3:00   id abcdef12');
    assert.equal(L.formatInvitationNotice({ ...request, companion: null }, NOW), '  link request   companion unknown   code window 3:00   id abcdef12');
    assert.equal(L.formatInvitationNotice({ ...request, companion: undefined }, NOW), '  link request   companion unknown   code window 3:00   id abcdef12');
    // The window runs down; once it has run out it says so rather than counting below zero.
    assert.match(L.formatInvitationNotice({ ...request, expiresAt: NOW + 125000 }, NOW), /code window 2:05/);
    assert.match(L.formatInvitationNotice({ ...request, expiresAt: NOW + 5000 }, NOW), /code window 0:05/);
    assert.match(L.formatInvitationNotice({ ...request, expiresAt: NOW - 1 }, NOW), /code window expired/);
    // The event as the client emits it, on arrival, now being now.
    assert.match(L.formatInvitationNotice({ id: id('f'), expiresAt: Date.now() + 180000, companion: 'cafebabe' }), /code window 3:00/);
    assert.doesNotThrow(() => L.formatInvitationNotice(undefined));
    assert.ok(!L.formatInvitationNotice(request, NOW).includes('\n'));
});

// ─── the public surface ─────────────────────────────────────────────────────

test('the link logic is reachable from the package, and nothing in it needs a socket', () => {
    assert.equal(wa.Cli.LinkCommands, L);
    for (const name of ['groupInvitations', 'chooseInvitation', 'formatInvitationNotice', 'explainError', 'formatReadiness', 'formatLinkedDevices', 'formatLinkStatus', 'runLinkCode', 'runLinkQr']) {
        assert.equal(typeof L[name], 'function', name);
    }
    // Pure formatting never reaches for the network, the disk, or the clock it was not given.
    const src = fs.readFileSync(path.join(LIB, 'cli', 'linkCommands.js'), 'utf8');
    assert.ok(!/require\(['"](?:node:)?(?:fs|net|tls|http|https|child_process)['"]\)/.test(src));
    assert.ok(!/\btoSorted\b|\bObject\.groupBy\b|\bPromise\.withResolvers\b/.test(src), 'Node 18 is the floor');
});
