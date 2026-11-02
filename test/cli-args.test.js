'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { version } = require('../package.json');

// How `wa` reads its options. Three ways of typing one were quietly wrong:
// `--session=./dir` was taken as a flag named "session=./dir" and ignored,
// `wa connect --no-message-store <phone>` handed the phone to the flag as its
// value, and `wa --session <dir> connect ...` read "--session" as the command.
//
// main() runs as cli.js loads, so the CLI is run for real, in a throwaway home
// with no network: every command used here stops before a connection (version,
// help, migrate-sessions, and connect for a number with no session on disk).

const CLI = path.join(__dirname, '..', 'cli.js');
const REFUSAL = 'error: --session needs a directory, e.g. --session ./sessions';
const PHONE = '447911123456';
const NO_SESSION = 'error: no session for +' + PHONE;

function runCli(args) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-args-')));
  try {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      cwd: home,
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, WA_SESSION_DIR: home },
      encoding: 'utf8',
      timeout: 20000
    });
    if (r.error) throw r.error;
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, home };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}
const lines = (text) => text.split(/\r?\n/);
const dump = (r) => 'exit ' + r.status + '\nstdout: ' + r.stdout + '\nstderr: ' + r.stderr;
// migrate-sessions names the folder it looked in, which is the folder chosen.
const usedFolder = (r, dir) => r.stdout.includes('every session in ' + dir + ' already has its own folder');

test('--session=<dir> is the same as --session <dir>', () => {
  for (const args of [['migrate-sessions', '--session=./sessions'], ['migrate-sessions', '--session', './sessions']]) {
    const r = runCli(args);
    assert.equal(r.status, 0, dump(r));
    assert.ok(usedFolder(r, path.join(r.home, 'sessions')), args.join(' ') + '\n' + dump(r));
  }
});

test('--session= with nothing after the = is refused like a bare --session', () => {
  for (const args of [['version', '--session='], ['--session=', 'version']]) {
    const r = runCli(args);
    assert.equal(r.status, 1, dump(r));
    assert.ok(lines(r.stderr).includes(REFUSAL), dump(r));
    assert.ok(!lines(r.stdout).includes(version), 'the command ran anyway\n' + dump(r));
  }
});

test('options typed before the command are read as options', () => {
  for (const args of [['--session', './sessions', 'migrate-sessions'], ['--session=./sessions', 'migrate-sessions']]) {
    const r = runCli(args);
    assert.equal(r.status, 0, dump(r));
    assert.doesNotMatch(r.stderr, /unknown command/, dump(r));
    assert.ok(usedFolder(r, path.join(r.home, 'sessions')), args.join(' ') + '\n' + dump(r));
  }
  const r = runCli(['--no-message-store', 'connect', PHONE]);
  assert.equal(r.status, 1, dump(r));
  assert.ok(lines(r.stderr).includes(NO_SESSION), dump(r));
});

test('--version and --help still work, alone or after options', () => {
  for (const args of [['--version'], ['-v'], ['--session', './sessions', '--version']]) {
    const r = runCli(args);
    assert.equal(r.status, 0, dump(r));
    assert.ok(lines(r.stdout).includes(version), args.join(' ') + '\n' + dump(r));
  }
  for (const args of [['--help'], ['--session=./sessions', '--help']]) {
    const r = runCli(args);
    assert.equal(r.status, 0, dump(r));
    assert.match(r.stdout, /^usage:/m, args.join(' ') + '\n' + dump(r));
  }
});

test('a switch never takes the next argument as its value', () => {
  // The phone after the switch is still the phone: the command gets as far as
  // looking for its session, instead of reporting that no number was given.
  for (const args of [
    ['connect', '--no-message-store', PHONE],
    ['connect', PHONE, '--no-message-store'],
    ['connect', '--business', PHONE],
    ['connect', '--no-message-store=true', PHONE]
  ]) {
    const r = runCli(args);
    assert.equal(r.status, 1, dump(r));
    assert.ok(lines(r.stderr).includes(NO_SESSION), args.join(' ') + '\n' + dump(r));
    assert.doesNotMatch(r.stderr, /phone number required/, dump(r));
  }
});

test('a switch given a value it cannot mean is refused, not guessed at', () => {
  const r = runCli(['connect', PHONE, '--no-message-store=maybe']);
  assert.equal(r.status, 1, dump(r));
  assert.ok(lines(r.stderr).includes('error: --no-message-store is a switch and takes no value (got "maybe")'), dump(r));
  assert.doesNotMatch(r.stderr, /no session for/, 'the command ran anyway\n' + dump(r));
});

test('the usage text names --no-message-store and both ways of giving a value', () => {
  const r = runCli(['help']);
  assert.equal(r.status, 0, dump(r));
  assert.match(r.stdout, /^\s+--no-message-store\s/m, dump(r));
  assert.match(r.stdout, /--session=<dir>/, dump(r));
});
