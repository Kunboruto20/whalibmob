'use strict';
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

// The commands the messages send a person to. Kept in one place so that the
// text and the commands the CLI actually offers cannot drift apart.
const COMMANDS = Object.freeze({
    code: '/link-code',
    qr: '/link-qr',
    invitations: '/link-invitations',
    status: '/link-status',
    reconcile: '/link-reconcile',
    retire: '/link-retire',
    unlock: '/link-unlock',
    bootstrap: '/link-bootstrap',
    devices: '/linked-devices',
    connect: '/connect',
    reconnect: '/reconnect',
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
    const error = new Error(message || code);
    error.code = code;
    return error;
}

// ─── pairing requests ───────────────────────────────────────────────────────

const validInvitation = i => !!i && typeof i.id === 'string' && i.id.length > 0;

// Web sends the same request more than once from one browser, about 200 ms
// apart, and every tab adds its own. They share a fingerprint of the browser's
// noise key (`companion`), so they are grouped on it and each group is shown as
// one browser, with its newest request. The fingerprint is a 32-bit label, not
// proof of anything. An entry with no fingerprint (an old journal) is never
// grouped with another: nothing says they belong together.
function groupInvitations(invitations) {
    const groups = [], byCompanion = new Map();
    for (const item of Array.isArray(invitations) ? invitations : []) {
        if (!validInvitation(item)) continue;
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
// picks between browsers on its own.
function chooseInvitation(invitations, selector) {
    const list = (Array.isArray(invitations) ? invitations : []).filter(validInvitation);
    const groups = groupInvitations(list);
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

function formatInvitations(groups, now) {
    const list = Array.isArray(groups) ? groups : [];
    if (!list.length) {
        return ['no pairing request is waiting.',
            '  On WhatsApp Web choose "Link with phone number", enter this number, then run ' + K.invitations + ' again.'];
    }
    const at = clock(now);
    const lines = ['pairing requests waiting, newest first:'];
    list.forEach((group, index) => {
        const left = span(group.newest.expiresAt - at);
        lines.push('  ' + (index + 1) + '  browser ' + (group.companion || 'unidentified')
            + '   ' + plural(group.count, 'request')
            + '   newest ' + String(group.newest.id).slice(0, 12)
            + '   ' + (left === 'expired' ? 'expired' : 'expires in ' + left));
    });
    lines.push('  Requests with the same browser label come from one browser (Web sends each more than once).',
        '  The label is a short fingerprint, not proof of who is behind it.',
        '  Pick one with  ' + K.code + ' <code> <number>,  or close the other Web tabs and wait ' + REQUEST_MINUTES + ' minutes.');
    return lines;
}

// ─── error messages ─────────────────────────────────────────────────────────

const GIVE_UP_KEEP = 'Keep the session folder as it is and report the code shown.';
const RETRY_NEW_CODE = 'On WhatsApp Web choose "Link with phone number" again to get a new code, then run ' + K.code + ' <code>.';
const BOOTSTRAP_AGAIN = 'Run ' + K.status + ' for where it stopped, then continue with ' + K.bootstrap + '; if it is refused again, link again with a new code.';
const RESEND = 'Do not approve again. Run ' + K.bootstrap + ' --resend to send that step once more under the same message id.';
const DISK = 'Free disk space or fix permissions on the session folder, then ';
const QUERY_NEXT = 'Retry in a moment; if it repeats, keep the session folder as it is and report the code shown.';

// code -> [title, next]. One line each: what happened, then the step to take.
const MESSAGES = Object.freeze({
    // ── linking ──────────────────────────────────────────────────────────────
    'PRIMARY_LINK_ABORTED': ['The link was cancelled before it finished.',
        'Run ' + K.status + ' to see how far it got; start again with ' + K.code + ', or finish an approval that was sent with ' + K.reconcile + '.'],
    'PRIMARY_LINK_ACCOUNT_CHANGED': ['The account on this connection changed while linking, so the link was stopped.',
        'Run /disconnect, connect to the number again with ' + K.connect + ' <phone>, and start over.'],
    'PRIMARY_LINK_ACCOUNT_REQUIRED': ['This session has no registered phone number to link from.',
        'Connect a registered number first (' + K.connect + ' <phone>), then start again.'],
    'PRIMARY_LINK_ADV_MISMATCH': ["The device list on WhatsApp does not match the link state saved for this number, so nothing was changed.",
        'Run ' + K.devices + ' and ' + K.status + ' to compare them, and do not delete the link journal; this needs repair by hand.'],
    'PRIMARY_LINK_BUSY': ['Another link operation is already running in this program.',
        'Wait up to 90 seconds for it to finish, then retry; ' + K.unlock + ' cannot help while this program holds the journal.'],
    'PRIMARY_LINK_CODE_ALREADY_USED': ['That pairing code was already used for an earlier approval.', RETRY_NEW_CODE],
    'PRIMARY_LINK_CODE_INVALID': ['The pairing code is not a valid 8-character code.',
        'Copy it again exactly as Web shows it (8 letters and digits, never I, O, U or 0) and run ' + K.code + ' <code>.'],
    'PRIMARY_LINK_CONNECTION_CLOSED': ['The connection to WhatsApp closed while linking.',
        'Run ' + K.reconnect + ', then ' + K.status + ': if an approval was sent, finish it with ' + K.reconcile + '; otherwise start again with ' + K.code + '.'],
    'PRIMARY_LINK_CONNECTION_REQUIRED': ['This session is not connected to WhatsApp as a primary right now.',
        'Connect first (' + K.connect + ' <phone>), then retry.'],
    'PRIMARY_LINK_DEVICE_LIST_UNCONFIRMED': ["WhatsApp's device list did not show the new companion as expected.",
        'Wait a few seconds and run ' + K.reconcile + ' again; do not approve a second time.'],
    'PRIMARY_LINK_DEVICE_STILL_PRESENT': ["The new companion is still on WhatsApp's device list (or the list changed), so the unfinished link cannot be retired.",
        'Run ' + K.devices + ': if the companion is listed, finish with ' + K.reconcile + '; if not, try ' + K.retire + ' again in a minute.'],
    'PRIMARY_LINK_DEVICE_UNMATCHED': ['The proof is for a different device than the one WhatsApp reported for this approval.',
        'Do not approve again; copy the proof from the browser you approved and run ' + K.reconcile + ' with it, and check ' + K.devices + '.'],
    'PRIMARY_LINK_EXISTING_ADV_REQUIRED': ['This account already has companions but no saved link state for them, so a new link is refused.',
        'Run ' + K.devices + ' and keep the session folder as it is; this needs repair by hand, not another approval.'],
    'PRIMARY_LINK_EXISTING_DEVICE_CHANGED': ["A device linked before this approval has changed on WhatsApp's list.",
        'Run ' + K.devices + ' to see what changed, and do not approve again until the list is what you expect.'],
    'PRIMARY_LINK_FINISH_UNMATCHED': ["The browser's finishing step does not belong to this approval.",
        'Reload WhatsApp Web, ask for a new code with "Link with phone number", and run ' + K.code + ' again.'],
    'PRIMARY_LINK_INVALID': ['Something WhatsApp or the browser sent did not have the expected shape.',
        'Ask Web for a new code and run ' + K.code + ' again; if it repeats, report the code shown.'],
    'PRIMARY_LINK_INVITATION_AMBIGUOUS': ['More than one browser is asking to link, so none was chosen for you.',
        'Run ' + K.invitations + ', then ' + K.code + ' <code> <number> for the one showing your code; or close the other Web tabs and wait ' + REQUEST_MINUTES + ' minutes.'],
    'PRIMARY_LINK_INVITATION_EXPIRED': ['That pairing request has expired (they last about ' + REQUEST_MINUTES + ' minutes).',
        'On Web choose "Link with phone number" again for a fresh code, then run ' + K.code + ' straight away.'],
    'PRIMARY_LINK_INVITATION_REQUIRED': ['No pairing request from WhatsApp Web has reached this number, or the one named is unknown.',
        'On Web choose "Link with phone number" and enter this number, check ' + K.invitations + ', then run ' + K.code + ' <code>.'],
    'PRIMARY_LINK_INVITATION_TIMEOUT': ['No pairing request arrived in time.',
        'On Web choose "Link with phone number" and enter this number, then run ' + K.code + ' <code> straight away.'],
    'PRIMARY_LINK_INVITATION_UNMATCHED': ['The pairing request is not from the browser that was expected.',
        'Check ' + K.invitations + ' and use the request from the browser you mean.'],
    'PRIMARY_LINK_IQ_REJECTED': ['WhatsApp rejected the link request.',
        'Run ' + K.status + ' to see whether anything was sent, wait a minute, then try again with a new code.'],
    'PRIMARY_LINK_IQ_UNCONFIRMED': ["WhatsApp's answer could not be matched to the link request that was sent.",
        'Run ' + K.status + ': if an approval was sent, finish it with ' + K.reconcile + '; otherwise start again with ' + K.code + '.'],
    'PRIMARY_LINK_KEY_EXCHANGE_INVALID': ["The code did not unlock the browser's request: it was mistyped, or Web has shown a newer code since.",
        'Read the code Web shows now, run ' + K.invitations + ' to see which request is newest, and run ' + K.code + ' <code> again.'],
    'PRIMARY_LINK_NO_PENDING_COMMIT': ['There is no approval waiting to be confirmed.',
        'Run ' + K.status + ' to see the state of the link.'],
    'PRIMARY_LINK_NO_RETIRABLE_TRANSACTION': ['There is no unfinished approval that can be retired.',
        'Run ' + K.status + '; only an approval that was sent and never confirmed can be retired.'],
    'PRIMARY_LINK_NOTIFICATION_REJECTED': ['A link message from WhatsApp could not be processed.',
        'Ask Web for a new code and try again; if it repeats, run ' + K.status + ' and report the code shown.'],
    'PRIMARY_LINK_PRIMARY_REQUIRED': ['Only a number registered through this tool can approve companions, and this session is a companion.',
        'Connect the registered number instead: ' + K.connect + ' <phone> sms.'],
    'PRIMARY_LINK_PROTO_INVALID': ['The saved or received link state could not be decoded.', GIVE_UP_KEEP],
    'PRIMARY_LINK_QR_ALREADY_USED': ['That QR code was already used for an earlier approval.',
        'Reload the Web page so it shows a fresh QR, then run ' + K.qr + ' with the new one.'],
    'PRIMARY_LINK_QR_INVALID': ['That is not a WhatsApp Web link QR code (or it has expired).',
        'Copy the whole QR text or wa.me link again, from a fresh QR, and run ' + K.qr + ' <qr-payload-or-wa.me-url>.'],
    'PRIMARY_LINK_QUERY_ACCOUNT': ["WhatsApp's device list is for a different account than this one.", QUERY_NEXT],
    'PRIMARY_LINK_QUERY_DEVICE_TAG': ["WhatsApp's device list held an entry that is not a device.", QUERY_NEXT],
    'PRIMARY_LINK_QUERY_DEVICES': ["WhatsApp's device list was empty or longer than any account can have.", QUERY_NEXT],
    'PRIMARY_LINK_QUERY_KEY_INDEX': ["A companion on WhatsApp's device list has no usable key index.", QUERY_NEXT],
    'PRIMARY_LINK_QUERY_LIST': ["WhatsApp's device list reply did not hold exactly one list.", QUERY_NEXT],
    'PRIMARY_LINK_QUERY_SID': ["WhatsApp's device list reply answered a different request.", QUERY_NEXT],
    'PRIMARY_LINK_RECONCILIATION_REQUIRED': ['An earlier approval has not been finished, so a new one is refused.',
        'If the companion appeared, finish it with ' + K.reconcile + ' <proof>; if it never did, ' + K.retire + ' clears it once it is ' + RETIRE_MINUTES + ' minutes old.'],
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
        'Run ' + K.status + ': if an approval was sent, finish it with ' + K.reconcile + '; otherwise try again.'],
    'PRIMARY_LINK_TIMEOUT_INVALID': ['The time limit given for the link is outside 1 to 90 seconds.',
        'Use a limit from 1 to 90 seconds, or none.'],
    'PRIMARY_LINK_TIMESTAMP_INVALID': ["WhatsApp's requested timestamp is more than a day from this computer's clock.",
        'Set the system date and time correctly, then start again with a new code.'],
    'PRIMARY_LINK_TRANSACTION_CHANGED': ['The unfinished approval changed while it was being retired.',
        'Run ' + K.status + ' and, if it is still unfinished, run ' + K.retire + ' again.'],
    'PRIMARY_LINK_UNCONFIRMED': ['The result of the link could not be confirmed.',
        'Do not approve again. Run ' + K.devices + ' and ' + K.status + ': if the companion is listed, finish with ' + K.reconcile + '; otherwise wait ' + RETIRE_MINUTES + ' minutes and use ' + K.retire + '.'],
    'PRIMARY_LINK_VERIFICATION_REQUIRED': ['WhatsApp wants extra verification before it will let another device link.',
        'Nothing was linked, and this tool cannot answer that check. Wait a while, run ' + K.status + ', and try again later.'],
    'PRIMARY_LINK_WAIT_INVALID': ['The wait for a pairing request is outside 0 to 90 seconds.',
        'Use a wait from 0 to 90 seconds.'],
    'PRIMARY_LINK_WEB_PROOF_INVALID': ['That is not a WhatsApp Web public binding proof.',
        'Copy the whole proof again, exactly as the page gives it, and run ' + K.reconcile + ' with it.'],

    // ── the bootstrap: key share, app-state patch, history ───────────────────
    'PRIMARY_BOOTSTRAP_ACK_': ['WhatsApp refused a bootstrap message with an error number.', BOOTSTRAP_AGAIN],
    'PRIMARY_BOOTSTRAP_ACK_REJECTED': ["The companion's device did not accept a bootstrap message.", BOOTSTRAP_AGAIN],
    'PRIMARY_BOOTSTRAP_ACK_UNCERTAIN': ['No reply came for a bootstrap message within 15 seconds, so it is not known whether the companion got it.',
        'Wait a minute. ' + RESEND],
    'PRIMARY_BOOTSTRAP_ALREADY_ATTEMPTED': ['A bootstrap was already tried for this link and will not be started a second time.',
        'Run ' + K.status + ': if it stopped part-way, continue it with ' + K.bootstrap + '; if it says sent, the history was already delivered.'],
    'PRIMARY_BOOTSTRAP_AUTHORIZED_LINK_REQUIRED': ['There is no approved companion to bootstrap.',
        'Approve one first with ' + K.code + ' or ' + K.qr + ' (' + K.status + ' shows the state).'],
    'PRIMARY_BOOTSTRAP_DEVICE_UNCONFIRMED': ["WhatsApp's device list does not show exactly one new companion yet.",
        'Wait a few seconds and run ' + K.bootstrap + ' again; if it never appears, check ' + K.devices + '.'],
    'PRIMARY_BOOTSTRAP_EXISTING_COMPANIONS_UNSUPPORTED': ['This account already has another companion, and history can only be handed to the first and only one.',
        'Unlink the other companions (' + K.devices + ' lists them), then link again.'],
    'PRIMARY_BOOTSTRAP_EXISTING_HISTORY': ['This session already holds history files that the bootstrap will not write over.',
        'Move the .history.json and .messages.json files out of the session folder (keep a copy), then retry.'],
    'PRIMARY_BOOTSTRAP_EXISTING_KEYS': ['The app-state key file in this session was not made by this tool, or cannot be trusted.',
        'Do not delete or edit it. ' + GIVE_UP_KEEP],
    'PRIMARY_BOOTSTRAP_EXISTING_SESSION': ['An encrypted session with the new companion already exists, and the bootstrap will not replace it.',
        'If an earlier bootstrap for it stopped part-way, continue with ' + K.bootstrap + '; otherwise ' + GIVE_UP_KEEP.toLowerCase()],
    'PRIMARY_BOOTSTRAP_EXISTING_STATE': ['This number already has app-state data that a first bootstrap would write over.', GIVE_UP_KEEP],
    'PRIMARY_BOOTSTRAP_FOREIGN_STATE': ['The app-state on WhatsApp or on disk was not written by this tool, so the bootstrap will not touch it.',
        'Run ' + K.status + ' and do not retry blindly. ' + GIVE_UP_KEEP],
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
    'PRIMARY_BOOTSTRAP_PATCH_REJECTED': ['WhatsApp rejected the app-state write the bootstrap makes (the profile name).',
        'Run ' + K.status + ' for the details, then ' + K.bootstrap + ' once; if it is rejected again, report the code shown.'],
    'PRIMARY_BOOTSTRAP_PEER_UNMATCHED': ["The companion's key on WhatsApp is not the one that was approved.",
        'Stop: it may be a different device. Run ' + K.devices + ', unlink any you do not recognise, and link again.'],
    'PRIMARY_BOOTSTRAP_PERSISTENCE_REQUIRED': ['The app-state version could not be saved to disk.', DISK + 'run ' + K.bootstrap + '.'],
    'PRIMARY_BOOTSTRAP_SERVER_STATE_REQUIRED': ["WhatsApp's app-state for this number is not empty, which a first bootstrap needs.", GIVE_UP_KEEP],
    'PRIMARY_BOOTSTRAP_UPLOAD_INVALID': ['The upload of the history did not match what was saved to send.',
        'Run ' + K.bootstrap + ' to send it again from the saved copy.'],
    'PRIMARY_BOOTSTRAP_UPLOAD_REQUIRED': ['A large history needs an upload step, and none was available.',
        'Run ' + K.bootstrap + '; this tool supplies the upload itself. If it repeats, report the code shown.'],

    // ── the primary message store ────────────────────────────────────────────
    'PRIMARY_MESSAGE_STORE_DISABLED': ['The message store is off, so there is no history to hand the companion.',
        'Start wa with the message store on and connect again; it keeps messages only from then on, so earlier ones stay missing.'],
    'PRIMARY_MESSAGE_STORE_FAILED': ['The message store failed for a reason it could not name.',
        'Check free disk space and permissions on the session folder, then run ' + K.reconnect + '.'],
    'PRIMARY_MESSAGE_STORE_BUSY': ['Another message store in this program already has these session files open.',
        'Close the other connection that uses this number, then run ' + K.reconnect + '.'],
    'PRIMARY_MESSAGE_STORE_CLOCK_INVALID': ["The computer's clock gave a time the message store cannot use.",
        'Set the system date and time correctly, then run ' + K.reconnect + '.'],
    'PRIMARY_MESSAGE_STORE_CLOSED': ['The message store was closed, usually because the connection was.',
        'Run ' + K.reconnect + ', then try again.'],
    'PRIMARY_MESSAGE_STORE_INPUT_INVALID': ['The message store was handed a message it could not record.',
        'Retry once; if it repeats, report the code shown.'],
    'PRIMARY_MESSAGE_STORE_LOG_CORRUPT': ['The message log on disk is damaged, so the store cannot be opened.',
        'Back up the session folder and report the code shown; do not delete the log files.'],
    'PRIMARY_MESSAGE_STORE_OPTIONS_INVALID': ['The message store was opened with settings it does not accept.',
        'Fix the messageStore option (perChat and maxMessages are whole numbers) and connect again.'],
    'PRIMARY_MESSAGE_STORE_SNAPSHOT_CORRUPT': ['The saved message store snapshot is damaged.',
        'Back up the session folder and report the code shown; do not delete the snapshot.'],
    'PRIMARY_MESSAGE_STORE_WRITE_FAILED': ['The message store could not write to disk.', DISK + 'run ' + K.reconnect + '.'],

    // ── the history encoder ──────────────────────────────────────────────────
    'PRIMARY_HISTORY_EXPORT_CUTOFF_INVALID': ['The cut-off point for the newer-messages step was not valid.',
        'Run ' + K.bootstrap + ' again; if it repeats, report the code shown.'],
    'PRIMARY_HISTORY_EXPORT_INLINE_TOO_LARGE': ['The history was too large to send inside the message.',
        'Run ' + K.bootstrap + ' again; a large history is sent as an upload instead.'],
    'PRIMARY_HISTORY_EXPORT_OPTIONS_INVALID': ['The history encoder was given settings it does not accept.',
        'This is a mistake in the calling program; report the code shown.'],
    'PRIMARY_HISTORY_EXPORT_PAYLOAD_INVALID': ['The history message to send was malformed.',
        'Run ' + K.bootstrap + ' again; if it repeats, report the code shown.'],
    'PRIMARY_HISTORY_EXPORT_SNAPSHOT_INVALID': ['The message store handed over a snapshot the history encoder cannot use.',
        'Nothing was sent. Back up the session folder and report the code shown.']
});

const GENERIC_TITLE = 'The link stopped for a reason this command does not recognise.';

function genericNext(code) {
    const named = typeof code === 'string' && code ? ' The code is ' + code + '.' : ' Report the error text as it was shown.';
    return 'Run ' + K.status + ' to see where it stopped, and do not approve again until it says nothing is pending.' + named;
}

function holderTitle(holder) {
    const who = [];
    if (isNum(holder.pid)) who.push('pid ' + holder.pid);
    if (typeof holder.host === 'string' && holder.host) who.push('on ' + holder.host);
    const since = stamp(holder.at);
    const where = who.length ? ' (' + who.join(' ') + (since && !holder.legacy ? ', since ' + since : '') + ')' : '';
    if (holder.mutex) return 'A takeover of the link journal\'s lock is in progress' + where + ', or died part-way.';
    return who.length ? 'Another process' + where + ' holds the link journal for this number.'
        : 'Another process holds the link journal for this number, and its details cannot be read.';
}

// code -> { title, next }. `error` is optional: for a busy journal its `holder`
// says who has it, and whether what stands in the way is a takeover in
// progress rather than the lock itself.
function explainError(code, error) {
    const text = typeof code === 'string' ? code : '';
    let entry = Object.prototype.hasOwnProperty.call(MESSAGES, text) ? MESSAGES[text] : null;
    if (!entry) {
        const ack = /^PRIMARY_BOOTSTRAP_ACK_(\d{3})$/.exec(text);
        if (ack) entry = ['WhatsApp refused a bootstrap message with error ' + ack[1] + '.', BOOTSTRAP_AGAIN];
    }
    if (!entry) return { title: GENERIC_TITLE, next: genericNext(text) };
    let [title, next] = entry;
    const holder = text === 'PRIMARY_LINK_STORE_BUSY' && error ? object(error.holder) : null;
    if (holder) {
        title = holderTitle(holder);
        next = holder.mutex
            ? 'Wait a minute for it to finish, then run ' + K.unlock + ' again.'
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
                    ? 'It is old enough to retire: run ' + K.retire + ' (or ' + K.reconcile + ' <proof> if the companion did appear).'
                    : 'If the companion appeared, finish it with ' + K.reconcile + ' <proof>; if not, ' + K.retire + ' works once it is ' + RETIRE_MINUTES + ' minutes old.'
            };
        }
        case 'PRIMARY_BOOTSTRAP_EXISTING_COMPANIONS_UNSUPPORTED': {
            const n = detail.companions;
            return {
                title: (isNum(n) ? plural(n, 'companion') + ' already linked' : 'Companions are already linked')
                    + ', and history can only be handed to the first and only one.',
                next: 'Unlink the other companions (' + K.devices + ' lists them), then link again.'
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
                return {
                    title: 'The message store could not be read' + (typeof detail.code === 'string' ? ' (' + detail.code.replace(/^PRIMARY_MESSAGE_STORE_/, '').toLowerCase().replace(/_/g, ' ') + ')' : '') + ', so there is no history to hand over.',
                    next: 'Back up the session folder and report the code shown by ' + K.status + '; do not delete the store files.'
                };
            }
            break;
        default:
    }
    return explainError(b.code);
}

// An error caught from any of the calls below, as lines to print: what
// happened, the step to take, and the stable code so it can be reported.
function describeError(error) {
    const e = object(error);
    const code = e && typeof e.code === 'string' && e.code.startsWith('PRIMARY_') ? e.code : null;
    const lines = [];
    if (!code) {
        lines.push(e && e.message !== undefined ? String(e.message) : String(error));
    } else {
        const blockers = Array.isArray(e.blockers) ? e.blockers : [];
        const info = blockers.length && blockers[0] && blockers[0].code === code ? explainBlocker(blockers[0]) : explainError(code, e);
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
        lines.push('The approval was already sent, so do not approve again; only the history handover still needs finishing (' + K.bootstrap + ').');
    }
    return lines;
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
    const from = isNum(r.from) ? stamp(r.from * 1000) : null, to = isNum(r.to) ? stamp(r.to * 1000) : null;
    const evicted = isNum(r.evicted) ? r.evicted : 0;
    const range = from && to ? from + ' to ' + to : 'no messages kept';
    const dropped = evicted > 0
        ? plural(evicted, 'older message') + (evicted === 1 ? ' was' : ' were') + " dropped to stay within the store's limits"
        : 'nothing older was dropped';
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
    if (typeof r.captureOrigin === 'string') lines.push('capture period: ' + captureText({ origin: r.captureOrigin }));
    if (isNum(r.evicted) && r.evicted > 0) lines.push(plural(r.evicted, 'older message') + ' had' + " been dropped from the store before this");
    const losses = describeLosses(r.losses);
    if (losses.length) lines.push('known or possible losses: ' + losses.join('; '));
    lines.push('The history is handed over; whether Web has finished showing it cannot be seen from here. If Web stays on "Loading chats", run ' + K.status + '.');
    return lines;
}

const nothing = () => {};

// Readiness first, then (only if the history is known to be partial) the
// person's yes. Returns the readiness, or null when they said no. A blocked
// link throws before anything is approved.
async function prepare(client, confirm, print) {
    const readiness = await client.getPrimaryLinkReadiness();
    const blockers = readiness && Array.isArray(readiness.blockers) ? readiness.blockers : [];
    if (!readiness || readiness.ready !== true) {
        if (!blockers.length) throw new Error('the readiness check gave no verdict');
        const error = coded(blockers[0].code);
        error.blockers = blockers;
        error.readiness = readiness;
        throw error;
    }
    if (readiness.needsConfirmation) {
        for (const line of formatReadiness(readiness)) print(line);
        // No way to ask is not a yes.
        if (typeof confirm !== 'function' || !(await confirm(readiness))) return null;
    } else {
        print(readinessSummary(readiness));
    }
    return readiness;
}

function announceApproval(approval, print) {
    if (approval && approval.status === 'linked') print('approved: the companion\'s proof was verified.');
    else print('approval sent. The binding to the browser is unconfirmed until its proof is reconciled with ' + K.reconcile + '.');
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

// /link-code <code> [number | id-prefix]
// -> { status: 'sent', invitationId, approval, bootstrap }
//  | { status: 'choose', groups }      several browsers, none chosen, nothing approved
//  | { status: 'aborted' }             the history is partial and the person said no
// Throws with the library's own `.code`; a blocker throws with `.blockers`.
async function runLinkCode({ client, code, selector, confirm, print = nothing, now } = {}) {
    const say = typeof print === 'function' ? print : nothing;
    if (!(await prepare(client, confirm, say))) return { status: 'aborted' };

    const list = await client.getPrimaryLinkInvitations();
    const choice = chooseInvitation(list, selector);
    const asked = selector !== undefined && selector !== null && String(selector).trim() !== '';
    if (choice.none) {
        if (!(asked && validList(list))) throw coded('PRIMARY_LINK_INVITATION_REQUIRED');
        const groups = groupInvitations(list);
        say('no pairing request matches "' + String(selector).trim() + '", so nothing was approved.');
        for (const line of formatInvitations(groups, now)) say(line);
        return { status: 'choose', groups };
    }
    if (choice.ambiguous) {
        say(asked ? 'that selector matches more than one request, so nothing was approved.'
            : 'more than one browser is asking to link, so nothing was approved. Choose the one this code belongs to.');
        for (const line of formatInvitations(choice.ambiguous, now)) say(line);
        return { status: 'choose', groups: choice.ambiguous };
    }

    const invitationId = choice.id;
    say('approving with the request ' + invitationId.slice(0, 12) + '...');
    const approval = await client.approveCompanionCode(code, { invitationId });
    announceApproval(approval, say);
    const bootstrap = await handOver(client, approval, invitationId, say);
    for (const line of formatBootstrapResult(bootstrap)) say(line);
    return { status: 'sent', invitationId, approval, bootstrap };
}

const validList = list => Array.isArray(list) && list.some(validInvitation);

// /link-qr <payload>
// -> { status: 'sent', approval, bootstrap } | { status: 'aborted' }
async function runLinkQr({ client, payload, options, confirm, print = nothing } = {}) {
    const say = typeof print === 'function' ? print : nothing;
    if (!(await prepare(client, confirm, say))) return { status: 'aborted' };

    say('approving the QR...');
    const approval = await client.approveCompanionQr(payload, options);
    announceApproval(approval, say);
    const bootstrap = await handOver(client, approval, undefined, say);
    for (const line of formatBootstrapResult(bootstrap)) say(line);
    return { status: 'sent', approval, bootstrap };
}

// ─── /linked-devices and /link-status ───────────────────────────────────────

// Phases in which an approval went out, so the journal can speak for a device.
const SENT = new Set(['awaiting_confirmation', 'committed', 'uncertain']);

const PHASES = Object.freeze({
    idle: 'idle (no link in progress)',
    exchange: 'exchanging keys with the browser',
    finish_verified: 'browser verified, approval about to be sent',
    pair_device_sending: 'approval being sent, outcome not confirmed',
    awaiting_confirmation: "approval sent, waiting for the browser's proof",
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
    const h = object(history), counts = [];
    if (h && isNum(h.chats)) counts.push(plural(h.chats, 'chat'));
    if (h && isNum(h.records)) counts.push(h.records + (h.records === 1 ? ' msg' : ' msgs'));
    return 'history delivered' + (counts.length ? ' (' + counts.join(', ') + ')' : '');
}

const idColumn = text => (text.length < 5 ? text.padEnd(5) : text + ' ');

// Spec 6.9. `journal` is getPrimaryLinkStatus() (it may also carry `method`,
// and `deviceId` or `keyIndex`, when the caller knows them). `history` is what
// the bootstrap reported it handed over: { chats, records }.
// Binding says "confirmed" only when a companion proof was reconciled: the
// journal is committed and the device list agreed. Otherwise it is unconfirmed.
function formatLinkedDevices({ phone, devices, journal, history, now } = {}) {
    const j = object(journal);
    const list = (Array.isArray(devices) ? devices : []).filter(d => d && isNum(d.deviceId)).sort((a, b) => a.deviceId - b.deviceId);
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
            const when = stamp(j.startedAt), method = typeof j.method === 'string' && j.method ? j.method : null;
            if (when || method) parts.push('linked' + (when ? ' ' + when : '') + (method ? ' by ' + method : ''));
        }
        parts.push(mine && j.confirmed === true && j.phase === 'committed' ? 'binding confirmed' : 'binding unconfirmed');
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
    const confirmed = s.confirmed === true && phase === 'committed';
    lines.push(row('binding', confirmed ? 'confirmed (the companion\'s proof was verified and the device list agrees)'
        : 'unconfirmed (no companion proof has been reconciled)'));

    const bootstrap = object(s.bootstrap);
    const bPhase = typeof s.bootstrapPhase === 'string' ? s.bootstrapPhase : bootstrap && typeof bootstrap.phase === 'string' ? bootstrap.phase : null;
    const errorCode = bootstrap && typeof bootstrap.errorCode === 'string' ? bootstrap.errorCode : null;
    lines.push(row('bootstrap', bPhase === null ? 'not started' : bPhase === 'sent' ? 'sent' : 'stopped at ' + bPhase + (errorCode ? ' (' + errorCode + ')' : '')));

    const devices = (Array.isArray(s.devices) ? s.devices : []).filter(d => d && isNum(d.deviceId));
    lines.push(row('companions', devices.length ? devices.map(d => '#' + d.deviceId + (isNum(d.keyIndex) ? ' key index ' + d.keyIndex : '')).join(', ') : 'none'));

    const next = [];
    if (phase === 'awaiting_confirmation' || phase === 'uncertain' || phase === 'pair_device_sending') {
        next.push('when Web shows its proof, run ' + K.reconcile + ' <proof>; if the companion never appeared, ' + K.retire + ' works once the approval is ' + RETIRE_MINUTES + ' minutes old');
    }
    if (phase === 'verification_required') next.push(explainError('PRIMARY_LINK_VERIFICATION_REQUIRED').next);
    if (bPhase !== null && bPhase !== 'sent') next.push(errorCode ? explainError(errorCode).next : 'continue the history handover with ' + K.bootstrap);
    if (bPhase === null && (phase === 'awaiting_confirmation' || phase === 'committed') && devices.length) {
        next.push('the history has not been sent, so Web will sit on "Loading chats": run ' + K.bootstrap);
    }
    for (const text of next) lines.push(row('next', text));
    return lines;
}

module.exports = {
    COMMANDS,
    groupInvitations,
    chooseInvitation,
    formatInvitations,
    explainError,
    explainBlocker,
    describeError,
    formatReadiness,
    formatBootstrapResult,
    formatLinkedDevices,
    formatLinkStatus,
    runLinkCode,
    runLinkQr
};
