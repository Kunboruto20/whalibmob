'use strict';
// The chat history a primary hands a newly linked companion, in the form the
// official phone hands it: a HistorySync, deflated, announced by a
// HistorySyncNotification inside a ProtocolMessage.
//
// Web takes this on trust and never says what it disliked. A HistorySync it
// cannot use leaves it on "Loading chats" until it logs itself out. So every
// field number here is WhatsApp's, the tests read the bytes back with a
// decoder that shares nothing with this file, and an empty store comes out
// byte for byte as the bootstrap validated live (PrimaryBootstrap.initialHistory).
//
// Pure: a store snapshot goes in, bytes come out. What the store buried stays
// buried. A revoked message goes over as the stub the official app shows for
// one — its key and time, none of what it said. Expired and view-once messages
// do not go over at all. A snapshot that does not add up is refused rather
// than exported with a quiet hole in it.
const zlib = require('node:zlib');
const { Writer } = require('protobufjs/minimal');

// A deflated HistorySync up to this size rides inside the notification; a
// larger one is uploaded as an md-msg-hist blob and only pointed to.
const INLINE_MAX = 64 * 1024;
const HISTORY_SYNC_NOTIFICATION = 5;   // ProtocolMessage.type
const REVOKE = 1;                      // WebMessageInfo.messageStubType

const VARINT = 0, LEN = 2;
const tag = (field, wire) => field * 8 + wire;
const has = v => v !== undefined && v !== null;
const isUint = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;

function failure(code, detail) {
    const full = 'PRIMARY_HISTORY_EXPORT_' + code;
    const error = new Error(detail ? full + ': ' + detail : full);
    error.code = full;
    return error;
}
function requireValue(ok, code, detail) { if (!ok) throw failure(code, detail); }

// syncType, chunkOrder and progress are written even when 0: the live
// bootstrap carries all three, and Web gets no default to guess at. Being
// always on the wire, they have to be real values: Writer would turn a
// string, a fraction or a negative into some other number without a word.
function checkChunk(syncType, chunkOrder, progress) {
    requireValue(isUint(syncType, 0x7fffffff) && isUint(chunkOrder, 0xffffffff) && isUint(progress, 100), 'OPTIONS_INVALID');
}

// Every list of records belongs to one of the chats. One that does not would
// be skipped by the export and still counted by recordsAfter.
function checkRecords(snapshot) {
    const chats = new Set(snapshot.chats.map(c => c.id));
    for (const id of Object.keys(snapshot.records)) {
        requireValue(chats.has(id), 'SNAPSHOT_INVALID', 'records for ' + id + ', which is not one of the chats');
    }
}

function buildHistorySync(snapshot, { syncType = 0, chunkOrder = 0, progress = 100 } = {}) {
    checkChunk(syncType, chunkOrder, progress);
    checkRecords(snapshot);
    const w = Writer.create();
    w.uint32(tag(1, VARINT)).int32(syncType);
    for (const { chat, messages } of conversations(snapshot)) {
        w.uint32(tag(2, LEN)).fork();                                    // conversations
        conversation(w, chat, messages);
        w.ldelim();
    }
    w.uint32(tag(5, VARINT)).uint32(chunkOrder);
    w.uint32(tag(6, VARINT)).uint32(progress);
    for (const p of snapshot.pushNames) {
        w.uint32(tag(7, LEN)).fork()                                     // pushnames
            .uint32(tag(1, LEN)).string(p.id)
            .uint32(tag(2, LEN)).string(p.pushname)
            .ldelim();
    }
    // From every chat that knows both its jids, whether or not it went over
    // as a conversation: a mapping is true without one. A contact with a chat
    // under each jid would give the same pair twice; it goes over once.
    const pairs = new Set();
    for (const chat of snapshot.chats) {
        if (!chat.pnJid || !chat.lidJid) continue;
        const pair = JSON.stringify([chat.pnJid, chat.lidJid]);
        if (pairs.has(pair)) continue;
        pairs.add(pair);
        w.uint32(tag(15, LEN)).fork()                                    // phoneNumberToLidMappings
            .uint32(tag(1, LEN)).string(chat.pnJid)
            .uint32(tag(2, LEN)).string(chat.lidJid)
            .ldelim();
    }
    return zlib.deflateSync(w.finish());
}

// The chats that go over, each with the records it carries, in snapshot order.
function conversations(snapshot) {
    const out = [];
    for (const chat of snapshot.chats) {
        const messages = exported(chat.id, snapshot.records[chat.id] || []);
        // Nothing to show and no time to place it at: Web would list an
        // empty chat from 1970.
        if (!messages.length && !(chat.conversationTimestamp > 0)) continue;
        out.push({ chat, messages });
    }
    return out;
}

// What buildHistorySync carries, counted: the chats that go over and their
// records, revoke stubs included, the records it leaves out not.
function exportedCounts(snapshot) {
    checkRecords(snapshot);
    let chats = 0, records = 0;
    for (const { messages } of conversations(snapshot)) { chats++; records += messages.length; }
    return { chats, records };
}

// Whether a record goes over at all: with its content, or as a revoke stub.
const goesOver = r => r.tombstone === 'revoked' || !has(r.tombstone);

// What each record goes over as: its content, or the revoke stub. Any other
// tombstone — expired, view-once, or one this file does not know — leaves the
// record out whole. A record with neither a tombstone nor its bytes is a
// broken snapshot; leaving it out would be a hole in the history that nobody
// hears about, so it is refused.
function exported(chatId, records) {
    const out = [];
    for (const r of records) {
        if (r.tombstone === 'revoked') out.push({ r, content: false });
        else if (goesOver(r)) {
            requireValue(Buffer.isBuffer(r.raw), 'SNAPSHOT_INVALID', 'record ' + r.id + ' in ' + chatId + ' has neither content nor a tombstone');
            out.push({ r, content: true });
        }
    }
    return out;
}

function conversation(w, chat, messages) {
    w.uint32(tag(1, LEN)).string(chat.id);                               // ID
    messages.forEach(({ r, content }, i) => {
        w.uint32(tag(2, LEN)).fork();                                    // messages: HistorySyncMsg
        w.uint32(tag(1, LEN)).fork();                                    //   message: WebMessageInfo
        webMessageInfo(w, chat.id, r, content);
        w.ldelim();
        w.uint32(tag(2, VARINT)).uint64(i + 1);                          //   msgOrderID, 1..n
        w.ldelim();
    });
    if (has(chat.unreadCount)) w.uint32(tag(6, VARINT)).uint32(chat.unreadCount);
    // The disappearing-messages timer. Without it Web shows the chat as not
    // disappearing and sends from it without one. setAt is in seconds, the
    // ts of the message that set it.
    const eph = chat.ephemeral;
    if (eph && eph.seconds > 0) {
        w.uint32(tag(9, VARINT)).uint32(eph.seconds);                    // ephemeralExpiration
        if (eph.setAt > 0) w.uint32(tag(10, VARINT)).int64(eph.setAt);   // ephemeralSettingTimestamp
    }
    if (chat.conversationTimestamp > 0) w.uint32(tag(12, VARINT)).uint64(chat.conversationTimestamp);
    if (has(chat.name)) w.uint32(tag(13, LEN)).string(chat.name);
    if (has(chat.pnJid)) w.uint32(tag(39, LEN)).string(chat.pnJid);
    if (has(chat.lidJid)) w.uint32(tag(42, LEN)).string(chat.lidJid);
}

function webMessageInfo(w, chatId, r, content) {
    w.uint32(tag(1, LEN)).fork();                                        // key: MessageKey
    w.uint32(tag(1, LEN)).string(chatId);                                //   remoteJID
    w.uint32(tag(2, VARINT)).bool(r.fromMe === true);                    //   fromMe
    w.uint32(tag(3, LEN)).string(r.id);                                  //   ID
    if (has(r.participant)) w.uint32(tag(4, LEN)).string(r.participant); //   participant
    w.ldelim();
    // The Message bytes exactly as they were stored; a stub has none.
    if (content) w.uint32(tag(2, LEN)).bytes(r.raw);                     // message
    w.uint32(tag(3, VARINT)).uint64(r.ts);                               // messageTimestamp, seconds
    if (has(r.status)) w.uint32(tag(4, VARINT)).int32(r.status);         // status
    // A group sender is in the key and here too, exactly as stored: a lid
    // stays a lid.
    if (has(r.participant)) w.uint32(tag(5, LEN)).string(r.participant); // participant
    if (has(r.pushName)) w.uint32(tag(19, LEN)).string(r.pushName);      // pushName
    if (!content) w.uint32(tag(24, VARINT)).int32(REVOKE);               // messageStubType
    // A message sent with a timer keeps it on Web, counted from when it came.
    if (content && r.expiration > 0) {
        w.uint32(tag(32, VARINT)).uint64(r.ts);                          // ephemeralStartTimestamp
        w.uint32(tag(33, VARINT)).uint32(r.expiration);                  // ephemeralDuration, seconds
    }
}

function validBlob(b) {
    return !!b && typeof b === 'object' && Buffer.isBuffer(b.fileSha256) && Buffer.isBuffer(b.mediaKey)
        && Buffer.isBuffer(b.fileEncSha256) && Number.isSafeInteger(b.fileLength) && b.fileLength >= 0
        && typeof b.directPath === 'string' && b.directPath.length > 0;
}

// payload is { inline: Buffer } — the deflated HistorySync itself — or
// { blob: { directPath, mediaKey, fileSha256, fileEncSha256, fileLength } }
// for one uploaded as md-msg-hist. Returns the Message bytes to send.
function buildNotification(payload, { syncType = 0, chunkOrder = 0, progress = 100 } = {}) {
    checkChunk(syncType, chunkOrder, progress);
    const inline = payload ? payload.inline : undefined, blob = payload ? payload.blob : undefined;
    // Decided once, and only by whether inline is a Buffer. Any other inline
    // is not an absent one: protobufjs would read a string as base64 and send it.
    const isInline = Buffer.isBuffer(inline);
    requireValue(isInline ? !has(blob) : !has(inline) && validBlob(blob), 'PAYLOAD_INVALID');
    if (isInline) requireValue(inline.length <= INLINE_MAX, 'INLINE_TOO_LARGE');

    const w = Writer.create();
    w.uint32(tag(12, LEN)).fork();                                       // Message.protocolMessage
    w.uint32(tag(2, VARINT)).int32(HISTORY_SYNC_NOTIFICATION);           //   type
    w.uint32(tag(6, LEN)).fork();                                        //   historySyncNotification
    if (!isInline) {
        w.uint32(tag(1, LEN)).bytes(blob.fileSha256);                    //     fileSHA256
        w.uint32(tag(2, VARINT)).uint64(blob.fileLength);                //     fileLength
        w.uint32(tag(3, LEN)).bytes(blob.mediaKey);                      //     mediaKey
        w.uint32(tag(4, LEN)).bytes(blob.fileEncSha256);                 //     fileEncSHA256
        w.uint32(tag(5, LEN)).string(blob.directPath);                   //     directPath
    }
    w.uint32(tag(6, VARINT)).int32(syncType);                            //     syncType
    w.uint32(tag(7, VARINT)).uint32(chunkOrder);                         //     chunkOrder
    w.uint32(tag(9, VARINT)).uint32(progress);                           //     progress
    if (isInline) w.uint32(tag(11, LEN)).bytes(inline);                  //     initialHistBootstrapInlinePayload
    w.ldelim();
    w.ldelim();
    return Buffer.from(w.finish());
}

// The part of a snapshot that changed after cutoff, as a RECENT chunk carries
// it: records whose seq is past cutoff.seq, the chats they belong to, and the
// push names of those chats and their senders. By seq and not by ts, so a
// message that arrived late with an old timestamp is still in it, and so is
// one edited, revoked or acked since. A chat with nothing new that goes over
// is left out whole: Web would show it again, empty, with its unread count.
// Losses and the rest are the snapshot's own.
function recordsAfter(snapshot, cutoff) {
    // A cutoff that is not a seq would select nothing without a word.
    requireValue(cutoff && Number.isSafeInteger(cutoff.seq) && cutoff.seq >= 0, 'CUTOFF_INVALID');
    checkRecords(snapshot);
    const chats = [], records = {}, named = new Set();
    let count = 0;
    for (const chat of snapshot.chats) {
        const list = (snapshot.records[chat.id] || []).filter(r => r.seq > cutoff.seq);
        if (!list.some(goesOver)) continue;
        chats.push(chat);
        records[chat.id] = list;
        count += list.length;
        for (const id of [chat.id, chat.pnJid, chat.lidJid]) if (has(id)) named.add(id);
        for (const r of list) if (has(r.participant)) named.add(r.participant);
    }
    return { ...snapshot, chats, records, pushNames: snapshot.pushNames.filter(p => named.has(p.id)),
        counts: { ...snapshot.counts, chats: chats.length, records: count } };
}

module.exports = { INLINE_MAX, buildHistorySync, buildNotification, recordsAfter, exportedCounts };
