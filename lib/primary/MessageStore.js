'use strict';
// What this account, acting as the primary device, has sent and received —
// kept so that a newly linked companion can be handed the chat history the
// official phone would hand it.
//
// Two files in the session directory, both 0600:
//   <phone>.primary-messages.log   one JSON event per line, appended as it happens
//   <phone>.primary-messages.json  the whole state as of the event `seq` it names
// Every change is an event with a strictly increasing seq, applied by one
// function both live and on replay. Opening loads the snapshot and replays
// only the events after its seq, so a crash anywhere — mid-append, or between
// the snapshot rename and the log truncation — applies nothing twice.
//
// Beside them:
//   <phone>.primary-messages.write-failed  empty; there while a refused write
//                                          is not yet written down as a loss,
//                                          its mtime the window's start. It is
//                                          the store's, and moves with a session.
//   <phone>.primary-messages.lock          the process that has the store open.
//                                          Never moved (not in SessionPaths).
//
// The store would rather say it missed something than pretend it did not. A
// message seen but never stored, one that could not be decrypted, logins the
// store was not open for, a counter that started over, and the time the disk
// refused to write all end up in `losses`. Revoked, expired and view-once
// content is dropped the moment it is known, never handed out, and taken off
// the disk at the next turn of the event loop.
const { Boom } = require('@hapi/boom');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { lockFile: Lock, heldByThisProcess } = require('../PrimaryLinkStore');

const STATUS = Object.freeze({ ERROR: 0, PENDING: 1, SERVER_ACK: 2, DELIVERY_ACK: 3, READ: 4, PLAYED: 5 });
const TOMBSTONES = ['revoked', 'expired', 'view-once'];
const KINDS = ['content', 'protocol', 'skip'];
const META = ['name', 'pnJid', 'lidJid', 'ephemeral'];
const EVENTS = ['open', 'login', 'inflight', 'fail', 'resolve', 'put', 'edit', 'tomb', 'expire', 'drop', 'status', 'read', 'meta', 'gap'];
// A compaction rewrites the whole snapshot. It waits until the log has grown
// by about as much as that snapshot holds, and never less than these, so a
// large store is not rewritten every megabyte (amortised, each byte appended
// costs at most one more written).
const COMPACT_BYTES = 1024 * 1024, COMPACT_LINES = 5000;
function thresholds(snapBytes, bytes = 0, lines = 0) {
    const scale = Math.max(1, snapBytes / COMPACT_BYTES);
    return { bytes: bytes + Math.ceil(COMPACT_BYTES * scale), lines: lines + Math.ceil(COMPACT_LINES * scale) };
}
// Expired content is swept this often by the store's own clock, with no one
// asking for a snapshot; open and snapshot() sweep as well.
const SWEEP_EVERY = 3600 * 1000;
const CORRUPT = ['PRIMARY_MESSAGE_STORE_LOG_CORRUPT', 'PRIMARY_MESSAGE_STORE_SNAPSHOT_CORRUPT'];
// Revoked ids, by chat: a revoke whose target had not come yet, and every
// record ever revoked, which eviction or drop may later forget. A redelivery
// of one is stored as a tombstone and its bytes never reach the disk. Only
// revokes take a place: view-once comes back without content anyway and
// expiry is swept again. Bounded: an id coming back thousands of revokes
// later is not a real case.
const REVOKED_IDS = 5000;
// Ids that arrived and were dealt with without being stored — a reaction, a
// revoke, an edit. The server may deliver one again, and that copy may fail to
// decrypt (its ratchet step is spent); it is not a message that went missing.
// Bounded the same way, for the same reason.
const SETTLED_IDS = 5000;
const VERSION = 1;
// Two stores over one pair of files would each compact their own memory over
// the other's, and one of them would silently lose. Refused within a process
// by this set, and across processes by the lock file.
const OPEN = new Set();
// Statuses only rise, except that a send the server rejected may go from
// PENDING to ERROR; a real ack after that still raises it.
const rises = (from, to) => to > from || (to === STATUS.ERROR && from === STATUS.PENDING);
const isGroup = jid => jid.endsWith('@g.us');

function failure(code, detail, cause) {
    const full = 'PRIMARY_MESSAGE_STORE_' + code;
    const error = new Boom(detail ? full + ': ' + detail : full);
    // Boom takes no `cause`; set it the way Error's own option does.
    if (cause) {
        Object.defineProperty(error, 'cause',
            { value: cause, writable: true, configurable: true, enumerable: false });
    }
    error.code = full;
    return error;
}
function requireValue(ok, code, detail) { if (!ok) throw failure(code, detail); }
const isStr = v => typeof v === 'string' && v.length > 0;
const isTs = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const optStr = v => v === undefined || v === null || typeof v === 'string';
const b64 = buf => buf.toString('base64');
const unb64 = s => Buffer.from(s, 'base64');

// Ties keep arrival order: a new record goes after every record with its ts.
function upperBound(records, ts) {
    let lo = 0, hi = records.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (records[mid].ts <= ts) lo = mid + 1; else hi = mid; }
    return lo;
}

// A min-heap of [conversationTimestamp, chat id], so eviction can find the
// least-recent chat without walking all of them. Entries go stale when a chat
// moves on; they are skipped when they surface. Ties break on the chat id so
// a replay evicts exactly what the live run did.
const before = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
function heapPush(h, e) {
    h.push(e);
    for (let i = h.length - 1; i > 0;) {
        const p = (i - 1) >> 1;
        if (!before(h[i], h[p])) break;
        [h[i], h[p]] = [h[p], h[i]]; i = p;
    }
}
function heapPop(h) {
    const last = h.pop();
    if (!h.length) return;
    h[0] = last;
    for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < h.length && before(h[l], h[m])) m = l;
        if (r < h.length && before(h[r], h[m])) m = r;
        if (m === i) return;
        [h[i], h[m]] = [h[m], h[i]]; i = m;
    }
}

// Mirrors createPrivate in PrimaryBootstrap: the old snapshot stays whole
// until the new one is complete, synced and renamed over it.
function writePrivateAtomic(file, text) {
    const tmp = file + '.tmp-' + crypto.randomBytes(8).toString('hex');
    const c = fs.constants;
    try {
        const fd = fs.openSync(tmp, c.O_WRONLY | c.O_CREAT | c.O_EXCL | (c.O_NOFOLLOW || 0), 0o600);
        try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, text); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
        fs.renameSync(tmp, file);
    } catch (e) { try { fs.unlinkSync(tmp); } catch (_) {} throw e; }
    const dir = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}

function validEvent(ev) {
    return !!ev && typeof ev === 'object' && Number.isSafeInteger(ev.seq) && ev.seq > 0 && EVENTS.includes(ev.t) && isTs(ev.at);
}

// ─── who has the store open ──────────────────────────────────────────────────
//
// <phone>.primary-messages.lock, with the link journal's semantics and code
// (PrimaryLinkStore): it names its holder by pid, host, boot, process start
// and pid namespace, and is taken over only from a holder provably dead.
// Anything else — a holder alive, paused, on another host or in another
// container — is BUSY, with err.holder saying who, until an operator breaks
// it (breakLock). A store whose lock was broken stops at its next write
// (_fence): PRIMARY_MESSAGE_STORE_LOST, and it writes nothing more.

function busy(holder, detail, cause) {
    const error = failure('BUSY', detail, cause);
    error.holder = holder || null;
    return error;
}

// `base` is <dir>/<phone>.primary-messages; the lock is base + '.lock'. The
// lock comes back with the file it is (ino, dev), for the fence to compare.
function takeLock(base) {
    const lockPath = base + '.lock', token = crypto.randomBytes(16).toString('hex');
    const held = fd => { const info = fs.fstatSync(fd); return { fd, path: lockPath, ino: info.ino, dev: info.dev }; };
    for (let attempt = 0; attempt < 3; attempt++) {
        let fd = null;
        try { fd = fs.openSync(lockPath, 'wx', 0o600); }
        catch (e) { if (e.code !== 'EEXIST') throw e; }
        if (fd !== null) {
            try { Lock.writeLease(fd, token, 1); return held(fd); }
            catch (e) { Lock.unlinkOwn(lockPath, fd); fs.closeSync(fd); throw failure('WRITE_FAILED', lockPath, e); }
        }
        let seen;
        try { seen = Lock.inspect(lockPath); } catch (e) { throw busy(null, lockPath, e); }
        if (!seen) continue;   // released between the two looks
        if (!Lock.provablyDead(seen.holder)) throw busy(seen.holder, lockPath);
        let taken;
        try { taken = Lock.takeOver(base, token, seen, false, null); }
        catch (e) { throw busy(e.holder !== undefined ? e.holder : seen.holder, lockPath, e); }
        if (taken) return { fd: taken.fd, path: lockPath, ino: taken.info.ino, dev: taken.info.dev };
    }
    throw busy(Lock.holderNow(lockPath), lockPath);
}

// Where a store's files are, and the key that names it within this process.
// The key is null when the directory is not there: nothing can be held in it.
function locate(dir, phone) {
    requireValue(isStr(dir), 'OPTIONS_INVALID', 'dir');
    requireValue(typeof phone === 'string' && /^\d{1,32}$/.test(phone), 'OPTIONS_INVALID', 'phone');
    const base = path.join(dir, phone + '.primary-messages');
    let key = null;
    // .native: the JS realpath keeps the caller's letter case, and on a
    // case-insensitive disk two spellings would be two keys for one file.
    try { key = path.join(fs.realpathSync.native(dir), phone); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    return { base, lockPath: base + '.lock', key };
}

// The one lock nothing here reads out or breaks: this process's own, whether
// through a store open in it (OPEN) or one whose lock names this very process.
function refuseOwn(key, holder, lockPath) {
    if ((key !== null && OPEN.has(key)) || heldByThisProcess(holder)) throw busy(holder, lockPath + ': held by this process');
}

// Only while the name is still the file this lock holds open: someone else's
// lock in its place is left be.
function releaseLock(lock) {
    if (!lock) return;
    Lock.unlinkOwn(lock.path, lock.fd);
    try { fs.closeSync(lock.fd); } catch (_) {}
}

const exists = file => { try { fs.lstatSync(file); return true; } catch (_) { return false; } };

// setAsideCorrupt: a store that cannot be read is renamed aside, every file of
// it or none, under one stamp of when; never deleted.
function setCorruptAside(files, at) {
    requireValue(isTs(at), 'CLOCK_INVALID');
    const suffix = '.corrupt-' + new Date(at).toISOString().replace(/[:.]/g, '-');
    const moved = [];
    try {
        for (const file of files.filter(exists)) {
            if (exists(file + suffix)) throw new Boom(file + suffix + ' already exists', { statusCode: 409 });
            fs.renameSync(file, file + suffix);
            moved.push(file);
        }
    } catch (e) {
        for (const file of moved.reverse()) { try { fs.renameSync(file + suffix, file); } catch (_) {} }
        throw e;
    }
    return moved.map(file => file + suffix).sort();
}

class PrimaryMessageStore {
    constructor(dir, phone, now) {
        this._now = now;
        this._logFile = path.join(dir, phone + '.primary-messages.log');
        this._snapFile = path.join(dir, phone + '.primary-messages.json');
        this._markFile = path.join(dir, phone + '.primary-messages.write-failed');
        this._fd = null; this._timer = null; this._compactTimer = null; this._closed = false; this._dirty = false; this._broken = false;
        this._lock = null; this._key = null; this._setAside = null;
        this._logBytes = 0; this._logLines = 0; this._snapBytes = 0; this._compactAt = thresholds(0);
        // _gapFrom: when the first write the disk refused was tried, until a
        // write lands and records the window (_flushGap). _purge: content was
        // just buried that is still on disk; the next turn compacts it away.
        this._gapFrom = null; this._purge = false; this._sweptAt = 0;
        this._seq = 0; this._lastWrite = null; this._capture = null;
        this._limits = { perChat: 100, maxMessages: 20000 };
        this._chats = new Map();      // chat id → { id, name?, pnJid?, lidJid?, ephemeral?, cts, unread, records (ts asc) }
        this._byId = new Map();       // message id → its records; one, unless two chats reuse an id
        this._total = 0; this._evicted = 0;
        this._inflight = new Set();   // ids seen arriving, not yet stored or resolved
        this._revoked = new Map();    // message id → [{ chat, sender? }], see REVOKED_IDS
        this._settled = new Set();    // ids resolved without being stored, see SETTLED_IDS
        this._losses = []; this._lossById = new Map();
        this._pushNames = new Map();
        this._heap = [];
    }

    // lc: the login counter this open is for. Left out, it is not known, and
    // the store draws nothing from it. setAsideCorrupt: a store that cannot be
    // read (LOG_CORRUPT, SNAPSHOT_CORRUPT) is renamed aside to
    // <file>.corrupt-<when> and a new one started, capturing from now
    // (origin 'enabled'); `setAside` then names the files it was kept under.
    static open({ dir, phone, origin = 'enabled', lc, perChat = 100, maxMessages = 20000, now = Date.now, setAsideCorrupt = false } = {}) {
        requireValue(isStr(dir), 'OPTIONS_INVALID', 'dir');
        requireValue(typeof phone === 'string' && /^\d{1,32}$/.test(phone), 'OPTIONS_INVALID', 'phone');
        requireValue(isStr(origin), 'OPTIONS_INVALID', 'origin');
        requireValue(lc === undefined || (Number.isSafeInteger(lc) && lc >= 0), 'OPTIONS_INVALID', 'lc');
        requireValue(Number.isSafeInteger(perChat) && perChat > 0, 'OPTIONS_INVALID', 'perChat');
        requireValue(Number.isSafeInteger(maxMessages) && maxMessages > 0, 'OPTIONS_INVALID', 'maxMessages');
        requireValue(typeof now === 'function', 'OPTIONS_INVALID', 'now');
        requireValue(typeof setAsideCorrupt === 'boolean', 'OPTIONS_INVALID', 'setAsideCorrupt');
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const base = path.join(dir, phone + '.primary-messages');
        // .native: the JS realpath keeps the caller's letter case, and on a
        // case-insensitive disk two spellings would be two keys for one file.
        const key = path.join(fs.realpathSync.native(dir), phone);
        if (OPEN.has(key)) throw busy(Lock.holderNow(base + '.lock'), key);
        OPEN.add(key);
        let lock = null;
        try {
            // Held from before anything is read until close: no other process
            // reads, compacts or sets aside these files meanwhile.
            lock = takeLock(base);
            const settings = { dir, phone, origin, lc, perChat, maxMessages, now, key, lock };
            try { return PrimaryMessageStore._load(settings); }
            catch (e) {
                if (!setAsideCorrupt || !CORRUPT.includes(e.code)) throw e;
                const aside = setCorruptAside([base + '.log', base + '.json', base + '.write-failed'], now());
                const store = PrimaryMessageStore._load({ ...settings, origin: 'enabled' });
                store._setAside = aside;
                return store;
            }
        } catch (e) {
            releaseLock(lock);
            OPEN.delete(key);
            throw e;
        }
    }

    // Who holds the store's lock, read and nothing more: what breakLock would
    // break, to show before the operator agrees. null when nothing is held.
    // → { v, pid, host, bootId, procStart, token, gen, at, pidNs, legacy } | null
    // BUSY, as breakLock is, while this process holds it.
    static readHolder({ dir, phone } = {}) {
        const { lockPath, key } = locate(dir, phone);
        if (key === null) return null;
        let seen;
        try { seen = Lock.inspect(lockPath); } catch (e) { throw busy(null, lockPath, e); }
        const holder = seen ? seen.holder : null;
        refuseOwn(key, holder, lockPath);
        return holder;
    }

    // An operator's break, the way out of a BUSY whose holder cannot be proven
    // gone from here: another host or container, a pid handed to another
    // process since, a lock its writer died before filling in. The lock is
    // taken over from whoever holds it, alive or not, under the same takeover
    // mutex as any takeover, so one breaker wins; then it is released for the
    // next opener. A holder that is in fact still running stops at its next
    // write (PRIMARY_MESSAGE_STORE_LOST) and writes nothing more.
    //
    // `holder`, as readHolder returned it: break that holder only. One that
    // took its place since (null: none was held then) is left alone, BUSY with
    // the holder now. Never this process's own lock (BUSY).
    // → { holder } — the holder broken, or null when none was held.
    static breakLock(options = {}) {
        const { dir, phone } = options;
        const expected = Object.prototype.hasOwnProperty.call(options, 'holder') ? options.holder : undefined;
        const { base, lockPath, key } = locate(dir, phone);
        if (key === null) return { holder: null };
        let seen;
        try { seen = Lock.inspect(lockPath); } catch (e) { throw busy(null, lockPath, e); }
        refuseOwn(key, seen && seen.holder, lockPath);
        if (!seen) return { holder: null };
        if (expected !== undefined && !Lock.sameHolder(seen.holder, expected)) throw busy(seen.holder, lockPath);
        let taken;
        try { taken = Lock.takeOver(base, crypto.randomBytes(16).toString('hex'), seen, true, null); }
        catch (e) { throw busy(e.holder !== undefined ? e.holder : seen.holder, lockPath, e); }
        if (!taken) {
            // It changed while we looked. Only the holder that was seen is broken.
            const now = Lock.holderNow(lockPath);
            if (now) throw busy(now, lockPath);
            return { holder: null };
        }
        Lock.unlinkOwn(lockPath, taken.fd);
        fs.closeSync(taken.fd);
        return { holder: seen.holder };
    }

    // fn() run while this process holds the store's lock, with the store not
    // open: for work on its files from outside, such as setting them aside.
    // BUSY wherever open() would be. Returns what fn returns.
    static withLock({ dir, phone } = {}, fn) {
        requireValue(typeof fn === 'function', 'OPTIONS_INVALID', 'fn');
        const { base } = locate(dir, phone);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const { key } = locate(dir, phone);
        if (OPEN.has(key)) throw busy(Lock.holderNow(base + '.lock'), key);
        OPEN.add(key);
        let lock = null;
        try {
            lock = takeLock(base);
            return fn();
        } finally {
            releaseLock(lock);
            OPEN.delete(key);
        }
    }

    // Reads the files under a lock already held. On failure it closes what it
    // opened and leaves the lock and the key to open().
    static _load({ dir, phone, origin, lc, perChat, maxMessages, now, key, lock }) {
        const store = new PrimaryMessageStore(dir, phone, now);
        store._key = key;
        try {
            const tmpPrefix = path.basename(store._snapFile) + '.tmp-';
            // What a takeover sets aside it removes itself; one killed half way
            // leaves these, which nobody reads. Only those over a minute old.
            const deadPrefixes = [path.basename(lock.path) + '.dead-', path.basename(lock.path) + '.takeover.dead-'];
            for (const name of fs.readdirSync(dir)) {
                const file = path.join(dir, name);
                if (name.startsWith(tmpPrefix)) fs.rmSync(file, { force: true });
                else if (deadPrefixes.some(p => name.startsWith(p))) {
                    try { if (Date.now() - fs.lstatSync(file).mtimeMs > Lock.MUTEX_AGED) fs.unlinkSync(file); } catch (_) {}
                }
            }
            const hadSnapshot = store._loadSnapshot();
            const c = fs.constants;   // 'a', refusing a symlink planted where the log goes
            store._fd = fs.openSync(store._logFile, c.O_RDWR | c.O_APPEND | c.O_CREAT | (c.O_NOFOLLOW || 0), 0o600);
            fs.fchmodSync(store._fd, 0o600);
            const stale = store._replay();
            const known = store._capture !== null;
            store._commit({ t: 'open', lc, origin, perChat, maxMessages });
            // Writes a process refused before it ended, not yet written down.
            // A marker from before this store's capture began, or one already
            // in the losses (killed between the two), says nothing new.
            const marked = store._readMark();
            if (marked !== null) {
                if (known && !store._losses.some(l => l.reason === 'write-failed' && l.from === marked)) {
                    store._gapFrom = marked;
                    store._flushGap(store._now());
                } else store._unmark();
            }
            // Expired content does not wait for someone to ask for a snapshot.
            const expired = store._sweep(store._now());
            store._sweptAt = store._now();
            // Stale lines are what a crash before the last truncation left;
            // they may still hold content revoked since, as may lines replayed
            // after a revoke whose compaction the crash forestalled. Fold
            // them, and any expired content, out of the files now.
            if (!hadSnapshot || stale || expired || store._purge) store.compact();
        } catch (e) { store._closeFiles(); throw e; }
        store._lock = lock;
        store._timer = setInterval(() => store._tick(), 1000);
        store._timer.unref();
        return store;
    }

    get capture() { return { ...this._capture }; }

    // The files a damaged store was renamed to by setAsideCorrupt, or null.
    get setAside() { return this._setAside && [...this._setAside]; }

    noteLogin(lc) {
        this._live();
        requireValue(Number.isSafeInteger(lc) && lc >= 0, 'INPUT_INVALID', 'lc');
        if (lc !== this._capture.lc) this._commit({ t: 'login', lc });
    }

    recordInflight({ id, chat, ts } = {}) {
        this._live();
        requireValue(isStr(id) && isStr(chat) && isTs(ts), 'INPUT_INVALID', 'inflight');
        if (!this._inflight.has(id)) this._commit({ t: 'inflight', id });
    }

    recordDecryptFailure({ id } = {}) {
        this._live();
        requireValue(isStr(id), 'INPUT_INVALID', 'id');
        if (!this._byId.has(id) && !this._lossById.has(id) && !this._settled.has(id)) this._commit({ t: 'fail', id });
    }

    recordIncoming({ id, chat, fromMe = false, participant, ts, pushName, raw, info } = {}) {
        this._live();
        checkMessage(id, chat, ts, raw, info);
        requireValue(typeof fromMe === 'boolean' && optStr(participant) && optStr(pushName), 'INPUT_INVALID', 'sender');
        if (info.kind === 'content' && !info.editOf) {
            const dead = this._dead({ id, chat, fromMe, participant: participant || undefined });
            this._commit({ t: 'put', id, chat, fromMe, participant: participant || undefined, ts, pushName: pushName || undefined,
                status: fromMe ? STATUS.SERVER_ACK : STATUS.DELIVERY_ACK, ...payload(dead ? undefined : raw, info) });
            return;
        }
        this._effects(chat, ts, raw, info, { fromMe, participant: participant || undefined });
        if (this._inflight.has(id) || this._lossById.has(id)) this._commit({ t: 'resolve', id });
    }

    recordOutgoing({ id, chat, ts, raw, info, supersedes } = {}) {
        this._live();
        checkMessage(id, chat, ts, raw, info);
        requireValue(supersedes === undefined || supersedes === null || isStr(supersedes), 'INPUT_INVALID', 'supersedes');
        if (info.kind === 'content' && !info.editOf) {
            const dead = this._dead({ id, chat, fromMe: true });
            this._commit({ t: 'put', id, chat, fromMe: true, ts, status: STATUS.PENDING, supersedes: supersedes || undefined,
                ...payload(dead ? undefined : raw, info) });
            return;
        }
        this._effects(chat, ts, raw, info, { fromMe: true });
    }

    // Direct calls are the library's own and name the chat themselves; edits
    // and revokes that arrive as messages go through _effects, which also
    // checks who sent them.
    recordEdit(chat, id, raw, at) {
        this._live();
        requireValue(isStr(chat) && isStr(id) && Buffer.isBuffer(raw) && isTs(at), 'INPUT_INVALID', 'edit');
        this._edit(chat, id, raw, at, undefined);
    }

    tombstone(chat, id, reason) {
        this._live();
        requireValue(isStr(chat) && isStr(id), 'INPUT_INVALID', 'tombstone');
        requireValue(TOMBSTONES.includes(reason), 'INPUT_INVALID', 'reason');
        this._tomb(chat, id, reason, undefined);
    }

    drop(chat, id) {
        this._live();
        requireValue(isStr(chat) && isStr(id), 'INPUT_INVALID', 'drop');
        if (this._find(chat, id)) this._commit({ t: 'drop', chat, id });
    }

    setStatus(chat, ids, status) {
        this._live();
        const list = typeof ids === 'string' ? [ids] : ids;
        requireValue(isStr(chat) && Array.isArray(list) && list.every(isStr), 'INPUT_INVALID', 'status target');
        requireValue(Number.isInteger(status) && status >= STATUS.ERROR && status <= STATUS.PLAYED, 'INPUT_INVALID', 'status');
        const rising = list.filter(id => this._statusTargets(chat, id).some(r => rises(r.status, status)));
        if (rising.length) this._commit({ t: 'status', chat, ids: rising, status });
    }

    hasChat(chat) {
        this._live();
        return this._chats.has(chat);
    }

    markRead(chat) {
        this._live();
        requireValue(isStr(chat), 'INPUT_INVALID', 'chat');
        if (this._chats.get(chat)?.unread) this._commit({ t: 'read', chat });
    }

    setChatMeta(chat, meta = {}) {
        this._live();
        requireValue(isStr(chat) && meta && typeof meta === 'object', 'INPUT_INVALID', 'chat meta');
        const { name, pnJid, lidJid, ephemeral } = meta;
        requireValue(optStr(name) && optStr(pnJid) && optStr(lidJid), 'INPUT_INVALID', 'chat meta');
        requireValue(ephemeral === undefined || ephemeral === null || (typeof ephemeral === 'object' && Number.isSafeInteger(ephemeral.seconds)
            && ephemeral.seconds >= 0 && (ephemeral.setAt === undefined || isTs(ephemeral.setAt))), 'INPUT_INVALID', 'ephemeral');
        const current = this._chats.get(chat) || {};
        const changes = {};
        for (const key of ['name', 'pnJid', 'lidJid']) if (meta[key] !== undefined && (meta[key] ?? undefined) !== current[key]) changes[key] = meta[key];
        if (ephemeral !== undefined) {
            const next = ephemeral && (ephemeral.setAt === undefined ? { seconds: ephemeral.seconds } : { seconds: ephemeral.seconds, setAt: ephemeral.setAt });
            if (JSON.stringify(next ?? undefined) !== JSON.stringify(current.ephemeral)) changes.ephemeral = next;
        }
        if (Object.keys(changes).length) this._commit({ t: 'meta', chat, meta: changes });
    }

    // `sweep: false` hands out what is held without first writing down what
    // has expired — for when that write has just failed. Content past its
    // expiry is withheld either way (publicRecord).
    snapshot({ now, sweep = true } = {}) {
        this._live();
        const at = now === undefined ? this._now() : now;
        requireValue(isTs(at), 'INPUT_INVALID', 'now');
        if (sweep) this._sweep(at);
        const chats = [...this._chats.values()].sort((a, b) => b.cts - a.cts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const records = {};
        let count = 0;
        for (const c of chats) { records[c.id] = c.records.map(r => publicRecord(r, at)); count += c.records.length; }
        const losses = this._losses.map(l => (l.ids ? { ...l, ids: [...l.ids] } : { ...l }));
        // Writes are being refused right now: everything since the first one may be missing.
        if (this._gapFrom !== null) losses.push(gapLoss(this._gapFrom, at));
        return {
            seq: this._seq,
            capture: { ...this._capture },
            chats: chats.map(publicChat),
            records,
            losses,
            retained: { evicted: this._evicted },
            pushNames: [...this._pushNames].map(([id, pushname]) => ({ id, pushname })),
            counts: { chats: chats.length, records: count }
        };
    }

    compact() {
        this._live();
        this._fence();
        // A window of refused writes still open is closed by this write, the
        // way the next append would close it: as the event after this._seq,
        // applied only once the snapshot holding it is safely in place.
        let gap = null;
        if (this._gapFrom !== null) {
            const at = this._now();
            requireValue(isTs(at), 'CLOCK_INVALID');
            gap = { seq: this._seq + 1, at, t: 'gap', ...gapLoss(this._gapFrom, at) };
        }
        const state = this._serialize();
        if (gap) Object.assign(state, { seq: gap.seq, lastWrite: gap.at, losses: [...state.losses, gapLoss(gap.from, gap.to)] });
        const text = JSON.stringify(state);
        writePrivateAtomic(this._snapFile, text);
        if (gap) { this._apply(gap); this._gapFrom = null; this._unmark(); }
        // The snapshot now holds every event up to this._seq. Dying before the
        // truncation lands is harmless: replay skips those events by seq.
        fs.ftruncateSync(this._fd, 0);
        try { fs.fdatasyncSync(this._fd); } catch (_) {}
        this._logBytes = 0; this._logLines = 0; this._dirty = false; this._broken = false; this._purge = false;
        this._snapBytes = Buffer.byteLength(text);
        this._compactAt = thresholds(this._snapBytes);
    }

    // A store whose lock was broken has nothing left to write: every event it
    // took is in the log already, and the new owner read them there.
    close() {
        if (this._closed) return;
        try { if (this._logLines > 0 || this._broken || this._gapFrom !== null || this._purge) this.compact(); }
        catch (e) { if (e.code !== 'PRIMARY_MESSAGE_STORE_LOST') throw e; }
        finally { this._release(); }
    }

    // ── persistence ──

    _live() { requireValue(!this._closed, 'CLOSED'); }

    // Run before every write, as late as it can be: the lock is still the file
    // this store took. Gone, or another file in its place, means an operator
    // broke it (breakLock) and another store may be writing these files now,
    // so this one lets go and writes nothing more: LOST, which is final. Not
    // being able to look at all says nothing either way, and the write goes on.
    // Not while opening: the lock was taken a moment before, and open() lets
    // it go itself should the load fail.
    _fence() {
        const lock = this._lock;
        if (!lock) return;
        let now = null;
        try { now = fs.lstatSync(lock.path); }
        catch (e) { if (e.code !== 'ENOENT') return; }
        if (now && now.ino === lock.ino && now.dev === lock.dev) return;
        this._release();
        throw failure('LOST', lock.path);
    }

    _release() {
        this._closed = true;
        this._closeFiles();
        releaseLock(this._lock);
        this._lock = null;
        OPEN.delete(this._key);
    }

    _closeFiles() {
        if (this._timer) clearInterval(this._timer);
        this._timer = null;
        if (this._compactTimer) clearImmediate(this._compactTimer);
        this._compactTimer = null;
        if (this._fd !== null) {
            try { fs.fdatasyncSync(this._fd); } catch (_) {}
            try { fs.closeSync(this._fd); } catch (_) {}
            this._fd = null;
        }
    }

    // Every second: the log to disk, and once an hour the expired content
    // out of it (a compaction follows, see _bury). A sweep the disk refuses
    // is tried again an hour later; the refusal itself is a write-failed gap.
    _tick() {
        this._sync();
        const now = this._now();
        if (!(now - this._sweptAt >= SWEEP_EVERY)) return;
        this._sweptAt = now;
        try { this._sweep(now); } catch (_) {}
    }

    // Best effort: a lost second of appends is what kill -9 of the machine
    // costs, and replay already copes with a torn tail.
    _sync() {
        if (!this._dirty || this._fd === null) return;
        this._dirty = false;
        try { fs.fdatasyncSync(this._fd); } catch (_) {}
    }

    // A window of refused writes is written down before anything else that
    // lands, so the log never claims the store was there throughout.
    _commit(fields) {
        const at = this._now();
        requireValue(isTs(at), 'CLOCK_INVALID');
        this._flushGap(at);
        this._append({ seq: this._seq + 1, at, ...fields });
    }

    _flushGap(at) {
        if (this._gapFrom === null) return;
        this._append({ seq: this._seq + 1, at, t: 'gap', ...gapLoss(this._gapFrom, at) });
        this._gapFrom = null;
        this._unmark();
    }

    _append(ev) {
        this._fence();
        if (this._broken) {
            this._refused(ev.at);
            throw failure('WRITE_FAILED', 'an earlier failed append could not be cut off');
        }
        const line = Buffer.from(JSON.stringify(ev) + '\n');
        try {
            for (let off = 0; off < line.length;) off += fs.writeSync(this._fd, line, off, line.length - off);
        } catch (e) {
            // Half a line would glue itself to the next append and become a
            // corrupt line mid-log. Cut it off; if even that fails, stop
            // writing until a compaction rewrites everything.
            try { fs.ftruncateSync(this._fd, this._logBytes); } catch (_) { this._broken = true; }
            this._refused(ev.at);
            throw failure('WRITE_FAILED', e.message, e);
        }
        this._logBytes += line.length; this._logLines++; this._dirty = true;
        this._apply(ev);
        if (this._purge || this._overThreshold()) this._scheduleCompact();
    }

    // The first refused write opens the window, from the start of its second
    // (the marker's mtime keeps no finer, and earlier is the safe side). The
    // marker carries it past the end of this process, should the window still
    // be open then: an empty file, which a full disk still has room for. One
    // already there is an earlier window's, written down but not removed; it
    // is replaced, or the next open would take this window for that one.
    _refused(at) {
        if (this._gapFrom !== null) return;
        this._gapFrom = Math.floor(at / 1000) * 1000;
        const c = fs.constants;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const fd = fs.openSync(this._markFile, c.O_WRONLY | c.O_CREAT | c.O_EXCL | (c.O_NOFOLLOW || 0), 0o600);
                try { fs.futimesSync(fd, this._gapFrom / 1000, this._gapFrom / 1000); } finally { fs.closeSync(fd); }
                return;
            } catch (e) {
                // Best effort: the window is still written at the next write that lands.
                if (e.code !== 'EEXIST') return;
                this._unmark();
            }
        }
    }

    _readMark() {
        try { return Math.floor(fs.lstatSync(this._markFile).mtimeMs / 1000) * 1000; }
        catch (_) { return null; }
    }

    _unmark() { try { fs.unlinkSync(this._markFile); } catch (_) {} }

    _overThreshold() { return this._logBytes > this._compactAt.bytes || this._logLines > this._compactAt.lines; }

    // Past a threshold the log is folded into the snapshot on the next turn of
    // the event loop, not on the stack of whoever appended: that caller may be
    // holding back an ack, and writing out a large snapshot takes a while. The
    // event is already safe in the log, so a compaction that runs later — or
    // never, because the process ended first — costs only a longer replay.
    // The same turn takes revoked or expired content off the disk (_purge);
    // however many asked, one compaction is pending at a time.
    _scheduleCompact() {
        if (this._compactTimer) return;
        this._compactTimer = setImmediate(() => {
            this._compactTimer = null;
            if (this._closed || !(this._purge || this._overThreshold())) return;
            // One that fails (a disk too full for the snapshot) only means a
            // longer log, and buried content left on disk until the next one
            // that succeeds. Try again a threshold later rather than on every
            // event, and let close() report it if it still fails then.
            try { this.compact(); }
            catch (_) { this._purge = false; this._compactAt = thresholds(this._snapBytes, this._logBytes, this._logLines); }
        });
        if (typeof this._compactTimer.unref === 'function') this._compactTimer.unref();
    }

    // Returns how many lines were already in the snapshot.
    _replay() {
        const data = fs.readFileSync(this._fd);
        const base = this._seq;
        let start = 0, line = 0, stale = 0;
        while (start < data.length) {
            const nl = data.indexOf(10, start);
            const end = nl === -1 ? data.length : nl;
            line++;
            let ev = null;
            try { ev = JSON.parse(data.toString('utf8', start, end)); } catch (_) {}
            if (nl === -1 && !ev) {
                // kill -9 mid-append: the one line that may be torn. Cut it so
                // the next append starts on a line of its own.
                fs.ftruncateSync(this._fd, start);
                break;
            }
            // Anything else unreadable is damage, not a crash. Skipping it could
            // skip a revoke and hand the content out after all, so refuse.
            requireValue(validEvent(ev), 'LOG_CORRUPT', `line ${line} of ${this._logFile}`);
            if (nl === -1) fs.writeSync(this._fd, '\n');   // whole, but lost its newline
            start = end + 1;
            this._logLines++;
            if (ev.seq <= base) {
                requireValue(this._seq === base, 'LOG_CORRUPT', `seq ${ev.seq} out of order at line ${line} of ${this._logFile}`);
                stale++;
                continue;
            }
            requireValue(ev.seq === this._seq + 1, 'LOG_CORRUPT', `seq ${ev.seq} after ${this._seq} at line ${line} of ${this._logFile}`);
            this._apply(ev);
        }
        this._logBytes = fs.fstatSync(this._fd).size;
        return stale;
    }

    _loadSnapshot() {
        let bytes;
        try { bytes = fs.readFileSync(this._snapFile); }
        catch (e) { if (e.code === 'ENOENT') return false; throw e; }
        fs.chmodSync(this._snapFile, 0o600);
        const text = bytes.toString('utf8');
        this._snapBytes = bytes.length;
        this._compactAt = thresholds(this._snapBytes);
        let s = null;
        try { s = JSON.parse(text); } catch (_) {}
        requireValue(s && s.version === VERSION && Number.isSafeInteger(s.seq) && s.seq >= 0 && s.limits
            && Array.isArray(s.chats) && Array.isArray(s.losses), 'SNAPSHOT_CORRUPT', this._snapFile);
        try {
            this._seq = s.seq; this._lastWrite = s.lastWrite ?? null; this._capture = s.capture || null;
            this._limits = s.limits; this._evicted = s.evicted || 0;
            for (const c of s.chats) {
                const chat = this._chat(c.id);
                for (const key of META) if (c[key] !== undefined) chat[key] = c[key];
                chat.cts = c.cts; chat.unread = c.unread;
                for (const d of c.records) {
                    const r = { ...d, chat: c.id };
                    if (d.raw !== undefined) r.raw = unb64(d.raw);
                    chat.records.push(r); this._index(r); this._total++;
                }
                if (chat.records.length) heapPush(this._heap, [chat.cts, chat.id]);
            }
            this._inflight = new Set(s.inflight); this._revoked = new Map(s.revoked); this._pushNames = new Map(s.pushNames);
            this._settled = new Set(s.settled || []);   // absent from snapshots written before it existed
            this._losses = s.losses;
            for (const loss of this._losses) for (const id of loss.ids || []) this._lossById.set(id, loss);
        } catch (e) { throw failure('SNAPSHOT_CORRUPT', this._snapFile, e); }
        return true;
    }

    _serialize() {
        const chats = [];
        for (const c of this._chats.values()) {
            const { records, ...meta } = c;
            chats.push({ ...meta, records: records.map(r => ({ ...r, chat: undefined, raw: r.raw && b64(r.raw) })) });
        }
        return { version: VERSION, seq: this._seq, lastWrite: this._lastWrite, capture: this._capture, limits: this._limits,
            chats, inflight: [...this._inflight], revoked: [...this._revoked], settled: [...this._settled], losses: this._losses,
            evicted: this._evicted, pushNames: [...this._pushNames] };
    }

    // ── applying events: the only code that changes state, live or on replay ──

    _apply(ev) {
        switch (ev.t) {
        case 'open': this._applyOpen(ev); break;
        // While open, a counter that rises is the logins this store saw; one
        // that falls is a break all the same (_relogin).
        case 'login': if (ev.lc < this._capture.lc) this._relogin(ev); else this._capture.lc = ev.lc; break;
        case 'gap': this._losses.push(gapLoss(ev.from, ev.to)); break;
        case 'inflight': this._inflight.add(ev.id); break;
        // Counted the moment it is known, so a live snapshot already says so.
        case 'fail': this._lose('undecryptable', ev.id); break;
        case 'resolve': this._resolve(ev.id); this._settle(ev.id); break;
        case 'put': this._applyPut(ev); break;
        case 'edit':
            for (const r of this._inChat(ev.chat, ev.id)) {
                // A later edit that arrived first is not undone by an earlier one.
                if (!r.tombstone && senderOk(r, ev.sender, false) && !(r.edited > ev.editedAt)) {
                    r.raw = unb64(ev.raw); r.edited = ev.editedAt; r.seq = ev.seq;
                }
            }
            break;
        case 'tomb': {
            const matches = this._inChat(ev.chat, ev.id);
            for (const r of matches) if (senderOk(r, ev.sender, ev.reason === 'revoked')) this._bury(r, ev.reason, ev.seq, ev.sender);
            // Nothing with the id in this chat yet: wait for it here, and only here.
            if (!matches.length && ev.reason === 'revoked') this._remember(ev.id, { chat: ev.chat, sender: ev.sender });
            break;
        }
        case 'expire': { const r = this._find(ev.chat, ev.id); if (r) this._bury(r, 'expired', ev.seq); break; }
        case 'drop': { const r = this._find(ev.chat, ev.id); if (r) this._remove(r); break; }
        case 'status':
            for (const id of ev.ids) {
                for (const r of this._statusTargets(ev.chat, id)) if (rises(r.status, ev.status)) { r.status = ev.status; r.seq = ev.seq; }
            }
            break;
        case 'read': this._chat(ev.chat).unread = 0; break;
        case 'meta': {
            const chat = this._chat(ev.chat);
            for (const key of META) if (ev.meta[key] === null) delete chat[key]; else if (ev.meta[key] !== undefined) chat[key] = ev.meta[key];
            // A tie learned late still reaches the revokes that came before it:
            // the copies on either side meet the revokes remembered on the other.
            const tied = [ev.meta.pnJid, ev.meta.lidJid].filter(isStr);
            if (tied.length) for (const jid of new Set([ev.chat, ...tied])) this._reconcile(jid, ev.seq);
            break;
        }
        }
        this._seq = ev.seq; this._lastWrite = ev.at;
    }

    _applyOpen(ev) {
        this._limits = { perChat: ev.perChat, maxMessages: ev.maxMessages };
        // Seen before the last close or crash and never stored: it is not
        // coming back through this process, so say so, id by id.
        for (const id of [...this._inflight]) this._lose('received-not-stored', id);
        if (!this._capture) this._capture = { since: ev.at, origin: ev.origin, lc: ev.lc ?? 0 };
        else if (ev.lc !== undefined && ev.lc !== this._capture.lc) this._relogin(ev);
        for (const chat of this._chats.values()) this._retain(chat);
    }

    // The login counter is not where this store left it. Higher: logins
    // happened that it was not open for. Lower: the counter started over,
    // which a new registration of the number does — by this library or
    // anything else. Either way whatever came in between the last thing
    // written and now may be missing; after a new registration the capture
    // also no longer runs unbroken from the registration, whatever it said.
    _relogin(ev) {
        this._losses.push({ reason: 'store-disabled', from: this._lastWrite ?? this._capture.since, to: ev.at });
        if (ev.lc < this._capture.lc) this._capture.origin = 'enabled';
        this._capture.lc = ev.lc;
    }

    _applyPut(ev) {
        this._resolve(ev.id);
        const chat = this._chat(ev.chat);
        let r = this._find(ev.chat, ev.id);
        const old = ev.supersedes && ev.supersedes !== ev.id && this._find(ev.chat, ev.supersedes);
        if (old && !r) { this._unindex(old); old.id = ev.id; this._index(old); r = old; }
        else if (old) { r.status = Math.max(r.status, old.status); this._remove(old); }
        if (!r) {
            r = { id: ev.id, chat: ev.chat, seq: ev.seq, fromMe: ev.fromMe, participant: ev.participant, ts: ev.ts, status: ev.status, pushName: ev.pushName };
            const seconds = ev.expiration || chat.ephemeral?.seconds || 0;
            if (seconds > 0) { r.expiration = seconds; r.expiresAt = ev.ts * 1000 + seconds * 1000; }
            if (ev.raw !== undefined) r.raw = unb64(ev.raw);
            const wasEmpty = !chat.records.length;
            chat.records.splice(upperBound(chat.records, ev.ts), 0, r);
            this._index(r); this._total++;
            if (!ev.fromMe) chat.unread++;
            if (ev.ts > chat.cts || wasEmpty) { chat.cts = Math.max(chat.cts, ev.ts); this._touch(chat); }
        } else {
            // The same message again: never brings back what was taken out,
            // never undoes an edit, never lowers a status.
            if (!r.tombstone && !r.edited && ev.raw !== undefined) r.raw = unb64(ev.raw);
            r.status = Math.max(r.status, ev.status);
            r.seq = ev.seq;
        }
        if (ev.viewOnce) this._bury(r, 'view-once', ev.seq);
        const revoked = this._revokedFor(r);
        if (revoked) this._bury(r, 'revoked', ev.seq, revoked.sender);
        if (ev.pushName && !ev.fromMe) this._pushNames.set(ev.participant || ev.chat, ev.pushName);
        this._retain(chat);
    }

    _retain(chat) {
        while (chat.records.length > this._limits.perChat) this._evict(chat);
        while (this._total > this._limits.maxMessages) this._evict(this._leastRecent());
    }

    _evict(chat) {
        const r = chat.records.shift();
        this._unindex(r); this._total--; this._evicted++;
    }

    _leastRecent() {
        for (;;) {
            const [cts, id] = this._heap[0];
            const chat = this._chats.get(id);
            if (chat && chat.records.length && chat.cts === cts) return chat;
            heapPop(this._heap);
        }
    }

    _touch(chat) {
        heapPush(this._heap, [chat.cts, chat.id]);
        if (this._heap.length > 2 * this._chats.size + 64) {
            // A sorted array is a valid heap; this drops the stale entries.
            this._heap = [...this._chats.values()].filter(c => c.records.length).map(c => [c.cts, c.id]).sort((a, b) => (before(a, b) ? -1 : 1));
        }
    }

    // `sender` is whoever revoked it, kept so the remembered revoke later
    // reaches only what that sender could have revoked.
    // Content it had is in the log or the snapshot still: _purge has the next
    // turn compact it away (on replay, the open does).
    _bury(r, reason, seq, sender) {
        if (!r.tombstone) r.tombstone = reason;
        // Eviction or drop may forget the record; this keeps a revoked id dead.
        if (reason === 'revoked') this._remember(r.id, { chat: r.chat, sender });
        if (r.raw !== undefined) this._purge = true;
        delete r.raw;
        r.seq = seq;
    }

    _remember(id, entry) {
        const list = this._revoked.get(id) || [];
        if (list.some(e => e.chat === entry.chat && JSON.stringify(e.sender) === JSON.stringify(entry.sender))) return;
        this._revoked.delete(id);
        this._revoked.set(id, [...list, entry].slice(-8));
        if (this._revoked.size > REVOKED_IDS) this._revoked.delete(this._revoked.keys().next().value);
    }

    // The remembered revoke, if any, that covers a message with r's key: same
    // conversation, and a sender who could have revoked it.
    _revokedFor(r) {
        return (this._revoked.get(r.id) || []).find(e => this._sameChat(e.chat, r.chat) && senderOk(r, e.sender, true));
    }

    // Whether a put's content would only be thrown away: written to the log it
    // would put revoked bytes back on disk, so it is not written at all.
    _dead(key) { return !!(this._find(key.chat, key.id)?.tombstone || this._revokedFor(key)); }

    _reconcile(chatId, seq) {
        for (const r of this._chats.get(chatId)?.records || []) {
            const revoked = !r.tombstone && this._revokedFor(r);
            if (revoked) this._bury(r, 'revoked', seq, revoked.sender);
        }
    }

    // Losses that are known now, not only at the next open. An id already
    // stored is not a loss, and an id already counted is not counted twice.
    _lose(reason, id) {
        this._inflight.delete(id);
        if (this._byId.has(id) || this._lossById.has(id) || this._settled.has(id)) return;
        let loss = this._losses[this._losses.length - 1];
        if (!loss || loss.reason !== reason) this._losses.push(loss = { reason, ids: [] });
        loss.ids.push(id);
        this._lossById.set(id, loss);
    }

    _sweep(at) {
        const expired = [];
        for (const chat of this._chats.values()) for (const r of chat.records) if (!r.tombstone && r.expiresAt <= at) expired.push(r);
        for (const r of expired) this._commit({ t: 'expire', chat: r.chat, id: r.id });
        return expired.length;
    }

    _settle(id) {
        this._settled.delete(id);
        this._settled.add(id);
        if (this._settled.size > SETTLED_IDS) this._settled.delete(this._settled.values().next().value);
    }

    _resolve(id) {
        this._inflight.delete(id);
        const loss = this._lossById.get(id);
        if (!loss) return;
        // It was counted lost, then came after all: it is not a loss any more.
        loss.ids.splice(loss.ids.indexOf(id), 1);
        this._lossById.delete(id);
        if (!loss.ids.length) this._losses.splice(this._losses.indexOf(loss), 1);
    }

    _remove(r) {
        const records = this._chats.get(r.chat).records;
        records.splice(records.indexOf(r), 1);
        this._unindex(r); this._total--;
    }

    _chat(id) {
        let chat = this._chats.get(id);
        if (!chat) this._chats.set(id, chat = { id, cts: 0, unread: 0, records: [] });
        return chat;
    }

    _index(r) {
        const list = this._byId.get(r.id);
        if (list) list.push(r); else this._byId.set(r.id, [r]);
    }

    _unindex(r) {
        const list = this._byId.get(r.id);
        list.splice(list.indexOf(r), 1);
        if (!list.length) this._byId.delete(r.id);
    }

    _find(chat, id) { return this._copies(id).find(r => r.chat === chat) || null; }

    _copies(id) { return (this._byId.get(id) || []).slice(); }

    // One conversation can be stored under two jids, its lid and its phone
    // number; setChatMeta is what ties them. Either side naming the other is
    // enough, since only one of them may have been told.
    _sameChat(a, b) {
        if (a === b) return true;
        const ca = this._chats.get(a), cb = this._chats.get(b);
        return !!((ca && (ca.pnJid === b || ca.lidJid === b)) || (cb && (cb.pnJid === a || cb.lidJid === a)));
    }

    // Edits and revokes reach only the chat they arrived in. key.remoteJid
    // is the sender's view of the chat and never chooses it.
    _inChat(chat, id) { return this._copies(id).filter(r => this._sameChat(r.chat, chat)); }

    // Receipts: the exact chat first, else our own message with that id, as a
    // receipt may name the other jid of the conversation.
    _statusTargets(chat, id) {
        const all = this._copies(id), exact = all.filter(r => r.chat === chat);
        return exact.length ? exact : all.filter(r => r.fromMe);
    }

    // Protocol messages change other records and are never stored themselves.
    // `chat` is where the message arrived; `sender` is who sent it.
    _effects(chat, ts, raw, info, sender) {
        if (info.kind === 'content') return this._edit(chat, info.editOf, raw, ts, sender);
        if (info.kind !== 'protocol') return;
        const p = info.protocol;
        if (p.type === 0) this._tomb(chat, p.key.id, 'revoked', sender);
        else if (p.type === 14) this._edit(chat, p.key.id, p.editedRaw, ts, sender);
        else if (p.type === 3) this.setChatMeta(chat, { ephemeral: { seconds: Number(p.ephemeralExpiration) || 0, setAt: ts } });
    }

    // Only what the event would change is written: an edit for something we
    // never had, may no longer show, or that its sender did not write is dropped.
    _edit(chat, id, raw, at, sender) {
        requireValue(Buffer.isBuffer(raw), 'INPUT_INVALID', 'raw');
        if (this._inChat(chat, id).some(r => !r.tombstone && senderOk(r, sender, false))) {
            this._commit({ t: 'edit', chat, id, raw: b64(raw), editedAt: at, sender });
        }
    }

    _tomb(chat, id, reason, sender) {
        const matches = this._inChat(chat, id);
        // Only a revoke waits for a target that has not come; nothing else would.
        const waiting = (this._revoked.get(id) || []).some(e => e.chat === chat && JSON.stringify(e.sender) === JSON.stringify(sender));
        if (matches.length ? matches.some(r => !r.tombstone && senderOk(r, sender, reason === 'revoked')) : reason === 'revoked' && !waiting) {
            this._commit({ t: 'tomb', chat, id, reason, sender });
        }
    }
}

// Whether `sender` may edit or revoke record r. No sender is the library's own
// direct call. Only the author may edit; in a 1:1 chat only the author may
// revoke, while in a group any member's revoke is taken, being either the
// author's or an admin deleting for everyone.
function senderOk(r, sender, revoke) {
    if (!sender) return true;
    const group = isGroup(r.chat);
    if (revoke && group) return true;
    if (r.fromMe !== sender.fromMe) return false;
    return !group || r.fromMe || (r.participant !== undefined && r.participant === sender.participant);
}

function checkMessage(id, chat, ts, raw, info) {
    requireValue(isStr(id) && isStr(chat) && isTs(ts), 'INPUT_INVALID', 'id, chat and ts');
    requireValue(info && typeof info === 'object' && KINDS.includes(info.kind), 'INPUT_INVALID', 'info.kind');
    if (info.kind === 'content') {
        requireValue(info.viewOnce || Buffer.isBuffer(raw), 'INPUT_INVALID', 'raw');
        requireValue(info.editOf === undefined || info.editOf === null || isStr(info.editOf), 'INPUT_INVALID', 'info.editOf');
        requireValue(info.expiration === undefined || info.expiration === null || (Number.isSafeInteger(info.expiration) && info.expiration >= 0),
            'INPUT_INVALID', 'info.expiration');
    } else if (info.kind === 'protocol') {
        const p = info.protocol;
        // A number, strictly: a revoke passed as 'REVOKE' and quietly ignored
        // would leave the revoked content in place.
        requireValue(p && typeof p === 'object' && Number.isInteger(p.type), 'INPUT_INVALID', 'info.protocol.type');
        if (p.type === 0 || p.type === 14) requireValue(isStr(p.key?.id) && optStr(p.key?.remoteJid), 'INPUT_INVALID', 'info.protocol.key');
        if (p.type === 14) requireValue(Buffer.isBuffer(p.editedRaw), 'INPUT_INVALID', 'info.protocol.editedRaw');
    }
}

// A time window in which messages may have arrived and were not kept, because
// the disk refused to write them. Milliseconds, like every other window.
function gapLoss(from, to) { return { reason: 'write-failed', from, to }; }

// View-once bytes, and content already known to be revoked (passed here as no
// raw), are never written anywhere, not even to the log.
function payload(raw, info) {
    return { raw: info.viewOnce || !raw ? undefined : b64(raw), viewOnce: info.viewOnce ? true : undefined,
        expiration: info.expiration > 0 ? info.expiration : undefined };
}

// A record past its expiry that the sweep could not write down yet goes out
// as the stub it is about to become, never with its content.
function publicRecord(r, at) {
    const out = { id: r.id, seq: r.seq, fromMe: r.fromMe, ts: r.ts, status: r.status };
    const expired = !r.tombstone && r.expiresAt <= at;
    if (r.participant !== undefined) out.participant = r.participant;
    if (r.pushName !== undefined) out.pushName = r.pushName;
    if (r.raw !== undefined && !expired) out.raw = Buffer.from(r.raw);
    if (r.tombstone !== undefined) out.tombstone = r.tombstone;
    else if (expired) out.tombstone = 'expired';
    if (r.edited !== undefined) out.edited = r.edited;
    if (r.expiration !== undefined) out.expiration = r.expiration;   // the disappearing timer, in seconds
    return out;
}

function publicChat(c) {
    const out = { id: c.id };
    for (const key of ['name', 'pnJid', 'lidJid']) if (c[key] !== undefined) out[key] = c[key];
    out.conversationTimestamp = c.cts;
    out.unreadCount = c.unread;
    if (c.ephemeral) out.ephemeral = { ...c.ephemeral };
    return out;
}

module.exports = { PrimaryMessageStore, STATUS };
