'use strict';

// ─── Media probing and inline thumbnails ─────────────────────────────────────
//
// WhatsApp renders a photo or video inline in the chat from the small JPEG
// carried in the message itself (ImageMessage.jpegThumbnail, field 16) together
// with the width and height. A message that arrives without them cannot be
// drawn, so the recipient gets the grey placeholder with a download arrow and
// has to tap it before seeing anything.
//
// The preview is the source resized to 32 pixels wide at JPEG quality 50, with
// the original dimensions read from the same decode. None of it is mandatory:
//
//   • Dimensions are read straight out of the file header — JPEG, PNG, WebP,
//     GIF and BMP — with no library at all.
//   • The thumbnail is made with sharp or jimp when either is installed. When
//     neither is, a JPEG that carries an EXIF thumbnail (which is to say, most
//     photos taken on a phone) yields one for free, and anything else goes
//     through the decoder in lib/image — still with nothing installed.
//   • Video frames need ffmpeg. Without it the video still sends, just without
//     an inline preview.
//
// Nothing here throws: every entry point resolves to whatever it managed to
// work out, so a missing library degrades the preview and never the send.

const { dbg: _whaDbg } = require('./logger');

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const { toSquareJpeg, toScaledJpeg, canDecode: canDecodeImage } = require('./image');

// The preview is deliberately tiny; it is only ever shown blurred behind the
// real image while that downloads.
const THUMB_WIDTH   = 32;
const THUMB_QUALITY = 50;

// An EXIF thumbnail is usually ~160x120 and a few KB. Anything much larger is
// not a thumbnail worth embedding in every copy of an E2EE message.
const MAX_EXIF_THUMB = 12 * 1024;

const EXEC_TIMEOUT_MS = 20000;

// ─── Dimensions from the file header ─────────────────────────────────────────

function probeImageSize(buf) {
  // Only enough to tell the formats apart; each branch below checks that the
  // bytes it actually reads are there. A single large minimum would reject
  // small-but-valid files.
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;

  // PNG — 8-byte signature, then IHDR with width/height as big-endian uint32.
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    if (buf.length < 24) return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // GIF — "GIF87a"/"GIF89a", then the logical screen descriptor, little-endian.
  if (buf.slice(0, 3).toString('latin1') === 'GIF') {
    if (buf.length < 10) return null;
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }

  // BMP — the 12-byte BITMAPCOREHEADER holds the size as two Int16, every
  // later header as two Int32, so the header size decides where to read.
  if (buf[0] === 0x42 && buf[1] === 0x4d && buf.length >= 26) {
    const headerSize = buf.readUInt32LE(14);
    if (headerSize < 12) return null;
    if (headerSize === 12) {
      return { width: buf.readInt16LE(18), height: Math.abs(buf.readInt16LE(20)) };
    }
    return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) };
  }

  // WebP — RIFF container, three different chunk layouts.
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' &&
      buf.slice(8, 12).toString('latin1') === 'WEBP') {
    const chunk = buf.slice(12, 16).toString('latin1');
    if (chunk === 'VP8 ' && buf.length >= 30) {
      // Lossy: 14-bit dimensions in the keyframe header.
      return {
        width:  buf.readUInt16LE(26) & 0x3fff,
        height: buf.readUInt16LE(28) & 0x3fff
      };
    }
    if (chunk === 'VP8L' && buf.length >= 25) {
      // Lossless: 14 bits of (width-1) then 14 bits of (height-1), packed.
      const b = buf.readUInt32LE(21);
      return {
        width:  (b & 0x3fff) + 1,
        height: ((b >> 14) & 0x3fff) + 1
      };
    }
    if (chunk === 'VP8X' && buf.length >= 30) {
      // Extended: 24-bit (width-1) and (height-1), little-endian.
      const w = buf[24] | (buf[25] << 8) | (buf[26] << 16);
      const h = buf[27] | (buf[28] << 8) | (buf[29] << 16);
      return { width: w + 1, height: h + 1 };
    }
    return null;
  }

  // JPEG — walk the marker chain to the start-of-frame, which holds the size.
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 8 < buf.length) {
      if (buf[off] !== 0xff) { off++; continue; }         // resync on padding
      const marker = buf[off + 1];
      if (marker === 0xd8 || marker === 0x01 ||
          (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
      if (marker === 0xd9 || marker === 0xda) break;      // end / scan data
      const len = buf.readUInt16BE(off + 2);
      if (len < 2) break;
      // SOF0..SOF15, minus DHT (c4), JPG (c8) and DAC (cc) which share the range
      const isSOF = marker >= 0xc0 && marker <= 0xcf &&
                    marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSOF) {
        return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
      }
      off += 2 + len;
    }
  }

  return null;
}

// ─── EXIF thumbnail, straight out of a JPEG ──────────────────────────────────
//
// Phone cameras embed a small JPEG preview in the APP1/EXIF segment, in the
// second IFD. Tag 0x0201 is its offset from the start of the TIFF header and
// 0x0202 its length. Pulling that out gives a usable inline preview on a
// machine with no image library installed at all.

function extractExifThumbnail(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;

  // Find the APP1 segment that starts with "Exif\0\0".
  let off = 2, tiff = -1, app1End = -1;
  while (off + 4 < buf.length) {
    if (buf[off] !== 0xff) { off++; continue; }
    const marker = buf[off + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
    const len = buf.readUInt16BE(off + 2);
    if (len < 2) break;
    if (marker === 0xe1 && off + 10 < buf.length &&
        buf.slice(off + 4, off + 10).toString('latin1') === 'Exif\0\0') {
      tiff    = off + 10;
      app1End = off + 2 + len;
      break;
    }
    off += 2 + len;
  }
  if (tiff < 0 || tiff + 8 > buf.length) return null;

  const bom = buf.slice(tiff, tiff + 2).toString('latin1');
  if (bom !== 'II' && bom !== 'MM') return null;
  const le  = bom === 'II';
  const u16 = (o) => le ? buf.readUInt16LE(o) : buf.readUInt16BE(o);
  const u32 = (o) => le ? buf.readUInt32LE(o) : buf.readUInt32BE(o);

  if (u16(tiff + 2) !== 42) return null;

  // IFD0, then hop to IFD1 — the thumbnail lives in the second one.
  const ifd0 = tiff + u32(tiff + 4);
  if (ifd0 + 2 > buf.length) return null;
  const count0 = u16(ifd0);
  const nextPtr = ifd0 + 2 + count0 * 12;
  if (nextPtr + 4 > buf.length) return null;
  const ifd1Off = u32(nextPtr);
  if (!ifd1Off) return null;
  const ifd1 = tiff + ifd1Off;
  if (ifd1 + 2 > buf.length) return null;

  const count1 = u16(ifd1);
  let thumbOff = 0, thumbLen = 0;
  for (let i = 0; i < count1; i++) {
    const e = ifd1 + 2 + i * 12;
    if (e + 12 > buf.length) break;
    const tag = u16(e);
    if (tag === 0x0201) thumbOff = u32(e + 8);
    else if (tag === 0x0202) thumbLen = u32(e + 8);
  }
  if (!thumbOff || !thumbLen || thumbLen > MAX_EXIF_THUMB) return null;

  const start = tiff + thumbOff;
  const end   = start + thumbLen;
  if (end > buf.length || (app1End > 0 && end > app1End)) return null;

  const thumb = buf.slice(start, end);
  // Must actually be a JPEG, or WhatsApp will render nothing.
  if (thumb.length < 4 || thumb[0] !== 0xff || thumb[1] !== 0xd8) return null;
  return Buffer.from(thumb);
}

// ─── Optional image library ──────────────────────────────────────────────────

let _imageLib;   // undefined = not looked for yet, null = none available

async function loadImageLib() {
  if (_imageLib !== undefined) return _imageLib;
  _imageLib = null;

  try {
    const sharp = require('sharp');
    _imageLib = { kind: 'sharp', sharp };
    _whaDbg('[DBG] THUMB using sharp');
    return _imageLib;
  } catch (_) {}

  // jimp 1.x is ESM-only, 0.x is CommonJS — accept either.
  try {
    const mod = await import('jimp');
    const jimp = mod.default && mod.default.Jimp ? mod.default : mod;
    if (jimp && jimp.Jimp) {
      _imageLib = { kind: 'jimp1', Jimp: jimp.Jimp, ResizeStrategy: jimp.ResizeStrategy };
      _whaDbg('[DBG] THUMB using jimp (v1)');
      return _imageLib;
    }
    const legacy = mod.default || mod;
    if (legacy && typeof legacy.read === 'function') {
      _imageLib = { kind: 'jimp0', Jimp: legacy };
      _whaDbg('[DBG] THUMB using jimp (v0)');
      return _imageLib;
    }
  } catch (_) {}

  _whaDbg('[DBG] THUMB no image library — falling back to the built-in ' +
    'decoder, which reads JPEG, PNG, GIF and BMP');
  return _imageLib;
}

// ─── Image: dimensions + inline preview ──────────────────────────────────────
//
// Returns { width, height, thumbnail } with whatever could be worked out; any
// field may be missing. Never rejects.

async function imageThumbnail(buf, opts) {
  opts = opts || {};
  const out = {};
  if (!Buffer.isBuffer(buf) || buf.length === 0) return out;

  const size = probeImageSize(buf);
  if (size && size.width > 0 && size.height > 0) {
    out.width  = size.width;
    out.height = size.height;
  }

  const width   = opts.width   || THUMB_WIDTH;
  const quality = opts.quality || THUMB_QUALITY;

  try {
    const lib = await loadImageLib();
    if (lib && lib.kind === 'sharp') {
      const img  = lib.sharp(buf);
      const meta = await img.metadata();
      if (meta && meta.width && meta.height) {
        out.width = meta.width; out.height = meta.height;
      }
      out.thumbnail = await lib.sharp(buf).resize(width).jpeg({ quality }).toBuffer();
      return out;
    }
    if (lib && lib.kind === 'jimp1') {
      const img = await lib.Jimp.read(buf);
      if (img.width && img.height) { out.width = img.width; out.height = img.height; }
      const resizeOpts = { w: width };
      if (lib.ResizeStrategy && lib.ResizeStrategy.BILINEAR) {
        resizeOpts.mode = lib.ResizeStrategy.BILINEAR;
      }
      out.thumbnail = await img.resize(resizeOpts).getBuffer('image/jpeg', { quality });
      return out;
    }
    if (lib && lib.kind === 'jimp0') {
      const Jimp = lib.Jimp;
      const img  = await Jimp.read(buf);
      if (img.bitmap) { out.width = img.bitmap.width; out.height = img.bitmap.height; }
      img.resize(width, Jimp.AUTO).quality(quality);
      out.thumbnail = await img.getBufferAsync(Jimp.MIME_JPEG);
      return out;
    }
  } catch (err) {
    _whaDbg('[DBG] THUMB image library failed: ' + (err && err.message));
  }

  // No library, or it could not read this file. The camera's own embedded
  // preview is the cheapest thing left, and on a phone photo it is usually
  // there — a few kilobytes already sized about right.
  const exif = extractExifThumbnail(buf);
  if (exif) {
    out.thumbnail = exif;
    _whaDbg('[DBG] THUMB using embedded EXIF thumbnail (' + exif.length + ' bytes)');
    return out;
  }

  // Otherwise scale it here. Slower than a library, but a preview is 32 pixels
  // wide and this is the difference between the picture showing in the chat and
  // a grey download placeholder.
  try {
    const built = toScaledJpeg(buf, width, quality);
    if (built && built.length) {
      out.thumbnail = built;
      _whaDbg('[DBG] THUMB made in-process (' + built.length + ' bytes)');
      return out;
    }
  } catch (err) {
    _whaDbg('[DBG] THUMB built-in scaler failed: ' + (err && err.message));
  }

  _whaDbg('[DBG] THUMB none available — the image will show as a download ' +
    'placeholder; install jimp to fix');
  return out;
}

// ─── Profile pictures ────────────────────────────────────────────────────────

// What WhatsApp's own apps upload. The server will not take an arbitrary file:
// it wants a square JPEG at this size, and a picture that is not one is dropped
// without an answer rather than refused, so the failure gives no clue.
const AVATAR_SIZE    = 640;
const AVATAR_QUALITY = 50;

/**
 * Re-encode an image into the form a profile picture has to be in.
 *
 * Cropped square, scaled to 640x640, and written out as a fresh JPEG.
 * Re-encoding is the point rather than a side effect: it strips EXIF,
 * progressive scans and unusual chroma subsampling — anything the file happened
 * to carry — and produces a plain baseline JPEG.
 *
 * Four converters are tried in turn, so a picture goes through whatever the
 * machine happens to have:
 *
 *   1. sharp or jimp, when one is installed — the best quality and the widest
 *      range of formats.
 *   2. the built-in converter, which reads JPEG, PNG, GIF and BMP with no
 *      dependency at all. This is the one that runs on a bare install.
 *   3. ffmpeg, which covers what the built-in one does not: WebP, HEIC,
 *      progressive JPEG.
 *   4. failing all of that, the file with its metadata segments stripped, which
 *      at least gives an already-square JPEG a chance.
 */
async function prepareProfilePicture(buf, opts) {
  opts = opts || {};
  if (!Buffer.isBuffer(buf) || !buf.length) return buf;

  const size    = opts.size    || AVATAR_SIZE;
  const quality = opts.quality || AVATAR_QUALITY;

  try {
    const lib = await loadImageLib();

    if (lib && lib.kind === 'sharp') {
      return await lib.sharp(buf)
        .resize(size, size, { fit: 'cover' })
        .jpeg({ quality })
        .toBuffer();
    }

    if (lib && lib.kind === 'jimp1') {
      const img = await lib.Jimp.read(buf);
      const min = Math.min(img.width, img.height);
      const sq  = img.crop({ x: 0, y: 0, w: min, h: min });
      const resizeOpts = { w: size, h: size };
      if (lib.ResizeStrategy && lib.ResizeStrategy.BILINEAR) {
        resizeOpts.mode = lib.ResizeStrategy.BILINEAR;
      }
      return await sq.resize(resizeOpts).getBuffer('image/jpeg', { quality });
    }

    if (lib && lib.kind === 'jimp0') {
      const Jimp = lib.Jimp;
      const img  = await Jimp.read(buf);
      const min  = Math.min(img.bitmap.width, img.bitmap.height);
      img.crop(0, 0, min, min).resize(size, size).quality(quality);
      return await img.getBufferAsync(Jimp.MIME_JPEG);
    }
  } catch (err) {
    _whaDbg('[DBG] AVATAR image library failed: ' + (err && err.message));
  }

  // No image library, or it could not read this file. The built-in converter
  // needs nothing installed and handles the formats a picture is usually in.
  try {
    const built = toSquareJpeg(buf, size, quality);
    if (built && built.length) {
      _whaDbg('[DBG] AVATAR converted in-process to ' + size + 'x' + size +
        ' (' + buf.length + ' → ' + built.length + ' bytes)');
      return built;
    }
  } catch (err) {
    _whaDbg('[DBG] AVATAR built-in converter failed: ' + (err && err.message));
  }

  // A format the built-in decoder does not read — WebP, HEIC, a progressive
  // JPEG. ffmpeg can do the same job and is already used by the video path, so
  // try it before giving up.
  const viaFfmpeg = await avatarViaFfmpeg(buf, size, quality);
  if (viaFfmpeg) return viaFfmpeg;

  // Nothing that can re-encode. Strip the metadata segments at least: EXIF and
  // the other APPn blocks are the part of an ordinary camera JPEG the server
  // most often will not take, and removing them needs no decoder — the image
  // data is left exactly as it was.
  const stripped = stripJpegMetadata(buf);
  if (stripped !== buf) {
    _whaDbg('[DBG] AVATAR no converter — sent with metadata stripped (' +
      buf.length + ' → ' + stripped.length + ' bytes). Install jimp or ffmpeg ' +
      'to have the image resized properly.');
    return stripped;
  }

  _whaDbg('[DBG] AVATAR nothing could read this file — sending it as it is. ' +
    'WhatsApp wants a square JPEG; JPEG, PNG, GIF and BMP are converted here ' +
    'on their own, and ffmpeg or jimp covers the rest.');
  return buf;
}

/**
 * Crop square and resize with ffmpeg, which needs no native npm module.
 *
 * Returns null when ffmpeg is not installed or cannot read the file, so the
 * caller can carry on to the next fallback.
 */
async function avatarViaFfmpeg(buf, size, quality) {
  if (!(await hasFfmpeg())) return null;

  const src = tmpFile('.img');
  const dst = tmpFile('.jpg');
  try {
    fs.writeFileSync(src, buf);
    // Crop to the shorter side, scale, and write baseline JPEG. -q:v runs 2..31
    // worst-to-best in ffmpeg, the opposite way round to a percentage quality.
    const q = Math.max(2, Math.min(31, Math.round(31 - (quality / 100) * 29)));
    const ok = await run('ffmpeg', [
      '-y', '-i', src,
      '-vf', "crop='min(iw,ih)':'min(iw,ih)',scale=" + size + ':' + size,
      '-q:v', String(q),
      '-f', 'mjpeg',
      dst
    ]);
    if (ok === null) return null;
    const out = fs.readFileSync(dst);
    if (!out.length || out[0] !== 0xff || out[1] !== 0xd8) return null;
    _whaDbg('[DBG] AVATAR re-encoded with ffmpeg (' + out.length + ' bytes)');
    return out;
  } catch (err) {
    _whaDbg('[DBG] AVATAR ffmpeg failed: ' + (err && err.message));
    return null;
  } finally {
    try { fs.unlinkSync(src); } catch (_) {}
    try { fs.unlinkSync(dst); } catch (_) {}
  }
}

/**
 * Drop every APPn segment from a JPEG, keeping the image itself byte for byte.
 *
 * EXIF, ICC profiles, thumbnails and camera maker notes all live in these, and
 * a picture that carries them is the ordinary case a phone produces. Removing
 * them takes no decoder — it is a walk over the segment headers — so it works
 * where nothing else is installed.
 *
 * Returns the input unchanged when it is not a JPEG or has nothing to drop.
 */
function stripJpegMetadata(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return buf;
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return buf;   // not a JPEG

  const keep = [buf.slice(0, 2)];
  let i = 2, dropped = 0;

  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) break;                 // out of step; leave the rest be
    const marker = buf[i + 1];

    // Start of scan — everything from here is entropy-coded image data.
    if (marker === 0xda) { keep.push(buf.slice(i)); i = buf.length; break; }
    // Standalone markers carry no length.
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      keep.push(buf.slice(i, i + 2)); i += 2; continue;
    }

    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) break;     // malformed; stop here
    const seg = buf.slice(i, i + 2 + len);

    // APP0 is the JFIF header, which is the one to keep; APP1..APPF and the
    // comment segment are metadata.
    const isAppN    = marker >= 0xe1 && marker <= 0xef;
    const isComment = marker === 0xfe;
    if (isAppN || isComment) dropped += seg.length;
    else keep.push(seg);

    i += 2 + len;
  }

  if (!dropped) return buf;
  if (i < buf.length) keep.push(buf.slice(i));
  return Buffer.concat(keep);
}

// ─── ffmpeg ──────────────────────────────────────────────────────────────────

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

let _ffmpegChecked;
async function hasFfmpeg() {
  if (_ffmpegChecked !== undefined) return _ffmpegChecked;
  _ffmpegChecked = (await run('ffmpeg', ['-version'])) !== null;
  if (!_ffmpegChecked) {
    _whaDbg('[DBG] THUMB ffmpeg not found — videos will send without an inline ' +
      'preview (Termux: pkg install ffmpeg)');
  }
  return _ffmpegChecked;
}

function tmpFile(ext) {
  return path.join(os.tmpdir(),
    'whalibmob-' + crypto.randomBytes(8).toString('hex') + ext);
}

// ─── Video: dimensions, duration, first-frame preview ────────────────────────
//
// input may be a file path or a Buffer; a Buffer is spilled to a temp file
// because ffmpeg needs to seek. Returns { width, height, seconds, thumbnail }
// with whatever could be worked out. Never rejects.

async function videoThumbnail(input, opts) {
  opts = opts || {};
  const out = {};
  if (!(await hasFfmpeg())) return out;

  let src = null, spilled = null;
  try {
    if (Buffer.isBuffer(input)) {
      spilled = tmpFile('.mp4');
      fs.writeFileSync(spilled, input);
      src = spilled;
    } else if (typeof input === 'string' && fs.existsSync(input)) {
      src = input;
    }
    if (!src) return out;

    // ffprobe ships with ffmpeg; when it is missing the frame grab below still
    // works, the message just goes out without dimensions.
    const probe = await run('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height:format=duration',
      '-of', 'json', src
    ]);
    if (probe) {
      try {
        const j  = JSON.parse(probe);
        const st = j.streams && j.streams[0];
        if (st && st.width && st.height) {
          out.width = Number(st.width); out.height = Number(st.height);
        }
        const dur = j.format && parseFloat(j.format.duration);
        if (Number.isFinite(dur) && dur > 0) out.seconds = Math.round(dur);
      } catch (_) {}
    }

    // First frame, scaled to the preview width with the aspect ratio kept.
    const dest = tmpFile('.jpg');
    try {
      const ok = await run('ffmpeg', [
        '-ss', '00:00:00', '-i', src, '-y',
        '-vf', 'scale=' + (opts.width || THUMB_WIDTH) + ':-1',
        '-vframes', '1', '-f', 'image2', dest
      ]);
      if (ok !== null && fs.existsSync(dest)) {
        const thumb = fs.readFileSync(dest);
        if (thumb.length > 0) out.thumbnail = thumb;
      }
    } finally {
      try { fs.unlinkSync(dest); } catch (_) {}
    }
  } catch (err) {
    _whaDbg('[DBG] THUMB video failed: ' + (err && err.message));
  } finally {
    if (spilled) { try { fs.unlinkSync(spilled); } catch (_) {} }
  }

  return out;
}

module.exports = {
  probeImageSize,
  extractExifThumbnail,
  imageThumbnail,
  prepareProfilePicture,
  stripJpegMetadata,
  canDecodeImage,
  videoThumbnail,
  hasFfmpeg,
  THUMB_WIDTH,
  THUMB_QUALITY,
  AVATAR_SIZE,
  AVATAR_QUALITY
};
