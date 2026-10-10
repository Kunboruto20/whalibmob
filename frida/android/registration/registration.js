// Registration parameter tracer (Android)
//
// WhatsApp builds the /code and /register request bodies as a plain query
// string, then wraps that string in an AES-256-GCM "ENC" envelope before it
// ever leaves the device. By the time the bytes hit the socket they are
// ciphertext, so a network proxy only ever sees the opaque ENC blob.
//
// This hook sits one layer lower: it attaches to the AES-GCM encrypt call
// inside libwhatsapp.so (mbedtls_gcm_crypt_and_tag, MBEDTLS_GCM_ENCRYPT) and
// prints the *plaintext* registration parameters the native client assembles
// -- the same fields whalibmob's lib/Registration.js produces -- right before
// they are sealed. Run a real `method=voice` registration in the app while
// this is attached and the full parameter string (cc, in, id, token, backup
// token, Play Integrity fields, the ephemeral public key, etc.) prints to the
// console, letting you verify whalibmob emits a byte-identical body.
//
// Reference only. Use it on your own device, with your own number.

'use strict';

var MODULE = 'libwhatsapp.so';
var ENCRYPT = 1; // MBEDTLS_GCM_ENCRYPT

function hex(ptr, len) {
  if (ptr.isNull() || len <= 0) return '';
  try {
    return Array.prototype.map
      .call(new Uint8Array(ptr.readByteArray(len)), function (b) {
        return ('0' + (b & 0xff).toString(16)).slice(-2);
      })
      .join('');
  } catch (e) {
    return '<unreadable>';
  }
}

// The plaintext body is printable ASCII (a query string). Show it as text when
// it looks like text, fall back to hex for anything binary (keys, nonces).
function asText(ptr, len) {
  if (ptr.isNull() || len <= 0) return '';
  try {
    var bytes = new Uint8Array(ptr.readByteArray(len));
    var printable = 0;
    for (var i = 0; i < bytes.length; i++) {
      var c = bytes[i];
      if (c === 0x09 || c === 0x0a || c === 0x0d || (c >= 0x20 && c < 0x7f)) {
        printable++;
      }
    }
    if (printable / bytes.length > 0.9) return ptr.readUtf8String(len);
  } catch (e) {}
  return hex(ptr, len) + ' (hex)';
}

// mbedtls_gcm_crypt_and_tag(
//   ctx, mode, length, iv, iv_len, add, add_len,
//   input, output, tag_len, tag)
function resolve() {
  // mbedTLS is statically linked, so the symbol is usually not exported.
  // Try the export table first, then the (stripped) symbol table, then let
  // the operator pin the address with WA_GCM_ADDR for a fully stripped build.
  var m = Process.findModuleByName(MODULE);
  if (!m) {
    console.log('[!] ' + MODULE + ' not loaded yet. Open WhatsApp and start a');
    console.log('    registration first, then re-attach.');
    return null;
  }

  var byExport = Module.findExportByName(MODULE, 'mbedtls_gcm_crypt_and_tag');
  if (byExport) return byExport;

  var hit = null;
  try {
    m.enumerateSymbols().forEach(function (s) {
      if (!hit && s.name === 'mbedtls_gcm_crypt_and_tag') hit = s.address;
    });
  } catch (e) {}
  if (hit) return hit;

  var env = Process.getEnvironmentVariable
    ? Process.getEnvironmentVariable('WA_GCM_ADDR')
    : null;
  if (env) return m.base.add(ptr(env)); // offset from module base

  console.log('[!] mbedtls_gcm_crypt_and_tag not found in ' + MODULE + '.');
  console.log('    This build is stripped. Find the function offset in Ghidra');
  console.log('    and re-run with WA_GCM_ADDR=0x<offset> (relative to the');
  console.log('    ' + MODULE + ' base).');
  return null;
}

var target = resolve();
if (target) {
  console.log('[*] Hooking mbedtls_gcm_crypt_and_tag @ ' + target);

  Interceptor.attach(target, {
    onEnter: function (args) {
      var mode = args[1].toInt32();
      if (mode !== ENCRYPT) return; // only observe the sealing direction

      var length = args[2].toInt32();
      var ivLen = args[4].toInt32();
      var addLen = args[6].toInt32();

      var body = asText(args[7], length);

      // The registration body always carries these markers. Everything else
      // this call encrypts (message payloads, media keys) is skipped so the
      // log stays focused on the registration run.
      if (body.indexOf('cc=') === -1 && body.indexOf('ENC') === -1 &&
          body.indexOf('token=') === -1 && body.indexOf('&in=') === -1) {
        return;
      }

      console.log('\n==================== ENC (registration) ====================');
      console.log('[plaintext len] ' + length);
      console.log('[iv]            ' + hex(args[3], ivLen) + (ivLen ? '' : ' (zero/implicit)'));
      if (addLen > 0) console.log('[aad]           ' + asText(args[5], addLen));
      console.log('[params]\n' + body);
      console.log('============================================================\n');
    },
  });
} else {
  console.log('[!] Nothing hooked. See notes above.');
}
