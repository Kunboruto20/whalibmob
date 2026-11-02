'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { version } = require('../package.json');

// How the CLI reads the authentication folder from its arguments and environment.
// This is main()'s own argument handling, so it is run for real rather than
// imported: cli.js starts main() as it loads.

const CLI = path.join(__dirname, '..', 'cli.js');
const REFUSAL = 'error: --session needs a directory, e.g. --session ./sessions';

// The CLI in a throwaway home and working directory. HOME, WA_SESSION_DIR and the
// cwd all point at it, so nothing here can reach the real home or the folder
// remembered in ~/.whalibmob.json, and the commands used (version,
// migrate-sessions) are ones that never open a connection.
function runCli(args, env) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-session-dir-')));
  try {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      cwd: home,
      env: Object.assign({ PATH: process.env.PATH, HOME: home, USERPROFILE: home, WA_SESSION_DIR: home }, env),
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

// A flag with nothing after it parses as `true`, and so does an empty value,
// which is what `--session "$DIR"` turns into when $DIR is unset. Neither names a
// folder. Compared by whole line so a Node warning on stderr cannot break it.
const REFUSED = [
  ['with nothing after it', ['version', '--session']],
  ['with an empty value, as an unset $DIR leaves it', ['version', '--session', '']],
  ['with a blank value', ['version', '--session', '   ']]
];

for (const [what, args] of REFUSED) {
  test(`--session ${what} is refused with a plain message`, () => {
    const r = runCli(args);
    assert.equal(r.status, 1, dump(r));
    assert.ok(lines(r.stderr).includes(REFUSAL), dump(r));
    assert.doesNotMatch(r.stderr, /TypeError|ERR_INVALID_ARG_TYPE|^\s+at /m, dump(r));
    assert.ok(!lines(r.stdout).includes(version), 'the command ran anyway\n' + dump(r));
  });
}

test('--session with a directory is accepted', () => {
  const r = runCli(['version', '--session', './sessions']);
  assert.equal(r.status, 0, dump(r));
  assert.ok(lines(r.stdout).includes(version), dump(r));
  assert.doesNotMatch(r.stderr, /^error:/m, dump(r));
});

test('an empty WA_SESSION_DIR is treated as unset', () => {
  const r = runCli(['migrate-sessions'], { WA_SESSION_DIR: '' });
  assert.equal(r.status, 0, dump(r));
  // Unset means the home default, which here is the throwaway home.
  assert.ok(r.stdout.includes(path.join(r.home, '.waSession')), dump(r));
});
