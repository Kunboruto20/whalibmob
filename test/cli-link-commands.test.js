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

const id = ch => ch.repeat(64);                           // an invitation id is a 64-hex sha256
const inv = (ch, companion, expiresAt) => ({ id: id(ch), expiresAt, companion });

// ─── grouping and choosing ──────────────────────────────────────────────────

test('same-companion duplicates collapse to the newest', () => {
    // Web sends the same request about 200 ms apart from one browser.
    const groups = L.groupInvitations([
        inv('a', '1a2b3c4d', NOW + 100),
        inv('b', '1a2b3c4d', NOW + 300),
        inv('c', '1a2b3c4d', NOW + 200)
    ]);
    assert.deepEqual(groups, [{ companion: '1a2b3c4d', newest: { id: id('b'), expiresAt: NOW + 300 }, count: 3 }]);

    // A tie goes to the later arrival, which is the later entry in the journal.
    const tie = L.groupInvitations([inv('a', '1a2b3c4d', NOW), inv('b', '1a2b3c4d', NOW)]);
    assert.equal(tie[0].newest.id, id('b'));

    // Only a unique choice is made on its own.
    assert.deepEqual(L.chooseInvitation([inv('a', '1a2b3c4d', NOW + 1), inv('b', '1a2b3c4d', NOW + 2)]), { id: id('b') });
});

test('two companions require an explicit choice', () => {
    const list = [inv('a', '1a2b3c4d', NOW + 100), inv('b', '99887766', NOW + 200), inv('c', '1a2b3c4d', NOW + 300)];
    const groups = L.groupInvitations(list);
    // Newest first: the browser that asked last is listed first.
    assert.deepEqual(groups.map(g => [g.companion, g.count, g.newest.id]), [['1a2b3c4d', 2, id('c')], ['99887766', 1, id('b')]]);
    const choice = L.chooseInvitation(list);
    assert.deepEqual(Object.keys(choice), ['ambiguous']);
    assert.deepEqual(choice.ambiguous, groups);
});

test('invitations with no fingerprint are never grouped with each other', () => {
    // A 32-bit label is not proof, and an entry without one is not a duplicate of anything.
    const groups = L.groupInvitations([inv('a', null, NOW + 1), inv('b', null, NOW + 2)]);
    assert.equal(groups.length, 2);
    assert.deepEqual(groups.map(g => [g.companion, g.count]), [[null, 1], [null, 1]]);
    assert.ok('ambiguous' in L.chooseInvitation([inv('a', null, NOW + 1), inv('b', null, NOW + 2)]));

    // Not with a fingerprinted one either.
    assert.ok('ambiguous' in L.chooseInvitation([inv('a', null, NOW + 1), inv('b', '1a2b3c4d', NOW + 2)]));

    // A lone one is a lone choice.
    assert.deepEqual(L.chooseInvitation([inv('a', null, NOW + 1)]), { id: id('a') });
});

test('no invitation is none, and so is a selector that matches nothing', () => {
    assert.deepEqual(L.chooseInvitation([]), { none: true });
    assert.deepEqual(L.chooseInvitation([], '1'), { none: true });
    assert.deepEqual(L.chooseInvitation(undefined), { none: true });
    const list = [inv('a', '1a2b3c4d', NOW + 1), inv('b', '99887766', NOW + 2)];
    assert.deepEqual(L.chooseInvitation(list, '3'), { none: true });
    assert.deepEqual(L.chooseInvitation(list, '0'), { none: true });
    assert.deepEqual(L.chooseInvitation(list, 'zzzzzz'), { none: true });
    assert.deepEqual(L.chooseInvitation(list, 'ab12'), { none: true });     // too short to be a prefix, not a number
    assert.deepEqual(L.chooseInvitation(list, 'cccccc'), { none: true });   // a prefix nothing has
});

test('numeric and prefix selectors pick the right invitation', () => {
    const list = [inv('a', '1a2b3c4d', NOW + 100), inv('b', '99887766', NOW + 200), inv('a', '1a2b3c4d', NOW + 50)];
    // The first two are two browsers; the third repeats the first. List order after grouping: b, then a (newest of its two).
    const [first, second] = L.groupInvitations(list);
    assert.equal(first.newest.id, id('b'));

    assert.deepEqual(L.chooseInvitation(list, '1'), { id: first.newest.id });
    assert.deepEqual(L.chooseInvitation(list, '2'), { id: second.newest.id });
    assert.deepEqual(L.chooseInvitation(list, 2), { id: second.newest.id });   // a number is accepted as a number too

    // An id prefix of six or more hex characters names that invitation, not its group's newest.
    const two = [inv('a', '1a2b3c4d', NOW + 100), inv('b', '1a2b3c4d', NOW + 200)];
    assert.deepEqual(L.chooseInvitation(two, 'aaaaaa'), { id: id('a') });
    assert.deepEqual(L.chooseInvitation(two, id('a').slice(0, 20).toUpperCase()), { id: id('a') });
    assert.deepEqual(L.chooseInvitation(two, id('b')), { id: id('b') });

    // Six digits is a prefix, not group 123456.
    const digits = [{ id: '123456' + 'a'.repeat(58), expiresAt: NOW, companion: 'aaaaaaaa' }, inv('b', 'bbbbbbbb', NOW + 1)];
    assert.deepEqual(L.chooseInvitation(digits, '123456'), { id: digits[0].id });

    // A prefix two invitations share is not a choice.
    const shared = [{ id: 'abcdef' + '1'.repeat(58), expiresAt: NOW, companion: 'aaaaaaaa' }, { id: 'abcdef' + '2'.repeat(58), expiresAt: NOW + 1, companion: 'bbbbbbbb' }];
    assert.ok('ambiguous' in L.chooseInvitation(shared, 'abcdef'));
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
    assert.match(L.explainError('PRIMARY_LINK_RECONCILIATION_REQUIRED').next, /\/link-reconcile/);
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
    assert.match(mutex.next, /wait/i);
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
    assert.match(young.next, /\/link-reconcile/);
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
        confirm: async (...args) => { log('confirm'); return over.confirm === undefined ? true : over.confirm; },
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
    assert.deepEqual(client.names(), ['getPrimaryLinkReadiness', 'confirm']);
    const text = client.printed.join('\n');
    assert.match(text, /capture period/);
    assert.match(text, /retained range/);
    assert.match(text, /known or possible losses/);

    // Not asked, and not assumed: a caller with no way to ask is a no.
    const mute = fake({ readiness: PARTIAL({ origin: 'enabled' }) });
    assert.deepEqual(await L.runLinkCode({ client: mute, code: 'ABCD1234', print: mute.print }), { status: 'aborted' });
    assert.deepEqual(mute.names(), ['getPrimaryLinkReadiness']);
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
    assert.deepEqual(client.names(), ['getPrimaryLinkReadiness', 'confirm', 'getPrimaryLinkInvitations', 'approveCompanionCode', 'bootstrapPrimaryCompanion']);
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
        history: { chats: 12, records: 340 },
        now: NOW
    });
    assert.deepEqual(lines, [
        'linked devices  +447949738354',
        '  #0   this phone (primary)',
        '  #12  companion   key index 3   linked 2026-11-02 15:31 by code   binding unconfirmed   history delivered (12 chats, 340 msgs)'
    ]);
});

test('formatLinkedDevices claims a confirmed binding only for a reconciled proof', () => {
    const base = { phone: '+447949738354', devices: [{ deviceId: 12, keyIndex: 3 }], history: { chats: 1, records: 2 }, now: NOW };
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
    const base = { phone: '1', now: NOW, history: { chats: 1, records: 1 } };

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
    const base = { phone: '1', devices: [{ deviceId: 12, keyIndex: 3 }], now: NOW };
    const row = (bootstrapPhase, extra = {}, history) => L.formatLinkedDevices({ ...base, history, journal: { phase: 'awaiting_confirmation', startedAt: LINKED_AT, method: 'code', bootstrapPhase, ...extra } })[2];

    assert.match(row('sent', {}, { chats: 1, records: 1 }), /history delivered \(1 chat, 1 msg\)/);
    assert.match(row('sent'), /history delivered$/);                                         // sent, but nobody told it the numbers
    assert.match(row(null), /history not sent/);
    assert.match(row('key_share_sending', { bootstrap: { phase: 'key_share_sending', errorCode: 'PRIMARY_BOOTSTRAP_ACK_UNCERTAIN' } }), /history stopped at key_share_sending/);
    assert.ok(!/delivered/.test(row('history_sending', {}, { chats: 9, records: 9 })), 'numbers are shown only for a delivery');

    // No companions at all.
    assert.deepEqual(L.formatLinkedDevices({ phone: '447949738354', devices: [], journal: null, now: NOW }), [
        'linked devices  +447949738354',
        '  #0   this phone (primary)',
        '  no companion linked'
    ]);
    // Not a phone number it was given, not a crash.
    assert.doesNotThrow(() => L.formatLinkedDevices({}));
});

// ─── /link-status ───────────────────────────────────────────────────────────

test('formatLinkStatus names the binding, the bootstrap and the companions', () => {
    const idle = L.formatLinkStatus({ hasADV: false, confirmed: false, phase: 'idle', startedAt: null, expectedDeviceId: null, bootstrapPhase: null, devices: [] }).join('\n');
    assert.match(idle, /link\s+idle/i);
    assert.match(idle, /binding\s+unconfirmed/i);
    assert.match(idle, /bootstrap\s+not started/i);
    assert.match(idle, /companions\s+none/i);

    const sent = L.formatLinkStatus({
        hasADV: true, confirmed: true, phase: 'committed', startedAt: LINKED_AT, expectedDeviceId: 12, bootstrapPhase: 'sent',
        bootstrap: { phase: 'sent', errorCode: null, iq: null }, devices: [{ deviceId: 12, keyIndex: 3 }]
    }).join('\n');
    assert.match(sent, /binding\s+confirmed/i);
    assert.match(sent, /bootstrap\s+sent/i);
    assert.match(sent, /#12/);
    assert.match(sent, /key index 3/);

    // Awaiting the browser's proof: the binding is not confirmed, and the way forward is given.
    const waiting = L.formatLinkStatus({ hasADV: true, confirmed: false, phase: 'awaiting_confirmation', startedAt: LINKED_AT, expectedDeviceId: 12, bootstrapPhase: null, devices: [{ deviceId: 12, keyIndex: 3 }] }).join('\n');
    assert.match(waiting, /binding\s+unconfirmed/i);
    assert.ok(!/binding\s+confirmed/i.test(waiting));
    assert.match(waiting, /\/link-reconcile/);

    // A bootstrap that stopped says why and what to do.
    const stopped = L.formatLinkStatus({
        hasADV: true, confirmed: false, phase: 'awaiting_confirmation', startedAt: LINKED_AT, expectedDeviceId: 12, bootstrapPhase: 'history_sending',
        bootstrap: { phase: 'history_sending', errorCode: 'PRIMARY_BOOTSTRAP_HISTORY_UNCERTAIN', iq: null }, devices: [{ deviceId: 12, keyIndex: 3 }]
    }).join('\n');
    assert.match(stopped, /history_sending/);
    assert.match(stopped, new RegExp(L.explainError('PRIMARY_BOOTSTRAP_HISTORY_UNCERTAIN').next.slice(0, 30).replace(/[/.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotThrow(() => L.formatLinkStatus(undefined));
});

// ─── invitations listing ────────────────────────────────────────────────────

test('formatInvitations numbers the browsers, newest first, with how long each has left', () => {
    const groups = L.groupInvitations([inv('a', '1a2b3c4d', NOW + 100000), inv('b', '1a2b3c4d', NOW + 120000), inv('c', null, NOW + 30000)]);
    const lines = L.formatInvitations(groups, NOW);
    const text = lines.join('\n');
    assert.match(lines.find(l => /^\s*1\b/.test(l)), /1a2b3c4d.*2 requests.*2m 00s/);
    assert.match(lines.find(l => /^\s*2\b/.test(l)), /unidentified.*1 request\b.*30s/);
    assert.match(text, /\/link-code/);
    assert.ok(text.includes(id('b').slice(0, 12)), 'the newest request is named by a prefix the person can paste');
    assert.deepEqual(L.formatInvitations([], NOW).join('\n').match(/no pairing request/i)?.length, 1);
    // Already gone.
    assert.match(L.formatInvitations(L.groupInvitations([inv('a', 'aaaaaaaa', NOW - 1)]), NOW).join('\n'), /expired/);
});

// ─── the public surface ─────────────────────────────────────────────────────

test('the link logic is reachable from the package, and nothing in it needs a socket', () => {
    assert.equal(wa.Cli.LinkCommands, L);
    for (const name of ['groupInvitations', 'chooseInvitation', 'explainError', 'formatReadiness', 'formatLinkedDevices', 'formatLinkStatus', 'runLinkCode', 'runLinkQr']) {
        assert.equal(typeof L[name], 'function', name);
    }
    // Pure formatting never reaches for the network, the disk, or the clock it was not given.
    const src = fs.readFileSync(path.join(LIB, 'cli', 'linkCommands.js'), 'utf8');
    assert.ok(!/require\(['"](?:node:)?(?:fs|net|tls|http|https|child_process)['"]\)/.test(src));
    assert.ok(!/\btoSorted\b|\bObject\.groupBy\b|\bPromise\.withResolvers\b/.test(src), 'Node 18 is the floor');
});
