'use strict';
// Whether this primary can finish a link, found out before the link is
// approved. Approving one it cannot finish is the failure this exists to
// prevent: the primary approves, the bootstrap then refuses, and Web hangs on
// "Loading chats" until it logs out.
//
// Two halves.
//   evaluateReadiness(facts)  pure: facts in, verdict out.
//   gatherFacts(client)       reads what the verdict needs. It sends two
//                             read-only IQs (the device list, and critical_block
//                             with no patch), reads the local key, app-state and
//                             history files, and takes the store's snapshot (which
//                             sweeps expired disappearing messages out of the
//                             store, as the bootstrap's own snapshot does). On
//                             first use it may create the link journal and its
//                             lock, as any primary-link call does. It never
//                             approves, never sends a message or a patch, never
//                             makes a key and never updates link state.
//
// The checks mirror lib/PrimaryBootstrap.js and lib/PrimaryLinking.js, so a
// verdict of ready is a link the bootstrap does not then refuse for anything
// that could have been seen here. Where a check is copied rather than called,
// test/primary-link-readiness.test.js holds the copy to the original.
const fs = require('node:fs');
const path = require('node:path');

const CODES = Object.freeze({
    ACCOUNT: 'PRIMARY_LINK_ACCOUNT_REQUIRED',
    RECONCILE: 'PRIMARY_LINK_RECONCILIATION_REQUIRED',
    COMPANIONS: 'PRIMARY_BOOTSTRAP_EXISTING_COMPANIONS_UNSUPPORTED',
    FOREIGN: 'PRIMARY_BOOTSTRAP_FOREIGN_STATE',
    NAME: 'PRIMARY_BOOTSTRAP_NAME_REQUIRED',
    STORE: 'PRIMARY_MESSAGE_STORE_DISABLED'
});
// PrimaryLinking approve() refuses to start over a transaction in one of these.
const HELD = new Set(['verification_required', 'finish_verified', 'pair_device_sending', 'awaiting_confirmation', 'uncertain']);
// PrimaryLinking retireAbsent() retires a hold in one of these, once it is
// this old, and no other.
const RETIRABLE = new Set(['awaiting_confirmation', 'uncertain', 'pair_device_sending']);
const RETIRE_AFTER_MS = 300000;
// PrimaryBootstrap: the push name the critical_block patch is written with.
const NAME_MAX = 25;

const isCount = value => Number.isFinite(value) && value >= 0;
const object = value => (value && typeof value === 'object' ? value : null);
const blocker = (code, detail) => ({ code, detail });

function validPushName(name) {
    return typeof name === 'string' && !!name.trim() && name !== 'User' && name.length <= NAME_MAX;
}

// The oldest and newest timestamp (seconds) among the records a store holds,
// tombstones included; null when there are none. Reads timestamps and nothing
// else, and takes them one at a time: a store may hold tens of thousands.
function rangeOf(records) {
    let from = null, to = null;
    if (object(records)) {
        for (const list of Object.values(records)) {
            if (!Array.isArray(list)) continue;
            for (const record of list) {
                const ts = record && record.ts;
                if (!isCount(ts)) continue;
                if (from === null || ts < from) from = ts;
                if (to === null || ts > to) to = ts;
            }
        }
    }
    return { from, to };
}

// The loss list as the store reports it: a reason, with the ids of the
// messages seen and not kept or the window nothing was kept for. Message ids
// are protocol identifiers, not content. Only those fields are copied.
function copyLoss(loss) {
    const entry = object(loss) || {};
    const copy = { reason: typeof entry.reason === 'string' ? entry.reason : null };
    if (Array.isArray(entry.ids)) copy.ids = entry.ids.filter(id => typeof id === 'string');
    if (isCount(entry.from)) copy.from = entry.from;
    if (isCount(entry.to)) copy.to = entry.to;
    return copy;
}

// What would be sent and how it falls short (spec 6.4), without any of the
// store's content: counts, the range of timestamps it holds, what it let go
// of and what it knows it missed. A snapshot with its records yields the range
// from them; one without (the gatherer drops the records) carries the range it
// already worked out in retained.from / retained.to.
function describeHistory(snapshot) {
    const capture = object(snapshot.capture) || {}, counts = object(snapshot.counts) || {}, kept = object(snapshot.retained) || {};
    const range = object(snapshot.records) ? rangeOf(snapshot.records) : { from: isCount(kept.from) ? kept.from : null, to: isCount(kept.to) ? kept.to : null };
    return {
        enabled: true,
        capture: {
            since: isCount(capture.since) ? capture.since : null,
            origin: typeof capture.origin === 'string' ? capture.origin : null,
            lc: isCount(capture.lc) ? capture.lc : null
        },
        chats: isCount(counts.chats) ? counts.chats : null,
        records: isCount(counts.records) ? counts.records : null,
        retained: { evicted: isCount(kept.evicted) ? kept.evicted : null, from: range.from, to: range.to },
        losses: (Array.isArray(snapshot.losses) ? snapshot.losses : []).map(copyLoss)
    };
}

function verdict(blockers, mode, history, needsConfirmation) {
    return { ready: blockers.length === 0, mode, blockers, history, needsConfirmation };
}

// facts = { registered, phoneOk, transaction: { phase, startedAt } | null,
//           devices: [{ id }], localKeys: { count, foreign },
//           server: { version, verified, foreign }, pushNameValid, storeEnabled,
//           snapshot, now,
//           local: { appStateConflict, historyFiles }, storeError? }
// A fact that is missing is not a fact that is fine: nothing here is ready
// unless the facts say it is. (A transaction of null is the fact that there is
// none; the gatherer always says it. The rest have no such default.)
function evaluateReadiness(facts) {
    const f = object(facts) || {};
    if (!f.registered || !f.phoneOk) {
        // Nothing else can be read from an account there is no session for.
        return verdict([blocker(CODES.ACCOUNT, { registered: !!f.registered, phoneOk: !!f.phoneOk })], null, null, false);
    }
    const blockers = [];

    // approve() refuses to start over a hold, so a link started now would not
    // get as far as the bootstrap.
    const tx = object(f.transaction);
    if (tx && HELD.has(tx.phase)) {
        const age = Number.isSafeInteger(tx.startedAt) && Number.isFinite(f.now) ? f.now - tx.startedAt : null;
        blockers.push(blocker(CODES.RECONCILE, {
            phase: tx.phase,
            startedAt: Number.isSafeInteger(tx.startedAt) ? tx.startedAt : null,
            ageMs: age,
            retirable: RETIRABLE.has(tx.phase) && age !== null && age >= RETIRE_AFTER_MS
        }));
    }

    // The bootstrap only supports an account whose one device is this one.
    const devices = Array.isArray(f.devices) ? f.devices : null;
    if (!devices || devices.length !== 1 || !devices[0] || devices[0].id !== 0)
        blockers.push(blocker(CODES.COMPANIONS, { companions: devices ? devices.filter(d => d && d.id !== 0).length : null }));

    // Mode is read the way classify() reads it: our own verified critical_block
    // at a version above 0 is a re-link, an empty one that matches an empty
    // local state is a first link, and nothing else is bootstrapped over.
    const keys = object(f.localKeys), server = object(f.server), local = object(f.local) || {};
    const reasons = [];
    if (!keys || keys.foreign) reasons.push('local_keys');
    else if (!server) { if (!local.appStateConflict) reasons.push('server_unknown'); }
    else if (server.foreign) reasons.push('server_foreign');
    else if (server.verified !== true || !Number.isSafeInteger(server.version) || server.version < 0) reasons.push('server_unverified');
    // The bootstrap refuses a first link over existing app state or history
    // (EXISTING_STATE, EXISTING_HISTORY), so both must be known to be absent:
    // a fact that is missing, or is not a yes or a no, rules neither out.
    if (local.appStateConflict === true) reasons.push('local_state');
    if (local.historyFiles === true) reasons.push('local_history');
    if (typeof local.appStateConflict !== 'boolean' || typeof local.historyFiles !== 'boolean') reasons.push('local_unknown');
    let mode = null;
    if (reasons.length) blockers.push(blocker(CODES.FOREIGN, { reasons, serverVersion: server && Number.isSafeInteger(server.version) ? server.version : null }));
    else mode = server.version > 0 ? 'relink' : 'first';

    if (!f.pushNameValid) blockers.push(blocker(CODES.NAME, { maxLength: NAME_MAX }));

    // The history that would be sent, and whether it is known to be complete.
    // Only a store that has captured since the account was registered can
    // claim that, and only with nothing it saw and could not keep and nothing
    // it let go of. Anything else (a store switched on later, one of an origin
    // not known here, a snapshot that does not say) asks. With no store there
    // is no history to confirm, and the blocker below stops the link.
    const snapshot = object(f.snapshot);
    let history = null, needsConfirmation = false;
    if (f.storeEnabled && snapshot) {
        history = describeHistory(snapshot);
        needsConfirmation = history.capture.origin !== 'registration' || !Array.isArray(snapshot.losses) || snapshot.losses.length > 0
            || history.retained.evicted === null || history.retained.evicted > 0;
    } else {
        blockers.push(blocker(CODES.STORE, f.storeEnabled && f.storeError ? { reason: 'unreadable', code: String(f.storeError) } : { reason: f.storeEnabled ? 'unreadable' : 'disabled' }));
    }
    return verdict(blockers, mode, history, needsConfirmation);
}

// ─── gathering ───────────────────────────────────────────────────────────────

function sessionFile(client, suffix) { return path.join(client._sessionDir, client._store.phoneNumber + suffix); }

// The key file as PrimaryBootstrap loadKeys() accepts it: a private regular
// file of at most 15 keys, every one made by this primary's own bootstrap under
// the ADV raw id the next link will use. Read-only; loadKeys is not exported.
// With no ADV state to continue the next link gets a raw id of its own, which
// no key on disk can have been made under.
function readKeys(client, rawId) {
    const file = sessionFile(client, '.appStateKeys.json');
    let info;
    try { info = fs.lstatSync(file); } catch (error) { return { count: 0, foreign: !(error && error.code === 'ENOENT') }; }
    const foreign = count => ({ count, foreign: true });
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 || info.size >= 65536) return foreign(0);
    let keys;
    try { keys = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return foreign(0); }
    if (!object(keys) || Array.isArray(keys)) return foreign(0);
    const entries = Object.entries(keys);
    const ours = entries.length > 0 && entries.length < 16 && rawId !== undefined && entries.every(([id, k]) => /^[a-f0-9]{12}$/.test(id) && object(k)
        && k.source === 'primary_bootstrap' && object(k.fingerprint)?.rawId === rawId && typeof k.keyData === 'string' && Buffer.from(k.keyData, 'base64').length === 32);
    return { count: entries.length, foreign: !ours };
}

// What classify() refuses to write over. A local critical_block past version 0
// is a re-link candidate and is judged against the server instead; a first
// link needs every local collection empty and no app-state file. Either way,
// an existing history file is refused.
function readLocal(client) {
    let appStateConflict = true;
    const state = client._appState;
    if (state) {
        appStateConflict = !(state.get('critical_block').version > 0)
            && (!Object.values(state.versions()).every(v => v === 0) || fs.existsSync(sessionFile(client, '.appState.json')));
    }
    return { appStateConflict, historyFiles: ['.history.json', '.messages.json'].some(suffix => fs.existsSync(sessionFile(client, suffix))) };
}

// critical_block on the server against the state we hold, as the bootstrap
// reads it (verifyServerCriticalBlock). A key file the bootstrap cannot use is
// reported by it as foreign, or raised as PRIMARY_BOOTSTRAP_EXISTING_KEYS or
// _FOREIGN_STATE; either way the server is not a state we can bootstrap over,
// and either way it is a blocker, never a crash. Any other failure (the server
// not answering, a timeout, an abort) means nothing was learned, and is thrown.
async function serverFacts(linking, operation) {
    let seen;
    try {
        seen = await require('../PrimaryBootstrap').verifyServerCriticalBlock(linking, operation);
    } catch (error) {
        if (!error || (error.code !== 'PRIMARY_BOOTSTRAP_EXISTING_KEYS' && error.code !== 'PRIMARY_BOOTSTRAP_FOREIGN_STATE')) throw error;
        return { version: null, verified: false, foreign: true };
    }
    const found = object(seen);
    if (!found) return null;
    return { version: found.version, verified: found.verified === true && !found.foreign, foreign: !!found.foreign };
}

// Everything evaluateReadiness needs from a client. Throws when it cannot look
// at all (not a primary, not connected, another link operation running, the
// server not answering); a refusal worth a blocker is returned, not thrown.
async function gatherFacts(client, options = {}) {
    const C = require('../PrimaryLinkCrypto');
    C.requireValue(client._mode === 'mobile', 'PRIMARY_LINK_PRIMARY_REQUIRED');
    const store = client._store;
    const facts = { registered: !!(store && store.registered), phoneOk: !!store && /^\d{8,15}$/.test(String(store.phoneNumber)),
        transaction: null, devices: null, localKeys: null, local: null, server: null,
        pushNameValid: false, storeEnabled: false, snapshot: null, now: Date.now() };
    // The journal and the lock are named by the phone number, so there is nothing to open.
    if (!facts.registered || !facts.phoneOk) return facts;

    const linking = client._primaryLinkingForSession();
    const operation = linking.begin({ timeoutMs: options.timeoutMs, signal: options.signal });
    try {
        const saved = linking.journal.snapshot(), tx = saved.transaction;
        facts.transaction = tx ? { phase: tx.phase, startedAt: tx.startedAt === undefined ? null : tx.startedAt } : null;
        facts.devices = (await linking.queryOwn(operation)).devices;

        facts.localKeys = readKeys(client, (saved.adv || saved.reservationFloor || {}).rawId);
        facts.local = readLocal(client);
        if (!facts.localKeys.foreign && client._appState) {
            facts.server = await serverFacts(linking, operation);
        }

        facts.pushNameValid = validPushName(store.name);
        facts.storeEnabled = !!client._messageStore;
        if (facts.storeEnabled) {
            try {
                // Only the coverage is kept; none of the messages leave this
                // function. The range is read off the records here, so the
                // facts hold timestamps and no records.
                const { capture, losses, retained, counts, records } = client.getPrimaryMessageStore();
                facts.snapshot = { capture, losses, retained: { evicted: object(retained)?.evicted, ...rangeOf(records) }, counts };
            } catch (error) {
                facts.storeError = error && typeof error.code === 'string' && error.code.startsWith('PRIMARY_MESSAGE_STORE_') ? error.code : 'PRIMARY_MESSAGE_STORE_FAILED';
            }
        }
    } finally { linking.end(operation); }
    facts.now = Date.now();
    return facts;
}

module.exports = { evaluateReadiness, gatherFacts, validPushName };
