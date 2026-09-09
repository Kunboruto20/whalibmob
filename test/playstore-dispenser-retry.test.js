'use strict';

// Asking the Aurora token dispenser more than once.
//
// The dispenser is a free service shared by everyone who uses it, and the way it
// sheds load is to refuse: 403 when it is rate limiting, 5xx when it is having a
// bad minute. Both are usually over in seconds. Before this, one refusal ended
// the whole APK download and the user was told to go and find an APK by hand —
// for something that would have answered on the second try.
//
// A 400, by contrast, means the request itself is wrong and asking again only
// makes the same error take three times as long to arrive.

const test   = require('node:test');
const assert = require('node:assert/strict');
const https  = require('node:https');
const { EventEmitter } = require('node:events');

const PlayStore = require('../lib/PlayStore');
const { dispenserRetryable, DISPENSER_ATTEMPTS } = PlayStore._retry;

// ─── which answers are worth asking again ────────────────────────────────────

test('a refusal that means "come back later" is retried', () => {
  for (const status of [403, 408, 429, 500, 502, 503, 504]) {
    assert.equal(dispenserRetryable(status), true, 'HTTP ' + status);
  }
});

test('a refusal that will never change is not retried', () => {
  // 400/401/404 say the request itself is the problem. 200 is not a refusal.
  for (const status of [200, 400, 401, 404, 410]) {
    assert.equal(dispenserRetryable(status), false, 'HTTP ' + status);
  }
});

// ─── the loop ────────────────────────────────────────────────────────────────
//
// https.request is stubbed so the dispenser can be made to answer whatever the
// test needs, and WA_PLAY_RETRY_DELAY_MS is set to 0 so nothing waits.

function withStub(answers, fn) {
  const realRequest = https.request;
  const calls = [];

  https.request = (opts, cb) => {
    const answer = answers[Math.min(calls.length, answers.length - 1)];
    calls.push(opts);

    const req = new EventEmitter();
    req.write = () => {};
    req.end   = () => {
      setImmediate(() => {
        if (answer instanceof Error) { req.emit('error', answer); return; }
        const res = new EventEmitter();
        res.statusCode = answer.status;
        res.headers    = {};
        res.resume     = () => {};
        cb(res);
        setImmediate(() => {
          if (answer.body) res.emit('data', Buffer.from(answer.body));
          res.emit('end');
        });
      });
    };
    req.destroy = () => {};
    return req;
  };

  const savedDelay = process.env.WA_PLAY_RETRY_DELAY_MS;
  process.env.WA_PLAY_RETRY_DELAY_MS = '0';

  return Promise.resolve()
    .then(() => fn(calls))
    .finally(() => {
      https.request = realRequest;
      if (savedDelay === undefined) delete process.env.WA_PLAY_RETRY_DELAY_MS;
      else process.env.WA_PLAY_RETRY_DELAY_MS = savedDelay;
    });
}

const OK_BODY = JSON.stringify({ authToken: 'tok', gsfId: 'g', dfeCookie: 'c' });

test('a 403 followed by a 200 comes back with the token', async () => {
  await withStub([{ status: 403 }, { status: 200, body: OK_BODY }], async (calls) => {
    const auth = await PlayStore.fetchAnonymousAuth();
    assert.equal(auth.authToken, 'tok');
    assert.equal(calls.length, 2, 'it asked twice');
  });
});

test('it keeps trying up to the attempt limit, then reports', async () => {
  await withStub([{ status: 403 }], async (calls) => {
    await assert.rejects(
      PlayStore.fetchAnonymousAuth(),
      (e) => /HTTP 403/.test(e.message) &&
             new RegExp(String(DISPENSER_ATTEMPTS) + ' attempts').test(e.message));
    assert.equal(calls.length, DISPENSER_ATTEMPTS,
      'it gave up only after the full run of attempts');
  });
});

test('a 400 is reported at once, without burning the retries', async () => {
  await withStub([{ status: 400 }], async (calls) => {
    await assert.rejects(PlayStore.fetchAnonymousAuth(), /HTTP 400/);
    assert.equal(calls.length, 1, 'asking again would never have helped');
  });
});

test('a success on the first ask does not retry', async () => {
  await withStub([{ status: 200, body: OK_BODY }], async (calls) => {
    const auth = await PlayStore.fetchAnonymousAuth();
    assert.equal(auth.authToken, 'tok');
    assert.equal(calls.length, 1);
  });
});

test('a dropped connection is retried like a 5xx', async () => {
  const boom = new Error('socket hang up');
  await withStub([boom, { status: 200, body: OK_BODY }], async (calls) => {
    const auth = await PlayStore.fetchAnonymousAuth();
    assert.equal(auth.authToken, 'tok');
    assert.equal(calls.length, 2);
  });
});

test('a connection that never comes back is reported, not swallowed', async () => {
  const boom = new Error('socket hang up');
  await withStub([boom], async (calls) => {
    await assert.rejects(PlayStore.fetchAnonymousAuth(), /socket hang up/);
    assert.equal(calls.length, DISPENSER_ATTEMPTS);
  });
});

test('the request itself is unchanged — same URL, UA and profile body', async () => {
  await withStub([{ status: 200, body: OK_BODY }], async (calls) => {
    await PlayStore.fetchAnonymousAuth();
    const [opts] = calls;
    assert.equal(opts.hostname, 'auroraoss.com');
    assert.equal(opts.path, '/api/auth');
    assert.equal(opts.method, 'POST');
    assert.equal(opts.headers['User-Agent'], 'com.aurora.store-4.6.1-70');
    assert.equal(opts.headers['Content-Type'], 'application/json');
  });
});
