/*
 * Registration parameter tracer  ·  libwhatsapp.so  ·  Android
 * ------------------------------------------------------------------
 * WhatsApp assembles the /code, /register and /exist request bodies as a
 * plain query string, then seals that string in an AES-256-GCM "ENC" envelope
 * before it ever reaches the socket. A network proxy therefore only sees the
 * opaque ciphertext. This agent instruments the GCM layer *inside*
 * libwhatsapp.so and reconstructs the registration payload in clear text,
 * exactly as the native client built it -- the same shape whalibmob's
 * lib/Registration.js produces, so the two can be diffed byte for byte.
 *
 * It follows both encryption entry points WhatsApp can take:
 *   - the one-shot  mbedtls_gcm_crypt_and_tag  (whole body in one call)
 *   - the streaming mbedtls_gcm_starts/update/finish (body fed in chunks,
 *     reassembled here per context pointer)
 *
 * Reference material. Run it on a device you own, with your own number.
 */

'use strict';

const MODULE = 'libwhatsapp.so';
const GCM_ENCRYPT = 1; // MBEDTLS_GCM_ENCRYPT

// A registration body always carries at least one of these tokens. Any other
// AES-GCM traffic (message payloads, media keys, backups) lacks them and is
// dropped, so the trace stays scoped to the registration run.
const REG_MARKERS = ['cc=', '&in=', 'token=', 'backup_token', 'authkey=', 'ENC'];

// The registration fields worth surfacing first, in request order.
const KEY_FIELDS = [
  'cc', 'in', 'rc', 'lg', 'lc', 'mcc', 'mnc', 'sim_mcc', 'sim_mnc',
  'method', 'reason', 'id', 'token', 'backup_token', 'pid',
  'e_regid', 'e_keytype', 'e_ident', 'e_skey_id', 'e_skey_val', 'e_skey_sig',
  'fdid', 'expid', 'network_radio_type', 'simnum', 'hasinrc', 'p8', 'hc',
  'authkey', 'e_ident_key', 'gpia', 'offline_ab', 'fetch_prekey', 'client_metrics',
];

/* ------------------------------------------------------------------ *
 *  Low-level readers
 * ------------------------------------------------------------------ */

function readBytes(ptr, len) {
  if (ptr.isNull() || len <= 0) return null;
  try {
    return new Uint8Array(ptr.readByteArray(len));
  } catch (_) {
    return null;
  }
}

function toHex(bytes) {
  if (!bytes) return '';
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += (bytes[i] + 0x100).toString(16).slice(1);
  return out;
}

function looksTextual(bytes) {
  if (!bytes || bytes.length === 0) return false;
  let printable = 0;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    if (c === 0x09 || c === 0x0a || c === 0x0d || (c >= 0x20 && c < 0x7f)) printable++;
  }
  return printable / bytes.length > 0.9;
}

function decode(bytes) {
  if (!bytes) return '';
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function isRegistrationBody(text) {
  if (!text) return false;
  for (let i = 0; i < REG_MARKERS.length; i++) {
    if (text.indexOf(REG_MARKERS[i]) !== -1) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 *  Reporter  (one structured record per captured body)
 * ------------------------------------------------------------------ */

const Reporter = (function () {
  const line = (label, value) => console.log('  ' + label.padEnd(14) + value);

  function params(text) {
    const pairs = {};
    text.split('&').forEach((kv) => {
      const eq = kv.indexOf('=');
      if (eq === -1) return;
      pairs[kv.slice(0, eq)] = kv.slice(eq + 1);
    });

    const shown = new Set();
    console.log('  ---- parameters ----');
    KEY_FIELDS.forEach((k) => {
      if (k in pairs) {
        shown.add(k);
        const v = pairs[k];
        console.log('    ' + k.padEnd(20) + (v.length > 96 ? v.slice(0, 96) + '…(' + v.length + ')' : v));
      }
    });
    Object.keys(pairs).forEach((k) => {
      if (shown.has(k)) return;
      const v = pairs[k];
      console.log('    ' + k.padEnd(20) + (v.length > 96 ? v.slice(0, 96) + '…(' + v.length + ')' : v));
    });
  }

  return {
    emit(ctx) {
      const bytes = ctx.plaintext;
      const textual = looksTextual(bytes);
      const text = textual ? decode(bytes) : null;

      console.log('\n╔══════════════ ENC registration payload ══════════════');
      line('via', ctx.via);
      line('site', ctx.site); // module + offset the hook fired at
      line('length', String(bytes ? bytes.length : 0) + ' bytes');
      if (ctx.iv) line('iv', toHex(ctx.iv) || '(none)');
      if (ctx.aad && ctx.aad.length) {
        line('aad', looksTextual(ctx.aad) ? decode(ctx.aad) : toHex(ctx.aad));
      }
      if (ctx.tag) line('tag', toHex(ctx.tag));

      if (textual) {
        params(text);
        console.log('  ---- raw body ----');
        console.log('  ' + text);
      } else {
        console.log('  ---- raw (binary) ----');
        console.log(hexdump(ctx.plaintextPtr, { length: Math.min(bytes ? bytes.length : 0, 512), ansi: false }));
      }
      console.log('╚═══════════════════════════════════════════════════════\n');
    },
  };
})();

/* ------------------------------------------------------------------ *
 *  Symbol resolution
 * ------------------------------------------------------------------ */

function resolve(name) {
  const byExport = Module.findExportByName(MODULE, name);
  if (byExport) return byExport;

  const mod = Process.findModuleByName(MODULE);
  if (!mod) return null;

  let hit = null;
  try {
    mod.enumerateSymbols().forEach((s) => {
      if (!hit && s.name === name) hit = s.address;
    });
  } catch (_) {}
  if (hit) return hit;

  // Fully stripped build: allow a pinned offset, e.g.
  //   WA_GCM_ADDR=0x3f1a20 frida -U "WhatsApp" -l registration.js
  if (name === 'mbedtls_gcm_crypt_and_tag' && typeof getenv === 'function') {
    const off = getenv('WA_GCM_ADDR');
    if (off) return mod.base.add(ptr(off));
  }
  return null;
}

function siteOf(addr) {
  const mod = Process.findModuleByName(MODULE);
  const off = mod ? addr.sub(mod.base) : null;
  return MODULE + (off ? '+0x' + off.toString(16) : '') + ' @ ' + addr;
}

/* ------------------------------------------------------------------ *
 *  One-shot:  mbedtls_gcm_crypt_and_tag(
 *    ctx, mode, length, iv, iv_len, add, add_len,
 *    input, output, tag_len, tag)
 * ------------------------------------------------------------------ */

function hookOneShot() {
  const addr = resolve('mbedtls_gcm_crypt_and_tag');
  if (!addr) return false;
  const site = siteOf(addr);

  Interceptor.attach(addr, {
    onEnter(args) {
      if (args[1].toInt32() !== GCM_ENCRYPT) return;

      const length = args[2].toInt32();
      const plaintext = readBytes(args[7], length);
      if (!plaintext) return;

      const text = looksTextual(plaintext) ? decode(plaintext) : '';
      if (!isRegistrationBody(text)) return;

      this.rec = {
        via: 'mbedtls_gcm_crypt_and_tag (one-shot)',
        site,
        plaintext,
        plaintextPtr: args[7],
        iv: readBytes(args[3], args[4].toInt32()),
        aad: readBytes(args[5], args[6].toInt32()),
        tagPtr: args[10],
        tagLen: args[9].toInt32(),
      };
    },
    onLeave() {
      if (!this.rec) return;
      this.rec.tag = readBytes(this.rec.tagPtr, this.rec.tagLen);
      Reporter.emit(this.rec);
    },
  });

  console.log('[+] hooked ' + site + '  (mbedtls_gcm_crypt_and_tag)');
  return true;
}

/* ------------------------------------------------------------------ *
 *  Streaming:  starts(ctx,mode,iv,iv_len) -> update(ctx,len,in,out)*
 *              -> finish(ctx,tag,tag_len)
 *  Chunks are reassembled per context pointer so a body split across
 *  several update() calls is still reconstructed whole.
 * ------------------------------------------------------------------ */

function hookStreaming() {
  const starts = resolve('mbedtls_gcm_starts');
  const update = resolve('mbedtls_gcm_update');
  const finish = resolve('mbedtls_gcm_finish');
  if (!update) return false;

  const sessions = {}; // ctx -> { mode, iv, chunks:[], total }

  if (starts) {
    Interceptor.attach(starts, {
      onEnter(args) {
        sessions[args[0].toString()] = {
          mode: args[1].toInt32(),
          iv: readBytes(args[2], args[3].toInt32()),
          chunks: [],
          total: 0,
        };
      },
    });
  }

  Interceptor.attach(update, {
    onEnter(args) {
      const key = args[0].toString();
      const s = sessions[key] || (sessions[key] = { mode: GCM_ENCRYPT, iv: null, chunks: [], total: 0 });
      if (s.mode !== GCM_ENCRYPT) return;
      const len = args[1].toInt32();
      const chunk = readBytes(args[2], len);
      if (chunk) {
        s.chunks.push(chunk);
        s.total += chunk.length;
      }
    },
  });

  const flush = (key, tag) => {
    const s = sessions[key];
    if (!s) return;
    delete sessions[key];
    if (s.mode !== GCM_ENCRYPT || s.total === 0) return;

    const plaintext = new Uint8Array(s.total);
    let off = 0;
    s.chunks.forEach((c) => { plaintext.set(c, off); off += c.length; });

    const text = looksTextual(plaintext) ? decode(plaintext) : '';
    if (!isRegistrationBody(text)) return;

    Reporter.emit({
      via: 'mbedtls_gcm_starts/update/finish (streaming)',
      site: siteOf(update),
      plaintext,
      plaintextPtr: Memory.alloc(plaintext.length).writeByteArray(Array.from(plaintext)),
      iv: s.iv,
      aad: null,
      tag,
    });
  };

  if (finish) {
    Interceptor.attach(finish, {
      onEnter(args) {
        this.key = args[0].toString();
        this.tagPtr = args[1];
        this.tagLen = args[2].toInt32();
      },
      onLeave() {
        flush(this.key, readBytes(this.tagPtr, this.tagLen));
      },
    });
  }

  console.log('[+] hooked ' + siteOf(update) + '  (mbedtls_gcm_update' +
    (starts ? ' + starts' : '') + (finish ? ' + finish' : '') + ')');
  return true;
}

/* ------------------------------------------------------------------ *
 *  Bootstrap
 * ------------------------------------------------------------------ */

(function main() {
  if (!Process.findModuleByName(MODULE)) {
    console.log('[!] ' + MODULE + ' is not loaded yet.');
    console.log('    Open WhatsApp and start a registration, then re-attach.');
    return;
  }

  const a = hookOneShot();
  const b = hookStreaming();

  if (!a && !b) {
    console.log('[!] No GCM symbols found in ' + MODULE + ' — this build is stripped.');
    console.log('    Find the mbedtls_gcm_crypt_and_tag offset in Ghidra and re-run with');
    console.log('    WA_GCM_ADDR=0x<offset> (relative to the ' + MODULE + ' base).');
    return;
  }

  console.log('[*] waiting for a registration run — request the code with method=voice …');
})();
