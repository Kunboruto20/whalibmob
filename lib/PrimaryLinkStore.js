'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { failure, requireValue, validateState } = require('./PrimaryLinkCrypto');
// Separate from upstream's mobile/companion credentials. No code, private
// ephemeral key, shared secret, token, message or account database is stored.
class PrimaryLinkStore {
    constructor(filename, binding) {
        this.filename = filename;
        this.binding = binding;
        this.closed = false;
        const dir = path.dirname(filename);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        this.directory = fs.lstatSync(dir);
        requireValue(this.directory.isDirectory() && !this.directory.isSymbolicLink());
        this.lockPath = filename + '.lock';
        try {
            this.lock = fs.openSync(this.lockPath, 'wx', 0o600);
            this.lockInfo = fs.fstatSync(this.lock);
            fs.writeFileSync(this.lock, String(process.pid));
            fs.fsyncSync(this.lock);
        }
        catch (_) {
            throw failure('PRIMARY_LINK_STORE_BUSY');
        }
        try {
            if (fs.existsSync(filename)) {
                const info = fs.lstatSync(filename);
                requireValue(info.isFile() && !info.isSymbolicLink() && !(info.mode & 0o077) && info.size <= 262144);
                const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
                try {
                    this.data = JSON.parse(fs.readFileSync(fd, 'utf8'));
                }
                finally {
                    fs.closeSync(fd);
                }
                this.validate(this.data);
            }
            else {
                this.data = { version: 1, binding, adv: null, pending: [], receipts: [], usedCodes: [], usedQrs: [], transaction: null };
                this.write(this.data);
            }
        }
        catch (_) {
            this.close();
            throw failure('PRIMARY_LINK_STORE_INVALID');
        }
    }
    validate(value) {
        requireValue(value && value.version === 1 && value.binding === this.binding);
        requireValue(Array.isArray(value.pending) && value.pending.length <= 16 && Array.isArray(value.receipts) && value.receipts.length <= 128 && Array.isArray(value.usedCodes) && value.usedCodes.length <= 256);
        // Optional for backwards-compatible reads of private.10 journals.
        if (value.usedQrs !== undefined)
            requireValue(Array.isArray(value.usedQrs) && value.usedQrs.length <= 256 && value.usedQrs.every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)));
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
        this.validate(next);
        this.write(next);
        this.data = next;
        return this.snapshot();
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
            fs.renameSync(temporary, this.filename);
            const directoryFd = fs.openSync(dir, 'r');
            try {
                fs.fsyncSync(directoryFd);
            }
            finally {
                fs.closeSync(directoryFd);
            }
        }
        catch (_) {
            if (fd !== undefined)
                fs.closeSync(fd);
            try {
                fs.unlinkSync(temporary);
            }
            catch (_) { }
            throw failure('PRIMARY_LINK_STORE_WRITE_FAILED');
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
module.exports = { PrimaryLinkStore };
