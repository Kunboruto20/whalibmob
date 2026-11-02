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
// The store would rather say it missed something than pretend it did not. A
// message seen but never stored, one that could not be decrypted, and logins
// the store was not open for all end up in `losses`. Revoked, expired and
// view-once content is dropped the moment it is known and never handed out.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const STATUS = Object.freeze({ ERROR: 0, PENDING: 1, SERVER_ACK: 2, DELIVERY_ACK: 3, READ: 4, PLAYED: 5 });
const TOMBSTONES = ['revoked', 'expired', 'view-once'];
const KINDS = ['content', 'protocol', 'skip'];
const META = ['name', 'pnJid', 'lidJid', 'ephemeral'];
const EVENTS = ['open', 'login', 'inflight', 'fail', 'resolve', 'put', 'edit', 'tomb', 'drop', 'status', 'read', 'meta'];
const COMPACT_BYTES = 1024 * 1024, COMPACT_LINES = 5000;
// Revokes whose target is not here (yet). Bounded: a revoke for a message we
// never had is common, a target arriving thousands of revokes later is not.
const PENDING_TOMBSTONES = 5000;
const VERSION = 1;

function failure(code, detail, cause) {
    const full = 'PRIMARY_MESSAGE_STORE_' + code;
    const error = new Error(detail ? full + ': ' + detail : full, cause ? { cause } : undefined);
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

class PrimaryMessageStore {
    constructor(dir, phone, now) {
        this._now = now;
        this._logFile = path.join(dir, phone + '.primary-messages.log');
        this._snapFile = path.join(dir, phone + '.primary-messages.json');
        this._fd = null; this._timer = null; this._closed = false; this._dirty = false; this._broken = false;
        this._logBytes = 0; this._logLines = 0; this._compactAt = { bytes: COMPACT_BYTES, lines: COMPACT_LINES };
        this._seq = 0; this._lastWrite = null; this._capture = null;
        this._limits = { perChat: 100, maxMessages: 20000 };
        this._chats = new Map();      // chat id → { id, name?, pnJid?, lidJid?, ephemeral?, cts, unread, records (ts asc) }
        this._byId = new Map();       // message id → its records; one, unless two chats reuse an id
        this._total = 0; this._evicted = 0;
        this._inflight = new Map();   // message id → whether its decrypt failed
        this._tombstoned = new Map(); // message id → reason, for a target not stored when it came
        this._losses = []; this._lossById = new Map();
        this._pushNames = new Map();
        this._heap = [];
    }

    static open({ dir, phone, origin = 'enabled', lc = 0, perChat = 100, maxMessages = 20000, now = Date.now } = {}) {
        requireValue(isStr(dir), 'OPTIONS_INVALID', 'dir');
        requireValue(typeof phone === 'string' && /^\d{1,32}$/.test(phone), 'OPTIONS_INVALID', 'phone');
        requireValue(isStr(origin), 'OPTIONS_INVALID', 'origin');
        requireValue(Number.isSafeInteger(lc) && lc >= 0, 'OPTIONS_INVALID', 'lc');
        requireValue(Number.isSafeInteger(perChat) && perChat > 0, 'OPTIONS_INVALID', 'perChat');
        requireValue(Number.isSafeInteger(maxMessages) && maxMessages > 0, 'OPTIONS_INVALID', 'maxMessages');
        requireValue(typeof now === 'function', 'OPTIONS_INVALID', 'now');
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const store = new PrimaryMessageStore(dir, phone, now);
        try {
            const tmpPrefix = path.basename(store._snapFile) + '.tmp-';
            for (const name of fs.readdirSync(dir)) if (name.startsWith(tmpPrefix)) fs.rmSync(path.join(dir, name), { force: true });
            const hadSnapshot = store._loadSnapshot();
            const c = fs.constants;   // 'a', refusing a symlink planted where the log goes
            store._fd = fs.openSync(store._logFile, c.O_RDWR | c.O_APPEND | c.O_CREAT | (c.O_NOFOLLOW || 0), 0o600);
            fs.fchmodSync(store._fd, 0o600);
            const stale = store._replay();
            store._commit({ t: 'open', lc, origin, perChat, maxMessages });
            // Stale lines are what a crash before the last truncation left;
            // they may still hold content revoked since. Fold them away now.
            if (!hadSnapshot || stale) store.compact();
        } catch (e) { store._release(); throw e; }
        store._timer = setInterval(() => store._sync(), 1000);
        store._timer.unref();
        return store;
    }

    get capture() { return { ...this._capture }; }

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
        if (this._inflight.get(id) !== true) this._commit({ t: 'fail', id });
    }

    recordIncoming({ id, chat, fromMe = false, participant, ts, pushName, raw, info } = {}) {
        this._live();
        checkMessage(id, chat, ts, raw, info);
        requireValue(typeof fromMe === 'boolean' && optStr(participant) && optStr(pushName), 'INPUT_INVALID', 'sender');
        if (info.kind === 'content' && !info.editOf) {
            this._commit({ t: 'put', id, chat, fromMe, participant: participant || undefined, ts, pushName: pushName || undefined,
                status: fromMe ? STATUS.SERVER_ACK : STATUS.DELIVERY_ACK, ...payload(raw, info) });
            return;
        }
        this._effects(chat, ts, raw, info);
        if (this._inflight.has(id) || this._lossById.has(id)) this._commit({ t: 'resolve', id });
    }

    recordOutgoing({ id, chat, ts, raw, info, supersedes } = {}) {
        this._live();
        checkMessage(id, chat, ts, raw, info);
        requireValue(supersedes === undefined || supersedes === null || isStr(supersedes), 'INPUT_INVALID', 'supersedes');
        if (info.kind === 'content' && !info.editOf) {
            this._commit({ t: 'put', id, chat, fromMe: true, ts, status: STATUS.PENDING, supersedes: supersedes || undefined, ...payload(raw, info) });
            return;
        }
        this._effects(chat, ts, raw, info);
    }

    recordEdit(chat, id, raw, at) {
        this._live();
        requireValue(isStr(chat) && isStr(id) && Buffer.isBuffer(raw) && isTs(at), 'INPUT_INVALID', 'edit');
        // An edit for something we never had, or no longer may show, is dropped:
        // there is nothing it could correctly change.
        if (this._copies(id).some(r => !r.tombstone)) this._commit({ t: 'edit', chat, id, raw: b64(raw), editedAt: at });
    }

    tombstone(chat, id, reason) {
        this._live();
        requireValue(isStr(chat) && isStr(id), 'INPUT_INVALID', 'tombstone');
        requireValue(TOMBSTONES.includes(reason), 'INPUT_INVALID', 'reason');
        const targets = this._copies(id);
        if (targets.length ? targets.some(r => !r.tombstone) : !this._tombstoned.has(id)) this._commit({ t: 'tomb', chat, id, reason });
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
        const rising = list.filter(id => this._statusTargets(chat, id).some(r => r.status < status));
        if (rising.length) this._commit({ t: 'status', chat, ids: rising, status });
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

    snapshot({ now } = {}) {
        this._live();
        const at = now === undefined ? this._now() : now;
        requireValue(isTs(at), 'INPUT_INVALID', 'now');
        // Expiry is written down before anything is handed out, so the content
        // is gone from the store too and not only from this copy.
        const expired = [];
        for (const chat of this._chats.values()) for (const r of chat.records) if (!r.tombstone && r.expiresAt <= at) expired.push(r);
        for (const r of expired) this._commit({ t: 'tomb', chat: r.chat, id: r.id, reason: 'expired' });

        const chats = [...this._chats.values()].sort((a, b) => b.cts - a.cts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const records = {};
        let count = 0;
        for (const c of chats) { records[c.id] = c.records.map(publicRecord); count += c.records.length; }
        return {
            seq: this._seq,
            capture: { ...this._capture },
            chats: chats.map(publicChat),
            records,
            losses: this._losses.map(l => (l.ids ? { ...l, ids: [...l.ids] } : { ...l })),
            retained: { evicted: this._evicted },
            pushNames: [...this._pushNames].map(([id, pushname]) => ({ id, pushname })),
            counts: { chats: chats.length, records: count }
        };
    }

    compact() {
        this._live();
        writePrivateAtomic(this._snapFile, JSON.stringify(this._serialize()));
        // The snapshot now holds every event up to this._seq. Dying before the
        // truncation lands is harmless: replay skips those events by seq.
        fs.ftruncateSync(this._fd, 0);
        try { fs.fdatasyncSync(this._fd); } catch (_) {}
        this._logBytes = 0; this._logLines = 0; this._dirty = false; this._broken = false;
        this._compactAt = { bytes: COMPACT_BYTES, lines: COMPACT_LINES };
    }

    close() {
        if (this._closed) return;
        try { if (this._logLines > 0 || this._broken) this.compact(); }
        finally { this._release(); }
    }

    // ── persistence ──

    _live() { requireValue(!this._closed, 'CLOSED'); }

    _release() {
        this._closed = true;
        if (this._timer) clearInterval(this._timer);
        this._timer = null;
        if (this._fd !== null) {
            try { fs.fdatasyncSync(this._fd); } catch (_) {}
            try { fs.closeSync(this._fd); } catch (_) {}
            this._fd = null;
        }
    }

    // Best effort: a lost second of appends is what kill -9 of the machine
    // costs, and replay already copes with a torn tail.
    _sync() {
        if (!this._dirty || this._fd === null) return;
        this._dirty = false;
        try { fs.fdatasyncSync(this._fd); } catch (_) {}
    }

    _commit(fields) {
        const ev = { seq: this._seq + 1, at: this._now(), ...fields };
        requireValue(isTs(ev.at), 'CLOCK_INVALID');
        requireValue(!this._broken, 'WRITE_FAILED', 'an earlier failed append could not be cut off');
        const line = Buffer.from(JSON.stringify(ev) + '\n');
        try {
            for (let off = 0; off < line.length;) off += fs.writeSync(this._fd, line, off, line.length - off);
        } catch (e) {
            // Half a line would glue itself to the next append and become a
            // corrupt line mid-log. Cut it off; if even that fails, stop
            // writing until a compaction rewrites everything.
            try { fs.ftruncateSync(this._fd, this._logBytes); } catch (_) { this._broken = true; }
            throw failure('WRITE_FAILED', e.message, e);
        }
        this._logBytes += line.length; this._logLines++; this._dirty = true;
        this._apply(ev);
        if (this._logBytes > this._compactAt.bytes || this._logLines > this._compactAt.lines) {
            // The event is already safe in the log; a compaction that fails
            // (a disk too full for the snapshot) only means a longer log. Try
            // again a threshold later rather than on every event, and let
            // close() report it if it still fails then.
            try { this.compact(); }
            catch (_) { this._compactAt = { bytes: this._logBytes + COMPACT_BYTES, lines: this._logLines + COMPACT_LINES }; }
        }
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
        let text;
        try { text = fs.readFileSync(this._snapFile, 'utf8'); }
        catch (e) { if (e.code === 'ENOENT') return false; throw e; }
        fs.chmodSync(this._snapFile, 0o600);
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
            this._inflight = new Map(s.inflight); this._tombstoned = new Map(s.tombstoned); this._pushNames = new Map(s.pushNames);
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
            chats, inflight: [...this._inflight], tombstoned: [...this._tombstoned], losses: this._losses,
            evicted: this._evicted, pushNames: [...this._pushNames] };
    }

    // ── applying events: the only code that changes state, live or on replay ──

    _apply(ev) {
        switch (ev.t) {
        case 'open': this._applyOpen(ev); break;
        case 'login': this._capture.lc = ev.lc; break;
        case 'inflight': this._inflight.set(ev.id, false); break;
        case 'fail': this._inflight.set(ev.id, true); break;
        case 'resolve': this._resolve(ev.id); break;
        case 'put': this._applyPut(ev); break;
        case 'edit':
            for (const r of this._copies(ev.id)) {
                // A later edit that arrived first is not undone by an earlier one.
                if (!r.tombstone && !(r.edited > ev.editedAt)) { r.raw = unb64(ev.raw); r.edited = ev.editedAt; r.seq = ev.seq; }
            }
            break;
        case 'tomb': {
            const targets = this._copies(ev.id);
            for (const r of targets) this._bury(r, ev.reason, ev.seq);
            if (!targets.length) {
                this._tombstoned.set(ev.id, ev.reason);
                if (this._tombstoned.size > PENDING_TOMBSTONES) this._tombstoned.delete(this._tombstoned.keys().next().value);
            }
            break;
        }
        case 'drop': { const r = this._find(ev.chat, ev.id); if (r) this._remove(r); break; }
        case 'status':
            for (const id of ev.ids) {
                for (const r of this._statusTargets(ev.chat, id)) if (ev.status > r.status) { r.status = ev.status; r.seq = ev.seq; }
            }
            break;
        case 'read': this._chat(ev.chat).unread = 0; break;
        case 'meta': {
            const chat = this._chat(ev.chat);
            for (const key of META) if (ev.meta[key] === null) delete chat[key]; else if (ev.meta[key] !== undefined) chat[key] = ev.meta[key];
            break;
        }
        }
        this._seq = ev.seq; this._lastWrite = ev.at;
    }

    _applyOpen(ev) {
        this._limits = { perChat: ev.perChat, maxMessages: ev.maxMessages };
        // Seen before the last close or crash and never stored: it is not
        // coming back through this process, so say so, id by id.
        const lost = { 'received-not-stored': [], undecryptable: [] };
        for (const [id, failed] of this._inflight) if (!this._byId.has(id)) lost[failed ? 'undecryptable' : 'received-not-stored'].push(id);
        this._inflight.clear();
        for (const [reason, ids] of Object.entries(lost)) {
            if (!ids.length) continue;
            const loss = { reason, ids };
            this._losses.push(loss);
            for (const id of ids) this._lossById.set(id, loss);
        }
        if (!this._capture) this._capture = { since: ev.at, origin: ev.origin, lc: ev.lc };
        else if (ev.lc > this._capture.lc) {
            // Logins happened that this store was not open for; whatever came
            // in between the last thing written and now may be missing.
            this._losses.push({ reason: 'store-disabled', from: this._lastWrite ?? this._capture.since, to: ev.at });
            this._capture.lc = ev.lc;
        }
        for (const chat of this._chats.values()) this._retain(chat);
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
            if (seconds > 0) r.expiresAt = ev.ts * 1000 + seconds * 1000;
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
        const pending = this._tombstoned.get(ev.id);
        if (pending) this._bury(r, pending, ev.seq);
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

    _bury(r, reason, seq) {
        if (!r.tombstone) r.tombstone = reason;
        delete r.raw;
        r.seq = seq;
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

    // Revokes and edits reach every record with the id. The same message can
    // sit under both jids of a conversation (lid and phone number), and a copy
    // missed by a revoke would be revoked content handed out; ids are random
    // enough that two different messages sharing one is not a real case.
    _copies(id) { return (this._byId.get(id) || []).slice(); }

    // Receipts: the exact chat first, else our own message with that id, as a
    // receipt may name the other jid of the conversation.
    _statusTargets(chat, id) {
        const all = this._copies(id), exact = all.filter(r => r.chat === chat);
        return exact.length ? exact : all.filter(r => r.fromMe);
    }

    // Protocol messages change other records and are never stored themselves.
    _effects(chat, ts, raw, info) {
        if (info.kind === 'content') return this.recordEdit(chat, info.editOf, raw, ts);
        if (info.kind !== 'protocol') return;
        const p = info.protocol, target = p.key?.remoteJid || chat;
        if (p.type === 0) this.tombstone(target, p.key.id, 'revoked');
        else if (p.type === 14) this.recordEdit(target, p.key.id, p.editedRaw, ts);
        else if (p.type === 3) this.setChatMeta(chat, { ephemeral: { seconds: Number(p.ephemeralExpiration) || 0, setAt: ts } });
    }
}

function checkMessage(id, chat, ts, raw, info) {
    requireValue(isStr(id) && isStr(chat) && isTs(ts), 'INPUT_INVALID', 'id, chat and ts');
    requireValue(info && typeof info === 'object' && KINDS.includes(info.kind), 'INPUT_INVALID', 'info.kind');
    if (info.kind === 'content') {
        requireValue(info.viewOnce || Buffer.isBuffer(raw), 'INPUT_INVALID', 'raw');
        requireValue(info.editOf === undefined || info.editOf === null || isStr(info.editOf), 'INPUT_INVALID', 'info.editOf');
        requireValue(info.expiration === undefined || info.expiration === null || isTs(info.expiration), 'INPUT_INVALID', 'info.expiration');
    } else if (info.kind === 'protocol') {
        const p = info.protocol;
        // A number, strictly: a revoke passed as 'REVOKE' and quietly ignored
        // would leave the revoked content in place.
        requireValue(p && typeof p === 'object' && Number.isInteger(p.type), 'INPUT_INVALID', 'info.protocol.type');
        if (p.type === 0 || p.type === 14) requireValue(isStr(p.key?.id) && optStr(p.key?.remoteJid), 'INPUT_INVALID', 'info.protocol.key');
        if (p.type === 14) requireValue(Buffer.isBuffer(p.editedRaw), 'INPUT_INVALID', 'info.protocol.editedRaw');
    }
}

// View-once bytes are never written anywhere, not even to the log.
function payload(raw, info) {
    return { raw: info.viewOnce ? undefined : b64(raw), viewOnce: info.viewOnce ? true : undefined,
        expiration: info.expiration > 0 ? info.expiration : undefined };
}

function publicRecord(r) {
    const out = { id: r.id, seq: r.seq, fromMe: r.fromMe, ts: r.ts, status: r.status };
    if (r.participant !== undefined) out.participant = r.participant;
    if (r.pushName !== undefined) out.pushName = r.pushName;
    if (r.raw !== undefined) out.raw = Buffer.from(r.raw);
    if (r.tombstone !== undefined) out.tombstone = r.tombstone;
    if (r.edited !== undefined) out.edited = r.edited;
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
