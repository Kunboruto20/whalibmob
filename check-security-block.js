#!/usr/bin/env node
'use strict';

const readline = require('readline');
const { createNewStore } = require('./lib/Store');
const { checkIfRegistered } = require('./lib/Registration');

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', gray: '\x1b[90m'
};

function paint(c, s) { return c + s + C.reset; }

function classify(r) {
  if (!r) return { code: 'unknown', label: 'UNKNOWN', color: C.gray, note: 'No response. Possible datacenter IP block — try a residential proxy.' };
  if (r.custom_block_screen) {
    const body = (r.custom_block_screen && r.custom_block_screen.body) || 'flagged by WhatsApp security';
    return { code: 'security_block', label: 'SECURITY BLOCK', color: C.red, note: String(body) };
  }
  if (r.status === 'ok') return { code: 'registered', label: 'REGISTERED (no block)', color: C.green, note: 'Number owns a session / is on WhatsApp.' };
  if (r.reason === 'incorrect') return { code: 'not_registered', label: 'NOT REGISTERED', color: C.yellow, note: 'Keys not found — number is free / not on WhatsApp.' };
  const reason = r.reason || r.status || 'unknown';
  if (reason === 'no_routes') return { code: 'no_routes', label: 'NO ROUTES', color: C.yellow, note: 'WhatsApp has no delivery route right now.' };
  return { code: 'unknown', label: 'UNKNOWN', color: C.gray, note: 'Reason: ' + reason + '. Possible IP restriction — try a residential proxy.' };
}

async function checkOne(raw) {
  const num = String(raw).replace(/\D/g, '');
  if (!num) return null;
  const store = createNewStore(num);
  let res;
  try {
    res = await checkIfRegistered(store);
  } catch (e) {
    const m = String(e && e.message || e);
    if (/security block/i.test(m)) return { num, out: { code: 'security_block', label: 'SECURITY BLOCK', color: C.red, note: m } };
    return { num, out: { code: 'error', label: 'ERROR', color: C.gray, note: m } };
  }
  return { num, out: classify(res) };
}

function line(num, out) {
  const tag = paint(out.color + C.bold, out.label.padEnd(22));
  return paint(C.cyan, ('+' + num).padEnd(16)) + ' ' + tag + ' ' + paint(C.dim, out.note);
}

async function run(input) {
  const nums = String(input).split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
  for (const n of nums) {
    process.stdout.write(paint(C.gray, '  checking +' + n.replace(/\D/g, '') + ' ...') + '\n');
    const r = await checkOne(n);
    if (!r) { process.stdout.write(paint(C.gray, '  (skipped empty)\n')); continue; }
    process.stdout.write('  ' + line(r.num, r.out) + '\n');
  }
}

function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: paint(C.bold + C.cyan, 'number> ') });
  process.stdout.write('\n' + paint(C.bold, '  whalibmob security-block checker') + '\n');
  process.stdout.write(paint(C.dim, '  /exist only — never sends SMS. Enter one or more numbers. Ctrl+C to exit.') + '\n\n');
  rl.prompt();
  rl.on('line', async (l) => {
    const s = l.trim();
    if (s === '') { rl.prompt(); return; }
    if (s === 'exit' || s === 'quit') { rl.close(); return; }
    try { await run(s); } catch (e) { process.stdout.write(paint(C.red, '  error: ' + (e && e.message || e)) + '\n'); }
    process.stdout.write('\n');
    rl.prompt();
  });
  rl.on('close', () => { process.stdout.write('\n'); process.exit(0); });
}

main();
