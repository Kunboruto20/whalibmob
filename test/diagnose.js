'use strict';

// Live protocol diagnostic — run this on YOUR machine, on your normal
// (residential/mobile) IP, with your own session. It connects, issues the
// queries whose response shapes this library depends on, and dumps the raw
// node structures so mismatches are obvious.
//
//   node test/diagnose.js <phone> [sessionDir]
//
// e.g.  node test/diagnose.js 919634847671 ~/.waSession
//
// It only READS: a device query, the group list, and metadata for the first
// group. It sends no messages and changes nothing on the account.
//
// The `--probe-group-addressing` flag additionally sends one group-service
// IQ addressed as '@g.us' instead of 'g.us', to settle which form the server
// accepts. It is a read-only 'get' — it still creates nothing.

const path = require('path');
const util = require('util');

const phone      = process.argv[2];
const sessionDir = process.argv[3] || path.join(process.env.HOME || '.', '.waSession');
const probeAddressing = process.argv.includes('--probe-group-addressing');

if (!phone) {
  console.error('usage: node test/diagnose.js <phone> [sessionDir] [--probe-group-addressing]');
  process.exit(1);
}

const { WhalibmobClient } = require('../lib/Client');
const { BinaryNode } = require('../lib/BinaryNode');

// Render a BinaryNode tree as readable XML-ish text.
function render(node, indent = '') {
  if (node == null) return indent + '(null)';
  if (Buffer.isBuffer(node)) {
    const s = node.toString('utf8');
    const printable = /^[\x20-\x7e\s]*$/.test(s);
    return indent + (printable ? JSON.stringify(s) : `<${node.length} bytes hex:${node.toString('hex').slice(0, 48)}>`);
  }
  if (Array.isArray(node)) return node.map(n => render(n, indent)).join('\n');
  if (typeof node !== 'object' || !node.description) return indent + util.inspect(node);

  const attrs = Object.entries(node.attrs || {})
    .map(([k, v]) => ` ${k}='${v}'`).join('');
  if (node.content == null) return `${indent}<${node.description}${attrs}/>`;
  return `${indent}<${node.description}${attrs}>\n` +
         render(node.content, indent + '  ') +
         `\n${indent}</${node.description}>`;
}

function section(title) {
  console.log('\n' + '='.repeat(72));
  console.log(title);
  console.log('='.repeat(72));
}

(async () => {
  const client = new WhalibmobClient({ sessionDir });

  const connected = new Promise((resolve, reject) => {
    client.on('connected', resolve);
    client.on('error', reject);
    setTimeout(() => reject(new Error('timed out waiting for connection')), 60000);
  });

  console.log(`connecting as ${phone} (session: ${sessionDir}) ...`);
  await client.init(phone);
  await connected;
  console.log('connected.');

  // ── 1. Device enumeration (the multi-device fanout fix) ──────────────────
  section('1. USync device query — raw response');
  console.log('This is the response the linked-device fanout depends on.');
  console.log('Expect: <user jid=...><devices><device-list><device id=.. key-index=..>\n');

  const ownUser = String(phone).replace(/\D/g, '');
  const iqId = client._genMsgId();
  const sid  = client._genMsgId();
  const usyncIq = new BinaryNode('iq',
    { id: iqId, to: 's.whatsapp.net', type: 'get', xmlns: 'usync' },
    [new BinaryNode('usync',
      { sid, mode: 'query', last: 'true', index: '0', context: 'message' },
      [
        new BinaryNode('query', {}, [new BinaryNode('devices', { version: '2' }, null)]),
        new BinaryNode('list', {}, [new BinaryNode('user', { jid: ownUser + '@s.whatsapp.net' }, null)]),
      ])]
  );
  const usyncResp = await client._sendIq(usyncIq).catch(e => ({ error: e.message }));
  console.log(render(usyncResp));

  console.log('\n--- parsed by the current DeviceManager ---');
  const devJids = await client._devMgr._usyncGetDevices([ownUser]).catch(e => ['ERROR: ' + e.message]);
  console.log(devJids.join('\n'));
  console.log(devJids.length > 1
    ? `\n=> ${devJids.length} devices enumerated (fanout will reach linked devices)`
    : '\n=> ONLY ONE DEVICE — if this account has linked devices, enumeration is still wrong');

  // ── 2. Group list (the <groups> wrapper fix) ─────────────────────────────
  section('2. fetchAllGroups — raw response');
  console.log('Expect the groups to sit inside a <groups> wrapper.\n');

  const grpIq = new BinaryNode('iq',
    { id: client._genMsgId(), to: 'g.us', type: 'get', xmlns: 'w:g2' },
    [new BinaryNode('participating', {}, [
      new BinaryNode('participants', {}, null),
      new BinaryNode('description', {}, null),
    ])]
  );
  const grpResp = await client._sendIq(grpIq).catch(e => ({ error: e.message }));
  const rendered = render(grpResp);
  // Groups can be numerous — cap the dump but always show the structure.
  console.log(rendered.length > 6000 ? rendered.slice(0, 6000) + '\n... (truncated)' : rendered);

  console.log('\n--- parsed by the current client ---');
  const groups = await client.fetchAllGroups().catch(e => { console.log('ERROR:', e.message); return []; });
  console.log(`fetchAllGroups returned ${groups.length} group(s)`);
  for (const g of groups.slice(0, 10)) {
    console.log(`  ${g.jid}  subject=${JSON.stringify(g.subject)}  addressing=${g.addressingMode}  participants=${g.participants.length}`);
  }

  // ── 3. Group metadata + participant addressing ───────────────────────────
  if (groups.length > 0) {
    section('3. Group metadata for ' + groups[0].jid);
    const meta = await client.getGroupMetadata(groups[0].jid).catch(e => ({ error: e.message }));
    if (meta && meta.participants) {
      console.log(`addressingMode = ${meta.addressingMode}`);
      console.log(`descId         = ${meta.descId}`);
      const lidCount = meta.participants.filter(p => p.jid.endsWith('@lid')).length;
      console.log(`participants   = ${meta.participants.length} (${lidCount} on @lid)`);
      console.log('\nfirst few participants:');
      for (const p of meta.participants.slice(0, 8)) console.log('  ' + p.jid + '  role=' + p.role);
      if (lidCount > 0) {
        console.log('\n=> This group uses LID addressing. Before the fix, LID members');
        console.log('   without a phone mapping were dropped from the sender-key list.');
      }
    } else {
      console.log(util.inspect(meta));
    }
  } else {
    section('3. Group metadata — SKIPPED (no groups found)');
    console.log('If this account IS in groups, the group list query is still wrong.');
  }

  // ── 4. Optional: settle the g.us vs @g.us question ───────────────────────
  if (probeAddressing) {
    section('4. Group-service addressing probe: "g.us" vs "@g.us"');
    console.log('Baileys addresses group-service IQs to "@g.us"; this library uses "g.us".');
    console.log('Both are read-only "get" queries here — nothing is created.\n');

    for (const to of ['g.us', '@g.us']) {
      const probe = new BinaryNode('iq',
        { id: client._genMsgId(), to, type: 'get', xmlns: 'w:g2' },
        [new BinaryNode('participating', {}, [new BinaryNode('participants', {}, null)])]
      );
      const r = await client._sendIq(probe).catch(e => ({ error: e.message }));
      const ok = r && !r.error && r.description;
      console.log(`to='${to}' -> ${ok ? 'RESPONSE ' + r.description : 'NO/ERROR ' + util.inspect(r).slice(0, 200)}`);
    }
  }

  section('Done');
  console.log('Paste this output back (redact phone numbers / group ids if you like —');
  console.log('the node structure is what matters).');

  try { client.close && client.close(); } catch (_) {}
  process.exit(0);
})().catch(err => {
  console.error('\nDIAGNOSTIC FAILED:', err && err.stack || err);
  process.exit(1);
});
