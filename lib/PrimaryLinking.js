'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const { BinaryNode, encodeNode } = require('./BinaryNode');
const { PrimaryLinkStore } = require('./PrimaryLinkStore');
const C = require('./PrimaryLinkCrypto');
const TTL = 180000;
const HOLD = new Set(['verification_required', 'finish_verified', 'pair_device_sending', 'awaiting_confirmation', 'uncertain']);
function digest(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
function future() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    promise.catch(() => { });
    return { promise, resolve, reject };
}
function checkResponse(node, id) {
    C.requireValue(node && node.description === 'iq' && String(node.attrs.id) === id && (!node.attrs.from || C.jid(node.attrs.from) === 's.whatsapp.net'), 'PRIMARY_LINK_IQ_UNCONFIRMED');
    for (const tag of ['retry-with-method', 'retry-after-challenges', 'challenges']) {
        if (C.optionalChild(node, tag))
            throw C.failure('PRIMARY_LINK_VERIFICATION_REQUIRED');
    }
    C.requireValue(node.attrs.type === 'result', 'PRIMARY_LINK_IQ_REJECTED');
}
function restoreInvitation(value) {
    C.requireValue(value && /^[a-f0-9]{64}$/.test(value.id) && Number.isSafeInteger(value.receivedAt));
    const invitation = { id: value.id, receivedAt: value.receivedAt, ref: Buffer.from(value.ref, 'base64'), noise: Buffer.from(value.noise, 'base64'), wrapped: Buffer.from(value.wrapped, 'base64') };
    C.requireValue(invitation.ref.length > 0 && invitation.ref.length <= 256);
    C.bytes(invitation.noise, 32);
    C.bytes(invitation.wrapped, 80);
    C.requireValue(value.id === digest(Buffer.concat([invitation.ref, invitation.noise, invitation.wrapped])));
    return invitation;
}
function notification(node, ownPhone, ownLid) {
    C.requireValue(node && node.description === 'notification' && node.attrs && node.attrs.type === 'link_code_companion_reg');
    const sender = C.jid(node.attrs.from);
    C.requireValue(['s.whatsapp.net', ownPhone, ownLid].includes(sender));
    C.requireValue(typeof node.attrs.id === 'string' && node.attrs.id.length > 0 && node.attrs.id.length <= 128);
    const wire = encodeNode(node);
    C.requireValue(wire.length <= 8192);
    const reg = C.child(node, 'link_code_companion_reg');
    C.requireValue(['companion_hello', 'companion_finish'].includes(reg.attrs.stage));
    return { reg, receipt: digest(wire), stage: reg.attrs.stage };
}
class PrimaryLinking {
    constructor(client) {
        C.requireValue(client && client._mode === 'mobile', 'PRIMARY_LINK_PRIMARY_REQUIRED');
        C.requireValue(client._store && client._store.registered && /^\d{8,15}$/.test(client._store.phoneNumber), 'PRIMARY_LINK_ACCOUNT_REQUIRED');
        this.client = client;
        this.socket = client._socket;
        this.identity = client._store.identityKeyPair;
        C.bytes(this.identity.private, 32);
        C.bare(this.identity.public);
        this.ownPhone = client._store.phoneNumber + '@s.whatsapp.net';
        this.ownLid = client._myLid ? C.jid(client._myLid) : null;
        this.binding = digest(Buffer.concat([Buffer.from(this.ownPhone), C.bare(this.identity.public)]));
        C.requireValue(typeof client._sessionDir === 'string' && path.isAbsolute(client._sessionDir), 'PRIMARY_LINK_STORE_REQUIRED');
        this.journal = new PrimaryLinkStore(path.join(client._sessionDir, client._store.phoneNumber + '.primary-linking.json'), this.binding);
        this.active = null;
        this.closed = false;
    }
    assertActive() {
        const c = this.client;
        C.requireValue(!this.closed && c._mode === 'mobile' && c._connected && c._socket === this.socket && !c._fatal, 'PRIMARY_LINK_CONNECTION_REQUIRED');
        C.requireValue(c._store.phoneNumber + '@s.whatsapp.net' === this.ownPhone && C.equal(C.bare(c._store.identityKeyPair.public), C.bare(this.identity.public)), 'PRIMARY_LINK_ACCOUNT_CHANGED');
    }
    pendingInvitations() {
        const now = Date.now();
        return this.journal.snapshot().pending.filter(p => p.receivedAt <= now && now - p.receivedAt < TTL).map(p => ({ id: p.id, expiresAt: p.receivedAt + TTL }));
    }
    ack(node) { this.assertActive(); this.socket.sendNode(new BinaryNode('ack', { id: node.attrs.id, to: node.attrs.from, class: 'notification', type: 'link_code_companion_reg' }, null)); }
    notificationOperationId(node) {
        try {
            if (this.active?.invitation && C.equal(C.reference(C.child(node, 'link_code_companion_reg')), this.active.invitation.ref)) return this.journal.snapshot().transaction?.id || null;
        } catch (_) { /* Unmatched or malformed notifications own no operation. */ }
        return null;
    }
    handleNotification(node) {
        this.assertActive();
        const parsed = notification(node, this.ownPhone, this.ownLid), saved = this.journal.snapshot();
        if (saved.receipts.includes(parsed.receipt)) {
            this.ack(node);
            return;
        }
        if (parsed.stage === 'companion_hello') {
            const reg = parsed.reg, ref = C.reference(reg), noise = C.payload(reg, 'companion_server_auth_key_pub', 32), wrapped = C.payload(reg, 'link_code_pairing_wrapped_companion_ephemeral_pub', 80);
            const id = digest(Buffer.concat([ref, noise, wrapped])), now = Date.now();
            this.journal.update(s => {
                s.pending = s.pending.filter(p => p.receivedAt <= now && now - p.receivedAt < TTL && p.id !== id);
                s.pending.push({ id, ref: ref.toString('base64'), noise: noise.toString('base64'), wrapped: wrapped.toString('base64'), receivedAt: now });
                s.pending = s.pending.slice(-16);
                s.receipts = [...s.receipts, parsed.receipt].slice(-128);
            });
            this.ack(node); // Receipt only, never primary authorization.
            this.client.emit('primary_link_invitation', { id, expiresAt: now + TTL });
            return;
        }
        // Delivery IDs may change on redelivery. Only a byte-identical finish
        // already authenticated and durably recorded may be acknowledged here.
        // It must never start another exchange or overwrite the active one.
        if (saved.transaction?.finishDigest === digest(encodeNode(parsed.reg))) {
            this.journal.update(s => { s.receipts = [...s.receipts, parsed.receipt].slice(-128); });
            this.ack(node);
            return;
        }
        C.requireValue(this.active && this.active.finish && C.equal(C.reference(parsed.reg), this.active.invitation.ref), 'PRIMARY_LINK_FINISH_UNMATCHED');
        // Detach every byte from the reader. No ACK until decryption and durable
        // state below succeed. The IQ reader remains free to receive its result.
        const copied = new BinaryNode('notification', { ...node.attrs }, [new BinaryNode('link_code_companion_reg', { ...parsed.reg.attrs }, [
                new BinaryNode('link_code_pairing_ref', {}, Buffer.from(C.reference(parsed.reg))),
                new BinaryNode('companion_identity_public', {}, Buffer.from(C.payload(parsed.reg, 'companion_identity_public', 32))),
                new BinaryNode('link_code_pairing_wrapped_key_bundle', {}, Buffer.from(C.payload(parsed.reg, 'link_code_pairing_wrapped_key_bundle', 156)))
            ])]);
        if (this.active.finishReceipt)
            C.requireValue(this.active.finishReceipt === parsed.receipt, 'PRIMARY_LINK_FINISH_UNMATCHED');
        this.active.finishReceipt = parsed.receipt;
        this.active.finish.resolve({ node: copied, reg: C.child(copied, 'link_code_companion_reg'), receipt: parsed.receipt });
    }
    async iq(content, xmlns = 'md', type = 'set', operation = null, observe = null) {
        this.assertActive();
        const id = this.client._genMsgId();
        const result = await this.wait(this.client._sendIq(new BinaryNode('iq', { id, to: 's.whatsapp.net', type, xmlns }, content)), operation);
        this.assertActive();
        if (observe) observe(result);
        checkResponse(result, id);
        return result;
    }
    async queryOwn(operation = null) {
        const sid = this.client._genMsgId();
        const result = await this.iq([new BinaryNode('usync', { sid, mode: 'query', last: 'true', index: '0', context: 'message' }, [
                new BinaryNode('query', {}, [new BinaryNode('devices', { version: '2' }, null)]),
                new BinaryNode('list', {}, [new BinaryNode('user', { jid: this.ownPhone }, null)]), new BinaryNode('side_list', {}, [])
            ])], 'usync', 'get', operation);
        const usync = C.child(result, 'usync');
        C.requireValue(!usync.attrs.sid || usync.attrs.sid === sid, 'PRIMARY_LINK_QUERY_SID');
        const list = C.child(usync, 'list');
        C.requireValue(Array.isArray(list.content) && list.content.length === 1, 'PRIMARY_LINK_QUERY_LIST');
        const user = list.content[0];
        C.requireValue(user.description === 'user' && C.jid(user.attrs.jid) === this.ownPhone, 'PRIMARY_LINK_QUERY_ACCOUNT');
        const raw = C.child(C.child(user, 'devices'), 'device-list');
        C.requireValue(Array.isArray(raw.content) && raw.content.length > 0 && raw.content.length <= 63, 'PRIMARY_LINK_QUERY_DEVICES');
        const devices = raw.content.map(d => {
            C.requireValue(d.description === 'device', 'PRIMARY_LINK_QUERY_DEVICE_TAG');
            const id = C.number(d.attrs.id, 99), hasKeyIndex = Object.hasOwn(d.attrs, 'key-index');
            const keyIndex = hasKeyIndex ? C.number(d.attrs['key-index']) : 0;
            C.requireValue(id === 0 || (hasKeyIndex && keyIndex > 0), 'PRIMARY_LINK_QUERY_KEY_INDEX');
            return { id, hasKeyIndex, keyIndex };
        });
        C.requireValue(new Set(devices.map(d => d.id)).size === devices.length && devices.some(d => d.id === 0));
        const indexes = devices.filter(d => d.id !== 0).map(d => d.keyIndex);
        C.requireValue(new Set(indexes).size === indexes.length);
        return { observedAt: Date.now(), devices };
    }
    async listLinkedDevices() { const own = await this.queryOwn(); return own.devices.filter(d => d.id !== 0).map(d => ({ deviceId: d.id, keyIndex: d.keyIndex })); }
    async status() {
        const own = await this.queryOwn(), saved = this.journal.snapshot(), tx = saved.transaction;
        const result = { hasADV: !!saved.adv,
            confirmed: tx?.phase === 'committed' && own.devices.some(d => d.id === tx.deviceId && d.keyIndex === tx.state.currentIndex),
            phase: tx ? tx.phase : 'idle',
            startedAt: tx ? tx.startedAt : null,
            expectedDeviceId: tx && tx.expectedDeviceId || null,
            bootstrapPhase: tx && tx.bootstrap ? tx.bootstrap.phase : null,
            devices: own.devices.map(d => ({ deviceId: d.id, keyIndex: d.keyIndex })) };
        if (tx?.bootstrap) {
            result.bootstrap = { phase: tx.bootstrap.phase, errorCode: tx.bootstrap.errorCode || null, iq: tx.bootstrap.iq || null };
            if (tx.bootstrap.phase === 'critical_patch_sending') {
                const { summarizeSyncResponse } = require('./PrimaryBootstrap');
                const node = await this.iq([new BinaryNode('sync', {}, [new BinaryNode('collection', { name: 'critical_block', return_snapshot: 'true' }, null)])], 'w:sync:app:state');
                result.bootstrap.remote = summarizeSyncResponse(node);
            }
        }
        return result;
    }
    async retireAbsent(options = {}) {
        const operation = this.begin(options);
        try {
            const tx = this.journal.snapshot().transaction;
            C.requireValue(tx && ['awaiting_confirmation', 'uncertain', 'pair_device_sending'].includes(tx.phase) && tx.state && tx.before, 'PRIMARY_LINK_NO_RETIRABLE_TRANSACTION');
            C.requireValue(Number.isSafeInteger(tx.startedAt) && Date.now() - tx.startedAt >= 300000, 'PRIMARY_LINK_RETIRE_TOO_EARLY');
            // Two fresh exact baseline lists. No device removal, pairing, proof
            // acceptance or ADV commitment is performed by this recovery path.
            for (let i = 0; i < 2; i++) {
                const own = await this.queryOwn(operation);
                C.requireValue(own.devices.length === tx.before.length && tx.before.every(p => own.devices.some(d => d.id === p.id && d.keyIndex === p.keyIndex && d.hasKeyIndex === p.hasKeyIndex)), 'PRIMARY_LINK_DEVICE_STILL_PRESENT');
            }
            this.journal.update(s => {
                C.requireValue(s.transaction.id === tx.id && s.transaction.phase === tx.phase, 'PRIMARY_LINK_TRANSACTION_CHANGED');
                const floor = s.reservationFloor;
                C.requireValue(!floor || floor.rawId === tx.state.rawId, 'PRIMARY_LINK_ADV_MISMATCH');
                if (!floor || floor.currentIndex < tx.state.currentIndex) s.reservationFloor = C.validateState(tx.state);
                s.transaction.phase = 'abandoned';
                s.transaction.retiredAt = Date.now();
            });
            return { status: 'abandoned', operationId: tx.id };
        } finally { this.end(operation); }
    }
    async seedState(value) {
        this.assertActive();
        C.requireValue(!this.active && !this.journal.snapshot().adv && !this.journal.snapshot().transaction, 'PRIMARY_LINK_STATE_EXISTS');
        const state = C.validateState(value), own = await this.queryOwn();
        C.requireValue(state.validIndexes.length === own.devices.length && own.devices.every(d => d.id === 0 || state.validIndexes.includes(d.keyIndex)), 'PRIMARY_LINK_ADV_MISMATCH');
        this.journal.update(s => { C.requireValue(!s.adv && !s.transaction && !this.active, 'PRIMARY_LINK_STATE_EXISTS'); s.adv = state; });
    }
    wait(promise, operation) {
        if (!operation)
            return promise;
        return Promise.race([Promise.resolve(promise), operation.cancel.promise]).then(value => { C.requireValue(!operation.stopped, 'PRIMARY_LINK_STOPPED'); this.assertActive(); return value; });
    }
    begin(options = {}) {
        this.assertActive();
        C.requireValue(!this.active, 'PRIMARY_LINK_BUSY');
        const timeout = options.timeoutMs === undefined ? 90000 : options.timeoutMs;
        C.requireValue(Number.isInteger(timeout) && timeout >= 1000 && timeout <= 90000, 'PRIMARY_LINK_TIMEOUT_INVALID');
        if (options.signal) {
            C.requireValue(typeof options.signal.addEventListener === 'function' && typeof options.signal.removeEventListener === 'function', 'PRIMARY_LINK_SIGNAL_INVALID');
            C.requireValue(!options.signal.aborted, 'PRIMARY_LINK_ABORTED');
        }
        const operation = { cancel: future(), finish: future(), stopped: false };
        this.active = operation;
        operation.stop = (code) => { if (!operation.stopped) {
            operation.stopped = true;
            operation.cancel.reject(C.failure(code));
        } };
        operation.timer = setTimeout(() => operation.stop('PRIMARY_LINK_TIMEOUT'), timeout);
        if (options.signal) {
            C.requireValue(typeof options.signal.addEventListener === 'function', 'PRIMARY_LINK_SIGNAL_INVALID');
            operation.abort = () => operation.stop('PRIMARY_LINK_ABORTED');
            options.signal.addEventListener('abort', operation.abort, { once: true });
            operation.signal = options.signal;
            if (options.signal.aborted)
                operation.abort();
        }
        return operation;
    }
    end(operation) {
        clearTimeout(operation.timer);
        if (operation.signal && operation.abort)
            operation.signal.removeEventListener('abort', operation.abort);
        if (this.active === operation)
            this.active = null;
    }
    markFailure(error) {
        if (this.journal.closed)
            return;
        this.journal.update(s => {
            if (!s.transaction || s.transaction.phase === 'committed')
                return;
            if (error && error.code === 'PRIMARY_LINK_VERIFICATION_REQUIRED')
                s.transaction.phase = 'verification_required';
            else
                s.transaction.phase = ['pair_device_sending', 'awaiting_confirmation', 'uncertain'].includes(s.transaction.phase) ? 'uncertain' : 'exchange_failed';
        });
    }
    invitationFor(options) {
        C.requireValue(typeof options.invitationId === 'string', 'PRIMARY_LINK_INVITATION_REQUIRED');
        const stored = this.journal.snapshot().pending.find(p => p.id === options.invitationId);
        C.requireValue(stored, 'PRIMARY_LINK_INVITATION_REQUIRED');
        const invitation = restoreInvitation(stored);
        C.requireValue(Date.now() >= invitation.receivedAt && Date.now() - invitation.receivedAt < TTL, 'PRIMARY_LINK_INVITATION_EXPIRED');
        if (options.expectedNoiseKey)
            C.requireValue(C.equal(invitation.noise, C.bare(options.expectedNoiseKey)), 'PRIMARY_LINK_INVITATION_UNMATCHED');
        return invitation;
    }
    async waitForInvitation(options, operation) {
        C.requireValue(options.invitationId === undefined || typeof options.invitationId === 'string', 'PRIMARY_LINK_INVITATION_REQUIRED');
        const waitMs = options.waitMs === undefined ? 45000 : options.waitMs;
        C.requireValue(Number.isInteger(waitMs) && waitMs >= 0 && waitMs <= 90000, 'PRIMARY_LINK_WAIT_INVALID');
        let timer, onInvitation;
        const ready = new Promise((resolve, reject) => {
            onInvitation = () => {
                try {
                    const pending = this.pendingInvitations().filter(p => options.invitationId === undefined || p.id === options.invitationId);
                    C.requireValue(pending.length <= 1, 'PRIMARY_LINK_INVITATION_AMBIGUOUS');
                    if (pending.length === 1) resolve(this.invitationFor({ ...options, invitationId: pending[0].id }));
                    else if (waitMs === 0) reject(C.failure('PRIMARY_LINK_INVITATION_REQUIRED'));
                } catch (error) { reject(error); }
            };
            this.client.on('primary_link_invitation', onInvitation);
            timer = setTimeout(() => reject(C.failure('PRIMARY_LINK_INVITATION_TIMEOUT')), waitMs);
            onInvitation(); // Also covers an alert delivered before subscription.
        });
        try { return await this.wait(ready, operation); }
        finally {
            clearTimeout(timer);
            this.client.removeListener('primary_link_invitation', onInvitation);
        }
    }
    async approve(pairingCode, options = {}, autoInvitation = false) {
        const normalized = C.code(pairingCode), saved = this.journal.snapshot();
        C.requireValue(!saved.transaction || !HOLD.has(saved.transaction.phase), 'PRIMARY_LINK_RECONCILIATION_REQUIRED');
        let invitation = autoInvitation ? null : this.invitationFor(options);
        const operation = this.begin(options);
        let exchange, finish, started = false;
        try {
            if (autoInvitation) invitation = await this.waitForInvitation(options, operation);
            operation.invitation = invitation;
            const used = digest(Buffer.concat([Buffer.from(normalized), invitation.ref, invitation.noise]));
            C.requireValue(!this.journal.snapshot().usedCodes.includes(used), 'PRIMARY_LINK_CODE_ALREADY_USED');
            this.journal.update(s => { s.usedCodes = [...s.usedCodes, used].slice(-256); s.transaction = { id: crypto.randomUUID(), method: 'code', phase: 'exchange', startedAt: Date.now(), invitationId: invitation.id }; });
            started = true;
            await this.iq([new BinaryNode('active', {}, null)], 'passive', 'set', operation);
            const before = await this.queryOwn(operation);
            const creatingExchange = C.primaryHello(invitation, normalized, this.identity).then(value => {
                if (operation.stopped || this.closed) {
                    value.ephemeral.private.fill(0);
                    value.shared.fill(0);
                    throw C.failure('PRIMARY_LINK_STOPPED');
                }
                return value;
            });
            exchange = await this.wait(creatingExchange, operation);
            await this.iq([new BinaryNode('link_code_companion_reg', { stage: 'primary_hello' }, exchange.children)], 'md', 'set', operation);
            const received = await this.wait(operation.finish.promise, operation);
            finish = C.primaryFinish(received.reg, invitation, exchange, this.identity, options.expectedIdentityKey);
            const reserved = this.journal.snapshot();
            const state = C.reserveState(reserved.adv, before.devices, Math.floor(Date.now() / 1000), reserved.reservationFloor);
            this.journal.update(s => { s.reservationFloor = C.validateState(state); s.transaction = { ...s.transaction, phase: 'finish_verified', finishDigest: digest(encodeNode(received.reg)), peer: finish.peer.toString('base64'), state, before: before.devices, timestampRetries: 0 }; s.receipts = [...s.receipts, received.receipt].slice(-128); });
            this.ack(received.node);
            return await this.sendPair(invitation, finish, options, operation, 'code');
        }
        catch (error) {
            if (started) this.markFailure(error);
            throw C.failure(error && typeof error.code === 'string' && error.code.startsWith('PRIMARY_LINK_') ? error.code : 'PRIMARY_LINK_UNCONFIRMED');
        }
        finally {
            if (exchange) {
                exchange.ephemeral.private.fill(0);
                exchange.shared.fill(0);
            }
            if (finish)
                finish.secret.fill(0);
            this.end(operation);
        }
    }
    async approveQr(input, options = {}) {
        const qr = require('./PrimaryLinkQr').parseCompanionQr(input);
        let operation, started = false;
        try {
            const saved = this.journal.snapshot();
            C.requireValue(!saved.transaction || !HOLD.has(saved.transaction.phase), 'PRIMARY_LINK_RECONCILIATION_REQUIRED');
            if (options.expectedNoiseKey)
                C.requireValue(C.equal(qr.noise, C.bare(options.expectedNoiseKey)), 'PRIMARY_LINK_INVITATION_UNMATCHED');
            if (options.expectedIdentityKey)
                C.requireValue(C.equal(qr.peer, C.bare(options.expectedIdentityKey)), 'PRIMARY_LINK_INVITATION_UNMATCHED');
            const used = digest(Buffer.concat([Buffer.from('primary-qr\0'), qr.ref, qr.noise, qr.peer, qr.secret]));
            C.requireValue(!(saved.usedQrs || []).includes(used), 'PRIMARY_LINK_QR_ALREADY_USED');
            operation = this.begin(options);
            this.journal.update(s => {
                s.usedQrs = [...(s.usedQrs || []), used].slice(-256);
                s.transaction = { id: crypto.randomUUID(), method: 'qr', phase: 'exchange', startedAt: Date.now() };
            });
            started = true;
            await this.iq([new BinaryNode('active', {}, null)], 'passive', 'set', operation);
            const before = await this.queryOwn(operation), reserved = this.journal.snapshot();
            const state = C.reserveState(reserved.adv, before.devices, Math.floor(Date.now() / 1000), reserved.reservationFloor);
            this.journal.update(s => {
                s.reservationFloor = C.validateState(state);
                s.transaction = { ...s.transaction, phase: 'finish_verified', peer: qr.peer.toString('base64'), state, before: before.devices, timestampRetries: 0 };
            });
            return await this.sendPair(qr, qr, options, operation, 'qr');
        } catch (error) {
            if (started) this.markFailure(error);
            throw C.failure(error && typeof error.code === 'string' && error.code.startsWith('PRIMARY_LINK_') ? error.code : 'PRIMARY_LINK_UNCONFIRMED');
        } finally {
            qr.secret.fill(0);
            if (operation) this.end(operation);
        }
    }
    // QR and phone-code approvals share the exact same durable send, retry-ts,
    // proof and fresh-device-list checks. A convenience API cannot commit early.
    async sendPair(invitation, finish, options, operation, method) {
        let result;
        const adv = this.journal.snapshot().adv;
        for (let attempt = 0; attempt < 2; attempt++) {
            this.assertActive();
            const tx = this.journal.snapshot().transaction, id = this.client._genMsgId();
            const node = C.primaryPairNode(id, invitation, finish.peer, finish.secret, this.identity, tx.state, method);
            this.journal.update(s => { s.transaction.phase = 'pair_device_sending'; s.transaction.requestId = id; });
            result = await this.wait(this.client._sendIq(node), operation);
            this.assertActive();
            checkResponse(result, id);
            const retry = C.optionalChild(result, 'retry-ts');
            if (!retry) break;
            C.requireValue(attempt === 0 && !C.optionalChild(result, 'device'), 'PRIMARY_LINK_REPEATED_RETRY');
            const seconds = C.number(retry.attrs.ts, Number.MAX_SAFE_INTEGER);
            C.requireValue(seconds > 0 && Math.abs(seconds - Math.floor(Date.now() / 1000)) <= 86400 && seconds !== tx.state.timestamp && (!adv || seconds > adv.timestamp), 'PRIMARY_LINK_TIMESTAMP_INVALID');
            this.journal.update(s => { s.transaction.state.timestamp = seconds; s.reservationFloor = C.validateState(s.transaction.state); s.transaction.timestampRetries = 1; });
        }
        const deviceNode = C.optionalChild(result, 'device');
        if (deviceNode) {
            const expected = C.parseDevice(deviceNode.attrs.jid, this.ownPhone, this.ownLid);
            this.journal.update(s => { s.transaction.expectedDeviceId = expected.id; });
        }
        this.journal.update(s => { s.transaction.phase = 'awaiting_confirmation'; });
        this.client.emit('primary_link_progress', { phase: 'awaiting_confirmation', operationId: this.journal.snapshot().transaction.id });
        if (!options.getCompanionProof)
            return { status: 'awaiting_confirmation', operationId: this.journal.snapshot().transaction.id };
        const proof = await this.wait(options.getCompanionProof({ operationId: this.journal.snapshot().transaction.id }), operation);
        return await this.confirm(proof, operation);
    }
    async confirm(proof, operation = null) {
        this.assertActive();
        const tx = this.journal.snapshot().transaction;
        C.requireValue(tx && ['awaiting_confirmation', 'uncertain', 'pair_device_sending'].includes(tx.phase), 'PRIMARY_LINK_NO_PENDING_COMMIT');
        const device = C.verifyProof(proof, tx, this.identity, this.ownPhone, this.ownLid);
        if (tx.expectedDeviceId)
            C.requireValue(tx.expectedDeviceId === device.id, 'PRIMARY_LINK_DEVICE_UNMATCHED');
        const own = await this.queryOwn(operation);
        C.requireValue(Date.now() - own.observedAt < 10000 && own.devices.length === tx.before.length + 1, 'PRIMARY_LINK_DEVICE_LIST_UNCONFIRMED');
        for (const previous of tx.before)
            C.requireValue(own.devices.some(d => d.id === previous.id && d.keyIndex === previous.keyIndex && d.hasKeyIndex === previous.hasKeyIndex), 'PRIMARY_LINK_EXISTING_DEVICE_CHANGED');
        C.requireValue(own.devices.some(d => d.id === device.id && d.hasKeyIndex && d.keyIndex === tx.state.currentIndex), 'PRIMARY_LINK_DEVICE_LIST_UNCONFIRMED');
        this.journal.update(s => { C.requireValue(s.transaction.id === tx.id); s.adv = C.validateState(tx.state); s.transaction.phase = 'committed'; s.transaction.deviceId = device.id; s.pending = s.pending.filter(p => p.id !== tx.invitationId); });
        this.client.emit('primary_linked', { operationId: tx.id, deviceId: device.id, keyIndex: tx.state.currentIndex });
        return { status: 'linked', operationId: tx.id, deviceId: device.id, keyIndex: tx.state.currentIndex };
    }
    async reconcile(proof, options = {}) {
        const operation = this.begin(options);
        try {
            return await this.confirm(proof, operation);
        }
        catch (error) {
            throw C.failure(error && error.code && error.code.startsWith('PRIMARY_LINK_') ? error.code : 'PRIMARY_LINK_UNCONFIRMED');
        }
        finally {
            this.end(operation);
        }
    }
    close() {
        if (this.closed)
            return;
        if (this.active) {
            try {
                this.markFailure(C.failure('PRIMARY_LINK_CONNECTION_CLOSED'));
            }
            catch (_) { /* A sending reservation already remains held on disk. */ }
            this.active.stop('PRIMARY_LINK_CONNECTION_CLOSED');
        }
        this.closed = true;
        this.journal.close();
    }
}
module.exports = { PrimaryLinking, notification, restoreInvitation, checkResponse };
