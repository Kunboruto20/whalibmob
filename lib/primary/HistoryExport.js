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
// do not go over at all.
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

function failure(code) {
    const error = new Error('PRIMARY_HISTORY_EXPORT_' + code);
    error.code = error.message;
    return error;
}
function requireValue(ok, code) { if (!ok) throw failure(code); }

// syncType, chunkOrder and progress are written even when 0: the live
// bootstrap carries all three, and Web gets no default to guess at.
function buildHistorySync(snapshot, { syncType = 0, chunkOrder = 0, progress = 100 } = {}) {
    const w = Writer.create();
    w.uint32(tag(1, VARINT)).int32(syncType);
    for (const chat of snapshot.chats) {
        w.uint32(tag(2, LEN)).fork();                                    // conversations
        conversation(w, chat, snapshot.records[chat.id] || []);
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
    for (const chat of snapshot.chats) {
        if (!chat.pnJid || !chat.lidJid) continue;
        w.uint32(tag(15, LEN)).fork()                                    // phoneNumberToLidMappings
            .uint32(tag(1, LEN)).string(chat.pnJid)
            .uint32(tag(2, LEN)).string(chat.lidJid)
            .ldelim();
    }
    return zlib.deflateSync(w.finish());
}

function conversation(w, chat, records) {
    w.uint32(tag(1, LEN)).string(chat.id);                               // ID
    let order = 0;
    for (const r of records) {
        const as = exportAs(r);
        if (!as) continue;
        w.uint32(tag(2, LEN)).fork();                                    // messages: HistorySyncMsg
        w.uint32(tag(1, LEN)).fork();                                    //   message: WebMessageInfo
        webMessageInfo(w, chat.id, r, as === 'content');
        w.ldelim();
        w.uint32(tag(2, VARINT)).uint64(++order);                        //   msgOrderID, 1..n
        w.ldelim();
    }
    if (has(chat.unreadCount)) w.uint32(tag(6, VARINT)).uint32(chat.unreadCount);
    if (has(chat.conversationTimestamp)) w.uint32(tag(12, VARINT)).uint64(chat.conversationTimestamp);
    if (has(chat.name)) w.uint32(tag(13, LEN)).string(chat.name);
    if (has(chat.pnJid)) w.uint32(tag(39, LEN)).string(chat.pnJid);
    if (has(chat.lidJid)) w.uint32(tag(42, LEN)).string(chat.lidJid);
}

// What a record goes over as: its content, the revoke stub, or nothing. Any
// other tombstone — expired, view-once, or one this file does not know — and
// a record with no content to carry are left out whole.
function exportAs(r) {
    if (r.tombstone === 'revoked') return 'stub';
    if (has(r.tombstone)) return null;
    return Buffer.isBuffer(r.raw) ? 'content' : null;
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
}

// payload is { inline: Buffer } — the deflated HistorySync itself — or
// { blob: { directPath, mediaKey, fileSha256, fileEncSha256, fileLength } }
// for one uploaded as md-msg-hist. Returns the Message bytes to send.
function buildNotification(payload, { syncType = 0, chunkOrder = 0, progress = 100 } = {}) {
    const inline = payload && payload.inline, blob = payload && payload.blob;
    requireValue(Buffer.isBuffer(inline) !== has(blob), 'PAYLOAD_INVALID');
    if (inline) requireValue(inline.length <= INLINE_MAX, 'INLINE_TOO_LARGE');
    else requireValue(Buffer.isBuffer(blob.fileSha256) && Buffer.isBuffer(blob.mediaKey) && Buffer.isBuffer(blob.fileEncSha256)
        && Number.isSafeInteger(blob.fileLength) && blob.fileLength >= 0 && typeof blob.directPath === 'string' && blob.directPath.length > 0,
    'PAYLOAD_INVALID');

    const w = Writer.create();
    w.uint32(tag(12, LEN)).fork();                                       // Message.protocolMessage
    w.uint32(tag(2, VARINT)).int32(HISTORY_SYNC_NOTIFICATION);           //   type
    w.uint32(tag(6, LEN)).fork();                                        //   historySyncNotification
    if (blob) {
        w.uint32(tag(1, LEN)).bytes(blob.fileSha256);                    //     fileSHA256
        w.uint32(tag(2, VARINT)).uint64(blob.fileLength);                //     fileLength
        w.uint32(tag(3, LEN)).bytes(blob.mediaKey);                      //     mediaKey
        w.uint32(tag(4, LEN)).bytes(blob.fileEncSha256);                 //     fileEncSHA256
        w.uint32(tag(5, LEN)).string(blob.directPath);                   //     directPath
    }
    w.uint32(tag(6, VARINT)).int32(syncType);                            //     syncType
    w.uint32(tag(7, VARINT)).uint32(chunkOrder);                         //     chunkOrder
    w.uint32(tag(9, VARINT)).uint32(progress);                           //     progress
    if (inline) w.uint32(tag(11, LEN)).bytes(inline);                    //     initialHistBootstrapInlinePayload
    w.ldelim();
    w.ldelim();
    return Buffer.from(w.finish());
}

// The part of a snapshot that changed after cutoff: records whose seq is past
// cutoff.seq. By seq and not by ts, so a message that arrived late with an
// old timestamp is still in it, and so is one edited, revoked or acked since.
// Everything else — chats, push names, losses — is the snapshot's own.
function recordsAfter(snapshot, cutoff) {
    // A cutoff that is not a seq would select nothing without a word.
    requireValue(cutoff && Number.isSafeInteger(cutoff.seq) && cutoff.seq >= 0, 'CUTOFF_INVALID');
    const records = {};
    let count = 0;
    for (const [chat, list] of Object.entries(snapshot.records)) {
        records[chat] = list.filter(r => r.seq > cutoff.seq);
        count += records[chat].length;
    }
    return { ...snapshot, records, counts: { ...snapshot.counts, records: count } };
}

module.exports = { INLINE_MAX, buildHistorySync, buildNotification, recordsAfter };
