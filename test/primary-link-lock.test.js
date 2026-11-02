'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');
const { PrimaryLinkStore } = require('../lib/PrimaryLinkStore');
const { WhalibmobClient } = require('../lib/Client');
const { createNewStore } = require('../lib/Store');

// The primary link journal is guarded by a lock file. A process that crashed
// used to leave that file behind, and every later link attempt failed with
// PRIMARY_LINK_STORE_BUSY until someone deleted it by hand.
//
// Taking a lock over is only safe when its owner is provably gone: a paused
// owner is alive, an owner on another host cannot be checked, two recoverers
// can race, and an owner that lost its lock can still try to write. So a lock
// is taken over automatically only from a dead process on this same boot of
// this same host, through a single-winner mutex, and every journal write checks
// that the lock and the journal's generation are still this owner's. Anything
// else stays BUSY until an operator breaks the lock explicitly.

const STORE = path.join(__dirname, '..', 'lib', 'PrimaryLinkStore.js');
const BINDING = 'synthetic-binding';
const RECEIPT = 'a'.repeat(64);

function scratch(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'primary-link-lock-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'journal.json');
    return { dir, file, lock: file + '.lock' };
}

// The other process. It is passed to `node -e` rather than kept as a file under
// test/, so `node --test` never runs it on its own. 'crash' opens the store and
// dies without closing it; 'hold' opens it and waits for commands on stdin;
// 'die-in-takeover' is a recoverer killed while it holds the takeover mutex.
function child() {
    const fs = require('node:fs');
    const [storeModule, file, binding, mode] = process.argv.slice(1);
    const { PrimaryLinkStore } = require(storeModule);
    // Synchronous, so nothing is still buffered when the process is killed.
    const say = line => fs.writeSync(1, line + '\n');
    if (mode === 'die-in-takeover') {
        new PrimaryLinkStore(file, binding, { hooks: { beforeTakeoverRename() {
            say(JSON.stringify({ pid: process.pid }));
            process.kill(process.pid, 'SIGKILL');
        } } });
        return;
    }
    const store = new PrimaryLinkStore(file, binding);
    if (mode === 'crash') {
        say(JSON.stringify({ pid: process.pid, token: store.token, gen: store.gen }));
        process.kill(process.pid, 'SIGKILL');
    }
    else {
        say('ready');
        require('node:readline').createInterface({ input: process.stdin })
            .on('line', command => {
                if (command === 'update') {
                    try {
                        store.update(s => { s.receipts = [...s.receipts, 'c'.repeat(64)]; });
                        say('wrote');
                    }
                    catch (error) {
                        say('error ' + error.code);
                    }
                }
                else if (command === 'close') {
                    store.close();
                    say('closed');
                }
            })
            .on('close', () => process.exit(0));
    }
}
const CHILD = '(' + child + ')()';

// A process that opened the store and died the way a crash or a SIGKILL does:
// its lock stays behind, naming a pid nothing runs any more.
function crashed(file, mode = 'crash') {
    const r = spawnSync(process.execPath, ['-e', CHILD, STORE, file, BINDING, mode], { encoding: 'utf8', timeout: 10000 });
    if (r.error)
        throw r.error;
    assert.equal(r.signal, 'SIGKILL', 'the child did not die as planned\n' + r.stderr);
    const said = JSON.parse(r.stdout);
    assert.equal(said.pid, r.pid);
    return said;
}

// A process that holds the store until the test ends. It is killed in t.after
// whether the test passed or not, and every wait on its output has a deadline
// rather than a sleep.
function holding(t, file) {
    const proc = spawn(process.execPath, ['-e', CHILD, STORE, file, BINDING, 'hold'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '', ended = null;
    const lines = [], waiting = [];
    proc.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    readline.createInterface({ input: proc.stdout }).on('line', line => {
        if (waiting.length)
            waiting.shift().resolve(line);
        else
            lines.push(line);
    });
    const end = reason => {
        ended = new Error(reason + '\n' + stderr);
        for (const w of waiting.splice(0))
            w.reject(ended);
    };
    proc.on('error', error => end('could not start the child: ' + error.message));
    proc.on('exit', (code, signal) => end('the child exited (' + (code ?? signal) + ') before answering'));
    // A write to a child that already died fails with EPIPE; the wait reports it.
    proc.stdin.on('error', () => { });
    t.after(() => new Promise(resolve => {
        if (proc.exitCode !== null || proc.signalCode !== null)
            return resolve();
        proc.once('exit', () => resolve());
        proc.kill('SIGKILL');
    }));
    proc.next = () => new Promise((resolve, reject) => {
        if (lines.length)
            return resolve(lines.shift());
        if (ended)
            return reject(ended);
        const timer = setTimeout(() => reject(new Error('the child said nothing for 10 s\n' + stderr)), 10000);
        waiting.push({
            resolve: line => { clearTimeout(timer); resolve(line); },
            reject: error => { clearTimeout(timer); reject(error); }
        });
    });
    proc.send = command => proc.stdin.write(command + '\n');
    return proc;
}

function caught(fn) {
    try {
        fn();
    }
    catch (error) {
        return error;
    }
    assert.fail('expected a throw');
}

function open(t, file, options) {
    const store = new PrimaryLinkStore(file, BINDING, options);
    t.after(() => store.close());
    return store;
}

test('dead same-host holder is taken over automatically', t => {
    const { dir, file } = scratch(t);
    const dead = crashed(file);
    const store = open(t, file);
    const holder = PrimaryLinkStore.readHolder(file);
    assert.equal(holder.token, store.token);
    assert.equal(holder.pid, process.pid);
    assert.equal(holder.legacy, false);
    assert.equal(store.gen, dead.gen + 1);
    // The new generation is on the journal before anything else is written.
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).leaseGen, store.gen);
    // The takeover mutex and the renamed dead lock are gone.
    assert.deepEqual(fs.readdirSync(dir).sort(), ['journal.json', 'journal.json.lock']);
    store.update(s => { s.receipts = [RECEIPT]; });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).receipts, [RECEIPT]);
});

// A stopped process is alive. Its pid answers signal 0, so it keeps its lock.
test('live paused holder gives BUSY and keeps working after SIGCONT', { skip: process.platform === 'win32' && 'no SIGSTOP on Windows' }, async t => {
    const { file } = scratch(t);
    const owner = holding(t, file);
    assert.equal(await owner.next(), 'ready');
    owner.kill('SIGSTOP');
    const busy = caught(() => new PrimaryLinkStore(file, BINDING));
    assert.equal(busy.code, 'PRIMARY_LINK_STORE_BUSY');
    assert.equal(busy.holder.pid, owner.pid);
    owner.kill('SIGCONT');
    owner.send('update');
    assert.equal(await owner.next(), 'wrote');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).receipts, ['c'.repeat(64)]);
    owner.send('close');
    assert.equal(await owner.next(), 'closed');
    assert.equal(PrimaryLinkStore.readHolder(file), null);
});

test('two recoverers interleaved yield exactly one owner', t => {
    const { file } = scratch(t);
    crashed(file);
    let second;
    // B arrives while A holds the takeover mutex and has not renamed yet. What
    // stops B is the mutex, so the holder it is shown is A, marked as such.
    const a = open(t, file, { hooks: { beforeTakeoverRename() { second = caught(() => new PrimaryLinkStore(file, BINDING)); } } });
    assert.ok(second, 'the hook did not run');
    assert.equal(second.code, 'PRIMARY_LINK_STORE_BUSY');
    assert.equal(second.holder.mutex, true);
    assert.equal(second.holder.token, a.token);
    assert.equal(PrimaryLinkStore.readHolder(file).token, a.token);
    // And with A done, A is alive: the next one is refused because of A.
    const third = caught(() => new PrimaryLinkStore(file, BINDING));
    assert.equal(third.code, 'PRIMARY_LINK_STORE_BUSY');
    assert.equal(third.holder.token, a.token);
});

test('old owner after an explicit break fails LOST and writes nothing', t => {
    const { dir, file } = scratch(t);
    const a = open(t, file);
    const broken = PrimaryLinkStore.breakLock(file);
    assert.equal(broken.holder.token, a.token);
    assert.equal(PrimaryLinkStore.readHolder(file), null);
    const b = open(t, file);
    assert.ok(b.gen > a.gen);
    const before = fs.readFileSync(file);
    assert.throws(() => a.update(s => { s.receipts = [RECEIPT]; }), { code: 'PRIMARY_LINK_STORE_LOST' });
    assert.deepEqual(fs.readFileSync(file), before);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['journal.json', 'journal.json.lock']);
});

test('final write is fenced too', t => {
    const { file } = scratch(t);
    const a = open(t, file);
    a.update(s => { s.receipts = [RECEIPT]; });
    PrimaryLinkStore.breakLock(file);
    const b = open(t, file);
    b.update(s => { s.receipts = [...s.receipts, 'b'.repeat(64)]; });
    const written = fs.readFileSync(file);
    // A's last word, as a close-time failure mark would be, after B has written.
    assert.throws(() => a.update(s => { s.receipts = []; }), { code: 'PRIMARY_LINK_STORE_LOST' });
    assert.deepEqual(fs.readFileSync(file), written);
    assert.deepEqual(JSON.parse(written.toString()).receipts, [RECEIPT, 'b'.repeat(64)]);
});

// The lock check alone is not the fence: a journal already written by a later
// generation refuses an owner even while that owner's lock file looks intact.
test('a later generation on the journal fences an owner whose lock looks intact', t => {
    const { file } = scratch(t);
    const a = open(t, file);
    const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
    journal.leaseGen = a.gen + 1;
    fs.writeFileSync(file, JSON.stringify(journal));
    const before = fs.readFileSync(file);
    assert.throws(() => a.update(s => { s.receipts = [RECEIPT]; }), { code: 'PRIMARY_LINK_STORE_LOST' });
    assert.deepEqual(fs.readFileSync(file), before);
});

test('regressed journal gives CONFLICT', t => {
    const { file } = scratch(t);
    const dead = crashed(file);
    // The journal names a generation newer than the lock that was left behind.
    const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
    journal.leaseGen = dead.gen + 5;
    fs.writeFileSync(file, JSON.stringify(journal));
    const before = fs.readFileSync(file);
    assert.throws(() => new PrimaryLinkStore(file, BINDING), { code: 'PRIMARY_LINK_STORE_CONFLICT' });
    assert.deepEqual(fs.readFileSync(file), before);
    // The refused opener keeps nothing.
    assert.equal(PrimaryLinkStore.readHolder(file), null);
});

// Locks written before this change hold a bare pid: no host, no boot, nothing
// that could prove the pid is this machine's. Even a dead pid stays BUSY.
test('legacy plain-pid lock gives BUSY unless broken', t => {
    const { file, lock } = scratch(t);
    const dead = crashed(file);
    fs.writeFileSync(lock, String(dead.pid), { mode: 0o600 });
    const busy = caught(() => new PrimaryLinkStore(file, BINDING));
    assert.equal(busy.code, 'PRIMARY_LINK_STORE_BUSY');
    assert.equal(busy.holder.legacy, true);
    assert.equal(busy.holder.pid, dead.pid);
    // Broken by the opener itself, which counts on from the journal, since a
    // legacy lock names no generation...
    const forced = new PrimaryLinkStore(file, BINDING, { breakLock: true });
    assert.equal(forced.gen, dead.gen + 1);
    assert.equal(PrimaryLinkStore.readHolder(file).token, forced.token);
    forced.close();
    // ...or by an operator, with the next opener starting a fresh lock.
    fs.writeFileSync(lock, String(dead.pid), { mode: 0o600, flag: 'wx' });
    assert.equal(PrimaryLinkStore.breakLock(file).holder.pid, dead.pid);
    const store = open(t, file);
    assert.equal(PrimaryLinkStore.readHolder(file).token, store.token);
});

// Containers restart with small pids, so an old lock can name a pid that a new,
// unrelated process now has. The start time tells them apart.
test('pid reuse with a different start time is treated as dead', { skip: process.platform !== 'linux' && 'reads /proc' }, t => {
    const { file, lock } = scratch(t);
    const own = new PrimaryLinkStore(file, BINDING);
    const mine = PrimaryLinkStore.readHolder(file);
    own.close();
    const { legacy, ...lease } = mine;
    fs.writeFileSync(lock, JSON.stringify({ ...lease, procStart: '1', token: 'e'.repeat(32) }), { mode: 0o600, flag: 'wx' });
    assert.equal(legacy, false);
    const store = open(t, file);
    assert.equal(PrimaryLinkStore.readHolder(file).token, store.token);
    assert.equal(store.gen, mine.gen + 1);
});

test('close removes only its own lock', t => {
    const { file } = scratch(t);
    const a = open(t, file);
    PrimaryLinkStore.breakLock(file);
    const b = open(t, file);
    a.close();
    assert.equal(PrimaryLinkStore.readHolder(file).token, b.token);
    b.close();
    assert.equal(PrimaryLinkStore.readHolder(file), null);
});

// What must never be taken over: a lock whose pid cannot be checked from here.
// Each one is a dead child's real lock with one thing changed, so that one
// thing is all that keeps it, and it is left exactly as it was.
const root = typeof process.getuid === 'function' && process.getuid() === 0;
function stillBusy(t, change) {
    const { dir, file, lock } = scratch(t);
    crashed(file);
    const { legacy, ...lease } = PrimaryLinkStore.readHolder(file);
    assert.equal(legacy, false);
    fs.writeFileSync(lock, JSON.stringify(change(lease)));
    const before = fs.readFileSync(lock);
    const busy = caught(() => new PrimaryLinkStore(file, BINDING));
    assert.equal(busy.code, 'PRIMARY_LINK_STORE_BUSY');
    assert.equal(busy.holder.mutex, undefined);
    assert.deepEqual(fs.readFileSync(lock), before);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['journal.json', 'journal.json.lock']);
    return busy.holder;
}

test('a lock from another host stays BUSY', t => {
    assert.equal(stillBusy(t, lease => ({ ...lease, host: 'elsewhere.invalid' })).host, 'elsewhere.invalid');
});

test('a lock from another boot stays BUSY', t => {
    assert.equal(stillBusy(t, lease => ({ ...lease, bootId: 'an-earlier-boot' })).bootId, 'an-earlier-boot');
});

test('a lock from another pid namespace stays BUSY', { skip: process.platform !== 'linux' && 'pid namespaces are Linux' }, t => {
    stillBusy(t, lease => ({ ...lease, pidNs: 'pid:[1]' }));
    // One that does not say which namespace proves nothing on Linux either.
    stillBusy(t, lease => ({ ...lease, pidNs: null }));
});

// EPERM is a process that exists and belongs to someone else: alive. Pid 1 is
// root's init almost everywhere, but not for root, nor in a container whose init
// is this user's, so the skip asks the system rather than guessing.
const pid1 = (() => {
    try {
        process.kill(1, 0);
    }
    catch (error) {
        return error.code;
    }
    return 'signalled';
})();
test('a lock whose pid this user may not signal stays BUSY', { skip: pid1 !== 'EPERM' && 'pid 1 gives ' + pid1 + ', not EPERM' }, t => {
    stillBusy(t, lease => ({ ...lease, pid: 1 }));
});

// A lock that names no generation, a bare pid or an empty file, cannot say how
// far its owner counted. A forced open goes one past the journal instead.
test('a forced open of a lock without a generation continues from the journal', t => {
    const { file, lock } = scratch(t);
    for (let i = 0; i < 2; i++)
        new PrimaryLinkStore(file, BINDING).close();
    for (const content of ['4242', '']) {
        const before = JSON.parse(fs.readFileSync(file, 'utf8')).leaseGen;
        assert.ok(before >= 2);
        fs.writeFileSync(lock, content, { mode: 0o600, flag: 'wx' });
        const store = new PrimaryLinkStore(file, BINDING, { breakLock: true });
        assert.equal(store.gen, before + 1);
        store.close();
    }
});

// LOST is final for whoever gets it, so it is kept for a store that really was
// taken over. A journal the fence cannot read is a failed write, and the next
// one can succeed.
test('a fence that cannot read the journal fails the write, not the lease', { skip: (process.platform === 'win32' || root) && 'needs file permissions to bite' }, t => {
    const { file } = scratch(t);
    const store = open(t, file);
    fs.chmodSync(file, 0o000);
    const failed = caught(() => store.update(s => { s.receipts = [RECEIPT]; }));
    fs.chmodSync(file, 0o600);
    assert.equal(failed.code, 'PRIMARY_LINK_STORE_WRITE_FAILED');
    assert.equal(failed.cause?.code, 'EACCES');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).receipts, []);
    store.update(s => { s.receipts = [RECEIPT]; });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).receipts, [RECEIPT]);
});

// A recoverer killed while it held the takeover mutex leaves the mutex behind.
// The mutex names its writer, so it is judged like a lock: that writer is dead
// here, so the mutex is set aside and the takeover goes ahead.
test('a leftover mutex from a dead recoverer is set aside automatically', t => {
    const { dir, file } = scratch(t);
    const dead = crashed(file);
    const recoverer = crashed(file, 'die-in-takeover');
    assert.equal(JSON.parse(fs.readFileSync(file + '.lock.takeover', 'utf8')).pid, recoverer.pid);
    const store = open(t, file);
    assert.equal(PrimaryLinkStore.readHolder(file).token, store.token);
    assert.equal(store.gen, dead.gen + 1);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['journal.json', 'journal.json.lock']);
});

// A takeover in progress belongs to a live process. Nothing sets its mutex
// aside, not even an explicit break, and the BUSY names the recoverer.
test('a live recoverer\'s mutex gives BUSY, marked as the mutex, even to an explicit break', t => {
    const { file } = scratch(t);
    crashed(file);
    let refused;
    const a = open(t, file, { hooks: { beforeTakeoverRename() {
        refused = [
            caught(() => new PrimaryLinkStore(file, BINDING)),
            caught(() => new PrimaryLinkStore(file, BINDING, { breakLock: true })),
            caught(() => PrimaryLinkStore.breakLock(file))
        ];
    } } });
    assert.equal(refused.length, 3);
    for (const busy of refused) {
        assert.equal(busy.code, 'PRIMARY_LINK_STORE_BUSY');
        assert.equal(busy.holder.mutex, true);
        assert.equal(busy.holder.pid, process.pid);
        assert.equal(busy.holder.token, a.token);
    }
    assert.equal(PrimaryLinkStore.readHolder(file).token, a.token);
});

// Two takeovers interleaved deterministically, without timing: the code under
// test is interrupted the first time it moves the takeover mutex aside, and
// `during(aside)` runs there. The rename itself goes ahead unless `during`
// returns true.
const realRename = fs.renameSync;
function interruptMutexSetAside(t, mutex, during) {
    let armed = true;
    fs.renameSync = function (src, dst) {
        if (armed && src === mutex) {
            armed = false;
            if (during(dst))
                return;
        }
        return realRename.apply(this, arguments);
    };
    t.after(() => { fs.renameSync = realRename; });
}

// B has judged a dead recoverer's mutex and is about to move it aside. In that
// gap A clears it, takes the lock and finishes, with A's own new mutex standing
// exactly where B's rename would have put the old one. That mutex is over: its
// writer holds the lock now. Put back, it would block every later recovery,
// explicit ones included, for as long as A lives.
test('two automatic recoverers on one stale mutex leave no mutex behind', t => {
    const { dir, file } = scratch(t);
    crashed(file);
    crashed(file, 'die-in-takeover');
    const mutex = file + '.lock.takeover';
    let a;
    interruptMutexSetAside(t, mutex, aside => {
        a = open(t, file, { hooks: { beforeTakeoverRename() { realRename(mutex, aside); } } });
        return true;
    });
    const b = caught(() => new PrimaryLinkStore(file, BINDING));
    fs.renameSync = realRename;
    assert.ok(a, 'A did not run');
    assert.equal(b.code, 'PRIMARY_LINK_STORE_BUSY');
    assert.equal(b.holder.token, a.token);
    assert.equal(b.holder.mutex, undefined);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['journal.json', 'journal.json.lock']);
});

// Two operators breaking at once, both having judged the same stale mutex. X
// either finishes entirely before Y moves anything, or is caught mid-way with
// its new mutex where Y's rename would have put the old one. Either way exactly
// one of them breaks the dead lock, and no file is left behind.
test('two explicit breakers on one stale mutex: one wins, nothing is left behind', t => {
    for (const variant of ['x finishes first', 'x mid-way']) {
        const { dir, file } = scratch(t);
        const dead = crashed(file);
        crashed(file, 'die-in-takeover');
        const mutex = file + '.lock.takeover';
        let x, y;
        interruptMutexSetAside(t, mutex, aside => {
            if (variant === 'x finishes first') {
                x = PrimaryLinkStore.breakLock(file);
                return false;
            }
            x = open(t, file, { breakLock: true, hooks: { beforeTakeoverRename() { realRename(mutex, aside); } } });
            return true;
        });
        try {
            y = PrimaryLinkStore.breakLock(file);
        }
        catch (error) {
            y = error;
        }
        fs.renameSync = realRename;
        if (variant === 'x finishes first') {
            assert.equal(x.holder.pid, dead.pid, variant);
            assert.deepEqual(y, { holder: null }, variant);
            assert.deepEqual(fs.readdirSync(dir), ['journal.json'], variant);
        }
        else {
            assert.equal(PrimaryLinkStore.readHolder(file).token, x.token, variant);
            assert.equal(y.code, 'PRIMARY_LINK_STORE_BUSY', variant);
            assert.equal(y.holder.token, x.token, variant);
            assert.equal(y.holder.mutex, undefined, variant);
            assert.deepEqual(fs.readdirSync(dir).sort(), ['journal.json', 'journal.json.lock'], variant);
        }
    }
});

// A mutex under the token the lock carries is a finished takeover's: the
// takeover got the lock. Should one be left, an explicit break clears it and
// goes on to break the lock.
test('a mutex written by the lock holder is finished and does not stop an explicit break', t => {
    const { dir, file, lock } = scratch(t);
    const a = open(t, file);
    fs.copyFileSync(lock, lock + '.takeover');
    assert.equal(PrimaryLinkStore.breakLock(file).holder.token, a.token);
    assert.deepEqual(fs.readdirSync(dir), ['journal.json']);
});

// A takeover is named by its token, not by its process: one process can hold
// the lock through one store while another store in it writes a mutex. That
// mutex belongs to a takeover that has not got the lock, live and fresh, and
// even an explicit break leaves it be.
test('a mutex from the lock holder\'s process under another token is not a finished takeover', t => {
    const { file, lock } = scratch(t);
    const a = open(t, file);
    const { legacy, ...mine } = PrimaryLinkStore.readHolder(file);
    assert.equal(legacy, false);
    fs.writeFileSync(lock + '.takeover', JSON.stringify({ ...mine, token: 'f'.repeat(32), gen: 0, at: Date.now() }), { mode: 0o600 });
    const busy = caught(() => PrimaryLinkStore.breakLock(file));
    assert.equal(busy.code, 'PRIMARY_LINK_STORE_BUSY');
    assert.equal(busy.holder.mutex, true);
    assert.equal(busy.holder.token, 'f'.repeat(32));
    assert.equal(PrimaryLinkStore.readHolder(file).token, a.token);
    assert.ok(fs.existsSync(lock + '.takeover'));
});

// A recoverer holds the mutex for microseconds. One more than a minute old is
// left over even if its writer's pid answers, so an operator's break clears it.
// The automatic path still clears only what it can prove.
test('an explicit break clears a mutex over a minute old; the automatic path does not', t => {
    const { dir, file, lock } = scratch(t);
    const dead = crashed(file);
    const other = scratch(t);
    const own = new PrimaryLinkStore(other.file, BINDING);
    const { legacy, ...mine } = PrimaryLinkStore.readHolder(other.file);
    own.close();
    assert.equal(legacy, false);
    // Written by this very process, alive, but a minute and more ago.
    fs.writeFileSync(lock + '.takeover', JSON.stringify({ ...mine, gen: 0, at: Date.now() - 61000 }));
    const busy = caught(() => new PrimaryLinkStore(file, BINDING));
    assert.equal(busy.holder.mutex, true);
    assert.equal(busy.holder.pid, process.pid);
    assert.equal(PrimaryLinkStore.breakLock(file).holder.pid, dead.pid);
    assert.deepEqual(fs.readdirSync(dir), ['journal.json']);
});

// An old owner whose lock was broken may find the new lock unreadable. That is
// still a takeover, not a disk problem: the name no longer holds its file.
test('an old owner is LOST even when the new lock is unreadable to it', { skip: (process.platform === 'win32' || root) && 'needs file permissions to bite' }, t => {
    const { file, lock } = scratch(t);
    const a = open(t, file);
    PrimaryLinkStore.breakLock(file);
    open(t, file);
    const before = fs.readFileSync(file);
    fs.chmodSync(lock, 0o000);
    const lost = caught(() => a.update(s => { s.receipts = [RECEIPT]; }));
    fs.chmodSync(lock, 0o600);
    assert.equal(lost.code, 'PRIMARY_LINK_STORE_LOST');
    assert.deepEqual(fs.readFileSync(file), before);
});

// A recoverer that died between moving something aside and removing it leaves
// <lock>.dead-* or <lock>.takeover.dead-* behind. Nobody reads them; the next
// owner removes them, and nothing else. One from the last minute may still be
// in a concurrent clearer's hands, and is left to it.
test('the next owner sweeps away what dead takeovers left aside', t => {
    const { dir, file, lock } = scratch(t);
    const old = (Date.now() - 120000) / 1000;
    for (const name of [lock + '.dead-0123', lock + '.takeover.dead-4567', lock + '.deadline']) {
        fs.writeFileSync(name, '');
        fs.utimesSync(name, old, old);
    }
    fs.writeFileSync(lock + '.takeover.dead-89ab', '');
    open(t, file);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['journal.json', 'journal.json.lock', 'journal.json.lock.deadline', 'journal.json.lock.takeover.dead-89ab']);
});

// The public way out of BUSY for a lock no automatic check can clear.
function primary(t, dir) {
    const client = new WhalibmobClient({ sessionDir: dir, refreshVersion: false });
    client._store = createNewStore('15550000123');
    client._store.registered = true;
    t.after(() => client._closePrimaryLinking());
    return client;
}

test('unlockPrimaryLink refuses while this process holds the store', t => {
    const { dir } = scratch(t);
    const file = path.join(dir, '15550000123.primary-linking.json');
    const one = primary(t, dir), other = primary(t, dir);
    one._primaryLinkingForSession();
    const token = PrimaryLinkStore.readHolder(file).token;
    assert.throws(() => one.unlockPrimaryLink(), { code: 'PRIMARY_LINK_BUSY' });
    // Another client in the same process may not break it either.
    assert.throws(() => other.unlockPrimaryLink(), { code: 'PRIMARY_LINK_BUSY' });
    assert.equal(PrimaryLinkStore.readHolder(file).token, token);
    assert.equal(one._primaryLinking.journal.token, token);
});

test('unlockPrimaryLink breaks a lock no process here can prove dead', t => {
    const { dir } = scratch(t);
    const file = path.join(dir, '15550000123.primary-linking.json');
    const client = primary(t, dir);
    fs.writeFileSync(file + '.lock', '4242', { mode: 0o600 });
    assert.throws(() => client._primaryLinkingForSession(), { code: 'PRIMARY_LINK_STORE_BUSY' });
    const { holder } = client.unlockPrimaryLink();
    assert.equal(holder.legacy, true);
    assert.equal(holder.pid, 4242);
    assert.equal(PrimaryLinkStore.readHolder(file), null);
    const linking = client._primaryLinkingForSession();
    assert.equal(PrimaryLinkStore.readHolder(file).token, linking.journal.token);
});

// An empty or unreadable mutex says nothing about its writer, so no automatic
// path may set it aside. The operator's unlock may, and the lock behind it too.
test('an empty or unreadable leftover mutex gives way to unlockPrimaryLink', t => {
    for (const content of ['', '{"v":2,']) {
        const { dir } = scratch(t);
        const file = path.join(dir, '15550000123.primary-linking.json');
        const dead = crashed(file);
        // The child's journal is bound to a synthetic account; the client starts
        // its own once the way is clear.
        fs.rmSync(file);
        fs.writeFileSync(file + '.lock.takeover', content, { mode: 0o600 });
        const client = primary(t, dir);
        const busy = caught(() => client._primaryLinkingForSession());
        assert.equal(busy.code, 'PRIMARY_LINK_STORE_BUSY');
        assert.equal(busy.holder.mutex, true);
        assert.equal(busy.holder.legacy, true);
        assert.equal(client.unlockPrimaryLink().holder.pid, dead.pid);
        assert.deepEqual(fs.readdirSync(dir), []);
        const linking = client._primaryLinkingForSession();
        assert.equal(PrimaryLinkStore.readHolder(file).token, linking.journal.token);
    }
});
