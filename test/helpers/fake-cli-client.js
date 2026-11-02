'use strict';

// A stand-in for WhalibmobClient, so cli.js can be driven end to end with no
// network:
//
//   WA_FAKE_CLIENT=<scenario.json> node -r test/helpers/fake-cli-client.js cli.js ...
//
// cli.js takes WhalibmobClient (and verifyCode) out of lib/Client as it loads,
// so this preload swaps them first. The scenario says what each client method
// answers, and every call the CLI makes is appended to scenario.log as one
// JSON line, for the test to read back. stderr is written to stdout, so what
// the CLI prints arrives in the order it printed it.
//
// Scenario:
//   log           file the calls are appended to
//   invitations   [{ id, companion, expiresIn }]: pending at connect, each
//                 announced with 'primary_link_invitation'
//   onConnect     [[event, payload], ...] emitted after them
//   answers       { method: [answer, ...] }, taken in order, the last one kept;
//                 an answer is { result } or { error: { code, ... } }, with
//                 optional emit: [[event, payload], ...] sent first
//   verify        what verifyCode resolves with
//   storeOpenError  a code PrimaryMessageStore.open throws, for a store that
//                 will not open
//
// `node --test` runs every .js under test/, helpers included, so without
// WA_FAKE_CLIENT this does nothing at all.

if (process.env.WA_FAKE_CLIENT) install(process.env.WA_FAKE_CLIENT);

function install(file) {
  const fs = require('node:fs');
  const path = require('node:path');
  const { EventEmitter } = require('node:events');
  const lib = require(path.join(__dirname, '..', '..', 'lib', 'Client'));
  const scenario = JSON.parse(fs.readFileSync(file, 'utf8'));

  process.stderr.write = process.stdout.write.bind(process.stdout);

  // Buffers (a parsed proof) are logged as base64.
  const replacer = (key, value) =>
    (value && value.type === 'Buffer' && Array.isArray(value.data) ? Buffer.from(value.data).toString('base64') : value);
  const log = (method, args) => fs.appendFileSync(scenario.log, JSON.stringify({ method, args }, replacer) + '\n');

  let invitations = [];

  function answer(client, method, args) {
    log(method, args);
    const list = (scenario.answers || {})[method];
    if (!list || !list.length) throw new Error('fake client: no answer for ' + method);
    const next = list.length > 1 ? list.shift() : list[0];
    for (const [event, payload] of next.emit || []) client.emit(event, payload);
    if (next.error) throw Object.assign(new Error(next.error.message || next.error.code), next.error);
    return next.result;
  }

  class FakeClient extends EventEmitter {
    constructor(opts) {
      super();
      log('constructor', [opts]);
      this.connected = false;
      this._mode = null;
      this._store = null;
    }

    get store() { return this._store; }

    _open(mode, phone) {
      this._mode = mode;
      this._store = { phoneNumber: phone, name: 'Owner' };
      this.connected = true;
      setImmediate(() => {
        this.emit('connected');
        const now = Date.now();
        invitations = (scenario.invitations || []).map(i => ({ id: i.id, expiresAt: now + i.expiresIn, companion: i.companion }));
        for (const invitation of invitations) this.emit('primary_link_invitation', invitation);
        for (const [event, payload] of scenario.onConnect || []) this.emit(event, payload);
      });
    }

    async init(phone) { log('init', [phone]); this._open('mobile', phone); }
    async connectWeb(phone) { log('connectWeb', [phone]); this._open('web', phone); }
    disconnect() { log('disconnect', []); this.connected = false; }

    getPrimaryLinkInvitations() { log('getPrimaryLinkInvitations', []); return invitations; }
    async getPrimaryLinkReadiness() { return answer(this, 'getPrimaryLinkReadiness', []); }
    async approveCompanionCode(code, options) { return answer(this, 'approveCompanionCode', [code, options]); }
    async approveCompanionQr(payload, options) { return answer(this, 'approveCompanionQr', [payload, options]); }
    async bootstrapPrimaryCompanion(options) { return answer(this, 'bootstrapPrimaryCompanion', [options]); }
    async getPrimaryLinkStatus() { return answer(this, 'getPrimaryLinkStatus', []); }
    async retireAbsentPrimaryLink(options) { return answer(this, 'retireAbsentPrimaryLink', [options]); }
    async reconcilePrimaryLink(proof, options) { return answer(this, 'reconcilePrimaryLink', [proof, options]); }
    unlockPrimaryLink() { return answer(this, 'unlockPrimaryLink', []); }
  }

  lib.WhalibmobClient = FakeClient;
  if (scenario.storeOpenError) {
    const { PrimaryMessageStore } = require(path.join(__dirname, '..', '..', 'lib', 'primary', 'MessageStore'));
    PrimaryMessageStore.open = () => { throw Object.assign(new Error(scenario.storeOpenError), { code: scenario.storeOpenError }); };
  }
  if (scenario.verify) {
    lib.verifyCode = async (store, code) => { log('verifyCode', [code]); return scenario.verify; };
  }
}
