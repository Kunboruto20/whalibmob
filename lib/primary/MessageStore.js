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
const EVENTS = ['open', 'login', 'inflight', 'fail', 'resolve', 'put', 'edit', 'tomb', 'expire', 'drop', 'status', 'read', 'meta'];
const COMPACT_BYTES = 1024 * 1024, COMPACT_LINES = 5000;
// Revoked ids, by chat: a revoke whose target had not come yet, and every
// record ever revoked, which eviction or drop may later forget. A redelivery
// of one is stored as a tombstone and its bytes never reach the disk. Only
// revokes take a place: view-once comes back without content anyway and
// expiry is swept again. Bounded: an id coming back thousands of revokes
// later is not a real case.
const REVOKED_IDS = 5000;
const VERSION = 1;
// Two stores over one pair of files would each compact their own memory over
// the other's, and one of them would silently lose. Refused within a process.
const OPEN = new Set();
// Statuses only rise, except that a send the server rejected may go from
// PENDING to ERROR; a real ack after that still raises it.
const rises = (from, to) => to > from || (to === STATUS.ERROR && from === STATUS.PENDING);
const isGroup = jid => jid.endsWith('@g.us');

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
        this._inflight = new Set();   // ids seen arriving, not yet stored or resolved
        this._revoked = new Map();    // message id → [{ chat, sender? }], see REVOKED_IDS
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
        // .native: the JS realpath keeps the caller's letter case, and on a
        // case-insensitive disk two spellings would be two keys for one file.
        const key = path.join(fs.realpathSync.native(dir), phone);
        requireValue(!OPEN.has(key), 'BUSY', key);
        const store = new PrimaryMessageStore(dir, phone, now);
        store._key = key;
        OPEN.add(key);
        try {
            const tmpPrefix = path.basename(store._snapFile) + '.tmp-';
            for (const name of fs.readdirSync(dir)) if (name.startsWith(tmpPrefix)) fs.rmSync(path.join(dir, name), { force: true });
            const hadSnapshot = store._loadSnapshot();
            const c = fs.constants;   // 'a', refusing a symlink planted where the log goes
            store._fd = fs.openSync(store._logFile, c.O_RDWR | c.O_APPEND | c.O_CREAT | (c.O_NOFOLLOW || 0), 0o600);
            fs.fchmodSync(store._fd, 0o600);
            const stale = store._replay();
            store._commit({ t: 'open', lc, origin, perChat, maxMessages });
            // Expired content does not wait for someone to ask for a snapshot.
            const expired = store._sweep(store._now());
            // Stale lines are what a crash before the last truncation left;
            // they may still hold content revoked since. Fold them, and any
            // expired content, out of the files now.
            if (!hadSnapshot || stale || expired) store.compact();
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
        if (!this._byId.has(id) && !this._lossById.has(id)) this._commit({ t: 'fail', id });
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
        this._sweep(at);
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
        OPEN.delete(this._key);
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
            this._inflight = new Set(s.inflight); this._revoked = new Map(s.revoked); this._pushNames = new Map(s.pushNames);
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
            chats, inflight: [...this._inflight], revoked: [...this._revoked], losses: this._losses,
            evicted: this._evicted, pushNames: [...this._pushNames] };
    }

    // ── applying events: the only code that changes state, live or on replay ──

    _apply(ev) {
        switch (ev.t) {
        case 'open': this._applyOpen(ev); break;
        case 'login': this._capture.lc = ev.lc; break;
        case 'inflight': this._inflight.add(ev.id); break;
        // Counted the moment it is known, so a live snapshot already says so.
        case 'fail': this._lose('undecryptable', ev.id); break;
        case 'resolve': this._resolve(ev.id); break;
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
    _bury(r, reason, seq, sender) {
        if (!r.tombstone) r.tombstone = reason;
        // Eviction or drop may forget the record; this keeps a revoked id dead.
        if (reason === 'revoked') this._remember(r.id, { chat: r.chat, sender });
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
        if (this._byId.has(id) || this._lossById.has(id)) return;
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

// View-once bytes, and content already known to be revoked (passed here as no
// raw), are never written anywhere, not even to the log.
function payload(raw, info) {
    return { raw: info.viewOnce || !raw ? undefined : b64(raw), viewOnce: info.viewOnce ? true : undefined,
        expiration: info.expiration > 0 ? info.expiration : undefined };
}

function publicRecord(r) {
    const out = { id: r.id, seq: r.seq, fromMe: r.fromMe, ts: r.ts, status: r.status };
    if (r.participant !== undefined) out.participant = r.participant;
    if (r.pushName !== undefined) out.pushName = r.pushName;
    if (r.raw !== undefined) out.raw = Buffer.from(r.raw);
    if (r.tombstone !== undefined) out.tombstone = r.tombstone;
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
