'use strict';

const { Boom } = require('@hapi/boom');

// The logic behind the CLI's link commands, with no terminal in it.
//
// A primary approves a separate companion (WhatsApp Web) and then hands it the
// chats it has kept. That is a sequence of calls on a client, a choice between
// pairing requests, and a great many ways to fail, each of which a person has
// to be told about in words. This module is all of that, so it can be tested
// against a client that only records what it was asked to do. cli.js (and any
// other front end) prints what comes back and does nothing clever.
//
// All human text lives here. The error codes the library throws are stable and
// are never changed: explainError() maps one to a title and a next step.
//
// Pure formatting, no I/O: the clock is passed in, nothing is read or written,
// and nothing here touches a socket. A client is only ever used through the
// methods named in the runLink* functions.

// The commands the messages send a person to: the set of the link spec
// (6.9), plus the CLI's own /connect, /disconnect, /reconnect, /reg and /name.
// Kept in one place so that the text and the commands the CLI actually offers
// cannot drift apart; a test holds every message to this set.
const COMMANDS = Object.freeze({
    code: '/link-code',
    qr: '/link-qr',
    invitations: '/link-invitations',
    status: '/link-status',
    // Confirming a link needs the companion's public proof, as a file or as the JSON itself.
    reconcile: '/link-confirm FILE|JSON',
    retire: '/link-retire',
    unlock: '/link-unlock',
    // A bare /link-bootstrap after an attempt is refused as already attempted; --resume is
    // harmless when nothing was recorded, so every message names it.
    bootstrap: '/link-bootstrap --resume',
    // resendUncertain counts only on a resume.
    resend: '/link-bootstrap --resume --resend-uncertain',
    devices: '/linked-devices',
    connect: '/connect',
    disconnect: '/disconnect',
    reconnect: '/reconnect',
    register: '/reg',
    name: '/name'
});
const K = COMMANDS;

// A pairing request lasts three minutes (PrimaryLinking TTL).
const REQUEST_MINUTES = 3;
// retireAbsent() will not retire an approval younger than this.
const RETIRE_MINUTES = 5;

// ─── small formatting helpers ───────────────────────────────────────────────

const isNum = value => typeof value === 'number' && Number.isFinite(value);
const object = value => (value && typeof value === 'object' ? value : null);
const pad2 = n => String(n).padStart(2, '0');
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many || one + 's');

// Local time, to the minute: 2026-11-02 15:31. A person reads this against the
// clock on their own wall.
function stamp(ms) {
    if (!isNum(ms)) return null;
    const d = new Date(ms);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function span(ms) {
    if (!isNum(ms) || ms <= 0) return 'expired';
    const seconds = Math.ceil(ms / 1000), minutes = Math.floor(seconds / 60);
    return minutes ? minutes + 'm ' + pad2(seconds % 60) + 's' : seconds + 's';
}

function size(bytes) {
    if (!isNum(bytes)) return null;
    if (bytes < 1024) return plural(bytes, 'byte');
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
}

const clock = now => (typeof now === 'function' ? now() : isNum(now) ? now : Date.now());

function coded(code, message) {
    const error = new Boom(message || code);
    error.code = code;
    return error;
}

// ─── pairing requests ───────────────────────────────────────────────────────

const validInvitation = i => !!i && typeof i.id === 'string' && i.id.length > 0;
const validList = list => Array.isArray(list) && list.some(validInvitation);
// A request is live until its expiry. One with no usable expiry cannot be shown
// to have lapsed, so it is left for the library to judge.
const live = (item, at) => validInvitation(item) && (!isNum(item.expiresAt) || item.expiresAt > at);

// Web sends the same request more than once from one browser, about 200 ms
// apart, and every tab adds its own. They share a fingerprint of the browser's
// noise key (`companion`), so they are grouped on it and each group is shown as
// one browser, with its newest request. The fingerprint is a 32-bit label, not
// proof of anything. An entry with no fingerprint (an old journal) is never
// grouped with another: nothing says they belong together. A request that has
// expired by `now` (default: the present) is not counted.
function groupInvitations(invitations, now) {
    const at = clock(now), groups = [], byCompanion = new Map();
    for (const item of Array.isArray(invitations) ? invitations : []) {
        if (!live(item, at)) continue;
        const companion = typeof item.companion === 'string' && item.companion ? item.companion : null;
        const expiresAt = isNum(item.expiresAt) ? item.expiresAt : 0;
        let group = companion === null ? undefined : byCompanion.get(companion);
        if (!group) {
            group = { companion, newest: { id: item.id, expiresAt }, count: 0 };
            groups.push(group);
            if (companion !== null) byCompanion.set(companion, group);
        } else if (expiresAt >= group.newest.expiresAt) {
            // A tie goes to the later entry: the journal keeps them in arrival order.
            group.newest = { id: item.id, expiresAt };
        }
        group.count++;
    }
    // Array.prototype.sort is stable, so equal groups keep their arrival order.
    return groups.sort((a, b) => b.newest.expiresAt - a.newest.expiresAt);
}

const GROUP_NUMBER = /^[1-9]\d{0,4}$/;      // 1 to 5 digits
const ID_PREFIX = /^[0-9a-f]{6,64}$/i;      // at least 6 hex characters

// selector: nothing, a group number ('1'..'n'), or an id prefix (6 or more hex
// characters). Returns { id } for one request, { ambiguous: groups } when it
// would be a guess, and { none: true } when there is nothing to pick. It never
// picks between browsers on its own. Requests that have expired by `now`
// (default: the present) are not offered.
function chooseInvitation(invitations, selector, now) {
    const at = clock(now);
    const list = (Array.isArray(invitations) ? invitations : []).filter(item => live(item, at));
    const groups = groupInvitations(list, at);
    if (!groups.length) return { none: true };
    const want = selector === undefined || selector === null ? '' : String(selector).trim();
    if (!want) return groups.length === 1 ? { id: groups[0].newest.id } : { ambiguous: groups };

    // Up to five digits is a group number; six or more characters of hex is an id.
    if (want.length < 6 && GROUP_NUMBER.test(want)) {
        const group = groups[Number(want) - 1];
        return group ? { id: group.newest.id } : { none: true };
    }
    if (ID_PREFIX.test(want)) {
        const lower = want.toLowerCase();
        const matches = list.filter(i => i.id.toLowerCase().startsWith(lower));
        if (matches.length === 1) return { id: matches[0].id };
        return matches.length ? { ambiguous: groups } : { none: true };
    }
    return { none: true };
}

// The groups still live at `now`, numbered from 1 as chooseInvitation numbers them.
function formatInvitations(groups, now) {
    const at = clock(now);
    const list = (Array.isArray(groups) ? groups : []).filter(g => g && g.newest && !(isNum(g.newest.expiresAt) && g.newest.expiresAt <= at));
    if (!list.length) {
        return ['no pairing request is waiting.',
            '  On WhatsApp Web choose "Link with phone number", enter this number, then run ' + K.invitations + ' again.'];
    }
    const lines = ['pairing requests waiting, newest first:'];
    list.forEach((group, index) => {
        lines.push('  ' + (index + 1) + '  browser ' + (group.companion || 'unidentified')
            + '   ' + plural(group.count, 'request')
            + '   newest id ' + String(group.newest.id).slice(0, 12)
            + '   expires in ' + span(group.newest.expiresAt - at));
    });
    lines.push('  Requests with the same browser label come from one browser (Web sends each more than once).',
        '  The label is a short fingerprint, not proof of who is behind it.',
        '  Choose one by its id (it does not move; 6 or more characters):  ' + K.code + ' CODE <id>',
        '  or by its number (numbers shift as requests expire):  ' + K.code + ' CODE <number>',
        '  or close the other Web tabs and wait ' + REQUEST_MINUTES + ' minutes.');
    return lines;
}

// The notice for a request as it arrives (the 'primary_link_invitation' event):
// who is asking, how long the code window has left, and the id to name it by.
function formatInvitationNotice(invitation, now) {
    const i = object(invitation) || {};
    const left = isNum(i.expiresAt) ? i.expiresAt - clock(now) : null;
    const window = left === null ? 'unknown' : left <= 0 ? 'expired' : (() => {
        const seconds = Math.ceil(left / 1000);
        return Math.floor(seconds / 60) + ':' + pad2(seconds % 60);
    })();
    return '  ' + ['link request',
        'companion ' + (typeof i.companion === 'string' && i.companion ? i.companion : 'unknown'),
        'code window ' + window,
        'id ' + (typeof i.id === 'string' && i.id ? i.id.slice(0, 8) : 'unknown')].join('   ');
}

// ─── error messages ─────────────────────────────────────────────────────────

const GIVE_UP_KEEP = 'Keep the session folder as it is and report the code shown.';
const RETRY_NEW_CODE = 'On WhatsApp Web choose "Link with phone number" again to get a new code, then run ' + K.code + ' CODE.';
// Confirming needs something the operator has to bring; nothing here says Web shows it.
const PROOF = "the companion's public proof JSON";
const FINISH = 'finish it with ' + K.reconcile + ' (needs ' + PROOF + ')';
const LOG_OUT = 'log out on that device (WhatsApp Web: Menu → Log out)';
const RESEND = 'Do not approve again. Run ' + K.resend + ' to send that step once more under the same message id.';
// A refused step stops the attempt at that step, and resuming it is refused as
// already attempted. The approval stands, so the way out is to start over.
const REFUSED = 'The approval stands, but this step cannot be resumed. Start over: ' + LOG_OUT + ', check ' + K.devices
    + ', clear any leftover hold with ' + K.retire + ' (once the approval is ' + RETIRE_MINUTES + ' minutes old), then ' + K.code + ' with a new code.';
const DISK = 'Free disk space or fix permissions on the session folder, then ';
const QUERY_NEXT = 'Retry in a moment; if it repeats, keep the session folder as it is and report the code shown.';
// The store sets damaged files aside under --reset-message-store and starts afresh (origin 'enabled').
const RESET_STORE = 'Restart wa with --reset-message-store: the damaged files are kept, renamed to <file>.corrupt-<time>, and the history starts again from now.';
const UPLOAD_AGAIN = 'The approval stands. Check the connection, then run ' + K.bootstrap + ': it uploads the saved copy of the history again.';

// code -> [title, next]. One line each: what happened, then the step to take.
const MESSAGES = Object.freeze({
    // ── linking ──────────────────────────────────────────────────────────────
    'PRIMARY_LINK_ABORTED': ['The link was cancelled before it finished.',
        'Run ' + K.status + ' to see how far it got. If an approval was sent, ' + FINISH + '; otherwise start again with ' + K.code + '.'],
    'PRIMARY_LINK_ACCOUNT_CHANGED': ['The account on this connection changed while linking, so the link was stopped.',
        'Run ' + K.disconnect + ', connect to the number again with ' + K.connect + ' <phone>, and start over.'],
    'PRIMARY_LINK_ACCOUNT_REQUIRED': ['This session has no registered phone number to link from.',
        'Run ' + K.disconnect + ', then ' + K.connect + ' <phone> for a number already registered here; a number that is not registered yet needs ' + K.register + ' first.'],
    'PRIMARY_LINK_ADV_MISMATCH': ["The device list on WhatsApp does not match the link state saved for this number, so nothing was changed.",
        'Run ' + K.devices + ' and ' + K.status + ' to compare them, and do not delete the link journal; this needs repair by hand.'],
    'PRIMARY_LINK_BUSY': ['Another link operation is already running in this program.',
        'Wait for it to finish (up to 90 seconds, longer while a large history uploads), then retry; ' + K.unlock + ' cannot help while this program holds the journal.'],
    'PRIMARY_LINK_CODE_ALREADY_USED': ['That pairing code was already used for an earlier approval.', RETRY_NEW_CODE],
    'PRIMARY_LINK_CODE_INVALID': ['The pairing code is not a valid 8-character code.',
        'Copy it again exactly as Web shows it (8 letters and digits, never I, O, U or 0) and run ' + K.code + ' CODE.'],
    'PRIMARY_LINK_CONNECTION_CLOSED': ['The connection to WhatsApp closed while linking.',
        'Run ' + K.reconnect + ', then ' + K.status + ': if an approval was sent, ' + FINISH + '; otherwise start again with ' + K.code + '.'],
    'PRIMARY_LINK_CONNECTION_REQUIRED': ['This session is not connected to WhatsApp as a primary right now.',
        'Run ' + K.reconnect + ' (or ' + K.disconnect + ', then ' + K.connect + ' <phone>), then retry.'],
    'PRIMARY_LINK_DEVICE_LIST_UNCONFIRMED': ["WhatsApp's device list did not show the new companion as expected.",
        'Wait a few seconds and run ' + K.reconcile + ' again; do not approve a second time.'],
    'PRIMARY_LINK_DEVICE_STILL_PRESENT': ["The new companion is still on WhatsApp's device list (or the list changed), so the unfinished link cannot be retired.",
        'Run ' + K.devices + ': if the companion is listed, ' + FINISH + '; if not, try ' + K.retire + ' again in a minute.'],
    'PRIMARY_LINK_DEVICE_UNMATCHED': ['The proof is for a different device than the one WhatsApp reported for this approval.',
        'Do not approve again; use the public proof JSON of the browser you approved with ' + K.reconcile + ', and check ' + K.devices + '.'],
    'PRIMARY_LINK_EXISTING_ADV_REQUIRED': ['This account already has companions but no saved link state for them, so a new link is refused.',
        'Run ' + K.devices + ' and keep the session folder as it is; this needs repair by hand, not another approval.'],
    'PRIMARY_LINK_EXISTING_DEVICE_CHANGED': ["A device linked before this approval has changed on WhatsApp's list.",
        'Run ' + K.devices + ' to see what changed, and do not approve again until the list is what you expect.'],
    'PRIMARY_LINK_FINISH_UNMATCHED': ["The browser's finishing step does not belong to this approval.",
        'Reload WhatsApp Web, ask for a new code with "Link with phone number", and run ' + K.code + ' again.'],
    'PRIMARY_LINK_INVALID': ['Something WhatsApp or the browser sent did not have the expected shape.',
        'Ask Web for a new code and run ' + K.code + ' again; if it repeats, report the code shown.'],
    'PRIMARY_LINK_INVITATION_AMBIGUOUS': ['More than one browser is asking to link, so none was chosen for you.',
        'Run ' + K.invitations + ', then ' + K.code + ' CODE <id> for the one showing your code; or close the other Web tabs and wait ' + REQUEST_MINUTES + ' minutes.'],
    'PRIMARY_LINK_INVITATION_EXPIRED': ['That pairing request has expired (they last about ' + REQUEST_MINUTES + ' minutes).',
        'On Web choose "Link with phone number" again for a fresh code, then run ' + K.code + ' CODE straight away.'],
    'PRIMARY_LINK_INVITATION_REQUIRED': ['No pairing request from WhatsApp Web has reached this number, or the one named is unknown.',
        'On Web choose "Link with phone number" and enter this number, check ' + K.invitations + ', then run ' + K.code + ' CODE.'],
    'PRIMARY_LINK_INVITATION_TIMEOUT': ['No pairing request arrived in time.',
        'On Web choose "Link with phone number" and enter this number, then run ' + K.code + ' CODE straight away.'],
    'PRIMARY_LINK_INVITATION_UNMATCHED': ['The pairing request is not from the browser that was expected.',
        'Check ' + K.invitations + ' and use the request from the browser you mean.'],
    'PRIMARY_LINK_IQ_REJECTED': ['WhatsApp rejected the link request.',
        'Run ' + K.status + ' to see whether anything was sent, wait a minute, then try again with a new code.'],
    'PRIMARY_LINK_IQ_UNCONFIRMED': ["WhatsApp's answer could not be matched to the link request that was sent.",
        'Run ' + K.status + ': if an approval was sent, ' + FINISH + '; otherwise start again with ' + K.code + '.'],
    'PRIMARY_LINK_KEY_EXCHANGE_INVALID': ["The code did not unlock the browser's request: it was mistyped, or Web has shown a newer code since.",
        'Read the code Web shows now, run ' + K.invitations + ' to see which request is newest, and run ' + K.code + ' CODE again.'],
    'PRIMARY_LINK_NO_PENDING_COMMIT': ['There is no approval waiting to be confirmed.',
        'Run ' + K.status + ' to see the state of the link.'],
    'PRIMARY_LINK_NO_RETIRABLE_TRANSACTION': ['There is no unfinished approval that can be retired.',
        'Run ' + K.status + '; only an approval that was sent and never confirmed can be retired.'],
    'PRIMARY_LINK_NOTIFICATION_REJECTED': ['A link message from WhatsApp could not be processed.',
        'Ask Web for a new code and try again; if it repeats, run ' + K.status + ' and report the code shown.'],
    'PRIMARY_LINK_PRIMARY_REQUIRED': ['Only a number registered through this tool can approve companions, and this session is a companion.',
        'Run ' + K.disconnect + ', then ' + K.connect + ' <phone> sms to use the registered number instead.'],
    'PRIMARY_LINK_PROTO_INVALID': ['The saved or received link state could not be decoded.', GIVE_UP_KEEP],
    'PRIMARY_LINK_QR_ALREADY_USED': ['That QR code was already used for an earlier approval.',
        'Reload the Web page so it shows a fresh QR, then run ' + K.qr + ' PAYLOAD with the new one.'],
    'PRIMARY_LINK_QR_INVALID': ['That is not a WhatsApp Web link QR code (or it has expired).',
        'Copy the whole QR text or wa.me link again, from a fresh QR, and run ' + K.qr + ' PAYLOAD.'],
    'PRIMARY_LINK_QUERY_ACCOUNT': ["WhatsApp's device list is for a different account than this one.", QUERY_NEXT],
    'PRIMARY_LINK_QUERY_DEVICE_TAG': ["WhatsApp's device list held an entry that is not a device.", QUERY_NEXT],
    'PRIMARY_LINK_QUERY_DEVICES': ["WhatsApp's device list was empty or longer than any account can have.", QUERY_NEXT],
    'PRIMARY_LINK_QUERY_KEY_INDEX': ["A companion on WhatsApp's device list has no usable key index.", QUERY_NEXT],
    'PRIMARY_LINK_QUERY_LIST': ["WhatsApp's device list reply did not hold exactly one list.", QUERY_NEXT],
    'PRIMARY_LINK_QUERY_SID': ["WhatsApp's device list reply answered a different request.", QUERY_NEXT],
    'PRIMARY_LINK_RECONCILIATION_REQUIRED': ['An earlier approval has not been finished, so a new one is refused.',
        'If the companion appeared, ' + FINISH + '; if it never did, ' + K.retire + ' clears it once it is ' + RETIRE_MINUTES + ' minutes old.'],
    'PRIMARY_LINK_REPEATED_RETRY': ['WhatsApp asked twice to retry the approval with a new timestamp.',
        'Check the system clock, run ' + K.status + ', and start again with a new code.'],
    'PRIMARY_LINK_RETIRE_TOO_EARLY': ['The unfinished approval is less than ' + RETIRE_MINUTES + ' minutes old, so it cannot be retired yet.',
        'Wait until it is ' + RETIRE_MINUTES + ' minutes old, then run ' + K.retire + '; if the companion has appeared, use ' + K.reconcile + ' instead.'],
    'PRIMARY_LINK_SIGNAL_INVALID': ['The cancel signal handed to the link was not usable.',
        'This is a mistake in the calling program: pass a real AbortSignal, or none.'],
    'PRIMARY_LINK_STATE_EXISTS': ['Link state already exists for this number, so it cannot be imported again.',
        'Run ' + K.status + ' to see it; link state is only imported into a number that has none.'],
    'PRIMARY_LINK_STOPPED': ['The link was stopped before it finished.',
        'Run ' + K.status + ' to see how far it got, then continue or start again.'],
    'PRIMARY_LINK_STORE_BUSY': ['Another program is using the link journal for this number.',
        'Close the other wa window or worker using this session; if it is gone for good, run ' + K.unlock + ' to break its lock.'],
    'PRIMARY_LINK_STORE_CONFLICT': ['The link journal was changed by another writer at the same moment.',
        'Make sure only one wa program uses this number, then retry.'],
    'PRIMARY_LINK_STORE_INVALID': ['The link journal could not be read, or does not belong to this number.',
        'Do not delete the journal. ' + GIVE_UP_KEEP],
    'PRIMARY_LINK_STORE_LOST': ['This program lost its lock on the link journal; another process broke it.',
        'Stop every other wa program using this number, run ' + K.reconnect + ', check ' + K.status + ', and only then retry.'],
    'PRIMARY_LINK_STORE_REQUIRED': ['There is no absolute session folder to keep the link journal in.',
        'Start wa with --session <absolute folder> (or without --session, for the default) and connect again.'],
    'PRIMARY_LINK_STORE_WRITE_FAILED': ['The link journal could not be written to disk.',
        DISK + 'check ' + K.status + ' before retrying.'],
    'PRIMARY_LINK_TIMEOUT': ['WhatsApp did not answer within 90 seconds.',
        'Run ' + K.status + ': if an approval was sent, ' + FINISH + '; otherwise try again.'],
    'PRIMARY_LINK_TIMEOUT_INVALID': ['The time limit given for the link is outside 1 to 90 seconds.',
        'Use a limit from 1 to 90 seconds, or none.'],
    'PRIMARY_LINK_TIMESTAMP_INVALID': ["WhatsApp's requested timestamp is more than a day from this computer's clock.",
        'Set the system date and time correctly, then start again with a new code.'],
    'PRIMARY_LINK_TRANSACTION_CHANGED': ['The unfinished approval changed while it was being retired.',
        'Run ' + K.status + ' and, if it is still unfinished, run ' + K.retire + ' again.'],
    'PRIMARY_LINK_UNCONFIRMED': ['The result of the link could not be confirmed.',
        'Do not approve again. Run ' + K.devices + ' and ' + K.status + ': if the companion is listed, ' + FINISH + '; otherwise wait ' + RETIRE_MINUTES + ' minutes and use ' + K.retire + '.'],
    'PRIMARY_LINK_VERIFICATION_REQUIRED': ['WhatsApp wants extra verification before it will let another device link.',
        'Nothing was linked, and this tool cannot answer that check. Wait a while, run ' + K.status + ', and try again later.'],
    'PRIMARY_LINK_WAIT_INVALID': ['The wait for a pairing request is outside 0 to 90 seconds.',
        'Use a wait from 0 to 90 seconds.'],
    'PRIMARY_LINK_WEB_PROOF_INVALID': ['That is not a WhatsApp Web public binding proof.',
        'Confirming a link needs ' + PROOF + ' (see the docs): pass it whole, as a file or the JSON itself, to ' + K.reconcile + '.'],

    // ── the bootstrap: key share, app-state patch, history ───────────────────
    'PRIMARY_BOOTSTRAP_ACK_': ['WhatsApp refused a bootstrap message with an error number.', REFUSED],
    'PRIMARY_BOOTSTRAP_ACK_REJECTED': ["The companion's device did not accept a bootstrap message.", REFUSED],
    'PRIMARY_BOOTSTRAP_ACK_UNCERTAIN': ['No reply came for a bootstrap message within 15 seconds, so it is not known whether the companion got it.',
        'Wait a minute. ' + RESEND],
    'PRIMARY_BOOTSTRAP_ALREADY_ATTEMPTED': ['A bootstrap was already tried for this link and will not be started a second time.',
        'Run ' + K.status + '. If it shows sent, the history was delivered. If it shows a refusal, that cannot be resumed: follow that error\'s next step. '
        + 'If it simply stopped, continue with ' + K.bootstrap + '.'],
    'PRIMARY_BOOTSTRAP_AUTHORIZED_LINK_REQUIRED': ['There is no approved companion to bootstrap.',
        'Approve one first with ' + K.code + ' or ' + K.qr + ' (' + K.status + ' shows the state).'],
    'PRIMARY_BOOTSTRAP_DEVICE_UNCONFIRMED': ["WhatsApp's device list does not show exactly one new companion yet.",
        'Wait a few seconds and run ' + K.bootstrap + ' again; if it never appears, check ' + K.devices + '.'],
    'PRIMARY_BOOTSTRAP_EXISTING_COMPANIONS_UNSUPPORTED': ['This account already has another companion, and history can only be handed to the first and only one.',
        'Log out on that device (WhatsApp Web: Menu → Log out), check ' + K.devices + ' until it is gone, then link again.'],
    'PRIMARY_BOOTSTRAP_EXISTING_HISTORY': ['This session already holds history files that the bootstrap will not write over.',
        'Move the .history.json and .messages.json files out of the session folder (keep a copy), then retry.'],
    'PRIMARY_BOOTSTRAP_EXISTING_KEYS': ['The app-state key file in this session was not made by this tool, or cannot be trusted.',
        'Do not delete or edit it. ' + GIVE_UP_KEEP],
    'PRIMARY_BOOTSTRAP_EXISTING_SESSION': ['An encrypted session with the new companion already exists, and the bootstrap will not replace it.',
        'If an earlier bootstrap for it stopped part-way, continue with ' + K.bootstrap + '; otherwise ' + GIVE_UP_KEEP.toLowerCase()],
    'PRIMARY_BOOTSTRAP_EXISTING_STATE': ['This number already has app-state data that a first bootstrap would write over.', GIVE_UP_KEEP],
    'PRIMARY_BOOTSTRAP_FOREIGN_STATE': ['The app-state on WhatsApp or on disk was not written by this tool, so the bootstrap will not touch it.',
        'Run ' + K.status + ' and do not retry blindly. ' + GIVE_UP_KEEP],
    'PRIMARY_BOOTSTRAP_HISTORY_INVALID': ['The history could not be encoded into the form WhatsApp Web reads, so it was not sent.',
        'Run ' + K.bootstrap + ' once, as it reads the store again; if it stops the same way, back up the session folder and report the code shown.'],
    'PRIMARY_BOOTSTRAP_HISTORY_REQUIRED': ['There was no usable history to hand over.',
        'Make sure the message store is on and has been capturing, then run ' + K.bootstrap + '.'],
    'PRIMARY_BOOTSTRAP_HISTORY_UNCERTAIN': ['The history was sent but no reply came, so it is not known whether the companion got it.', RESEND],
    'PRIMARY_BOOTSTRAP_KEY_SHARE_UNCERTAIN': ['The sync key was sent but no reply came, so it is not known whether the companion got it.', RESEND],
    'PRIMARY_BOOTSTRAP_KEYS_CHANGED': ['The app-state key file changed while the bootstrap was running.',
        'Do not edit session files during a link; run ' + K.bootstrap + ' to continue, and report the code if it repeats.'],
    'PRIMARY_BOOTSTRAP_LOCAL_ERROR': ['The bootstrap stopped on a local problem (disk, permissions or an unexpected error).',
        'Check free space and permissions on the session folder, then run ' + K.bootstrap + ' to continue.'],
    'PRIMARY_BOOTSTRAP_NAME_REQUIRED': ['This number has no profile name the bootstrap can use (unset, "User", or over 25 characters).',
        'Set one with ' + K.name + ' <text> (up to 25 characters), then link again.'],
    'PRIMARY_BOOTSTRAP_OUTBOX_INVALID': ['The saved copy of the history waiting to be sent is damaged.',
        'Do not delete the outbox file. ' + GIVE_UP_KEEP],
    'PRIMARY_BOOTSTRAP_PATCH_REJECTED': ['WhatsApp rejected the app-state write the bootstrap makes (the profile name).', REFUSED],
    'PRIMARY_BOOTSTRAP_PEER_UNMATCHED': ["The companion's key on WhatsApp is not the one that was approved.",
        'Stop: it may be a different device. Run ' + K.devices + ', and log out on any device that is not the one you approved (WhatsApp Web: Menu → Log out) before linking again.'],
    'PRIMARY_BOOTSTRAP_PERSISTENCE_REQUIRED': ['The app-state version could not be saved to disk.', DISK + 'run ' + K.bootstrap + '.'],
    'PRIMARY_BOOTSTRAP_SERVER_STATE_REQUIRED': ["WhatsApp's app-state for this number is not empty, which a first bootstrap needs.", GIVE_UP_KEEP],
    'PRIMARY_BOOTSTRAP_UPLOAD_FAILED': ["The history could not be uploaded to WhatsApp's media servers.", UPLOAD_AGAIN],
    'PRIMARY_BOOTSTRAP_UPLOAD_INVALID': ['The upload of the history did not match what was saved to send.',
        'Run ' + K.bootstrap + ' to send it again from the saved copy.'],
    'PRIMARY_BOOTSTRAP_UPLOAD_TIMEOUT': ['The upload of the history did not finish in the time it is given.', UPLOAD_AGAIN],
    'PRIMARY_BOOTSTRAP_UPLOAD_TIMEOUT_INVALID': ['The time limit given for the history upload is outside 1 second to 1 hour.',
        'This is a mistake in the calling program: pass uploadTimeoutMs from 1000 to 3600000, or none.'],
    'PRIMARY_BOOTSTRAP_UPLOAD_REQUIRED': ['A large history needs an upload step, and none was available.',
        'Run ' + K.bootstrap + '; this tool supplies the upload itself. If it repeats, report the code shown.'],

    // ── the primary message store ────────────────────────────────────────────
    'PRIMARY_MESSAGE_STORE_DISABLED': ['The message store is off, so there is no history to hand the companion.',
        'Restart wa without --no-message-store (the store is on by default) and connect again; it keeps messages only from then on, so earlier ones stay missing.'],
    'PRIMARY_MESSAGE_STORE_FAILED': ['The message store failed for a reason it could not name.',
        'Check free disk space and permissions on the session folder, then run ' + K.reconnect + '.'],
    'PRIMARY_MESSAGE_STORE_BUSY': ["Another wa, in this program or in another process, has this number's message store open.",
        'Close the other wa using this session, or wait until it has finished, then run ' + K.reconnect + '. If no other wa is running, restart wa with --unlock-message-store.'],
    'PRIMARY_MESSAGE_STORE_CLOCK_INVALID': ["The computer's clock gave a time the message store cannot use.",
        'Set the system date and time correctly, then run ' + K.reconnect + '.'],
    'PRIMARY_MESSAGE_STORE_CLOSED': ['The message store was closed, usually because the connection was.',
        'Run ' + K.reconnect + ', then try again.'],
    'PRIMARY_MESSAGE_STORE_INPUT_INVALID': ['The message store was handed a message it could not record, so that one message was not kept.',
        'Nothing needs doing for one; if it keeps happening, report the code shown.'],
    'PRIMARY_MESSAGE_STORE_LOG_CORRUPT': ['The message log on disk is damaged, so the store cannot be opened.', RESET_STORE],
    'PRIMARY_MESSAGE_STORE_LOST': ['This program lost its lock on the message store; another process broke it, so it keeps no more messages.',
        'Stop every other wa using this number, then run ' + K.reconnect + '.'],
    'PRIMARY_MESSAGE_STORE_OPTIONS_INVALID': ['The message store was opened with settings it does not accept.',
        'Fix the messageStore option (perChat and maxMessages are whole numbers) and connect again.'],
    'PRIMARY_MESSAGE_STORE_SNAPSHOT_CORRUPT': ['The saved message store snapshot is damaged, so the store cannot be opened.', RESET_STORE],
    'PRIMARY_MESSAGE_STORE_WRITE_FAILED': ['The message store could not write to disk.', DISK + 'run ' + K.reconnect + '.'],

    // ── the history encoder ──────────────────────────────────────────────────
    'PRIMARY_HISTORY_EXPORT_CUTOFF_INVALID': ['The cut-off point for the newer-messages step was not valid.',
        'Run ' + K.bootstrap + ' again; if it repeats, report the code shown.'],
    'PRIMARY_HISTORY_EXPORT_INLINE_NOT_INITIAL': ['Only the first history message may carry its history inside it; this one had to be an upload.',
        'This is a mistake in the calling program; report the code shown.'],
    'PRIMARY_HISTORY_EXPORT_INLINE_TOO_LARGE': ['The history was too large to send inside the message.',
        'Run ' + K.bootstrap + ' again; a large history is sent as an upload instead.'],
    'PRIMARY_HISTORY_EXPORT_OPTIONS_INVALID': ['The history encoder was given settings it does not accept.',
        'This is a mistake in the calling program; report the code shown.'],
    'PRIMARY_HISTORY_EXPORT_PAYLOAD_INVALID': ['The history message to send was malformed.',
        'Run ' + K.bootstrap + ' again; if it repeats, report the code shown.'],
    'PRIMARY_HISTORY_EXPORT_SNAPSHOT_INVALID': ['The message store handed over a snapshot the history encoder cannot use.',
        'Nothing was sent. Back up the session folder and report the code shown.']
});

// ── the handover after an approval ───────────────────────────────────────
//
// A stop that is the link's own (its time, a cancel, the connection, a disk
// that refused the journal, a reply that did not match) leaves a bootstrap with
// every step it got through recorded. The approval stands, and the way on is
// the resume: never a proof, never a new approval. These words replace the
// link's own when the error came from a bootstrap (context 'bootstrap', and
// 'status' for one /link-status shows). A step that went out and was never
// answered is sent again only on request, so a stop at one asks for that.
function continueFrom(phase, before = '', after = '') {
    const unanswered = typeof phase === 'string' && /_sending$/.test(phase) && phase !== 'critical_patch_sending';
    return 'The approval stands and every step already accepted is kept: ' + before + 'continue with '
        + (unanswered ? K.resend + ' (no reply came for the step that was going out; it goes once more, under the same message id).' : K.bootstrap + '.') + after;
}
// code -> [title, what to do before the resume, what to add after it]
const RECONNECT_FIRST = 'run ' + K.reconnect + ', then ';
const HANDOVER = Object.freeze({
    'PRIMARY_LINK_ABORTED': ['The handover to the companion was cancelled before it finished.', ''],
    'PRIMARY_LINK_CONNECTION_CLOSED': ['The connection to WhatsApp closed during the handover to the companion.', RECONNECT_FIRST],
    'PRIMARY_LINK_CONNECTION_REQUIRED': ['This session is not connected to WhatsApp as a primary, so the handover cannot go on.', RECONNECT_FIRST],
    'PRIMARY_LINK_IQ_REJECTED': ['WhatsApp refused a request the handover made.', 'wait a minute, then ', ' If it is refused again, report the code shown.'],
    'PRIMARY_LINK_IQ_UNCONFIRMED': ["WhatsApp's answer to a step of the handover could not be matched to it.", ''],
    'PRIMARY_LINK_STOPPED': ['The handover to the companion was stopped before it finished.', ''],
    'PRIMARY_LINK_STORE_LOST': ['This program lost its lock on the link journal during the handover; another process broke it.',
        'stop every other wa program using this number, ' + RECONNECT_FIRST],
    'PRIMARY_LINK_STORE_WRITE_FAILED': ['The link journal could not be written to disk during the handover.', 'free disk space or fix permissions on the session folder, then '],
    'PRIMARY_LINK_TIMEOUT': ['The handover to the companion did not finish within 90 seconds (an upload of the history has time of its own).', ''],
    'PRIMARY_LINK_VERIFICATION_REQUIRED': ['WhatsApp asked for extra verification during the handover, which this tool cannot answer.', 'wait a while, then '],
    'PRIMARY_MESSAGE_STORE_CLOSED': ['The message store was closed during the handover, usually because the connection was.', RECONNECT_FIRST]
});
// A store that failed during the handover is fixed first; the handover then goes on.
const STORE_THEN_CONTINUE = new Set(['PRIMARY_MESSAGE_STORE_BUSY', 'PRIMARY_MESSAGE_STORE_CLOCK_INVALID', 'PRIMARY_MESSAGE_STORE_FAILED', 'PRIMARY_MESSAGE_STORE_LOST', 'PRIMARY_MESSAGE_STORE_WRITE_FAILED']);
// /link-status is what is on the screen, so nothing it shows sends anyone back to it.
const STATUS_NEXT = Object.freeze({
    'PRIMARY_BOOTSTRAP_FOREIGN_STATE': 'Do not retry blindly. ' + GIVE_UP_KEEP
});
// wa listen has no shell to type a command into: what it is told instead.
const LISTEN_NEXT = Object.freeze({
    'PRIMARY_MESSAGE_STORE_BUSY': 'Close the other wa using this session, or wait until it has finished, then restart wa. If no other wa is running, break the lock with wa connect <phone> --unlock-message-store (it asks first).',
    'PRIMARY_MESSAGE_STORE_CLOCK_INVALID': 'Set the system date and time correctly, then restart wa.',
    'PRIMARY_MESSAGE_STORE_CLOSED': 'Nothing needs doing if the connection comes back, as the store opens again with it; if these keep coming, restart wa.',
    'PRIMARY_MESSAGE_STORE_FAILED': 'Check free disk space and permissions on the session folder, then restart wa.',
    'PRIMARY_MESSAGE_STORE_LOST': 'Stop every other wa using this number, then restart wa.',
    'PRIMARY_MESSAGE_STORE_WRITE_FAILED': 'Free disk space or fix permissions on the session folder, then restart wa.'
});
const VERIFY_LATER = 'Nothing was linked, and this tool cannot answer that check. Wait a while, then try again with a new code.';

const GENERIC_TITLE = 'The link stopped for a reason this command does not recognise.';

function genericNext(code, context) {
    const named = typeof code === 'string' && code ? ' The code is ' + code + '.' : ' Report the error text as it was shown.';
    if (context === 'status') return 'Do not approve again. Continue with ' + K.bootstrap + ', and if it stops the same way, report the code.' + named;
    return 'Run ' + K.status + ' to see where it stopped, and do not approve again until it says nothing is pending.' + named;
}

// ' (pid 4242 on box, since 2026-11-02 15:31)', or '' when the lock names nobody.
function holderWhere(holder) {
    const who = [];
    if (isNum(holder.pid)) who.push('pid ' + holder.pid);
    if (typeof holder.host === 'string' && holder.host) who.push('on ' + holder.host);
    const since = stamp(holder.at);
    return who.length ? ' (' + who.join(' ') + (since && !holder.legacy ? ', since ' + since : '') + ')' : '';
}

function holderTitle(holder) {
    const where = holderWhere(holder);
    if (holder.mutex) return 'A takeover of the link journal\'s lock is in progress' + where + ', or died part-way.';
    return where ? 'Another process' + where + ' holds the link journal for this number.'
        : 'Another process holds the link journal for this number, and its details cannot be read.';
}

// The message store's BUSY, when it says who holds the store (err.holder).
// The way out of a holder that is gone is --unlock-message-store, a flag at
// startup: wa listen cannot ask, so it is sent to wa connect for it, and
// 'unlock' is the flag's own run, which is not sent back to itself.
const UNLOCK_STORE = '--unlock-message-store';
function storeHolderTitle(holder) {
    const where = holderWhere(holder);
    if (holder.mutex) return 'A takeover of the message store\'s lock is in progress' + where + ', or died part-way.';
    return where ? 'Another process' + where + ' has this number\'s message store open.'
        : 'Another process has this number\'s message store open, and its details cannot be read.';
}
function storeHolderNext(holder, context) {
    if (holder.mutex) {
        if (context === 'listen') return 'Wait a minute, then start wa listen again; if it stays, clear it with wa connect <phone> ' + UNLOCK_STORE + ' (it asks first).';
        if (context === 'unlock') return 'A recovery is still running on this machine: wait a minute, then start wa with ' + UNLOCK_STORE + ' again.';
        return 'Wait a minute, then run ' + K.reconnect + '; if it stays, restart wa with ' + UNLOCK_STORE + ' to clear it.';
    }
    if (context === 'listen') return 'Close that wa; if no other wa is using this number, break the lock with wa connect <phone> ' + UNLOCK_STORE + ' (it asks first), then start wa listen again.';
    if (context === 'unlock') return 'Close that wa; if no other wa is using this number, start wa with ' + UNLOCK_STORE + ' again.';
    return 'Close that wa; if no other wa is using this number (it stopped, or ran on another machine or in another container), restart wa with ' + UNLOCK_STORE + ' to break the lock.';
}

// code -> { title, next }. `error` is optional: for a busy journal or message
// store its `holder` says who has it, and whether what stands in the way is a
// takeover in progress rather than the lock itself; for a bootstrap, `resumable` false
// says its attempt can never continue, and `bootstrapPhase` where it stopped.
// `context` is 'unlock' when the error came from the unlock command itself,
// which changes what a takeover in progress should be told ("again" only
// makes sense after an unlock); 'bootstrap' when it came from a bootstrap, so
// that a stop of the link's own is answered with the resume; 'status' for the
// error a bootstrap recorded, as /link-status shows it.
const own = (table, key) => Object.prototype.hasOwnProperty.call(table, key);
function explainError(code, error, context) {
    const text = typeof code === 'string' ? code : '';
    const e = object(error);
    const handover = context === 'bootstrap' || context === 'status';
    let entry = null;
    if (handover && own(HANDOVER, text)) {
        const [title, before, after] = HANDOVER[text];
        entry = [title, continueFrom(e && e.bootstrapPhase, before, after)];
    } else if (own(MESSAGES, text)) entry = MESSAGES[text];
    if (!entry) {
        const ack = /^PRIMARY_BOOTSTRAP_ACK_(\d{3})$/.exec(text);
        if (ack) entry = ['WhatsApp refused a bootstrap message with error ' + ack[1] + '.', REFUSED];
    }
    if (!entry) return { title: GENERIC_TITLE, next: genericNext(text, context) };
    let [title, next] = entry;
    const storeHolder = text === 'PRIMARY_MESSAGE_STORE_BUSY' && e ? object(e.holder) : null;
    if (storeHolder) {
        title = storeHolderTitle(storeHolder);
        next = storeHolderNext(storeHolder, context);
    }
    if (handover) {
        // An attempt that can never continue is started over, whatever stopped it.
        if (e && e.resumable === false) next = REFUSED;
        else if (STORE_THEN_CONTINUE.has(text)) next += ' Then continue the handover with ' + K.bootstrap + '.';
    }
    if (context === 'status' && next.includes(K.status)) next = own(STATUS_NEXT, text) ? STATUS_NEXT[text] : genericNext(text, context);
    if (context === 'listen' && own(LISTEN_NEXT, text) && !storeHolder) next = LISTEN_NEXT[text];
    const holder = text === 'PRIMARY_LINK_STORE_BUSY' && error ? object(error.holder) : null;
    if (holder) {
        title = holderTitle(holder);
        next = holder.mutex
            ? (context === 'unlock'
                ? 'A recovery is still running on this machine: wait a minute, then run ' + K.unlock + ' again.'
                : 'Run ' + K.unlock + ' to clear it.')
            : 'Close that program; if it is gone for good (another machine or container, or an old lock), run ' + K.unlock + ' to break the lock.';
    }
    return { title, next };
}

const FOREIGN_REASONS = Object.freeze({
    local_keys: 'the app-state key file here was not made by this tool',
    server_unknown: "WhatsApp's app-state could not be read",
    server_foreign: "WhatsApp's app-state was written by another key",
    server_unverified: "WhatsApp's app-state could not be verified",
    local_state: 'this session already holds app-state data',
    local_history: 'this session already has history files'
});

// A readiness blocker is `{ code, detail }`. The detail makes the message
// specific (how old the hold is, how many companions); without it this is
// explainError.
function explainBlocker(blocker) {
    const b = object(blocker) || {};
    const detail = object(b.detail) || {};
    switch (b.code) {
        case 'PRIMARY_LINK_RECONCILIATION_REQUIRED': {
            const age = isNum(detail.ageMs) && detail.ageMs >= 0 ? ', ' + Math.max(1, Math.round(detail.ageMs / 60000)) + ' min old' : '';
            const phase = typeof detail.phase === 'string' ? ' (' + detail.phase + age + ')' : '';
            return {
                title: 'An earlier approval' + phase + ' has not been finished, so a new one is refused.',
                next: detail.retirable === true
                    ? 'It is old enough to retire: run ' + K.retire + ' (or, if the companion did appear, ' + FINISH + ').'
                    : 'If the companion appeared, ' + FINISH + '; if not, ' + K.retire + ' works once it is ' + RETIRE_MINUTES + ' minutes old.'
            };
        }
        case 'PRIMARY_BOOTSTRAP_EXISTING_COMPANIONS_UNSUPPORTED': {
            const n = detail.companions;
            return {
                title: (isNum(n) ? plural(n, 'companion') + ' already linked' : 'Companions are already linked')
                    + ', and history can only be handed to the first and only one.',
                next: explainError(b.code).next
            };
        }
        case 'PRIMARY_BOOTSTRAP_FOREIGN_STATE': {
            const why = (Array.isArray(detail.reasons) ? detail.reasons : []).map(r => FOREIGN_REASONS[r]).filter(Boolean);
            if (!why.length) break;
            return {
                title: "This number's state was not made by this tool, so the bootstrap will not touch it: " + why.join('; ') + '.',
                next: explainError(b.code).next
            };
        }
        case 'PRIMARY_MESSAGE_STORE_DISABLED':
            if (detail.reason === 'unreadable') {
                // The store's own failure, in its own words, when it named one.
                const code = typeof detail.code === 'string' && /^PRIMARY_MESSAGE_STORE_/.test(detail.code) && own(MESSAGES, detail.code) ? detail.code : null;
                if (code) {
                    const why = MESSAGES[code][0].replace(/\.$/, '');
                    return { title: 'There is no history to hand over: ' + why.charAt(0).toLowerCase() + why.slice(1) + '.', next: MESSAGES[code][1] };
                }
                return {
                    title: 'The message store could not be read' + (typeof detail.code === 'string' ? ' (' + detail.code.replace(/^PRIMARY_MESSAGE_STORE_/, '').toLowerCase().replace(/_/g, ' ') + ')' : '') + ', so there is no history to hand over.',
                    next: 'Back up the session folder and report the code shown; do not delete the store files.'
                };
            }
            break;
        default:
    }
    return explainError(b.code);
}

// An error caught from any of the calls below, as lines to print: what
// happened, the step to take, and the stable code so it can be reported.
function describeError(error, context) {
    const e = object(error);
    const code = e && typeof e.code === 'string' && e.code.startsWith('PRIMARY_') ? e.code : null;
    const lines = [];
    if (!code) {
        lines.push(e && e.message !== undefined ? String(e.message) : String(error));
    } else {
        const blockers = Array.isArray(e.blockers) ? e.blockers : [];
        // A failure after the approval is a bootstrap's, whichever command ran it.
        const info = blockers.length && blockers[0] && blockers[0].code === code ? explainBlocker(blockers[0])
            : explainError(code, e, context || (e.afterApproval === true ? 'bootstrap' : undefined));
        lines.push(info.title, '  next: ' + info.next, '  (' + code + ')');
        const message = typeof e.message === 'string' ? e.message : '';
        if (message.startsWith(code + ': ')) lines.push('  detail: ' + message.slice(code.length + 2));
        if (blockers.length > 1) {
            lines.push('also in the way:');
            for (const blocker of blockers.slice(1)) {
                const more = explainBlocker(blocker);
                lines.push('  - ' + more.title, '    next: ' + more.next);
            }
        }
    }
    if (e && e.afterApproval === true) {
        lines.push('The approval was already sent and stands, so do not repeat it; follow the next step above for the history.');
    }
    return lines;
}

// ─── events ─────────────────────────────────────────────────────────────────

// The message store reports every message it could not record, and on a full
// disk that is every message. The limiter answers whether a report of `code`
// is shown now: once per code a minute, the first one at once. A report shown
// after some were held back says how many (formatHeldBack). `now` is a clock
// for tests, as elsewhere here.
function createEventLimiter({ windowMs = 60000, now } = {}) {
    const last = new Map();
    return code => {
        const at = clock(now), key = String(code), seen = last.get(key);
        if (seen && at - seen.at < windowMs) {
            seen.held++;
            return null;
        }
        last.set(key, { at, held: 0 });
        return { held: seen ? seen.held : 0 };
    };
}
function formatHeldBack(held) {
    return '  (' + held + ' more like this since the last one ' + (held === 1 ? 'was' : 'were') + ' not shown)';
}

// ─── readiness and the coverage notice ──────────────────────────────────────

const REASONS = Object.freeze({
    undecryptable: n => plural(n, 'received message') + ' could not be decrypted',
    'received-not-stored': n => plural(n, 'received message') + (n === 1 ? ' was' : ' were') + ' not saved'
});

function windowText(loss) {
    const from = stamp(loss.from), to = stamp(loss.to);
    return from && to ? ' from ' + from + ' to ' + to : from ? ' from ' + from : to ? ' until ' + to : '';
}

// What the store knows it lost, one phrase per reason (counts added up) and
// one per time window. Message ids are never printed.
function describeLosses(losses) {
    const counted = new Map(), phrases = [], windows = [];
    for (const loss of Array.isArray(losses) ? losses : []) {
        const l = object(loss);
        if (!l) continue;
        const reason = typeof l.reason === 'string' ? l.reason : 'unknown';
        const n = Array.isArray(l.ids) ? l.ids.length : isNum(l.count) ? l.count : null;
        if (reason === 'store-disabled') {
            windows.push('no messages were captured' + (windowText(l) || ' for a while') + ' (the store was off)');
        } else if (reason === 'write-failed') {
            windows.push('messages were not saved' + (windowText(l) || ' for a while') + ' (the store could not write to disk)');
        } else if (n !== null) {
            counted.set(reason, (counted.get(reason) || 0) + n);
        } else {
            windows.push('messages were lost' + windowText(l) + ' (' + reason + ')');
        }
    }
    for (const [reason, n] of counted) {
        phrases.push(REASONS[reason] ? REASONS[reason](n) : plural(n, 'message') + ' lost (' + reason + ')');
    }
    return phrases.concat(windows);
}

// Why capture begins where it does: since this number was registered (nothing
// before it was missed) or since the store was switched on (everything before
// that was never seen).
function captureText(capture) {
    const c = object(capture), since = c ? stamp(c.since) : null, origin = c && typeof c.origin === 'string' ? c.origin : null;
    if (origin === 'registration') {
        return 'since registration' + (since ? ' (' + since + ')' : '') + ': the store has been on since this number was registered';
    }
    if (origin === 'enabled') {
        return since ? 'since ' + since + ' - the store was switched on then, so anything earlier was never captured'
            : 'start unknown - the store was switched on after registration, so anything earlier was never captured';
    }
    if (since) return 'since ' + since + (origin ? ' (' + origin + ')' : ', and why it began there is unknown');
    return origin ? 'start unknown (' + origin + ')' : 'unknown';
}

function retainedText(retained) {
    // Not said is not "nothing": a history that does not carry the range is unknown.
    const r = object(retained);
    if (!r) return 'unknown';
    // from and to are the oldest and newest message kept, in seconds, and both
    // null when it keeps none. A part that is missing is not that: it is unknown.
    let range = 'range unknown';
    if (isNum(r.from) && isNum(r.to)) range = stamp(r.from * 1000) + ' to ' + stamp(r.to * 1000);
    else if (r.from === null && r.to === null) range = 'no messages kept';
    let dropped = 'how many older messages were dropped is unknown';
    if (isNum(r.evicted)) {
        dropped = r.evicted > 0
            ? plural(r.evicted, 'older message') + (r.evicted === 1 ? ' was' : ' were') + " dropped to stay within the store's limits"
            : 'nothing older was dropped';
    }
    return range + '; ' + dropped;
}

const LABEL_WIDTH = 'known or possible losses'.length;
const labelled = (label, text) => '  ' + label.padEnd(LABEL_WIDTH) + '   ' + text;

// The history that would go, as three facts kept apart: the period the store
// has been capturing (and why it begins there), the range it still holds (and
// how many older messages it let go of), and what it knows or suspects it
// lost. No single flag says "complete".
function coverageLines(history) {
    const h = object(history);
    if (!h || h.enabled === false) return ['history: none - there is no message store, so the companion would get no history'];
    const parts = [];
    if (isNum(h.chats)) parts.push(plural(h.chats, 'chat'));
    if (isNum(h.records)) parts.push(plural(h.records, 'message'));
    const losses = describeLosses(h.losses);
    return [
        'history to send: ' + (parts.length ? parts.join(', ') : 'amount unknown'),
        labelled('capture period', captureText(h.capture)),
        labelled('retained range', retainedText(h.retained)),
        labelled('known or possible losses', !Array.isArray(h.losses) ? 'unknown' : losses.length ? losses.join('; ') : 'none recorded')
    ];
}

function readinessSummary(readiness) {
    const h = object(readiness.history);
    const what = h && h.enabled !== false
        ? [isNum(h.chats) ? plural(h.chats, 'chat') : null, isNum(h.records) ? plural(h.records, 'message') : null].filter(Boolean).join(', ')
        : '';
    return 'ready to link (' + (readiness.mode === 'relink' ? 're-link' : 'first link') + ')' + (what ? ': ' + what + ' to send' : '');
}

// getPrimaryLinkReadiness() as lines: what stands in the way and what to do
// about each, or the mode and the coverage notice.
function formatReadiness(readiness) {
    const r = object(readiness) || {};
    const blockers = Array.isArray(r.blockers) ? r.blockers : [];
    if (r.ready === false || blockers.length) {
        const lines = ['not ready to link:'];
        for (const blocker of blockers) {
            const info = explainBlocker(blocker);
            lines.push('  - ' + info.title, '    next: ' + info.next);
        }
        return lines;
    }
    const lines = [r.mode === 'relink' ? 'ready to link (re-link over this number\'s earlier bootstrap)' : 'ready to link (first link)'];
    lines.push(...coverageLines(r.history));
    if (r.needsConfirmation) lines.push('This is only what this program captured, not everything the account has ever sent or received.');
    return lines;
}

// ─── the link itself ────────────────────────────────────────────────────────

function formatBootstrapResult(result) {
    const r = object(result) || {};
    const h = object(r.history);
    const lines = [];
    const mode = r.mode === 'relink' ? 're-link' : r.mode === 'first' ? 'first link' : null;
    if (h) {
        const what = [isNum(h.chats) ? plural(h.chats, 'chat') : null, isNum(h.records) ? plural(h.records, 'message') : null, size(h.bytes)].filter(Boolean);
        lines.push('history handed to the companion: ' + (what.join(', ') || 'sent')
            + (h.inline === false ? ' (uploaded as a blob)' : h.inline === true ? ' (sent inline)' : '') + (mode ? ', ' + mode : ''));
    } else if (mode) {
        lines.push('bootstrap sent (' + mode + ')');
    }
    const delta = object(r.delta);
    if (delta && isNum(delta.records) && delta.records > 0) lines.push(plural(delta.records, 'newer message') + ' sent after it');
    // What the store says it missed, as the history that went over held it
    // (PrimaryBootstrapResult.history): losses is how many loss records it
    // had, each a run of messages seen and not kept or a time it was not
    // capturing. null is a provider that does not say, and is not printed.
    if (h && typeof h.captureOrigin === 'string') {
        // The result names how capture began, not when: the readiness check showed the date.
        lines.push('capture period: ' + (h.captureOrigin === 'enabled' ? 'since the store was switched on, after registration, so anything earlier was never captured'
            : captureText({ origin: h.captureOrigin })));
    }
    if (h && isNum(h.evicted) && h.evicted > 0) lines.push(plural(h.evicted, 'older message') + ' had' + " been dropped from the store before this");
    if (h && isNum(h.losses) && h.losses > 0) {
        lines.push('known or possible losses: ' + h.losses + ' recorded by the store'
            + ' (messages it saw and could not keep, or a time it was not capturing), so this history is partial');
    }
    lines.push('The history is handed over; whether Web has finished showing it cannot be seen from here. If Web stays on "Loading chats", run ' + K.status + '.');
    return lines;
}

const nothing = () => {};

// The readiness check, before anything else. A blocked link throws here,
// before a request is read or anything is approved.
async function checkReady(client) {
    const readiness = await client.getPrimaryLinkReadiness();
    const blockers = readiness && Array.isArray(readiness.blockers) ? readiness.blockers : [];
    if (!readiness || readiness.ready !== true) {
        if (!blockers.length) throw new Boom('the readiness check gave no verdict');
        const error = coded(blockers[0].code);
        error.blockers = blockers;
        error.readiness = readiness;
        throw error;
    }
    return readiness;
}

// What is about to go, and (only if the history is known to be partial) the
// person's yes. This comes after the request is chosen, so it is asked once,
// about one browser, which `ask` names: { question, invitationId?, companion? }.
// The question is the words; how to answer it is the front end's.
// Returns false when they said no.
async function agree(readiness, confirm, print, ask) {
    if (!readiness.needsConfirmation) {
        print(readinessSummary(readiness));
        return true;
    }
    for (const line of formatReadiness(readiness)) print(line);
    // No way to ask is not a yes.
    return typeof confirm === 'function' && !!(await confirm(readiness, ask));
}

function browserQuestion(invitationId, companion) {
    return 'approve the link with ' + (companion ? 'browser ' + companion : 'an unidentified browser')
        + ' (request ' + String(invitationId).slice(0, 8) + ') and send it this history?';
}

function announceApproval(approval, print) {
    if (approval && approval.status === 'linked') print('approved: the companion\'s proof was verified.');
    else print('approval sent. The binding to the browser stays unconfirmed unless you confirm it with ' + K.reconcile + ' (needs ' + PROOF + ').');
}

// The bootstrap after an approval. An approval that went through and a
// bootstrap that did not is the state Web hangs in, so a failure here says
// which it was and carries what was approved.
async function handOver(client, approval, invitationId, print) {
    print('sending the stored history to the companion...');
    try {
        return await client.bootstrapPrimaryCompanion({ history: 'store' });
    } catch (error) {
        if (object(error)) {
            try {
                error.afterApproval = true;
                if (invitationId !== undefined) error.invitationId = invitationId;
                if (approval && approval.operationId !== undefined) error.operationId = approval.operationId;
            } catch (_) { /* a frozen error still carries its code */ }
        }
        throw error;
    }
}

// /link-code CODE [n|id]   (n: a group number, id: 6 or more characters of a request id)
// In order: readiness, the choice of request, the person's yes when the history
// is partial, the approval, the bootstrap.
// -> { status: 'sent', invitationId, approval, bootstrap }
//  | { status: 'choose', groups }      several browsers, none chosen, nothing asked or approved
//  | { status: 'aborted' }             the history is partial and the person said no
// Throws with the library's own `.code`; a blocker throws with `.blockers`.
async function runLinkCode({ client, code, selector, confirm, print = nothing, now } = {}) {
    const say = typeof print === 'function' ? print : nothing;
    const readiness = await checkReady(client);

    // One reading of the clock for the whole choice, so what is listed is what can be picked.
    const at = clock(now);
    const list = await client.getPrimaryLinkInvitations();
    const choice = chooseInvitation(list, selector, at);
    const asked = selector !== undefined && selector !== null && String(selector).trim() !== '';
    if (choice.none) {
        if (!validList(list)) throw coded('PRIMARY_LINK_INVITATION_REQUIRED');
        // Requests there are, and every one has run out.
        if (!list.some(item => live(item, at))) throw coded('PRIMARY_LINK_INVITATION_EXPIRED');
        if (!asked) throw coded('PRIMARY_LINK_INVITATION_REQUIRED');
        const groups = groupInvitations(list, at);
        say('no pairing request matches "' + String(selector).trim() + '", so nothing was approved.');
        for (const line of formatInvitations(groups, at)) say(line);
        return { status: 'choose', groups };
    }
    if (choice.ambiguous) {
        say(asked ? 'that selector matches more than one request, so nothing was approved.'
            : 'more than one browser is asking to link, so nothing was approved. Choose the one this code belongs to.');
        for (const line of formatInvitations(choice.ambiguous, at)) say(line);
        return { status: 'choose', groups: choice.ambiguous };
    }

    const invitationId = choice.id;
    const chosen = list.find(item => validInvitation(item) && item.id === invitationId);
    const companion = chosen && typeof chosen.companion === 'string' && chosen.companion ? chosen.companion : null;
    if (!(await agree(readiness, confirm, say, { question: browserQuestion(invitationId, companion), invitationId, companion }))) {
        return { status: 'aborted' };
    }

    say('approving with the request ' + invitationId.slice(0, 12) + '...');
    const approval = await client.approveCompanionCode(code, { invitationId });
    announceApproval(approval, say);
    const bootstrap = await handOver(client, approval, invitationId, say);
    for (const line of formatBootstrapResult(bootstrap)) say(line);
    return { status: 'sent', invitationId, approval, bootstrap };
}

// /link-qr PAYLOAD
// -> { status: 'sent', approval, bootstrap } | { status: 'aborted' }
async function runLinkQr({ client, payload, options, confirm, print = nothing } = {}) {
    const say = typeof print === 'function' ? print : nothing;
    // A QR names its own browser, so there is no choice to make before asking.
    const readiness = await checkReady(client);
    const question = 'approve the link with the browser behind this QR and send it this history?';
    if (!(await agree(readiness, confirm, say, { question }))) return { status: 'aborted' };

    say('approving the QR...');
    const approval = await client.approveCompanionQr(payload, options);
    announceApproval(approval, say);
    const bootstrap = await handOver(client, approval, undefined, say);
    for (const line of formatBootstrapResult(bootstrap)) say(line);
    return { status: 'sent', approval, bootstrap };
}

// ─── /link-unlock ───────────────────────────────────────────────────────────

// Who a lock names, as far as it says: 'pid 4242 on old-box, since 2026-11-02
// 15:31'. An old-format lock has a pid at most, and its time is only when the
// file was written, so that is left out.
function holderName(holder) {
    const h = object(holder) || {};
    const who = [];
    if (isNum(h.pid)) who.push('pid ' + h.pid);
    if (typeof h.host === 'string' && h.host) who.push('on ' + h.host);
    const since = h.legacy ? null : stamp(h.at);
    return who.length ? who.join(' ') + (since ? ', since ' + since : '') : null;
}

// What breaking the lock would mean, before anyone is asked.
function formatLockHolder(holder) {
    const h = object(holder) || {};
    const name = holderName(h);
    const lines = [name
        ? 'the link journal is locked by ' + name + (h.legacy ? ' (an older lock format, which cannot be proven stale)' : '')
        : 'the link journal is locked by a process whose details cannot be read'];
    lines.push('  Break it only if that program is gone: stopped, or on a machine or in a container that no longer runs it.',
        '  A program that is in fact still running stops at its next write to the journal, which is left intact.');
    return lines;
}

// /link-unlock. Who holds the link journal, what breaking its lock means, and
// the person's yes; anything else is no, and so is having no way to ask. What
// is broken is the holder that was shown: one that has taken its place by
// then is refused by the library (PRIMARY_LINK_STORE_BUSY, with that holder),
// and the error goes to the caller.
// -> { status: 'none' }               nothing held, or gone by the time of the yes
//  | { status: 'kept', holder }       the answer was no
//  | { status: 'broken', holder }
async function runLinkUnlock({ client, confirm, print = nothing } = {}) {
    const say = typeof print === 'function' ? print : nothing;
    const { holder } = object(client.getPrimaryLinkLockHolder()) || {};
    if (!object(holder)) {
        say('no lock is held on the link journal; there is nothing to break');
        return { status: 'none' };
    }
    for (const line of formatLockHolder(holder)) say(line);
    const question = 'break the lock held by ' + (holderName(holder) || 'that process').replace(/, since .*$/, '') + '?';
    if (!(typeof confirm === 'function' && (await confirm(question)) === true)) {
        say('the lock was left as it is');
        return { status: 'kept', holder };
    }
    const broken = object((object(client.unlockPrimaryLink({ holder })) || {}).holder);
    if (!broken) {
        say('the lock was gone by then; there was nothing to break');
        return { status: 'none' };
    }
    say('broke the link journal lock' + (holderName(broken) ? ' held by ' + holderName(broken).replace(/, since .*$/, '') : ''));
    say('  next: retry the command that reported the journal busy');
    return { status: 'broken', holder: broken };
}

// ─── --unlock-message-store ─────────────────────────────────────────────────

// What breaking the message store's lock would mean, before anyone is asked.
function formatStoreLockHolder(holder, number) {
    const h = object(holder) || {};
    const name = holderName(h);
    return [name
        ? 'the message store of ' + number + ' is locked by ' + name + (h.legacy ? ' (an older lock format, which cannot be proven stale)' : '')
        : 'the message store of ' + number + ' is locked by a process whose details cannot be read',
    '  Break it only if no other wa is using this number: one that stopped, or ran on a machine or in a container that no longer runs it.',
    '  A wa that is in fact still running stops keeping messages at its next write; what it already kept stays in the store.'];
}

// --unlock-message-store, before a number's message store is opened: who
// holds its lock, what breaking it means, and the person's yes. Anything else
// is no. `confirm` null is a run that cannot ask at all (wa listen), which
// refuses and says where to break it instead. What is broken is the holder
// that was shown: one that has taken its place by then is refused by the
// library (PRIMARY_MESSAGE_STORE_BUSY, with that holder), and the error goes
// to the caller. `readHolder` and `breakLock(holder)` are
// PrimaryMessageStore's, bound to the number's folder.
// -> { status: 'none' }               nothing held, or gone by the time of the yes
//  | { status: 'kept', holder }       the answer was no
//  | { status: 'refused', holder }    no way to ask
//  | { status: 'broken', holder }
async function runMessageStoreUnlock({ phone, readHolder, breakLock, confirm, print = nothing } = {}) {
    const say = typeof print === 'function' ? print : nothing;
    const digits = String(phone === undefined || phone === null ? '' : phone).replace(/^\+/, '');
    const number = '+' + digits;
    const holder = object(readHolder());
    if (!holder) {
        say('the message store of ' + number + ' is not locked; there is nothing to break');
        return { status: 'none' };
    }
    for (const line of formatStoreLockHolder(holder, number)) say(line);
    if (typeof confirm !== 'function') {
        say('wa listen cannot ask, so the lock was left as it is. If no other wa is using this number, break it with wa connect '
            + digits + ' ' + UNLOCK_STORE + ' (it asks first), then start wa listen again.');
        return { status: 'refused', holder };
    }
    const question = 'break the lock held by ' + (holderName(holder) || 'that process').replace(/, since .*$/, '') + '?';
    if ((await confirm(question)) !== true) {
        say('the lock was left as it is');
        return { status: 'kept', holder };
    }
    const broken = object((object(breakLock(holder)) || {}).holder);
    if (!broken) {
        say('the lock was gone by then; there was nothing to break');
        return { status: 'none' };
    }
    say('broke the message store lock' + (holderName(broken) ? ' held by ' + holderName(broken).replace(/, since .*$/, '') : ''));
    return { status: 'broken', holder: broken };
}

// ─── /linked-devices and /link-status ───────────────────────────────────────

// Phases in which an approval went out, so the journal can speak for a device.
const SENT = new Set(['awaiting_confirmation', 'committed', 'uncertain']);

const PHASES = Object.freeze({
    idle: 'idle (no link in progress)',
    exchange: 'exchanging keys with the browser',
    finish_verified: 'browser verified, approval about to be sent',
    pair_device_sending: 'approval being sent, outcome not confirmed',
    awaiting_confirmation: 'approval sent, not confirmed with a companion proof',
    uncertain: 'approval sent, outcome unknown',
    verification_required: 'WhatsApp asked for extra verification',
    exchange_failed: 'stopped during the key exchange; nothing was approved',
    committed: 'linked and verified',
    abandoned: 'retired; nothing was linked'
});

// Whether the journal's latest link is the one that made this device. A
// device id (or key index) in the journal settles it; with neither, only a
// lone companion can be it. Several companions and nothing to tell them apart
// means none is claimed.
function isLinkOf(journal, device, companions) {
    if (!journal || !SENT.has(journal.phase)) return false;
    const named = isNum(journal.deviceId) ? journal.deviceId : isNum(journal.expectedDeviceId) ? journal.expectedDeviceId : null;
    if (named !== null) return device.deviceId === named;
    if (isNum(journal.keyIndex)) return device.keyIndex === journal.keyIndex;
    return companions === 1;
}

function historyColumn(journal, history) {
    const phase = journal.bootstrapPhase !== undefined ? journal.bootstrapPhase : object(journal.bootstrap) ? journal.bootstrap.phase : null;
    if (phase === null || phase === undefined) return 'history not sent';
    if (phase !== 'sent') return 'history stopped at ' + phase;
    // What the journal recorded at `sent`; else what the caller knows.
    const h = object(journal.delivered) || object(history), counts = [];
    if (h && isNum(h.chats)) counts.push(plural(h.chats, 'chat'));
    if (h && isNum(h.records)) counts.push(h.records + (h.records === 1 ? ' msg' : ' msgs'));
    return 'history delivered' + (counts.length ? ' (' + counts.join(', ') + ')' : '');
}

const idColumn = text => (text.length < 5 ? text.padEnd(5) : text + ' ');

// Spec 6.9. `journal` is getPrimaryLinkStatus(): how the companion was linked
// (`method`), when the approval went through (`linkedAt`, else the approval's
// start), which device it made (`deviceId`, else `expectedDeviceId`, else
// `keyIndex`), and what history it was handed (`delivered`). `history` is the
// counts a caller knows when the status does not carry them: { chats, records }.
// Binding says "confirmed" only when a companion proof was reconciled: the
// journal is committed and the device list agreed. Otherwise it is unconfirmed.
function formatLinkedDevices({ phone, devices, journal, history } = {}) {
    const j = object(journal);
    // Companions only: the primary is device 0 and has its own line.
    const list = (Array.isArray(devices) ? devices : []).filter(d => d && isNum(d.deviceId) && d.deviceId !== 0).sort((a, b) => a.deviceId - b.deviceId);
    const number = phone !== undefined && phone !== null && String(phone) ? '+' + String(phone).replace(/^\+/, '') : '';
    const lines = ['linked devices' + (number ? '  ' + number : ''), '  ' + idColumn('#0') + 'this phone (primary)'];
    if (!list.length) {
        lines.push('  no companion linked');
        return lines;
    }
    for (const device of list) {
        const mine = isLinkOf(j, device, list.length);
        const parts = ['companion'];
        if (isNum(device.keyIndex)) parts.push('key index ' + device.keyIndex);
        if (mine) {
            const when = stamp(isNum(j.linkedAt) ? j.linkedAt : j.startedAt), method = typeof j.method === 'string' && j.method ? j.method : null;
            if (when || method) parts.push('linked' + (when ? ' ' + when : '') + (method ? ' by ' + method : ''));
        }
        const confirmed = mine && j.confirmed === true && j.phase === 'committed';
        parts.push(confirmed ? 'binding confirmed'
            : mine && j.phase === 'committed' ? 'binding unconfirmed (a proof was reconciled, but the device list no longer agrees)'
                : 'binding unconfirmed');
        parts.push(mine ? historyColumn(j, history) : 'history unknown');
        lines.push('  ' + idColumn('#' + device.deviceId) + parts.join('   '));
    }
    return lines;
}

// getPrimaryLinkStatus() as lines: where the link is, whether its binding was
// ever confirmed, how far the bootstrap got, which companions are listed, and
// the way forward when something is unfinished.
function formatLinkStatus(status) {
    const s = object(status) || {};
    const phase = typeof s.phase === 'string' ? s.phase : 'idle';
    const row = (label, text) => label.padEnd(11) + text;
    const lines = [];
    const started = stamp(s.startedAt);
    lines.push(row('link', (PHASES[phase] || phase) + (started && phase !== 'idle' ? ', started ' + started : '')));
    // Committed means a companion proof was reconciled; confirmed also needs the device list to agree.
    const confirmed = s.confirmed === true && phase === 'committed';
    lines.push(row('binding', confirmed ? 'confirmed (the companion\'s proof was verified and the device list agrees)'
        : phase === 'committed' ? 'unconfirmed now (a companion proof was reconciled, but that device is no longer listed as it was)'
            : 'unconfirmed (no companion proof has been reconciled)'));

    const bootstrap = object(s.bootstrap);
    const bPhase = typeof s.bootstrapPhase === 'string' ? s.bootstrapPhase : bootstrap && typeof bootstrap.phase === 'string' ? bootstrap.phase : null;
    const errorCode = bootstrap && typeof bootstrap.errorCode === 'string' ? bootstrap.errorCode : null;
    lines.push(row('bootstrap', bPhase === null ? 'not started' : bPhase === 'sent' ? 'sent' : 'stopped at ' + bPhase + (errorCode ? ' (' + errorCode + ')' : '')));

    // The list always holds the primary, device 0; only the others are companions.
    const devices = (Array.isArray(s.devices) ? s.devices : []).filter(d => d && isNum(d.deviceId) && d.deviceId !== 0);
    lines.push(row('companions', devices.length ? devices.map(d => '#' + d.deviceId + (isNum(d.keyIndex) ? ' key index ' + d.keyIndex : '')).join(', ') : 'none'));

    const next = [], present = devices.length > 0;
    if (phase === 'awaiting_confirmation' || phase === 'uncertain' || phase === 'pair_device_sending') {
        next.push(present
            ? 'if you have ' + PROOF + ', run ' + K.reconcile + '; if the companion never appeared, ' + K.retire + ' works once the approval is ' + RETIRE_MINUTES + ' minutes old'
            : 'the companion has not appeared in the device list yet: check ' + K.devices + ' in a few seconds; if it never does, ' + K.retire + ' works once the approval is ' + RETIRE_MINUTES + ' minutes old');
    }
    if (phase === 'committed' && !present) next.push('the companion is no longer listed: check ' + K.devices);
    if (phase === 'verification_required') next.push(VERIFY_LATER);
    if (bPhase !== null && bPhase !== 'sent') {
        // An attempt that can never continue is started over; any other goes on from where it stopped.
        const resumable = bootstrap ? bootstrap.resumable : undefined;
        next.push(resumable === false ? REFUSED : errorCode ? explainError(errorCode, { bootstrapPhase: bPhase, resumable }, 'status').next : continueFrom(bPhase));
    }
    // Web waits on the history, but there is nothing to hand it to until the companion is on the list.
    if (bPhase === null && (phase === 'awaiting_confirmation' || phase === 'committed') && present) {
        next.push('the history has not been sent, so Web will sit on "Loading chats": run ' + K.bootstrap);
    }
    for (const text of next) lines.push(row('next', text));
    return lines;
}

// A 'primary_link_progress' event as one line. A history upload says how much
// is going up, since nothing else is said until it is done and that can take
// minutes; any other phase is the link's, as /link-status words it.
function formatLinkProgress(event) {
    const e = object(event) || {};
    if (e.phase === 'history_uploading') {
        const bytes = isNum(e.bytes) && e.bytes >= 0 ? size(e.bytes) : null;
        return 'uploading history' + (bytes ? ' (' + bytes + ')' : '') + '... this can take a few minutes';
    }
    return formatLinkStatus({ phase: e.phase })[0];
}

module.exports = {
    COMMANDS,
    groupInvitations,
    chooseInvitation,
    formatInvitations,
    formatInvitationNotice,
    explainError,
    explainBlocker,
    describeError,
    formatReadiness,
    formatBootstrapResult,
    formatLinkedDevices,
    formatLinkStatus,
    formatLinkProgress,
    runLinkCode,
    runLinkQr,
    runLinkUnlock,
    runMessageStoreUnlock,
    createEventLimiter,
    formatHeldBack
};
