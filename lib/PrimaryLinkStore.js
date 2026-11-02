'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { failure, requireValue, validateState } = require('./PrimaryLinkCrypto');
const LOCK_MAX = 4096;
// Never follow a link, and never wait on a FIFO someone left in the lock's place.
const READ_LOCK = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);

// ─── Who holds the journal ────────────────────────────────────────────────
//
// The lock file names its owner:
//   { v: 2, pid, host, bootId, procStart, token, gen, at, pidNs }
// A pid on its own proves nothing. It only means something on the boot of the
// host that issued it, and inside its pid namespace, and once that process is
// gone the number is handed to the next one. So a lock is taken over without
// an operator only when every one of those matches this process and the pid is
// gone or now belongs to a process that started at another time. Everything
// else, a paused owner included, stays BUSY until someone breaks the lock.
//
// A takeover runs under a mutex, <lock>.takeover, which names its writer the
// same way (gen 0), so that one left behind by a recoverer that died mid-way is
// judged by the same rules instead of blocking every recovery for good.

// Linux names each boot. Elsewhere the boot instant in whole seconds stands in
// for it. macOS reports uptime in whole seconds, so subtracting it from the
// fractional clock and rounding flips by one depending on when in the second
// you ask: the clock is floored first when the uptime is whole.
function bootId() {
    try {
        const id = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
        if (id)
            return id;
    }
    catch (_) { }
    for (let attempt = 0; attempt < 2; attempt++) {
        const before = Date.now(), uptime = os.uptime(), after = Date.now();
        if (Math.floor(before / 1000) === Math.floor(after / 1000))
            return String(Number.isInteger(uptime) ? Math.floor(before / 1000) - uptime : Math.round(before / 1000 - uptime));
    }
    return String(Math.round(Date.now() / 1000 - os.uptime()));
}
// Field 22 of /proc/<pid>/stat: when the process started, in clock ticks since
// boot. Two processes that hold one pid in turn do not share it. Field 2 is the
// command name in parentheses and may itself hold spaces or parentheses, so the
// fields are counted from the last ')'.
function processStart(pid) {
    if (process.platform !== 'linux')
        return null;
    try {
        const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
        const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
        return /^\d+$/.test(start) ? start : null;
    }
    catch (_) {
        return null;
    }
}
// Containers on one host share its boot, and its host name too when they are
// given a fixed one or the host's network. A pid from the container next door
// means nothing here: that it is missing here is no proof it is gone there.
function pidNamespace() {
    if (process.platform !== 'linux')
        return null;
    try {
        return fs.readlinkSync('/proc/self/ns/pid');
    }
    catch (_) {
        return null;
    }
}
function writeLease(fd, token, gen) {
    fs.writeFileSync(fd, JSON.stringify({ v: 2, pid: process.pid, host: os.hostname(), bootId: bootId(), procStart: processStart('self'), token, gen, at: Date.now(), pidNs: pidNamespace() }));
    fs.fsyncSync(fd);
}
const short = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
function describe(text, info) {
    let value = null;
    try {
        value = JSON.parse(text);
    }
    catch (_) { }
    if (value && value.v === 2 && Number.isSafeInteger(value.pid) && value.pid > 0 && short(value.host) && short(value.bootId)
        && (value.procStart === null || (typeof value.procStart === 'string' && /^\d{1,20}$/.test(value.procStart)))
        && short(value.token) && Number.isSafeInteger(value.gen) && value.gen >= 0 && value.gen < Number.MAX_SAFE_INTEGER
        && Number.isFinite(value.at) && (value.pidNs === undefined || value.pidNs === null || short(value.pidNs)))
        return { v: 2, pid: value.pid, host: value.host, bootId: value.bootId, procStart: value.procStart, token: value.token, gen: value.gen, at: value.at, pidNs: value.pidNs ?? null, legacy: false };
    // A bare pid from before this format, or a lock whose writer died before
    // filling it in. Neither says enough to prove its owner gone.
    const pid = typeof text === 'string' && /^\s*\d{1,10}\s*$/.test(text) ? Number(text) : null;
    return { v: 1, pid: pid > 0 ? pid : null, host: null, bootId: null, procStart: null, token: null, gen: null, at: Math.round(info.mtimeMs), pidNs: null, legacy: true };
}
// The lock as it is right now: which file it is, and what it says.
function inspect(lockPath) {
    let fd;
    try {
        fd = fs.openSync(lockPath, READ_LOCK);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        // A symlink or something else that cannot be read: held, by whom unknown.
        let info;
        try {
            info = fs.lstatSync(lockPath);
        }
        catch (again) {
            if (again.code === 'ENOENT')
                return null;
            throw again;
        }
        return { info, text: null, holder: describe(null, info) };
    }
    try {
        return opened(fd);
    }
    finally {
        fs.closeSync(fd);
    }
}
function opened(fd) {
    const info = fs.fstatSync(fd);
    let text = null;
    if (info.isFile()) {
        const buffer = Buffer.alloc(LOCK_MAX);
        text = buffer.toString('utf8', 0, fs.readSync(fd, buffer, 0, LOCK_MAX, 0));
    }
    return { info, text, holder: describe(text, info) };
}
function holderNow(lockPath) {
    try {
        return inspect(lockPath)?.holder || null;
    }
    catch (_) {
        return null;
    }
}
// Whether a holder's pid can be checked from here at all: written on this boot
// of this host, in this pid namespace. On Linux both namespaces must be known
// and equal; elsewhere there are none, and a holder must not claim one.
function local(holder) {
    if (!holder || holder.legacy || holder.v !== 2)
        return false;
    if (holder.host !== os.hostname() || holder.bootId !== bootId())
        return false;
    const ns = pidNamespace();
    return holder.pidNs === ns && (ns !== null || process.platform !== 'linux');
}
function provablyDead(holder) {
    if (!local(holder))
        return false;
    try {
        process.kill(holder.pid, 0);
    }
    catch (error) {
        // EPERM: someone else's process, alive. Anything else proves nothing.
        return error.code === 'ESRCH';
    }
    // The pid is in use. Only a start time that differs shows it is not the owner.
    if (holder.procStart === null)
        return false;
    const start = processStart(holder.pid);
    return start !== null && start !== holder.procStart;
}
// A process here that is running: the one thing even an explicit break leaves be.
function liveHere(holder) {
    return local(holder) && !provablyDead(holder);
}
// Whether a lock is this very process's own, through any store or client in it.
function heldByThisProcess(holder) {
    return !!holder && !holder.legacy && holder.pid === process.pid && holder.host === os.hostname() && holder.bootId === bootId()
        && holder.procStart === processStart('self') && (holder.pidNs === null || holder.pidNs === pidNamespace());
}
function busy(holder, cause) {
    const error = failure('PRIMARY_LINK_STORE_BUSY');
    error.holder = holder || null;
    if (cause)
        error.cause = cause;
    return error;
}
// One holder, as readHolder describes it, by every field it has.
const HOLDER_FIELDS = ['v', 'pid', 'host', 'bootId', 'procStart', 'token', 'gen', 'at', 'pidNs', 'legacy'];
function sameHolder(a, b) {
    return !!a && !!b && typeof a === 'object' && typeof b === 'object' && HOLDER_FIELDS.every(k => (a[k] ?? null) === (b[k] ?? null));
}
function sameLock(a, b) {
    return a.info.ino === b.info.ino && a.info.dev === b.info.dev && a.text === b.text;
}
// Remove file only while it is still the one open on fd. An open file's inode
// cannot be handed to another file, so a match is never someone else's.
function unlinkOwn(file, fd) {
    try {
        const open = fs.fstatSync(fd), now = fs.lstatSync(file);
        if (open.ino === now.ino && open.dev === now.dev)
            fs.unlinkSync(file);
    }
    catch (_) { }
}
// BUSY because of the takeover mutex: err.holder is the mutex's writer, marked.
function busyMutex(holder) {
    return busy(holder ? { ...holder, mutex: true } : null);
}
// A takeover writes its mutex and the lock it wins under one token. A mutex
// whose token the lock now carries belongs to a takeover that is over: it got
// the lock. Stale on any path. The process alone does not say so: one process
// can hold the lock through one store while another store in it writes a
// mutex of its own.
function finished(holder, lockPath) {
    const now = holderNow(lockPath);
    return !!holder && !!now && !holder.legacy && !now.legacy && typeof holder.token === 'string' && holder.token === now.token;
}
// A recoverer holds the mutex for microseconds. One older than this is left
// over whoever wrote it, which an operator's break may act on.
const MUTEX_AGED = 60000;
function stale(holder, lockPath, force) {
    if (finished(holder, lockPath))
        return true;
    if (!force)
        return provablyDead(holder);
    return !liveHere(holder) || Date.now() - holder.at > MUTEX_AGED;
}
// Move file aside to a name of our own, then check that what moved is the very
// file that was judged. If it is not, another clearer got there first and this
// is a newer mutex. A finished one (the lock carries its token) is removed with
// the rest; any other is put back for its owner, and this clearer loses.
//
// That is not airtight. While a live recoverer's new mutex is aside, a third
// opener can create the name afresh, and the put-back then fails: two
// recoverers each believe they hold the mutex. The worst that follows is that
// one renames the other's brand-new lock away; that owner fails LOST at its
// next fence. A write already past its fence can still land, so at most one
// in-flight write of the displaced owner lands; the file is never torn.
function setAside(file, seen, token, lockPath) {
    const aside = file + '.dead-' + token;
    try {
        fs.renameSync(file, aside);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return; // Cleared by someone else already.
        throw error;
    }
    // Vanished from under us counts as cleared by someone else, as above.
    const moved = inspect(aside), gone = !moved || sameLock(moved, seen) || finished(moved.holder, lockPath);
    if (!gone) {
        try {
            fs.linkSync(aside, file);
        }
        catch (_) { }
    }
    try {
        fs.unlinkSync(aside);
    }
    catch (_) { }
    if (!gone)
        throw busyMutex(moved.holder);
}
// The takeover mutex, created exclusively, then filled with its writer's lease
// so that one left behind by a recoverer killed mid-takeover can be judged like
// a lock. Stale on any path when its takeover is over (the lock carries its
// token). Otherwise, without an operator, only when its writer is provably dead;
// on an explicit break, unless its writer is running here and wrote it within
// the last minute: empty, unreadable, foreign, dead or aged all give way. At
// most one clearing per call.
function claimMutex(lockPath, token, force, lockHolder) {
    const mutexPath = lockPath + '.takeover';
    let cleared = false;
    for (let attempt = 0; attempt < 3; attempt++) {
        let fd;
        try {
            fd = fs.openSync(mutexPath, 'wx', 0o600);
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw busy(lockHolder, error);
            const seen = inspect(mutexPath);
            if (!seen)
                continue;
            if (cleared || !stale(seen.holder, lockPath, force))
                throw busyMutex(seen.holder);
            setAside(mutexPath, seen, token, lockPath);
            cleared = true;
            continue;
        }
        try {
            writeLease(fd, token, 0);
            return fd;
        }
        catch (error) {
            unlinkOwn(mutexPath, fd);
            fs.closeSync(fd);
            throw error;
        }
    }
    throw busyMutex(holderNow(mutexPath));
}
// A journal's generation, for a lock that names none of its own.
function journalGen(filename) {
    try {
        const saved = readJournal(filename);
        return saved && Number.isSafeInteger(saved.leaseGen) ? saved.leaseGen : 0;
    }
    catch (_) {
        return 0;
    }
}
// Take the lock `seen` over. One recoverer at a time, through the mutex. Under
// it the lock must still be the very file that was judged, and still judged the
// same, before it is renamed aside. The new lock counts one generation past the
// old one, or, when the old one names no generation (a bare pid, empty,
// unreadable), one past the journal's. Returns the new lock, or null when the
// lock changed in the meantime.
function takeOver(filename, token, seen, force, hooks) {
    const lockPath = filename + '.lock', mutexPath = lockPath + '.takeover', deadPath = lockPath + '.dead-' + token;
    const mutex = claimMutex(lockPath, token, force, seen.holder);
    let renamed = false;
    try {
        const now = inspect(lockPath);
        if (!now || !sameLock(now, seen) || !(force || provablyDead(now.holder)))
            return null;
        if (hooks && hooks.beforeTakeoverRename)
            hooks.beforeTakeoverRename();
        fs.renameSync(lockPath, deadPath);
        renamed = true;
        let fd;
        try {
            fd = fs.openSync(lockPath, 'wx', 0o600);
        }
        catch (error) {
            // A fresh opener took the empty name first. It owns the store now.
            throw busy(holderNow(lockPath), error);
        }
        const gen = seen.holder.legacy ? journalGen(filename) + 1 : seen.holder.gen + 1;
        try {
            writeLease(fd, token, gen);
            return { fd, info: fs.fstatSync(fd), gen };
        }
        catch (error) {
            unlinkOwn(lockPath, fd);
            fs.closeSync(fd);
            throw error;
        }
    }
    finally {
        unlinkOwn(mutexPath, mutex);
        fs.closeSync(mutex);
        if (renamed) {
            try {
                fs.unlinkSync(deadPath);
            }
            catch (_) { }
        }
    }
}
function readJournal(filename) {
    let info;
    try {
        info = fs.lstatSync(filename);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
    requireValue(info.isFile() && !info.isSymbolicLink() && !(info.mode & 0o077) && info.size <= 262144);
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        return JSON.parse(fs.readFileSync(fd, 'utf8'));
    }
    finally {
        fs.closeSync(fd);
    }
}
// Separate from upstream's mobile/companion credentials. No code, private
// ephemeral key, shared secret, token, message or account database is stored.
// A bootstrap's history, and the media key of a history blob, live only in the
// 0600 outbox (<phone>.primary-history-outbox.json); this journal keeps their
// digests, never them.
class PrimaryLinkStore {
    // breakLock takes the lock over from any holder, alive or not: an operator's
    // decision, never a default. hooks is a test seam.
    constructor(filename, binding, { breakLock = false, hooks = {} } = {}) {
        this.filename = filename;
        this.binding = binding;
        this.closed = false;
        const dir = path.dirname(filename);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        this.directory = fs.lstatSync(dir);
        requireValue(this.directory.isDirectory() && !this.directory.isSymbolicLink());
        this.lockPath = filename + '.lock';
        this.token = crypto.randomBytes(16).toString('hex');
        this.acquire(breakLock, hooks);
        try {
            const saved = readJournal(filename);
            if (saved)
                this.validate(saved);
            const leaseGen = saved && saved.leaseGen || 0;
            if (this.gen === undefined) {
                // A fresh lock carries on from the last generation the journal saw.
                this.gen = leaseGen + 1;
                writeLease(this.lock, this.token, this.gen);
            }
            requireValue(leaseGen <= this.gen, 'PRIMARY_LINK_STORE_CONFLICT');
            // Stamped at once: an earlier owner is fenced off by the journal
            // itself, and the next fresh lock counts on from this generation.
            const next = { ...(saved || { version: 1, binding, adv: null, pending: [], receipts: [], usedCodes: [], usedQrs: [], transaction: null }), leaseGen: this.gen };
            this.write(next);
            this.data = next;
            this.sweep();
        }
        catch (error) {
            this.close();
            if (error.code === 'PRIMARY_LINK_STORE_CONFLICT' || error.code === 'PRIMARY_LINK_STORE_LOST')
                throw error;
            throw failure('PRIMARY_LINK_STORE_INVALID');
        }
    }
    // What a takeover sets aside it removes at once, but a recoverer killed in
    // between leaves <lock>.dead-* or <lock>.takeover.dead-* behind. Nobody
    // reads those, so once this store owns the lock they go. Best effort, and
    // only those over a minute old: a younger one may be a concurrent clearer's,
    // in the microseconds before it checks what it moved and removes it itself.
    sweep() {
        const dir = path.dirname(this.filename), base = path.basename(this.lockPath);
        let names;
        try {
            names = fs.readdirSync(dir);
        }
        catch (_) {
            return;
        }
        for (const name of names) {
            if (!name.startsWith(base + '.dead-') && !name.startsWith(base + '.takeover.dead-'))
                continue;
            try {
                const leftover = path.join(dir, name);
                if (Date.now() - fs.lstatSync(leftover).mtimeMs > MUTEX_AGED)
                    fs.unlinkSync(leftover);
            }
            catch (_) { }
        }
    }
    acquire(force, hooks) {
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                this.lock = fs.openSync(this.lockPath, 'wx', 0o600);
                this.lockInfo = fs.fstatSync(this.lock);
                return;
            }
            catch (error) {
                if (error.code !== 'EEXIST')
                    throw busy(null, error);
            }
            let seen;
            try {
                seen = inspect(this.lockPath);
            }
            catch (error) {
                throw busy(null, error);
            }
            if (!seen)
                continue; // Released between the two looks.
            if (!force && !provablyDead(seen.holder))
                throw busy(seen.holder);
            let taken;
            try {
                taken = takeOver(this.filename, this.token, seen, force, hooks);
            }
            catch (error) {
                throw error.code === 'PRIMARY_LINK_STORE_BUSY' ? error : busy(seen.holder, error);
            }
            if (taken) {
                this.lock = taken.fd;
                this.lockInfo = taken.info;
                this.gen = taken.gen;
                return;
            }
        }
        throw busy(holderNow(this.lockPath));
    }
    // → { v, pid, host, bootId, procStart, token, gen, at, pidNs, legacy } | null
    static readHolder(filename) {
        return inspect(filename + '.lock')?.holder || null;
    }
    // An operator's break: take the lock over from whoever holds it, under the
    // same mutex as any takeover, then release it for the next opener. An old
    // owner that is still running finds its lock gone at its next write, and the
    // next owner's generation stamped on the journal. `expected`, when given, is
    // the holder the operator was shown (readHolder) and agreed to break: a lock
    // that names another holder now is left alone, BUSY with that holder.
    static breakLock(filename, expected) {
        const lockPath = filename + '.lock', seen = inspect(lockPath);
        if (!seen)
            return { holder: null };
        if (expected !== undefined && !sameHolder(seen.holder, expected))
            throw busy(seen.holder);
        let taken;
        try {
            taken = takeOver(filename, crypto.randomBytes(16).toString('hex'), seen, true, null);
        }
        catch (error) {
            throw error.code === 'PRIMARY_LINK_STORE_BUSY' ? error : busy(seen.holder, error);
        }
        if (!taken) {
            // It changed while we looked. Only the holder that was seen is broken.
            const now = holderNow(lockPath);
            if (now)
                throw busy(now);
            return { holder: null };
        }
        unlinkOwn(lockPath, taken.fd);
        fs.closeSync(taken.fd);
        return { holder: seen.holder };
    }
    validate(value) {
        requireValue(value && value.version === 1 && value.binding === this.binding);
        requireValue(Array.isArray(value.pending) && value.pending.length <= 16 && Array.isArray(value.receipts) && value.receipts.length <= 128 && Array.isArray(value.usedCodes) && value.usedCodes.length <= 256);
        // Optional for backwards-compatible reads of private.10 journals.
        if (value.usedQrs !== undefined)
            requireValue(Array.isArray(value.usedQrs) && value.usedQrs.length <= 256 && value.usedQrs.every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)));
        // Absent from journals written before the lock was fenced.
        if (value.leaseGen !== undefined)
            requireValue(Number.isSafeInteger(value.leaseGen) && value.leaseGen >= 0 && value.leaseGen < Number.MAX_SAFE_INTEGER);
        if (value.adv)
            validateState(value.adv);
        if (value.reservationFloor) {
            validateState(value.reservationFloor);
            requireValue(!value.adv || value.adv.rawId === value.reservationFloor.rawId);
        }
        if (value.transaction) {
            const t = value.transaction;
            requireValue(typeof t.id === 'string' && /^[0-9a-f-]{36}$/.test(t.id));
            requireValue(['exchange', 'exchange_failed', 'verification_required', 'finish_verified', 'pair_device_sending', 'awaiting_confirmation', 'uncertain', 'committed', 'abandoned'].includes(t.phase));
            if (t.method !== undefined)
                requireValue(t.method === 'code' || t.method === 'qr');
            if (t.state)
                validateState(t.state);
        }
    }
    snapshot() { requireValue(!this.closed); return JSON.parse(JSON.stringify(this.data)); }
    update(change) {
        const next = this.snapshot();
        change(next);
        next.leaseGen = this.gen;
        this.validate(next);
        this.write(next);
        this.data = next;
        return this.snapshot();
    }
    // The fence, run by every write as late as it can be: the lock file is still
    // this owner's, and no later generation has written the journal. Either one
    // failing means the store was taken over, and nothing is written: LOST, which
    // is final. Failing to look at all is the filesystem's fault, not a takeover,
    // and goes back to write() as an ordinary failed write.
    fence() {
        let fd;
        try {
            fd = fs.openSync(this.lockPath, READ_LOCK);
        }
        catch (error) {
            // Gone, or a link in its place: not ours any more.
            requireValue(error.code !== 'ENOENT' && error.code !== 'ELOOP', 'PRIMARY_LINK_STORE_LOST');
            // Unreadable. Whether the name still holds our file decides which:
            // a new owner's lock we may not read is a takeover all the same.
            let info;
            try {
                info = fs.lstatSync(this.lockPath);
            }
            catch (again) {
                requireValue(again.code !== 'ENOENT', 'PRIMARY_LINK_STORE_LOST');
                throw error;
            }
            requireValue(info.ino === this.lockInfo.ino && info.dev === this.lockInfo.dev, 'PRIMARY_LINK_STORE_LOST');
            throw error;
        }
        let lock;
        try {
            lock = opened(fd);
        }
        finally {
            fs.closeSync(fd);
        }
        requireValue(lock.info.ino === this.lockInfo.ino && lock.info.dev === this.lockInfo.dev && lock.holder.token === this.token, 'PRIMARY_LINK_STORE_LOST');
        const saved = readJournal(this.filename);
        if (saved && saved.leaseGen !== undefined) {
            requireValue(Number.isSafeInteger(saved.leaseGen));
            requireValue(saved.leaseGen <= this.gen, 'PRIMARY_LINK_STORE_LOST');
        }
    }
    write(value) {
        requireValue(!this.closed);
        const dir = path.dirname(this.filename), current = fs.lstatSync(dir);
        requireValue(current.isDirectory() && current.ino === this.directory.ino && current.dev === this.directory.dev);
        const temporary = this.filename + '.tmp-' + crypto.randomBytes(8).toString('hex');
        let fd;
        try {
            fd = fs.openSync(temporary, 'wx', 0o600);
            fs.writeFileSync(fd, JSON.stringify(value));
            fs.fsyncSync(fd);
            fs.closeSync(fd);
            fd = undefined;
            this.fence();
            fs.renameSync(temporary, this.filename);
            const directoryFd = fs.openSync(dir, 'r');
            try {
                fs.fsyncSync(directoryFd);
            }
            finally {
                fs.closeSync(directoryFd);
            }
        }
        catch (error) {
            if (fd !== undefined)
                fs.closeSync(fd);
            try {
                fs.unlinkSync(temporary);
            }
            catch (_) { }
            if (error.code === 'PRIMARY_LINK_STORE_LOST')
                throw error;
            const failed = failure('PRIMARY_LINK_STORE_WRITE_FAILED');
            failed.cause = error;
            throw failed;
        }
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        if (this.lock !== undefined) {
            try {
                const info = fs.lstatSync(this.lockPath);
                if (this.lockInfo && info.ino === this.lockInfo.ino && info.dev === this.lockInfo.dev)
                    fs.unlinkSync(this.lockPath);
            }
            catch (_) { }
            fs.closeSync(this.lock);
            this.lock = undefined;
        }
    }
}
module.exports = { PrimaryLinkStore, heldByThisProcess };
// The lock primitives, shared with the message store's own lock (lib/primary/MessageStore.js).
module.exports.lockFile = { inspect, holderNow, provablyDead, takeOver, writeLease, unlinkOwn, MUTEX_AGED };
