'use strict';

// The history store, read back from where it was written.
//
// A companion's files carry a `.web` in the middle — 40712345678.web.history.json
// — because a number can be registered over SMS and separately linked as a
// companion, and the two are different accounts' views of it. The writer knew
// that and the readers did not, which is the quietest kind of wrong: nothing
// errors, the file is written correctly, and every read of it comes back empty.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const { WhalibmobClient } = require('../lib/Client');

const PHONE = '40712345678';

// The shape a real sync leaves behind, trimmed to what the readers look at.
const HISTORY = {
  phone: PHONE,
  syncTime: '2026-08-26T23:26:31.041Z',
  chats: {
    '40799999999@s.whatsapp.net': { id: '40799999999@s.whatsapp.net', name: 'A', messageCount: 12 }
  },
  contacts: {
    '40799999999@s.whatsapp.net': { id: '40799999999@s.whatsapp.net', name: 'A', pnJid: '40799999999@s.whatsapp.net' }
  },
  pushNames: { '40799999999@s.whatsapp.net': 'A' },
  lidPnMap:  {},
  pnLidMap:  {}
};
const MESSAGES = { ABC123: { id: 'ABC123', chatId: '40799999999@s.whatsapp.net', fromMe: false } };

function session(mode, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whalib-hist-'));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(body), 'utf8');
  }
  const client = Object.assign(Object.create(WhalibmobClient.prototype), {
    _store: { phoneNumber: PHONE },
    _sessionDir: dir,
    _mode: mode
  });
  return { client, dir };
}

test('a companion reads the history it wrote, under .web', () => {
  const { client } = session('web', {
    [PHONE + '.web.history.json']:  HISTORY,
    [PHONE + '.web.messages.json']: MESSAGES
  });

  const hist = client.getHistoryStore();
  assert.ok(hist, 'the file the companion wrote is found');
  assert.equal(Object.keys(hist.contacts).length, 1);
  assert.equal(Object.keys(client.getMessagesStore()).length, 1);
});

test('an SMS session still reads the plain files', () => {
  const { client } = session('mobile', {
    [PHONE + '.history.json']:  HISTORY,
    [PHONE + '.messages.json']: MESSAGES
  });

  assert.ok(client.getHistoryStore());
  assert.ok(client.getMessagesStore());
});

test('the two halves of one number do not read each other', () => {
  // Both registered over SMS and linked as a companion, with different
  // histories. Each side must see only its own.
  const smsOnly = { ...HISTORY, contacts: {}, chats: {} };
  const { dir } = session('web', {
    [PHONE + '.history.json']:     smsOnly,
    [PHONE + '.web.history.json']: HISTORY
  });

  const asWeb = Object.assign(Object.create(WhalibmobClient.prototype),
    { _store: { phoneNumber: PHONE }, _sessionDir: dir, _mode: 'web' });
  const asSms = Object.assign(Object.create(WhalibmobClient.prototype),
    { _store: { phoneNumber: PHONE }, _sessionDir: dir, _mode: 'mobile' });

  assert.equal(Object.keys(asWeb.getHistoryStore().contacts).length, 1, 'companion sees its own');
  assert.equal(Object.keys(asSms.getHistoryStore().contacts).length, 0, 'the SMS half sees its own');
});

test('a session with nothing synced yet reads as null, not as a throw', () => {
  const { client } = session('web', {});
  assert.equal(client.getHistoryStore(), null);
  assert.equal(client.getMessagesStore(), null);
});

test('the prefix is what the writer and the readers agree on', () => {
  const web = Object.assign(Object.create(WhalibmobClient.prototype),
    { _store: { phoneNumber: PHONE }, _mode: 'web' });
  const sms = Object.assign(Object.create(WhalibmobClient.prototype),
    { _store: { phoneNumber: PHONE }, _mode: 'mobile' });
  const none = Object.assign(Object.create(WhalibmobClient.prototype), { _store: null });

  assert.equal(web._sessionFilePrefix(), PHONE + '.web');
  assert.equal(sms._sessionFilePrefix(), PHONE);
  assert.equal(none._sessionFilePrefix(), null, 'no number, no prefix');
});
