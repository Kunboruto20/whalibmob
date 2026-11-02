# Sessions & Signal Store

[← Back to the README](../README.md) · [Documentation index](../README.md#documentation)

---

## Saving & Restoring Sessions

Sessions are persisted to disk under the `sessionDir` you provide — the
authentication folder. Pass any path you like; nothing is hardcoded.

```js
const client = new WhalibmobClient({
  sessionDir: path.join(process.env.HOME, 'whalibmob_auth')
})

// no need to register again — just connect
await client.init('919634847671')
```

**Each number gets a folder of its own inside it**, holding every file that
number owns:

```
whalibmob_auth/
├── android-apk-material.json            ← shared by every Android registration
├── android-apk-material-business.json
├── 919634847671/
│   ├── 919634847671.json                ← the store: keys, device, version
│   ├── 919634847671.signal.json         ← Signal sessions, signed pre-key, identities
│   ├── 919634847671.pre-key-1.json      ← one-time pre-keys, one file each
│   ├── 919634847671.pre-key-2.json
│   ├── …                                  812 of them
│   ├── 919634847671.pre-key-812.json
│   ├── 919634847671.sk.json             ← sender keys
│   ├── 919634847671.tctoken.json
│   ├── 919634847671.device-cache.json
│   ├── 919634847671.lid-mapping.json
│   ├── 919634847671.lid-reverse-mapping.json
│   ├── 919634847671.appState.json
│   ├── 919634847671.appStateKeys.json
│   ├── 919634847671.history.json
│   ├── 919634847671.messages.json
│   ├── 919634847671.primary-messages.log        ← what the primary kept, to hand a companion
│   ├── 919634847671.primary-messages.json
│   ├── 919634847671.primary-messages.write-failed ← only while a disk failure is not yet recorded
│   ├── 919634847671.primary-history-outbox.json ← only while a handover is under way
│   └── 919634847671.primary-linking.json        ← the link journal
└── 5568936182750/
    └── …
```

A companion link for the same number lives beside it as `<phone>.web.json` and
friends, in the same folder.

One account is then one directory: copy it to move a number to another machine,
delete it to be rid of one, archive it to keep it. Nothing has to be picked out
of a pile by prefix.

The five `primary-*` files only exist on a number that acts as the primary device
and keeps messages or links a companion; see
[Files the Primary Keeps for Linked Companions](#files-the-primary-keeps-for-linked-companions).

> [!NOTE]
> **Sessions written by earlier versions keep working where they are.** The
> layout is decided per number: a number whose files sit loose in the base
> directory is left exactly as it is, and only new numbers get a folder. Nothing
> is moved unless you ask — `wa migrate-sessions` does that, one number or all
> of them, and re-running it is safe.

### Files the Primary Keeps for Linked Companions

A number registered here is the account's primary device. When it keeps a record of its messages and approves a companion such as WhatsApp Web ([how](linking.md#linking-whatsapp-web-from-the-cli)), more files appear beside the others: the message store's two and the link journal for good, the store's write-failed marker while the disk is refusing it, the history outbox while a handover is under way, and a lock file beside the store and one beside the journal while a program has them open. All are created readable by you only (mode `0600`).

| File | Backend key | Holds |
|---|---|---|
| `<phone>.primary-messages.log` | `primary-messages-log` | The message store's journal, one JSON event per line, appended as messages are sent and received. The message bytes are in it, base64, unencrypted. |
| `<phone>.primary-messages.json` | `primary-messages` | The same store, compacted: the chats, the messages kept (newest 100 per chat and 20 000 in all, by default), what it knows it lost, and where capture began (`origin`: `registration` or `enabled`). The journal is folded into it (a compaction) once it has grown by about as much as this snapshot holds, and never less than about 1 MiB or 5 000 lines, so a large store is not rewritten every megabyte; also when the store is closed on disconnect, and on the next turn of the event loop after a message is revoked or expires, so that its bytes leave the files at once. Expiry is checked when the store opens, when it is read, and once an hour while it is open. |
| `<phone>.primary-messages.write-failed` | `primary-messages-write-failed` | Empty. There only while the disk is refusing the store's writes and that stretch has not been written down yet; its modification time is when the refusals began. The next write that lands (or, after a crash, the next open) records the stretch as a loss, `messages were not saved from ... to ...`, and removes the file. It belongs to the store and moves with it. A copy between backends keeps the file but not its time. |
| `<phone>.primary-history-outbox.json` | `primary-history-outbox` | The history waiting to go out to a companion, pinned before it is sent so that a resume sends exactly those bytes. Plaintext, and for a blob the key that opens it. Only while a handover is under way: it is deleted when the handover finishes, or can never be sent. |
| `<phone>.primary-linking.json` | `primary-linking` | The link journal: approvals begun and not finished, the pairing requests waiting, the link state with the companions' key indexes, and how far the bootstrap got. Bound to the number and its identity key by a digest, and refused for any other number. |
| `<phone>.primary-messages.lock` | none | Who has the message store open right now (pid, host, boot, start time), so that a second program on the same session is refused it (`PRIMARY_MESSAGE_STORE_BUSY`, which names the holder). It belongs to a running process, not to the number, and never moves: it is there from the login that opens the store until the store is closed, and one left by a process that died on this machine is taken over by the next. One whose holder cannot be proven gone (another machine or container, a pid handed to another process since, a lock its writer died before filling in) stays until you break it: start wa with `--unlock-message-store`, which shows the holder and asks first. A program that in fact still held it stops keeping messages at its next write (`PRIMARY_MESSAGE_STORE_LOST`). |
| `<phone>.primary-linking.json.lock` | none | Who holds the journal right now (pid, host, boot, start time). A connected primary takes it at its first link activity (any link command, `/link-status` included, or a pairing request arriving from Web) and keeps it until it disconnects or its connection closes. It belongs to a running process, not to the number, and is the file `/link-unlock` breaks. |

The backend keys are for `copySession` and the backends below. The client itself still writes files. A companion (`.web.`) session never writes these, but a `<phone>.web.primary-*` copy is listed too, so a move does not leave one behind.

What the files do when a session is moved or re-filed:

- **`wa migrate-sessions` (and `migrateSession()`)** moves the store (its write-failed marker included, with its time), the outbox and the journal with everything else. The two `.lock` files never move, there or anywhere else: each belongs to a process.
- **Re-filing under the number WhatsApp uses** ([see accounts](accounts.md#the-number-whatsapp-files-your-account-under); `adoptCanonicalNumber()`) renames the message store, its write-failed marker and the outbox with the number, so the history follows the account. The **link journal is not renamed**: it is bound to the number it was written for, and a renamed copy would be refused. It stays under the old name, with its lock, and the new number starts a journal of its own, so an approval left unfinished under the old name is not seen under the new one. The store's lock is not renamed either.
- **Registering the number again in the CLI** starts a new message store. The earlier one is moved aside, as `<phone>.primary-messages.log.before-<time>` and `<phone>.primary-messages.json.before-<time>` (and its write-failed marker, if it left one); it is kept, and never handed to a companion. Under `--no-message-store` the earlier store is still moved aside, and no new one starts. The move happens under the store's lock: if another wa has the store open then, nothing is moved, and the warning names who holds it.
- **`--no-message-store`** writes no store files at all. A later run with the store on records that there was a stretch it was not open for, as a loss.
- **`--reset-message-store`** starts a store whose files are damaged again. The damaged files stay in the folder, renamed `<phone>.primary-messages.log.corrupt-<time>` and `<phone>.primary-messages.json.corrupt-<time>` (and the marker, if there is one); they are kept, never read and never handed to a companion, and the new store counts as switched on at that moment.
- **`--unlock-message-store`** breaks a store lock whose holder cannot be proven gone. Before the store of the number being connected or registered opens, it shows who holds the lock (pid, host, since when) and asks `[y/N]`; Enter is no. `wa listen` cannot ask, so it names the holder and refuses. Break it only when no other wa is using the number.

These files hold message content in the clear. Back them up, move them and delete them the way you do the keys beside them.

### Keeping the Announced Version Current

Every connection announces the WhatsApp build it claims to be. The server checks
it, and when it stops recognising the number it refuses the handshake with
`405` — a failure that says nothing about the version and has nothing to do with
the account.

A session records the version it registered with. Left alone it announces that
same number forever, so a number registered in spring is still claiming a spring
build in autumn, and one day the connect simply stops working.

**Sessions refresh themselves, on both platforms.** Before every handshake the
client asks the platform's store what the current build is and writes it into
`<phone>.json`. iOS reads the App Store listing, Android the Play Store one.
Nothing to run, nothing to remember:

```js
client.on('version_update', ({ from, to, source }) => {
  console.log('announcing', to, 'instead of', from, '—', source)
})

await client.init('919634847671')
```

**Reconnects are covered too.** The check runs from the socket-connect step
rather than from `init()`, so the library's own reconnect loop passes through it
as well. A bot that stays up for weeks does not go on announcing whatever the
listing said the morning it started. The handshake reads the version out of the
store at the moment it runs, so a version written here is the one that goes out.

Four rules keep this from being the thing that breaks a working session:

- **It never goes backwards.** Both lookups answer with a pinned fallback rather
  than failing when they cannot reach the network, and that fallback can easily
  be older than what the session holds. Moving a session to an older version is
  the one outcome that makes a `405` *more* likely.
- **`WA_VERSION` still wins.** A version pinned on the way out of a `405` is a
  decision, and is never quietly replaced.
- **A failed lookup changes nothing.** The session keeps the version it has and
  the connect carries on.
- **The network is not asked twice for the same answer.** Each lookup is
  memoised for six hours, so a connection that flaps every few seconds reaches
  the store once rather than once per attempt — and a session up for a month
  still picks up a release the day it lands.

Set `{ refreshVersion: false }` on the client to turn it off.

> [!NOTE]
> **Registration still reads the APK.** A number being registered announces the
> `versionName` of the APK its token material came from, because the Android
> registration token is signed over that build. Only the *announced* version on
> an already-registered session follows the Play Store listing — no token
> travels in the handshake, so there is nothing there for it to fall out of step
> with. When the listing moves past the cached material the client emits
> `apk_material_stale`, which is the cue to run `wa apk-material --download`
> before registering the next number.

The manual tool still works on both platforms:

```bash
wa refresh-version 919634847671                    # current build for the platform
wa refresh-version 919634847671 --version 2.25.1.2 # or one you name
```

Companion sessions have never had this problem: `connectWeb()` reads the live
web revision on every connect already.

### One-time Pre-keys

A pre-key is a one-shot Diffie-Hellman key the account leaves with the server so
somebody who wants to message it can open a Signal session without it being
online. Each one is handed out once and then gone. Run out and nobody can start
a conversation with the number at all — the messages are not delayed, they are
never sent, and nothing anywhere reports it.

whalibmob keeps a pool of **812**, generated the moment a session is created and
written one key per file, in whatever authentication folder you gave it:

```
~/.waSession/919634847671/
├── 919634847671.pre-key-1.json
├── 919634847671.pre-key-2.json
└── … 919634847671.pre-key-812.json
```

A companion link for the same number keeps its own pool beside it as
`919634847671.web.pre-key-<id>.json`. The two are never shared: they are
separate devices with separate identity keys, and a key offered under the wrong
one cannot be answered.

The file is the same shape the reference client writes — the raw 32-byte public
key and the private key, both BufferJSON:

```json
{"private":{"type":"Buffer","data":"…"},"public":{"type":"Buffer","data":"…"}}
```

**Keeping the server stocked.** Three things drive it, and all of them ask the
server what it is actually holding rather than guessing from the local pool —
the two drift apart, because the server spends a key on every bundle it hands
out and none of that reaches this side.

| When | What it does |
|---|---|
| on login | asks the server for its count; **0** there means a full 812 goes up, anything low means a top-up of 5 |
| when the server says it is running low | same check, same batch |
| every 30 minutes | same check — for the session that stays up long enough to be drained without a word |

A batch is the next ids the server has not been sent, never the whole pool
again, and only counts as sent once the server has acknowledged it — a rejected
upload is retried four times with backoff and then left for the next check, with
the same keys still queued. Ids are never reused, even after the key under one
has been spent.

After the login upload the account also asks for the server's **key bundle
digest** and compares the identity key and signed pre-key it is being served
against the ones this session holds. A mismatch there is the failure that used
to need the number registering again to clear.

None of this needs calling: `init()` and `connectWeb()` both do it, identically.

> [!NOTE]
> **Sessions written before 5.14.19 keep every key they had.** Pre-keys used to
> live inside `<phone>.signal.json`; on the first start they are moved out into
> files of their own and the aggregate copy is dropped. The keys themselves do
> not change, so the bundles the server has already handed out stay answerable.

### Where the folder comes from

| order | source |
|---|---|
| 1 | `sessionDir` passed to `WhalibmobClient` (library), or `--session <dir>` (CLI) |
| 2 | `WA_SESSION_DIR` in the environment |
| 3 | the answer remembered in `~/.whalibmob.json`, which the CLI asks for once on a first run |
| 4 | `~/.waSession` |

The CLI asks only when none of the above has decided it and the default folder
is empty, so an existing installation is never asked to rename anything, and a
non-interactive run — a script, a cron — never blocks on the question.

```
  where should sessions be kept? each number gets its own folder inside.
  a bare name goes under your home directory; enter for /home/you/.waSession
  authentication folder:  whalibmob_auth
  sessions will be kept in /home/you/whalibmob_auth
```

A bare name is created under your home directory; an absolute path or one
starting with `~` is taken as given.

### Working out the paths yourself

`lib/SessionPaths` is the same resolver the library and the CLI use, so a
caller that wants to read or move a session's files does not have to guess the
layout:

```js
// exported from the package itself, or from lib/SessionPaths directly
const {
  defaultBaseDir, sessionDirFor, storeFileFor, webStoreFileFor,
  listSessions, migrateSession, SessionPaths
} = require('whalibmob')

const { isLegacyLayout, SESSION_SUFFIXES } = SessionPaths

const base = path.join(process.env.HOME, 'whalibmob_auth')

sessionDirFor(base, '919634847671')                  // …/whalibmob_auth/919634847671
sessionDirFor(base, '919634847671', { create: true }) // and makes it
storeFileFor(base, '919634847671')                   // …/919634847671/919634847671.json
webStoreFileFor(base, '919634847671')                // …/919634847671/919634847671.web.json

listSessions(base)
// [ { phone, dir, storeFile, webStoreFile, legacy, hasMobile, hasWeb }, … ]
//   covers both layouts, so it is what to iterate over

migrateSession(base, '919634847671')
// { phone, from, to, moved: [...], skipped: [...] }   moves one number into its folder
```

`SESSION_SUFFIXES` is every per-number file the library writes — the list to
copy or delete against if you are moving an account by hand.

### Where a Session Is Kept

Everything above describes files, because files are what whalibmob writes and
what it will go on writing unless you say otherwise. **Nothing in this section
is something you have to do.** Leave it alone and sessions stay exactly where
they have always been, in the JSON files named above.

What is new is that the place is now a choice. A **backend** is four
synchronous operations over a flat key space:

```js
read(key)          // the stored text, or null when the key was never written
write(key, value)  // put it there, replacing whatever was there before
remove(key)        // take it away; a key that is not there is not an error
list(prefix)       // every key present that starts with prefix
```

The keys are logical names rather than file names — `auth`, `signal`,
`sender-key`, `tc-token`, `device-cache`, `lid-mapping`,
`lid-reverse-mapping`, `history`, `messages`, `app-state`, `app-state-keys`,
the primary's `primary-messages-log`, `primary-messages`,
`primary-messages-write-failed`, `primary-history-outbox` and
`primary-linking`, and `` `pre-key/${id}` `` for
each of the 812 one-time pre-keys. The lock files have no key: they belong to a
running process, not to the session.

Three implementations ship with the package:

| Backend | Where the state goes | Needs |
|---|---|---|
| `FileBackend` | JSON files — what the library has always written | nothing; this is the default |
| `SqliteBackend` | one database file | Node 22.5+, or `better-sqlite3` |
| `MemoryBackend` | nowhere; gone when the process ends | nothing |

```js
const { FileBackend } = require('whalibmob')

const backend = new FileBackend({
  dir:   '/home/you/.waSession/919634847671',
  phone: '919634847671'
})

backend.write('auth', JSON.stringify(creds))
backend.read('auth')          // the text, or null
backend.list()                // ['auth', 'pre-key/1', 'signal', …]
backend.list('pre-key/')      // just the pre-keys
backend.remove('pre-key/42')
backend.fileFor('signal')     // …/919634847671.signal.json
```

`FileBackend` writes the same names in the same places as every release before
it, so a session written by whalibmob 5.30 opens through it untouched and one
written through it opens in 5.30. The only change is that writes now go to a
temporary file and are renamed into place, so a process that dies mid-write
leaves the previous state intact instead of half a file.

> [!IMPORTANT]
> **A number has two halves, and they are separate sessions.** The one
> registered over the Mobile API and the companion linked over the Web API
> never share state — in particular they have separate pre-key id spaces, and
> mixing them hands out two different keys under one id and breaks decryption.
> A backend covers **one** half, chosen by `web`:
>
> ```js
> const mobile = new FileBackend({ dir, phone, web: false })  // default
> const web    = new FileBackend({ dir, phone, web: true })
> ```
>
> Both take the same keys and keep entirely separate values.

> [!NOTE]
> **The client does not accept a backend yet.** `new WhalibmobClient({ … })`
> takes `sessionDir` and writes files, as it always has; the modules that hold
> session state still do their own file I/O. The backends are usable on their
> own — for reading, inspecting, copying or moving a session — and wiring them
> through the client is the next step. Nothing here changes how a session is
> created or connected today.

### One Database Instead of 844 Files

A number's state is 32 named files (16 for each half of the number, the
primary's message store, its write-failed marker, history outbox and link
journal among them) plus a
file for each of its 812 one-time pre-keys, and the two lock files while a
program holds them. On a laptop nobody notices. On a phone under Termux, on a
container with a small inode budget, or with fifty numbers in one folder, it is
over 40 000 files whose directory has to be read every time the pre-key pool is
counted.

`SqliteBackend` is the same state as a handful of rows:

```js
const { SqliteBackend } = require('whalibmob')

const db = new SqliteBackend({
  path:  '/home/you/.waSession/sessions.sqlite',
  phone: '919634847671'
})

db.write('auth', JSON.stringify(creds))
db.read('auth')
db.list('pre-key/')
db.driver          // 'node:sqlite' or 'better-sqlite3'
db.close()         // let go of the file
```

**What it needs.** Node ships SQLite of its own from **22.5.0** as
`node:sqlite`, and that is what this uses when it is there — nothing to
install, nothing for node-gyp to fail at, and Termux stays a place whalibmob
runs. On older Node it falls back to `better-sqlite3` if that is installed:

```sh
npm install better-sqlite3      # only on Node older than 22.5
```

Neither is a dependency of this package. On a runtime with neither, the
constructor throws and says which of the two to reach for — and `FileBackend`
goes on needing nothing at all.

One file holds as many numbers and halves as you like, while each backend sees
only its own slice:

```js
const mobile = new SqliteBackend({ path: file, phone: '919634847671' })
const web    = new SqliteBackend({ path: file, phone: '919634847671', web: true })
const other  = new SqliteBackend({ path: file, phone: '40712345678' })

SqliteBackend.sessionsIn(file)
// [ { phone: '40712345678',  half: 'mobile', web: false },
//   { phone: '919634847671', half: 'mobile', web: false },
//   { phone: '919634847671', half: 'web',    web: true  } ]
```

The file handle is shared between the backends opened on it and closed once
the last of them calls `close()`, so closing one does not pull the file out
from under the others. Calling `close()` twice is harmless.

The database runs in WAL mode, so a client flushing its Signal store and
another reading the pre-key pool do not block each other. Values are stored as
blobs rather than text: a credential blob carrying a NUL byte is truncated by
a text binding and the session then loads with keys that are wrong from that
byte on, which is the worst way for a bug to present.

### Moving a Session Between Backends

Nothing is removed and the source is never modified, so if the result is not
what you wanted the old files are still there to go back to:

```js
const { FileBackend, SqliteBackend, copySession, compareSessions } = require('whalibmob')

const files = new FileBackend({ dir: '/home/you/.waSession/919634847671',
                                phone: '919634847671' })
const db    = new SqliteBackend({ path: '/home/you/.waSession/sessions.sqlite',
                                  phone: '919634847671' })

const moved = copySession(files, db)
// { copied: ['auth', 'pre-key/1', …], skipped: [], bytes: 1284 }

const check = compareSessions(files, db)
// { ok: true, missing: [], differing: [], extra: [] }

db.close()
```

`compareSessions` reads both sides back rather than trusting that the copy
said so — run it before deleting anything. A key the destination already holds
is left alone, so an interrupted copy is safe to run again; pass
`{ overwrite: true }` when you do mean to replace what is there.

Do both halves of a number separately — `web: false` and `web: true` are two
sessions and a copy of one is not a copy of the other.

## Signal Store Utilities

`auth-utils` is a collection of optional helpers for power users who manage their own `SignalStore` instances directly (e.g. custom storage backends, multi-account servers).

```js
const {
  makeCacheableSignalKeyStore,
  addTransactionCapability,
  assertMeId,
  initAuthCreds
} = require('whalibmob')
```

### `makeCacheableSignalKeyStore`

Wraps a `SignalStore` with an in-memory cache (5-minute TTL). Reads for sessions, pre-keys, signed pre-keys and identity keys are served from cache on subsequent accesses; `store*` calls write through to both, and `remove*` / `delete*` calls drop the entry.

A lookup that finds nothing is **not** cached. Absence is the state most likely to change from underneath — a session about to be built, a pre-key about to be uploaded — so a remembered miss is the one that would hurt.

`useClones` is set to `false` so that `SessionRecord` objects — which carry internal state and methods — are returned by reference and never deep-cloned.

Every method the underlying store has is forwarded, including `transaction()` and `isInTransaction()` when present, so the wrapper is a drop-in replacement and safe to stack with `addTransactionCapability`.

```js
const { SignalStore, makeCacheableSignalKeyStore } = require('whalibmob')

const store  = new SignalStore()
const cached = makeCacheableSignalKeyStore(store)

// reads hit cache after first access
const session = await cached.loadSession('919634847671.0')
```

Call `await cached.flushCache()` to drop everything — after a key rotation, or when another process may have written to the same session file.

**When to use:** whenever your `SignalStore` is backed by a remote or disk-based store (database, Redis, file system) and you want to reduce repeated lookups for sessions that haven't changed between sends.

### `addTransactionCapability`

Wraps a `SignalStore` with batched-write (transaction) semantics. During a transaction all writes are buffered in memory and flushed to the underlying store in one shot when the callback returns — there is no `commit()` to call. Reads check the buffer first, so a transaction sees its own writes. If the callback throws, nothing is written at all and the error reaches the caller.

Uses `AsyncLocalStorage` to propagate transaction context across async call chains, and a `Mutex` with reference-counting per transaction key.

```js
const { SignalStore, addTransactionCapability, makeCacheableSignalKeyStore } = require('whalibmob')

// recommended: cache first, then transactions on top
const base     = new SignalStore()
const cached   = makeCacheableSignalKeyStore(base)
const txnStore = addTransactionCapability(cached)

// inside a send flow
await txnStore.transaction(async () => {
  // all writes are buffered until this callback returns
  await txnStore.storeSession('919634847671.0', sessionRecord)
  await txnStore.storePreKey(1, preKeyPair)
}, 'send')
```

The second argument is a scope: two transactions with different keys run concurrently, two with the same key run one after the other. It defaults to `'default'`. Any key is safe — the transaction locks are kept separate from the locks reads take, so no choice of key can make a transaction wait on itself.

Nested `transaction()` calls reuse the enclosing context instead of opening a second one, so an inner transaction does not commit on its own.

Stacking order matters: put `makeCacheableSignalKeyStore` below `addTransactionCapability`, so that a transaction which rolls back never reaches the cache. The other order works too — a failed transaction flushes the cache rather than leave it holding writes the store never took — but it throws away good entries to do it.

**When to use:** for high-throughput servers that send to many recipients concurrently and need to batch Signal key writes into a single atomic flush per message.

### `assertMeId`

Returns the account's JID, or throws an `Error` describing what is missing.

Works with both kinds of store — the SMS store from `initAuthCreds` / `createNewStore`, and the companion store from `createNewWebStore`. Only the wording of the error differs, since the way out of "not registered yet" is SMS verification in one case and pairing in the other.

Once registered, the JID the server assigned is preferred (`store.me.id`) — on a companion it carries the device suffix, and rebuilding it from the phone number drops that silently. Before registration it throws, including during the pairing window: requesting a pairing code writes a placeholder `me` with no suffix, and that is not treated as being linked.

```js
const { assertMeId } = require('whalibmob')

const store = loadStore(sessFile)

try {
  const jid = assertMeId(store)
  // '919634847671:12@s.whatsapp.net' once connected,
  // '919634847671@s.whatsapp.net' before that
  console.log('account JID:', jid)
} catch (err) {
  console.error('store is not registered:', err.message)
}
```

**When to use:** as a guard before calling `client.init()` to give a clear error message when a corrupted or unregistered session file is accidentally loaded.

### `initAuthCreds`

Creates a fresh credential store for the given phone number — the key pairs, registration ID and device identifiers a number needs before it can even ask for an SMS code. This is what `/reg code` calls.

It returns everything `createNewStore` does, plus a few fields kept for application code that expects them: `nextPreKeyId`, `firstUnuploadedPreKeyId`, `accountSyncCounter`, `accountSettings`, `processedHistoryMessages` and `advSecretKey`. Those extras live on the object only — `saveStore` does not write them, so they are not there again after a reload. Nothing in the library reads them; treat them as a convenience, not as state.

> [!NOTE]
> The two pre-key counters the library actually runs on are the ones in the
> `SignalStore` — `nextPreKeyId()` and `firstUnuploadedPreKeyId()`, persisted in
> `<phone>.signal.json`. They live there rather than in the store because a
> number's mobile half and its companion half have a `SignalStore` each and must
> never share a pre-key id space. The fields above are the same names on a
> different object and do not drive anything.

```js
const { initAuthCreds, saveStore } = require('whalibmob')
const path = require('path')
const fs   = require('fs')

const phone    = '919634847671'
const sessDir  = path.join(process.env.HOME, '.waSession')
const sessFile = path.join(sessDir, phone + '.json')

fs.mkdirSync(sessDir, { recursive: true })

const store = initAuthCreds(phone)
saveStore(store, sessFile)
```

This is the function the CLI uses for every new SMS session. Prefer it over `createNewStore` for forward compatibility.

> [!NOTE]
> `initAuthCreds` and `createNewStore` produce equivalent stores for every current library operation, and identical files on disk. Use `createNewWebStore` instead when the device will be linked as a companion rather than registered by SMS — that one adds the pairing fields, and its own serialiser persists them.

The file it writes has exactly these 16 keys:

```json
{
  "phoneNumber": "40712345678",
  "noiseKeyPair":    { "private": "…", "public": "…" },
  "identityKeyPair": { "private": "…", "public": "…" },
  "signedPreKey":    { "id": 3649616, "private": "…", "public": "…", "signature": "…" },
  "registrationId": 2183,
  "fdid": "2f701f8b-d693-4728-…",
  "deviceId": "CBIyyJRAokOdYoTYEjTbng==",
  "identityId": "SE8Q785oful7dGdBgNpwjg==",
  "advertisingId": "5c97eea9-783f-4fcc-…",
  "backupToken": "…",
  "registered": true,
  "codePending": false,
  "name": "Boss",
  "version": "2.26.9.75",
  "device": { "os": "ios", "platform": 1, "model": "iPhone 15 Pro", "…": "…" },
  "advIdentity": "…"
}
```

`registered` and `codePending` are the two that move: both `false` when the store is created, `codePending` flips to `true` once a code has been requested, and `verifyCode` sets `registered` to `true` and `codePending` back to `false`. `advIdentity` stays `null` until the server sends the signed device identity in `<success>`.

### Recommended Stacking Pattern

For a production multi-account server:

```js
const {
  SignalStore,
  makeCacheableSignalKeyStore,
  addTransactionCapability,
  initAuthCreds,
  saveStore,
  loadStore
} = require('whalibmob')

// 1. load or create the credential store
let store = loadStore(sessFile) || initAuthCreds(phone)

// 2. build the layered Signal key store
const signalStore = new SignalStore()
signalStore.attachFile(sessFile)
const cachedStore = makeCacheableSignalKeyStore(signalStore)
const txnStore    = addTransactionCapability(cachedStore)

// 3. pass to the client (advanced usage — most users should use WhalibmobClient directly)
```

For standard usage, `WhalibmobClient` handles all of this internally. These helpers are for advanced scenarios where you need direct control over Signal key storage.


---

[← Back to the README](../README.md) · [Documentation index](../README.md#documentation)
