'use strict';

// The contract between index.js and index.d.ts.
//
// Types drift silently: someone adds an export and forgets the declaration, or
// renames a method and leaves a declaration behind that promises something the
// runtime does not have. The second kind is worse — it type-checks and then
// throws at runtime. These tests make both fail in CI instead.

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');

const pkg  = require('../package.json');
const lib  = require('../index.js');

const DTS_PATH = path.join(__dirname, '..', 'index.d.ts');
const dts = fs.readFileSync(DTS_PATH, 'utf8');

/** Top-level names index.d.ts declares as values (not types or interfaces). */
function declaredValues(source) {
  const names = new Set();
  const re = /^export declare (?:function|const|class) ([A-Za-z_][A-Za-z0-9_]*)/gm;
  let m;
  while ((m = re.exec(source)) !== null) names.add(m[1]);
  return names;
}

/** Method names declared inside the WhalibmobClient class block. */
function declaredClientMethods(source) {
  const start = source.indexOf('export declare class WhalibmobClient');
  assert.notEqual(start, -1, 'the client class is declared');
  // The block ends at the first line that closes it at column zero.
  const end = source.indexOf('\n}', start);
  assert.notEqual(end, -1, 'the client class block is closed');

  const body = source.slice(start, end);
  const names = new Set();
  // Two leading spaces, a name, then either "(" or a generic "<".
  const re = /^ {2}([a-zA-Z_][a-zA-Z0-9_]*)\s*[(<]/gm;
  let m;
  while ((m = re.exec(body)) !== null) {
    if (m[1] !== 'constructor') names.add(m[1]);
  }
  return names;
}

test('package.json points at the declarations', () => {
  assert.equal(pkg.types, 'index.d.ts');
});

test('the declarations are actually published', () => {
  // Without this the file exists in git and is missing from the tarball, which
  // is the failure mode nobody notices until a consumer reports "no types".
  assert.ok(
    pkg.files.includes('index.d.ts'),
    'index.d.ts must be listed in package.json "files"'
  );
  assert.ok(fs.existsSync(DTS_PATH), 'index.d.ts exists on disk');
});

test('every runtime export has a declaration', () => {
  const runtime  = Object.keys(lib).sort();
  const declared = declaredValues(dts);

  const missing = runtime.filter(name => !declared.has(name));
  assert.deepEqual(
    missing, [],
    'these are exported from index.js but not declared in index.d.ts'
  );
});

test('no declaration promises something the runtime does not export', () => {
  // A phantom declaration compiles and then throws "is not a function".
  const runtime  = new Set(Object.keys(lib));
  const declared = [...declaredValues(dts)].sort();

  const phantom = declared.filter(name => !runtime.has(name));
  assert.deepEqual(
    phantom, [],
    'these are declared in index.d.ts but not exported from index.js'
  );
});

test('every method declared on WhalibmobClient exists on the class', () => {
  const declared = declaredClientMethods(dts);
  assert.ok(declared.size > 50, `expected a substantial method list, got ${declared.size}`);

  // One instance for the whole check: the filter runs per declared method, and
  // building a client each time is ~110 constructions for no gain.
  const probe = new lib.WhalibmobClient({ sessionDir: '/tmp/whalibmob-test-not-created' });
  const missing = [...declared].filter(name => {
    const onPrototype = typeof lib.WhalibmobClient.prototype[name] === 'function';
    // on/once/off/emit and friends come from EventEmitter.
    const inherited = typeof probe[name] === 'function';
    return !onPrototype && !inherited;
  }).sort();

  assert.deepEqual(missing, [], 'declared on the class but absent at runtime');
});

test('the client exposes the methods the README documents', () => {
  // A spot-check across every area, so a rename cannot quietly break the docs.
  const documented = [
    'init', 'connect', 'connectWeb', 'requestPairingCode', 'disconnect',
    'sendText', 'sendImage', 'sendVideo', 'sendAudio', 'sendDocument',
    'sendSticker', 'sendReaction', 'sendPoll', 'sendLocation', 'sendContact',
    'sendReply', 'sendStatus', 'forwardMessage', 'editMessage', 'deleteMessage',
    'downloadMedia', 'requestMediaRetry', 'decryptMediaRetry',
    'markRead', 'markMessagePlayed', 'setOnline', 'setChatPresence', 'subscribeToPresence',
    'hasWhatsapp', 'queryAbout', 'queryOwnAbout', 'queryPicture', 'queryBusinessProfile',
    'changeName', 'changeAbout', 'changeProfilePicture',
    'queryPrivacySettings', 'changePrivacySetting', 'blockContact', 'unblockContact',
    'queryBlockList', 'queryStatusPrivacy',
    'markChatRead', 'markChatUnread', 'muteChat', 'unmuteChat', 'pinChat', 'unpinChat',
    'archiveChat', 'unarchiveChat', 'starMessage', 'unstarMessage',
    'changeEphemeralTimer', 'changeNewChatsEphemeralTimer',
    'syncAppState', 'canSyncAppState',
    'fetchReachoutTimelock', 'getReachoutTimelock',
    'createGroup', 'leaveGroup', 'getGroupMetadata', 'fetchAllGroups',
    'addGroupParticipants', 'removeGroupParticipants', 'promoteGroupParticipants',
    'demoteGroupParticipants', 'addGroupParticipantsOrInvite',
    'changeGroupSubject', 'changeGroupDescription', 'changeGroupPicture', 'changeGroupSetting',
    'queryGroupInviteLink', 'revokeGroupInvite', 'acceptGroupInvite', 'queryGroupInviteInfo',
    'queryGroupPendingParticipants', 'approveGroupParticipants',
    'sendGroupInvite', 'queryGroupInviteMessageInfo', 'acceptGroupInviteMessage',
    'createCommunity', 'deactivateCommunity', 'linkGroupsToCommunity', 'unlinkGroupFromCommunity',
    'createNewsletter', 'joinNewsletter', 'leaveNewsletter', 'queryNewsletterMetadata',
    'changeNewsletterDescription', 'sendNewsletterText',
    'createCallLink', 'sendCallLink',
    'getHistoryStore', 'getMessagesStore', 'checkSessionAlive', 'adoptCanonicalNumber'
  ];

  const missing = documented.filter(m => typeof lib.WhalibmobClient.prototype[m] !== 'function');
  assert.deepEqual(missing, [], 'documented in the README but missing from the client');
});

test('the top-level helpers the README tells people to require are callable', () => {
  for (const name of [
    'createNewStore', 'initAuthCreds', 'saveStore', 'loadStore',
    'requestSmsCode', 'verifyCode', 'checkNumberStatus', 'checkIfRegistered',
    'receivePushCode', 'supportsPush',
    'makeCacheableSignalKeyStore', 'addTransactionCapability', 'assertMeId',
    'fetchWaWebVersion', 'currentVersionFor', 'refreshSessionVersion',
    'defaultBaseDir', 'sessionDirFor', 'storeFileFor', 'webStoreFileFor',
    'listSessions', 'migrateSession', 'getDeviceConfig',
    'makeJid', 'generateMessageId', 'encryptMedia', 'decryptMedia'
  ]) {
    assert.equal(typeof lib[name], 'function', `${name} should be a function`);
  }
});

test('a client can be constructed without touching the network', () => {
  const client = new lib.WhalibmobClient({ sessionDir: '/tmp/whalibmob-test-not-created' });
  assert.equal(client._mode, 'mobile', 'the default mode is the SMS-registered primary');
  assert.equal(typeof client.on, 'function', 'it is an EventEmitter');
});

test('sending before connecting fails loudly rather than silently', async () => {
  const client = new lib.WhalibmobClient({ sessionDir: '/tmp/whalibmob-test-not-created' });
  await assert.rejects(() => client.sendText('919634847671', 'hi'), /not connected/i);
});

test('the CLI entry point is declared and present', () => {
  assert.equal(pkg.bin.wa, './cli.js');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'cli.js')));
});
