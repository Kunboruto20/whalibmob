'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { COMMANDS } = require('../lib/cli/linkCommands');

// The shell's help has to list every link command, and every command the link
// messages send a person to has to exist in the shell. The owner was handed
// commands that did not work as typed; a message naming one that /help does
// not list, or that the shell answers with "unknown command", is the same
// mistake made by the program instead of by a person.
//
// cli.js starts its main() as it loads, so it is read as text here.

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'cli.js'), 'utf8');

function helpBlock() {
  const m = /\nconst HELP = `([\s\S]*?)`\.trim\(\);/.exec(SOURCE);
  assert.ok(m, 'the HELP block was not found in cli.js');
  return m[1];
}

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A command is listed when a help line starts with it, as every entry does.
const helpLine = (help, cmd) => help.split('\n').find(l => new RegExp('^\\s*' + escape(cmd) + '(\\s|$)').test(l));
const dispatched = cmd => SOURCE.includes("case '" + cmd + "':");

// The command set of the link spec (6.9).
const LINK = [
  ['/link-code',        /CODE\s+\[n\|id\]/],
  ['/link-qr',          /PAYLOAD/],
  ['/link-invitations', null],
  ['/link-status',      null],
  ['/linked-devices',   null],
  ['/link-retire',      null],
  ['/link-confirm',     /FILE\|JSON/],
  ['/link-bootstrap',   /\[--resume\]\s+\[--resend-uncertain\]/],
  ['/link-unlock',      null]
];

test('HELP lists all nine link commands, each with its arguments', () => {
  const help = helpBlock();
  for (const [cmd, args] of LINK) {
    const line = helpLine(help, cmd);
    assert.ok(line, cmd + ' is not listed in HELP');
    if (args) assert.match(line, args, cmd + ' is listed without its arguments');
  }
});

test('every link command is dispatched by the shell', () => {
  for (const [cmd] of LINK) assert.ok(dispatched(cmd), cmd + ' has no case in handleLine');
});

test('every command a link message names is listed in HELP and dispatched', () => {
  const help = helpBlock();
  const named = new Set(Object.values(COMMANDS).map(c => c.split(' ')[0]));
  for (const cmd of named) {
    assert.ok(helpLine(help, cmd), cmd + ' is named by a link message but not listed in HELP');
    assert.ok(dispatched(cmd), cmd + ' is named by a link message but the shell does not know it');
  }
});
