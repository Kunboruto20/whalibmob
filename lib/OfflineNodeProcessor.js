'use strict';

// The backlog the server flushes on reconnect, processed at a pace that leaves
// the process usable.
//
// Everything that arrived while this session was offline is delivered in one
// burst the moment it reconnects — messages, receipts, notifications, calls,
// stamped `offline` so a client can tell them from live traffic. On an account
// that has been away for a day that burst is hundreds of stanzas.
//
// Handled the way live traffic is handled, they all start at once: hundreds of
// decryptions, disk writes and event emissions racing each other with nothing
// between them, and the event loop never gets a turn. Nothing else in the
// process runs until the last one finishes — no timers, no keepalive, no socket
// reads. And one handler that throws takes the rest of the burst with it.
//
// So the backlog gets a queue of its own:
//
//   • one stanza at a time, in the order the server sent them
//   • the event loop gets a turn after every batch, so timers and the socket
//     keep running while the backlog drains
//   • a handler that throws is reported and the queue carries on — a single bad
//     stanza costs one stanza, not the rest of the burst
//   • a socket that closes mid-drain stops the queue rather than working
//     through a backlog nobody can answer
//
// Live traffic does not come through here. It has no `offline` attribute and
// goes straight to its handler, exactly as before.

// How many stanzas to handle before giving the event loop a turn. The reference
// client uses ten; more starves the loop, fewer spends the whole drain in
// setImmediate round trips.
const DEFAULT_BATCH_SIZE = 10;

/**
 * @param {Map<string, (node) => Promise<void>|void>} handlers  stanza tag → handler
 * @param {object} deps
 *   @param {() => boolean}        deps.isOpen     whether the socket is still up
 *   @param {(err, ctx) => void}   deps.onError    called for anything a handler throws
 *   @param {() => Promise<void>} [deps.yield]     how to give the loop a turn
 * @param {number} [batchSize]
 */
function makeOfflineNodeProcessor(handlers, deps, batchSize) {
  const size    = batchSize > 0 ? batchSize : DEFAULT_BATCH_SIZE;
  const pending = [];
  let draining  = false;

  const yieldToLoop = (deps && deps.yield) ||
    (() => new Promise(resolve => setImmediate(resolve)));

  async function drain() {
    let inBatch = 0;
    while (pending.length && deps.isOpen()) {
      const { tag, node } = pending.shift();
      const handler = handlers.get(tag);

      if (!handler) {
        deps.onError(new Error('unknown offline stanza: ' + tag), 'offline ' + tag);
        continue;
      }

      try {
        await handler(node);
      } catch (err) {
        // Reported, not rethrown: the rest of the backlog is still worth having.
        deps.onError(err, 'offline ' + tag);
      }

      if (++inBatch >= size) {
        inBatch = 0;
        await yieldToLoop();
      }
    }
    draining = false;
  }

  return {
    /** Put one stanza on the queue, and start draining if nothing else is. */
    enqueue(tag, node) {
      pending.push({ tag, node });
      if (draining) return;
      draining = true;
      drain().catch(err => {
        draining = false;
        deps.onError(err, 'draining offline backlog');
      });
    },

    /** How many stanzas are still waiting. */
    get size() { return pending.length; },

    /** Whether the queue is working through a backlog right now. */
    get draining() { return draining; },

    /** Throw the backlog away — used when the session is torn down. */
    clear() { pending.length = 0; }
  };
}

module.exports = { makeOfflineNodeProcessor, DEFAULT_BATCH_SIZE };
